import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import type { Registration } from '../../src/bo/registration.js';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/bo/registration.js';
import { Database } from '../../src/db/config/database.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { RegistrationRepository } from '../../src/db/raw/repository/registration-repository.js';
import { RegistrationDbService } from '../../src/db/service/registration-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { RegistrationService } from '../../src/service/registration-service.js';
import { agency, otherAgency } from '../fixtures.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const ISSUER = 'https://registration-test.example/';
const registration: Registration = { displayName: 'Rahim', locale: 'bn', onBehalfOfOther: false };
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('registration on real PostgreSQL', async (t) => {
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
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 6 });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.end();
  });
  const service = new RegistrationService(
    new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
  );

  // Each run uses fresh numbers, so a database that already holds earlier runs still works.
  const run = Date.now().toString().slice(-7);
  const phone = (n: number) => `+88017${run}${n}`;
  const who = (n: number, subject = `sms|${run}-${n}`) => ({
    issuer: ISSUER,
    subject,
    phone: phone(n),
  });

  await t.test('a registration stores a member, the consents and an event together', async () => {
    const account = await service.register(agency, who(1), registration, 'req-1');
    assert.equal(account.role, 'member');
    assert.equal(account.displayName, 'Rahim');

    const row = await admin.query(
      `SELECT role, status, phone_e164, phone_verified_at IS NOT NULL AS verified, locale, auth_issuer
       FROM matrimony.accounts WHERE id=$1`,
      [account.id],
    );
    assert.deepEqual(row.rows[0], {
      role: 'member',
      status: 'active',
      phone_e164: phone(1),
      verified: true,
      locale: 'bn',
      auth_issuer: ISSUER,
    });

    const consents = await admin.query(
      `SELECT purpose, document_version, action FROM matrimony.consent_events WHERE account_id=$1 ORDER BY purpose`,
      [account.id],
    );
    assert.deepEqual(consents.rows, [
      { purpose: 'privacy', document_version: PRIVACY_VERSION, action: 'accepted' },
      { purpose: 'terms', document_version: TERMS_VERSION, action: 'accepted' },
    ]);

    const events = await admin.query(
      `SELECT event->>'type' AS type, event->>'correlationId' AS correlation
       FROM matrimony.event_outbox WHERE event->>'subjectId'=$1`,
      [account.id],
    );
    assert.deepEqual(events.rows, [{ type: 'account.registered', correlation: 'req-1' }]);
  });

  await t.test('registering for someone else records that consent too', async () => {
    const account = await service.register(
      agency,
      who(2),
      { ...registration, onBehalfOfOther: true },
      'c',
    );
    const consents = await admin.query(
      `SELECT purpose FROM matrimony.consent_events WHERE account_id=$1 ORDER BY purpose`,
      [account.id],
    );
    assert.deepEqual(
      consents.rows.map((r) => r.purpose),
      ['privacy', 'profile_representation', 'terms'],
    );
  });

  await t.test(
    'registering again as the same person is a login, not a second account',
    async () => {
      const first = await service.register(agency, who(3), registration, 'c');
      const again = await service.register(agency, who(3), registration, 'c2');
      assert.equal(again.id, first.id);
      const count = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.accounts WHERE auth_subject=$1`,
        [`sms|${run}-3`],
      );
      assert.equal(count.rows[0].n, 1);
      const consents = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.consent_events WHERE account_id=$1`,
        [first.id],
      );
      assert.equal(consents.rows[0].n, 2, 'nothing recorded a second time');
    },
  );

  await t.test('a number that belongs to a different identity is refused', async () => {
    await service.register(agency, who(4), registration, 'c');
    await assert.rejects(
      service.register(agency, who(4, `sms|${run}-someone-else`), registration, 'c'),
      code(409, 'PHONE_ALREADY_REGISTERED'),
    );
    const count = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.accounts WHERE phone_e164=$1`,
      [phone(4)],
    );
    assert.equal(count.rows[0].n, 1);
  });

  await t.test('the same number can register at another agency, separately', async () => {
    const a = await service.register(agency, who(5), registration, 'c');
    const b = await service.register(otherAgency, who(5), registration, 'c');
    assert.notEqual(a.id, b.id);
    assert.equal(b.agencyId, otherAgency);
  });

  await t.test('simultaneous registrations of one person end with one account', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.register(agency, who(6), registration, 'c')),
    );
    const accounts = results.filter((r) => r.status === 'fulfilled');
    assert.ok(accounts.length >= 1);
    const ids = new Set(
      accounts.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id),
    );
    assert.equal(ids.size, 1, 'every request that succeeded got the same account');
    const count = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.accounts WHERE auth_subject=$1`,
      [`sms|${run}-6`],
    );
    assert.equal(count.rows[0].n, 1);
    // Anything that failed failed cleanly, not with a half-created account.
    for (const failure of results.filter((r) => r.status === 'rejected')) {
      assert.ok(
        (failure as PromiseRejectedResult).reason instanceof AppError,
        String((failure as PromiseRejectedResult).reason),
      );
    }
  });

  await t.test('an account that cannot log in is not registered over', async () => {
    await admin.query(
      `INSERT INTO matrimony.accounts(agency_id,role,display_name,phone_e164,auth_issuer,auth_subject,status)
       VALUES ($1,'member','Off',$2,$3,$4,'disabled')`,
      [agency, phone(7), ISSUER, `sms|${run}-7`],
    );
    await assert.rejects(
      service.register(agency, who(7), registration, 'c'),
      code(403, 'ACCOUNT_NOT_ACTIVE'),
    );
  });

  await t.test(
    'the application cannot change an account afterwards or delete consent',
    async () => {
      const account = await service.register(agency, who(8), registration, 'c');
      await assert.rejects(
        db.transaction(agency, (tx) =>
          tx.query(`UPDATE matrimony.accounts SET role='admin' WHERE id=$1`, [account.id]),
        ),
      );
      await assert.rejects(
        db.transaction(agency, (tx) =>
          tx.query(`DELETE FROM matrimony.consent_events WHERE account_id=$1`, [account.id]),
        ),
      );
      await assert.rejects(
        db.transaction(agency, (tx) =>
          tx.query(`UPDATE matrimony.consent_events SET action='withdrawn' WHERE account_id=$1`, [
            account.id,
          ]),
        ),
      );
    },
  );

  await t.test('another agency cannot read this account or its consents', async () => {
    const account = await service.register(agency, who(9), registration, 'c');
    const seen = await db.transaction(otherAgency, async (tx) => ({
      accounts: (await tx.query(`SELECT id FROM matrimony.accounts WHERE id=$1`, [account.id]))
        .rowCount,
      consents: (
        await tx.query(`SELECT id FROM matrimony.consent_events WHERE account_id=$1`, [account.id])
      ).rowCount,
    }));
    assert.deepEqual(seen, { accounts: 0, consents: 0 });
  });
});
