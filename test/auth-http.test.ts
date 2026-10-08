import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../src/config/env.js';
import { buildApp, type AppDependencies } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import {
  agency,
  config,
  unusedClients,
  unusedInvitations,
  unusedPhotos,
  unusedProfiles,
  unusedReviews,
} from './fixtures.js';

const sessionId = 'a'.repeat(43);
const csrf = 'c'.repeat(43);
const linkToken = 'L'.repeat(43);
const challengeId = 'g'.repeat(43);
const pendingId = 'p'.repeat(43);
const tokens = { accessToken: 'access.jwt.token', csrfToken: csrf, expiresIn: 600 };
const origin = 'http://localhost';

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

type Fail = Error | undefined;

const tenantFor = (locale = 'bn') => ({
  id: agency,
  hostname: 'localhost',
  name: 'MSBD',
  locale,
  publicConfig: { branches: [], successStories: [] },
});

async function build(
  options: {
    fail?: Partial<Record<string, Fail>>;
    config?: AppConfig;
    locale?: string;
    /** Google sign-in is on unless this is false. */
    google?: boolean;
    outcome?: unknown;
  } = {},
) {
  const calls: Record<string, unknown[][]> = {
    login: [],
    bootstrap: [],
    refresh: [],
    logout: [],
    startRegistration: [],
    verifyEmail: [],
    requestPasswordReset: [],
    resetPassword: [],
    sendReauthCode: [],
    startAddEmail: [],
    confirmAddEmail: [],
    changePassword: [],
    googleStart: [],
    googleComplete: [],
    googlePending: [],
    googleLink: [],
    googlePendingSignup: [],
    googleSignup: [],
  };
  const track =
    <T>(name: string, result: T) =>
    async (...args: unknown[]) => {
      calls[name]!.push(args);
      const failure = options.fail?.[name];
      if (failure) throw failure;
      return result;
    };
  const app = await buildApp({
    config: options.config ?? config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    reviews: unusedReviews,
    clients: unusedClients,
    invitations: unusedInvitations,
    registrations: { signInMethods: async () => null },
    identities: {
      tenant: async (host) => {
        if (host !== 'localhost') throw new AppError(404, 'TENANT_NOT_FOUND');
        return tenantFor(options.locale);
      },
    },
    auth: {
      authenticate: async () => {
        throw new Error('unused');
      },
      login: track('login', { sessionId, ...tokens }) as AppDependencies['auth']['login'],
      bootstrap: track('bootstrap', tokens) as AppDependencies['auth']['bootstrap'],
      refresh: track('refresh', tokens) as AppDependencies['auth']['refresh'],
      logout: track('logout', undefined) as AppDependencies['auth']['logout'],
    },
    ...(options.google === false
      ? {}
      : {
          google: {
            start: track('googleStart', {
              challengeId: challengeId,
              authorizationUrl: 'https://accounts.google.example/auth?state=s',
            }) as unknown as NonNullable<AppDependencies['google']>['start'],
            complete: track(
              'googleComplete',
              options.outcome ?? { kind: 'session', locale: 'bn', sessionId },
            ) as unknown as NonNullable<AppDependencies['google']>['complete'],
            pending: track('googlePending', {
              email: 'rahim@example.com',
            }) as unknown as NonNullable<AppDependencies['google']>['pending'],
            pendingSignup: track('googlePendingSignup', {
              email: 'rahim@example.com',
              name: 'Rahim Uddin',
            }) as unknown as NonNullable<AppDependencies['google']>['pendingSignup'],
            signup: track('googleSignup', {
              locale: 'bn',
              sessionId,
              ...tokens,
            }) as unknown as NonNullable<AppDependencies['google']>['signup'],
            link: track('googleLink', {
              locale: 'bn',
              sessionId,
              ...tokens,
            }) as unknown as NonNullable<AppDependencies['google']>['link'],
          },
        }),
    access: {
      startRegistration: track(
        'startRegistration',
        undefined,
      ) as AppDependencies['access']['startRegistration'],
      verifyEmail: track('verifyEmail', {
        sessionId,
        ...tokens,
      }) as AppDependencies['access']['verifyEmail'],
      requestPasswordReset: track(
        'requestPasswordReset',
        undefined,
      ) as AppDependencies['access']['requestPasswordReset'],
      resetPassword: track(
        'resetPassword',
        undefined,
      ) as AppDependencies['access']['resetPassword'],
      sendReauthCode: track('sendReauthCode', {
        resendAfter: 60,
        expiresIn: 300,
      }) as unknown as AppDependencies['access']['sendReauthCode'],
      startAddEmail: track(
        'startAddEmail',
        undefined,
      ) as AppDependencies['access']['startAddEmail'],
      confirmAddEmail: track(
        'confirmAddEmail',
        undefined,
      ) as AppDependencies['access']['confirmAddEmail'],
      changePassword: track(
        'changePassword',
        undefined,
      ) as AppDependencies['access']['changePassword'],
    },
  });
  const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { host: 'localhost', origin, ...headers },
    });
  return { app, calls, post };
}

const cookiesOf = (response: { headers: Record<string, unknown> }) =>
  [response.headers['set-cookie']].flat().filter(Boolean).join('\n');
const fields = (response: {
  json: () => { error: { details: { fields: { path: string; code: string }[] } } };
}) =>
  response
    .json()
    .error.details.fields.map((f) => `${f.path}:${f.code}`)
    .sort();

const registration = {
  email: ' Rahim@Example.com ',
  password: 'a good long password',
  displayName: '  Rahim Uddin ',
  locale: 'bn',
  acceptTerms: true,
  acceptPrivacy: true,
};

// ---- sign in -------------------------------------------------------------------------------

await test('signing in returns the tokens and starts an HttpOnly, strict, same-site session cookie', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/login', {
    email: ' Rahim@Example.com ',
    password: 'the right password',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  assert.equal(response.headers['cache-control'], 'no-store');
  const cookie = cookiesOf(response);
  assert.match(cookie, new RegExp(`^matrimony-session=${sessionId}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=28800/);
  // The session id is only in the cookie, never in the body.
  assert.equal(response.body.includes(sessionId), false);
  // The agency comes from the host, and the email reaches the process clean.
  assert.deepEqual(calls.login![0]!.slice(0, 2), [
    agency,
    { email: 'rahim@example.com', password: 'the right password' },
  ]);
});

await test('in production the cookie is Secure and carries the __Host- prefix', async (t) => {
  const production = { ...config, NODE_ENV: 'production' } as AppConfig;
  const { app, post } = await build({ config: production });
  t.after(() => app.close());
  const response = await post(
    '/api/v1/auth/login',
    { email: 'a@b.com', password: 'x' },
    { origin: 'https://localhost' },
  );
  assert.equal(response.statusCode, 200);
  const cookie = cookiesOf(response);
  assert.match(cookie, /^__Host-matrimony-session=/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

await test('a sign-in from another site, or with no Origin, is refused before anything is checked', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const body = { email: 'a@b.com', password: 'x' };
  assert.equal(
    (await post('/api/v1/auth/login', body, { origin: 'https://evil.example' })).statusCode,
    403,
  );
  const none = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: body,
    headers: { host: 'localhost' },
  });
  assert.equal(none.statusCode, 403);
  assert.equal(none.json().error.code, 'ORIGIN_INVALID');
  assert.equal(calls.login!.length, 0);
});

await test('a sign-in with missing or extra fields says which, and checks nothing', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const empty = await post('/api/v1/auth/login', { email: '', password: '' });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(fields(empty), ['email:required', 'password:required']);
  const bad = await post('/api/v1/auth/login', { email: 'not-an-email', password: 'x' });
  assert.deepEqual(fields(bad), ['email:invalidEmail']);
  for (const extra of [{ role: 'admin' }, { agencyId: agency }, { remember: true }])
    assert.equal(
      (await post('/api/v1/auth/login', { email: 'a@b.com', password: 'x', ...extra })).statusCode,
      400,
    );
  assert.equal((await post('/api/v1/auth/login')).statusCode, 400);
  assert.equal(calls.login!.length, 0);
});

await test('wrong credentials, a pause and a disabled account are safe errors and set no session', async (t) => {
  for (const [error, status, code] of [
    [new AppError(401, 'INVALID_CREDENTIALS'), 401, 'INVALID_CREDENTIALS'],
    [new AppError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 540 }), 429, 'TOO_MANY_ATTEMPTS'],
    [new AppError(403, 'ACCOUNT_NOT_ACTIVE'), 403, 'ACCOUNT_NOT_ACTIVE'],
  ] as const) {
    const { app, post } = await build({ fail: { login: error } });
    t.after(() => app.close());
    const response = await post('/api/v1/auth/login', { email: 'a@b.com', password: 'x' });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    assert.equal(cookiesOf(response).includes('matrimony-session'), false);
  }
});

await test('a pause says how long to wait, in the body and in Retry-After', async (t) => {
  const { app, post } = await build({
    fail: { login: new AppError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 540 }) },
  });
  t.after(() => app.close());
  const response = await post('/api/v1/auth/login', { email: 'a@b.com', password: 'x' });
  assert.equal(response.json().error.details.retryAfter, 540);
  assert.equal(response.headers['retry-after'], '540');
});

await test('an unexpected failure while signing in does not leak details', async (t) => {
  const { app, post } = await build({ fail: { login: new Error('database password is hunter2') } });
  t.after(() => app.close());
  const response = await post('/api/v1/auth/login', { email: 'a@b.com', password: 'x' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.equal(response.body.includes('hunter2'), false);
});

// ---- registering and email links -----------------------------------------------------------

await test('registering is public, answers 202, and hands the process the cleaned input', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/register', registration);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'verification_sent' });
  assert.equal(cookiesOf(response), '');
  const [context, input] = calls.startRegistration![0]!;
  assert.deepEqual(context, { agencyId: agency, agencyName: 'MSBD', origin: 'http://localhost' });
  assert.equal((input as { email: string }).email, 'rahim@example.com');
  assert.equal((input as { displayName: string }).displayName, 'Rahim Uddin');
});

await test('the links in emails are built from the host that was validated, never from a header', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  await post('/api/v1/auth/register', registration, {
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
  });
  assert.equal((calls.startRegistration![0]![0] as { origin: string }).origin, 'http://localhost');
});

await test('registering from another site is refused before anything is sent', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  assert.equal(
    (await post('/api/v1/auth/register', registration, { origin: 'https://evil.example' }))
      .statusCode,
    403,
  );
  assert.equal(calls.startRegistration!.length, 0);
});

await test('bad registration answers say which field and why, and send nothing', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/register', {
    email: 'nope',
    password: 'short',
    displayName: '',
    locale: 'xx',
    acceptTerms: false,
    acceptPrivacy: true,
    onBehalfOfOther: true,
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(
    fields(response),
    [
      'acceptTerms:required',
      'displayName:required',
      'email:invalidEmail',
      'locale:invalidOption',
      'password:tooShort',
    ].sort(),
  );
  assert.equal(calls.startRegistration!.length, 0);
  // The password the person typed is never echoed back.
  assert.equal(response.body.includes('short'), false);
});

await test('a role, a status, a phone number or an agency in a registration is refused, never used', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  for (const extra of [
    { role: 'admin' },
    { status: 'active' },
    { phone: '+8801700000000' },
    { agencyId: agency },
  ])
    assert.equal(
      (await post('/api/v1/auth/register', { ...registration, ...extra })).statusCode,
      400,
      JSON.stringify(extra),
    );
  assert.equal(calls.startRegistration!.length, 0);
});

await test('too many emails to one address is a 429 that says when to retry', async (t) => {
  const { app, post } = await build({
    fail: { startRegistration: new AppError(429, 'EMAIL_RATE_LIMITED', { retryAfter: 1200 }) },
  });
  t.after(() => app.close());
  const response = await post('/api/v1/auth/register', registration);
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, 'EMAIL_RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '1200');
});

await test('confirming the emailed link signs the person in: tokens in the body, session in the cookie', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/verify-email', { token: linkToken });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  assert.match(cookiesOf(response), new RegExp(`matrimony-session=${sessionId}`));
  assert.match(cookiesOf(response), /HttpOnly/);
  assert.match(cookiesOf(response), /SameSite=Strict/);
  assert.deepEqual(calls.verifyEmail![0]!.slice(0, 2), [agency, linkToken]);
  assert.equal(typeof calls.verifyEmail![0]![2], 'string');
});

await test('a wrong, used or expired link is a plain 400, and a malformed one never reaches the process', async (t) => {
  const { app, calls, post } = await build({
    fail: { verifyEmail: new AppError(400, 'LINK_INVALID_OR_EXPIRED') },
  });
  t.after(() => app.close());
  const gone = await post('/api/v1/auth/verify-email', { token: linkToken });
  assert.equal(gone.statusCode, 400);
  assert.equal(gone.json().error.code, 'LINK_INVALID_OR_EXPIRED');
  const malformed = await post('/api/v1/auth/verify-email', { token: 'short' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.verifyEmail!.length, 1);
  assert.equal(
    (
      await post(
        '/api/v1/auth/verify-email',
        { token: linkToken },
        { origin: 'https://evil.example' },
      )
    ).statusCode,
    403,
  );
});

// ---- forgotten password --------------------------------------------------------------------

await test('asking for a reset link always answers 202, whoever the email belongs to', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/password/forgot', { email: ' Rahim@Example.com ' });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'reset_link_sent' });
  assert.deepEqual(calls.requestPasswordReset![0]![1], 'rahim@example.com');
  assert.equal((await post('/api/v1/auth/password/forgot', { email: 'nope' })).statusCode, 400);
  assert.equal(
    (await post('/api/v1/auth/password/forgot', { email: 'a@b.com', x: 1 })).statusCode,
    400,
  );
  assert.equal(
    (
      await post(
        '/api/v1/auth/password/forgot',
        { email: 'a@b.com' },
        { origin: 'https://evil.example' },
      )
    ).statusCode,
    403,
  );
  assert.equal(calls.requestPasswordReset!.length, 1);
});

await test('choosing a new password needs a good link and a password that follows the rules', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const ok = await post('/api/v1/auth/password/reset', {
    token: linkToken,
    password: 'a new long password',
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { status: 'password_reset' });
  assert.deepEqual(calls.resetPassword![0]!.slice(1, 3), [linkToken, 'a new long password']);

  const weak = await post('/api/v1/auth/password/reset', {
    token: linkToken,
    password: 'password123',
  });
  assert.equal(weak.statusCode, 400);
  assert.deepEqual(fields(weak), ['password:tooWeak']);
  const short = await post('/api/v1/auth/password/reset', { token: linkToken, password: 'short' });
  assert.deepEqual(fields(short), ['password:tooShort']);
  assert.equal(
    (await post('/api/v1/auth/password/reset', { token: 'x', password: 'a new long password' }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await post(
        '/api/v1/auth/password/reset',
        { token: linkToken, password: 'a new long password' },
        { origin: 'https://evil.example' },
      )
    ).statusCode,
    403,
  );
  assert.equal(calls.resetPassword!.length, 1);
});

await test('a used reset link is a plain 400', async (t) => {
  const { app, post } = await build({
    fail: { resetPassword: new AppError(400, 'LINK_INVALID_OR_EXPIRED') },
  });
  t.after(() => app.close());
  const response = await post('/api/v1/auth/password/reset', {
    token: linkToken,
    password: 'a new long password',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'LINK_INVALID_OR_EXPIRED');
});

// ---- the session ---------------------------------------------------------------------------

await test('POST /auth/session returns tokens for a same-origin request with a session cookie', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/session', undefined, {
    cookie: `matrimony-session=${sessionId}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls.bootstrap![0]!.slice(0, 2), [agency, sessionId]);
});

await test('POST /auth/session rejects a cross-site or missing Origin, and a missing or malformed cookie', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const cookie = `matrimony-session=${sessionId}`;
  const wrong = await post('/api/v1/auth/session', undefined, {
    origin: 'https://evil.test',
    cookie,
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.code, 'ORIGIN_INVALID');
  const missing = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { host: 'localhost', cookie },
  });
  assert.equal(missing.statusCode, 403);
  for (const bad of [undefined, 'matrimony-session=short', 'matrimony-session=%20%20']) {
    const response = await post('/api/v1/auth/session', undefined, bad ? { cookie: bad } : {});
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  }
  assert.equal(calls.bootstrap!.length, 0);
});

await test('every auth route resolves the agency from the host, not from the request', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  for (const url of ['/api/v1/auth/session', '/api/v1/auth/login', '/api/v1/auth/register']) {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {},
      headers: {
        host: 'evil.test',
        origin: 'http://evil.test',
        'x-forwarded-host': 'localhost',
        cookie: `matrimony-session=${sessionId}`,
      },
    });
    assert.equal(response.statusCode, 404, url);
  }
  assert.equal(calls.bootstrap!.length + calls.login!.length + calls.startRegistration!.length, 0);
});

await test('refresh needs the session cookie, a CSRF token and the same origin', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const cookie = `matrimony-session=${sessionId}`;
  const ok = await post('/api/v1/auth/refresh', undefined, { cookie, 'x-csrf-token': csrf });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), tokens);
  assert.deepEqual(calls.refresh![0]!.slice(0, 3), [agency, sessionId, csrf]);
  assert.equal((await post('/api/v1/auth/refresh', undefined, { cookie })).statusCode, 400);
  assert.equal(
    (await post('/api/v1/auth/refresh', undefined, { 'x-csrf-token': csrf })).statusCode,
    400,
  );
  assert.equal(
    (
      await post('/api/v1/auth/refresh', undefined, {
        cookie,
        'x-csrf-token': csrf,
        origin: 'https://evil.test',
      })
    ).statusCode,
    403,
  );
  assert.equal(calls.refresh!.length, 1);
});

await test('signing out needs the CSRF token, ends the session and clears the cookie', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const cookie = `matrimony-session=${sessionId}`;
  const response = await post('/api/v1/auth/logout', undefined, { cookie, 'x-csrf-token': csrf });
  assert.equal(response.statusCode, 204);
  assert.match(cookiesOf(response), /matrimony-session=;/);
  assert.deepEqual(calls.logout![0]!.slice(0, 3), [agency, sessionId, csrf]);
  assert.equal((await post('/api/v1/auth/logout', undefined, { cookie })).statusCode, 400);
  assert.equal(
    (
      await post('/api/v1/auth/logout', undefined, {
        cookie,
        'x-csrf-token': csrf,
        origin: 'https://evil.test',
      })
    ).statusCode,
    403,
  );
  assert.equal(calls.logout!.length, 1);
});

await test('the old redirect-based routes are gone', async (t) => {
  const { app } = await build();
  t.after(() => app.close());
  for (const url of ['/api/v1/auth/authorize', '/api/v1/auth/callback', '/api/v1/dev/sms']) {
    const response = await app.inject({ url, headers: { host: 'localhost' } });
    assert.ok([401, 404].includes(response.statusCode), `${url} -> ${response.statusCode}`);
  }
});

// ---- sign in with Google --------------------------------------------------------------------

const googleStartBody = {
  intent: 'register',
  locale: 'en',
  acceptTerms: true,
  acceptPrivacy: true,
};

await test('the page is told which ways of signing in are on', async (t) => {
  const on = await build();
  t.after(() => on.app.close());
  assert.deepEqual(
    (await on.app.inject({ url: '/api/v1/auth/methods', headers: { host: 'localhost' } })).json(),
    {
      password: true,
      google: true,
      phone: false,
      phoneCountries: ['880'],
    },
  );
  const off = await build({ google: false });
  t.after(() => off.app.close());
  assert.deepEqual(
    (await off.app.inject({ url: '/api/v1/auth/methods', headers: { host: 'localhost' } })).json(),
    {
      password: true,
      google: false,
      phone: false,
      phoneCountries: ['880'],
    },
  );
});

await test("starting with Google answers with Google's address and a single-use attempt cookie that Google can come back with", async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post('/api/v1/auth/google/start', googleStartBody);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authorizationUrl: 'https://accounts.google.example/auth?state=s',
  });
  const cookie = cookiesOf(response);
  assert.match(cookie, new RegExp('^matrimony-challenge=' + challengeId));
  assert.match(cookie, /HttpOnly/);
  // Lax, because coming back from Google is a cross-site navigation that must carry it.
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=300/);
  assert.equal(response.body.includes(challengeId), false);
  assert.deepEqual(calls.googleStart![0]!.slice(0, 2), [agency, 'http://localhost']);
  assert.equal((calls.googleStart![0]![2] as { intent: string }).intent, 'register');
});

await test('logging in with Google needs no agreements, registering needs them, and says which', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  assert.equal(
    (await post('/api/v1/auth/google/start', { intent: 'login', locale: 'bn' })).statusCode,
    200,
  );
  const missing = await post('/api/v1/auth/google/start', {
    intent: 'register',
    locale: 'bn',
    onBehalfOfOther: true,
  });
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(fields(missing), [
    'acceptPrivacy:required',
    'acceptTerms:required',
    'confirmAuthority:required',
  ]);
  assert.equal(calls.googleStart!.length, 1);
});

await test('starting with Google refuses other sites, extra fields and bad choices', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  assert.equal(
    (await post('/api/v1/auth/google/start', googleStartBody, { origin: 'https://evil.example' }))
      .statusCode,
    403,
  );
  for (const extra of [{ role: 'admin' }, { agencyId: agency }, { email: 'a@b.com' }])
    assert.equal(
      (await post('/api/v1/auth/google/start', { ...googleStartBody, ...extra })).statusCode,
      400,
    );
  assert.equal(
    (await post('/api/v1/auth/google/start', { ...googleStartBody, intent: 'delete' })).statusCode,
    400,
  );
  assert.equal(
    (await post('/api/v1/auth/google/start', { ...googleStartBody, locale: 'fr' })).statusCode,
    400,
  );
  assert.equal(calls.googleStart!.length, 0);
});

await test('when Google cannot be reached starting says so and sets no cookie', async (t) => {
  const { app, post } = await build({
    fail: { googleStart: new AppError(502, 'GOOGLE_UNAVAILABLE') },
  });
  t.after(() => app.close());
  const response = await post('/api/v1/auth/google/start', googleStartBody);
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'GOOGLE_UNAVAILABLE');
  assert.equal(cookiesOf(response), '');
});

await test('without Google settings every Google route answers 404 GOOGLE_NOT_CONFIGURED', async (t) => {
  const { app, post } = await build({ google: false });
  t.after(() => app.close());
  const start = await post('/api/v1/auth/google/start', googleStartBody);
  assert.equal(start.statusCode, 404);
  assert.equal(start.json().error.code, 'GOOGLE_NOT_CONFIGURED');
  const link = await post(
    '/api/v1/auth/google/link',
    { password: 'x' },
    { cookie: 'matrimony-link=' + pendingId },
  );
  assert.equal(link.statusCode, 404);
  const pending = await app.inject({
    url: '/api/v1/auth/google/pending',
    headers: { host: 'localhost', cookie: 'matrimony-link=' + pendingId },
  });
  assert.equal(pending.statusCode, 404);
  const back = await app.inject({
    url: '/api/v1/auth/google/callback?code=c',
    headers: { host: 'localhost', cookie: 'matrimony-challenge=' + challengeId },
  });
  assert.equal(back.statusCode, 302);
  assert.equal(back.headers.location, '/bn/login?error=GOOGLE_NOT_CONFIGURED');
});

const comeBack = (
  app: Awaited<ReturnType<typeof build>>['app'],
  headers: Record<string, string> = {},
) =>
  app.inject({
    url: '/api/v1/auth/google/callback?code=one-time-code&state=s',
    headers: { host: 'localhost', cookie: 'matrimony-challenge=' + challengeId, ...headers },
  });

await test('coming back from Google signs in with a cookie and redirects, never returning tokens', async (t) => {
  const { app, calls } = await build({ outcome: { kind: 'session', locale: 'en', sessionId } });
  t.after(() => app.close());
  const response = await comeBack(app);
  assert.equal(response.statusCode, 302);
  // The language the person was reading, not the agency's default.
  assert.equal(response.headers.location, '/en/dashboard');
  assert.equal(response.body, '');
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp('matrimony-session=' + sessionId + '.*HttpOnly'));
  assert.match(cookies, /matrimony-session=[^;]+;[^\n]*SameSite=Strict/);
  assert.match(cookies, /matrimony-challenge=;/);
  const everything = JSON.stringify(response.headers) + response.body;
  assert.equal(everything.includes(tokens.accessToken), false);
  assert.equal(everything.includes(tokens.csrfToken), false);
  // The process is given the agency, the attempt, and the full address Google came back to.
  const [agencyId, id, url] = calls.googleComplete![0]!;
  assert.equal(agencyId, agency);
  assert.equal(id, challengeId);
  assert.equal(
    (url as URL).href,
    'http://localhost/api/v1/auth/google/callback?code=one-time-code&state=s',
  );
});

await test('an email that already has an account goes to the password step, with a strict cookie', async (t) => {
  const { app } = await build({ outcome: { kind: 'link', locale: 'bn', pendingId } });
  t.after(() => app.close());
  const response = await comeBack(app);
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/bn/link-google');
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp('matrimony-link=' + pendingId));
  assert.match(cookies, /matrimony-link=[^;]+;[^\n]*HttpOnly/);
  assert.match(cookies, /matrimony-link=[^;]+;[^\n]*SameSite=Strict/);
  assert.match(cookies, /Max-Age=600/);
  // No session yet: nobody is signed in until the password is given.
  assert.equal(cookies.includes('matrimony-session'), false);
});

await test('every failure coming back from Google returns to the login page with a safe code and no session', async (t) => {
  for (const code of [
    'GOOGLE_AUTH_FAILED',
    'GOOGLE_EMAIL_UNVERIFIED',
    'GOOGLE_RETRY',
    'ACCOUNT_HAS_NO_PASSWORD',
    'ACCOUNT_NOT_ACTIVE',
    'OAUTH_CHALLENGE_EXPIRED',
    'OAUTH_CONTEXT_MISMATCH',
  ]) {
    const { app } = await build({ fail: { googleComplete: new AppError(403, code) } });
    t.after(() => app.close());
    const response = await comeBack(app);
    assert.equal(response.statusCode, 302, code);
    assert.equal(response.headers.location, '/bn/login?error=' + code);
    assert.equal(cookiesOf(response).includes('matrimony-session'), false);
    assert.match(cookiesOf(response), /matrimony-challenge=;/);
  }
});

await test('coming back with no attempt cookie goes to the login page instead of showing JSON', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const response = await app.inject({
    url: '/api/v1/auth/google/callback?code=c&state=s',
    headers: { host: 'localhost' },
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/bn/login?error=INVALID_REQUEST');
  assert.equal(calls.googleComplete!.length, 0);
});

await test('an unexpected failure coming back from Google stays a server error and leaks nothing', async (t) => {
  const { app } = await build({
    fail: { googleComplete: new Error('database password is hunter2') },
  });
  t.after(() => app.close());
  const response = await comeBack(app);
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  assert.equal(response.body.includes('hunter2'), false);
});

await test('the password step is told whose account it is, from the strict cookie alone', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const ok = await app.inject({
    url: '/api/v1/auth/google/pending',
    headers: { host: 'localhost', cookie: 'matrimony-link=' + pendingId },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { email: 'rahim@example.com' });
  assert.deepEqual(calls.googlePending![0]!.slice(0, 2), [agency, pendingId]);
  const none = await app.inject({
    url: '/api/v1/auth/google/pending',
    headers: { host: 'localhost' },
  });
  assert.equal(none.statusCode, 400);
  const bad = await app.inject({
    url: '/api/v1/auth/google/pending',
    headers: { host: 'localhost', cookie: 'matrimony-link=short' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(calls.googlePending!.length, 1);
});

await test('approving the link with the password signs in like a login and ends the pending step', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post(
    '/api/v1/auth/google/link',
    { password: 'the right password' },
    { cookie: 'matrimony-link=' + pendingId },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp('matrimony-session=' + sessionId));
  assert.match(cookies, /matrimony-link=;/);
  assert.deepEqual(calls.googleLink![0]!.slice(0, 3), [agency, pendingId, 'the right password']);
});

await test('approving the link needs the same origin, the cookie and a password, and refuses extras', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const cookie = { cookie: 'matrimony-link=' + pendingId };
  assert.equal(
    (
      await post(
        '/api/v1/auth/google/link',
        { password: 'x' },
        { ...cookie, origin: 'https://evil.example' },
      )
    ).statusCode,
    403,
  );
  assert.equal((await post('/api/v1/auth/google/link', { password: 'x' })).statusCode, 400);
  assert.deepEqual(fields(await post('/api/v1/auth/google/link', { password: '' }, cookie)), [
    'password:required',
  ]);
  assert.equal(
    (await post('/api/v1/auth/google/link', { password: 'x', email: 'a@b.com' }, cookie))
      .statusCode,
    400,
  );
  assert.equal(calls.googleLink!.length, 0);
});

await test('a wrong password, a pause and a spent link are safe errors that sign nobody in', async (t) => {
  for (const [error, status, code] of [
    [new AppError(401, 'INVALID_CREDENTIALS'), 401, 'INVALID_CREDENTIALS'],
    [new AppError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 300 }), 429, 'TOO_MANY_ATTEMPTS'],
    [new AppError(400, 'LINK_INVALID_OR_EXPIRED'), 400, 'LINK_INVALID_OR_EXPIRED'],
    [new AppError(409, 'GOOGLE_ALREADY_LINKED'), 409, 'GOOGLE_ALREADY_LINKED'],
  ] as const) {
    const { app, post } = await build({ fail: { googleLink: error } });
    t.after(() => app.close());
    const response = await post(
      '/api/v1/auth/google/link',
      { password: 'x' },
      { cookie: 'matrimony-link=' + pendingId },
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    assert.equal(cookiesOf(response).includes('matrimony-session'), false);
  }
});

await test('in production the Google cookies carry the __Host- prefix and are Secure', async (t) => {
  const production = { ...config, NODE_ENV: 'production' } as AppConfig;
  const { app, post } = await build({ config: production });
  t.after(() => app.close());
  const started = await post('/api/v1/auth/google/start', googleStartBody, {
    origin: 'https://localhost',
  });
  assert.match(cookiesOf(started), /^__Host-matrimony-challenge=/);
  assert.match(cookiesOf(started), /Secure/);
  const back = await app.inject({
    url: '/api/v1/auth/google/callback?code=c',
    headers: { host: 'localhost', cookie: '__Host-matrimony-challenge=' + challengeId },
  });
  assert.equal(back.statusCode, 302);
  assert.match(cookiesOf(back), /__Host-matrimony-session=/);
});

await test('a failure that knows the language the person was reading returns to the login page in it', async (t) => {
  const { GoogleSignInError } = await import('../src/process/google-auth-process.js');
  const { app } = await build({
    fail: { googleComplete: new GoogleSignInError(new AppError(403, 'GOOGLE_AUTH_FAILED'), 'en') },
  });
  t.after(() => app.close());
  const response = await comeBack(app);
  // The agency's default language is Bengali, but the person was reading English.
  assert.equal(response.headers.location, '/en/login?error=GOOGLE_AUTH_FAILED');
});

// ---- a login that found no account: agree to the terms, then create ----

const signupCookieHeader = { cookie: 'matrimony-signup=' + pendingId };

await test('a Google login with no account goes to the agree-and-create page with a strict cookie and no session', async (t) => {
  const { app } = await build({ outcome: { kind: 'signup', locale: 'en', pendingId } });
  t.after(() => app.close());
  const response = await comeBack(app);
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/en/signup-google');
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp('matrimony-signup=' + pendingId));
  assert.match(cookies, /matrimony-signup=[^;]+;[^\n]*HttpOnly/);
  assert.match(cookies, /matrimony-signup=[^;]+;[^\n]*SameSite=Strict/);
  assert.match(cookies, /Max-Age=600/);
  assert.equal(cookies.includes('matrimony-session'), false);
});

await test('the agree-and-create page is told who is signing up, from the strict cookie alone', async (t) => {
  const { app, calls } = await build();
  t.after(() => app.close());
  const ok = await app.inject({
    url: '/api/v1/auth/google/signup',
    headers: { host: 'localhost', ...signupCookieHeader },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { email: 'rahim@example.com', name: 'Rahim Uddin' });
  assert.deepEqual(calls.googlePendingSignup![0]!.slice(0, 2), [agency, pendingId]);
  assert.equal(
    (await app.inject({ url: '/api/v1/auth/google/signup', headers: { host: 'localhost' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/auth/google/signup',
        headers: { host: 'localhost', cookie: 'matrimony-signup=short' },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls.googlePendingSignup!.length, 1);
});

await test('agreeing creates the account and signs in like a login, and ends the step', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const response = await post(
    '/api/v1/auth/google/signup',
    { acceptTerms: true, acceptPrivacy: true },
    signupCookieHeader,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp('matrimony-session=' + sessionId));
  assert.match(cookies, /matrimony-signup=;/);
  const [agencyId, id, input] = calls.googleSignup![0]!;
  assert.equal(agencyId, agency);
  assert.equal(id, pendingId);
  assert.deepEqual(input, {
    acceptTerms: true,
    acceptPrivacy: true,
    onBehalfOfOther: false,
    confirmAuthority: false,
  });
});

await test('creating needs both agreements, and the confirmation when registering for someone else, and says which', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const none = await post('/api/v1/auth/google/signup', {}, signupCookieHeader);
  assert.equal(none.statusCode, 400);
  assert.deepEqual(fields(none), ['acceptPrivacy:required', 'acceptTerms:required']);
  const someone = await post(
    '/api/v1/auth/google/signup',
    { acceptTerms: true, acceptPrivacy: true, onBehalfOfOther: true },
    signupCookieHeader,
  );
  assert.deepEqual(fields(someone), ['confirmAuthority:required']);
  assert.equal(calls.googleSignup!.length, 0);
});

await test('creating refuses other sites, a missing cookie and extra fields, so a name or email cannot be sent', async (t) => {
  const { app, calls, post } = await build();
  t.after(() => app.close());
  const body = { acceptTerms: true, acceptPrivacy: true };
  assert.equal(
    (
      await post('/api/v1/auth/google/signup', body, {
        ...signupCookieHeader,
        origin: 'https://evil.example',
      })
    ).statusCode,
    403,
  );
  assert.equal((await post('/api/v1/auth/google/signup', body)).statusCode, 400);
  for (const extra of [
    { email: 'a@b.com' },
    { name: 'X' },
    { role: 'admin' },
    { agencyId: agency },
  ])
    assert.equal(
      (await post('/api/v1/auth/google/signup', { ...body, ...extra }, signupCookieHeader))
        .statusCode,
      400,
    );
  assert.equal(calls.googleSignup!.length, 0);
});

await test('an expired step, and an address that got an account meanwhile, are safe errors that sign nobody in', async (t) => {
  for (const [error, status, code] of [
    [new AppError(400, 'LINK_INVALID_OR_EXPIRED'), 400, 'LINK_INVALID_OR_EXPIRED'],
    [new AppError(409, 'GOOGLE_RETRY'), 409, 'GOOGLE_RETRY'],
  ] as const) {
    const { app, post } = await build({ fail: { googleSignup: error } });
    t.after(() => app.close());
    const response = await post(
      '/api/v1/auth/google/signup',
      { acceptTerms: true, acceptPrivacy: true },
      signupCookieHeader,
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    assert.equal(cookiesOf(response).includes('matrimony-session'), false);
  }
});

await test('without Google settings the agree-and-create routes answer 404 too', async (t) => {
  const { app, post } = await build({ google: false });
  t.after(() => app.close());
  const get = await app.inject({
    url: '/api/v1/auth/google/signup',
    headers: { host: 'localhost', ...signupCookieHeader },
  });
  assert.equal(get.statusCode, 404);
  assert.equal(
    (
      await post(
        '/api/v1/auth/google/signup',
        { acceptTerms: true, acceptPrivacy: true },
        signupCookieHeader,
      )
    ).statusCode,
    404,
  );
});
