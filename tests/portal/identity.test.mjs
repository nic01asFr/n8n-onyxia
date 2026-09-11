import test from "node:test";
import assert from "node:assert/strict";
import { IdentityError, createIdentityVerifier, decodeJwtPayload, parseBaseUrl } from "../../charts/n8n/files/portal/identity.mjs";
import { ANON, DOC, GRIST, baseFor, fakeGrist, jwt, tokenFor } from "./helpers.mjs";

test("parseBaseUrl n'accepte que les hôtes Grist de la liste", () => {
  assert.deepEqual(parseBaseUrl(baseFor(), [GRIST]), {
    origin: GRIST, docId: DOC, docBase: `${GRIST}/o/docs/api/docs/${DOC}`,
  });
  assert.equal(parseBaseUrl(`${GRIST}/api/docs/${DOC}`, [GRIST]).docId, DOC);
  assert.throws(() => parseBaseUrl(`https://faux-grist.example/api/docs/${DOC}`, [GRIST]), (e) => e.status === 403);
  assert.throws(() => parseBaseUrl(`${GRIST}/api/docs/${DOC}/tables`, [GRIST]), IdentityError);
  assert.throws(() => parseBaseUrl(`${GRIST}/api/docs/${DOC}?auth=x`, [GRIST]), IdentityError);
  assert.throws(() => parseBaseUrl(`http://grist.example.org/api/docs/${DOC}`, ["http://grist.example.org"]), IdentityError);
});

test("decodeJwtPayload lit la charge utile, sans rien vérifier", () => {
  assert.deepEqual(decodeJwtPayload(jwt({ userId: 7 })), { userId: 7 });
  assert.equal(decodeJwtPayload("pas-un-jwt"), null);
});

test("l'identité vient du jeton accepté par Grist", async () => {
  const token = tokenFor(42);
  const grist = fakeGrist(new Set([token]));
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  const identity = await verify({ token, baseUrl: baseFor() });
  const { expiresAt, ...rest } = identity;
  assert.deepEqual(rest, { userId: 42, docId: DOC, origin: GRIST, docBase: baseFor(), readOnly: false, anonymous: false });
  assert.ok(expiresAt > Date.now());
  assert.match(grist.calls()[0], /\/o\/docs\/api\/docs\/docTest00001\/tables\?auth=/);
});

// Constaté : 42531 sur grist.numerique.gouv.fr, 40 sur docs.getgrist.com.
test("le visiteur anonyme d'un document public est reconnu, sans rien coder en dur", async () => {
  const anon = tokenFor(ANON);
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: fakeGrist(new Set([anon])).fetchImpl });
  assert.equal((await verify({ token: anon, baseUrl: baseFor() })).anonymous, true);
});

test("si l'anonyme de l'instance est introuvable, l'identité le dit au lieu de deviner", async () => {
  const token = tokenFor(42);
  const verify = createIdentityVerifier({
    allowedOrigins: [GRIST], fetchImpl: fakeGrist(new Set([token]), { sessionDown: true }).fetchImpl,
  });
  assert.equal((await verify({ token, baseUrl: baseFor() })).anonymous, null);
});

test("un jeton fabriqué est refusé : Grist ne l'a pas émis", async () => {
  const forged = tokenFor(1);
  const grist = fakeGrist(new Set());
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  await assert.rejects(verify({ token: forged, baseUrl: baseFor() }), /Grist refuse ce jeton/);
});

// Grist donne au widget l'adresse du document avec son identifiant d'URL
// (court) et signe le jeton avec l'identifiant complet (constaté sur
// grist.numerique.gouv.fr : 5h9vnuxrxjZF / 5h9vnuxrxjZFjm1BkiwqSz).
test("le document retenu est celui du jeton signé, pas celui de l'adresse", async () => {
  const full = `${DOC}jm1BkiwqSz`;
  const token = tokenFor(42, full);
  const grist = fakeGrist(new Set([token]));
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  assert.equal((await verify({ token, baseUrl: baseFor(DOC) })).docId, full);
  // Un jeton d'un autre document présenté ici reste un accès à cet autre document.
  const other = tokenFor(42, "docAutre0002");
  const verify2 = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: fakeGrist(new Set([other])).fetchImpl });
  assert.equal((await verify2({ token: other, baseUrl: baseFor(DOC) })).docId, "docAutre0002");
});

test("jeton expiré ou sans utilisateur : refusé sans appeler Grist", async () => {
  const grist = fakeGrist(new Set());
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  await assert.rejects(verify({ token: tokenFor(42, DOC, { exp: 1 }), baseUrl: baseFor() }), /expiré/);
  await assert.rejects(verify({ token: jwt({ docId: DOC, exp: 9999999999 }), baseUrl: baseFor() }), /aucun utilisateur/);
  assert.equal(grist.calls().length, 0);
});

test("un jeton vérifié n'est redemandé à Grist qu'après son expiration", async () => {
  let t = Date.now();
  const token = tokenFor(42, DOC, { exp: Math.floor(t / 1000) + 60 });
  const grist = fakeGrist(new Set([token]));
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl, now: () => t });
  await verify({ token, baseUrl: baseFor() });
  await verify({ token, baseUrl: baseFor() });
  assert.equal(grist.calls().length, 1);
  t += 61000;
  await assert.rejects(verify({ token, baseUrl: baseFor() }), /expiré/);
});

test("sans origine autorisée, le vérificateur refuse de démarrer", () => {
  assert.throws(() => createIdentityVerifier({ allowedOrigins: [] }), /PORTAL_GRIST_ORIGINS/);
});
