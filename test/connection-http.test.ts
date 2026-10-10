import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  authFor,
  config,
  unusedAccess,
  unusedCandidates,
  unusedClients,
  unusedInvitations,
  unusedMatches,
  unusedPhotos,
  unusedProfiles,
  unusedReviews,
} from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const ID = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

async function setup(role: 'admin' | 'agent' | 'member') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
  const record =
    <T>(name: string, result: T) =>
    async (actor: ProfileActor, ...args: unknown[]) => {
      calls.push({ name, actor, args });
      return result;
    };
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
    invitations: unusedInvitations,
    connections: {
      send: record('send', {
        outcome: 'requested' as const,
        connectionId: ID,
        status: 'pending' as const,
      }),
      respond: record('respond', undefined),
      withdraw: record('withdraw', undefined),
      shareContact: record('shareContact', undefined),
      list: record('list', { items: [], next: null }),
      notifications: record('notifications', {
        items: [
          {
            id: ID,
            kind: 'connection_request' as const,
            createdAt: '2026-10-10T08:00:00.000Z',
            position: '2026-10-10T08:00:00.000000Z',
            connectionId: ID,
            forProfileId: ID,
            about: { profileId: OTHER, memberCode: 'M1', fullName: 'Ayesha' },
          },
        ],
        next: null,
      }),
      staffList: record('staffList', []),
      staffRespond: record('staffRespond', undefined),
      staffShareContact: record('staffShareContact', undefined),
    },
    registrations: { signInMethods: async () => null },
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
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
    });
  return { app, call, calls };
}

const MEMBER_ROUTES: [string, string, unknown][] = [
  ['POST', '/api/v1/me/connections', { candidateId: ID }],
  ['GET', '/api/v1/me/connections', undefined],
  ['POST', `/api/v1/me/connections/${ID}/respond`, { response: 'accept' }],
  ['POST', `/api/v1/me/connections/${ID}/withdraw`, undefined],
  ['POST', `/api/v1/me/connections/${ID}/share-contact`, undefined],
];
const STAFF_ROUTES: [string, string, unknown][] = [
  ['GET', `/api/v1/staff/clients/${ID}/connections`, undefined],
  ['POST', `/api/v1/staff/clients/${ID}/connections/${OTHER}/respond`, { response: 'decline' }],
  ['POST', `/api/v1/staff/clients/${ID}/connections/${OTHER}/share-contact`, undefined],
];

await test('members reach their own routes, staff theirs, and neither the other, nor anyone unsigned', async (t) => {
  for (const [role, mine, theirs] of [
    ['member', MEMBER_ROUTES, STAFF_ROUTES],
    ['agent', STAFF_ROUTES, MEMBER_ROUTES],
    ['admin', STAFF_ROUTES, MEMBER_ROUTES],
  ] as const) {
    const { app, call } = await setup(role);
    t.after(() => app.close());
    for (const [method, url, body] of mine) {
      const res = await call(method as 'GET', url, body);
      assert.ok(res.statusCode < 300, `${role} ${method} ${url}: ${res.statusCode}`);
    }
    for (const [method, url, body] of theirs) {
      assert.equal(
        (await call(method as 'GET', url, body)).statusCode,
        403,
        `${role} ${method} ${url}`,
      );
    }
  }
  const { app } = await setup('member');
  t.after(() => app.close());
  const anonymous = await app.inject({
    url: '/api/v1/me/notifications',
    headers: { host: 'localhost' },
  });
  assert.equal(anonymous.statusCode, 401);
});

await test('the inbox is open to every signed-in role', async (t) => {
  for (const role of ['member', 'agent', 'admin'] as const) {
    const { app, call } = await setup(role);
    t.after(() => app.close());
    const res = await call('GET', '/api/v1/me/notifications');
    assert.equal(res.statusCode, 200, role);
    assert.deepEqual(Object.keys(res.json().items[0]).sort(), [
      'about',
      'connectionId',
      'createdAt',
      'forProfileId',
      'id',
      'kind',
    ]);
    // The internal cursor position is never sent.
    assert.equal('position' in res.json().items[0], false);
  }
});

await test('a request, an answer and a list take only what they should', async (t) => {
  const { app, call, calls } = await setup('member');
  t.after(() => app.close());
  const sent = await call('POST', '/api/v1/me/connections', { candidateId: ID });
  assert.deepEqual(sent.json(), { outcome: 'requested', connectionId: ID, status: 'pending' });
  assert.deepEqual(calls[0]?.args[0], ID);

  await call('POST', `/api/v1/me/connections/${ID}/respond`, { response: 'decline' });
  assert.deepEqual(calls[1]?.args.slice(0, 2), [ID, false]);
  assert.equal((await call('POST', `/api/v1/me/connections/${ID}/withdraw`)).statusCode, 204);

  await call('GET', '/api/v1/me/connections?box=sent&limit=5');
  assert.deepEqual(calls.at(-1)?.args[0], { box: 'sent', limit: 5 });
  await call('GET', '/api/v1/me/connections');
  assert.deepEqual(calls.at(-1)?.args[0], { box: 'received', limit: 20 });

  const before = calls.length;
  for (const bad of [
    () => call('POST', '/api/v1/me/connections', {}),
    () => call('POST', '/api/v1/me/connections', { candidateId: 'x' }),
    () => call('POST', '/api/v1/me/connections', { candidateId: ID, extra: 1 }),
    () => call('POST', `/api/v1/me/connections/${ID}/respond`, { response: 'maybe' }),
    () => call('POST', `/api/v1/me/connections/${ID}/respond`, {}),
    () => call('POST', '/api/v1/me/connections/not-an-id/withdraw'),
    () => call('GET', '/api/v1/me/connections?box=all'),
    () => call('GET', '/api/v1/me/connections?limit=0'),
    () => call('GET', '/api/v1/me/notifications?limit=51'),
    () => call('GET', '/api/v1/me/notifications?extra=1'),
  ]) {
    assert.equal((await bad()).statusCode, 400);
  }
  assert.equal(calls.length, before);
});

await test('staff answer for a client with the ids from the path, and never a person from the body', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  assert.equal(
    (
      await call('POST', `/api/v1/staff/clients/${ID}/connections/${OTHER}/respond`, {
        response: 'accept',
      })
    ).statusCode,
    204,
  );
  assert.deepEqual(calls[0]?.args.slice(0, 3), [ID, OTHER, true]);
  assert.equal(
    (
      await call('POST', `/api/v1/staff/clients/${ID}/connections/${OTHER}/respond`, {
        response: 'accept',
        asClient: ID,
      })
    ).statusCode,
    400,
  );
  assert.equal((await call('GET', '/api/v1/staff/clients/not-an-id/connections')).statusCode, 400);
});
