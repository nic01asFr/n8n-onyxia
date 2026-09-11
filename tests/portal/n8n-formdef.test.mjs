import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createN8nClient, inputNamesFromWorkflow, isPublished, webhookTriggers } from "../../charts/n8n/files/portal/n8n.mjs";
import { checkInputs, draftFormDef, pickResult, validateActionFormDef } from "../../charts/n8n/files/portal/formdef.mjs";
import { CREDENTIAL_ID, SECRET, WORKFLOW, fakeN8n } from "./helpers.mjs";

const hook = (parameters, extra = {}) => ({ nodes: [{ name: "W", type: "n8n-nodes-base.webhook", parameters, ...extra }] });

const protectedBy = (id) => ({ credentials: { httpHeaderAuth: { id, name: "x" } } });

test("webhookTriggers n'expose qu'un webhook POST protégé par le credential du portail", () => {
  const opts = { credentialId: CREDENTIAL_ID };
  const ok = { httpMethod: "POST", path: "ok", authentication: "headerAuth" };
  assert.equal(webhookTriggers(hook(ok, protectedBy(CREDENTIAL_ID)), opts)[0].blocker, null);
  assert.match(webhookTriggers(hook({ httpMethod: "POST", path: "ok" }), opts)[0].blocker, /non protégé/);
  assert.match(webhookTriggers(hook(ok, protectedBy("autre")), opts)[0].blocker, /doit utiliser le credential/);
  assert.match(webhookTriggers(hook({ ...ok, authentication: "basicAuth" }), opts)[0].blocker, /doit utiliser le credential/);
  // Sans credential connu (n8n indisponible au démarrage), rien n'est exposable.
  assert.notEqual(webhookTriggers(hook(ok, protectedBy(CREDENTIAL_ID)))[0].blocker, null);
  assert.match(webhookTriggers(hook({ path: "x" }), opts)[0].blocker, /attend GET/);
  assert.match(webhookTriggers(hook({ httpMethod: "POST", path: "a/:id" }), opts)[0].blocker, /paramètre/);
  assert.equal(webhookTriggers(hook({ httpMethod: "POST" }, { webhookId: "abc" }), opts)[0].path, "abc");
  assert.equal(webhookTriggers(hook(ok, { disabled: true }), opts).length, 0);
});

function keyFile() {
  const dir = mkdtempSync(join(tmpdir(), "portail-"));
  writeFileSync(join(dir, "key"), "cle-api\n");
  return join(dir, "key");
}

const portalCredential = () => [{ id: CREDENTIAL_ID, name: "Portail d'actions (en-tête)", type: "httpHeaderAuth", data: { name: "X-Portail-Secret", value: SECRET } }];

test("ensureCredential crée une seule fois le credential, inutilisable par HTTP Request", async () => {
  const fake = fakeN8n();
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: keyFile(), webhookSecret: SECRET, fetchImpl: fake.fetchImpl });
  assert.equal(await client.ensureCredential(null), CREDENTIAL_ID);
  assert.equal(await client.ensureCredential(CREDENTIAL_ID), CREDENTIAL_ID);
  assert.equal(fake.created.length, 1);
  assert.deepEqual(fake.created[0].data, { name: "X-Portail-Secret", value: SECRET, allowedHttpRequestDomains: "none" });
});

test("checkApiKey n'accepte que les clés reconnues par ce n8n", async () => {
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: keyFile(), fetchImpl: fakeN8n().fetchImpl });
  assert.equal(await client.checkApiKey("cle-du-proprietaire"), true);
  assert.equal(await client.checkApiKey("inventee"), false);
  assert.equal(await client.checkApiKey(""), false);
});

test("isPublished lit active, puis la version active", () => {
  assert.equal(isPublished({ active: true }), true);
  assert.equal(isPublished({ active: false, activeVersionId: "v1" }), false);
  assert.equal(isPublished({ activeVersionId: "v1" }), true);
});

test("inputNamesFromWorkflow repère les champs lus dans le corps", () => {
  const wf = {
    nodes: [
      ...WORKFLOW.nodes,
      { name: "Code", parameters: { jsCode: 'const d = $json["body"]["document"];' } },
    ],
  };
  assert.deepEqual(inputNamesFromWorkflow(wf).sort(), ["consigne", "document", "url"]);
});

// Cas réel : le workflow de démonstration de n8n-v2 ne donnait aucun champ.
test("inputNamesFromWorkflow lit aussi les nœuds Code qui rangent le corps dans une variable", () => {
  const code = [
    "const body = $input.first().json.body || {};",
    "const texte = String(body.texte || '');",
    "const ctx = body._portail || {};",
    "const c = body['consigne'];",
    "const { langue, niveau: n = 1 } = $json.body;",
    "const autre = {}; autre.pasunchamp = 1;",
  ].join("\n");
  const wf = { nodes: [{ name: "Code", parameters: { jsCode: code } }] };
  assert.deepEqual(inputNamesFromWorkflow(wf).sort(), ["consigne", "langue", "niveau", "texte"]);
});

test("runWebhook envoie les entrées à plat, le contexte sous _portail et l'en-tête secret", async () => {
  const fake = fakeN8n({ credentials: portalCredential(), respond: () => ({ status: 200, body: [{ resume: "r" }] }) });
  const client = createN8nClient({ baseUrl: "http://127.0.0.1:5678", apiKeyFile: keyFile(), webhookSecret: SECRET, fetchImpl: fake.fetchImpl });
  const out = await client.runWebhook({ path: "analyse-web", inputs: { url: "u" }, context: { runId: "r1" } });
  assert.deepEqual(out, { resume: "r" });
  assert.equal(fake.runs[0].path, "analyse-web");
  assert.deepEqual(fake.runs[0].body, { url: "u", _portail: { runId: "r1" } });
});

// Ce que le secret empêche : l'appel direct à l'adresse du webhook, qui reste
// joignable par l'hôte de l'éditeur, avec un contexte forgé.
test("sans le secret, le webhook refuse l'appel et le portail le dit clairement", async () => {
  const fake = fakeN8n({ credentials: portalCredential() });
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: keyFile(), webhookSecret: "mauvais", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.runWebhook({ path: "analyse-web", inputs: {}, context: {} }), /refuse le portail/);
  assert.equal(fake.runs.length, 0);
});

test("runWebhook traduit un 404 en workflow non publié", async () => {
  const fake = fakeN8n({ respond: () => ({ status: 404, body: { message: "not registered" } }) });
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: "/inexistant", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.runWebhook({ path: "x", inputs: {}, context: {} }), /pas publié/);
});

test("runWebhook garde pour le journal le détail d'une erreur de n8n", async () => {
  const fake = fakeN8n({ respond: () => ({ status: 500, body: { message: "credential Albert invalide : sk-123" } }) });
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: "/inexistant", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.runWebhook({ path: "x", inputs: {}, context: {} }), (error) => {
    assert.doesNotMatch(error.message, /sk-123/);
    assert.match(error.detail, /sk-123/);
    return true;
  });
});

test("runWebhook refuse une réponse démesurée sans la charger", async () => {
  const fake = fakeN8n({ respond: () => ({ status: 200, body: "x".repeat(6 * 1024 * 1024) }) });
  const client = createN8nClient({ baseUrl: "http://n8n", apiKeyFile: "/inexistant", fetchImpl: fake.fetchImpl });
  await assert.rejects(client.runWebhook({ path: "x", inputs: {}, context: {} }), /trop volumineuse/);
});

const FORM = {
  manifest_version: "1.1.0",
  id: "demo",
  title: "Démo",
  target: { kind: "action", action: "demo" },
  sections: [
    { id: "s1", label: "Saisie", fields: [
      { colId: "url", label: "Adresse", type: "Text", widget: "text", required: true },
      { colId: "mode", label: "Mode", type: "Choice", widget: "select" },
      { colId: "themes", label: "Thèmes", type: "ChoiceList", widget: "multiselect" },
      { colId: "jour", label: "Jour", type: "Date", widget: "date" },
      { colId: "detail", label: "Détail", type: "Text", widget: "text", required: true, condition: { field: "mode", operator: "=", value: "long" } },
    ] },
  ],
  choices: { mode: ["court", "long"], themes: ["eau", "air"] },
  result: { fields: [{ key: "resume", label: "Résumé", render: "markdown" }] },
};

test("validateActionFormDef accepte un formulaire d'action complet", () => {
  assert.deepEqual(validateActionFormDef(FORM, "demo"), []);
  const errors = validateActionFormDef({ ...FORM, target: { kind: "grist" }, sections: [] }, "demo");
  assert.ok(errors.some((e) => /target.kind/.test(e)));
  assert.ok(errors.some((e) => /section/.test(e)));
  const bad = structuredClone(FORM);
  bad.sections[0].fields.push({ colId: "url", label: "x", type: "Attachments", widget: "file" });
  assert.equal(validateActionFormDef(bad, "demo").length, 3);
});

test("checkInputs ne laisse passer que les champs déclarés, convertis", () => {
  const out = checkInputs(FORM, {
    url: "https://a", mode: "court", themes: ["L", "eau"], jour: 1757548800, intrus: "x",
  });
  assert.deepEqual(out, { url: "https://a", mode: "court", themes: ["eau"], jour: "2025-09-11" });
});

test("checkInputs refuse l'obligatoire manquant et les valeurs non proposées", () => {
  assert.throws(() => checkInputs(FORM, {}), /Adresse/);
  assert.throws(() => checkInputs(FORM, { url: "a", mode: "autre" }), /non proposée/);
  assert.throws(() => checkInputs(FORM, { url: "a", themes: ["feu"] }), /non proposée/);
  assert.throws(() => checkInputs(FORM, { url: "x".repeat(20001) }), /dépasse/);
  // « detail » est obligatoire seulement si son champ parent l'affiche.
  assert.deepEqual(checkInputs(FORM, { url: "a" }), { url: "a" });
});

test("pickResult ne montre que les clés déclarées", () => {
  assert.deepEqual(pickResult(FORM, { resume: "r", interne: "secret" }), { resume: "r" });
  assert.deepEqual(pickResult({ ...FORM, result: undefined }, { a: 1 }), { a: 1 });
});

test("draftFormDef propose un champ par entrée repérée", () => {
  const draft = draftFormDef({ key: "analyse", workflow: WORKFLOW, inputNames: ["url", "consigne"] });
  assert.deepEqual(validateActionFormDef(draft, "analyse"), []);
  assert.deepEqual(draft.sections[0].fields.map((f) => [f.colId, f.widget]), [["url", "text"], ["consigne", "textarea"]]);
});
