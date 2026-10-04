import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { SecretBox } from '../src/security/secret-box.js';
import { JwtVerifier } from '../src/security/jwt-verifier.js';
import { loadConfig } from '../src/config/env.js';
import { env } from './fixtures.js';
await test('configuration rejects missing secrets without exposing values', () => {
  assert.throws(
    () => loadConfig({ ...env, SESSION_ENCRYPTION_KEY: 'sensitive-value' }),
    (error) => error instanceof Error && !error.message.includes('sensitive-value'),
  );
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }));
  assert.throws(() =>
    loadConfig({ ...env, DATABASE_URL: env.DATABASE_URL + '?sslmode=no-verify' }),
  );
  assert.throws(() => loadConfig({ ...env, TENANT_HOSTS: '{"localhost":"not-a-uuid"}' }));
});
await test('encrypted refresh secrets cannot be altered or moved to another session', () => {
  const box = new SecretBox('ab'.repeat(32));
  const sealed = box.seal('refresh-secret', 'session-a');
  assert.equal(box.open(sealed, 'session-a'), 'refresh-secret');
  assert.throws(() => box.open(sealed, 'session-b'));
  const bytes = Buffer.from(sealed, 'base64url');
  bytes[14] = bytes[14]! ^ 1;
  assert.throws(() => box.open(bytes.toString('base64url'), 'session-a'));
});
await test('JWT verification rejects incorrect audience, issuer, expiry, scope and signing key', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey);
  key.kid = 'test';
  const verifier = new JwtVerifier(
    createLocalJWKSet({ keys: [key] }),
    'https://identity.example.com',
    'api',
    'matrimony:api',
  );
  const sign = (claims: Record<string, unknown> = {}) =>
    new SignJWT({ scope: 'matrimony:api', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('user')
      .setIssuer('https://identity.example.com')
      .setAudience('api')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  assert.equal((await verifier.verify(await sign())).subject, 'user');
  for (const [claim, value] of [
    ['aud', 'other'],
    ['iss', 'other'],
    ['exp', 1],
    ['scope', 'openid'],
  ] as const) {
    const token = await new SignJWT({
      sub: 'user',
      iss: 'https://identity.example.com',
      aud: 'api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: 'matrimony:api',
      [claim]: value,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .sign(privateKey);
    await assert.rejects(() => verifier.verify(token));
  }
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .sign(other.privateKey);
  await assert.rejects(() => verifier.verify(forged));
});
