import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { ReviewDetail } from '../src/bo/review.js';
import { buildApp } from '../src/controller/app.js';
import type { ClientDetail } from '../src/service/client-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import {
  account,
  agency,
  config,
  unusedPhotos,
  unusedProfiles,
  unusedMatches,
  unusedConnections,
  authFor,
  unusedInvitations,
  unusedAccess,
} from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const ID = '44444444-4444-4444-8444-444444444444';
const emptyState = { profile: null, pendingReview: null, lastDecision: null };
const detail: ReviewDetail = {
  id: ID,
  kind: 'initial_submission',
  status: 'approved',
  createdAt: '2026-10-06T00:00:00.000Z',
  position: '2026-10-06T00:00:00.000000Z',
  profile: {
    id: ID,
    memberCode: 'M0000001',
    fullName: 'Rahim',
    serviceMode: 'self_service',
    assignedAgentId: null,
  },
  submittedBy: { id: ID, displayName: 'Niha' },
  photoId: null,
  baseProfileVersion: 3,
  reviewerNotes: null,
  reviewedAt: null,
  decidedBy: null,
  profileDetail: { status: 'active', version: 4 },
  changes: [],
  stale: false,
  canDecide: false,
  blockedBy: 'decided',
};

async function setup(role: 'admin' | 'agent' | 'member' = 'agent') {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    <T>(name: string, result: T) =>
    async (_actor: ProfileActor, ...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const image = Buffer.from([1, 2, 3]);
  const clientDetail: ClientDetail = {
    state: emptyState,
    meta: { serviceMode: 'assisted', assignedAgent: null, owner: null },
  };

  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    reviews: {
      list: record('reviews.list', { items: [], next: null }),
      pendingCount: record('reviews.count', 4),
      detail: record('reviews.detail', detail),
      approve: record('reviews.approve', detail),
      reject: record('reviews.reject', detail),
      photo: async (_actor, ...args) => {
        calls.push({ name: 'reviews.photo', args });
        return image;
      },
    },
    clients: {
      list: record('clients.list', { items: [], next: null }),
      detail: record('clients.detail', clientDetail),
      create: record('clients.create', { id: ID, detail: clientDetail }),
      save: record('clients.save', clientDetail),
      submit: record('clients.submit', clientDetail),
      requestEdit: record('clients.edit', clientDetail),
      cancelPending: record('clients.cancel', clientDetail),
      changeStatus: record('clients.status', clientDetail),
      assign: record('clients.assign', clientDetail),
      listStaff: record('clients.staff', []),
    },
    candidates: {
      generate: record('candidates.generate', { considered: 0, proposed: 0, items: [] }),
      list: record('candidates.list', { items: [] }),
      settings: record('candidates.settings', {
        cap: 50,
        visibleFields: ['fullName'],
        releasedCount: 0,
        isDefault: true,
      }),
      saveSettings: record('candidates.saveSettings', {
        cap: 40,
        visibleFields: ['fullName'],
        releasedCount: 0,
        isDefault: false,
      }),
      release: record('candidates.release', { done: [], skipped: [] }),
      remove: record('candidates.remove', { done: [], skipped: [] }),
    },
    matches: unusedMatches,
    connections: unusedConnections,
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
    invitations: unusedInvitations,
  });
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token' },
    });
  return { app, call, calls, image };
}

const validClient = {
  profile: {
    fullName: 'Karima',
    dateOfBirth: '1998-03-02',
    gender: 'female',
    maritalStatus: 'never_married',
    heightCm: 160,
    religionCode: 'islam',
    currentDistrictCode: 'dhaka',
    highestDegreeCode: 'bachelors',
    occupationCode: 'student',
  },
  contact: { phone: '+8801712345678' },
};

const ROUTES: [string, string, unknown, ('admin' | 'agent')[]][] = [
  ['GET', '/api/v1/reviews', undefined, ['admin', 'agent']],
  ['GET', '/api/v1/reviews/summary', undefined, ['admin', 'agent']],
  ['GET', `/api/v1/reviews/${ID}`, undefined, ['admin', 'agent']],
  ['GET', `/api/v1/reviews/${ID}/photo`, undefined, ['admin', 'agent']],
  ['POST', `/api/v1/reviews/${ID}/approve`, {}, ['admin', 'agent']],
  ['POST', `/api/v1/reviews/${ID}/reject`, { note: 'x' }, ['admin', 'agent']],
  ['GET', '/api/v1/staff/clients', undefined, ['admin', 'agent']],
  ['POST', '/api/v1/staff/clients', validClient, ['admin', 'agent']],
  ['GET', `/api/v1/staff/clients/${ID}`, undefined, ['admin', 'agent']],
  ['PUT', `/api/v1/staff/clients/${ID}`, { ...validClient, version: 1 }, ['admin', 'agent']],
  ['POST', `/api/v1/staff/clients/${ID}/submit`, { version: 1 }, ['admin', 'agent']],
  [
    'POST',
    `/api/v1/staff/clients/${ID}/edit-requests`,
    { ...validClient, version: 1 },
    ['admin', 'agent'],
  ],
  ['DELETE', `/api/v1/staff/clients/${ID}/pending-review`, undefined, ['admin', 'agent']],
  [
    'POST',
    `/api/v1/staff/clients/${ID}/status`,
    { status: 'paused', version: 1 },
    ['admin', 'agent'],
  ],
  ['PUT', `/api/v1/staff/clients/${ID}/assignment`, { agentId: null }, ['admin']],
  ['GET', '/api/v1/admin/staff', undefined, ['admin']],
  ['POST', `/api/v1/staff/clients/${ID}/candidates/generate`, undefined, ['admin', 'agent']],
  ['GET', `/api/v1/staff/clients/${ID}/candidates`, undefined, ['admin', 'agent']],
  ['GET', `/api/v1/staff/clients/${ID}/release-settings`, undefined, ['admin', 'agent']],
  [
    'PUT',
    `/api/v1/staff/clients/${ID}/release-settings`,
    { cap: 40, visibleFields: ['fullName'] },
    ['admin', 'agent'],
  ],
  [
    'POST',
    `/api/v1/staff/clients/${ID}/candidates/release`,
    { candidateIds: [ID] },
    ['admin', 'agent'],
  ],
  [
    'POST',
    `/api/v1/staff/clients/${ID}/candidates/remove`,
    { candidateIds: [ID] },
    ['admin', 'agent'],
  ],
];

await test('members cannot reach any staff route, and nobody can without signing in', async (t) => {
  const { app, call } = await setup('member');
  t.after(() => app.close());
  for (const [method, url, body] of ROUTES) {
    const res = await call(method as 'GET', url, body);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  const anonymous = await app.inject({ url: '/api/v1/reviews', headers: { host: 'localhost' } });
  assert.equal(anonymous.statusCode, 401);
});

await test('staff routes are open to the roles meant for them, and only those', async (t) => {
  for (const role of ['admin', 'agent'] as const) {
    const { app, call } = await setup(role);
    t.after(() => app.close());
    for (const [method, url, body, allowed] of ROUTES) {
      const res = await call(method as 'GET', url, body);
      if (allowed.includes(role))
        assert.ok(res.statusCode < 300, `${role} ${method} ${url}: ${res.statusCode}`);
      else assert.equal(res.statusCode, 403, `${role} ${method} ${url}`);
    }
  }
});

await test('a candidate list takes a state and a size, and refuses nonsense', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  await call('GET', `/api/v1/staff/clients/${ID}/candidates`);
  assert.deepEqual(calls[0]?.args[1], { state: 'proposed', limit: 100 });
  await call('GET', `/api/v1/staff/clients/${ID}/candidates?state=removed&limit=5`);
  assert.deepEqual(calls[1]?.args[1], { state: 'removed', limit: 5 });
  for (const bad of ['state=weird', 'limit=0', 'limit=201', 'limit=x', 'extra=1']) {
    assert.equal(
      (await call('GET', `/api/v1/staff/clients/${ID}/candidates?${bad}`)).statusCode,
      400,
      bad,
    );
  }
  assert.equal((await call('GET', '/api/v1/staff/clients/not-an-id/candidates')).statusCode, 400);
  assert.equal(calls.length, 2);
});

await test('settings and release bodies are checked, and what the client sends is cleaned', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  const url = `/api/v1/staff/clients/${ID}`;
  // The fields come back unique and in the list's own order.
  await call('PUT', `${url}/release-settings`, {
    cap: 30,
    visibleFields: ['photo', 'fullName', 'photo'],
  });
  assert.deepEqual(calls[0]?.args[1], { cap: 30, visibleFields: ['fullName', 'photo'] });
  for (const bad of [
    { cap: 0, visibleFields: ['fullName'] },
    { cap: 201, visibleFields: ['fullName'] },
    { cap: 1.5, visibleFields: ['fullName'] },
    { cap: 10, visibleFields: [] },
    { cap: 10, visibleFields: ['phone'] },
    { cap: 10, visibleFields: ['internalNotes'] },
    { cap: 10, visibleFields: ['fullName'], extra: 1 },
    { visibleFields: ['fullName'] },
  ]) {
    assert.equal(
      (await call('PUT', `${url}/release-settings`, bad)).statusCode,
      400,
      JSON.stringify(bad),
    );
  }
  await call('POST', `${url}/candidates/release`, { candidateIds: [ID, ID] });
  assert.deepEqual(calls[1]?.args[1], { candidateIds: [ID] });
  for (const bad of [
    {},
    { candidateIds: [] },
    { candidateIds: ['x'] },
    { candidateIds: [ID], extra: 1 },
  ]) {
    for (const action of ['release', 'remove']) {
      assert.equal(
        (await call('POST', `${url}/candidates/${action}`, bad)).statusCode,
        400,
        `${action} ${JSON.stringify(bad)}`,
      );
    }
  }
  assert.equal(calls.length, 2);
});

await test('generating takes no body from the client and answers with the proposals', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  const res = await call('POST', `/api/v1/staff/clients/${ID}/candidates/generate`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { considered: 0, proposed: 0, items: [] });
  assert.equal(calls[0]?.name, 'candidates.generate');
  assert.equal(calls[0]?.args[0], ID);
});

await test('the agency and account come from the session, never from the request', async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  await call('POST', `/api/v1/reviews/${ID}/approve`, { note: 'ok', profileVersion: 4 });
  assert.deepEqual(calls[0]?.args[1], { note: 'ok', profileVersion: 4 });
  assert.equal(
    (await call('POST', `/api/v1/reviews/${ID}/approve`, { agencyId: 'other', reviewerId: 'x' }))
      .statusCode,
    400,
  );
  assert.equal(calls.length, 1);
});

await test('rejecting needs a reason, and a reason that is too long is refused', async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  for (const note of [undefined, '', '   ']) {
    const res = await call(
      'POST',
      `/api/v1/reviews/${ID}/reject`,
      note === undefined ? {} : { note },
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.details.fields[0].path, 'note');
    assert.equal(res.json().error.details.fields[0].code, 'required');
  }
  const long = await call('POST', `/api/v1/reviews/${ID}/reject`, { note: 'x'.repeat(1001) });
  assert.equal(long.json().error.details.fields[0].code, 'tooLong');
  assert.equal(calls.length, 0);
  assert.equal(
    (await call('POST', `/api/v1/reviews/${ID}/reject`, { note: 'Add a photo.' })).statusCode,
    200,
  );
});

await test('the queue takes a status, a kind and a page size, and refuses nonsense', async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  await call('GET', '/api/v1/reviews?status=approved&kind=photo_add&limit=5');
  assert.deepEqual(calls[0]?.args[0], { status: 'approved', kind: 'photo_add', limit: 5 });
  await call('GET', '/api/v1/reviews');
  assert.deepEqual(calls[1]?.args[0], { status: 'pending', limit: 20 });
  for (const bad of [
    'status=weird',
    'kind=photo_remove',
    'limit=0',
    'limit=51',
    'limit=x',
    'extra=1',
  ]) {
    assert.equal((await call('GET', `/api/v1/reviews?${bad}`)).statusCode, 400, bad);
  }
  assert.equal((await call('GET', '/api/v1/reviews/not-an-id')).statusCode, 400);
});

await test('the count of waiting requests is its own small route, not mistaken for a request id', async (t) => {
  const { app, call } = await setup('agent');
  t.after(() => app.close());
  const res = await call('GET', '/api/v1/reviews/summary');
  assert.deepEqual(res.json(), { pending: 4 });
});

await test("the reviewer's response carries what they need and nothing internal", async (t) => {
  const { app, call } = await setup('admin');
  t.after(() => app.close());
  const body = (await call('GET', `/api/v1/reviews/${ID}`)).json();
  assert.deepEqual(Object.keys(body).sort(), [
    'baseProfileVersion',
    'blockedBy',
    'canDecide',
    'changes',
    'createdAt',
    'decidedBy',
    'id',
    'kind',
    'photoId',
    'profile',
    'profileStatus',
    'profileVersion',
    'reviewedAt',
    'reviewerNotes',
    'stale',
    'status',
    'submittedBy',
  ]);
});

await test('a photo under review comes back as a private image, in the size asked for', async (t) => {
  const { app, call, calls, image } = await setup('agent');
  t.after(() => app.close());
  const res = await call('GET', `/api/v1/reviews/${ID}/photo?size=thumb`);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(String(res.headers['cache-control']), /^private/);
  assert.deepEqual(res.rawPayload, image);
  assert.deepEqual(calls.at(-1)?.args, [ID, 'thumb']);
  assert.equal((await call('GET', `/api/v1/reviews/${ID}/photo?size=huge`)).statusCode, 400);
});

await test('a new client is validated like a profile, and may name an agent only by a real id', async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  const created = await call('POST', '/api/v1/staff/clients', {
    ...validClient,
    assignedAgentId: ID,
  });
  assert.equal(created.statusCode, 201);
  assert.equal((calls[0]?.args[0] as { assignedAgentId: string }).assignedAgentId, ID);

  const bad = await call('POST', '/api/v1/staff/clients', {
    ...validClient,
    profile: { ...validClient.profile, fullName: '', dateOfBirth: '2020-01-01' },
    assignedAgentId: 'not-an-id',
  });
  assert.equal(bad.statusCode, 400);
  const codes = Object.fromEntries(
    bad.json().error.details.fields.map((f: { path: string; code: string }) => [f.path, f.code]),
  );
  assert.equal(codes['profile.fullName'], 'required');
  assert.equal(codes['profile.dateOfBirth'], 'underAge');
  assert.equal(codes['assignedAgentId'], 'invalid');
  assert.equal(calls.length, 1);
});

await test('a status change needs a live status and the version that was seen', async (t) => {
  const { app, call, calls } = await setup('agent');
  t.after(() => app.close());
  const path = `/api/v1/staff/clients/${ID}/status`;
  assert.equal((await call('POST', path, { status: 'paused', version: 3 })).statusCode, 200);
  assert.deepEqual(calls[0]?.args, [ID, 'paused', 3, calls[0]?.args[3]]);
  for (const body of [
    { status: 'draft', version: 3 },
    { status: 'pending_review', version: 3 },
    { status: 'paused' },
    { status: 'paused', version: 0 },
    { status: 'paused', version: 3, extra: true },
  ]) {
    assert.equal((await call('POST', path, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 1);
});

await test("an assignment is an agent's id or null, and ids in paths are checked", async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  const path = `/api/v1/staff/clients/${ID}/assignment`;
  assert.equal((await call('PUT', path, { agentId: ID })).statusCode, 200);
  assert.equal((await call('PUT', path, { agentId: null })).statusCode, 200);
  for (const body of [{}, { agentId: 'x' }, { agentId: ID, extra: 1 }]) {
    assert.equal((await call('PUT', path, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await call('GET', '/api/v1/staff/clients/not-an-id')).statusCode, 400);
  assert.equal(calls.length, 2);
});

await test('the client list takes filters and refuses nonsense', async (t) => {
  const { app, call, calls } = await setup('admin');
  t.after(() => app.close());
  await call(
    'GET',
    `/api/v1/staff/clients?status=active&serviceMode=assisted&assignedTo=none&q=kar&limit=10`,
  );
  assert.deepEqual(calls[0]?.args[0], {
    status: 'active',
    serviceMode: 'assisted',
    assignedTo: 'none',
    q: 'kar',
    limit: 10,
  });
  for (const bad of [
    'status=weird',
    'serviceMode=x',
    'assignedTo=someone',
    `q=${'x'.repeat(101)}`,
    'limit=51',
  ]) {
    assert.equal((await call('GET', `/api/v1/staff/clients?${bad}`)).statusCode, 400, bad);
  }
});
