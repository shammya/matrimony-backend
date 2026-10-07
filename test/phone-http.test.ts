import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../src/config/env.js';
import { buildApp, type AppDependencies } from '../src/controller/app.js';
import { AppError } from '../src/exception/app-error.js';
import {
  account,
  agency,
  authFor,
  config,
  unusedAccess,
  unusedClients,
  unusedPhotos,
  unusedProfiles,
  unusedReviews,
} from './fixtures.js';

const sessionId = 'a'.repeat(43);
const pendingId = 'p'.repeat(43);
const tokens = { accessToken: 'access.jwt.token', csrfToken: 'c'.repeat(43), expiresIn: 600 };
const origin = 'http://localhost';
const number = '+8801712345678';
const bearer = { authorization: 'Bearer valid.jwt.token' };

const redis = {
  defineCommand: () => {},
  rateLimit: (...args: unknown[]) => {
    (args.at(-1) as (err: null, value: number[]) => void)(null, [1, 60000]);
  },
} as unknown as Redis;

async function build(
  options: {
    fail?: Partial<Record<string, Error>>;
    config?: AppConfig;
    phone?: boolean;
    outcome?: unknown;
    methods?: unknown;
  } = {},
) {
  const calls: Record<string, unknown[][]> = {
    sendCode: [],
    verifyCode: [],
    pendingSignup: [],
    signup: [],
    sendAttachCode: [],
    confirmAttach: [],
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
    registrations: {
      signInMethods: (async () =>
        options.methods === undefined
          ? {
              email: 'rahim@example.com',
              emailVerified: true,
              phone: number,
              hasPassword: true,
              google: false,
            }
          : options.methods) as AppDependencies['registrations']['signInMethods'],
    },
    identities: {
      tenant: async (host) => {
        if (host !== 'localhost') throw new AppError(404, 'TENANT_NOT_FOUND');
        return {
          id: agency,
          hostname: 'localhost',
          name: 'MSBD',
          locale: 'bn',
          publicConfig: { branches: [], successStories: [] },
        };
      },
    },
    auth: authFor(async () => account),
    access: unusedAccess,
    ...(options.phone === false
      ? {}
      : {
          phone: {
            sendCode: track('sendCode', {
              resendAfter: 60,
              expiresIn: 300,
            }) as unknown as NonNullable<AppDependencies['phone']>['sendCode'],
            verifyCode: track(
              'verifyCode',
              options.outcome ?? { kind: 'session', sessionId, ...tokens },
            ) as unknown as NonNullable<AppDependencies['phone']>['verifyCode'],
            pendingSignup: track('pendingSignup', {
              phone: number,
            }) as unknown as NonNullable<AppDependencies['phone']>['pendingSignup'],
            signup: track('signup', {
              sessionId,
              ...tokens,
            }) as unknown as NonNullable<AppDependencies['phone']>['signup'],
            sendAttachCode: track('sendAttachCode', {
              resendAfter: 60,
              expiresIn: 300,
            }) as unknown as NonNullable<AppDependencies['phone']>['sendAttachCode'],
            confirmAttach: track('confirmAttach', undefined) as unknown as NonNullable<
              AppDependencies['phone']
            >['confirmAttach'],
          },
        }),
  });
  const send = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { host: 'localhost', origin, ...headers },
    });
  return { app, calls, send };
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

await test('the methods say whether phone sign-in is on', async (t) => {
  const on = await build();
  const off = await build({ phone: false });
  t.after(async () => {
    await on.app.close();
    await off.app.close();
  });
  assert.equal((await on.send('GET', '/api/v1/auth/methods')).json().phone, true);
  assert.equal((await off.send('GET', '/api/v1/auth/methods')).json().phone, false);
});

await test('every phone route is a plain 404 when no SMS sender is configured', async (t) => {
  const { app, send } = await build({ phone: false });
  t.after(() => app.close());
  const body = { phone: number, locale: 'en', code: '123456' };
  for (const [method, url] of [
    ['POST', '/api/v1/auth/phone/start'],
    ['POST', '/api/v1/auth/phone/verify'],
    ['GET', '/api/v1/auth/phone/signup'],
    ['POST', '/api/v1/auth/phone/signup'],
    ['POST', '/api/v1/me/phone/start'],
    ['POST', '/api/v1/me/phone/verify'],
  ] as const) {
    const response = await send(
      method,
      url,
      method === 'POST' ? body : undefined,
      url.startsWith('/api/v1/me') ? bearer : {},
    );
    assert.equal(response.statusCode, 404, `${method} ${url}`);
    assert.equal(response.json().error.code, 'PHONE_NOT_CONFIGURED');
  }
});

await test('asking for a code reads the number as E.164 and answers 202 without setting a cookie', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const response = await send('POST', '/api/v1/auth/phone/start', {
    phone: ' 017 1234-5678 ',
    locale: 'bn',
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'code_sent', resendAfter: 60, expiresIn: 300 });
  assert.equal(cookiesOf(response), '');
  assert.deepEqual(calls.sendCode![0]!.slice(0, 3), [
    { agencyId: agency, agencyName: 'MSBD' },
    number,
    'bn',
  ]);
});

await test('asking for a code is for this site only, and a bad number never reaches the process', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const wrongSite = await send(
    'POST',
    '/api/v1/auth/phone/start',
    { phone: number, locale: 'bn' },
    { origin: 'https://evil.example' },
  );
  assert.equal(wrongSite.statusCode, 403);
  const bad = await send('POST', '/api/v1/auth/phone/start', { phone: '12345', locale: 'bn' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(fields(bad), ['phone:invalidPhone']);
  const extra = await send('POST', '/api/v1/auth/phone/start', {
    phone: number,
    locale: 'bn',
    role: 'admin',
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(calls.sendCode!.length, 0);
});

await test('a limit on codes is a 429 that says how long to wait', async (t) => {
  const { app, send } = await build({
    fail: { sendCode: new AppError(429, 'CODE_RATE_LIMITED', { retryAfter: 42 }) },
  });
  t.after(() => app.close());
  const response = await send('POST', '/api/v1/auth/phone/start', { phone: number, locale: 'en' });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, 'CODE_RATE_LIMITED');
  assert.equal(response.headers['retry-after'], '42');
});

await test('a gateway that fails is a plain 502 with a stable code', async (t) => {
  const { app, send } = await build({ fail: { sendCode: new AppError(502, 'SMS_UNAVAILABLE') } });
  t.after(() => app.close());
  const response = await send('POST', '/api/v1/auth/phone/start', { phone: number, locale: 'en' });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'SMS_UNAVAILABLE');
});

await test('a right code for an account signs in like a login: tokens in the body, the session in a Strict cookie', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const response = await send('POST', '/api/v1/auth/phone/verify', {
    phone: '01712345678',
    code: ' ১২৩ ৪৫৬ ',
    locale: 'en',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp(`matrimony-session=${sessionId}`));
  assert.match(cookies, /HttpOnly/);
  assert.match(cookies, /SameSite=Strict/);
  assert.deepEqual(calls.verifyCode![0]!.slice(0, 4), [agency, number, '123456', 'en']);
});

await test('a right code for a number with no account is 202 with the signup cookie and no session', async (t) => {
  const { app, send } = await build({ outcome: { kind: 'signup', pendingId } });
  t.after(() => app.close());
  const response = await send('POST', '/api/v1/auth/phone/verify', {
    phone: number,
    code: '123456',
    locale: 'en',
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'signup_required' });
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp(`matrimony-signup=${pendingId}`));
  assert.match(cookies, /HttpOnly/);
  assert.match(cookies, /SameSite=Strict/);
  assert.match(cookies, /Max-Age=600/);
  assert.equal(cookies.includes('matrimony-session'), false);
});

await test('a wrong, used or cancelled code and a disabled account are safe errors that set no cookie', async (t) => {
  for (const [error, status, code] of [
    [new AppError(400, 'CODE_INVALID'), 400, 'CODE_INVALID'],
    [new AppError(400, 'CODE_EXPIRED'), 400, 'CODE_EXPIRED'],
    [new AppError(403, 'ACCOUNT_NOT_ACTIVE'), 403, 'ACCOUNT_NOT_ACTIVE'],
  ] as const) {
    const { app, send } = await build({ fail: { verifyCode: error } });
    t.after(() => app.close());
    const response = await send('POST', '/api/v1/auth/phone/verify', {
      phone: number,
      code: '123456',
      locale: 'en',
    });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    assert.equal(cookiesOf(response), '');
  }
});

await test('checking a code is for this site only, and a malformed code never reaches the process', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const base = { phone: number, code: '123456', locale: 'en' };
  assert.equal(
    (await send('POST', '/api/v1/auth/phone/verify', base, { origin: 'https://evil.example' }))
      .statusCode,
    403,
  );
  for (const code of ['12345', '1234567', 'abcdef', ''])
    assert.equal(
      (await send('POST', '/api/v1/auth/phone/verify', { ...base, code })).statusCode,
      400,
    );
  assert.equal(calls.verifyCode!.length, 0);
});

await test('the page after a code is told the number, and only with the signup cookie', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const response = await send('GET', '/api/v1/auth/phone/signup', undefined, {
    cookie: `matrimony-signup=${pendingId}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { phone: number });
  assert.deepEqual(calls.pendingSignup![0], [agency, pendingId]);
  const without = await send('GET', '/api/v1/auth/phone/signup');
  assert.equal(without.statusCode, 400);
  const malformed = await send('GET', '/api/v1/auth/phone/signup', undefined, {
    cookie: 'matrimony-signup=short',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.pendingSignup!.length, 1);
});

await test('giving a name and agreeing creates the account and signs in; the signup cookie is cleared', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const response = await send(
    'POST',
    '/api/v1/auth/phone/signup',
    {
      displayName: ' Nina ',
      acceptTerms: true,
      acceptPrivacy: true,
      onBehalfOfOther: true,
      confirmAuthority: true,
    },
    { cookie: `matrimony-signup=${pendingId}` },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), tokens);
  const cookies = cookiesOf(response);
  assert.match(cookies, new RegExp(`matrimony-session=${sessionId}`));
  assert.match(cookies, /matrimony-signup=;/);
  const [agencyId, pending, input] = calls.signup![0]!;
  assert.equal(agencyId, agency);
  assert.equal(pending, pendingId);
  assert.deepEqual(input, {
    displayName: 'Nina',
    acceptTerms: true,
    acceptPrivacy: true,
    onBehalfOfOther: true,
    confirmAuthority: true,
  });
});

await test('agreeing needs a name and both agreements, and nothing about the person can be sent', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const cookie = { cookie: `matrimony-signup=${pendingId}` };
  const none = await send('POST', '/api/v1/auth/phone/signup', {}, cookie);
  assert.equal(none.statusCode, 400);
  assert.deepEqual(fields(none), ['displayName:required']);
  const noAgreement = await send(
    'POST',
    '/api/v1/auth/phone/signup',
    { displayName: 'Nina' },
    cookie,
  );
  assert.deepEqual(fields(noAgreement), ['acceptPrivacy:required', 'acceptTerms:required']);
  const sneaky = await send(
    'POST',
    '/api/v1/auth/phone/signup',
    {
      displayName: 'Nina',
      acceptTerms: true,
      acceptPrivacy: true,
      phone: '+8801811111111',
      role: 'admin',
    },
    cookie,
  );
  assert.equal(sneaky.statusCode, 400);
  const foreign = await send(
    'POST',
    '/api/v1/auth/phone/signup',
    { displayName: 'Nina', acceptTerms: true, acceptPrivacy: true },
    { ...cookie, origin: 'https://evil.example' },
  );
  assert.equal(foreign.statusCode, 403);
  assert.equal(calls.signup!.length, 0);
});

await test('a spent step and a number that got an account meanwhile are safe errors that sign nobody in', async (t) => {
  for (const [error, status, code] of [
    [new AppError(400, 'LINK_INVALID_OR_EXPIRED'), 400, 'LINK_INVALID_OR_EXPIRED'],
    [new AppError(409, 'PHONE_RETRY'), 409, 'PHONE_RETRY'],
  ] as const) {
    const { app, send } = await build({ fail: { signup: error } });
    t.after(() => app.close());
    const response = await send(
      'POST',
      '/api/v1/auth/phone/signup',
      { displayName: 'Nina', acceptTerms: true, acceptPrivacy: true },
      { cookie: `matrimony-signup=${pendingId}` },
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
    assert.equal(cookiesOf(response).includes('matrimony-session'), false);
  }
});

await test('in production the phone cookie carries the __Host- prefix and is Secure', async (t) => {
  const production = { ...config, NODE_ENV: 'production' } as AppConfig;
  const { app, send } = await build({ config: production, outcome: { kind: 'signup', pendingId } });
  t.after(() => app.close());
  const response = await send(
    'POST',
    '/api/v1/auth/phone/verify',
    { phone: number, code: '123456', locale: 'en' },
    { origin: 'https://localhost' },
  );
  assert.match(cookiesOf(response), /^__Host-matrimony-signup=/);
  assert.match(cookiesOf(response), /Secure/);
});

await test('the sign-in methods of the signed-in member show their number partly hidden', async (t) => {
  const { app, send } = await build();
  t.after(() => app.close());
  const response = await send('GET', '/api/v1/me/sign-in-methods', undefined, bearer);
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.email, 'rahim@example.com');
  assert.equal(body.hasPassword, true);
  assert.equal(body.google, false);
  assert.equal(body.phone, '+8801••••••678');
  assert.equal(JSON.stringify(body).includes(number), false);
  assert.equal((await send('GET', '/api/v1/me/sign-in-methods', undefined, {})).statusCode, 401);
});

await test('a member with no number, no email or no password is shown that way', async (t) => {
  const { app, send } = await build({
    methods: { email: null, emailVerified: false, phone: null, hasPassword: false, google: true },
  });
  t.after(() => app.close());
  const response = await send('GET', '/api/v1/me/sign-in-methods', undefined, bearer);
  assert.deepEqual(response.json(), {
    email: null,
    emailVerified: false,
    phone: null,
    hasPassword: false,
    google: true,
  });
});

await test('adding a number needs a signed-in member and sends the code for that account', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const anonymous = await send('POST', '/api/v1/me/phone/start', { phone: number, locale: 'en' });
  assert.equal(anonymous.statusCode, 401);
  const response = await send(
    'POST',
    '/api/v1/me/phone/start',
    { phone: '01712345678', locale: 'en' },
    bearer,
  );
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: 'code_sent', resendAfter: 60, expiresIn: 300 });
  const [context, who, phone, locale] = calls.sendAttachCode![0]!;
  assert.deepEqual(context, { agencyId: agency, agencyName: 'MSBD' });
  assert.equal((who as { id: string }).id, account.id);
  assert.equal(phone, number);
  assert.equal(locale, 'en');
});

await test('confirming the number for the signed-in account, and refusals that change nothing', async (t) => {
  const { app, calls, send } = await build();
  t.after(() => app.close());
  const anonymous = await send('POST', '/api/v1/me/phone/verify', {
    phone: number,
    code: '123456',
  });
  assert.equal(anonymous.statusCode, 401);
  const response = await send(
    'POST',
    '/api/v1/me/phone/verify',
    { phone: number, code: '123456' },
    bearer,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'phone_added' });
  const [agencyId, who, phone, code] = calls.confirmAttach![0]!;
  assert.equal(agencyId, agency);
  assert.equal((who as { id: string }).id, account.id);
  assert.equal(phone, number);
  assert.equal(code, '123456');
  // Nothing about the account, the role or an email can be sent with it.
  const sneaky = await send(
    'POST',
    '/api/v1/me/phone/verify',
    { phone: number, code: '123456', accountId: 'x', locale: 'en' },
    bearer,
  );
  assert.equal(sneaky.statusCode, 400);
  assert.equal(calls.confirmAttach!.length, 1);
});

await test('a number that is in use, a wrong code or an old one are safe errors', async (t) => {
  for (const [error, status, code] of [
    [new AppError(409, 'PHONE_IN_USE'), 409, 'PHONE_IN_USE'],
    [new AppError(400, 'CODE_INVALID'), 400, 'CODE_INVALID'],
    [new AppError(400, 'CODE_EXPIRED'), 400, 'CODE_EXPIRED'],
  ] as const) {
    const { app, send } = await build({ fail: { confirmAttach: error } });
    t.after(() => app.close());
    const response = await send(
      'POST',
      '/api/v1/me/phone/verify',
      { phone: number, code: '123456' },
      bearer,
    );
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error.code, code);
  }
});
