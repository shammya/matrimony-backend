import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { clientInputSchema } from '../../src/bo/client.js';
import { Database } from '../../src/db/config/database.js';
import { CandidateRepository } from '../../src/db/raw/repository/candidate-repository.js';
import { ClientRepository } from '../../src/db/raw/repository/client-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../../src/db/raw/repository/review-repository.js';
import { CandidateDbService } from '../../src/db/service/candidate-db-service.js';
import { ClientDbService } from '../../src/db/service/client-db-service.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { ReviewProcess } from '../../src/process/review-process.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { ClientService } from '../../src/service/client-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';
import { LocalFileStorage } from '../../src/storage/repository/local-file-storage.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date();
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('candidate lists on real PostgreSQL', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);

  // Every run gets its own agencies, so profiles left by earlier runs never take part.
  const tag = randomUUID().slice(0, 8);
  const agencyId = randomUUID();
  const elsewhereId = randomUUID();
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,$2,$3,'Candidates one'),($4,$5,$6,'Candidates two')`,
    [
      agencyId,
      `cand-${tag}`,
      `cand-${tag}.localhost`,
      elsewhereId,
      `cand2-${tag}`,
      `cand2-${tag}.localhost`,
    ],
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

  const silent = pino({ level: 'silent' });
  const profiles = new ProfileService(
    new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
  );
  const reviews = new ReviewService(
    new ReviewDbService(db, new ReviewRepository(), new ProfileRepository(), new EventRepository()),
  );
  const clients = new ClientService(
    new ClientDbService(db, new ClientRepository(), new EventRepository()),
    profiles,
  );
  const candidates = new CandidateService(
    new CandidateDbService(db, new CandidateRepository(), new EventRepository()),
    silent,
  );

  const account = async (role: ProfileActor['role'], name: string, inAgency = agencyId) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
       VALUES ($1,$2,$3,$4,'active',$5,'https://test.example',$6)`,
      [id, inAgency, role, name, `${id}@example.com`, id],
    );
    return { id, actor: { agencyId: inAgency, accountId: id, role } as ProfileActor };
  };
  const boss = await account('admin', 'Boss');
  const abir = await account('agent', 'Abir');
  const rival = await account('agent', 'Rival');
  const outsider = await account('admin', 'Outsider', elsewhereId);

  const BASE = {
    dateOfBirth: '1996-05-12',
    maritalStatus: 'never_married',
    heightCm: 165,
    religionCode: 'islam',
    currentDistrictCode: 'dhaka',
    highestDegreeCode: 'bachelors',
    occupationCode: 'salaried',
  };
  /** A published client: created by staff, sent for review and approved. */
  const published = async (
    name: string,
    profile: Record<string, unknown>,
    preferences: Record<string, unknown> = {},
    options: { owner?: typeof abir; staff?: typeof boss; agency?: string; approve?: boolean } = {},
  ) => {
    const staff = options.staff ?? boss;
    const created = await clients.create(
      staff.actor,
      clientInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, ...profile },
        contact: { phone: '+8801712345678' },
        preferences,
        assignedAgentId: staff.actor.agencyId === agencyId ? (options.owner?.id ?? abir.id) : null,
      }),
      'c',
    );
    const sent = await clients.submit(
      staff.actor,
      created.id,
      created.detail.state.profile!.version,
      'c',
    );
    if (options.approve !== false)
      await reviews.approve(staff.actor, sent.state.pendingReview!.id, {}, 'c');
    return created.id;
  };
  const states = async (clientId: string) =>
    Object.fromEntries(
      (
        await admin.query(
          `SELECT candidate_profile_id AS id, state FROM matrimony.client_candidates WHERE client_profile_id = $1`,
          [clientId],
        )
      ).rows.map((row) => [row.id, row.state]),
    );

  const client = await published(
    'Client',
    { gender: 'male', dateOfBirth: '1990-01-01' },
    { professionCodes: ['doctor'] },
  );
  const doctor = await published('Doctor', { gender: 'female', professionCode: 'doctor' });
  const teacher = await published('Teacher', { gender: 'female', professionCode: 'teacher' });
  const youngDoctor = await published(
    'Young doctor wants younger',
    { gender: 'female', professionCode: 'doctor' },
    { ageMin: 18, ageMax: 25 },
  );
  const sameGender = await published('Other man', { gender: 'male', professionCode: 'doctor' });
  const waiting = await published(
    'Not yet approved',
    { gender: 'female', professionCode: 'doctor' },
    {},
    { approve: false },
  );
  const stranger = await published(
    'Elsewhere',
    { gender: 'female', professionCode: 'doctor' },
    {},
    {
      staff: outsider,
    },
  );

  await t.test(
    'only published profiles of the other gender in this agency are proposed, best first',
    async () => {
      const result = await candidates.generate(boss.actor, client);
      const ids = result.items.map((item) => item.candidateId);
      assert.deepEqual(new Set(ids), new Set([doctor, teacher, youngDoctor]));
      for (const excluded of [sameGender, waiting, stranger, client])
        assert.ok(!ids.includes(excluded));
      // The doctor who fits both ways is first. The one who wants someone younger is flagged, not removed.
      assert.equal(ids[0], doctor);
      const flagged = result.items.find((item) => item.candidateId === youngDoctor)!;
      assert.ok(flagged.reverse.some((r) => r.key === 'age' && r.outcome === 'unmet'));
      assert.ok(flagged.unmet > result.items[0]!.unmet);
      assert.equal(result.considered, 3);
      assert.equal(result.proposed, 3);
    },
  );

  await t.test('running again changes nothing: one row per candidate', async () => {
    await candidates.generate(boss.actor, client);
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.client_candidates WHERE client_profile_id = $1`,
      [client],
    );
    assert.equal(rows.rows[0].n, 3);
  });

  await t.test('two runs at once leave one row each and fail nobody', async () => {
    const results = await Promise.all([
      candidates.generate(boss.actor, client),
      candidates.generate(abir.actor, client),
      candidates.generate(boss.actor, client),
    ]);
    for (const r of results) assert.equal(r.items.length, 3);
    assert.equal(Object.keys(await states(client)).length, 3);
  });

  await t.test(
    'what staff removed never returns, and what they released is left alone',
    async () => {
      await admin.query(
        `UPDATE matrimony.client_candidates SET state = 'removed' WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
        [client, teacher],
      );
      await admin.query(
        `UPDATE matrimony.client_candidates SET state = 'released', met_count = 9 WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
        [client, youngDoctor],
      );
      const result = await candidates.generate(boss.actor, client);
      assert.deepEqual(
        result.items.map((i) => i.candidateId),
        [doctor],
      );
      assert.equal(result.considered, 1);
      const now = await states(client);
      assert.equal(now[teacher], 'removed');
      assert.equal(now[youngDoctor], 'released');
      const released = await admin.query(
        `SELECT met_count FROM matrimony.client_candidates WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
        [client, youngDoctor],
      );
      assert.equal(released.rows[0].met_count, 9);
      // Put them back as they were for the next test.
      await admin.query(
        `UPDATE matrimony.client_candidates SET state = 'proposed' WHERE client_profile_id = $1`,
        [client],
      );
    },
  );

  await t.test(
    'a proposal that is no longer eligible lapses, and returns when it is eligible again',
    async () => {
      await admin.query(`UPDATE matrimony.member_profiles SET status = 'paused' WHERE id = $1`, [
        doctor,
      ]);
      await candidates.generate(boss.actor, client);
      assert.equal((await states(client))[doctor], 'lapsed');
      assert.deepEqual(
        (await candidates.list(boss.actor, client, { state: 'lapsed', limit: 100 })).items.map(
          (i) => i.candidateId,
        ),
        [doctor],
      );
      await admin.query(`UPDATE matrimony.member_profiles SET status = 'active' WHERE id = $1`, [
        doctor,
      ]);
      await candidates.generate(boss.actor, client);
      assert.equal((await states(client))[doctor], 'proposed');
    },
  );

  await t.test('the list shows safe fields only, with both sides of the fit', async () => {
    const list = await candidates.list(abir.actor, client, { state: 'proposed', limit: 100 });
    const first = list.items[0]!;
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        'age',
        'candidateId',
        'currentDistrictCode',
        'forward',
        'fullName',
        'maritalStatus',
        'memberCode',
        'met',
        'occupationCode',
        'professionCode',
        'profileStatus',
        'proposedAt',
        'religionCode',
        'reverse',
        'state',
        'unknown',
        'unmet',
      ].sort(),
    );
    assert.equal(first.fullName, 'Doctor');
  });

  await t.test(
    'an agent reaches only their own client; another agency reaches nothing',
    async () => {
      await assert.rejects(
        candidates.generate(rival.actor, client),
        code(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        candidates.list(rival.actor, client, { state: 'proposed', limit: 10 }),
        code(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        candidates.generate(outsider.actor, client),
        code(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        candidates.list(outsider.actor, client, { state: 'proposed', limit: 10 }),
        code(404, 'PROFILE_NOT_FOUND'),
      );
      // The other agency's client is empty of this agency's profiles.
      const theirs = await published('Their client', { gender: 'male' }, {}, { staff: outsider });
      const result = await candidates.generate(outsider.actor, theirs);
      assert.deepEqual(
        result.items.map((i) => i.candidateId),
        [stranger],
      );
    },
  );

  await t.test('a profile that is not published yet cannot have a list', async () => {
    await assert.rejects(
      candidates.generate(boss.actor, waiting),
      code(409, 'PROFILE_NOT_PUBLISHED'),
    );
  });

  await t.test(
    'releasing respects the cap, removal frees a place, and every change is recorded',
    async () => {
      await candidates.generate(boss.actor, client);
      const defaults = await candidates.settings(abir.actor, client);
      assert.equal(defaults.cap, 50);
      assert.equal(defaults.isDefault, true);
      assert.equal(defaults.releasedCount, 0);

      const saved = await candidates.saveSettings(
        abir.actor,
        client,
        { cap: 2, visibleFields: ['fullName', 'age', 'photo'] },
        'c',
      );
      assert.equal(saved.isDefault, false);
      assert.deepEqual(saved.visibleFields, ['fullName', 'age', 'photo']);

      // Three do not fit in a window of two: nothing is released.
      await assert.rejects(
        candidates.release(
          abir.actor,
          client,
          { candidateIds: [doctor, teacher, youngDoctor] },
          'c',
        ),
        (e) => code(409, 'CAP_REACHED')(e) && (e as AppError).details?.room === 2,
      );
      assert.deepEqual(
        Object.values(await states(client)).filter((s) => s === 'released'),
        [],
      );

      const first = await candidates.release(
        abir.actor,
        client,
        { candidateIds: [doctor, teacher] },
        'c',
      );
      assert.deepEqual(new Set(first.done), new Set([doctor, teacher]));
      await assert.rejects(
        candidates.release(abir.actor, client, { candidateIds: [youngDoctor] }, 'c'),
        (e) => code(409, 'CAP_REACHED')(e) && (e as AppError).details?.room === 0,
      );
      await assert.rejects(
        candidates.saveSettings(abir.actor, client, { cap: 1, visibleFields: ['fullName'] }, 'c'),
        (e) => code(409, 'CAP_BELOW_RELEASED')(e) && (e as AppError).details?.released === 2,
      );

      // Removing one frees a place; the removed profile never comes back from a later run.
      assert.deepEqual(
        (await candidates.remove(abir.actor, client, { candidateIds: [teacher] }, 'c')).done,
        [teacher],
      );
      assert.equal(
        (await candidates.release(abir.actor, client, { candidateIds: [youngDoctor] }, 'c'))
          .done[0],
        youngDoctor,
      );
      await candidates.generate(boss.actor, client);
      const now = await states(client);
      assert.equal(now[teacher], 'removed');
      assert.equal(now[doctor], 'released');
      assert.equal(now[youngDoctor], 'released');

      const events = await admin.query(
        `SELECT event->>'type' AS type FROM matrimony.event_outbox
        WHERE agency_id = $1 AND event->>'subjectId' = $2 AND event->>'type' LIKE 'candidates.%'`,
        [agencyId, client],
      );
      const types = events.rows.map((row) => row.type);
      for (const type of [
        'candidates.settings_changed',
        'candidates.released',
        'candidates.removed',
      ])
        assert.ok(types.includes(type), type);
    },
  );

  await t.test(
    'two staff releasing the same profile at once release it once, and fail nobody',
    async () => {
      await admin.query(
        `UPDATE matrimony.client_candidates SET state = 'proposed' WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
        [client, teacher],
      );
      await candidates.saveSettings(
        boss.actor,
        client,
        { cap: 10, visibleFields: ['fullName'] },
        'c',
      );
      const results = await Promise.all([
        candidates.release(boss.actor, client, { candidateIds: [teacher] }, 'c'),
        candidates.release(abir.actor, client, { candidateIds: [teacher] }, 'c'),
      ]);
      assert.equal(results.flatMap((r) => r.done).length, 1);
      assert.equal(results.flatMap((r) => r.skipped).length, 1);
      assert.equal((await states(client))[teacher], 'released');
    },
  );

  await t.test('a profile that stopped being published cannot be released', async () => {
    await admin.query(`UPDATE matrimony.member_profiles SET status = 'paused' WHERE id = $1`, [
      youngDoctor,
    ]);
    await admin.query(
      `UPDATE matrimony.client_candidates SET state = 'proposed' WHERE client_profile_id = $1 AND candidate_profile_id = $2`,
      [client, youngDoctor],
    );
    const outcome = await candidates.release(
      boss.actor,
      client,
      { candidateIds: [youngDoctor] },
      'c',
    );
    assert.deepEqual(outcome, { done: [], skipped: [youngDoctor] });
    await admin.query(`UPDATE matrimony.member_profiles SET status = 'active' WHERE id = $1`, [
      youngDoctor,
    ]);
  });

  await t.test(
    'an agent reaches only their own client for settings, release and removal',
    async () => {
      const settings = { cap: 5, visibleFields: ['fullName' as const] };
      for (const act of [
        () => candidates.settings(rival.actor, client),
        () => candidates.saveSettings(rival.actor, client, settings, 'c'),
        () => candidates.release(rival.actor, client, { candidateIds: [doctor] }, 'c'),
        () => candidates.remove(rival.actor, client, { candidateIds: [doctor] }, 'c'),
        () => candidates.settings(outsider.actor, client),
        () => candidates.release(outsider.actor, client, { candidateIds: [doctor] }, 'c'),
      ])
        await assert.rejects(act(), code(404, 'PROFILE_NOT_FOUND'));
    },
  );

  await t.test('the application cannot delete a candidate row', async () => {
    await assert.rejects(
      pool.query(`DELETE FROM matrimony.client_candidates`),
      /permission denied/,
    );
  });

  await t.test(
    'approving a profile refreshes its own list; a failure never undoes the approval',
    async () => {
      const storage = new LocalFileStorage(
        await (
          await import('node:fs/promises')
        ).mkdtemp(
          (await import('node:path')).join((await import('node:os')).tmpdir(), 'matrimony-cand-'),
        ),
      );
      const process = new ReviewProcess(reviews, storage, candidates, silent);
      const created = await clients.create(
        boss.actor,
        clientInputSchema(NOW).parse({
          profile: { fullName: 'Fresh client', ...BASE, gender: 'male' },
          contact: { phone: '+8801712345678' },
          preferences: { professionCodes: ['doctor'] },
          assignedAgentId: abir.id,
        }),
        'c',
      );
      const sent = await clients.submit(
        boss.actor,
        created.id,
        created.detail.state.profile!.version,
        'c',
      );
      assert.equal(Object.keys(await states(created.id)).length, 0);
      const detail = await process.approve(boss.actor, sent.state.pendingReview!.id, {}, 'c');
      assert.equal(detail.status, 'approved');
      // Nobody pressed the button, yet the list exists.
      assert.ok(Object.keys(await states(created.id)).length >= 3);

      const failing = new ReviewProcess(
        reviews,
        storage,
        {
          refresh: async () => {
            throw new Error('boom');
          },
        },
        silent,
      );
      const second = await clients.create(
        boss.actor,
        clientInputSchema(NOW).parse({
          profile: { fullName: 'Second client', ...BASE, gender: 'male' },
          contact: { phone: '+8801712345678' },
          assignedAgentId: abir.id,
        }),
        'c',
      );
      const secondSent = await clients.submit(
        boss.actor,
        second.id,
        second.detail.state.profile!.version,
        'c',
      );
      const done = await failing.approve(boss.actor, secondSent.state.pendingReview!.id, {}, 'c');
      assert.equal(done.status, 'approved');
      const row = await admin.query(`SELECT status FROM matrimony.member_profiles WHERE id = $1`, [
        second.id,
      ]);
      assert.equal(row.rows[0].status, 'active');
    },
  );
});
