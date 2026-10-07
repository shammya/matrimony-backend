import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  config,
  unusedPhotos,
  unusedReviews,
  unusedClients,
  authFor,
  unusedAccess,
} from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const empty = { profile: null, pendingReview: null, lastDecision: null };

async function setup(role: 'member' | 'agent' = 'member') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
  const record =
    (name: string, result: unknown = empty) =>
    async (actor: ProfileActor, ...args: unknown[]) => {
      calls.push({ name, actor, args });
      if (result instanceof Error) throw result;
      return result as typeof empty;
    };
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    photos: unusedPhotos,
    reviews: unusedReviews,
    clients: unusedClients,
    profiles: {
      get: record('get'),
      save: record('save'),
      submit: record('submit'),
      requestEdit: record('requestEdit'),
      cancelPending: record('cancelPending', new AppError(404, 'NO_PENDING_REVIEW')),
    },
    identities: {
      tenant: async () => ({
        id: agency,
        hostname: 'localhost',
        name: 'MSBD',
        locale: 'bn',
        publicConfig: { branches: [], successStories: [] },
      }),
    },
    auth: authFor(async () => ({ ...account, role })),
    access: unusedAccess,
  });
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
    });
  return { app, call, calls };
}

await test('profile routes need a signed-in member', async (t) => {
  const { app, call } = await setup('agent');
  t.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/v1/me/profile'],
    ['PUT', '/api/v1/me/profile'],
    ['POST', '/api/v1/me/profile/submit'],
    ['POST', '/api/v1/me/profile/edit-requests'],
    ['DELETE', '/api/v1/me/profile/pending-review'],
  ] as const) {
    const res = await call(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  const anonymous = await app.inject({ url: '/api/v1/me/profile', headers: { host: 'localhost' } });
  assert.equal(anonymous.statusCode, 401);
});

await test('the agency and account come from the session, never from the request', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', '/api/v1/me/profile', {
    profile: { fullName: 'Rahim' },
    // Unknown keys are refused rather than ignored, so an agency id cannot be smuggled in.
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), empty);
  assert.equal(calls[0]?.actor.agencyId, agency);
  assert.equal(calls[0]?.actor.accountId, account.id);

  const smuggled = await call('PUT', '/api/v1/me/profile', {
    agencyId: 'other',
    profile: { fullName: 'Rahim' },
  });
  assert.equal(smuggled.statusCode, 400);
  assert.equal(calls.length, 1);
});

await test('a rejected body lists which fields were wrong with stable codes, and no values', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const res = await call('PUT', '/api/v1/me/profile', {
    profile: { fullName: '', dateOfBirth: '2020-01-01', heightCm: 'secret-value', gender: 'robot' },
    contact: { phone: '123' },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json().error;
  assert.equal(body.code, 'INVALID_REQUEST');
  const fields = body.details.fields as { path: string; code: string }[];
  const find = (path: string) => fields.find((f) => f.path === path)?.code;
  assert.equal(find('profile.fullName'), 'required');
  assert.equal(find('profile.dateOfBirth'), 'underAge');
  assert.equal(find('profile.gender'), 'invalidOption');
  assert.ok(find('contact.phone'));
  assert.ok(!res.body.includes('secret-value'));
  assert.equal(calls.length, 0);
});

await test('submit needs a version number', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  assert.equal((await call('POST', '/api/v1/me/profile/submit', {})).statusCode, 400);
  assert.equal((await call('POST', '/api/v1/me/profile/submit', { version: 'x' })).statusCode, 400);
  assert.equal((await call('POST', '/api/v1/me/profile/submit', { version: 3 })).statusCode, 200);
  assert.deepEqual(calls.at(-1)?.args.slice(0, 1), [3]);
});

await test('service errors keep their status, code and details', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const res = await call('DELETE', '/api/v1/me/profile/pending-review');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NO_PENDING_REVIEW');
});
