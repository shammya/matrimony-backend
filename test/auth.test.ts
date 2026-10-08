import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { AuthProcess } from '../src/process/auth-process.js';
import { AccessTokens } from '../src/security/access-token.js';
import { digest } from '../src/security/secret-box.js';
import type { Session, SessionRepository } from '../src/cache/repository/session-repository.js';
import type { Hits, ThrottleRepository } from '../src/cache/repository/throttle-repository.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import { AppError } from '../src/exception/app-error.js';
import { agency, otherAgency, account, accountId } from './fixtures.js';

const login = { email: 'rahim@example.com', password: 'the right password' };
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function fixture(options: { accessTtl?: number; maxSessions?: number } = {}) {
  const tokens = new AccessTokens(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
  );
  const store = new Map<string, Session>();
  const accessIndex = new Map<string, string>();
  const limited: { accountId: string; max: number }[] = [];
  const sessions: Pick<
    SessionRepository,
    'put' | 'get' | 'forAccess' | 'remove' | 'claim' | 'finalize' | 'limit'
  > = {
    put: async (id, s) => {
      store.set(id, s);
      accessIndex.set(s.accessHash, id);
    },
    get: async (id) => store.get(id) ?? null,
    forAccess: async (hash) => {
      const session = store.get(accessIndex.get(hash) ?? '');
      return session?.accessHash === hash ? session : null;
    },
    remove: async (id) => {
      store.delete(id);
    },
    limit: async (accountId, max) => {
      limited.push({ accountId, max });
    },
    claim: async (id, csrf, agencyId, claim) => {
      const s = store.get(id);
      if (!s || s.claim || s.csrf !== csrf || s.agencyId !== agencyId) return null;
      store.set(id, { ...s, claim });
      return s;
    },
    finalize: async (id, claim, next) => {
      if (store.get(id)?.claim !== claim) return false;
      store.set(id, next);
      accessIndex.set(next.accessHash, id);
      return true;
    },
  };

  const counters = new Map<string, number>();
  const throttle: Pick<ThrottleRepository, 'peek' | 'hit' | 'clear'> = {
    peek: async (name): Promise<Hits> => ({ count: counters.get(name) ?? 0, retryAfter: 600 }),
    hit: async (name): Promise<Hits> => {
      counters.set(name, (counters.get(name) ?? 0) + 1);
      return { count: counters.get(name)!, retryAfter: 900 };
    },
    clear: async (name) => {
      counters.delete(name);
    },
  };

  const events: WorkflowEvent[] = [];
  const phoneChecks: { agencyId: string; phone: string }[] = [];
  let accountActive = true;
  let verify = async (_agency: string, _email: string, password: string) => {
    if (password !== login.password) throw new AppError(401, 'INVALID_CREDENTIALS');
    return account;
  };
  const auth = new AuthProcess(
    {
      verify: (agencyId, email, password) => verify(agencyId, email, password),
      verifyPhone: async (agencyId, phone, password) => {
        phoneChecks.push({ agencyId, phone });
        return verify(agencyId, phone, password);
      },
    },
    tokens,
    sessions,
    {
      account: async () => {
        if (!accountActive) throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
        return account;
      },
    },
    throttle,
    {
      record: async (event) => {
        events.push(event);
      },
    },
    {
      sessionTtl: 3600,
      accessTtl: options.accessTtl ?? 600,
      maxSessions: options.maxSessions ?? 10,
    },
  );
  return {
    auth,
    tokens,
    store,
    events,
    phoneChecks,
    limited,
    counters,
    setVerify: (fn: typeof verify) => {
      verify = fn;
    },
    disableAccount: () => {
      accountActive = false;
    },
    async signedIn() {
      const result = await auth.login(agency, login, 'req');
      return { ...result, key: digest(result.sessionId) };
    },
  };
}

await test('signing in starts a session and returns tokens that work at once', async () => {
  const f = fixture();
  const result = await f.auth.login(agency, login, 'req-1');
  assert.equal(result.sessionId.length, 43);
  assert.equal(result.csrfToken.length, 43);
  assert.ok(result.expiresIn > 0 && result.expiresIn <= 600);

  const session = f.store.get(digest(result.sessionId))!;
  assert.equal(session.agencyId, agency);
  assert.equal(session.accountId, accountId);
  assert.equal(session.accessHash, digest(result.accessToken));
  // The raw secrets are not stored: the session id and the access token only as hashes.
  assert.equal(JSON.stringify(session).includes(result.accessToken), false);
  assert.equal(JSON.stringify(session).includes(result.sessionId), false);

  assert.equal((await f.auth.authenticate(agency, result.accessToken)).id, accountId);
  assert.deepEqual(
    f.events.map((e) => e.type),
    ['auth.login'],
  );
  assert.equal(f.events[0]!.actorId, accountId);
});

await test('the session lasts its full time, not the access token time', async () => {
  const f = fixture();
  const { key } = await f.signedIn();
  const left = f.store.get(key)!.expiresAt - Date.now() / 1000;
  assert.ok(left > 3590 && left <= 3600);
});

await test('every sign-in gets a new session id and CSRF token', async () => {
  const f = fixture();
  const [a, b] = [await f.signedIn(), await f.signedIn()];
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.csrfToken, b.csrfToken);
  assert.notEqual(a.accessToken, b.accessToken);
});

await test('the number of sessions per account is capped after each sign-in', async () => {
  const f = fixture({ maxSessions: 3 });
  await f.signedIn();
  assert.deepEqual(f.limited, [{ accountId, max: 3 }]);
});

await test('five wrong passwords pause sign-in, even for the right password', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      () => f.auth.login(agency, { ...login, password: 'wrong' }, 'req'),
      code(401, 'INVALID_CREDENTIALS'),
    );
  await assert.rejects(
    () => f.auth.login(agency, login, 'req'),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 429 &&
      error.code === 'TOO_MANY_ATTEMPTS' &&
      error.details?.retryAfter === 600,
  );
  assert.equal(f.store.size, 0);
});

await test('four wrong passwords do not pause sign-in, and a right one clears the count', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => f.auth.login(agency, { ...login, password: 'wrong' }, 'req'));
  await f.auth.login(agency, login, 'req');
  assert.equal(f.counters.size, 0);
  // A fresh run of four more is still allowed.
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => f.auth.login(agency, { ...login, password: 'wrong' }, 'req'));
  await f.auth.login(agency, login, 'req');
});

await test('the count follows the email and the agency, not other people', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++)
    await assert.rejects(() => f.auth.login(agency, { ...login, password: 'wrong' }, 'req'));
  // Another email, and the same email at another agency, are not paused.
  await f.auth.login(agency, { ...login, email: 'other@example.com' }, 'req');
  await f.auth.login(otherAgency, login, 'req');
  assert.equal(f.counters.size, 1);
});

await test('only wrong passwords are counted: a disabled account or a system error is not', async () => {
  const f = fixture();
  f.setVerify(async () => {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
  });
  for (let i = 0; i < 8; i++)
    await assert.rejects(() => f.auth.login(agency, login, 'req'), code(403, 'ACCOUNT_NOT_ACTIVE'));
  f.setVerify(async () => {
    throw new Error('database down');
  });
  await assert.rejects(() => f.auth.login(agency, login, 'req'));
  assert.equal(f.counters.size, 0);
});

await test('a token established for one agency cannot be reused at another', async () => {
  const f = fixture();
  const { accessToken } = await f.signedIn();
  await assert.rejects(
    () => f.auth.authenticate(otherAgency, accessToken),
    code(401, 'SESSION_INVALID'),
  );
  assert.equal((await f.auth.authenticate(agency, accessToken)).id, accountId);
});

await test('a validly signed token with no live session behind it is refused', async () => {
  const f = fixture();
  const { token } = await f.tokens.issue(accountId, 600);
  await assert.rejects(() => f.auth.authenticate(agency, token), code(401, 'SESSION_INVALID'));
});

await test('a token is refused when its session names another account', async () => {
  const f = fixture();
  const { accessToken, key } = await f.signedIn();
  f.store.set(key, { ...f.store.get(key)!, accountId: '44444444-4444-4444-8444-444444444444' });
  await assert.rejects(
    () => f.auth.authenticate(agency, accessToken),
    code(401, 'SESSION_INVALID'),
  );
});

await test('a token is refused once its session has expired', async () => {
  const f = fixture();
  const { accessToken, key } = await f.signedIn();
  f.store.set(key, { ...f.store.get(key)!, expiresAt: Date.now() / 1000 - 1 });
  await assert.rejects(
    () => f.auth.authenticate(agency, accessToken),
    code(401, 'SESSION_INVALID'),
  );
});

await test('a disabled account is refused on the very next request, with no wait for expiry', async () => {
  const f = fixture();
  const { accessToken } = await f.signedIn();
  f.disableAccount();
  await assert.rejects(
    () => f.auth.authenticate(agency, accessToken),
    code(403, 'ACCOUNT_NOT_ACTIVE'),
  );
});

await test('refresh replaces the access token and keeps the absolute session expiry', async () => {
  const f = fixture();
  const first = await f.signedIn();
  const expiry = f.store.get(first.key)!.expiresAt;
  const next = await f.auth.refresh(agency, first.sessionId, first.csrfToken, 'req');
  assert.notEqual(next.accessToken, first.accessToken);
  assert.equal(next.csrfToken, first.csrfToken);
  assert.equal(f.store.get(first.key)!.expiresAt, expiry);
  assert.equal(f.store.get(first.key)!.claim, undefined);
  await assert.rejects(() => f.auth.authenticate(agency, first.accessToken));
  assert.equal((await f.auth.authenticate(agency, next.accessToken)).id, accountId);
});

await test('refresh needs the right CSRF token and agency', async () => {
  const f = fixture();
  const first = await f.signedIn();
  await assert.rejects(
    () => f.auth.refresh(agency, first.sessionId, 'wrong', 'req'),
    code(409, 'REFRESH_UNAVAILABLE'),
  );
  await assert.rejects(
    () => f.auth.refresh(otherAgency, first.sessionId, first.csrfToken, 'req'),
    code(409, 'REFRESH_UNAVAILABLE'),
  );
  assert.notEqual(f.store.get(first.key), undefined);
});

await test('two refreshes at once: only one goes through', async () => {
  const f = fixture();
  const first = await f.signedIn();
  const results = await Promise.allSettled([
    f.auth.refresh(agency, first.sessionId, first.csrfToken, 'req'),
    f.auth.refresh(agency, first.sessionId, first.csrfToken, 'req'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

await test('signing out while a refresh is running cannot bring the session back', async () => {
  const f = fixture();
  const first = await f.signedIn();
  const slow = new AuthProcess(
    { verify: async () => account, verifyPhone: async () => account },
    {
      verify: (token) => f.tokens.verify(token),
      issue: async (id, ttl) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return f.tokens.issue(id, ttl);
      },
    },
    {
      put: async () => {},
      get: async (id) => f.store.get(id) ?? null,
      forAccess: async () => null,
      remove: async (id) => {
        f.store.delete(id);
      },
      limit: async () => {},
      claim: async (id, csrf, agencyId, claim) => {
        const s = f.store.get(id);
        if (!s || s.claim || s.csrf !== csrf || s.agencyId !== agencyId) return null;
        f.store.set(id, { ...s, claim });
        return s;
      },
      finalize: async (id, claim, next) => {
        if (f.store.get(id)?.claim !== claim) return false;
        f.store.set(id, next);
        return true;
      },
    },
    { account: async () => account },
    {
      peek: async () => ({ count: 0, retryAfter: 1 }),
      hit: async () => ({ count: 1, retryAfter: 1 }),
      clear: async () => {},
    },
    { record: async () => {} },
    { sessionTtl: 3600, accessTtl: 600, maxSessions: 10 },
  );
  const refreshing = slow.refresh(agency, first.sessionId, first.csrfToken, 'req');
  await new Promise((resolve) => setImmediate(resolve));
  await f.auth.logout(agency, first.sessionId, first.csrfToken, 'req');
  await assert.rejects(() => refreshing, code(401, 'SESSION_INVALID'));
  assert.equal(f.store.get(first.key), undefined);
});

await test('a refresh that fails ends the session instead of retrying', async () => {
  const f = fixture();
  const first = await f.signedIn();
  f.disableAccount();
  await assert.rejects(() => f.auth.refresh(agency, first.sessionId, first.csrfToken, 'req'));
  assert.equal(f.store.get(first.key), undefined);
});

await test('refreshing an expired session ends it', async () => {
  const f = fixture();
  const first = await f.signedIn();
  f.store.set(first.key, { ...f.store.get(first.key)!, expiresAt: Date.now() / 1000 - 1 });
  await assert.rejects(
    () => f.auth.refresh(agency, first.sessionId, first.csrfToken, 'req'),
    code(401, 'SESSION_EXPIRED'),
  );
  assert.equal(f.store.get(first.key), undefined);
});

await test('bootstrap gives a fresh token set from the cookie alone, with the same CSRF token', async () => {
  const f = fixture();
  const first = await f.signedIn();
  const result = await f.auth.bootstrap(agency, first.sessionId, 'req');
  assert.equal(result.csrfToken, first.csrfToken);
  assert.notEqual(result.accessToken, first.accessToken);
  assert.equal((await f.auth.authenticate(agency, result.accessToken)).id, accountId);
  await assert.rejects(() => f.auth.authenticate(agency, first.accessToken));
});

await test('bootstrap refuses an unknown session, or one that belongs to another agency, and leaves it intact', async () => {
  const f = fixture();
  const first = await f.signedIn();
  await assert.rejects(
    () => f.auth.bootstrap(agency, 'x'.repeat(43), 'req'),
    code(401, 'SESSION_INVALID'),
  );
  await assert.rejects(
    () => f.auth.bootstrap(otherAgency, first.sessionId, 'req'),
    code(401, 'SESSION_INVALID'),
  );
  assert.notEqual(f.store.get(first.key), undefined);
  assert.equal(f.store.get(first.key)!.claim, undefined);
});

await test('signing out needs the CSRF token, ends the session and records it', async () => {
  const f = fixture();
  const first = await f.signedIn();
  await assert.rejects(
    () => f.auth.logout(agency, first.sessionId, 'wrong', 'req'),
    code(403, 'CSRF_INVALID'),
  );
  assert.notEqual(f.store.get(first.key), undefined);

  await f.auth.logout(agency, first.sessionId, first.csrfToken, 'req');
  assert.equal(f.store.get(first.key), undefined);
  await assert.rejects(() => f.auth.authenticate(agency, first.accessToken));
  assert.deepEqual(
    f.events.map((e) => e.type),
    ['auth.login', 'auth.logout'],
  );
  // Signing out twice is not an error.
  await f.auth.logout(agency, first.sessionId, first.csrfToken, 'req');
});

const phoneLogin = { phone: '+8801712345678', password: login.password };

await test('a phone number and its password sign in like an email and password do', async () => {
  const f = fixture();
  const result = await f.auth.login(agency, phoneLogin, 'req-phone');
  assert.equal(result.sessionId.length, 43);
  assert.deepEqual(f.phoneChecks, [{ agencyId: agency, phone: '+8801712345678' }]);
  assert.equal((await f.auth.authenticate(agency, result.accessToken)).id, account.id);
  assert.deepEqual(
    f.events.map((e) => [e.type, e.correlationId]),
    [['auth.login', 'req-phone']],
  );
});

await test('a wrong password for a number is a plain 401, and five of them pause that number', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      () => f.auth.login(agency, { ...phoneLogin, password: 'nope' }, 'r'),
      (error) => error instanceof AppError && error.status === 401,
    );
  // Now even the right password waits, and the check is not even run.
  const before = f.phoneChecks.length;
  await assert.rejects(
    () => f.auth.login(agency, phoneLogin, 'r'),
    (error) =>
      error instanceof AppError && error.status === 429 && error.code === 'TOO_MANY_ATTEMPTS',
  );
  assert.equal(f.phoneChecks.length, before);
});

await test("a number's pause is its own: it does not pause the email of the same person, and a good login clears it", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => f.auth.login(agency, { ...phoneLogin, password: 'nope' }, 'r'));
  // The email counter was never touched.
  assert.equal((await f.auth.login(agency, login, 'r')).sessionId.length, 43);
  // A right password clears the number's count, so four more wrong ones do not pause it.
  assert.equal((await f.auth.login(agency, phoneLogin, 'r')).sessionId.length, 43);
  for (let i = 0; i < 4; i++)
    await assert.rejects(() => f.auth.login(agency, { ...phoneLogin, password: 'nope' }, 'r'));
  assert.equal((await f.auth.login(agency, phoneLogin, 'r')).sessionId.length, 43);
});

await test('a disabled account is not signed in by phone either', async () => {
  const f = fixture();
  f.setVerify(async () => {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
  });
  await assert.rejects(
    () => f.auth.login(agency, phoneLogin, 'r'),
    (error) => error instanceof AppError && error.code === 'ACCOUNT_NOT_ACTIVE',
  );
});
