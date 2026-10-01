// Refait les captures du portail affichées sur la vitrine (site/assets/portail-*.png).
// L'interface est la vraie, servie par tests/portal/dev-server.mjs : faux Grist et
// faux n8n, donc données de démonstration, thème sombre comme la vitrine.
//
//   npm i --no-save playwright-core
//   PORT=3201 node tests/portal/dev-server.mjs &
//   BASE=http://127.0.0.1:3201 CHROME=/chemin/vers/chrome node site/capture-portail.mjs
//
// Hors CI et hors tests : à relancer quand l'interface du portail change, puis
// vérifier les images avant de les committer.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://127.0.0.1:3201";
const OUT = process.env.OUT || fileURLToPath(new URL("./assets", import.meta.url));
const CHROME = process.env.CHROME || undefined; // sinon : chromium de Playwright
mkdirSync(OUT, { recursive: true });

const owner = { "x-grist-token": "dev-10", "x-grist-base": "x", "content-type": "application/json" };
async function call(method, path, body, session) {
  const headers = { ...owner, ...(session ? { authorization: `Bearer ${session}` } : {}) };
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

// --- Amorçage : deux actions réalistes, ouvertes dans le document ------------
const { session } = await call("POST", "/api/admin/login", { apiKey: "cle-du-proprietaire" });
const keys = [];

async function seed({ workflowId, node, title, description, icon, fields, outputs, gristAccess, writeBack }) {
  const draft = await call("POST", "/api/admin/draft", { workflowId, node }, session);
  const fd = draft.formdef;
  fd.title = title;
  fd.description = description;
  fd.sections[0].label = "Votre demande";
  fd.sections[0].fields = fields;
  fd.result = { fields: outputs };
  await call("POST", "/api/admin/action", { key: draft.key, workflowId, node, icon, formdef: fd, gristAccess, writeBack }, session);
  keys.push(draft.key);
}

await seed({
  workflowId: "wf1", node: "Webhook", title: "Analyser une page web", icon: "🌐",
  description: "Résume le contenu d'une page et en liste les sources.",
  fields: [
    { colId: "url", label: "Adresse de la page", type: "Text", widget: "text", required: true, options: { placeholder: "https://www.service-public.fr" } },
    { colId: "consigne", label: "Ce que vous cherchez", type: "Text", widget: "textarea", required: false, options: { placeholder: "Facultatif : un point précis à relever" } },
  ],
  outputs: [
    { key: "success", label: "Statut", render: "badge" },
    { key: "resume", label: "Résumé", render: "markdown" },
    { key: "sources", label: "Sources", render: "list" },
  ],
  gristAccess: "write",
  writeBack: { tableId: "Resultats", fields: { resume: "Resume", acces: "Acces" } },
});
await seed({
  workflowId: "wf1", node: "Webhook", title: "Relever les mentions d'une page", icon: "📌",
  description: "Repère les informations clés d'une page : titre, dates, contacts.",
  fields: [{ colId: "url", label: "Adresse de la page", type: "Text", widget: "text", required: true, options: {} }],
  outputs: [{ key: "success", label: "Statut", render: "badge" }],
  gristAccess: "none", writeBack: null,
});
await call("POST", "/api/admin/access", { actions: keys, signedInOnly: true }, session);
console.log("actions ouvertes :", keys.join(", "));

// --- Captures -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const W = 1180, H = 760;
const shot = (page, name, clip) => page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });

async function open(user) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5, locale: "fr-FR", colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("erreur page :", e.message));
  await page.goto(`${BASE}/?user=${user}&theme=dark`);
  await page.waitForSelector(".app");
  return { ctx, page };
}

// 1. Un collègue ouvre le portail : les actions disponibles.
{
  const { ctx, page } = await open(20);
  await page.getByText("Actions disponibles").waitFor();
  await page.waitForTimeout(400);
  await shot(page, "portail-actions", { x: 0, y: 0, width: W, height: 470 });
  // 2. Il lance l'action et lit le résultat.
  await page.getByRole("button", { name: /Analyser une page web/ }).click();
  await page.getByRole("textbox", { name: /Adresse de la page/ }).fill("https://www.service-public.fr");
  await page.getByRole("textbox", { name: /Ce que vous cherchez/ }).fill("Les démarches proposées en ligne");
  await page.getByRole("button", { name: "Envoyer" }).click();
  await page.getByText("Résultat enregistré dans la table").waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await shot(page, "portail-resultat", { x: 0, y: 0, width: W, height: 880 / 1 > H ? H : 880 });
  await ctx.close();
}

// 3. Le propriétaire règle l'action dans l'éditeur.
{
  const { ctx, page } = await open(10);
  await page.getByRole("button", { name: "Configurer" }).click();
  await page.getByRole("button", { name: "Clé API" }).click();
  await page.getByRole("textbox").first().fill("cle-du-proprietaire");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("button", { name: "Modifier" }).first().waitFor();
  await page.getByRole("button", { name: "Modifier" }).first().click();
  await page.getByText("Modifier l'action").waitFor();
  await page.waitForTimeout(600);
  await shot(page, "portail-editeur");
  await ctx.close();
}
await browser.close();
console.log("captures écrites dans", OUT);
