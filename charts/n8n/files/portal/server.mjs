// Portail d'actions : la seule porte publique du pod.
//
// Il sert l'interface (widget Grist) et une API. Chaque appel porte le jeton
// Grist du lecteur, vérifié auprès de Grist (identity.mjs). Les droits sont
// dans le store : quel document ouvre quelles actions, qui est propriétaire.
// Une action ouverte est exécutée en appelant le webhook de son workflow sur
// localhost, avec des entrées contrôlées ici et non dans le navigateur.
//
// Deux rôles :
//   destinataire : tout lecteur d'un document auquel le propriétaire a ouvert
//                  des actions ; il voit ces actions et les lance ;
//   propriétaire : présente en plus le jeton d'administration (notes Onyxia)
//                  et doit être le compte Grist associé au portail.

import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IdentityError, createIdentityVerifier } from "./identity.mjs";
import { openStore, isActionKey } from "./store.mjs";
import { N8nError, createN8nClient, inputNamesFromWorkflow, isPublished, webhookTriggers } from "./n8n.mjs";
import { checkInputs, draftFormDef, pickResult, publicAction, validateActionFormDef } from "./formdef.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;

const STATIC = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/portal.css": ["portal.css", "text/css; charset=utf-8"],
  "/engine.js": ["engine.js", "text/javascript; charset=utf-8"],
  "/types.js": ["types.js", "text/javascript; charset=utf-8"],
  "/dsfr-like.css": ["dsfr-like.css", "text/css; charset=utf-8"],
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const log = (message) => console.log(`[portail] ${message}`);

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// Fenêtre fixe par clé : assez pour freiner un script, invisible pour un humain.
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (hits.size > 10000) hits.clear();
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function clientIp(req) {
  // Derrière le contrôleur d'ingress : X-Real-IP porte l'adresse du client.
  return String(req.headers["x-real-ip"] || req.socket.remoteAddress || "inconnue");
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Requête trop volumineuse.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Corps JSON illisible.");
  }
}

export function securityHeaders({ gristOrigins, pluginUrl }) {
  const pluginOrigin = new URL(pluginUrl).origin;
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${pluginOrigin}`,
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self'",
    `frame-ancestors ${gristOrigins.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export function createPortal({ config, store, verifyIdentity, n8n, now = Date.now }) {
  const headers = securityHeaders(config);
  const apiLimiter = createRateLimiter({ limit: 120, windowMs: 60000, now });
  const runLimiter = createRateLimiter({ limit: 20, windowMs: 60000, now });

  function send(res, status, body, extra = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    });
    res.end(payload);
  }

  async function identify(req) {
    return verifyIdentity({
      token: req.headers["x-grist-token"],
      baseUrl: req.headers["x-grist-base"],
    });
  }

  async function requireOwner(req, identity) {
    if (!config.adminToken) throw new HttpError(403, "Administration désactivée : aucun jeton d'administration n'est configuré.");
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(bearer, config.adminToken)) throw new HttpError(401, "Jeton d'administration invalide.");
    if (!store.isOwner(identity)) {
      throw new HttpError(403, store.owner()
        ? "Ce portail est associé à un autre compte Grist."
        : "Associez d'abord ce portail à votre compte Grist.");
    }
  }

  async function findTrigger(workflowId, nodeName) {
    const workflow = await n8n.getWorkflow(workflowId);
    const trigger = webhookTriggers(workflow).find((t) => t.node === nodeName);
    return { workflow, trigger };
  }

  async function listWorkflows(exposedByWorkflow) {
    const workflows = await n8n.listWorkflows();
    return workflows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      published: isPublished(wf),
      tags: (wf.tags || []).map((t) => t.name),
      triggers: webhookTriggers(wf),
      exposedAs: exposedByWorkflow.get(String(wf.id)) || [],
    }));
  }

  const routes = {
    "GET /api/catalog": async (req, res) => {
      const identity = await identify(req);
      const access = store.access(identity.origin, identity.docId);
      const actions = (access?.actions || [])
        .map((key) => [key, store.action(key)])
        .filter(([, action]) => action)
        .map(([key, action]) => publicAction(key, action));
      send(res, 200, {
        document: { docId: identity.docId },
        isOwner: store.isOwner(identity),
        paired: Boolean(store.owner()),
        adminEnabled: Boolean(config.adminToken),
        actions,
      });
    },

    "POST /api/run": async (req, res) => {
      const identity = await identify(req);
      if (!runLimiter(`${identity.origin}#${identity.userId}`)) {
        throw new HttpError(429, "Trop de lancements en une minute : patientez un instant.");
      }
      const body = await readJson(req);
      const key = String(body.action || "");
      const access = store.access(identity.origin, identity.docId);
      const action = isActionKey(key) ? store.action(key) : null;
      if (!action || !access?.actions.includes(key)) {
        throw new HttpError(404, "Cette action n'est pas ouverte dans ce document.");
      }
      let inputs;
      try {
        inputs = checkInputs(action.formdef, body.inputs);
      } catch (error) {
        throw new HttpError(422, error.message);
      }
      const { workflow, trigger } = await findTrigger(action.workflowId, action.node);
      if (!trigger || trigger.blocker) {
        throw new HttpError(409, "Le workflow de cette action a changé : le propriétaire doit la reconfigurer.");
      }
      if (!isPublished(workflow)) {
        throw new HttpError(409, "Le workflow de cette action n'est pas publié dans n8n.");
      }
      const runId = randomUUID();
      const context = {
        runId,
        action: key,
        requester: { gristUserId: identity.userId, origin: identity.origin },
        document: { docId: identity.docId, origin: identity.origin },
        at: new Date(now()).toISOString(),
      };
      const started = now();
      log(`run ${runId} action=${key} doc=${identity.docId} user=${identity.userId}`);
      const result = await n8n.runWebhook({ path: trigger.path, inputs, context });
      send(res, 200, {
        runId,
        durationMs: now() - started,
        result: pickResult(action.formdef, result),
        render: action.formdef.result?.fields || [],
        acknowledgedOnly: trigger.responseMode === "onReceived",
      });
    },

    "POST /api/admin/pair": async (req, res) => {
      const identity = await identify(req);
      if (!config.adminToken) throw new HttpError(403, "Administration désactivée : aucun jeton d'administration n'est configuré.");
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!sameSecret(bearer, config.adminToken)) throw new HttpError(401, "Jeton d'administration invalide.");
      const ok = await store.pairOwner({ origin: identity.origin, userId: identity.userId });
      if (!ok) throw new HttpError(403, "Ce portail est associé à un autre compte Grist.");
      log(`propriétaire associé : ${identity.origin} utilisateur ${identity.userId}`);
      send(res, 200, { paired: true });
    },

    "GET /api/admin/state": async (req, res) => {
      const identity = await identify(req);
      await requireOwner(req, identity);
      const actions = store.actions();
      const exposed = new Map();
      for (const [key, action] of Object.entries(actions)) {
        const id = String(action.workflowId);
        exposed.set(id, [...(exposed.get(id) || []), key]);
      }
      const access = store.access(identity.origin, identity.docId);
      send(res, 200, {
        document: { docId: identity.docId },
        actions,
        openedHere: access?.actions || [],
        workflows: await listWorkflows(exposed),
      });
    },

    "POST /api/admin/draft": async (req, res) => {
      const identity = await identify(req);
      await requireOwner(req, identity);
      const body = await readJson(req);
      const { workflow, trigger } = await findTrigger(String(body.workflowId || ""), String(body.node || ""));
      if (!trigger) throw new HttpError(404, "Déclencheur webhook introuvable dans ce workflow.");
      const base = String(workflow.name || "action").normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "action";
      let key = base;
      for (let i = 2; store.action(key); i += 1) key = `${base}-${i}`;
      send(res, 200, {
        key,
        blocker: trigger.blocker,
        formdef: draftFormDef({ key, workflow, inputNames: inputNamesFromWorkflow(workflow) }),
      });
    },

    "POST /api/admin/action": async (req, res) => {
      const identity = await identify(req);
      await requireOwner(req, identity);
      const body = await readJson(req);
      const key = String(body.key || "");
      if (!isActionKey(key)) throw new HttpError(422, "Clé d'action invalide : minuscules, chiffres, « - » et « _ ».");
      const errors = validateActionFormDef(body.formdef, key);
      if (errors.length) throw new HttpError(422, "Formulaire invalide.", errors);
      const { workflow, trigger } = await findTrigger(String(body.workflowId || ""), String(body.node || ""));
      if (!trigger) throw new HttpError(404, "Déclencheur webhook introuvable dans ce workflow.");
      if (trigger.blocker) throw new HttpError(409, `Workflow non exposable : ${trigger.blocker}.`);
      const saved = await store.putAction(key, {
        workflowId: String(workflow.id),
        workflowName: workflow.name,
        node: trigger.node,
        icon: typeof body.icon === "string" ? body.icon.slice(0, 8) : "",
        formdef: body.formdef,
      });
      send(res, 200, { key, action: saved, published: isPublished(workflow) });
    },

    "DELETE /api/admin/action": async (req, res) => {
      const identity = await identify(req);
      await requireOwner(req, identity);
      const body = await readJson(req);
      const removed = await store.deleteAction(String(body.key || ""));
      send(res, removed ? 200 : 404, { removed });
    },

    "POST /api/admin/access": async (req, res) => {
      const identity = await identify(req);
      await requireOwner(req, identity);
      const body = await readJson(req);
      const keys = Array.isArray(body.actions) ? body.actions.map(String).filter(isActionKey) : [];
      const access = await store.setAccess({
        origin: identity.origin,
        docId: identity.docId,
        label: typeof body.label === "string" ? body.label.slice(0, 120) : "",
        actions: keys,
      });
      send(res, 200, { openedHere: access?.actions || [] });
    },
  };

  async function serveStatic(res, pathname) {
    if (pathname === "/" || pathname === "/index.html") {
      const html = (await readFile(join(config.publicDir, "index.html"), "utf8"))
        .replace("%GRIST_PLUGIN_URL%", config.pluginUrl);
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(html);
      return true;
    }
    const entry = STATIC[pathname];
    if (!entry) return false;
    const content = await readFile(join(config.publicDir, entry[0]));
    res.writeHead(200, { ...headers, "content-type": entry[1], "cache-control": "no-cache" });
    res.end(content);
    return true;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://portail.local");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!apiLimiter(clientIp(req))) throw new HttpError(429, "Trop de requêtes : patientez un instant.");
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) throw new HttpError(404, "Route inconnue.");
        await route(req, res);
        return;
      }
      // HEAD comme GET : sondes et proxys vérifient une page sans la lire.
      if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(res, url.pathname))) return;
      throw new HttpError(404, "Page introuvable.");
    } catch (error) {
      const known = error instanceof HttpError || error instanceof IdentityError || error instanceof N8nError;
      if (!known) log(`erreur : ${error?.stack || error}`);
      if (error instanceof N8nError && error.detail) log(`n8n : ${error.detail}`);
      const status = known ? error.status : 500;
      const message = known ? error.message : "Erreur interne du portail.";
      if (!res.headersSent) send(res, status, { error: message, details: error.details });
      else res.end();
    }
  };
}

export function configFromEnv(env = process.env) {
  const list = (value) => String(value || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return {
    port: Number(env.PORTAL_PORT || 3100),
    n8nUrl: env.N8N_URL || "http://127.0.0.1:5678",
    apiKeyFile: env.API_KEY_FILE || "/home/node/.n8n/onyxia/n8n-api-key",
    storeFile: env.PORTAL_STORE_FILE || "/home/node/.n8n/onyxia/portail.json",
    adminToken: env.PORTAL_ADMIN_TOKEN || "",
    gristOrigins: list(env.PORTAL_GRIST_ORIGINS || "https://grist.numerique.gouv.fr,https://docs.getgrist.com"),
    pluginUrl: env.PORTAL_GRIST_PLUGIN_URL || "https://grist.numerique.gouv.fr/grist-plugin-api.js",
    runTimeoutMs: Number(env.PORTAL_RUN_TIMEOUT_MS || 120000),
    publicDir: env.PORTAL_PUBLIC_DIR || HERE,
  };
}

// Démarré par start.mjs. Pas de garde « ce fichier est-il le programme
// principal ? » : dans une ConfigMap, /portal/server.mjs est un lien
// symbolique, Node compare son chemin réel, et le serveur ne démarrait jamais.
export async function main() {
  const config = configFromEnv();
  if (!config.adminToken) log("ATTENTION : PORTAL_ADMIN_TOKEN vide, l'administration est désactivée");
  const store = await openStore(config.storeFile);
  const handle = createPortal({
    config,
    store,
    verifyIdentity: createIdentityVerifier({ allowedOrigins: config.gristOrigins }),
    n8n: createN8nClient({ baseUrl: config.n8nUrl, apiKeyFile: config.apiKeyFile, runTimeoutMs: config.runTimeoutMs }),
  });
  const server = createServer(handle);
  server.listen(config.port, () => {
    log(`à l'écoute sur le port ${server.address().port}, Grist autorisé : ${config.gristOrigins.join(", ")}`);
  });
  return server;
}
