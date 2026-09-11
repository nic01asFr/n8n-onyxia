import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORTAL = join(dirname(fileURLToPath(import.meta.url)), "../../charts/n8n/files/portal");

function start(dir) {
  const work = mkdtempSync(join(tmpdir(), "portail-start-"));
  const child = spawn(process.execPath, [join(dir, "start.mjs")], {
    env: {
      ...process.env,
      PORTAL_PORT: "0",
      PORTAL_ADMIN_TOKEN: "x",
      PORTAL_STORE_FILE: join(work, "portail.json"),
      PORTAL_PUBLIC_DIR: dir,
    },
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`pas démarré : ${out}`)); }, 10000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /port (\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`sorti (${code}) : ${out}`)); });
  });
}

async function check(dir) {
  const { child, port } = await start(dir);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    child.removeAllListeners("exit");
    child.kill();
  }
}

test("start.mjs démarre le serveur", async () => {
  await check(PORTAL);
});

// Une ConfigMap montée expose ses fichiers par liens symboliques : le serveur
// doit démarrer quand même (il ne démarrait pas, garde sur le chemin réel).
test("start.mjs démarre aussi derrière des liens symboliques", async (t) => {
  const real = mkdtempSync(join(tmpdir(), "portail-reel-"));
  cpSync(PORTAL, real, { recursive: true });
  const linked = mkdtempSync(join(tmpdir(), "portail-liens-"));
  try {
    for (const name of readdirSync(real)) symlinkSync(join(real, name), join(linked, name));
  } catch {
    t.skip("liens symboliques indisponibles sur ce système");
    return;
  }
  await check(linked);
});
