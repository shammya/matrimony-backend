import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import {
  config,
  account,
  agency,
  authFor,
  unusedAccess,
  unusedPhotos,
  unusedReviews,
  unusedClients,
  unusedCandidates,
  unusedMatches,
  unusedConnections,
  unusedInvitations,
  unusedProfiles,
} from './fixtures.js';
await test('HTTP routes default to JWT protection, enforce roles, and expose safe responses', async (t) => {
  const redis = {
    defineCommand: () => {},
    rateLimit: (...args: unknown[]) => {
      const callback = args.at(-1) as (err: null, value: number[]) => void;
      callback(null, [1, 60000]);
    },
  } as unknown as Redis;
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    reviews: unusedReviews,
    clients: unusedClients,
    candidates: unusedCandidates,
    matches: unusedMatches,
    connections: unusedConnections,
    invitations: unusedInvitations,
    registrations: { signInMethods: async () => null },
    identities: {
      tenant: async (host) => {
        if (host !== 'localhost') throw new AppError(404, 'TENANT_NOT_FOUND');
        return {
          id: agency,
          hostname: host,
          name: 'MSBD',
          locale: 'bn',
          publicConfig: { branches: [], successStories: [] },
        };
      },
    },
    auth: authFor(async (_agency, token) => {
      if (token !== 'valid.jwt.token') throw new AppError(401, 'INVALID_ACCESS_TOKEN');
      return account;
    }),
    access: unusedAccess,
  });
  t.after(() => app.close());
  app.get('/api/v1/new-route', async () => ({ ok: true }));
  app.get('/api/v1/admin-check', { config: { roles: ['admin'] } }, async () => ({ ok: true }));
  const call = (url: string, authorization?: string) =>
    app.inject({
      url,
      headers: { host: 'localhost', ...(authorization ? { authorization } : {}) },
    });
  assert.equal((await call('/health/live')).statusCode, 200);
  assert.equal((await call('/api/v1/public/tenant')).statusCode, 200);
  assert.equal((await call('/api/v1/new-route')).statusCode, 401);
  assert.equal((await call('/api/v1/me', 'Bearer invalid')).statusCode, 401);
  assert.equal((await call('/api/v1/admin-check', 'Bearer valid.jwt.token')).statusCode, 403);
  const me = await call('/api/v1/me', 'Bearer valid.jwt.token');
  assert.equal(me.statusCode, 200);
  assert.deepEqual(Object.keys(me.json()).sort(), ['agencyId', 'displayName', 'id', 'role']);
  assert.equal(me.headers['cache-control'], 'no-store');
  const cross = await app.inject({
    url: '/api/v1/me',
    headers: {
      host: 'evil.test',
      authorization: 'Bearer valid.jwt.token',
      'x-forwarded-host': 'localhost',
    },
  });
  assert.equal(cross.statusCode, 404);
  const csrf = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { host: 'localhost', origin: 'https://evil.test' },
  });
  assert.equal(csrf.statusCode, 403);
});
