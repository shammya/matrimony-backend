import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { MatchPage } from '../src/bo/matches.js';
import { buildApp } from '../src/controller/app.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  authFor,
  config,
  unusedAccess,
  unusedCandidates,
  unusedConnections,
  unusedClients,
  unusedInvitations,
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
const page: MatchPage = {
  items: [
    {
      candidateId: ID,
      memberCode: 'M0000001',
      position: '2026-10-10T08:00:00.000000Z',
      connection: null,
      fullName: 'Ayesha',
      age: 27,
      hasPhoto: true,
    },
  ],
  next: null,
  profileStatus: 'active',
  releasedTotal: 1,
  visibleFields: ['fullName', 'age', 'photo'],
};

async function setup(role: 'admin' | 'agent' | 'member' = 'member') {
  const calls: { name: string; actor: ProfileActor; args: unknown[] }[] = [];
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
    connections: unusedConnections,
    invitations: unusedInvitations,
    matches: {
      detail: async () => {
        throw new Error('not used here');
      },
      page: async (actor, ...args) => {
        calls.push({ name: 'page', actor, args });
        return page;
      },
      photo: async (actor, ...args) => {
        calls.push({ name: 'photo', actor, args });
        return Buffer.from([1, 2, 3]);
      },
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
  const call = (url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
    });
  return { app, call, calls };
}

await test('only a member reaches their matches, and nobody without signing in', async (t) => {
  for (const role of ['admin', 'agent'] as const) {
    const { app, call } = await setup(role);
    t.after(() => app.close());
    assert.equal((await call('/api/v1/me/matches')).statusCode, 403, role);
    assert.equal((await call(`/api/v1/me/matches/${ID}/photo`)).statusCode, 403, role);
  }
  const { app, call } = await setup('member');
  t.after(() => app.close());
  assert.equal((await call('/api/v1/me/matches')).statusCode, 200);
  const anonymous = await app.inject({ url: '/api/v1/me/matches', headers: { host: 'localhost' } });
  assert.equal(anonymous.statusCode, 401);
});

await test('the response has the allowed fields and never the internal cursor position', async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  const body = (await call('/api/v1/me/matches')).json();
  assert.deepEqual(Object.keys(body).sort(), [
    'items',
    'next',
    'profileStatus',
    'releasedTotal',
    'visibleFields',
  ]);
  assert.deepEqual(body.items[0], {
    candidateId: ID,
    memberCode: 'M0000001',
    connection: null,
    fullName: 'Ayesha',
    age: 27,
    hasPhoto: true,
  });
});

await test('the filters are cleaned, blank ones ignored, and nonsense is refused', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  await call(
    '/api/v1/me/matches?q=m0000001&ageMin=25&ageMax=30&religion=islam&district=dhaka&educationMin=bachelors&limit=5&profession=',
  );
  // A blank filter is ignored: it comes through as undefined, which the database sees as no filter.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.args[0])), {
    q: 'M0000001',
    ageMin: 25,
    ageMax: 30,
    religion: 'islam',
    district: 'dhaka',
    educationMin: 'bachelors',
    limit: 5,
  });
  await call('/api/v1/me/matches');
  assert.deepEqual(calls[1]?.args[0], { limit: 20 });
  for (const bad of [
    'ageMin=17',
    'ageMax=101',
    'ageMin=30&ageMax=25',
    'religion=nowhere',
    'district=atlantis',
    'educationMin=phd2',
    'limit=0',
    'limit=51',
    'q=M1;DROP',
    'candidateId=x',
    'status=active',
  ]) {
    assert.equal((await call(`/api/v1/me/matches?${bad}`)).statusCode, 400, bad);
  }
  assert.equal(calls.length, 2);
});

await test('a photo takes an id and a size, and is private to the browser', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const res = await call(`/api/v1/me/matches/${ID}/photo`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.equal(res.headers['cache-control'], 'private, max-age=3600');
  assert.deepEqual(calls[0]?.args, [ID, 'thumb']);
  await call(`/api/v1/me/matches/${ID}/photo?size=full`);
  assert.deepEqual(calls[1]?.args, [ID, 'full']);
  assert.equal((await call('/api/v1/me/matches/not-an-id/photo')).statusCode, 400);
  assert.equal((await call(`/api/v1/me/matches/${ID}/photo?size=huge`)).statusCode, 400);
});
