import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chargerVitrine, echapper, generate, lireVersions } from "./generate.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test("echapper neutralise le HTML", () => {
  assert.equal(echapper(`a<b>&"c`), "a&lt;b&gt;&amp;&quot;c");
  assert.equal(echapper("« x » : y"), "«&nbsp;x&nbsp;»&nbsp;: y");
});

test("chargerVitrine refuse un JSON incomplet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-site-"));
  const f = path.join(dir, "bad.json");
  fs.writeFileSync(f, JSON.stringify({ nom: "X" }));
  assert.throws(() => chargerVitrine(f), /champ requis/);
});

test("lireVersions relit le chart plutôt qu'une copie", () => {
  const v = lireVersions();
  assert.match(v.chart, /^\d+\.\d+\.\d+$/);
  assert.match(v.n8n, /^\d+\.\d+\.\d+$/);
  assert.match(v.mcp, /^\d+\.\d+\.\d+$/);
});

test("generate produit la vitrine, ses sections et ses assets", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-dist-"));
  const { out, bytes, versions } = generate({ distDir: dist });
  assert.ok(bytes > 5000);
  const html = fs.readFileSync(out, "utf8");
  for (const id of ["produit", "apercu", "promesse", "fonctionnalites", "parcours", "installer", "mcp", "usages", "stack", "migration", "journal"]) {
    assert.match(html, new RegExp(`id="${id}"`), `section ${id} absente`);
  }
  assert.match(html, /base href="\/n8n-onyxia\/"/);
  assert.match(html, /--accent: #EA4B71/);
  assert.match(html, /install\.sh \| bash/);
  assert.ok(html.includes(versions.n8n), "version n8n absente");
  assert.ok(fs.existsSync(path.join(dist, "assets", "n8n.svg")), "icône absente");
  assert.doesNotMatch(html, /undefined/);
});
