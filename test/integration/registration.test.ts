import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import type { Registration } from '../../src/bo/registration.js';
import { Database } from '../../src/db/config/database.js';
import { CredentialRepository } from '../../src/db/raw/repository/credential-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { IdentityRepository } from '../../src/db/raw/repository/identity-repository.js';
import { RegistrationRepository } from '../../src/db/raw/repository/registration-repository.js';
import { CredentialDbService } from '../../src/db/service/credential-db-service.js';
import { IdentityDbService } from '../../src/db/service/identity-db-service.js';
import { RegistrationDbService } from '../../src/db/service/registration-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { PasswordHasher } from '../../src/security/password-hasher.js';
import { CredentialService } from '../../src/service/credential-service.js';
import { IdentityService } from '../../src/service/identity-service.js';
import { RegistrationService } from '../../src/service/registration-service.js';
import { agency, otherAgency } from '../fixtures.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const registration: Registration = {
  displayName: 'Rahim',
  locale: 'bn',
  onBehalfOfOther: false,
  termsVersion: 'terms-test',
  privacyVersion: 'privacy-test',
};
const hasher = new PasswordHasher({ memory: 64, passes: 1, parallelism: 1 });
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('email and password accounts on real PostgreSQL', async (t) => {
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
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 8 });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.end();
  });

  const registrations = new RegistrationService(
    new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
  );
  const credentialDb = new CredentialDbService(
    db,
    new CredentialRepository(),
    new EventRepository(),
  );
  const credentials = new CredentialService(credentialDb, hasher, pino({ level: 'silent' }));
  const identities = new IdentityService(new IdentityDbService(db, new IdentityRepository()), {
    localhost: agency,
    'other.localhost': otherAgency,
  });

  // Each run uses fresh addresses, so a database that already holds earlier runs still works.
  const run = Date.now().toString(36) + randomUUID().slice(0, 4);
  const email = (name: string) => `${name}.${run}@example.com`;
  const verified = async (name: string, password = 'the right password') => ({
    email: email(name),
    passwordHash: await hasher.hash(password),
    registration,
  });
  const accountRow = async (address: string, agencyId = agency) =>
    (
      await admin.query(
        `SELECT id, role, status, email, email_verified_at IS NOT NULL AS verified, locale, auth_issuer, auth_subject
         FROM matrimony.accounts WHERE agency_id=$1 AND email=$2`,
        [agencyId, address],
      )
    ).rows;

  await t.test(
    'opening the link stores the account, password, consents and event together',
    async () => {
      const result = await registrations.createVerified(agency, await verified('one'), 'req-1');
      assert.ok(result.created);
      assert.equal(result.account.role, 'member');

      const [row] = await accountRow(email('one'));
      assert.deepEqual(row, {
        id: result.account.id,
        role: 'member',
        status: 'active',
        email: email('one'),
        verified: true,
        locale: 'bn',
        auth_issuer: 'local',
        auth_subject: result.account.id,
      });

      const credential = await admin.query(
        `SELECT password_hash FROM matrimony.account_credentials WHERE account_id=$1`,
        [result.account.id],
      );
      assert.equal(credential.rows.length, 1);
      assert.match(credential.rows[0].password_hash, /^\$argon2id\$v=19\$/);

      const consents = await admin.query(
        `SELECT purpose, document_version, action FROM matrimony.consent_events WHERE account_id=$1 ORDER BY purpose`,
        [result.account.id],
      );
      assert.deepEqual(consents.rows, [
        { purpose: 'privacy', document_version: 'privacy-test', action: 'accepted' },
        { purpose: 'terms', document_version: 'terms-test', action: 'accepted' },
      ]);

      const events = await admin.query(
        `SELECT event FROM matrimony.event_outbox WHERE event->>'subjectId'=$1`,
        [result.account.id],
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event.type, 'account.registered');
      assert.equal(JSON.stringify(events.rows[0].event).includes(email('one')), false);
    },
  );

  await t.test(
    'the same email again adds nothing and leaves the first password alone',
    async () => {
      const first = await registrations.createVerified(
        agency,
        await verified('dup', 'first password!'),
        'r',
      );
      assert.ok(first.created);
      const second = await registrations.createVerified(
        agency,
        await verified('dup', 'second password'),
        'r',
      );
      assert.deepEqual(second, { created: false });
      assert.equal((await accountRow(email('dup'))).length, 1);
      await credentials.verify(agency, email('dup'), 'first password!');
      await assert.rejects(
        () => credentials.verify(agency, email('dup'), 'second password'),
        code(401, 'INVALID_CREDENTIALS'),
      );
      const consents = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.consent_events WHERE account_id=$1`,
        [first.account.id],
      );
      assert.equal(consents.rows[0].n, 2);
    },
  );

  await t.test('two links opened at the same moment create exactly one account', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, async () =>
        registrations.createVerified(agency, await verified('race'), 'r'),
      ),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    const rows = await accountRow(email('race'));
    assert.equal(rows.length, 1);
    const counts = await admin.query(
      `SELECT (SELECT count(*)::int FROM matrimony.account_credentials WHERE account_id=$1) AS credentials,
              (SELECT count(*)::int FROM matrimony.consent_events WHERE account_id=$1) AS consents,
              (SELECT count(*)::int FROM matrimony.event_outbox WHERE event->>'subjectId'=$1::text) AS events`,
      [rows[0].id],
    );
    assert.deepEqual(counts.rows[0], { credentials: 1, consents: 2, events: 1 });
  });

  await t.test('a failure part-way leaves nothing behind', async () => {
    // A stored password must be an Argon2id hash. This one is not, so the insert of the password
    // fails after the account row was written, and the whole transaction is undone.
    await assert.rejects(() =>
      registrations.createVerified(
        agency,
        { email: email('atomic'), passwordHash: 'plain-text', registration },
        `req-atomic-${run}`,
      ),
    );
    assert.equal((await accountRow(email('atomic'))).length, 0);
    const events = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'correlationId'=$1`,
      [`req-atomic-${run}`],
    );
    assert.equal(events.rows[0].n, 0);
  });

  await t.test(
    'the same email at two agencies is two accounts, and neither can see the other',
    async () => {
      const [a, b] = await Promise.all([
        registrations.createVerified(agency, await verified('both', 'password for one'), 'r'),
        registrations.createVerified(otherAgency, await verified('both', 'password for two'), 'r'),
      ]);
      assert.ok(a.created && b.created);
      assert.notEqual(a.account.id, b.account.id);

      // Each agency's sign-in sees only its own account and password.
      assert.equal(
        (await credentials.verify(agency, email('both'), 'password for one')).id,
        a.account.id,
      );
      assert.equal(
        (await credentials.verify(otherAgency, email('both'), 'password for two')).id,
        b.account.id,
      );
      await assert.rejects(
        () => credentials.verify(agency, email('both'), 'password for two'),
        code(401, 'INVALID_CREDENTIALS'),
      );

      // An account that exists only at the other agency does not exist here.
      const only = await registrations.createVerified(
        otherAgency,
        await verified('elsewhere'),
        'r',
      );
      assert.ok(only.created);
      assert.equal(await credentials.findByEmail(agency, email('elsewhere')), null);
      assert.equal(await registrations.emailRegistered(agency, email('elsewhere')), false);
      assert.equal(await registrations.emailRegistered(otherAgency, email('elsewhere')), true);
      await assert.rejects(
        () => identities.account(agency, only.account.id),
        code(403, 'ACCOUNT_NOT_ACTIVE'),
      );
    },
  );

  await t.test(
    'sign-in checks the real stored hash, and tells apart only what it may',
    async () => {
      const created = await registrations.createVerified(agency, await verified('login'), 'r');
      assert.ok(created.created);
      assert.equal(
        (await credentials.verify(agency, email('login'), 'the right password')).id,
        created.account.id,
      );
      await assert.rejects(
        () => credentials.verify(agency, email('login'), 'wrong'),
        code(401, 'INVALID_CREDENTIALS'),
      );
      await assert.rejects(
        () => credentials.verify(agency, email('nobody'), 'the right password'),
        code(401, 'INVALID_CREDENTIALS'),
      );

      // An account with no password row behaves like an unknown email.
      await admin.query(
        `INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,auth_issuer,auth_subject,status)
       VALUES ($1,$2::uuid,'agent','No password',$3,'local',($2::uuid)::text,'active')`,
        [agency, randomUUID(), email('nopass')],
      );
      await assert.rejects(
        () => credentials.verify(agency, email('nopass'), 'anything'),
        code(401, 'INVALID_CREDENTIALS'),
      );

      await admin.query(`UPDATE matrimony.accounts SET status='disabled' WHERE id=$1`, [
        created.account.id,
      ]);
      await assert.rejects(
        () => credentials.verify(agency, email('login'), 'the right password'),
        code(403, 'ACCOUNT_NOT_ACTIVE'),
      );
      await assert.rejects(
        () => credentials.verify(agency, email('login'), 'wrong'),
        code(401, 'INVALID_CREDENTIALS'),
      );
      await assert.rejects(
        () => identities.account(agency, created.account.id),
        code(403, 'ACCOUNT_NOT_ACTIVE'),
      );
    },
  );

  await t.test('the account for a token is found by id, and only while active', async () => {
    const created = await registrations.createVerified(agency, await verified('byid'), 'r');
    assert.ok(created.created);
    assert.deepEqual(await identities.account(agency, created.account.id), created.account);
    await assert.rejects(
      () => identities.account(otherAgency, created.account.id),
      code(403, 'ACCOUNT_NOT_ACTIVE'),
    );
    await assert.rejects(
      () => identities.account(agency, randomUUID()),
      code(403, 'ACCOUNT_NOT_ACTIVE'),
    );
  });

  await t.test(
    'an older hash is upgraded after sign-in, but never over a newer password',
    async () => {
      const weak = new PasswordHasher({ memory: 32, passes: 1, parallelism: 1 });
      const created = await registrations.createVerified(
        agency,
        { ...(await verified('rehash')), passwordHash: await weak.hash('the right password') },
        'r',
      );
      assert.ok(created.created);
      const stored = async () =>
        (
          await admin.query(
            `SELECT password_hash, password_changed_at FROM matrimony.account_credentials WHERE account_id=$1`,
            [created.account.id],
          )
        ).rows[0];
      const before = await stored();
      assert.match(before.password_hash, /\$m=32,/);

      await credentials.verify(agency, email('rehash'), 'the right password');
      const after = await stored();
      assert.match(after.password_hash, /\$m=64,/);
      assert.equal(await hasher.verify('the right password', after.password_hash), true);
      // Only the hash settings changed; this is not a password change.
      assert.deepEqual(after.password_changed_at, before.password_changed_at);

      // A replacement based on an old hash does nothing if the password has changed since.
      const changed = await hasher.hash('a newer password');
      await admin.query(
        `UPDATE matrimony.account_credentials SET password_hash=$2 WHERE account_id=$1`,
        [created.account.id, changed],
      );
      assert.equal(
        await credentialDb.rehash(
          agency,
          created.account.id,
          await hasher.hash('x'),
          before.password_hash,
        ),
        false,
      );
      assert.equal((await stored()).password_hash, changed);
    },
  );

  await t.test(
    'resetting a password stores it and the event together, and refuses an inactive account',
    async () => {
      const created = await registrations.createVerified(agency, await verified('reset'), 'r');
      assert.ok(created.created);
      const hash = await hasher.hash('after the reset');
      assert.equal(
        await credentials.setPassword(agency, created.account.id, hash, `req-reset-${run}`),
        true,
      );
      assert.equal(
        (await credentials.verify(agency, email('reset'), 'after the reset')).id,
        created.account.id,
      );
      await assert.rejects(
        () => credentials.verify(agency, email('reset'), 'the right password'),
        code(401, 'INVALID_CREDENTIALS'),
      );

      const changedAt = await admin.query(
        `SELECT password_changed_at > created_at AS changed FROM matrimony.account_credentials WHERE account_id=$1`,
        [created.account.id],
      );
      assert.equal(changedAt.rows[0].changed, true);
      const events = await admin.query(
        `SELECT event FROM matrimony.event_outbox WHERE event->>'correlationId'=$1`,
        [`req-reset-${run}`],
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event.type, 'auth.password_reset');
      assert.equal(events.rows[0].event.subjectId, created.account.id);

      await admin.query(`UPDATE matrimony.accounts SET status='disabled' WHERE id=$1`, [
        created.account.id,
      ]);
      assert.equal(
        await credentials.setPassword(
          agency,
          created.account.id,
          await hasher.hash('blocked pass'),
          `req-blocked-${run}`,
        ),
        false,
      );
      const blocked = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'correlationId'=$1`,
        [`req-blocked-${run}`],
      );
      assert.equal(blocked.rows[0].n, 0);
    },
  );

  await t.test('a password can be set for an account that had none', async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,auth_issuer,auth_subject,status)
       VALUES ($1,$2::uuid,'agent','Staff',$3,'local',($2::uuid)::text,'active')`,
      [agency, id, email('staff')],
    );
    assert.equal(
      await credentials.setPassword(agency, id, await hasher.hash('first ever password'), 'r'),
      true,
    );
    assert.equal((await credentials.verify(agency, email('staff'), 'first ever password')).id, id);
  });

  await t.test(
    'the runtime role cannot delete a password or rewrite an account, and cannot read another agency through a mistake',
    async () => {
      const created = await registrations.createVerified(agency, await verified('grants'), 'r');
      assert.ok(created.created);
      const denied = (sql: string, params: unknown[]) =>
        db.transaction(agency, (tx) => tx.query(sql, params));
      await assert.rejects(
        () =>
          denied(`DELETE FROM matrimony.account_credentials WHERE account_id=$1`, [
            created.account.id,
          ]),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          denied(`UPDATE matrimony.accounts SET role='admin' WHERE id=$1`, [created.account.id]),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          denied(`UPDATE matrimony.accounts SET email='x@y.com' WHERE id=$1`, [created.account.id]),
        /permission denied/,
      );
      // Asked for with the wrong agency context, the row is simply not there.
      const other = await db.transaction(otherAgency, (tx) =>
        tx.query(
          `SELECT count(*)::int AS n FROM matrimony.account_credentials WHERE account_id=$1`,
          [created.account.id],
        ),
      );
      assert.equal(other.rows[0].n, 0);
      // And a write for another agency's row is refused by the row-level policy.
      await assert.rejects(() =>
        db.transaction(otherAgency, (tx) =>
          tx.query(
            `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash) VALUES ($1,$2,$3)`,
            [agency, created.account.id, '$argon2id$v=19$x'],
          ),
        ),
      );
    },
  );

  const google = (name: string) => ({
    provider: 'google' as const,
    subject: `sub-${name}-${run}`,
    email: email(name),
  });

  await t.test(
    'registering with Google stores a member with no password, the identity, the consents and an event together',
    async () => {
      const identity = google('g1');
      const result = await registrations.registerExternal(
        agency,
        { ...identity, displayName: 'Google Person' },
        registration,
        `req-g1-${run}`,
      );
      assert.ok(result.created);
      const [row] = await accountRow(identity.email);
      assert.equal(row.role, 'member');
      assert.equal(row.status, 'active');
      assert.equal(row.verified, true);
      const counts = await admin.query(
        `SELECT (SELECT count(*)::int FROM matrimony.account_credentials WHERE account_id=$1) AS passwords,
              (SELECT count(*)::int FROM matrimony.account_identities WHERE account_id=$1) AS identities,
              (SELECT count(*)::int FROM matrimony.consent_events WHERE account_id=$1) AS consents,
              (SELECT count(*)::int FROM matrimony.event_outbox WHERE event->>'subjectId'=$1::text) AS events`,
        [result.account.id],
      );
      assert.deepEqual(counts.rows[0], { passwords: 0, identities: 1, consents: 2, events: 1 });
      const found = await registrations.findByIdentity(agency, 'google', identity.subject);
      assert.equal(found?.account.id, result.account.id);
      assert.equal(found?.status, 'active');
    },
  );

  await t.test("the identity is found by Google's id only inside its own agency", async () => {
    const identity = google('g2');
    const result = await registrations.registerExternal(
      agency,
      { ...identity, displayName: 'G' },
      registration,
      'r',
    );
    assert.ok(result.created);
    assert.equal(await registrations.findByIdentity(otherAgency, 'google', identity.subject), null);
    // The same Google person can have a separate account at another agency.
    const other = await registrations.registerExternal(
      otherAgency,
      { ...identity, displayName: 'G' },
      registration,
      'r',
    );
    assert.ok(other.created);
    assert.notEqual(other.account.id, result.account.id);
    assert.equal(
      (await registrations.findByIdentity(otherAgency, 'google', identity.subject))?.account.id,
      other.account.id,
    );
  });

  await t.test(
    'Google never takes over an email that already has an account, and creates nothing',
    async () => {
      const existing = await registrations.createVerified(agency, await verified('g3'), 'r');
      assert.ok(existing.created);
      const identity = google('g3');
      assert.deepEqual(
        await registrations.registerExternal(
          agency,
          { ...identity, displayName: 'Takeover' },
          registration,
          'r',
        ),
        { created: false },
      );
      assert.equal((await accountRow(identity.email)).length, 1);
      assert.equal(await registrations.findByIdentity(agency, 'google', identity.subject), null);
      // The account is still reachable with its own password only.
      assert.equal(
        (await credentials.verify(agency, identity.email, 'the right password')).id,
        existing.account.id,
      );
    },
  );

  await t.test(
    'a Google identity can belong to one account, and an account can have one Google identity',
    async () => {
      const first = await registrations.createVerified(agency, await verified('g4a'), 'r');
      const second = await registrations.createVerified(agency, await verified('g4b'), 'r');
      assert.ok(first.created && second.created);
      const identity = google('g4');
      assert.equal(
        await registrations.linkIdentity(agency, first.account.id, identity, `req-l-${run}`),
        true,
      );
      // The same Google person cannot also be linked to a second account.
      assert.equal(
        await registrations.linkIdentity(agency, second.account.id, identity, 'r'),
        false,
      );
      // And the first account cannot get another Google identity.
      assert.equal(
        await registrations.linkIdentity(
          agency,
          first.account.id,
          { ...identity, subject: `other-${run}` },
          'r',
        ),
        false,
      );
      const events = await admin.query(
        `SELECT event FROM matrimony.event_outbox WHERE event->>'correlationId'=$1`,
        [`req-l-${run}`],
      );
      assert.equal(events.rows.length, 1);
      assert.equal(events.rows[0].event.type, 'auth.identity_linked');
      // The first account still signs in with its password as well.
      assert.equal(
        (await credentials.verify(agency, email('g4a'), 'the right password')).id,
        first.account.id,
      );
    },
  );

  await t.test(
    'two requests registering the same Google person at once create exactly one account',
    async () => {
      const identity = google('g5');
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          registrations.registerExternal(
            agency,
            { ...identity, displayName: 'Race' },
            registration,
            'r',
          ),
        ),
      );
      const created = results.filter((r) => r.status === 'fulfilled' && r.value.created).length;
      assert.equal(created, 1);
      assert.equal((await accountRow(identity.email)).length, 1);
      const rows = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.account_identities WHERE provider_subject=$1`,
        [identity.subject],
      );
      assert.equal(rows.rows[0].n, 1);
    },
  );

  await t.test(
    'the runtime role cannot change or delete an identity, and another agency cannot see it',
    async () => {
      const identity = google('g6');
      const result = await registrations.registerExternal(
        agency,
        { ...identity, displayName: 'G' },
        registration,
        'r',
      );
      assert.ok(result.created);
      const run1 = (sql: string, params: unknown[]) =>
        db.transaction(agency, (tx) => tx.query(sql, params));
      await assert.rejects(
        () =>
          run1('DELETE FROM matrimony.account_identities WHERE account_id=$1', [result.account.id]),
        /permission denied/,
      );
      await assert.rejects(
        () =>
          run1("UPDATE matrimony.account_identities SET provider_subject='x' WHERE account_id=$1", [
            result.account.id,
          ]),
        /permission denied/,
      );
      const elsewhere = await db.transaction(otherAgency, (tx) =>
        tx.query(
          'SELECT count(*)::int AS n FROM matrimony.account_identities WHERE account_id=$1',
          [result.account.id],
        ),
      );
      assert.equal(elsewhere.rows[0].n, 0);
      await assert.rejects(() =>
        db.transaction(otherAgency, (tx) =>
          tx.query(
            "INSERT INTO matrimony.account_identities(agency_id, account_id, provider, provider_subject, email) VALUES ($1,$2,'google','x','x@y.com')",
            [agency, result.account.id],
          ),
        ),
      );
    },
  );

  await t.test(
    'the database refuses an unknown provider, an empty subject and an email that is not lower case',
    async () => {
      const created = await registrations.createVerified(agency, await verified('g7'), 'r');
      assert.ok(created.created);
      const insert = (provider: string, subject: string, addr: string) =>
        admin.query(
          'INSERT INTO matrimony.account_identities(agency_id, account_id, provider, provider_subject, email) VALUES ($1,$2,$3,$4,$5)',
          [agency, created.account.id, provider, subject, addr],
        );
      await assert.rejects(() => insert('facebook', 's', 'a@b.com'), /check constraint/);
      await assert.rejects(() => insert('google', '', 'a@b.com'), /check constraint/);
      await assert.rejects(() => insert('google', 's', 'A@B.com'), /check constraint/);
    },
  );

  await t.test(
    'the database itself refuses a plain-text password and an unverified email without an address',
    async () => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO matrimony.accounts(agency_id,id,role,display_name,email,auth_issuer,auth_subject,status)
       VALUES ($1,$2::uuid,'member','Constraint check',$3,'local',($2::uuid)::text,'active')`,
        [agency, id, email('constraint')],
      );
      await assert.rejects(
        () =>
          admin.query(
            `INSERT INTO matrimony.account_credentials(agency_id,account_id,password_hash) VALUES ($1,$2,'hunter2')`,
            [agency, id],
          ),
        /account_credentials_password_hash_check|check constraint/,
      );
      await assert.rejects(
        () =>
          admin.query(
            `INSERT INTO matrimony.accounts(agency_id,id,role,display_name,phone_e164,email_verified_at,auth_issuer,auth_subject,status)
         VALUES ($1,$2::uuid,'member','Phone only',$3,now(),'local',($2::uuid)::text,'active')`,
            [agency, randomUUID(), `+88017${run.replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}9`],
          ),
        /accounts_email_verified_needs_email|check constraint/,
      );
    },
  );
});
