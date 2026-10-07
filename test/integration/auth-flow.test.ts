import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { migrate } from '../../scripts/migrate.js';
import { AppError } from '../../src/exception/app-error.js';
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
import { GoogleAuthProcess } from '../../src/process/google-auth-process.js';
import { PhoneAuthProcess } from '../../src/process/phone-auth-process.js';
import { PhoneCodeRepository } from '../../src/cache/repository/phone-code-repository.js';
import type { SmsMessage } from '../../src/sms/sender.js';
import type { GoogleIdentityProvider, GoogleProfile } from '../../src/security/google-provider.js';
import { AuthProcess } from '../../src/process/auth-process.js';
import { AccessTokens, parseSigningKey } from '../../src/security/access-token.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { SecretBox, digest } from '../../src/security/secret-box.js';
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
  const registrations = new RegistrationService(
    new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
  );
  const oneTimeTokens = new OneTimeTokenRepository(redis);
  // Google itself cannot be reached from a test: a person is signed in "at Google" by setting who
  // they are. Everything of ours (the attempt, the cookies, the accounts, the sessions) is real.
  let googleProfile: GoogleProfile | Error = {
    subject: 'google-default',
    email: 'default@example.com',
    emailVerified: true,
    name: 'Default Person',
  };
  const fakeGoogle: GoogleIdentityProvider = {
    authorize: async (attempt) => `https://accounts.google.example/auth?state=${attempt.state}`,
    exchange: async () => {
      if (googleProfile instanceof Error) throw googleProfile;
      return googleProfile;
    },
  };
  const google = new GoogleAuthProcess(
    fakeGoogle,
    sessions,
    oneTimeTokens,
    registrations,
    credentials,
    auth,
    new SecretBox(config.SESSION_ENCRYPTION_KEY),
    pino({ level: 'silent' }),
  );
  // Text messages are captured, so a test reads the code the way a person would. Everything else
  // (the codes in Redis, the accounts, the sessions) is real.
  const texts: SmsMessage[] = [];
  const phone = new PhoneAuthProcess(
    {
      send: async (message) => {
        texts.push(message);
      },
    },
    new PhoneCodeRepository(redis),
    throttle,
    oneTimeTokens,
    registrations,
    auth,
    new SecretBox(config.SESSION_ENCRYPTION_KEY),
    pino({ level: 'silent' }),
  );
  const access = new AccountAccessProcess(
    registrations,
    credentials,
    oneTimeTokens,
    throttle,
    sessions,
    auth,
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
    google,
    phone,
    registrations,
  });
  t.after(async () => {
    await app.close();
    await db.close();
    await admin.end();
    redis.disconnect();
  });

  const run = Date.now().toString(36) + randomUUID().slice(0, 4);
  const email = (name: string) => `${name}.${run}@example.com`;
  // A random start, because the address limits live in Redis and outlast a test run.
  let visitor = 10 + Math.floor(Math.random() * 3_000_000);
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
  const cookieFrom = (response: { headers: Record<string, unknown> }, name: string) =>
    new RegExp(name + '=([^;]*)').exec([response.headers['set-cookie']].flat().join(';'))?.[1] ??
    '';
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
        ['account.registered', 'auth.login'],
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
    const opened = await visit('POST', '/api/v1/auth/verify-email', { body: { token } });
    assert.equal(opened.statusCode, 200);
    // Confirming the address also signs the person in, like a login.
    assert.equal(cookieFrom(opened, 'matrimony-session').length, 43);
    const profile = await me(visit, opened.json().accessToken);
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().role, 'member');
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

  // ---- sign in with Google ----
  const person = (name: string, over: Partial<GoogleProfile> = {}): GoogleProfile => ({
    subject: `sub-${name}-${run}`,
    email: email(name),
    emailVerified: true,
    name: `Person ${name}`,
    ...over,
  });
  /** Start at our site, "go to Google" and come back, carrying only the cookie we set. */
  async function viaGoogle(
    visit: ReturnType<typeof as>,
    who: GoogleProfile | Error,
    intent: 'login' | 'register' = 'login',
  ) {
    googleProfile = who;
    const started = await visit('POST', '/api/v1/auth/google/start', {
      body: { intent, locale: 'en', acceptTerms: true, acceptPrivacy: true },
    });
    assert.equal(started.statusCode, 200, started.body);
    const challenge = cookieFrom(started, 'matrimony-challenge');
    assert.equal(challenge.length, 43);
    return visit('GET', '/api/v1/auth/google/callback?code=c&state=s', {
      headers: { cookie: `matrimony-challenge=${challenge}` },
    });
  }
  /** The tokens of a session that a redirect just set the cookie for, as the page asks for them. */
  async function tokensFor(
    visit: ReturnType<typeof as>,
    response: { headers: Record<string, unknown> },
  ) {
    const session = cookieFrom(response, 'matrimony-session');
    assert.equal(session.length, 43);
    const restored = await visit('POST', '/api/v1/auth/session', {
      headers: { cookie: `matrimony-session=${session}` },
    });
    assert.equal(restored.statusCode, 200);
    return restored.json();
  }

  await t.test('Google: register, then sign in again, with the same account', async () => {
    const visit = as();
    const registered = await viaGoogle(visit, person('gnew'), 'register');
    assert.equal(registered.statusCode, 302);
    assert.equal(registered.headers.location, '/en/dashboard');
    const { accessToken } = await tokensFor(visit, registered);
    const profile = await me(visit, accessToken);
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().role, 'member');
    assert.equal(profile.json().displayName, 'Person gnew');

    // A later sign-in with Google reaches the same account, and no second one exists.
    const again = await viaGoogle(as(), person('gnew'), 'login');
    assert.equal(again.headers.location, '/en/dashboard');
    const second = await tokensFor(as(), again);
    assert.equal((await me(as(), second.accessToken)).json().id, profile.json().id);
    const accounts = await admin.query(
      'SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1',
      [email('gnew')],
    );
    assert.equal(accounts.rows[0].n, 1);
  });

  await t.test(
    'Google: the account has no password, and "forgot password" can give it one',
    async () => {
      const visit = as();
      await viaGoogle(visit, person('gpass'), 'register');
      const row = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.account_credentials c JOIN matrimony.accounts a ON a.id=c.account_id WHERE a.email=$1',
        [email('gpass')],
      );
      assert.equal(row.rows[0].n, 0);
      assert.equal((await logIn(as(), 'gpass', 'any password at all')).statusCode, 401);

      await as()('POST', '/api/v1/auth/password/forgot', { body: { email: email('gpass') } });
      await settle();
      const reset = await as()('POST', '/api/v1/auth/password/reset', {
        body: { token: tokenIn(lastMail(email('gpass'))), password: 'a password set later on' },
      });
      assert.equal(reset.statusCode, 200);
      assert.equal((await logIn(as(), 'gpass', 'a password set later on')).statusCode, 200);
      // And Google still works for the same account.
      const again = await viaGoogle(as(), person('gpass'));
      assert.equal(again.headers.location, '/en/dashboard');
    },
  );

  await t.test(
    'Google: a login with no account creates nothing until the terms are agreed to, then creates it',
    async () => {
      const visit = as();
      const response = await viaGoogle(
        visit,
        person('gnone', { name: 'Nina From Google' }),
        'login',
      );
      // No account and no session yet: the person is asked to agree first.
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, '/en/signup-google');
      assert.equal(cookieFrom(response, 'matrimony-session'), '');
      const signup = cookieFrom(response, 'matrimony-signup');
      assert.equal(signup.length, 43);
      const cookie = { cookie: `matrimony-signup=${signup}` };
      const none = () =>
        admin.query('SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1', [
          email('gnone'),
        ]);
      assert.equal((await none()).rows[0].n, 0);

      // The page is told who Google says this is, and nothing else.
      const pending = await visit('GET', '/api/v1/auth/google/signup', { headers: cookie });
      assert.deepEqual(pending.json(), { email: email('gnone'), name: 'Nina From Google' });

      // Without the agreements nothing is created, and the step stays open.
      const refused = await visit('POST', '/api/v1/auth/google/signup', {
        body: {},
        headers: cookie,
      });
      assert.equal(refused.statusCode, 400);
      assert.equal((await none()).rows[0].n, 0);

      // Agreeing creates the member (no password) from Google's name and email, and signs in.
      const agreed = await visit('POST', '/api/v1/auth/google/signup', {
        body: { acceptTerms: true, acceptPrivacy: true },
        headers: cookie,
      });
      assert.equal(agreed.statusCode, 200);
      assert.equal(cookieFrom(agreed, 'matrimony-session').length, 43);
      const profile = await me(visit, agreed.json().accessToken);
      assert.equal(profile.statusCode, 200);
      assert.equal(profile.json().role, 'member');
      assert.equal(profile.json().displayName, 'Nina From Google');

      const row = await admin.query(
        `SELECT a.id, (SELECT count(*)::int FROM matrimony.account_credentials c WHERE c.account_id=a.id) AS passwords,
              (SELECT count(*)::int FROM matrimony.account_identities i WHERE i.account_id=a.id) AS identities,
              (SELECT count(*)::int FROM matrimony.consent_events e WHERE e.account_id=a.id) AS consents
       FROM matrimony.accounts a WHERE a.email=$1`,
        [email('gnone')],
      );
      assert.equal(row.rows.length, 1);
      assert.deepEqual(
        {
          passwords: row.rows[0].passwords,
          identities: row.rows[0].identities,
          consents: row.rows[0].consents,
        },
        { passwords: 0, identities: 1, consents: 2 },
      );

      // The step is spent: pressing again cannot create a second account.
      const again = await visit('POST', '/api/v1/auth/google/signup', {
        body: { acceptTerms: true, acceptPrivacy: true },
        headers: cookie,
      });
      assert.equal(again.statusCode, 400);
      assert.equal((await none()).rows[0].n, 1);

      // And from now on, Google signs in directly.
      const next = await viaGoogle(as(), person('gnone'), 'login');
      assert.equal(next.headers.location, '/en/dashboard');
    },
  );

  await t.test(
    'Google: the agree-and-create step belongs to the agency it started at, and is never taken from the request',
    async () => {
      const visit = as();
      const response = await viaGoogle(
        visit,
        person('gscope', { name: 'Real Google Name' }),
        'login',
      );
      const signup = cookieFrom(response, 'matrimony-signup');
      const cookie = { cookie: `matrimony-signup=${signup}` };
      const elsewhere = await as('other.localhost')('POST', '/api/v1/auth/google/signup', {
        body: { acceptTerms: true, acceptPrivacy: true },
        headers: cookie,
      });
      assert.equal(elsewhere.statusCode, 400);
      // Names, emails and roles in the request are refused; the account uses what Google said.
      const sneaky = await visit('POST', '/api/v1/auth/google/signup', {
        body: {
          acceptTerms: true,
          acceptPrivacy: true,
          email: 'someone.else@example.com',
          role: 'admin',
        },
        headers: cookie,
      });
      assert.equal(sneaky.statusCode, 400);
      const created = await visit('POST', '/api/v1/auth/google/signup', {
        body: { acceptTerms: true, acceptPrivacy: true },
        headers: cookie,
      });
      assert.equal(created.statusCode, 200);
      const profile = await me(visit, created.json().accessToken);
      assert.equal(profile.json().displayName, 'Real Google Name');
      assert.equal(profile.json().role, 'member');
      const rows = await admin.query('SELECT email FROM matrimony.accounts WHERE email=ANY($1)', [
        [email('gscope'), 'someone.else@example.com'],
      ]);
      assert.deepEqual(
        rows.rows.map((r) => r.email),
        [email('gscope')],
      );
    },
  );

  await t.test(
    'Google: an address that got an account while the step was open is not given a second one',
    async () => {
      const visit = as();
      const response = await viaGoogle(visit, person('graced'), 'login');
      const cookie = { cookie: `matrimony-signup=${cookieFrom(response, 'matrimony-signup')}` };
      await signUp('graced');
      const late = await visit('POST', '/api/v1/auth/google/signup', {
        body: { acceptTerms: true, acceptPrivacy: true },
        headers: cookie,
      });
      assert.equal(late.statusCode, 409);
      assert.equal(late.json().error.code, 'GOOGLE_RETRY');
      assert.equal(cookieFrom(late, 'matrimony-session'), '');
      const rows = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1',
        [email('graced')],
      );
      assert.equal(rows.rows[0].n, 1);
      const identities = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.account_identities WHERE provider_subject=$1',
        [`sub-graced-${run}`],
      );
      assert.equal(identities.rows[0].n, 0);
    },
  );

  await t.test('Google: an email Google has not confirmed is refused everywhere', async () => {
    await signUp('gunv');
    for (const intent of ['login', 'register'] as const) {
      const response = await viaGoogle(as(), person('gunv', { emailVerified: false }), intent);
      assert.equal(response.headers.location, '/en/login?error=GOOGLE_EMAIL_UNVERIFIED');
      assert.equal(cookieFrom(response, 'matrimony-session'), '');
      assert.equal(cookieFrom(response, 'matrimony-link'), '');
    }
    const fresh = await viaGoogle(as(), person('gunv2', { emailVerified: false }), 'register');
    assert.equal(fresh.headers.location, '/en/login?error=GOOGLE_EMAIL_UNVERIFIED');
    const rows = await admin.query(
      'SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1',
      [email('gunv2')],
    );
    assert.equal(rows.rows[0].n, 0);
  });

  await t.test(
    'Google: it is never attached to an existing account by the email alone',
    async () => {
      await signUp('gtake', 'the real owners password');
      const attacker = as();
      const response = await viaGoogle(
        attacker,
        person('gtake', { subject: `sub-attacker-${run}` }),
        'login',
      );
      // Not signed in, and nothing linked: the person is asked for the account's password.
      assert.equal(response.headers.location, '/en/link-google');
      assert.equal(cookieFrom(response, 'matrimony-session'), '');
      const link = cookieFrom(response, 'matrimony-link');
      assert.equal(link.length, 43);
      const identities = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.account_identities i JOIN matrimony.accounts a ON a.id=i.account_id WHERE a.email=$1',
        [email('gtake')],
      );
      assert.equal(identities.rows[0].n, 0);

      const pending = await attacker('GET', '/api/v1/auth/google/pending', {
        headers: { cookie: `matrimony-link=${link}` },
      });
      assert.deepEqual(pending.json(), { email: email('gtake') });

      // The attacker does not know the password: refused, still not linked, and signed in nowhere.
      const wrong = await attacker('POST', '/api/v1/auth/google/link', {
        body: { password: 'a guess' },
        headers: { cookie: `matrimony-link=${link}` },
      });
      assert.equal(wrong.statusCode, 401);
      assert.equal(cookieFrom(wrong, 'matrimony-session'), '');
      const afterWrong = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.account_identities i JOIN matrimony.accounts a ON a.id=i.account_id WHERE a.email=$1',
        [email('gtake')],
      );
      assert.equal(afterWrong.rows[0].n, 0);
    },
  );

  await t.test(
    'Google: the owner approves the link with the password, then both ways work',
    async () => {
      await signUp('glink', 'the owners password');
      const visit = as();
      const response = await viaGoogle(visit, person('glink'), 'login');
      const link = cookieFrom(response, 'matrimony-link');
      const approved = await visit('POST', '/api/v1/auth/google/link', {
        body: { password: 'the owners password' },
        headers: { cookie: `matrimony-link=${link}` },
      });
      assert.equal(approved.statusCode, 200);
      const { accessToken } = approved.json();
      assert.equal((await me(visit, accessToken)).statusCode, 200);
      assert.equal((await me(visit, accessToken)).json().displayName, 'Member glink');

      // The link step cannot be used a second time.
      const reused = await visit('POST', '/api/v1/auth/google/link', {
        body: { password: 'the owners password' },
        headers: { cookie: `matrimony-link=${link}` },
      });
      assert.equal(reused.statusCode, 400);

      // Now Google signs in directly, to the same account, and the password still works.
      const direct = await viaGoogle(as(), person('glink'), 'login');
      assert.equal(direct.headers.location, '/en/dashboard');
      const second = await tokensFor(as(), direct);
      assert.equal(
        (await me(as(), second.accessToken)).json().id,
        (await me(visit, accessToken)).json().id,
      );
      assert.equal((await logIn(as(), 'glink', 'the owners password')).statusCode, 200);
      const events = await admin.query(
        "SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'type'='auth.identity_linked' AND event->>'subjectId'=(SELECT id::text FROM matrimony.accounts WHERE email=$1)",
        [email('glink')],
      );
      assert.equal(events.rows[0].n, 1);
    },
  );

  await t.test(
    'Google: wrong passwords at the link step share the same pause as signing in',
    async () => {
      await signUp('gpause', 'the owners password');
      const visit = as();
      const response = await viaGoogle(visit, person('gpause'), 'login');
      const link = cookieFrom(response, 'matrimony-link');
      for (let i = 0; i < 5; i++) {
        const wrong = await as()('POST', '/api/v1/auth/google/link', {
          body: { password: 'wrong guess' },
          headers: { cookie: `matrimony-link=${link}` },
        });
        assert.equal(wrong.statusCode, 401);
      }
      // Even the right password is refused during the pause, here and at the ordinary sign-in.
      const paused = await as()('POST', '/api/v1/auth/google/link', {
        body: { password: 'the owners password' },
        headers: { cookie: `matrimony-link=${link}` },
      });
      assert.equal(paused.statusCode, 429);
      assert.equal((await logIn(as(), 'gpause', 'the owners password')).statusCode, 429);
    },
  );

  await t.test(
    'Google: an account with no password cannot be linked, and a disabled one cannot sign in',
    async () => {
      await viaGoogle(as(), person('gonly'), 'register');
      const other = await viaGoogle(
        as(),
        person('gonly', { subject: `sub-other-${run}` }),
        'login',
      );
      assert.equal(other.headers.location, '/en/login?error=ACCOUNT_HAS_NO_PASSWORD');

      await admin.query("UPDATE matrimony.accounts SET status='disabled' WHERE email=$1", [
        email('gonly'),
      ]);
      const blocked = await viaGoogle(as(), person('gonly'), 'login');
      assert.equal(blocked.headers.location, '/en/login?error=ACCOUNT_NOT_ACTIVE');
      assert.equal(cookieFrom(blocked, 'matrimony-session'), '');
    },
  );

  await t.test(
    'Google: a failed or cancelled sign-in goes back to login, and an attempt cannot be replayed',
    async () => {
      const failed = await viaGoogle(as(), new AppError(401, 'GOOGLE_AUTH_FAILED'), 'login');
      assert.equal(failed.headers.location, '/en/login?error=GOOGLE_AUTH_FAILED');

      const visit = as();
      googleProfile = person('greplay');
      const started = await visit('POST', '/api/v1/auth/google/start', {
        body: { intent: 'register', locale: 'bn', acceptTerms: true, acceptPrivacy: true },
      });
      const challenge = cookieFrom(started, 'matrimony-challenge');
      const cookie = `matrimony-challenge=${challenge}`;
      const first = await visit('GET', '/api/v1/auth/google/callback?code=c&state=s', {
        headers: { cookie },
      });
      assert.equal(first.headers.location, '/bn/dashboard');
      const replay = await visit('GET', '/api/v1/auth/google/callback?code=c&state=s', {
        headers: { cookie },
      });
      assert.equal(replay.headers.location, '/bn/login?error=OAUTH_CHALLENGE_EXPIRED');
      assert.equal(cookieFrom(replay, 'matrimony-session'), '');
      const accounts = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1',
        [email('greplay')],
      );
      assert.equal(accounts.rows[0].n, 1);
    },
  );

  await t.test(
    'Google: an attempt started at one agency cannot be finished at another',
    async () => {
      const visit = as();
      googleProfile = person('gtenant');
      const started = await visit('POST', '/api/v1/auth/google/start', {
        body: { intent: 'register', locale: 'bn', acceptTerms: true, acceptPrivacy: true },
      });
      const cookie = `matrimony-challenge=${cookieFrom(started, 'matrimony-challenge')}`;
      const elsewhere = await as('other.localhost')(
        'GET',
        '/api/v1/auth/google/callback?code=c&state=s',
        { headers: { cookie } },
      );
      assert.equal(elsewhere.headers.location, '/bn/login?error=OAUTH_CONTEXT_MISMATCH');
      const rows = await admin.query(
        'SELECT count(*)::int AS n FROM matrimony.accounts WHERE email=$1',
        [email('gtenant')],
      );
      assert.equal(rows.rows[0].n, 0);
    },
  );

  await t.test(
    'Google: registering needs the agreements, checked before leaving for Google',
    async () => {
      const visit = as();
      const missing = await visit('POST', '/api/v1/auth/google/start', {
        body: { intent: 'register', locale: 'bn' },
      });
      assert.equal(missing.statusCode, 400);
      assert.equal(cookieFrom(missing, 'matrimony-challenge'), '');
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

  // ---- sign in and register with a phone number ----
  const numbers = new Map<string, string>();
  /** A number of its own for each name in this run, so tests never share a code or a limit. */
  const phoneOf = (name: string) => {
    if (!numbers.has(name))
      numbers.set(name, `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
    return numbers.get(name)!;
  };
  const askCode = (visit: ReturnType<typeof as>, name: string) =>
    visit('POST', '/api/v1/auth/phone/start', { body: { phone: phoneOf(name), locale: 'en' } });
  /** As if a minute had passed since the last code was sent to this number. */
  const skipTheWait = (name: string) =>
    redis.del(`matrimony:throttle:phone-gap:${agency}:${digest(phoneOf(name))}`);
  const lastCodeTo = (name: string) =>
    /\b(\d{6})\b/.exec(texts.filter((m) => m.to === phoneOf(name)).at(-1)!.text)![1]!;
  const checkCode = (visit: ReturnType<typeof as>, name: string, code = lastCodeTo(name)) =>
    visit('POST', '/api/v1/auth/phone/verify', {
      body: { phone: phoneOf(name), code, locale: 'en' },
    });
  const wrongCode = (name: string) => (lastCodeTo(name) === '000000' ? '000001' : '000000');
  const accountOfPhone = async (name: string, agencyId = agency) =>
    (
      await admin.query(
        `SELECT a.id, a.email, a.phone_verified_at, a.status,
                (SELECT count(*)::int FROM matrimony.account_credentials c WHERE c.account_id=a.id) AS passwords,
                (SELECT count(*)::int FROM matrimony.consent_events e WHERE e.account_id=a.id) AS consents
         FROM matrimony.accounts a WHERE a.agency_id=$1 AND a.phone_e164=$2`,
        [agencyId, phoneOf(name)],
      )
    ).rows;
  const agree = { acceptTerms: true, acceptPrivacy: true };

  await t.test(
    'Phone: the sign-in methods on offer include the phone when texts can be sent',
    async () => {
      const methods = await as()('GET', '/api/v1/auth/methods');
      assert.deepEqual(methods.json(), { password: true, google: true, phone: true });
    },
  );

  await t.test(
    'Phone: a new number gets a code, then is asked to agree, and only then has an account',
    async () => {
      const visit = as();
      const asked = await askCode(visit, 'pnew');
      assert.equal(asked.statusCode, 202);
      assert.deepEqual(asked.json(), { status: 'code_sent', resendAfter: 60, expiresIn: 300 });
      assert.match(texts.at(-1)!.text, /your code is \d{6}/);
      assert.equal(texts.at(-1)!.to, phoneOf('pnew'));

      // A right code for a number with no account signs nobody in and creates nothing.
      const proven = await checkCode(visit, 'pnew');
      assert.equal(proven.statusCode, 202);
      assert.deepEqual(proven.json(), { status: 'signup_required' });
      assert.equal(cookieFrom(proven, 'matrimony-session'), '');
      const pending = cookieFrom(proven, 'matrimony-signup');
      assert.equal(pending.length, 43);
      assert.equal((await accountOfPhone('pnew')).length, 0);
      const cookie = { cookie: `matrimony-signup=${pending}` };

      // The page is told the number, and nothing else.
      const waiting = await visit('GET', '/api/v1/auth/phone/signup', { headers: cookie });
      assert.deepEqual(waiting.json(), { phone: phoneOf('pnew') });

      // Without a name and the agreements nothing is created, and the step stays open.
      for (const body of [{}, { displayName: 'Nina' }, { ...agree }]) {
        const refused = await visit('POST', '/api/v1/auth/phone/signup', { body, headers: cookie });
        assert.equal(refused.statusCode, 400);
      }
      assert.equal((await accountOfPhone('pnew')).length, 0);

      const created = await visit('POST', '/api/v1/auth/phone/signup', {
        body: { displayName: 'Nina Phone', ...agree },
        headers: cookie,
      });
      assert.equal(created.statusCode, 200);
      assert.equal(cookieFrom(created, 'matrimony-session').length, 43);
      const profile = await me(visit, created.json().accessToken);
      assert.equal(profile.statusCode, 200);
      assert.equal(profile.json().role, 'member');
      assert.equal(profile.json().displayName, 'Nina Phone');

      // A member with a proven number, and no email and no password.
      const rows = await accountOfPhone('pnew');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].email, null);
      assert.notEqual(rows[0].phone_verified_at, null);
      assert.equal(rows[0].status, 'active');
      assert.equal(rows[0].passwords, 0);
      assert.equal(rows[0].consents, 2);
      const events = await admin.query(
        `SELECT event->>'type' AS type FROM matrimony.event_outbox WHERE event->>'subjectId'=$1 ORDER BY 1`,
        [rows[0].id],
      );
      assert.deepEqual(
        events.rows.map((r) => r.type),
        ['account.registered', 'auth.login'],
      );

      // The step is spent: pressing again cannot create a second account.
      const again = await visit('POST', '/api/v1/auth/phone/signup', {
        body: { displayName: 'Nina Phone', ...agree },
        headers: cookie,
      });
      assert.equal(again.statusCode, 400);
      assert.equal((await accountOfPhone('pnew')).length, 1);

      // From now on the number signs in, as the same account.
      const second = as();
      await skipTheWait('pnew');
      await askCode(second, 'pnew');
      const back = await checkCode(second, 'pnew');
      assert.equal(back.statusCode, 200);
      const same = await me(second, back.json().accessToken);
      assert.equal(same.json().id, rows[0].id);
    },
  );

  await t.test(
    'Phone: the code is a six-digit number sent once, kept only as a fingerprint, and used up by a right guess',
    async () => {
      const visit = as();
      await askCode(visit, 'pcode');
      const code = lastCodeTo('pcode');
      assert.match(code, /^\d{6}$/);
      // Nothing in Redis can be used to read the code or the number back.
      const keys = await redis.keys('matrimony:phone-code:*');
      const stored = await Promise.all(keys.map((k) => redis.hgetall(k)));
      const everything = JSON.stringify([keys, stored]);
      assert.equal(everything.includes(code), false);
      assert.equal(everything.includes(phoneOf('pcode')), false);
      assert.equal((await checkCode(visit, 'pcode', code)).statusCode, 202);
      const replay = await checkCode(visit, 'pcode', code);
      assert.equal(replay.statusCode, 400);
      assert.equal(replay.json().error.code, 'CODE_EXPIRED');
    },
  );

  await t.test(
    'Phone: a wrong code can be tried again, and five wrong ones cancel the code',
    async () => {
      const visit = as();
      await askCode(visit, 'plock');
      const right = lastCodeTo('plock');
      const wrong = wrongCode('plock');
      for (let i = 0; i < 4; i++) {
        const refused = await checkCode(visit, 'plock', wrong);
        assert.equal(refused.statusCode, 400);
        assert.equal(refused.json().error.code, 'CODE_INVALID');
      }
      const last = await checkCode(visit, 'plock', wrong);
      assert.equal(last.json().error.code, 'CODE_EXPIRED');
      const late = await checkCode(visit, 'plock', right);
      assert.equal(late.statusCode, 400);
      assert.equal(late.json().error.code, 'CODE_EXPIRED');
      assert.equal((await accountOfPhone('plock')).length, 0);
    },
  );

  await t.test(
    'Phone: a second code within a minute is refused with how long to wait',
    async () => {
      const visit = as();
      assert.equal((await askCode(visit, 'pgap')).statusCode, 202);
      const second = await askCode(as(), 'pgap');
      assert.equal(second.statusCode, 429);
      assert.equal(second.json().error.code, 'CODE_RATE_LIMITED');
      assert.ok(Number(second.headers['retry-after']) > 0);
      assert.equal(texts.filter((m) => m.to === phoneOf('pgap')).length, 1);
    },
  );

  /** An account that already has this number, made directly so the number is not yet limited. */
  const accountWithPhone = async (name: string, agencyId = agency) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts
        (agency_id, id, role, display_name, phone_e164, phone_verified_at, auth_issuer, auth_subject, status, locale)
       VALUES ($1, $2::uuid, 'member', $3, $4, now(), 'local', ($2::uuid)::text, 'active', 'en')`,
      [agencyId, id, `Has ${name}`, phoneOf(name)],
    );
    return id;
  };

  await t.test(
    'Phone: asking looks exactly the same for a number that has an account and one that has not',
    async () => {
      await accountWithPhone('pknown');
      const known = await askCode(as(), 'pknown');
      const unknown = await askCode(as(), 'punknown');
      assert.equal(known.statusCode, 202);
      assert.deepEqual(known.json(), unknown.json());
      assert.equal(known.statusCode, unknown.statusCode);
      assert.equal(
        texts
          .filter((m) => m.to === phoneOf('pknown'))
          .at(-1)!
          .text.replace(/\d{6}/, 'X'),
        texts
          .filter((m) => m.to === phoneOf('punknown'))
          .at(-1)!
          .text.replace(/\d{6}/, 'X'),
      );
    },
  );

  await t.test(
    'Phone: the owner of a number signs in with a code, as their own account',
    async () => {
      const id = await accountWithPhone('powns');
      const visit = as();
      await askCode(visit, 'powns');
      const back = await checkCode(visit, 'powns');
      assert.equal(back.statusCode, 200);
      assert.equal((await me(visit, back.json().accessToken)).json().id, id);
    },
  );

  await t.test(
    'Phone: a number that has an account signs in with its code, and a disabled one does not',
    async () => {
      await signUp('pdisabled');
      const visit = as();
      const token = (await logIn(visit, 'pdisabled')).json().accessToken;
      const start = await visit('POST', '/api/v1/me/phone/start', {
        body: { phone: phoneOf('pdisabled'), locale: 'en' },
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(start.statusCode, 202);
      const done = await visit('POST', '/api/v1/me/phone/verify', {
        body: { phone: phoneOf('pdisabled'), code: lastCodeTo('pdisabled') },
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(done.statusCode, 200);

      await admin.query(
        `UPDATE matrimony.accounts SET status='disabled' WHERE agency_id=$1 AND phone_e164=$2`,
        [agency, phoneOf('pdisabled')],
      );
      const other = as();
      await skipTheWait('pdisabled');
      await askCode(other, 'pdisabled');
      const refused = await checkCode(other, 'pdisabled');
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error.code, 'ACCOUNT_NOT_ACTIVE');
      assert.equal(cookieFrom(refused, 'matrimony-session'), '');
    },
  );

  await t.test(
    'Phone: adding a number to an email account, signing in with it, and seeing it hidden',
    async () => {
      await signUp('padd');
      const visit = as();
      const bearer = { authorization: `Bearer ${(await logIn(visit, 'padd')).json().accessToken}` };
      const before = await visit('GET', '/api/v1/me/sign-in-methods', { headers: bearer });
      assert.deepEqual(before.json(), {
        email: email('padd'),
        emailVerified: true,
        phone: null,
        hasPassword: true,
        google: false,
      });

      assert.equal(
        (
          await visit('POST', '/api/v1/me/phone/start', {
            body: { phone: phoneOf('padd'), locale: 'en' },
            headers: bearer,
          })
        ).statusCode,
        202,
      );
      // A wrong code adds nothing.
      const wrong = await visit('POST', '/api/v1/me/phone/verify', {
        body: { phone: phoneOf('padd'), code: wrongCode('padd') },
        headers: bearer,
      });
      assert.equal(wrong.statusCode, 400);
      assert.equal((await accountOfPhone('padd')).length, 0);
      const added = await visit('POST', '/api/v1/me/phone/verify', {
        body: { phone: phoneOf('padd'), code: lastCodeTo('padd') },
        headers: bearer,
      });
      assert.equal(added.statusCode, 200);
      assert.deepEqual(added.json(), { status: 'phone_added' });

      const after = (await visit('GET', '/api/v1/me/sign-in-methods', { headers: bearer })).json();
      assert.notEqual(after.phone, null);
      assert.equal(after.phone.includes(phoneOf('padd')), false);
      assert.ok(
        after.phone.startsWith(phoneOf('padd').slice(0, 5)) &&
          after.phone.endsWith(phoneOf('padd').slice(-3)),
      );
      const events = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'type'='auth.phone_added' AND event->>'subjectId'=$1`,
        [(await accountOfPhone('padd'))[0].id],
      );
      assert.equal(events.rows[0].n, 1);

      // Now the number signs in, as the very same account that has the email and the password.
      const login = as();
      await skipTheWait('padd');
      await askCode(login, 'padd');
      const back = await checkCode(login, 'padd');
      assert.equal(back.statusCode, 200);
      const same = await me(login, back.json().accessToken);
      assert.equal(same.json().id, (await accountOfPhone('padd'))[0].id);
      assert.equal(same.json().displayName, 'Member padd');
    },
  );

  await t.test(
    'Phone: a number that belongs to another account is never added to a second one',
    async () => {
      await signUp('pthief');
      const owner = await accountWithPhone('powner');
      // Someone signed in as another account, who holds the number's text, is still refused.
      numbers.set('pthief', phoneOf('powner'));
      const thief = as();
      const bearer = {
        authorization: `Bearer ${(await logIn(thief, 'pthief')).json().accessToken}`,
      };
      assert.equal(
        (
          await thief('POST', '/api/v1/me/phone/start', {
            body: { phone: phoneOf('powner'), locale: 'en' },
            headers: bearer,
          })
        ).statusCode,
        202,
      );
      const refused = await thief('POST', '/api/v1/me/phone/verify', {
        body: { phone: phoneOf('powner'), code: lastCodeTo('powner') },
        headers: bearer,
      });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().error.code, 'PHONE_IN_USE');
      const rows = await accountOfPhone('powner');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, owner);
    },
  );

  await t.test('Phone: adding or changing a number needs a signed-in member', async () => {
    const visit = as();
    for (const url of ['/api/v1/me/phone/start', '/api/v1/me/phone/verify'])
      assert.equal(
        (
          await visit('POST', url, {
            body: { phone: phoneOf('panon'), code: '123456', locale: 'en' },
          })
        ).statusCode,
        401,
      );
    assert.equal((await visit('GET', '/api/v1/me/sign-in-methods')).statusCode, 401);
    assert.equal(
      texts.some((m) => m.to === phoneOf('panon')),
      false,
    );
  });

  await t.test(
    'Phone: a code, and the step that follows it, belong to the agency they began at',
    async () => {
      const visit = as();
      await askCode(visit, 'pscope');
      const right = lastCodeTo('pscope');
      // The code does nothing at another agency.
      const elsewhere = await as('other.localhost')('POST', '/api/v1/auth/phone/verify', {
        body: { phone: phoneOf('pscope'), code: right, locale: 'en' },
      });
      assert.equal(elsewhere.statusCode, 400);
      assert.equal(elsewhere.json().error.code, 'CODE_EXPIRED');

      const proven = await checkCode(visit, 'pscope', right);
      const cookie = { cookie: `matrimony-signup=${cookieFrom(proven, 'matrimony-signup')}` };
      const stolen = await as('other.localhost')('POST', '/api/v1/auth/phone/signup', {
        body: { displayName: 'X', ...agree },
        headers: cookie,
      });
      assert.equal(stolen.statusCode, 400);
      assert.equal((await accountOfPhone('pscope', otherAgency)).length, 0);
      assert.equal((await accountOfPhone('pscope')).length, 0);

      // The same number can have its own account at the other agency.
      const there = as('other.localhost');
      await there('POST', '/api/v1/auth/phone/start', {
        body: { phone: phoneOf('pscope'), locale: 'en' },
      });
      const code = /\b(\d{6})\b/.exec(texts.at(-1)!.text)![1]!;
      const provenThere = await there('POST', '/api/v1/auth/phone/verify', {
        body: { phone: phoneOf('pscope'), code, locale: 'en' },
      });
      const createdThere = await there('POST', '/api/v1/auth/phone/signup', {
        body: { displayName: 'There', ...agree },
        headers: { cookie: `matrimony-signup=${cookieFrom(provenThere, 'matrimony-signup')}` },
      });
      assert.equal(createdThere.statusCode, 200);
      assert.equal((await accountOfPhone('pscope', otherAgency)).length, 1);
      assert.equal((await accountOfPhone('pscope')).length, 0);
    },
  );

  await t.test(
    'Phone: a foreign request, an invalid number and extra fields are refused',
    async () => {
      const visit = as();
      const wrongSite = await visit('POST', '/api/v1/auth/phone/start', {
        body: { phone: phoneOf('pforeign'), locale: 'en' },
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(wrongSite.statusCode, 403);
      for (const body of [
        { phone: '12345', locale: 'en' },
        { phone: '', locale: 'en' },
        { locale: 'en' },
        { phone: phoneOf('pforeign'), locale: 'en', role: 'admin' },
      ])
        assert.equal((await visit('POST', '/api/v1/auth/phone/start', { body })).statusCode, 400);
      assert.equal(
        texts.some((m) => m.to === phoneOf('pforeign')),
        false,
      );
      const noCookie = await visit('GET', '/api/v1/auth/phone/signup');
      assert.equal(noCookie.statusCode, 400);
    },
  );
});
