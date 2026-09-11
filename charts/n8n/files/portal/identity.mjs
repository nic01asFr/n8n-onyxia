// Identité du lecteur d'un widget Grist, vérifiée côté serveur.
//
// Le widget obtient un jeton par grist.docApi.getAccessToken() : un JWT signé
// par le serveur Grist, qui porte l'identifiant du lecteur (userId) et le
// document (docId), valable quelques minutes. Le portail ne reçoit que ce jeton
// et l'adresse de base du document, jamais une identité déclarée.
//
// Un JWT ne se vérifie pas ici : la clé de signature appartient à Grist. On
// présente donc le jeton à Grist, sur un hôte de notre liste blanche. S'il est
// accepté, la charge utile de CE jeton est authentique, et on la lit. Accepter
// l'hôte fourni par le client reviendrait à laisser un faux Grist valider un
// jeton fabriqué.

import { createHash } from "node:crypto";

// /api/docs/<docId>, éventuellement précédé de /o/<organisation>.
const DOC_PATH = /^(\/o\/[A-Za-z0-9_-]+)?\/api\/docs\/([A-Za-z0-9_-]{8,64})\/?$/;

export class IdentityError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function parseBaseUrl(baseUrl, allowedOrigins) {
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    throw new IdentityError("Adresse du document Grist illisible.", 400);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new IdentityError("Le document Grist doit être servi en HTTPS.", 400);
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new IdentityError(`Ce portail n'accepte pas les documents de ${url.origin}.`, 403);
  }
  const match = DOC_PATH.exec(url.pathname);
  if (!match || url.search || url.hash) {
    throw new IdentityError("Adresse du document Grist inattendue.", 400);
  }
  return { origin: url.origin, docId: match[2], docBase: `${url.origin}${url.pathname.replace(/\/$/, "")}` };
}

export function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function userIdFrom(payload) {
  const raw = payload.userId ?? payload.sub;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Vérifie un jeton contre Grist et le garde en cache jusqu'à son expiration :
// un widget qui enchaîne les appels ne coûte qu'un aller-retour vers Grist.
export function createIdentityVerifier({ allowedOrigins, fetchImpl = fetch, now = Date.now, timeoutMs = 10000 }) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error("Aucune origine Grist autorisée : renseignez PORTAL_GRIST_ORIGINS.");
  }
  const cache = new Map();

  function purge() {
    const t = now();
    for (const [key, entry] of cache) if (entry.expiresAt <= t) cache.delete(key);
  }

  return async function verify({ token, baseUrl }) {
    if (!token) throw new IdentityError("Jeton Grist manquant.");
    const { origin, docId, docBase } = parseBaseUrl(baseUrl, allowedOrigins);
    const payload = decodeJwtPayload(token);
    if (!payload) throw new IdentityError("Jeton Grist illisible.");
    const userId = userIdFrom(payload);
    if (!userId) throw new IdentityError("Le jeton Grist ne désigne aucun utilisateur.");
    if (payload.docId && payload.docId !== docId) {
      throw new IdentityError("Le jeton Grist ne correspond pas à ce document.");
    }
    const expiresAt = Number(payload.exp) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new IdentityError("Jeton Grist expiré : rechargez la page.");
    }

    const key = createHash("sha256").update(`${docBase}\n${token}`).digest("hex");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.identity;

    let response;
    try {
      response = await fetchImpl(`${docBase}/tables?auth=${encodeURIComponent(token)}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new IdentityError("Grist ne répond pas : réessayez dans un instant.", 503);
    }
    if (response.status === 401 || response.status === 403) {
      throw new IdentityError("Grist refuse ce jeton.");
    }
    if (!response.ok) {
      throw new IdentityError(`Grist a répondu ${response.status} à la vérification du jeton.`, 502);
    }

    const identity = Object.freeze({ userId, docId, origin, readOnly: Boolean(payload.readOnly) });
    purge();
    cache.set(key, { identity, expiresAt });
    return identity;
  };
}
