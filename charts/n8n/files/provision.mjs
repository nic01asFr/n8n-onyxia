// Provisioning n8n depuis l'intérieur du pod : compte owner, puis clé API pour
// le serveur MCP.
//
// Pourquoi dans le pod plutôt qu'en Job Helm : le Job devait patcher un Secret,
// donc créer un Role, ce que SSPCloud refuse dans un namespace utilisateur. Ici
// tout passe par HTTP sur localhost et par un fichier du volume partagé : aucun
// droit Kubernetes n'est nécessaire, et le lancement depuis le catalogue Onyxia
// fonctionne comme l'installation en ligne de commande.
//
// Le script s'exécute avec le Node embarqué dans l'image n8n : aucune dépendance.
// Il ne se termine jamais en erreur : un conteneur qui sort serait relancé en
// boucle par Kubernetes. Il consigne ce qu'il a fait, puis reste inactif.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const env = (name, fallback = "") => process.env[name] ?? fallback;

const N8N_URL = env("N8N_URL", "http://127.0.0.1:5678");
const OWNER_EMAIL = env("OWNER_EMAIL");
const OWNER_PASSWORD = env("OWNER_PASSWORD");
const OWNER_FIRST_NAME = env("OWNER_FIRST_NAME", "Admin");
const OWNER_LAST_NAME = env("OWNER_LAST_NAME", "n8n");
const CREATE_API_KEY = env("CREATE_API_KEY", "false") === "true";
const API_KEY_LABEL = env("API_KEY_LABEL", "onyxia-mcp");
const API_KEY_FILE = env("API_KEY_FILE", "/home/node/.n8n/onyxia/n8n-api-key");
// Préfixes de scopes accordés à la clé (« workflow: », « execution: »...).
// Vide : tous les scopes proposés par n8n.
const API_KEY_SCOPE_PREFIXES = env("API_KEY_SCOPE_PREFIXES")
  .split(",")
  .map((prefix) => prefix.trim())
  .filter(Boolean);
const READY_TIMEOUT_S = Number(env("READY_TIMEOUT_SECONDS", "600"));
// Clé créée par les charts 0.x (Secret, clé N8N_API_KEY). n8n n'autorise parfois
// qu'une clé par utilisateur : la reprendre évite de buter sur cette limite.
const LEGACY_API_KEY = env("LEGACY_API_KEY");
// Libellés des clés que ce chart a pu créer, et qu'il peut donc remplacer.
const OWN_KEY_LABELS = [API_KEY_LABEL, "auto-provisioned"];

// n8n lie le cookie de session à l'en-tête browser-id présenté à la connexion :
// il faut renvoyer le même à chaque appel.
const BROWSER_ID = "onyxia-provisioner";

const log = (message) => console.log(`[provision] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, { body, cookie, apiKey } = {}) {
  const headers = { "browser-id": BROWSER_ID };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (apiKey) headers["x-n8n-api-key"] = apiKey;
  const response = await fetch(`${N8N_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try {
      const { status } = await request("GET", "/healthz/readiness");
      if (status === 200) return true;
    } catch {
      // n8n n'écoute pas encore.
    }
    await sleep(3000);
  }
  return false;
}

async function ensureOwner() {
  const settings = await request("GET", "/rest/settings");
  const needsSetup = settings.json?.data?.userManagement?.showSetupOnFirstLoad;
  if (needsSetup === false) {
    log("compte owner déjà présent");
    return true;
  }
  if (!OWNER_EMAIL || !OWNER_PASSWORD) {
    log("ATTENTION : aucun owner fourni, l'écran de création reste ouvert à qui ouvre l'URL");
    return false;
  }
  const setup = await request("POST", "/rest/owner/setup", {
    body: {
      email: OWNER_EMAIL,
      firstName: OWNER_FIRST_NAME,
      lastName: OWNER_LAST_NAME,
      password: OWNER_PASSWORD,
    },
  });
  if (setup.status === 200) {
    log(`compte owner créé (${OWNER_EMAIL})`);
    return true;
  }
  log(`échec de création de l'owner : HTTP ${setup.status} ${setup.text.slice(0, 200)}`);
  return false;
}

async function isKeyValid(apiKey) {
  try {
    const { status } = await request("GET", "/api/v1/workflows?limit=1", { apiKey });
    return status === 200;
  } catch {
    return false;
  }
}

async function login() {
  const response = await request("POST", "/rest/login", {
    body: { emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  if (response.status !== 200) {
    log(`connexion refusée : HTTP ${response.status}`);
    return undefined;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  const auth = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("n8n-auth="));
  if (!auth) log("connexion acceptée mais aucun cookie n8n-auth reçu");
  return auth;
}

async function selectScopes(cookie) {
  // n8n 2.x exige une liste de scopes non vide et publie celles qu'il accepte.
  const response = await request("GET", "/rest/api-keys/scopes", { cookie });
  const available = Array.isArray(response.json?.data) ? response.json.data : [];
  if (API_KEY_SCOPE_PREFIXES.length === 0) return available;
  return available.filter((scope) =>
    API_KEY_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix)),
  );
}

async function removeOwnKeys(cookie) {
  // Seules les clés portant un libellé de ce chart sont retirées : celles que
  // l'utilisateur a créées lui-même restent intactes.
  const response = await request("GET", "/rest/api-keys", { cookie });
  const keys = Array.isArray(response.json?.data) ? response.json.data : [];
  let removed = 0;
  for (const key of keys.filter((k) => OWN_KEY_LABELS.includes(k.label))) {
    const deletion = await request("DELETE", `/rest/api-keys/${key.id}`, { cookie });
    if (deletion.status === 200) removed += 1;
  }
  return removed;
}

async function createApiKey(cookie, { retried = false } = {}) {
  const scopes = await selectScopes(cookie);
  if (scopes.length === 0) {
    log("aucun scope disponible pour la clé API, vérifiez API_KEY_SCOPE_PREFIXES");
    return undefined;
  }
  const response = await request("POST", "/rest/api-keys", {
    cookie,
    body: { label: API_KEY_LABEL, expiresAt: null, scopes },
  });
  if (!retried && response.status === 400 && /maximum number of API keys/i.test(response.text)) {
    const removed = await removeOwnKeys(cookie);
    log(`limite de clés API atteinte : ${removed} ancienne(s) clé(s) de ce chart retirée(s)`);
    if (removed > 0) return createApiKey(cookie, { retried: true });
  }
  const data = response.json?.data ?? response.json ?? {};
  const rawKey = data.rawApiKey ?? data.apiKey;
  if (response.status !== 200 || !rawKey) {
    log(`échec de création de la clé API : HTTP ${response.status} ${response.text.slice(0, 200)}`);
    return undefined;
  }
  log(`clé API créée avec ${scopes.length} scopes`);
  return rawKey;
}

async function writeKeyFile(apiKey) {
  await mkdir(dirname(API_KEY_FILE), { recursive: true });
  const tmp = `${API_KEY_FILE}.tmp`;
  // 0640 : lisible par le groupe fsGroup du pod, donc par le conteneur MCP,
  // dont l'UID change à chaque build de son image.
  await writeFile(tmp, apiKey, { mode: 0o640 });
  await rename(tmp, API_KEY_FILE);
}

async function ensureApiKey() {
  try {
    const existing = (await readFile(API_KEY_FILE, "utf8")).trim();
    if (existing && (await isKeyValid(existing))) {
      log("clé API existante valide, rien à faire");
      return true;
    }
    log("clé API existante refusée par n8n, création d'une nouvelle");
  } catch {
    log("aucune clé API sur le volume");
  }
  if (LEGACY_API_KEY && (await isKeyValid(LEGACY_API_KEY))) {
    await writeKeyFile(LEGACY_API_KEY);
    log("clé API de l'installation précédente reprise pour le serveur MCP");
    return true;
  }
  log("création d'une clé API");
  const cookie = await login();
  if (!cookie) {
    log("impossible de se connecter avec le mot de passe du chart.");
    log("Si le mot de passe owner a été changé dans n8n, créez une clé API dans");
    log("Settings > n8n API et écrivez-la dans " + API_KEY_FILE);
    return false;
  }
  const apiKey = await createApiKey(cookie);
  if (!apiKey) return false;
  await writeKeyFile(apiKey);
  log(`clé API « ${API_KEY_LABEL} » déposée pour le serveur MCP`);
  return true;
}

async function main() {
  log(`attente de n8n sur ${N8N_URL}`);
  if (!(await waitForReady())) {
    log(`n8n ne répond pas après ${READY_TIMEOUT_S} s, abandon`);
    return;
  }
  const ownerOk = await ensureOwner();
  if (CREATE_API_KEY && ownerOk) await ensureApiKey();
  log("terminé");
}

try {
  await main();
} catch (error) {
  log(`erreur inattendue : ${error?.message ?? error}`);
}

// Rester en vie : le pod redémarrerait sinon ce conteneur sans fin.
setInterval(() => {}, 1 << 30);
