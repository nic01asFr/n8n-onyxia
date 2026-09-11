import test from "node:test";
import assert from "node:assert/strict";
import { IdentityError, createIdentityVerifier, decodeJwtPayload, parseBaseUrl } from "../../charts/n8n/files/portal/identity.mjs";
import { DOC, GRIST, baseFor, fakeGrist, jwt, tokenFor } from "./helpers.mjs";

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
  assert.deepEqual({ ...identity }, { userId: 42, docId: DOC, origin: GRIST, readOnly: false });
  assert.match(grist.calls[0], /\/o\/docs\/api\/docs\/docTest00001\/tables\?auth=/);
});

test("un jeton fabriqué est refusé : Grist ne l'a pas émis", async () => {
  const forged = tokenFor(1);
  const grist = fakeGrist(new Set());
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  await assert.rejects(verify({ token: forged, baseUrl: baseFor() }), /Grist refuse ce jeton/);
});

test("jeton d'un autre document, expiré ou sans utilisateur : refusé sans appeler Grist", async () => {
  const grist = fakeGrist(new Set());
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl });
  await assert.rejects(verify({ token: tokenFor(42, "docAutre0002"), baseUrl: baseFor() }), /ne correspond pas/);
  await assert.rejects(verify({ token: tokenFor(42, DOC, { exp: 1 }), baseUrl: baseFor() }), /expiré/);
  await assert.rejects(verify({ token: jwt({ docId: DOC, exp: 9999999999 }), baseUrl: baseFor() }), /aucun utilisateur/);
  assert.equal(grist.calls.length, 0);
});

test("un jeton vérifié n'est redemandé à Grist qu'après son expiration", async () => {
  let t = Date.now();
  const token = tokenFor(42, DOC, { exp: Math.floor(t / 1000) + 60 });
  const grist = fakeGrist(new Set([token]));
  const verify = createIdentityVerifier({ allowedOrigins: [GRIST], fetchImpl: grist.fetchImpl, now: () => t });
  await verify({ token, baseUrl: baseFor() });
  await verify({ token, baseUrl: baseFor() });
  assert.equal(grist.calls.length, 1);
  t += 61000;
  await assert.rejects(verify({ token, baseUrl: baseFor() }), /expiré/);
});

test("sans origine autorisée, le vérificateur refuse de démarrer", () => {
  assert.throws(() => createIdentityVerifier({ allowedOrigins: [] }), /PORTAL_GRIST_ORIGINS/);
});
