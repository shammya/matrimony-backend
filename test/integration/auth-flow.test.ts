import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { migrate } from '../../scripts/migrate.js';
import { loadConfig } from '../../src/config/env.js';
import { buildApp } from '../../src/controller/app.js';
import { OneTimeTokenRepository } from '../../src/cache/repository/one-time-token-repository.js';
import { SessionRepository } from '../../src/cache/repository/session-repository.js';
import { ThrottleRepository } from '../../src/cache/repository/throttle-repository.js';
import { Database } from '../../src/db/config/database.js';
import { CredentialRepository } from '../../src/db/raw/repository/credential-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { IdentityRepository } from '../../src/db/raw/repository/identity-repository.js';
import { RegistrationRepository } from '../../src/db/raw/repository/registration-repository.js';
import { CredentialDbService } from '../../src/db/service/credential-db-service.js';
import { EventDbService } from '../../src/db/service/event-db-service.js';
import { IdentityDbService } from '../../src/db/service/identity-db-service.js';
import { RegistrationDbService } from '../../src/db/service/registration-db-service.js';
import type { MailMessage } from '../../src/mail/mailer.js';
import { AccountAccessProcess } from '../../src/process/account-access-process.js';
import { AuthProcess } from '../../src/process/auth-process.js';
import { AccessTokens, parseSigningKey } from '../../src/security/access-token.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { CredentialService } from '../../src/service/credential-service.js';
import { IdentityService } from '../../src/service/identity-service.js';
import { RegistrationService } from '../../src/service/registration-service.js';
import {
  agency,
  env,
  otherAgency,
  unusedClients,
  unusedPhotos,
  unusedProfiles,
  unusedReviews,
} from '../fixtures.js';

// The whole sign-in stack over HTTP, with real PostgreSQL and real Redis; only email is captured.
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');
if (!redisUrl) throw new Error('Set TEST_REDIS_URL to a Redis that is safe to write test keys to');

const strongPassword = 'a long and strong password';

await test('the whole email and password journey over HTTP', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,'test-one','localhost','Test one'),($2,'test-two','other.localhost','Test two') ON CONFLICT(id) DO NOTHING`,
    [agency, otherAgency],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const db = new Database(new Pool({ connectionString: runtimeUrl.href, max: 8 }));
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  // Cheap hashing keeps the run fast; the settings themselves are covered by their own tests.
  const hasher = new PasswordHasher({ memory: 64, passes: 1, parallelism: 1 });
  const config = loadConfig({
    ...env,
    MAX_SESSIONS_PER_ACCOUNT: '2',
    ACCESS_TOKEN_TTL_SECONDS: '600',
  });
  const mails: MailMessage[] = [];
  const sessions = new SessionRepository(redis);
  const throttle = new ThrottleRepository(redis);
  const credentials = new CredentialService(
    new CredentialDbService(db, new CredentialRepository(), new EventRepository()),
    hasher,
    pino({ level: 'silent' }),
  );
  const identities = new IdentityService(new IdentityDbService(db, new IdentityRepository()), {
    localhost: agency,
    'other.localhost': otherAgency,
  });
  const auth = new AuthProcess(
    credentials,
    new AccessTokens(parseSigningKey(config.AUTH_JWT_PRIVATE_KEY)),
    sessions,
    identities,
    throttle,
    new EventDbService(db, new EventRepository()),
    {
      sessionTtl: config.SESSION_TTL_SECONDS,
      accessTtl: config.ACCESS_TOKEN_TTL_SECONDS,
      maxSessions: config.MAX_SESSIONS_PER_ACCOUNT,
    },
  );
  const access = new AccountAccessProcess(
    new RegistrationService(
      new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
    ),
    credentials,
    new OneTimeTokenRepository(redis),
    throttle,
    sessions,
    {
      send: async (message) => {
        mails.push(message);
      },
    },
    new SecretBox(config.SESSION_ENCRYPTION_KEY),
    pino({ level: 'silent' }),
  );
  const app = await buildApp({
    config,
    logger: pino({ level: 'silent' }),
    redis,
    ready: async () => {},
    profiles: unusedProfiles,
    photos: unusedPhotos,
    reviews: unusedReviews,
    clients: unusedClients,
    identities,
    auth,
    access,
  });
  t.after(async () => {
    await app.close();
    await db.close();
    await admin.end();
    redis.disconnect();
  });

  const run = Date.now().toString(36) + randomUUID().slice(0, 4);
  const email = (name: string) => `${name}.${run}@example.com`;
  let visitor = 10;
  /** Each call is a visitor from its own address, so the per-address limits do not mix tests up. */
  const as = (host = 'localhost') => {
    const remoteAddress = `10.${Math.floor(visitor / 65536) % 256}.${Math.floor(visitor / 256) % 256}.${visitor++ % 256}`;
    return (
      method: 'GET' | 'POST',
      url: string,
      options: { body?: unknown; headers?: Record<string, string> } = {},
    ) =>
      app.inject({
        method,
        url,
        remoteAddress,
        ...(options.body === undefined ? {} : { payload: options.body as object }),
        headers: { host, origin: `http://${host}`, ...options.headers },
      });
  };
  const cookieValue = (response: { headers: Record<string, unknown> }) =>
    /matrimony-session=([^;]*)/.exec([response.headers['set-cookie']].flat().join(';'))?.[1] ?? '';
  const tokenIn = (message: MailMessage) =>
    /token=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1] ?? '';
  const settle = () => access.idle();
  const lastMail = (to: string) => mails.filter((m) => m.to === to).at(-1)!;

  const register = async (
    visit: ReturnType<typeof as>,
    name: string,
    password = strongPassword,
  ) => {
    const response = await visit('POST', '/api/v1/auth/register', {
      body: {
        email: email(name),
        password,
        displayName: `Member ${name}`,
        locale: 'en',
        acceptTerms: true,
        acceptPrivacy: true,
      },
    });
    await settle();
    return response;
  };
  const verify = async (visit: ReturnType<typeof as>, name: string) =>
    visit('POST', '/api/v1/auth/verify-email', { body: { token: tokenIn(lastMail(email(name))) } });
  const signUp = async (name: string, password = strongPassword) => {
    const visit = as();
    assert.equal((await register(visit, name, password)).statusCode, 202);
    assert.equal((await verify(visit, name)).statusCode, 200);
  };
  const logIn = (visit: ReturnType<typeof as>, name: string, password = strongPassword) =>
    visit('POST', '/api/v1/auth/login', { body: { email: email(name), password } });
  const me = (visit: ReturnType<typeof as>, token: string) =>
    visit('GET', '/api/v1/me', { headers: { authorization: `Bearer ${token}` } });

  await t.test('register, open the link, sign in, use the API, refresh, sign out', async () => {
    const visit = as();
    const registered = await register(visit, 'journey');
    assert.equal(registered.statusCode, 202);
    // Nothing exists until the link is opened: signing in fails.
    assert.equal((await logIn(visit, 'journey')).statusCode, 401);

    assert.equal((await verify(visit, 'journey')).statusCode, 200);
    const signedIn = await logIn(visit, 'journey');
    assert.equal(signedIn.statusCode, 200);
    const { accessToken, csrfToken } = signedIn.json();
    const session = cookieValue(signedIn);
    assert.equal(session.length, 43);

    const profile = await me(visit, accessToken);
    assert.equal(profile.statusCode, 200);
    assert.deepEqual(Object.keys(profile.json()).sort(), ['agencyId', 'displayName', 'id', 'role']);
    assert.equal(profile.json().role, 'member');
    assert.equal(profile.json().displayName, 'Member journey');

    // A reload: the cookie alone brings back a working token set.
    const restored = await visit('POST', '/api/v1/auth/session', {
      headers: { cookie: `matrimony-session=${session}` },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().csrfToken, csrfToken);
    assert.equal((await me(visit, restored.json().accessToken)).statusCode, 200);
    assert.equal((await me(visit, accessToken)).statusCode, 401);

    const refreshed = await visit('POST', '/api/v1/auth/refresh', {
      headers: { cookie: `matrimony-session=${session}`, 'x-csrf-token': csrfToken },
    });
    assert.equal(refreshed.statusCode, 200);
    assert.equal((await me(visit, refreshed.json().accessToken)).statusCode, 200);
    assert.equal((await me(visit, restored.json().accessToken)).statusCode, 401);

    const wrongCsrf = await visit('POST', '/api/v1/auth/logout', {
      headers: { cookie: `matrimony-session=${session}`, 'x-csrf-token': 'x'.repeat(43) },
    });
    assert.equal(wrongCsrf.statusCode, 403);
    assert.equal((await me(visit, refreshed.json().accessToken)).statusCode, 200);

    const out = await visit('POST', '/api/v1/auth/logout', {
      headers: { cookie: `matrimony-session=${session}`, 'x-csrf-token': csrfToken },
    });
    assert.equal(out.statusCode, 204);
    assert.equal((await me(visit, refreshed.json().accessToken)).statusCode, 401);
    const gone = await visit('POST', '/api/v1/auth/session', {
      headers: { cookie: `matrimony-session=${session}` },
    });
    assert.equal(gone.statusCode, 401);
  });

  await t.test(
    'the account stores nothing in plain text, and the audit trail has ids only',
    async () => {
      await signUp('stored');
      const row = await admin.query(
        `SELECT a.id, c.password_hash FROM matrimony.accounts a JOIN matrimony.account_credentials c ON c.account_id=a.id WHERE a.email=$1`,
        [email('stored')],
      );
      assert.match(row.rows[0].password_hash, /^\$argon2id\$/);
      assert.equal(row.rows[0].password_hash.includes(strongPassword), false);
      const events = await admin.query(
        `SELECT event FROM matrimony.event_outbox WHERE event->>'subjectId'=$1`,
        [row.rows[0].id],
      );
      assert.deepEqual(
        events.rows.map((r) => r.event.type),
        ['account.registered'],
      );
      assert.equal(JSON.stringify(events.rows).includes(email('stored')), false);
    },
  );

  await t.test(
    'registering an email that has an account looks identical and creates nothing',
    async () => {
      await signUp('twice');
      const before = (
        await admin.query(`SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1`, [
          email('twice'),
        ])
      ).rows[0].n;
      const fresh = await register(as(), 'brandnew');
      const again = await register(as(), 'twice', 'someone elses password');
      assert.equal(again.statusCode, fresh.statusCode);
      assert.equal(again.body, fresh.body);
      assert.equal(
        (
          await admin.query(`SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1`, [
            email('twice'),
          ])
        ).rows[0].n,
        before,
      );
      // The owner is told, and no link is sent.
      assert.match(lastMail(email('twice')).text, /already has an account/);
      assert.equal(tokenIn(lastMail(email('twice'))), '');
      // The first password still works and the second does not.
      assert.equal((await logIn(as(), 'twice')).statusCode, 200);
      assert.equal((await logIn(as(), 'twice', 'someone elses password')).statusCode, 401);
    },
  );

  await t.test('an emailed link works once, and not at another agency', async () => {
    const visit = as();
    await register(visit, 'onelink');
    const token = tokenIn(lastMail(email('onelink')));
    const elsewhere = await as('other.localhost')('POST', '/api/v1/auth/verify-email', {
      body: { token },
    });
    assert.equal(elsewhere.statusCode, 400);
    assert.equal(
      (await visit('POST', '/api/v1/auth/verify-email', { body: { token } })).statusCode,
      200,
    );
    const reused = await visit('POST', '/api/v1/auth/verify-email', { body: { token } });
    assert.equal(reused.statusCode, 400);
    assert.equal(reused.json().error.code, 'LINK_INVALID_OR_EXPIRED');
  });

  await t.test('wrong passwords look the same for every kind of failure', async () => {
    await signUp('same');
    const wrong = await logIn(as(), 'same', 'definitely wrong');
    const unknown = await logIn(as(), 'nobody-here', 'definitely wrong');
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(JSON.parse(wrong.body).error.code, JSON.parse(unknown.body).error.code);
    assert.deepEqual(Object.keys(wrong.json().error), Object.keys(unknown.json().error));
  });

  await t.test(
    'five wrong passwords pause sign-in for that email, even for the right password',
    async () => {
      await signUp('pause');
      for (let i = 0; i < 5; i++)
        assert.equal((await logIn(as(), 'pause', 'wrong password!')).statusCode, 401);
      const paused = await logIn(as(), 'pause');
      assert.equal(paused.statusCode, 429);
      assert.equal(paused.json().error.code, 'TOO_MANY_ATTEMPTS');
      assert.ok(Number(paused.headers['retry-after']) > 0);
      assert.equal(cookieValue(paused), '');
      // Another email is not affected.
      await signUp('nopause');
      assert.equal((await logIn(as(), 'nopause')).statusCode, 200);
    },
  );

  await t.test(
    'forgotten password: a link, a new password, and every old session ends',
    async () => {
      await signUp('forgot');
      const phone = as();
      const first = await logIn(phone, 'forgot');
      const thief = await logIn(as(), 'forgot');
      assert.equal((await me(phone, first.json().accessToken)).statusCode, 200);

      const asked = await as()('POST', '/api/v1/auth/password/forgot', {
        body: { email: email('forgot') },
      });
      assert.equal(asked.statusCode, 202);
      await settle();
      const link = lastMail(email('forgot'));
      assert.match(link.text, /\/en\/reset-password\?token=/);

      const weak = await as()('POST', '/api/v1/auth/password/reset', {
        body: { token: tokenIn(link), password: 'password123' },
      });
      assert.equal(weak.statusCode, 400);
      // A refused password does not use up the link.
      const reset = await as()('POST', '/api/v1/auth/password/reset', {
        body: { token: tokenIn(link), password: 'my new strong password' },
      });
      assert.equal(reset.statusCode, 200);
      await settle();

      assert.equal((await me(phone, first.json().accessToken)).statusCode, 401);
      assert.equal((await me(phone, thief.json().accessToken)).statusCode, 401);
      assert.equal((await logIn(as(), 'forgot')).statusCode, 401);
      assert.equal((await logIn(as(), 'forgot', 'my new strong password')).statusCode, 200);
      assert.match(lastMail(email('forgot')).text, /was just changed/);

      const reused = await as()('POST', '/api/v1/auth/password/reset', {
        body: { token: tokenIn(link), password: 'yet another password' },
      });
      assert.equal(reused.statusCode, 400);
    },
  );

  await t.test(
    'asking for a reset for an unknown email answers the same and sends nothing',
    async () => {
      const known = await as()('POST', '/api/v1/auth/password/forgot', {
        body: { email: email('forgot') },
      });
      const sent = mails.length;
      const unknown = await as()('POST', '/api/v1/auth/password/forgot', {
        body: { email: email('no-such-account') },
      });
      await settle();
      assert.equal(unknown.statusCode, known.statusCode);
      assert.equal(unknown.body, known.body);
      assert.equal(mails.length, sent);
    },
  );

  await t.test('another agency has its own accounts, even for the same email', async () => {
    await signUp('tenant');
    const other = as('other.localhost');
    const attempt = await other('POST', '/api/v1/auth/login', {
      body: { email: email('tenant'), password: strongPassword },
    });
    assert.equal(attempt.statusCode, 401);
    // A token from one agency is useless at another.
    const signedIn = await logIn(as(), 'tenant');
    assert.equal((await me(other, signedIn.json().accessToken)).statusCode, 401);
    assert.equal((await me(as(), signedIn.json().accessToken)).statusCode, 200);
  });

  await t.test('a disabled account is cut off on its next request', async () => {
    await signUp('disabled');
    const visit = as();
    const signedIn = await logIn(visit, 'disabled');
    assert.equal((await me(visit, signedIn.json().accessToken)).statusCode, 200);
    await admin.query(`UPDATE matrimony.accounts SET status='disabled' WHERE email=$1`, [
      email('disabled'),
    ]);
    assert.equal((await me(visit, signedIn.json().accessToken)).statusCode, 403);
    const again = await logIn(as(), 'disabled');
    assert.equal(again.statusCode, 403);
    assert.equal(again.json().error.code, 'ACCOUNT_NOT_ACTIVE');
    const wrong = await logIn(as(), 'disabled', 'not the password');
    assert.equal(wrong.statusCode, 401);
  });

  await t.test(
    'only the newest sessions are kept when an account signs in on many devices',
    async () => {
      await signUp('devices');
      const [one, two, three] = [as(), as(), as()];
      const a = await logIn(one, 'devices');
      const b = await logIn(two, 'devices');
      assert.equal((await me(one, a.json().accessToken)).statusCode, 200);
      const c = await logIn(three, 'devices');
      // The limit in this test is two: the oldest device is signed out.
      assert.equal((await me(one, a.json().accessToken)).statusCode, 401);
      assert.equal((await me(two, b.json().accessToken)).statusCode, 200);
      assert.equal((await me(three, c.json().accessToken)).statusCode, 200);
    },
  );

  await t.test('a forged or foreign request is refused', async () => {
    await signUp('forged');
    const visit = as();
    const wrongSite = await visit('POST', '/api/v1/auth/login', {
      body: { email: email('forged'), password: strongPassword },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(wrongSite.statusCode, 403);
    const noToken = await visit('GET', '/api/v1/me');
    assert.equal(noToken.statusCode, 401);
    const garbage = await me(visit, 'not.a.token');
    assert.equal(garbage.statusCode, 401);
    // A well-formed token signed with another key is refused.
    const { generateKeyPairSync } = await import('node:crypto');
    const foreign = await new AccessTokens(
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
    ).issue(randomUUID(), 600);
    assert.equal((await me(visit, foreign.token)).statusCode, 401);
  });
});
