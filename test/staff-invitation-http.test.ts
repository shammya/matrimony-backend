import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import { buildApp } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import type { StaffInvitation } from '../src/bo/staff.js';
import {
  account,
  agency,
  authFor,
  config,
  unusedAccess,
  unusedClients,
  unusedCandidates,
  unusedMatches,
  unusedConnections,
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
const TOKEN = 'A'.repeat(43);
const invitation: StaffInvitation = {
  id: ID,
  email: 'new.agent@example.com',
  displayName: 'New Agent',
  role: 'agent',
  locale: 'en',
  invitedByName: 'Test member',
  createdAt: '2026-10-09T00:00:00.000Z',
  expiresAt: '2026-10-16T00:00:00.000Z',
  status: 'pending',
};
const valid = {
  email: 'New.Agent@Example.com',
  displayName: ' New Agent ',
  role: 'agent',
  locale: 'en',
};

async function setup(role: 'admin' | 'agent' | 'member' = 'admin', fail?: AppError) {
  const calls: { name: string; args: unknown[] }[] = [];
  const track =
    <T>(name: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      if (fail) throw fail;
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
    invitations: {
      invite: track('invite', invitation) as never,
      resend: track('resend', invitation) as never,
      list: track('list', [invitation]) as never,
      revoke: track('revoke', undefined) as never,
      preview: track('preview', {
        email: invitation.email,
        displayName: invitation.displayName,
        role: 'agent',
      }) as never,
      accept: track('accept', {
        sessionId: 'S'.repeat(43),
        accessToken: 'access.jwt.token',
        csrfToken: 'C'.repeat(43),
        expiresIn: 600,
      }) as never,
    },
  });
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: 'localhost', authorization: 'Bearer valid.jwt.token', ...headers },
    });
  return { app, call, calls };
}

const ADMIN_ROUTES: [string, string, unknown][] = [
  ['GET', '/api/v1/admin/staff/invitations', undefined],
  ['POST', '/api/v1/admin/staff/invitations', valid],
  ['POST', `/api/v1/admin/staff/invitations/${ID}/resend`, undefined],
  ['DELETE', `/api/v1/admin/staff/invitations/${ID}`, undefined],
];

await test('only an admin reaches the invitation routes, and nobody without signing in', async (t) => {
  for (const role of ['member', 'agent', 'admin'] as const) {
    const { app, call, calls } = await setup(role);
    t.after(() => app.close());
    for (const [method, url, body] of ADMIN_ROUTES) {
      const res = await call(method as 'GET', url, body);
      if (role === 'admin') assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode}`);
      else assert.equal(res.statusCode, 403, `${role} ${method} ${url}`);
    }
    if (role !== 'admin') assert.equal(calls.length, 0, role);
  }
  const { app } = await setup();
  t.after(() => app.close());
  for (const [method, url] of ADMIN_ROUTES) {
    const res = await app.inject({ method: method as 'GET', url, headers: { host: 'localhost' } });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

await test('inviting validates and cleans the input, and the agency and admin come from the session', async (t) => {
  const { app, call, calls } = await setup();
  t.after(() => app.close());
  const created = await call('POST', '/api/v1/admin/staff/invitations', valid);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), invitation);
  assert.deepEqual(calls[0]?.args[2], {
    email: 'new.agent@example.com',
    displayName: 'New Agent',
    role: 'agent',
    locale: 'en',
  });
  // The admin and the agency are the session's.
  assert.equal((calls[0]?.args[1] as { id: string }).id, account.id);
  assert.equal((calls[0]?.args[0] as { agencyId: string }).agencyId, agency);

  for (const bad of [
    { ...valid, role: 'member' },
    { ...valid, role: 'owner' },
    { ...valid, email: 'not an email' },
    { ...valid, displayName: '   ' },
    { ...valid, locale: 'fr' },
    { ...valid, agencyId: agency },
    { ...valid, status: 'active' },
  ]) {
    const res = await call('POST', '/api/v1/admin/staff/invitations', bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 1);
});

await test('an invitation id must be a uuid, and a failure keeps its code', async (t) => {
  const ok = await setup();
  t.after(() => ok.app.close());
  assert.equal((await ok.call('DELETE', '/api/v1/admin/staff/invitations/nope')).statusCode, 400);
  assert.equal(
    (await ok.call('POST', '/api/v1/admin/staff/invitations/nope/resend')).statusCode,
    400,
  );
  const failing = await setup('admin', new AppError(409, 'EMAIL_IN_USE'));
  t.after(() => failing.app.close());
  const res = await failing.call('POST', '/api/v1/admin/staff/invitations', valid);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'EMAIL_IN_USE');
  const missing = await setup('admin', new AppError(404, 'INVITATION_NOT_FOUND'));
  t.after(() => missing.app.close());
  assert.equal(
    (await missing.call('DELETE', `/api/v1/admin/staff/invitations/${ID}`)).statusCode,
    404,
  );
});

await test('the invited person previews and accepts without signing in, from this site only', async (t) => {
  const { app, call, calls } = await setup('member');
  t.after(() => app.close());
  const same = { origin: 'http://localhost' };
  const anonymous = (url: string, payload: unknown, headers = same) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { host: 'localhost', ...headers },
    });

  const preview = await anonymous('/api/v1/auth/staff-invitation/preview', { token: TOKEN });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(preview.json(), {
    email: invitation.email,
    displayName: 'New Agent',
    role: 'agent',
  });
  assert.equal(calls[0]?.args[0], agency);

  const accepted = await anonymous('/api/v1/auth/staff-invitation/accept', {
    token: TOKEN,
    password: 'a long and strong password',
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), {
    accessToken: 'access.jwt.token',
    csrfToken: 'C'.repeat(43),
    expiresIn: 600,
  });
  const cookie = [accepted.headers['set-cookie']].flat().join(';');
  assert.match(cookie, /matrimony-session=S{43}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  // The session id never appears in the body.
  assert.equal(accepted.body.includes('S'.repeat(43)), false);

  // Another site, no origin, a bad token, a short password and extra fields are all refused.
  for (const url of [
    '/api/v1/auth/staff-invitation/preview',
    '/api/v1/auth/staff-invitation/accept',
  ]) {
    const body = { token: TOKEN, password: 'a long and strong password' };
    const payload = url.endsWith('preview') ? { token: TOKEN } : body;
    assert.equal(
      (await anonymous(url, payload, { origin: 'http://evil.example' })).statusCode,
      403,
      url,
    );
    assert.equal((await anonymous(url, payload, {} as { origin: string })).statusCode, 403, url);
  }
  const before = calls.length;
  for (const bad of [
    { token: 'short', password: 'a long and strong password' },
    { token: TOKEN, password: 'short' },
    { token: TOKEN, password: 'a long and strong password', role: 'admin' },
    { token: TOKEN },
  ]) {
    assert.equal(
      (await anonymous('/api/v1/auth/staff-invitation/accept', bad)).statusCode,
      400,
      JSON.stringify(bad),
    );
  }
  assert.equal(calls.length, before);

  // A link that is not good says so with the usual code.
  const spent = await setup('member', new AppError(400, 'LINK_INVALID_OR_EXPIRED'));
  t.after(() => spent.app.close());
  const res = await spent.app.inject({
    method: 'POST',
    url: '/api/v1/auth/staff-invitation/preview',
    payload: { token: TOKEN },
    headers: { host: 'localhost', origin: 'http://localhost' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'LINK_INVALID_OR_EXPIRED');
  void call;
});
