import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp, type AppDependencies } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import { config, agency } from './fixtures.js';

const sessionId = 'a'.repeat(43);
const challengeId = 'b'.repeat(43);
const tokens = { accessToken: 'access.jwt.token', csrfToken: 'c'.repeat(43), expiresIn: 3600 };

async function build(
  overrides: { locale?: string; complete?: AppDependencies['auth']['complete'] } = {},
) {
  const redis = {
    defineCommand: () => {},
    rateLimit: (...args: unknown[]) => {
      const callback = args.at(-1) as (err: null, value: number[]) => void;
      callback(null, [1, 60000]);
    },
  } as unknown as Redis;
  const calls = { bootstrap: [] as string[][], complete: 0 };
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    identities: {
      tenant: async (host) => {
        if (host !== 'localhost') throw new AppError(404, 'TENANT_NOT_FOUND');
        return {
          id: agency,
          hostname: host,
          name: 'MSBD',
          locale: overrides.locale ?? 'bn',
          publicConfig: {},
        };
      },
    },
    auth: {
      authenticate: async () => {
        throw new Error('unused');
      },
      begin: async () => ({ challengeId, authorizationUrl: 'https://issuer' }),
      complete:
        overrides.complete ??
        (async () => {
          calls.complete++;
          return { sessionId, ...tokens };
        }),
      bootstrap: async (agencyId, id) => {
        calls.bootstrap.push([agencyId, id]);
        return tokens;
      },
      refresh: async () => {
        throw new Error('unused');
      },
      logout: async () => {},
    },
  });
  return { app, calls };
}

const origin = 'http://localhost';

await test('POST /auth/session returns tokens for a same-origin request with a session cookie', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { host: 'localhost', origin, cookie: `matrimony-session=${sessionId}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls.bootstrap, [[agency, sessionId]]);
});

await test('POST /auth/session rejects a cross-site or missing Origin before touching the session', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const cookie = `matrimony-session=${sessionId}`;
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { host: 'localhost', origin: 'https://evil.test', cookie },
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.code, 'ORIGIN_INVALID');
  const missing = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { host: 'localhost', cookie },
  });
  assert.equal(missing.statusCode, 403);
  assert.equal(calls.bootstrap.length, 0);
});

await test('POST /auth/session rejects a missing or malformed session cookie', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  for (const cookie of [undefined, 'matrimony-session=short', 'matrimony-session=%20%20']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      headers: { host: 'localhost', origin, ...(cookie ? { cookie } : {}) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  }
  assert.equal(calls.bootstrap.length, 0);
});

await test('POST /auth/session resolves the agency from the host, not from the request', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: {
      host: 'evil.test',
      origin: 'http://evil.test',
      'x-forwarded-host': 'localhost',
      cookie: `matrimony-session=${sessionId}`,
    },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(calls.bootstrap.length, 0);
});

await test('the callback redirects to the frontend completion page and never exposes tokens', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/callback?code=one-time-code&state=s',
    headers: { host: 'localhost', cookie: `matrimony-challenge=${challengeId}` },
  });
  assert.equal(calls.complete, 1);
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/bn/auth/complete');
  assert.equal(response.body, '');
  assert.equal(response.headers['cache-control'], 'no-store');
  const cookies = [response.headers['set-cookie']].flat().join('\n');
  assert.match(cookies, new RegExp(`matrimony-session=${sessionId}.*HttpOnly`));
  assert.match(cookies, /matrimony-challenge=;/);
  const everything = JSON.stringify(response.headers) + response.body;
  assert.equal(everything.includes(tokens.accessToken), false);
  assert.equal(everything.includes(tokens.csrfToken), false);
});

await test('the callback redirect uses the agency locale', async (t) => {
  const { app } = await build({ locale: 'en' });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/callback?code=c&state=s',
    headers: { host: 'localhost', cookie: `matrimony-challenge=${challengeId}` },
  });
  assert.equal(response.headers.location, '/en/auth/complete');
});

await test('a failed login redirects to the login page with a safe error code and sets no session', async (t) => {
  const { app } = await build({
    complete: async () => {
      throw new AppError(401, 'OAUTH_EXCHANGE_FAILED');
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/callback?error=access_denied&state=s',
    headers: { host: 'localhost', cookie: `matrimony-challenge=${challengeId}` },
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/bn/login?error=OAUTH_EXCHANGE_FAILED');
  assert.equal(
    [response.headers['set-cookie']].flat().join('\n').includes('matrimony-session'),
    false,
  );
});

await test('a callback without a challenge cookie redirects to login instead of showing JSON', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/callback?code=c&state=s',
    headers: { host: 'localhost' },
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/bn/login?error=INVALID_REQUEST');
  assert.equal(calls.complete, 0);
});

await test('an unexpected callback failure stays a server error and does not leak details', async (t) => {
  const { app } = await build({
    complete: async () => {
      throw new Error('database password is hunter2');
    },
  });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/callback?code=c&state=s',
    headers: { host: 'localhost', cookie: `matrimony-challenge=${challengeId}` },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.equal(response.body.includes('hunter2'), false);
});
