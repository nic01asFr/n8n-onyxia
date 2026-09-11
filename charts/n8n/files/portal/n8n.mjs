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

// Déclencheurs qu'un portail sait appeler : webhook POST, sans paramètre de
// chemin. Les autres sont signalés avec la raison, pour que le propriétaire
// sache quoi changer dans son workflow.
export function webhookTriggers(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  return nodes
    .filter((node) => node.type === WEBHOOK_TYPE && !node.disabled)
    .map((node) => {
      const p = node.parameters || {};
      const method = String(p.httpMethod || "GET").toUpperCase();
      const path = String(p.path || node.webhookId || "").replace(/^\/+|\/+$/g, "");
      const responseMode = p.responseMode || "onReceived";
      let blocker = null;
      if (method !== "POST") blocker = `le webhook attend ${method}, le portail envoie POST`;
      else if (!path) blocker = "le webhook n'a pas de chemin";
      else if (path.includes(":")) blocker = "le chemin du webhook contient un paramètre";
      else if (p.authentication && p.authentication !== "none") blocker = "le webhook exige une authentification";
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
  return [...names];
}

export function createN8nClient({ baseUrl, apiKeyFile, fetchImpl = fetch, runTimeoutMs = 120000 }) {
  async function apiKey() {
    try {
      return (await readFile(apiKeyFile, "utf8")).trim();
    } catch {
      throw new N8nError("La clé API de n8n n'est pas encore prête : le provisioning est en cours.", 503);
    }
  }

  async function api(path) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        headers: { "x-n8n-api-key": await apiKey(), accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (error instanceof N8nError) throw error;
      throw new N8nError("n8n ne répond pas.", 503);
    }
    if (!response.ok) throw new N8nError(`L'API de n8n a répondu ${response.status}.`);
    return response.json();
  }

  return {
    async listWorkflows() {
      const out = [];
      let cursor = "";
      do {
        const page = await api(`/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        out.push(...(page.data || []));
        cursor = page.nextCursor || "";
      } while (cursor && out.length < 1000);
      return out;
    },

    getWorkflow(id) {
      return api(`/workflows/${encodeURIComponent(id)}`);
    },

    async runWebhook({ path, inputs, context }) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/webhook/${path.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/plain;q=0.9" },
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
      if (!response.ok) {
        const detail = typeof body.message === "string" ? body.message.slice(0, 500) : text.slice(0, 500);
        throw new N8nError(`Le workflow a échoué (HTTP ${response.status}). Le propriétaire trouvera le détail dans les exécutions de n8n.`, 502, detail);
      }
      return body;
    },
  };
}
