import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, decodeJwt } from 'jose';
import { AppError } from '../src/exception/app-error.js';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  AccessTokens,
  parseSigningKey,
} from '../src/security/access-token.js';

const ec = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
const accountId = randomUUID();
const invalid = (error: unknown) =>
  error instanceof AppError && error.status === 401 && error.code === 'INVALID_ACCESS_TOKEN';

/** A token with the right claims, signed by the given key, with one claim replaced or removed. */
function craft(
  key: KeyObject,
  change: {
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    drop?: string[];
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: ACCESS_TOKEN_ISSUER,
    aud: ACCESS_TOKEN_AUDIENCE,
    sub: accountId,
    jti: randomUUID(),
    iat: now,
    exp: now + 300,
    scope: 'matrimony:api',
    ...change.claims,
  };
  for (const name of change.drop ?? []) delete claims[name];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', ...change.header })
    .sign(key);
}

await test('a token verifies and names only the account it was issued to', async () => {
  const tokens = new AccessTokens(ec());
  const { token, expiresAt } = await tokens.issue(accountId, 600);
  const verified = await tokens.verify(token);
  assert.equal(verified.accountId, accountId);
  assert.equal(verified.expiresAt, expiresAt);

  // Nothing a client could be tempted to trust as authorization is in the token.
  const claims = decodeJwt(token);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'scope', 'sub']);
  assert.equal(decodeProtectedHeader(token).alg, 'ES256');
});

await test('every token is different, even for the same account in the same second', async () => {
  const tokens = new AccessTokens(ec());
  const [a, b] = await Promise.all([tokens.issue(accountId, 600), tokens.issue(accountId, 600)]);
  assert.notEqual(a.token, b.token);
});

await test('a token is refused after it expires', async () => {
  let now = Date.now();
  const tokens = new AccessTokens(ec(), () => now);
  const { token } = await tokens.issue(accountId, 60);
  assert.equal((await tokens.verify(token)).accountId, accountId);
  now += 61_000 + 5_000; // past expiry and past the five seconds of allowed clock difference
  await assert.rejects(() => tokens.verify(token), invalid);
});

await test('a token signed with another key is refused', async () => {
  const tokens = new AccessTokens(ec());
  await assert.rejects(async () => tokens.verify(await craft(ec())), invalid);
});

await test('wrong issuer, audience, scope or type, or a missing claim, is refused', async () => {
  const key = ec();
  const tokens = new AccessTokens(key);
  assert.equal((await tokens.verify(await craft(key))).accountId, accountId);
  const bad = [
    craft(key, { claims: { iss: 'someone-else' } }),
    craft(key, { claims: { aud: 'another-api' } }),
    craft(key, { claims: { scope: 'openid' } }),
    craft(key, { claims: { scope: undefined } }),
    craft(key, { header: { typ: 'JWT' } }),
    craft(key, { drop: ['sub'] }),
    craft(key, { drop: ['jti'] }),
    craft(key, { drop: ['exp'] }),
  ];
  for (const token of bad) await assert.rejects(async () => tokens.verify(await token), invalid);
});

await test('algorithm tricks are refused: none, HS256 with the public key, and RS256', async () => {
  const key = ec();
  const tokens = new AccessTokens(key);
  const base = await craft(key);
  const [, payload] = base.split('.');
  const none = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${payload}.`;
  await assert.rejects(() => tokens.verify(none), invalid);

  const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rs = await new SignJWT({ scope: 'matrimony:api' })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' })
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(accountId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(rsa);
  await assert.rejects(() => tokens.verify(rs), invalid);

  // Signing with the public key as an HMAC secret must not work.
  const publicPem = createPublicKey(key).export({
    type: 'spki',
    format: 'pem',
  });
  const hs = await new SignJWT({ scope: 'matrimony:api' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(accountId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(Buffer.from(publicPem as string));
  await assert.rejects(() => tokens.verify(hs), invalid);
});

await test('garbage is refused without a stack trace or detail', async () => {
  const tokens = new AccessTokens(ec());
  for (const value of ['', 'abc', 'a.b.c', 'Bearer x', '.'.repeat(3)])
    await assert.rejects(() => tokens.verify(value), invalid);
});

await test('the signing key is read from a PEM, also when written on one line with \\n', () => {
  const pem = ec().export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  assert.equal(parseSigningKey(pem).asymmetricKeyType, 'ec');
  assert.equal(parseSigningKey(pem.replace(/\n/g, '\\n')).asymmetricKeyType, 'ec');
});

await test('only a P-256 elliptic-curve key is accepted as the signing key', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => parseSigningKey(rsa.export({ type: 'pkcs8', format: 'pem' }).toString()));
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  assert.throws(() => parseSigningKey(p384.export({ type: 'pkcs8', format: 'pem' }).toString()));
  assert.throws(() => parseSigningKey('not a key'));
});
