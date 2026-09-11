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
import { DOC, GRIST, OTHER_DOC, baseFor, fakeGrist, fakeN8n, tokenFor } from "./helpers.mjs";

const ADMIN = "jeton-admin-de-test";
const OWNER = 10;
const COLLEGUE = 20;
const INTRUS = 30;

async function startPortal({ n8n = fakeN8n() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portail-"));
  writeFileSync(join(dir, "key"), "cle-api");
  const tokens = {
    owner: tokenFor(OWNER),
    ownerOther: tokenFor(OWNER, OTHER_DOC),
    collegue: tokenFor(COLLEGUE),
    collegueOther: tokenFor(COLLEGUE, OTHER_DOC),
    intrus: tokenFor(INTRUS),
  };
  const grist = fakeGrist(new Set(Object.values(tokens)));
  const config = {
    ...configFromEnv({}),
    adminToken: ADMIN,
    gristOrigins: [GRIST],
    storeFile: join(dir, "portail.json"),
  };
  const store = await openStore(config.storeFile);
  const handle = createPortal({
    config,
    store,
    verifyIdentity: createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl }),
    n8n: createN8nClient({ baseUrl: "http://127.0.0.1:5678", apiKeyFile: join(dir, "key"), fetchImpl: n8n.fetchImpl }),
  });
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { as = "owner", admin = false, body, docId } = {}) {
    const headers = { "x-grist-token": tokens[as], "x-grist-base": baseFor(docId ?? (as.endsWith("Other") ? OTHER_DOC : DOC)) };
    if (admin) headers.authorization = `Bearer ${admin === true ? ADMIN : admin}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  }

  return { url, call, n8n, store, config, close: () => new Promise((r) => server.close(r)) };
}

async function exposeAnalyse(p) {
  await p.call("POST", "/api/admin/pair", { admin: true });
  const draft = await p.call("POST", "/api/admin/draft", { admin: true, body: { workflowId: "wf1", node: "Webhook" } });
  const formdef = draft.json.formdef;
  formdef.sections[0].fields[0].required = true;
  formdef.result.fields = [{ key: "resume", label: "Résumé", render: "markdown" }];
  const saved = await p.call("POST", "/api/admin/action", {
    admin: true, body: { key: draft.json.key, workflowId: "wf1", node: "Webhook", formdef },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  return draft.json.key;
}

test("l'administration exige le jeton d'administration, puis le compte associé", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  assert.equal((await p.call("GET", "/api/admin/state")).status, 401);
  assert.equal((await p.call("GET", "/api/admin/state", { admin: "mauvais" })).status, 401);
  assert.equal((await p.call("GET", "/api/admin/state", { admin: true })).status, 403);
  assert.equal((await p.call("POST", "/api/admin/pair", { admin: true })).status, 200);
  const state = await p.call("GET", "/api/admin/state", { admin: true });
  assert.equal(state.status, 200);
  assert.equal(state.json.workflows[0].triggers[0].path, "analyse-web");
  // Même avec le jeton d'administration, un autre compte Grist n'entre pas.
  assert.equal((await p.call("POST", "/api/admin/pair", { as: "collegue", admin: true })).status, 403);
  assert.equal((await p.call("GET", "/api/admin/state", { as: "collegue", admin: true })).status, 403);
  assert.deepEqual(JSON.parse(readFileSync(p.config.storeFile, "utf8")).owner.userId, OWNER);
});

test("une action n'est visible et lançable que dans le document qui l'ouvre", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const key = await exposeAnalyse(p);
  assert.equal(key, "analyser-une-page-web");

  // Pas encore ouverte : invisible pour le collègue.
  assert.deepEqual((await p.call("GET", "/api/catalog", { as: "collegue" })).json.actions, []);
  const refused = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } });
  assert.equal(refused.status, 404);

  const opened = await p.call("POST", "/api/admin/access", { admin: true, body: { actions: [key, "inconnue"] } });
  assert.deepEqual(opened.json.openedHere, [key]);

  const catalog = await p.call("GET", "/api/catalog", { as: "collegue" });
  assert.equal(catalog.json.isOwner, false);
  assert.equal(catalog.json.actions[0].key, key);
  assert.equal(catalog.json.actions[0].formdef.target.action, key);
  assert.equal(JSON.stringify(catalog.json).includes("analyse-web"), false, "le chemin du webhook ne doit pas fuiter");

  // Dans un autre document, rien.
  assert.deepEqual((await p.call("GET", "/api/catalog", { as: "collegueOther" })).json.actions, []);
  assert.equal((await p.call("POST", "/api/run", { as: "collegueOther", body: { action: key, inputs: { url: "u" } } })).status, 404);
});

test("un lancement passe des entrées contrôlées et l'identité vérifiée au workflow", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  const key = await exposeAnalyse(p);
  await p.call("POST", "/api/admin/access", { admin: true, body: { actions: [key] } });

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
  assert.equal(sent.path, "analyse-web");
  assert.equal(sent.body.url, "https://exemple.gouv.fr");
  assert.equal(sent.body.intrus, undefined);
  assert.equal(sent.body._portail.requester.gristUserId, COLLEGUE, "l'identité vient du jeton, pas du corps");
  assert.equal(sent.body._portail.document.docId, DOC);
  assert.equal(sent.body._portail.runId, run.json.runId);
});

test("un workflow dépublié ou modifié bloque l'action avec un message clair", async (t) => {
  const workflow = structuredClone((await import("./helpers.mjs")).WORKFLOW);
  const p = await startPortal({ n8n: fakeN8n({ workflows: [workflow] }) });
  t.after(p.close);
  const key = await exposeAnalyse(p);
  await p.call("POST", "/api/admin/access", { admin: true, body: { actions: [key] } });
  workflow.active = false;
  const unpublished = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } });
  assert.equal(unpublished.status, 409);
  assert.match(unpublished.json.error, /pas publié/);
  workflow.active = true;
  workflow.nodes[0].parameters.httpMethod = "GET";
  const changed = await p.call("POST", "/api/run", { as: "collegue", body: { action: key, inputs: { url: "u" } } });
  assert.equal(changed.status, 409);
  assert.match(changed.json.error, /reconfigurer/);
});

test("un jeton non émis par Grist ne donne accès à rien", async (t) => {
  const p = await startPortal();
  t.after(p.close);
  // Même utilisateur et même document, mais une charge utile que Grist n'a pas signée.
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
});
