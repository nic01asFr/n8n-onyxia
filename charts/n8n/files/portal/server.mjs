// Portail d'actions : la seule porte publique du pod.
//
// Il sert l'interface (widget Grist) et une API. Chaque appel porte le jeton
// Grist du lecteur, vérifié auprès de Grist (identity.mjs). Les droits sont
// dans le store : quel document ouvre quelles actions, qui est propriétaire.
// Une action ouverte est exécutée en appelant le webhook de son workflow sur
// localhost, avec des entrées contrôlées ici et non dans le navigateur, et un
// en-tête secret que seul ce portail connaît.
//
// Deux rôles :
//   destinataire : tout lecteur d'un document auquel le propriétaire a ouvert
//                  des actions (compte Grist connecté, sauf choix contraire) ;
//   propriétaire : le compte Grist associé au portail, connecté au mode
//                  « Configurer » avec le jeton du serveur MCP, le compte de
//                  ce n8n ou une clé API, échangé contre une session courte.
//
// Pour tout le reste (lister les workflows, créer son credential, lancer les
// webhooks), le portail est connecté à n8n comme le serveur MCP : par la clé
// API que le chart crée au démarrage, sans rien demander à personne.

import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IdentityError, createIdentityVerifier } from "./identity.mjs";
import { openStore, isActionKey } from "./store.mjs";
import {
  CREDENTIAL_NAME, N8nError, SECRET_HEADER, createN8nClient, inputNamesFromWorkflow, isPublished, webhookTriggers,
} from "./n8n.mjs";
import { checkInputs, draftFormDef, pickResult, publicAction, validateActionFormDef } from "./formdef.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 256 * 1024;
const SESSION_MS = 60 * 60 * 1000;
const GRIST_ACCESS = ["none", "read", "write"];
const GRIST_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// Session du mode « Configurer » : signée, courte, liée au compte Grist qui l'a
// ouverte. La clé API n8n ne sert qu'une fois, à l'ouverture ; elle ne reste ni
// dans le navigateur ni sur le serveur. Le secret de signature vit en mémoire :
// un redémarrage ferme les sessions, ce qui ne coûte qu'une reconnexion.
function createSessions({ now = Date.now, secret = randomBytes(32) }) {
  const sign = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    issue(identity) {
      const expiresAt = now() + SESSION_MS;
      const payload = Buffer.from(JSON.stringify({ u: identity.userId, o: identity.origin, e: expiresAt })).toString("base64url");
      return { session: `${payload}.${sign(payload)}`, expiresAt };
    },
    valid(session, identity) {
      const [payload, mac] = String(session || "").split(".");
      if (!payload || !mac) return false;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
      let data;
      try {
        data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return false;
      }
      return data.e > now() && data.u === identity.userId && data.o === identity.origin;
    },
  };
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

// Écriture du résultat dans le document, faite par le widget avec les droits
// du lecteur : une table, et pour chaque clé du résultat la colonne qui la
// reçoit.
function checkWriteBack(writeBack) {
  if (writeBack == null) return null;
  const errors = [];
  if (!GRIST_ID.test(writeBack.tableId || "")) errors.push("writeBack.tableId : identifiant de table Grist attendu.");
  const fields = writeBack.fields && typeof writeBack.fields === "object" ? writeBack.fields : {};
  if (Object.keys(fields).length === 0) errors.push("writeBack.fields : au moins une clé du résultat à enregistrer.");
  for (const [key, col] of Object.entries(fields)) {
    if (!GRIST_ID.test(key) || !GRIST_ID.test(String(col))) errors.push(`writeBack.fields : « ${key} » → « ${col} » invalide.`);
  }
  if (errors.length) throw new HttpError(422, "Écriture du résultat invalide.", errors);
  return { tableId: writeBack.tableId, fields: { ...fields } };
}

export function createPortal({ config, store, verifyIdentity, n8n, now = Date.now, sessions = createSessions({ now }) }) {
  const headers = securityHeaders(config);
  const apiLimiter = createRateLimiter({ limit: 120, windowMs: 60000, now });
  const runLimiter = createRateLimiter({ limit: 20, windowMs: 60000, now });
  const loginLimiter = createRateLimiter({ limit: 10, windowMs: 60000, now });

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

  function requireOwner(req, identity) {
    const session = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!sessions.valid(session, identity)) {
      throw new HttpError(401, "Session expirée ou absente : reconnectez-vous avec une clé API n8n.");
    }
    if (!store.isOwner(identity)) throw new HttpError(403, "Ce portail est associé à un autre compte Grist.");
  }

  // Un document qui exige un compte connecté ne sert rien aux visiteurs
  // anonymes, ni à ceux dont on ne sait pas dire s'ils le sont.
  function blockedForAnonymous(access, identity) {
    return access && access.signedInOnly !== false && identity.anonymous !== false;
  }

  // Credential du portail dans n8n, créé au premier besoin puis mémorisé.
  let credentialPromise = null;
  function credentialId() {
    if (!credentialPromise) {
      credentialPromise = n8n.ensureCredential(store.setting("credentialId")).then(async (id) => {
        if (id) await store.setSetting("credentialId", id);
        return id;
      }).catch((error) => {
        credentialPromise = null;
        throw error;
      });
    }
    return credentialPromise;
  }

  async function findTrigger(workflowId, nodeName) {
    const [workflow, credential] = await Promise.all([n8n.getWorkflow(workflowId), credentialId()]);
    const trigger = webhookTriggers(workflow, { credentialId: credential }).find((t) => t.node === nodeName);
    return { workflow, trigger };
  }

  function actionSettings(body) {
    const gristAccess = GRIST_ACCESS.includes(body.gristAccess) ? body.gristAccess : "none";
    return { gristAccess, writeBack: checkWriteBack(body.writeBack) };
  }

  const routes = {
    "GET /api/catalog": async (req, res) => {
      const identity = await identify(req);
      const access = store.access(identity.origin, identity.docId);
      const signInRequired = Boolean(blockedForAnonymous(access, identity));
      const actions = signInRequired ? [] : (access?.actions || [])
        .map((key) => [key, store.action(key)])
        .filter(([, action]) => action)
        .map(([key, action]) => publicAction(key, action));
      send(res, 200, {
        document: { docId: identity.docId },
        isOwner: store.isOwner(identity),
        paired: Boolean(store.owner()),
        loginMethods: [...(config.mcpToken ? ["mcp"] : []), "compte", "cle"],
        anonymous: identity.anonymous,
        signInRequired,
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
      if (blockedForAnonymous(access, identity)) {
        throw new HttpError(403, "Connectez-vous à Grist pour lancer cette action.");
      }
      let inputs;
      try {
        inputs = checkInputs(action.formdef, body.inputs);
      } catch (error) {
        throw new HttpError(422, error.message);
      }

      // Accès délégué au document : un second jeton du même lecteur, pour le
      // même document, que le workflow utilisera avec ses droits à lui.
      let grist = null;
      const wanted = action.gristAccess || "none";
      if (wanted !== "none") {
        if (!body.delegated?.token) throw new HttpError(422, "Cette action a besoin d'un accès au document.");
        const delegated = await verifyIdentity({ token: body.delegated.token, baseUrl: req.headers["x-grist-base"] });
        if (delegated.userId !== identity.userId || delegated.docId !== identity.docId || delegated.origin !== identity.origin) {
          throw new HttpError(403, "Le jeton d'accès au document ne correspond pas au lecteur.");
        }
        grist = {
          baseUrl: delegated.docBase,
          token: String(body.delegated.token),
          access: wanted === "write" && !delegated.readOnly ? "write" : "read",
          expiresAt: new Date(delegated.expiresAt).toISOString(),
        };
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
        ...(grist ? { grist } : {}),
      };
      const started = now();
      log(`run ${runId} action=${key} doc=${identity.docId} user=${identity.userId}${grist ? ` grist=${grist.access}` : ""}`);
      const result = await n8n.runWebhook({ path: trigger.path, inputs, context });
      send(res, 200, {
        runId,
        durationMs: now() - started,
        result: pickResult(action.formdef, result),
        render: action.formdef.result?.fields || [],
        acknowledgedOnly: trigger.responseMode === "onReceived",
      });
    },

    // Connexion du propriétaire : compte Grist connecté + preuve qu'on tient
    // ce n8n, soit son compte (email, mot de passe, code de double
    // authentification), soit une clé API. Le premier compte Grist à réussir
    // devient propriétaire du portail.
    "POST /api/admin/login": async (req, res) => {
      if (!loginLimiter(clientIp(req))) throw new HttpError(429, "Trop de tentatives : patientez une minute.");
      const identity = await identify(req);
      if (identity.anonymous !== false) {
        throw new HttpError(403, "Connectez-vous à Grist avant de configurer le portail.");
      }
      const body = await readJson(req);
      if (body.mcpToken !== undefined) {
        if (!config.mcpToken) throw new HttpError(401, "Connexion par jeton MCP indisponible : le serveur MCP n'est pas activé.");
        if (!sameSecret(body.mcpToken, config.mcpToken)) throw new HttpError(401, "Jeton MCP refusé.");
      } else if (body.email !== undefined) {
        const account = await n8n.checkAccount({ email: body.email, password: body.password, mfaCode: body.mfaCode });
        if (!account.ok) throw new HttpError(401, "Email ou mot de passe n8n refusé par ce n8n.");
        if (!account.admin) throw new HttpError(403, "Ce compte n8n n'est ni propriétaire ni administrateur de l'instance.");
      } else if (!(await n8n.checkApiKey(body.apiKey))) {
        throw new HttpError(401, "Clé API n8n refusée par ce n8n.");
      }
      const ok = await store.pairOwner({ origin: identity.origin, userId: identity.userId });
      if (!ok) throw new HttpError(403, "Ce portail est associé à un autre compte Grist.");
      log(`session ouverte pour ${identity.origin} utilisateur ${identity.userId}`);
      send(res, 200, sessions.issue(identity));
    },

    "GET /api/admin/state": async (req, res) => {
      const identity = await identify(req);
      requireOwner(req, identity);
      const credential = await credentialId();
      const actions = store.actions();
      const exposed = new Map();
      for (const [key, action] of Object.entries(actions)) {
        const id = String(action.workflowId);
        exposed.set(id, [...(exposed.get(id) || []), key]);
      }
      const workflows = (await n8n.listWorkflows()).map((wf) => ({
        id: wf.id,
        name: wf.name,
        published: isPublished(wf),
        tags: (wf.tags || []).map((t) => t.name),
        triggers: webhookTriggers(wf, { credentialId: credential }),
        exposedAs: exposed.get(String(wf.id)) || [],
      }));
      const access = store.access(identity.origin, identity.docId);
      send(res, 200, {
        document: { docId: identity.docId },
        credential: { id: credential, name: CREDENTIAL_NAME, header: SECRET_HEADER },
        actions,
        openedHere: access?.actions || [],
        signedInOnly: access ? access.signedInOnly !== false : true,
        workflows,
      });
    },

    "POST /api/admin/draft": async (req, res) => {
      const identity = await identify(req);
      requireOwner(req, identity);
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
        gristAccess: "none",
        writeBack: null,
        formdef: draftFormDef({ key, workflow, inputNames: inputNamesFromWorkflow(workflow) }),
      });
    },

    "POST /api/admin/action": async (req, res) => {
      const identity = await identify(req);
      requireOwner(req, identity);
      const body = await readJson(req);
      const key = String(body.key || "");
      if (!isActionKey(key)) throw new HttpError(422, "Clé d'action invalide : minuscules, chiffres, « - » et « _ ».");
      const errors = validateActionFormDef(body.formdef, key);
      if (errors.length) throw new HttpError(422, "Formulaire invalide.", errors);
      const settings = actionSettings(body);
      const { workflow, trigger } = await findTrigger(String(body.workflowId || ""), String(body.node || ""));
      if (!trigger) throw new HttpError(404, "Déclencheur webhook introuvable dans ce workflow.");
      if (trigger.blocker) throw new HttpError(409, `Workflow non exposable : ${trigger.blocker}.`);
      const saved = await store.putAction(key, {
        workflowId: String(workflow.id),
        workflowName: workflow.name,
        node: trigger.node,
        icon: typeof body.icon === "string" ? body.icon.slice(0, 8) : "",
        formdef: body.formdef,
        ...settings,
      });
      send(res, 200, { key, action: saved, published: isPublished(workflow) });
    },

    "DELETE /api/admin/action": async (req, res) => {
      const identity = await identify(req);
      requireOwner(req, identity);
      const body = await readJson(req);
      const removed = await store.deleteAction(String(body.key || ""));
      send(res, removed ? 200 : 404, { removed });
    },

    "POST /api/admin/access": async (req, res) => {
      const identity = await identify(req);
      requireOwner(req, identity);
      const body = await readJson(req);
      const keys = Array.isArray(body.actions) ? body.actions.map(String).filter(isActionKey) : [];
      const access = await store.setAccess({
        origin: identity.origin,
        docId: identity.docId,
        label: typeof body.label === "string" ? body.label.slice(0, 120) : "",
        actions: keys,
        signedInOnly: body.signedInOnly !== false,
      });
      send(res, 200, { openedHere: access?.actions || [], signedInOnly: access ? access.signedInOnly : true });
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
    webhookSecret: env.PORTAL_WEBHOOK_SECRET || "",
    // Jeton du serveur MCP (notes Onyxia) : l'une des preuves qu'on tient ce n8n.
    mcpToken: env.PORTAL_MCP_TOKEN || "",
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
  if (!config.webhookSecret) log("ATTENTION : PORTAL_WEBHOOK_SECRET vide, aucun webhook ne sera exposable");
  const store = await openStore(config.storeFile);
  const handle = createPortal({
    config,
    store,
    verifyIdentity: createIdentityVerifier({ allowedOrigins: config.gristOrigins }),
    n8n: createN8nClient({
      baseUrl: config.n8nUrl,
      apiKeyFile: config.apiKeyFile,
      webhookSecret: config.webhookSecret,
      runTimeoutMs: config.runTimeoutMs,
    }),
  });
  const server = createServer(handle);
  server.listen(config.port, () => {
    log(`à l'écoute sur le port ${server.address().port}, Grist autorisé : ${config.gristOrigins.join(", ")}`);
  });
  return server;
}
