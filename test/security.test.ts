import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SecretBox } from '../src/security/secret-box.js';
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
await test('sealed values cannot be altered or moved to another context', () => {
  const box = new SecretBox('ab'.repeat(32));
  const sealed = box.seal('secret-value', 'context-a');
  assert.equal(box.open(sealed, 'context-a'), 'secret-value');
  assert.throws(() => box.open(sealed, 'context-b'));
  const bytes = Buffer.from(sealed, 'base64url');
  bytes[14] = bytes[14]! ^ 1;
  assert.throws(() => box.open(bytes.toString('base64url'), 'context-a'));
});
await test('the signing key must be present and be a P-256 elliptic-curve key, and is never echoed', () => {
  const withoutKey: Record<string, string> = { ...env };
  delete withoutKey.AUTH_JWT_PRIVATE_KEY;
  assert.throws(() => loadConfig(withoutKey), /AUTH_JWT_PRIVATE_KEY/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  assert.throws(
    () => loadConfig({ ...env, AUTH_JWT_PRIVATE_KEY: String(rsa) }),
    (error) =>
      error instanceof Error &&
      /AUTH_JWT_PRIVATE_KEY/.test(error.message) &&
      !error.message.includes('PRIVATE KEY'),
  );
  assert.throws(
    () => loadConfig({ ...env, AUTH_JWT_PRIVATE_KEY: 'not a key' }),
    /AUTH_JWT_PRIVATE_KEY/,
  );
});
await test('token and session lifetimes have safe bounds', () => {
  const config = loadConfig(env);
  assert.equal(config.ACCESS_TOKEN_TTL_SECONDS, 600);
  assert.equal(config.MAX_SESSIONS_PER_ACCOUNT, 10);
  for (const bad of [
    { ACCESS_TOKEN_TTL_SECONDS: '10' },
    { ACCESS_TOKEN_TTL_SECONDS: '999999' },
    { MAX_SESSIONS_PER_ACCOUNT: '0' },
  ])
    assert.throws(() => loadConfig({ ...env, ...bad }));
});
await test('production needs real, encrypted email delivery and refuses the development console', () => {
  // Everything else a production deployment needs is valid here, so only the mail settings decide.
  const production = {
    ...env,
    NODE_ENV: 'production',
    DB_SSL: 'verify-full',
    REDIS_URL: 'rediss://redis.example:6380',
    MONGO_URL: 'mongodb+srv://user:pw@cluster.example/db',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'matrimony-private',
  };
  const smtp = {
    MAIL_DRIVER: 'smtp',
    MAIL_FROM: 'Marriage Solution BD <no-reply@example.com>',
    SMTP_HOST: 'smtp.example.com',
  };
  assert.throws(() => loadConfig(production), /MAIL_DRIVER/);
  assert.throws(() => loadConfig({ ...production, MAIL_DRIVER: 'console' }), /MAIL_DRIVER/);
  assert.doesNotThrow(() => loadConfig({ ...production, ...smtp }));
  assert.throws(() => loadConfig({ ...production, ...smtp, SMTP_TLS: 'none' }), /SMTP_TLS/);
  // The development console is fine outside production.
  assert.doesNotThrow(() => loadConfig({ ...production, NODE_ENV: 'development' }));
});
await test('SMTP delivery needs a sender and a host, and both or neither of user and password', () => {
  const base = {
    ...env,
    MAIL_DRIVER: 'smtp',
    MAIL_FROM: 'no-reply@example.com',
    SMTP_HOST: 'smtp.example.com',
  };
  assert.doesNotThrow(() => loadConfig(base));
  assert.doesNotThrow(() => loadConfig({ ...base, SMTP_USER: 'u', SMTP_PASSWORD: 'p' }));
  assert.throws(
    () => loadConfig({ ...env, MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.com' }),
    /MAIL_FROM/,
  );
  assert.throws(
    () => loadConfig({ ...env, MAIL_DRIVER: 'smtp', MAIL_FROM: 'no-reply@example.com' }),
    /SMTP_HOST/,
  );
  assert.throws(() => loadConfig({ ...base, SMTP_USER: 'u' }), /SMTP_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, SMTP_PASSWORD: 'p' }), /SMTP_PASSWORD/);
});
await test('the sender address cannot carry a line break, so no header can be injected', () => {
  const base = { ...env, MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.com' };
  for (const from of [
    'no-reply@example.com\r\nBcc: x@y.com',
    'not an address',
    'Name <a@b.com>\nX: y',
  ])
    assert.throws(() => loadConfig({ ...base, MAIL_FROM: from }), /MAIL_FROM/, from);
  assert.doesNotThrow(() =>
    loadConfig({ ...base, MAIL_FROM: 'Marriage Solution BD <no-reply@example.com>' }),
  );
});
