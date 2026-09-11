// Doublures de Grist et de n8n pour les tests du portail.

export const GRIST = "https://grist.example.org";
export const DOC = "docTest00001";
export const OTHER_DOC = "docAutre0002";
export const ANON = 99;
export const SECRET = "secret-du-portail";
// Clés API acceptées par le faux n8n : celle du provisioning (fichier) et une
// clé créée par le propriétaire dans l'interface de n8n.
export const API_KEYS = new Set(["cle-api", "cle-du-proprietaire"]);

export function jwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}

export function tokenFor(userId, docId = DOC, { exp = Math.floor(Date.now() / 1000) + 300, readOnly } = {}) {
  return jwt({ userId, docId, exp, ...(readOnly === undefined ? {} : { readOnly }) });
}

export function baseFor(docId = DOC) {
  return `${GRIST}/o/docs/api/docs/${docId}`;
}

// Grist accepte les jetons qu'il a « émis » : ceux de l'ensemble `valid`. Une
// session sans cookie est celle de l'anonyme.
export function fakeGrist(valid, { anonymousId = ANON, sessionDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/api/session/access/active") {
      if (sessionDown) return new Response("{}", { status: 503 });
      return Response.json({ user: { id: anonymousId, email: "anon@getgrist.com", anonymous: true } });
    }
    const token = u.searchParams.get("auth");
    return new Response(JSON.stringify({ tables: [] }), { status: valid.has(token) ? 200 : 401 });
  };
  return { fetchImpl, calls: () => calls.filter((c) => !c.includes("/api/session/")) };
}

export const CREDENTIAL_ID = "cred-1";

export const WORKFLOW = {
  id: "wf1",
  name: "Analyser une page web",
  active: true,
  tags: [{ name: "portail" }],
  nodes: [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { httpMethod: "POST", path: "analyse-web", responseMode: "lastNode", authentication: "headerAuth" },
      credentials: { httpHeaderAuth: { id: CREDENTIAL_ID, name: "Portail d'actions (en-tête)" } },
    },
    {
      name: "Résumer",
      type: "n8n-nodes-base.set",
      parameters: { value: "={{ $json.body.url }} et {{ $('Webhook').item.json.body.consigne }} {{ $json.body._portail.runId }}" },
    },
  ],
};

export function fakeN8n({
  workflows = [WORKFLOW],
  credentials = [],
  respond = () => ({ status: 200, body: { success: true, resume: "ok", interne: "secret" } }),
} = {}) {
  const runs = [];
  const created = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const key = init.headers?.["x-n8n-api-key"];
    if (u.pathname.startsWith("/api/v1/") && !API_KEYS.has(key)) {
      return new Response('{"message":"unauthorized"}', { status: 401 });
    }
    if (u.pathname === "/api/v1/workflows") return Response.json({ data: workflows, nextCursor: null });
    const m = /^\/api\/v1\/workflows\/(.+)$/.exec(u.pathname);
    if (m) {
      const wf = workflows.find((w) => w.id === decodeURIComponent(m[1]));
      return wf ? Response.json(wf) : new Response("{}", { status: 404 });
    }
    if (u.pathname === "/api/v1/credentials" && method === "GET") {
      return Response.json({ data: credentials.map(({ id, name, type }) => ({ id, name, type })), nextCursor: null });
    }
    if (u.pathname === "/api/v1/credentials" && method === "POST") {
      const body = JSON.parse(init.body);
      const cred = { id: CREDENTIAL_ID, ...body };
      credentials.push(cred);
      created.push(cred);
      return Response.json({ id: cred.id, name: cred.name, type: cred.type });
    }
    if (u.pathname.startsWith("/webhook/")) {
      const path = u.pathname.slice("/webhook/".length);
      const wf = workflows.find((w) => w.nodes.some((n) => n.parameters?.path === path));
      const node = wf?.nodes.find((n) => n.parameters?.path === path);
      if (node?.parameters?.authentication === "headerAuth") {
        const cred = credentials.find((c) => c.id === node.credentials?.httpHeaderAuth?.id);
        const header = Object.entries(init.headers || {}).find(([k]) => k.toLowerCase() === cred?.data?.name?.toLowerCase());
        if (!cred || !header || header[1] !== cred.data.value) {
          return new Response("Authorization data is wrong!", { status: 403 });
        }
      }
      const body = JSON.parse(init.body);
      runs.push({ path, body, headers: init.headers });
      const r = respond(body);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, runs, credentials, created };
}
