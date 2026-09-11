// Doublures de Grist et de n8n pour les tests du portail.

export const GRIST = "https://grist.example.org";
export const DOC = "docTest00001";
export const OTHER_DOC = "docAutre0002";

export function jwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}

export function tokenFor(userId, docId = DOC, { exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
  return jwt({ userId, docId, exp });
}

export function baseFor(docId = DOC) {
  return `${GRIST}/o/docs/api/docs/${docId}`;
}

// Grist accepte les jetons qu'il a « émis » : ceux de l'ensemble `valid`.
export function fakeGrist(valid) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const token = new URL(url).searchParams.get("auth");
    return new Response(JSON.stringify({ tables: [] }), { status: valid.has(token) ? 200 : 401 });
  };
  return { fetchImpl, calls };
}

export const WORKFLOW = {
  id: "wf1",
  name: "Analyser une page web",
  active: true,
  tags: [{ name: "portail" }],
  nodes: [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { httpMethod: "POST", path: "analyse-web", responseMode: "lastNode" },
    },
    {
      name: "Résumer",
      type: "n8n-nodes-base.set",
      parameters: { value: "={{ $json.body.url }} et {{ $('Webhook').item.json.body.consigne }} {{ $json.body._portail.runId }}" },
    },
  ],
};

export function fakeN8n({ workflows = [WORKFLOW], respond = () => ({ status: 200, body: { success: true, resume: "ok", interne: "secret" } }) } = {}) {
  const runs = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/workflows") {
      return Response.json({ data: workflows, nextCursor: null });
    }
    const m = /^\/api\/v1\/workflows\/(.+)$/.exec(u.pathname);
    if (m) {
      const wf = workflows.find((w) => w.id === decodeURIComponent(m[1]));
      return wf ? Response.json(wf) : new Response("{}", { status: 404 });
    }
    if (u.pathname.startsWith("/webhook/")) {
      const body = JSON.parse(init.body);
      runs.push({ path: u.pathname.slice("/webhook/".length), body });
      const r = respond(body);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, runs };
}
