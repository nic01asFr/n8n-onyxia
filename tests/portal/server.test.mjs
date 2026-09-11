import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, configFromEnv } from "../../charts/n8n/files/portal/server.mjs";
import { createIdentityVerifier } from "../../charts/n8n/files/portal/identity.mjs";
import { createN8nClient } from "../../charts/n8n/files/portal/n8n.mjs";
import { openStore } from "../../charts/n8n/files/portal/store.mjs";
import { ANON, DOC, GRIST, OTHER_DOC, SECRET, WORKFLOW, baseFor, fakeGrist, fakeN8n, tokenFor } from "./helpers.mjs";

const OWNER = 10;
const COLLEGUE = 20;
const OWNER_KEY = "cle-du-proprietaire";

async function startPortal({ n8n = fakeN8n() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portail-"));
  writeFileSync(join(dir, "key"), "cle-api");
  const tokens = {
    owner: tokenFor(OWNER),
    ownerOther: tokenFor(OWNER, OTHER_DOC),
    collegue: tokenFor(COLLEGUE),
    collegueOther: tokenFor(COLLEGUE, OTHER_DOC),
    collegueWrite: tokenFor(COLLEGUE, DOC, { readOnly: false, exp: Math.floor(Date.now() / 1000) + 290 }),
    collegueReadOnly: tokenFor(COLLEGUE, DOC, { readOnly: true, exp: Math.floor(Date.now() / 1000) + 280 }),
    ownerWrite: tokenFor(OWNER, DOC, { readOnly: false, exp: Math.floor(Date.now() / 1000) + 290 }),
    anon: tokenFor(ANON),
  };
  const grist = fakeGrist(new Set(Object.values(tokens)));
  const config = { ...configFromEnv({}), webhookSecret: SECRET, gristOrigins: [GRIST], storeFile: join(dir, "portail.json") };
  const store = await openStore(config.storeFile);
  const handle = createPortal({
    config,
    store,
    verifyIdentity: createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl }),
    n8n: createN8nClient({ baseUrl: "http://127.0.0.1:5678", apiKeyFile: join(dir, "key"), webhookSecret: SECRET, fetchImpl: n8n.fetchImpl }),
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { as = "owner", session, body } = {}) {
    const headers = { "x-grist-token": tokens[as], "x-grist-base": baseFor(as.endsWith("Other") ? OTHER_DOC : DOC) };
    if (session) headers.authorization = `Bearer ${session}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  }

  async function login(as = "owner", apiKey = OWNER_KEY) {
    return call("POST", "/api/admin/login", { as, body: { apiKey } });
  }

  return { url, call, login, tokens, n8n, store, config, close: () => new Promise((r) => server.close(r)) };
}

async function exposeAnalyse(p, { gristAccess = "none", writeBack } = {}) {
  const { json: { session } } = await p.login();
  const draft = await p.call("POST", "/api/admin/draft", { session, body: { workflowId: "wf1", node: "Webhook" } });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  const formdef = draft.json.formdef;
  formdef.sections[0].fields[0].required = true;
  formdef.result.fields = [{ key: "resume", label: "Résumé", render: "markdown" }];
  const saved = await p.call("POST", "/api/admin/action", {
    session, body: { key: draft.json.key, workflowId: "wf1", node: "Webhook", formdef, gristAccess, writeBack },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return { key: draft.json.key, session };
}

test("le mode Configurer s'ouvre avec une clé API de ce n8n, pour le compte associé", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  assert.equal((await p.call("GET", "/api/admin/state")).status, 401);
  assert.equal((await p.login("owner", "inventee")).status, 401);
  // Un anonyme ne peut pas devenir propriétaire, même avec une vraie clé.
  assert.equal((await p.login("anon")).status, 403);
  const ok = await p.login();
  assert.equal(ok.status, 200);
  assert.ok(ok.json.expiresAt > Date.now());
  assert.equal(JSON.stringify(ok.json).includes(OWNER_KEY), false, "la clé n8n ne revient pas au navigateur");
  const state = await p.call("GET", "/api/admin/state", { session: ok.json.session });
  assert.equal(state.status, 200);
  assert.equal(state.json.credential.header, "X-Portail-Secret");
  assert.equal(state.json.workflows[0].triggers[0].blocker, null);
  // Une vraie clé ne suffit pas à un autre compte Grist, ni la session d'un autre.
  assert.equal((await p.login("collegue")).status, 403);
  assert.equal((await p.call("GET", "/api/admin/state", { as: "collegue", session: ok.json.session })).status, 401);
  assert.equal((await p.call("GET", "/api/admin/state", { session: `${ok.json.session}x` })).status, 401);
  assert.equal(JSON.parse(readFileSync(p.config.storeFile, "utf8")).owner.userId, OWNER);
});

test("le credential du portail est créé dans n8n au premier besoin, une seule fois", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { json: { session } } = await p.login();
  await p.call("GET", "/api/admin/state", { session });
  await p.call("GET", "/api/admin/state", { session });
  assert.equal(p.n8n.created.length, 1);
  assert.equal(p.n8n.created[0].data.value, SECRET);
});

test("une action n'est visible et lançable que dans le document qui l'ouvre", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { key, session } = await exposeAnalyse(p);
  assert.equal(key, "analyser-une-page-web");

  assert.deepEqual((await p.call("GET", "/api/catalog", { as: "collegue" })).json.actions, []);
  assert.equal((await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } })).status, 404);

  const opened = await p.call("POST", "/api/admin/access", { session, body: { actions: [key, "inconnue"] } });
  assert.deepEqual(opened.json.openedHere, [key]);
  assert.equal(opened.json.signedInOnly, true, "réservé aux comptes connectés par défaut");

  const catalog = await p.call("GET", "/api/catalog", { as: "collegue" });
  assert.equal(catalog.json.isOwner, false);
  assert.equal(catalog.json.actions[0].key, key);
  assert.equal(JSON.stringify(catalog.json).includes("analyse-web"), false, "le chemin du webhook ne doit pas fuiter");

  assert.deepEqual((await p.call("GET", "/api/catalog", { as: "collegueOther" })).json.actions, []);
  assert.equal((await p.call("POST", "/api/run", { as: "collegueOther", body: { action: key, inputs: { url: "u" } } })).status, 404);
});

test("un document ouvert reste fermé aux visiteurs anonymes, sauf choix contraire", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { key, session } = await exposeAnalyse(p);
  await p.call("POST", "/api/admin/access", { session, body: { actions: [key] } });
  const anonCatalog = await p.call("GET", "/api/catalog", { as: "anon" });
  assert.equal(anonCatalog.json.signInRequired, true);
  assert.deepEqual(anonCatalog.json.actions, []);
  assert.equal((await p.call("POST", "/api/run", { as: "anon", body: { action: key, inputs: { url: "u" } } })).status, 403);

  await p.call("POST", "/api/admin/access", { session, body: { actions: [key], signedInOnly: false } });
  assert.equal((await p.call("GET", "/api/catalog", { as: "anon" })).json.actions.length, 1);
  assert.equal((await p.call("POST", "/api/run", { as: "anon", body: { action: key, inputs: { url: "u" } } })).status, 200);
});

test("un lancement passe des entrées contrôlées, l'identité vérifiée et le secret au workflow", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { key, session } = await exposeAnalyse(p);
  await p.call("POST", "/api/admin/access", { session, body: { actions: [key] } });

  const missing = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: {} } });
  assert.equal(missing.status, 422);
  assert.equal(p.n8n.runs.length, 0);

  const run = await p.call("POST", "/api/run", {
    as: "collegue",
    body: { action: key, inputs: { url: "https://exemple.gouv.fr", intrus: "x", _portail: { requester: { gristUserId: OWNER } } } },
  });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.deepEqual(run.json.result, { resume: "ok" });
  const sent = p.n8n.runs[0];
  assert.equal(sent.body.url, "https://exemple.gouv.fr");
  assert.equal(sent.body.intrus, undefined);
  assert.equal(sent.body._portail.requester.gristUserId, COLLEGUE, "l'identité vient du jeton, pas du corps");
  assert.equal(sent.body._portail.grist, undefined, "aucun accès au document sans le demander");
  assert.equal(sent.headers["x-portail-secret"], SECRET);
});

test("l'accès délégué au document suit l'action et les droits réels du lecteur", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { key, session } = await exposeAnalyse(p, { gristAccess: "write" });
  await p.call("POST", "/api/admin/access", { session, body: { actions: [key] } });
  const inputs = { url: "u" };

  assert.equal((await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs } })).status, 422);
  // Le jeton d'un autre lecteur ne passe pas.
  const stolen = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs, delegated: { token: p.tokens.ownerWrite } } });
  assert.equal(stolen.status, 403);

  const write = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs, delegated: { token: p.tokens.collegueWrite } } });
  assert.equal(write.status, 200, JSON.stringify(write.json));
  const grist = p.n8n.runs.at(-1).body._portail.grist;
  assert.equal(grist.access, "write");
  assert.equal(grist.baseUrl, baseFor(DOC));
  assert.equal(grist.token, p.tokens.collegueWrite);

  // Un lecteur en lecture seule ne reçoit qu'un accès en lecture.
  await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs, delegated: { token: p.tokens.collegueReadOnly } } });
  assert.equal(p.n8n.runs.at(-1).body._portail.grist.access, "read");
});

test("l'écriture du résultat est validée à l'enregistrement et annoncée au widget", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const { json: { session } } = await p.login();
  const draft = await p.call("POST", "/api/admin/draft", { session, body: { workflowId: "wf1", node: "Webhook" } });
  const bad = await p.call("POST", "/api/admin/action", {
    session, body: { key: "a", workflowId: "wf1", node: "Webhook", formdef: { ...draft.json.formdef, target: { kind: "action", action: "a" } }, writeBack: { tableId: "1 table", fields: {} } },
  });
  assert.equal(bad.status, 422);
  const { key } = await exposeAnalyse(p, { writeBack: { tableId: "Resultats", fields: { resume: "Resume" } } });
  await p.call("POST", "/api/admin/access", { session, body: { actions: [key] } });
  const catalog = await p.call("GET", "/api/catalog", { as: "collegue" });
  assert.deepEqual(catalog.json.actions[0].writeBack, { tableId: "Resultats", fields: { resume: "Resume" } });
});

test("un workflow dépublié, modifié ou non protégé bloque l'action avec un message clair", async (t) => {
  const workflow = structuredClone(WORKFLOW);
  const p = await startPortal({ n8n: fakeN8n({ workflows: [workflow] }) });
  t.after(p.close);
  const { key, session } = await exposeAnalyse(p);
  await p.call("POST", "/api/admin/access", { session, body: { actions: [key] } });
  workflow.active = false;
  const unpublished = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } });
  assert.equal(unpublished.status, 409);
  assert.match(unpublished.json.error, /pas publié/);
  workflow.active = true;
  workflow.nodes[0].parameters.authentication = "none";
  const unprotected = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } });
  assert.equal(unprotected.status, 409);
  assert.match(unprotected.json.error, /reconfigurer/);
});

test("un jeton non émis par Grist ne donne accès à rien", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const forged = await fetch(`${p.url}/api/catalog`, {
    headers: { "x-grist-token": tokenFor(OWNER, DOC, { exp: 4102444800 }), "x-grist-base": baseFor() },
  });
  assert.equal(forged.status, 401);
  const foreign = await fetch(`${p.url}/api/catalog`, {
    headers: { "x-grist-token": tokenFor(OWNER), "x-grist-base": `https://ailleurs.example/api/docs/${DOC}` },
  });
  assert.equal(foreign.status, 403);
});

test("la page ne s'intègre que dans les hôtes Grist autorisés", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const res = await fetch(`${p.url}/healthz`);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, new RegExp(`frame-ancestors ${GRIST}(;|$)`));
  assert.match(csp, /default-src 'none'/);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal((await fetch(`${p.url}/`, { method: "HEAD" })).status, 200);
});
