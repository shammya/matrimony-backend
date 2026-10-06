import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { AuthProcess } from '../src/process/auth-process.js';
import { SecretBox, digest } from '../src/security/secret-box.js';
import type { Session, SessionRepository } from '../src/cache/repository/session-repository.js';
import type { Tokens } from '../src/security/oidc-provider.js';
import { AppError } from '../src/exception/app-error.js';
import { agency, otherAgency, account, accountId } from './fixtures.js';
function fixture() {
  const id = 'browser-session';
  const csrf = 'csrf';
  const key = digest(id);
  const box = new SecretBox('ab'.repeat(32));
  let stored: Session | null = {
    agencyId: agency,
    subject: 'subject',
    issuer: 'https://issuer',
    accountId,
    refreshSecret: box.seal('old-refresh', key),
    accessHash: digest('old-access'),
    csrf,
    expiresAt: Date.now() / 1000 + 3600,
  };
  const sessions: Pick<
    SessionRepository,
    'put' | 'get' | 'forAccess' | 'remove' | 'claim' | 'finalize' | 'putChallenge' | 'takeChallenge'
  > = {
    put: async (_id, s) => {
      stored = s;
    },
    get: async () => stored,
    forAccess: async (hash) => (stored?.accessHash === hash ? stored : null),
    remove: async () => {
      stored = null;
    },
    putChallenge: async () => {},
    takeChallenge: async () => null,
    claim: async (_id, c, a, claim) => {
      if (!stored || stored.claim || stored.csrf !== c || stored.agencyId !== a) return null;
      const before = { ...stored };
      stored = { ...stored, claim };
      return before;
    },
    finalize: async (_id, claim, next) => {
      if (stored?.claim !== claim) return false;
      stored = next;
      return true;
    },
  };
  let refresh = async (): Promise<Tokens> => ({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
  });
  let refreshCalls = 0;
  let revokeCalls = 0;
  const auth = new AuthProcess(
    {
      authorize: async () => '',
      exchange: async () => ({ accessToken: '', refreshToken: '' }),
      refresh: async () => {
        refreshCalls++;
        return refresh();
      },
      revoke: async () => {
        revokeCalls++;
      },
    },
    {
      verify: async () => ({
        subject: 'subject',
        issuer: 'https://issuer',
        expiresAt: Date.now() / 1000 + 300,
      }),
    },
    sessions,
    { account: async () => account },
    {
      find: async () => ({ account, status: 'active' as const }),
      register: async () => account,
    },
    { record: async () => {} },
    box,
    3600,
    pino({ level: 'silent' }),
  );
  return {
    auth,
    id,
    csrf,
    stored: () => stored,
    clearSession: () => {
      stored = null;
    },
    refreshCalls: () => refreshCalls,
    revokeCalls: () => revokeCalls,
    setRefresh: (fn: typeof refresh) => {
      refresh = fn;
    },
  };
}
await test('a token established for one agency cannot be reused at another', async () => {
  const f = fixture();
  await assert.rejects(() => f.auth.authenticate(otherAgency, 'old-access'));
  assert.equal((await f.auth.authenticate(agency, 'old-access')).id, accountId);
});
await test('refresh replaces access mapping and retains absolute session expiry', async () => {
  const f = fixture();
  const expiry = f.stored()!.expiresAt;
  await f.auth.refresh(agency, f.id, f.csrf, 'request');
  assert.equal(f.stored()!.expiresAt, expiry);
  await assert.rejects(() => f.auth.authenticate(agency, 'old-access'));
  assert.equal((await f.auth.authenticate(agency, 'new-access')).id, accountId);
});
await test('only one concurrent refresh can reach the provider', async () => {
  const f = fixture();
  let complete!: (value: Tokens) => void;
  f.setRefresh(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const first = f.auth.refresh(agency, f.id, f.csrf, 'request');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => f.auth.refresh(agency, f.id, f.csrf, 'request'));
  complete({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  await first;
  assert.equal(f.refreshCalls(), 1);
});
await test('logout during refresh cannot resurrect a session', async () => {
  const f = fixture();
  let complete!: (value: Tokens) => void;
  f.setRefresh(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = f.auth.refresh(agency, f.id, f.csrf, 'request');
  await new Promise((resolve) => setImmediate(resolve));
  await f.auth.logout(agency, f.id, f.csrf, 'request');
  complete({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  await assert.rejects(() => pending);
  assert.equal(f.stored(), null);
  assert.equal(f.revokeCalls(), 2);
});
await test('ambiguous refresh failure invalidates the session without automatic retry', async () => {
  const f = fixture();
  f.setRefresh(async () => {
    throw new Error('timeout');
  });
  await assert.rejects(() => f.auth.refresh(agency, f.id, f.csrf, 'request'));
  assert.equal(f.stored(), null);
  assert.equal(f.refreshCalls(), 1);
});
await test('bootstrap issues a fresh token set from the stored session without a caller-supplied CSRF token', async () => {
  const f = fixture();
  const expiry = f.stored()!.expiresAt;
  const result = await f.auth.bootstrap(agency, f.id, 'request');
  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.csrfToken, f.csrf);
  assert.equal(f.stored()!.expiresAt, expiry);
  assert.equal(f.refreshCalls(), 1);
  await assert.rejects(() => f.auth.authenticate(agency, 'old-access'));
  assert.equal((await f.auth.authenticate(agency, 'new-access')).id, accountId);
});
await test('bootstrap rejects an unknown session without calling the provider', async () => {
  const f = fixture();
  f.clearSession();
  await assert.rejects(
    () => f.auth.bootstrap(agency, f.id, 'request'),
    (error: unknown) => error instanceof AppError && error.code === 'SESSION_INVALID',
  );
  assert.equal(f.refreshCalls(), 0);
});
await test('bootstrap cannot use a session that belongs to another agency and leaves it intact', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.auth.bootstrap(otherAgency, f.id, 'request'),
    (error: unknown) => error instanceof AppError && error.code === 'SESSION_INVALID',
  );
  assert.equal(f.refreshCalls(), 0);
  assert.notEqual(f.stored(), null);
  assert.equal(f.stored()!.claim, undefined);
});
await test('only one concurrent bootstrap can reach the provider', async () => {
  const f = fixture();
  let complete!: (value: Tokens) => void;
  f.setRefresh(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const first = f.auth.bootstrap(agency, f.id, 'request');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => f.auth.bootstrap(agency, f.id, 'request'),
    (error: unknown) => error instanceof AppError && error.code === 'REFRESH_UNAVAILABLE',
  );
  complete({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  await first;
  assert.equal(f.refreshCalls(), 1);
});
