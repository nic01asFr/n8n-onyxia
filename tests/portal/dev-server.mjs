// Portail en local, sans Grist ni n8n : pour regarder l'interface.
//
//   node tests/portal/dev-server.mjs            -> http://127.0.0.1:3199/?user=10
//
// ?user=10 est le propriétaire (jeton d'administration : « dev »), ?user=20 un
// collègue. Le faux Grist accepte tout jeton « dev-<id> » : ce serveur ne sert
// qu'à l'œil, jamais à valider la sécurité (voir les tests).

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, configFromEnv } from "../../charts/n8n/files/portal/server.mjs";
import { createN8nClient } from "../../charts/n8n/files/portal/n8n.mjs";
import { openStore } from "../../charts/n8n/files/portal/store.mjs";
import { WORKFLOW, fakeN8n } from "./helpers.mjs";

const PORT = Number(process.env.PORT || 3199);
const ORIGIN = "https://grist.example.org";
const DOC = "docDemo00001";

const STUB = `window.grist = {
  ready: function () {},
  docApi: {
    getAccessToken: function () {
      var user = new URLSearchParams(location.search).get('user') || '10';
      return Promise.resolve({ token: 'dev-' + user, baseUrl: '${ORIGIN}/o/docs/api/docs/${DOC}', ttlMsecs: 300000 });
    }
  }
};`;

const workflows = [
  WORKFLOW,
  {
    id: "wf2",
    name: "Moteur de recherche web",
    active: false,
    tags: [],
    nodes: [{ name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { httpMethod: "GET", path: "recherche" } }],
  },
];
const n8n = fakeN8n({
  workflows,
  respond: (body) => ({
    status: 200,
    body: {
      success: true,
      resume: `Synthèse de ${body.url}\n\n- point 1\n- point 2`,
      sources: [{ title: "Service-public.fr", url: "https://www.service-public.fr" }],
      interne: "ne doit pas apparaître",
    },
  }),
});

const dir = mkdtempSync(join(tmpdir(), "portail-dev-"));
writeFileSync(join(dir, "key"), "cle");
const config = {
  ...configFromEnv({}),
  adminToken: "dev",
  gristOrigins: [ORIGIN],
  pluginUrl: `http://127.0.0.1:${PORT}/stub-grist.js`,
  storeFile: join(dir, "portail.json"),
};
const handle = createPortal({
  config,
  store: await openStore(config.storeFile),
  verifyIdentity: async ({ token }) => ({ userId: Number(String(token).slice(4)), docId: DOC, origin: ORIGIN, readOnly: true }),
  n8n: createN8nClient({ baseUrl: "http://n8n", apiKeyFile: join(dir, "key"), fetchImpl: n8n.fetchImpl }),
});

createServer((req, res) => {
  if (req.url === "/stub-grist.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(STUB);
    return;
  }
  handle(req, res);
}).listen(PORT, "127.0.0.1", () => console.log(`portail de développement : http://127.0.0.1:${PORT}/?user=10`));
