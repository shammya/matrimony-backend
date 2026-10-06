import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { Registration } from '../src/bo/registration.js';
import { buildApp } from '../src/controller/app.js';
import { agency, config, unusedPhotos, unusedProfiles } from './fixtures.js';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

const valid = {
  displayName: '  Rahim Uddin ',
  locale: 'bn',
  acceptTerms: true,
  acceptPrivacy: true,
};

async function setup() {
  const started: { agencyId: string; redirectUri: string; registration: Registration }[] = [];
  const unused = async () => {
    throw new Error('unused');
  };
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    identities: {
      tenant: async () => ({
        id: agency,
        hostname: 'localhost',
        name: 'MSBD',
        locale: 'bn',
        publicConfig: { branches: [], successStories: [] },
      }),
    },
    auth: {
      authenticate: unused,
      begin: unused,
      beginRegistration: async (agencyId, redirectUri, registration) => {
        started.push({ agencyId, redirectUri, registration });
        return {
          challengeId: 'c'.repeat(43),
          authorizationUrl: 'https://issuer.example/authorize',
        };
      },
      complete: unused,
      bootstrap: unused,
      refresh: unused,
      logout: async () => {},
    },
  });
  const register = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: body as object,
      headers: { host: 'localhost', origin: 'http://localhost', ...headers },
    });
  return { app, register, started };
}

await test('registering starts a login attempt at the provider and remembers only what is needed', async (t) => {
  const { app, register, started } = await setup();
  t.after(() => app.close());
  const res = await register(valid);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { authorizationUrl: 'https://issuer.example/authorize' });
  assert.match(String(res.headers['set-cookie']), /matrimony-challenge=/);
  assert.match(String(res.headers['set-cookie']), /HttpOnly/);

  assert.deepEqual(started, [
    {
      agencyId: agency,
      redirectUri: 'http://localhost/api/v1/auth/callback',
      registration: { displayName: 'Rahim Uddin', locale: 'bn', onBehalfOfOther: false },
    },
  ]);
});

await test('a request from another site is refused before anything starts', async (t) => {
  const { app, register, started } = await setup();
  t.after(() => app.close());
  assert.equal((await register(valid, { origin: 'https://evil.example' })).statusCode, 403);
  const noOrigin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: valid,
    headers: { host: 'localhost' },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(started.length, 0);
});

await test('missing agreements and bad answers say which field and why, and start nothing', async (t) => {
  const { app, register, started } = await setup();
  t.after(() => app.close());
  const res = await register({
    displayName: '',
    locale: 'xx',
    acceptTerms: false,
    acceptPrivacy: true,
    onBehalfOfOther: true,
  });
  assert.equal(res.statusCode, 400);
  const fields = res.json().error.details.fields as { path: string; code: string }[];
  const code = (path: string) => fields.find((f) => f.path === path)?.code;
  assert.equal(code('displayName'), 'required');
  assert.equal(code('locale'), 'invalidOption');
  assert.equal(code('acceptTerms'), 'required');
  assert.equal(started.length, 0);
});

await test('registering for someone else needs the confirmation of authority', async (t) => {
  const { app, register, started } = await setup();
  t.after(() => app.close());
  const missing = await register({ ...valid, onBehalfOfOther: true });
  assert.equal(missing.statusCode, 400);
  assert.equal(
    missing.json().error.details.fields.find((f: { path: string }) => f.path === 'confirmAuthority')
      .code,
    'required',
  );

  const ok = await register({ ...valid, onBehalfOfOther: true, confirmAuthority: true });
  assert.equal(ok.statusCode, 200);
  assert.equal(started.at(-1)?.registration.onBehalfOfOther, true);
});

await test('a role, a phone number or an agency in the request is refused, never used', async (t) => {
  const { app, register, started } = await setup();
  t.after(() => app.close());
  for (const extra of [{ role: 'admin' }, { phone: '+8801700000000' }, { agencyId: agency }]) {
    assert.equal((await register({ ...valid, ...extra })).statusCode, 400, JSON.stringify(extra));
  }
  assert.equal(started.length, 0);
});

await test('it is a public route: no sign-in is needed to register', async (t) => {
  const { app, register } = await setup();
  t.after(() => app.close());
  // No authorization header was sent in any of these requests.
  assert.equal((await register(valid)).statusCode, 200);
});
