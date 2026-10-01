// Accès à n8n depuis le pod : API publique pour lire les workflows, webhooks
// de production pour les exécuter. Tout passe par localhost : les webhooks
// n'ont pas à être publics, le portail est la seule porte d'entrée.

import { readFile } from "node:fs/promises";

const WEBHOOK_TYPE = "n8n-nodes-base.webhook";
// Clé réservée dans le corps envoyé au workflow : le reste, ce sont les entrées
// du formulaire, à plat, comme les lisent déjà les workflows existants
// ($json.body.<champ>).
export const CONTEXT_KEY = "_portail";

// Réponse d'un workflow au-delà de laquelle le portail abandonne : un résultat
// affiché dans un formulaire n'a aucune raison d'être plus gros.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class N8nError extends Error {
  constructor(message, status = 502, detail = "") {
    super(message);
    this.status = status;
    // Pour le journal du pod seulement : jamais renvoyé au destinataire.
    this.detail = detail;
  }
}

async function readLimited(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new N8nError("La réponse du workflow est trop volumineuse pour être affichée.", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// En-tête secret joint par le portail à chaque appel. Le webhook d'une action
// l'exige par un credential « Header Auth » : un appel direct à son adresse,
// qui reste joignable par l'hôte de l'éditeur, est alors refusé par n8n, et le
// contexte _portail ne peut plus être forgé.
export const SECRET_HEADER = "X-Portail-Secret";
export const CREDENTIAL_NAME = "Portail d'actions (en-tête)";
const HEADER_AUTH_TYPE = "httpHeaderAuth";

// Déclencheurs qu'un portail sait appeler : webhook POST, sans paramètre de
// chemin, protégé par le credential du portail. Les autres sont signalés avec
// la raison, pour que le propriétaire sache quoi changer dans son workflow.
export function webhookTriggers(workflow, { credentialId = null } = {}) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  return nodes
    .filter((node) => node.type === WEBHOOK_TYPE && !node.disabled)
    .map((node) => {
      const p = node.parameters || {};
      const method = String(p.httpMethod || "GET").toUpperCase();
      const path = String(p.path || node.webhookId || "").replace(/^\/+|\/+$/g, "");
      const responseMode = p.responseMode || "onReceived";
      const auth = p.authentication || "none";
      const usedCredential = node.credentials?.[HEADER_AUTH_TYPE]?.id ?? null;
      let blocker = null;
      if (method !== "POST") blocker = `le webhook attend ${method}, le portail envoie POST`;
      else if (!path) blocker = "le webhook n'a pas de chemin";
      else if (path.includes(":")) blocker = "le chemin du webhook contient un paramètre";
      else if (auth === "none") blocker = `webhook non protégé : réglez son authentification sur Header Auth avec le credential « ${CREDENTIAL_NAME} »`;
      else if (auth !== "headerAuth" || !credentialId || String(usedCredential) !== String(credentialId)) {
        blocker = `le webhook doit utiliser le credential « ${CREDENTIAL_NAME} » (Header Auth)`;
      }
      return { node: node.name, method, path, responseMode, blocker };
    });
}

// Un workflow n8n 2.x est « publié » quand une version est active ; le champ
// active reste renseigné par l'API publique.
export function isPublished(workflow) {
  if (typeof workflow?.active === "boolean") return workflow.active;
  return Boolean(workflow?.activeVersionId);
}

// Noms des champs lus dans le corps du webhook, d'après les expressions des
// nœuds : $json.body.x, $json["body"]["x"], $('Webhook').item.json.body.x.
export function inputNamesFromWorkflow(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const text = JSON.stringify(nodes.map((node) => node.parameters || {}));
  const names = new Set();
  const dotted = /(?:\$json|\.json)\.body\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const bracketed = /(?:\$json|\.json)\[\s*\\?["']body\\?["']\s*\]\s*\[\s*\\?["']([A-Za-z_][A-Za-z0-9_]*)\\?["']\s*\]/g;
  for (const re of [dotted, bracketed]) {
    for (const match of text.matchAll(re)) {
      if (match[1] !== CONTEXT_KEY) names.add(match[1]);
    }
  }
  // Nœuds Code : le corps est souvent rangé dans une variable
  // (const body = $input.first().json.body) puis lu champ par champ, ou
  // déstructuré (const { texte } = $json.body).
  for (const node of nodes) {
    const code = node.parameters?.jsCode;
    if (typeof code !== "string") continue;
    for (const name of inputNamesFromCode(code)) if (name !== CONTEXT_KEY) names.add(name);
  }
  return [...names];
}

const BODY_SOURCE = String.raw`(?:\$json|\$input\.(?:first|last|item|all)\(\)(?:\[\d+\])?\.json|\$\([^)]*\)\.(?:first|last|item)\(?\)?\.json|items\[\d+\]\.json)\.body`;

function inputNamesFromCode(code) {
  const names = new Set();
  const variable = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${BODY_SOURCE}\b(?:\s*\|\|\s*\{\})?`, "g");
  for (const [, v] of code.matchAll(variable)) {
    const escaped = v.replace(/\$/g, "\\$");
    const dotted = new RegExp(String.raw`(?<![\w$.])${escaped}\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
    const bracketed = new RegExp(String.raw`(?<![\w$.])${escaped}\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]`, "g");
    for (const re of [dotted, bracketed]) for (const m of code.matchAll(re)) names.add(m[1]);
  }
  const destructured = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${BODY_SOURCE}\b`, "g");
  for (const [, list] of code.matchAll(destructured)) {
    for (const part of list.split(",")) {
      const name = part.split(/[:=]/)[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

export function createN8nClient({ baseUrl, apiKeyFile, webhookSecret = "", fetchImpl = fetch, runTimeoutMs = 120000 }) {
  async function apiKey() {
    try {
      return (await readFile(apiKeyFile, "utf8")).trim();
    } catch {
      throw new N8nError("La clé API de n8n n'est pas encore prête : le provisioning est en cours.", 503);
    }
  }

  async function request(path, { method = "GET", body, key } = {}) {
    try {
      return await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        headers: {
          "x-n8n-api-key": key ?? (await apiKey()),
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (error instanceof N8nError) throw error;
      throw new N8nError("n8n ne répond pas.", 503);
    }
  }

  async function api(path, options) {
    const response = await request(path, options);
    if (!response.ok) throw new N8nError(`L'API de n8n a répondu ${response.status}.`);
    return response.json();
  }

  async function paginate(path) {
    const out = [];
    let cursor = "";
    do {
      const page = await api(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...(page.data || []));
      cursor = page.nextCursor || "";
    } while (cursor && out.length < 1000);
    return out;
  }

  return {
    listWorkflows() {
      return paginate("/workflows");
    },

    getWorkflow(id) {
      return api(`/workflows/${encodeURIComponent(id)}`);
    },

    // Compte n8n présenté par quelqu'un qui veut administrer le portail : n8n
    // le vérifie lui-même (/rest/login, sur localhost). Seuls le propriétaire
    // et les administrateurs de l'instance passent. La session ouverte chez n8n
    // pour cette vérification est refermée aussitôt ; rien n'est conservé.
    async checkAccount({ email, password, mfaCode }) {
      if (!email || !password) return { ok: false };
      const headers = { "content-type": "application/json", "browser-id": "portail-verification" };
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/rest/login`, {
          method: "POST",
          headers,
          body: JSON.stringify({ emailOrLdapLoginId: String(email), password: String(password), ...(mfaCode ? { mfaCode: String(mfaCode) } : {}) }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new N8nError("n8n ne répond pas.", 503);
      }
      const body = await response.json().catch(() => ({}));
      if (response.status !== 200) {
        // n8n signale ainsi un compte à double authentification sans code.
        if (body?.code === 998 || /mfa/i.test(String(body?.message))) {
          throw new N8nError("Ce compte n8n a la double authentification : saisissez aussi le code.", 401);
        }
        return { ok: false };
      }
      const user = body?.data || {};
      const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("n8n-auth="));
      if (cookie) {
        await fetchImpl(`${baseUrl}/rest/logout`, { method: "POST", headers: { ...headers, cookie } }).catch(() => {});
      }
      const role = String(user.role || "");
      return { ok: true, admin: user.isOwner === true || role === "global:owner" || role === "global:admin", role };
    },

    // Une clé API présentée par quelqu'un qui veut administrer le portail :
    // valide si n8n l'accepte pour lire les workflows.
    async checkApiKey(key) {
      if (!key) return false;
      const response = await request("/workflows?limit=1", { key: String(key) });
      if (response.status === 403) {
        throw new N8nError("Clé API n8n valide, mais sans le droit de lire les workflows.", 403);
      }
      return response.ok;
    },

    // Credential « Header Auth » qui porte le secret du portail. Retrouvé par
    // son identifiant connu, sinon par son nom, sinon créé. Son usage par un
    // nœud HTTP Request est interdit : il ne sert qu'à vérifier les appels.
    async ensureCredential(knownId) {
      if (!webhookSecret) return null;
      const all = await paginate("/credentials");
      const mine = all.filter((c) => c.type === HEADER_AUTH_TYPE);
      const found = mine.find((c) => String(c.id) === String(knownId)) || mine.find((c) => c.name === CREDENTIAL_NAME);
      if (found) return String(found.id);
      const created = await api("/credentials", {
        method: "POST",
        body: {
          name: CREDENTIAL_NAME,
          type: HEADER_AUTH_TYPE,
          data: { name: SECRET_HEADER, value: webhookSecret, allowedHttpRequestDomains: "none" },
        },
      });
      return String(created.id);
    },

    async runWebhook({ path, inputs, context }) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/webhook/${path.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain;q=0.9",
            ...(webhookSecret ? { [SECRET_HEADER.toLowerCase()]: webhookSecret } : {}),
          },
          body: JSON.stringify({ ...inputs, [CONTEXT_KEY]: context }),
          signal: AbortSignal.timeout(runTimeoutMs),
        });
      } catch (error) {
        if (error?.name === "TimeoutError") {
          throw new N8nError("Le workflow n'a pas répondu à temps.", 504);
        }
        throw new N8nError("n8n ne répond pas.", 503);
      }
      const text = await readLimited(response, MAX_RESPONSE_BYTES);
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { message: text };
      }
      if (Array.isArray(body)) body = body.length === 1 && body[0] && typeof body[0] === "object" ? body[0] : { items: body };
      if (body === null || typeof body !== "object") body = { message: String(body) };
      if (response.status === 404) {
        throw new N8nError("Ce workflow n'est pas publié dans n8n : son webhook de production ne répond pas.", 502);
      }
      if (response.status === 401 || response.status === 403) {
        throw new N8nError("Le webhook refuse le portail : son credential ne porte plus le secret du portail.", 502, text.slice(0, 200));
      }
      if (!response.ok) {
        const detail = typeof body.message === "string" ? body.message.slice(0, 500) : text.slice(0, 500);
        throw new N8nError(`Le workflow a échoué (HTTP ${response.status}). Le propriétaire trouvera le détail dans les exécutions de n8n.`, 502, detail);
      }
      return body;
    },
  };
}
