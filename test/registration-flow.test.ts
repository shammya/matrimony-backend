import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import * as oidc from 'openid-client';
import type { Account } from '../src/bo/identity.js';
import type { Registration } from '../src/bo/registration.js';
import type { Session } from '../src/cache/repository/session-repository.js';
import type { FoundAccount } from '../src/db/raw/repository/registration-repository.js';
import { AppError } from '../src/exception/app-error.js';
import { AuthProcess } from '../src/process/auth-process.js';
import {
  OidcProvider,
  verifiedPhone,
  type Challenge,
  type Tokens,
} from '../src/security/oidc-provider.js';
import { SecretBox } from '../src/security/secret-box.js';
import { account, agency } from './fixtures.js';

const ISSUER = 'https://issuer.example/';
const REDIRECT = 'http://localhost:3000/api/v1/auth/callback';
const registration: Registration = {
  displayName: 'Rahim Secret Name',
  locale: 'bn',
  onBehalfOfOther: false,
};

function setup(
  options: {
    found?: FoundAccount | null;
    phone?: string | undefined;
    claimNames?: string[];
  } = {},
) {
  const logs: string[] = [];
  const box = new SecretBox('ab'.repeat(32));
  const challenges = new Map<string, string>();
  const sessions: Session[] = [];
  const authorized: Challenge[] = [];
  const registered: { phone: string | undefined; registration: Registration }[] = [];
  const found = 'found' in options ? options.found : null;
  const phone = 'phone' in options ? options.phone : '+8801712345678';

  const auth = new AuthProcess(
    {
      authorize: async (challenge) => {
        authorized.push(challenge);
        return 'https://issuer.example/authorize';
      },
      exchange: async (): Promise<Tokens> => ({
        accessToken: 'access',
        refreshToken: 'refresh',
        subject: 'sms|abc',
        phone,
        claimNames: options.claimNames,
      }),
      refresh: async () => ({ accessToken: 'a', refreshToken: 'r' }),
      revoke: async () => {},
    },
    {
      verify: async () => ({
        subject: 'sms|abc',
        issuer: ISSUER,
        expiresAt: Date.now() / 1000 + 300,
      }),
    },
    {
      put: async (_id, session) => {
        sessions.push(session);
      },
      get: async () => null,
      forAccess: async () => null,
      remove: async () => {},
      claim: async () => null,
      finalize: async () => false,
      putChallenge: async (id, sealed) => {
        challenges.set(id, sealed);
      },
      takeChallenge: async (id) => {
        const value = challenges.get(id) ?? null;
        challenges.delete(id);
        return value;
      },
    },
    { account: async () => account },
    {
      find: async () => found ?? null,
      register: async (_agency, identity, input) => {
        registered.push({ phone: identity.phone, registration: input });
        if (!identity.phone) throw new AppError(422, 'REGISTRATION_PHONE_REQUIRED');
        return { ...account, id: 'new-member', displayName: input.displayName };
      },
    },
    { record: async () => {} },
    box,
    3600,
    pino({ level: 'warn' }, { write: (line: string) => logs.push(line) }),
  );
  const callback = new URL(`${REDIRECT}?code=abc&state=s`);
  return { auth, challenges, sessions, authorized, registered, callback, logs };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `an AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

await test('registering creates the account once the provider verified the phone, then logs in', async () => {
  const f = setup();
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  const result = await f.auth.complete(agency, challengeId, f.callback, 'req-1');

  assert.deepEqual(f.registered, [{ phone: '+8801712345678', registration }]);
  assert.equal(f.sessions[0]?.accountId, 'new-member');
  assert.ok(result.sessionId && result.accessToken);
});

await test('logging in never creates an account', async () => {
  const f = setup();
  const { challengeId } = await f.auth.begin(agency, REDIRECT);
  await rejects(f.auth.complete(agency, challengeId, f.callback, 'c'), 403, 'ACCOUNT_NOT_FOUND');
  assert.equal(f.registered.length, 0);
  assert.equal(f.sessions.length, 0);
});

await test('registering when an account already exists is a plain login', async () => {
  const existing: Account = { ...account, id: 'existing-member' };
  const f = setup({ found: { account: existing, status: 'active' } });
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  await f.auth.complete(agency, challengeId, f.callback, 'c');
  assert.equal(f.registered.length, 0, 'no second account');
  assert.equal(f.sessions[0]?.accountId, 'existing-member');
});

await test('an account that cannot log in is refused, whether the person logs in or registers', async () => {
  for (const status of ['invited', 'disabled'] as const) {
    const f = setup({ found: { account, status } });
    for (const start of [
      () => f.auth.begin(agency, REDIRECT),
      () => f.auth.beginRegistration(agency, REDIRECT, registration),
    ]) {
      const { challengeId } = await start();
      await rejects(
        f.auth.complete(agency, challengeId, f.callback, 'c'),
        403,
        'ACCOUNT_NOT_ACTIVE',
      );
    }
    assert.equal(f.registered.length, 0);
    assert.equal(f.sessions.length, 0);
  }
});

await test('a phone the provider did not verify stops the registration', async () => {
  const f = setup({ phone: undefined });
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  await rejects(
    f.auth.complete(agency, challengeId, f.callback, 'c'),
    422,
    'REGISTRATION_PHONE_REQUIRED',
  );
  assert.equal(f.sessions.length, 0);
});

await test('a missing phone is explained in the log by claim names only, never by values', async () => {
  const f = setup({
    phone: undefined,
    claimNames: ['sub', 'iss', 'email_verified', 'nickname'],
  });
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  await rejects(
    f.auth.complete(agency, challengeId, f.callback, 'c'),
    422,
    'REGISTRATION_PHONE_REQUIRED',
  );
  const entry = JSON.parse(f.logs.find((line) => line.includes('REGISTRATION_PHONE_MISSING'))!);
  assert.deepEqual(entry.claimNames, ['sub', 'iss', 'email_verified', 'nickname']);
  assert.equal(entry.code, 'REGISTRATION_PHONE_MISSING');
  assert.ok(!f.logs.join('').includes('Rahim Secret Name'), 'nothing the person typed is logged');
});

await test('nothing is logged when the phone was verified, or for a plain login', async () => {
  const verified = setup();
  const first = await verified.auth.beginRegistration(agency, REDIRECT, registration);
  await verified.auth.complete(agency, first.challengeId, verified.callback, 'c');
  assert.deepEqual(verified.logs, []);

  const login = setup({ phone: undefined });
  const second = await login.auth.begin(agency, REDIRECT);
  await rejects(
    login.auth.complete(agency, second.challengeId, login.callback, 'c'),
    403,
    'ACCOUNT_NOT_FOUND',
  );
  assert.deepEqual(login.logs, []);
});

await test('what the person agreed to is sealed with the login attempt, not readable or reusable', async () => {
  const f = setup();
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  const stored = [...f.challenges.values()][0]!;
  assert.ok(!stored.includes('Rahim'), 'the name is not stored in the clear');
  assert.ok(!stored.includes('displayName'));

  await f.auth.complete(agency, challengeId, f.callback, 'c');
  // The attempt can be used once: a second visit to the callback finds nothing.
  await rejects(
    f.auth.complete(agency, challengeId, f.callback, 'c'),
    401,
    'OAUTH_CHALLENGE_EXPIRED',
  );
  assert.equal(f.registered.length, 1);
});

await test('an attempt for one agency cannot be completed at another', async () => {
  const f = setup();
  const { challengeId } = await f.auth.beginRegistration(agency, REDIRECT, registration);
  await rejects(
    f.auth.complete('22222222-2222-4222-8222-222222222222', challengeId, f.callback, 'c'),
    401,
    'OAUTH_CONTEXT_MISMATCH',
  );
  assert.equal(f.registered.length, 0);
});

await test('the provider is told whether this is a login or a registration', async () => {
  const f = setup();
  await f.auth.begin(agency, REDIRECT);
  await f.auth.beginRegistration(agency, REDIRECT, registration);
  assert.deepEqual(
    f.authorized.map((c) => c.intent),
    ['login', 'register'],
  );
});

// ---- The authorization address built for the provider ----

const configuration = () =>
  new oidc.Configuration(
    {
      issuer: ISSUER,
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
    },
    'client',
  );
const challenge = (intent: Challenge['intent']): Challenge => ({
  agencyId: agency,
  redirectUri: REDIRECT,
  state: 'state',
  nonce: 'nonce',
  verifier: 'v'.repeat(43),
  intent,
});
const params = async (provider: OidcProvider, intent: Challenge['intent']) =>
  new URL(await provider.authorize(challenge(intent))).searchParams;

await test('registration asks the provider for the phone number; login does not', async () => {
  const provider = new OidcProvider(configuration(), 'openid offline_access matrimony:api');
  assert.equal(
    (await params(provider, 'login')).get('scope'),
    'openid offline_access matrimony:api',
  );
  assert.equal(
    (await params(provider, 'register')).get('scope'),
    'openid offline_access matrimony:api phone',
  );
});

await test('registration can be sent straight to the phone sign-in method', async () => {
  const withConnection = new OidcProvider(configuration(), 'openid', 'sms');
  assert.equal((await params(withConnection, 'register')).get('connection'), 'sms');
  assert.equal((await params(withConnection, 'login')).get('connection'), null);

  const without = new OidcProvider(configuration(), 'openid');
  assert.equal((await params(without, 'register')).get('connection'), null);
});

await test('every address still carries state, nonce and the S256 code challenge', async () => {
  const provider = new OidcProvider(configuration(), 'openid', 'sms');
  for (const intent of ['login', 'register'] as const) {
    const p = await params(provider, intent);
    assert.equal(p.get('state'), 'state');
    assert.equal(p.get('nonce'), 'nonce');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok(p.get('code_challenge'));
    assert.equal(p.get('redirect_uri'), REDIRECT);
  }
});

// ---- Which phone number is trusted ----

await test('a number the provider marks as verified is trusted, with or without the connection', () => {
  const claims = { sub: 'auth0|abc', phone_number: '+8801712345678', phone_number_verified: true };
  assert.equal(verifiedPhone(claims), '+8801712345678');
  assert.equal(verifiedPhone(claims, 'sms'), '+8801712345678');
});

await test('a number the provider marks as NOT verified is never trusted', () => {
  const claims = { sub: 'sms|abc', phone_number: '+8801712345678', phone_number_verified: false };
  assert.equal(verifiedPhone(claims, 'sms'), undefined);
});

await test('with no flag, a sign-in through the phone connection is trusted: Auth0 sends no flag for it', () => {
  const claims = { sub: 'sms|65a1b2c3', phone_number: '+8801849726748' };
  assert.equal(verifiedPhone(claims, 'sms'), '+8801849726748');
});

await test('with no flag, any other sign-in method is not trusted, and neither is an unknown connection', () => {
  for (const sub of [
    'auth0|abc',
    'google-oauth2|123',
    'email|abc',
    'sms',
    'sms-other|abc',
    'xsms|abc',
  ]) {
    assert.equal(verifiedPhone({ sub, phone_number: '+8801712345678' }, 'sms'), undefined, sub);
  }
  // Without a configured phone connection nothing is assumed.
  assert.equal(verifiedPhone({ sub: 'sms|abc', phone_number: '+8801712345678' }), undefined);
});

await test('no phone claim, or one that is not text, means no phone', () => {
  assert.equal(verifiedPhone(undefined, 'sms'), undefined);
  assert.equal(verifiedPhone({ sub: 'sms|abc' }, 'sms'), undefined);
  for (const bad of [123, null, ['+8801712345678'], {}]) {
    assert.equal(verifiedPhone({ sub: 'sms|abc', phone_number: bad }, 'sms'), undefined);
  }
});
