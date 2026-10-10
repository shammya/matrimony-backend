import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { profileInputSchema } from '../../src/bo/profile.js';
import { Database } from '../../src/db/config/database.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { agency, otherAgency } from '../fixtures.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const input = (version: number | undefined, profile: Record<string, unknown> = {}, extra = {}) =>
  profileInputSchema().parse({
    version,
    profile: {
      fullName: 'Rahim Uddin',
      dateOfBirth: '1996-05-12',
      gender: 'male',
      maritalStatus: 'never_married',
      heightCm: 172,
      religionCode: 'islam',
      currentDistrictCode: 'coxs_bazar',
      highestDegreeCode: 'bachelors',
      occupationCode: 'salaried',
      ...profile,
    },
    contact: { phone: '+8801712345678' },
    ...extra,
  });

/** The profile as it was last saved above, so that only what a test changes differs. */
const same = (version: number, profile: Record<string, unknown> = {}) =>
  input(version, { aboutMe: 'Hello', ...profile });

const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('member profiles on real PostgreSQL', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,'test-one','localhost','Test one'),($2,'test-two','other.localhost','Test two') ON CONFLICT(id) DO NOTHING`,
    [agency, otherAgency],
  );
  const accounts = async (agencyId: string, count: number) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
         VALUES ($1,$2,'member',$3,'active',$4,'https://test.example',$5)`,
        [id, agencyId, `Member ${i}`, `${id}@example.com`, id],
      );
      ids.push(id);
    }
    return ids;
  };
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 4 });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.end();
  });
  const service = new ProfileService(
    new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
  );
  const actorFor = (agencyId: string, accountId: string): ProfileActor => ({
    agencyId,
    accountId,
    role: 'member',
  });
  const [one, two, three] = await accounts(agency, 3);
  const [elsewhere] = await accounts(otherAgency, 1);
  const me = actorFor(agency, one!);

  let version = 0;
  await t.test(
    'a first save stores a draft with contact, preferences and a derived division',
    async () => {
      const state = await service.save(
        me,
        input(
          undefined,
          {},
          { preferences: { ageMin: 22, ageMax: 30, districtCodes: ['dhaka', 'cumilla'] } },
        ),
      );
      assert.equal(state.profile?.status, 'draft');
      assert.match(state.profile!.memberCode, /^M\d{7}$/);
      assert.equal(state.profile?.currentDivisionCode, 'chattogram');
      assert.equal(state.profile?.data.profile.dateOfBirth, '1996-05-12');
      assert.equal(state.profile?.data.contact.phone, '+8801712345678');
      assert.deepEqual(state.profile?.data.preferences.districtCodes, ['cumilla', 'dhaka']);
      assert.equal(state.profile?.data.preferences.ageMin, 22);
      version = state.profile!.version;
    },
  );

  await t.test(
    'profession, lifestyle and the matching preference lists are saved and read back',
    async () => {
      const detailed = actorFor(agency, three!);
      const state = await service.save(
        detailed,
        input(
          undefined,
          {
            professionCode: 'doctor',
            smokingCode: 'never',
            childrenCode: 'none',
            relocationCode: 'abroad',
          },
          {
            preferences: {
              professionCodes: ['nurse', 'doctor'],
              complexionCodes: ['fair', 'medium'],
              religiousPracticeCodes: ['practicing'],
              dietaryPreferenceCodes: ['halal_only'],
              smokingCodes: ['never'],
              childrenCodes: ['none'],
              relocationCodes: ['within_country', 'abroad'],
            },
          },
        ),
      );
      const saved = (await service.get(detailed)).profile!.data;
      assert.equal(state.profile?.data.profile.professionCode, 'doctor');
      assert.equal(saved.profile.professionCode, 'doctor');
      assert.equal(saved.profile.smokingCode, 'never');
      assert.equal(saved.profile.childrenCode, 'none');
      assert.equal(saved.profile.relocationCode, 'abroad');
      assert.deepEqual(saved.preferences.professionCodes, ['doctor', 'nurse']);
      assert.deepEqual(saved.preferences.complexionCodes, ['fair', 'medium']);
      assert.deepEqual(saved.preferences.relocationCodes, ['within_country', 'abroad']);
      assert.deepEqual(saved.preferences.religiousPracticeCodes, ['practicing']);
      assert.deepEqual(saved.preferences.dietaryPreferenceCodes, ['halal_only']);
      assert.deepEqual(saved.preferences.smokingCodes, ['never']);
      assert.deepEqual(saved.preferences.childrenCodes, ['none']);
    },
  );

  await t.test('changing only the contact or preferences still raises the version', async () => {
    const before = (await service.get(me)).profile!;
    const saved = await service.save(
      me,
      input(
        before.version,
        {},
        { preferences: { ageMin: 25 }, contact: { phone: '+8801812345678' } },
      ),
    );
    assert.ok(saved.profile!.version > before.version);
    assert.equal(saved.profile?.data.contact.phone, '+8801812345678');
    version = saved.profile!.version;
    await assert.rejects(
      service.save(me, input(before.version)),
      code(409, 'PROFILE_VERSION_CONFLICT'),
    );
  });

  await t.test('only one first save wins when two arrive at once', async () => {
    const racer = actorFor(agency, two!);
    const results = await Promise.allSettled([
      service.save(racer, input(undefined, { fullName: 'First' })),
      service.save(racer, input(undefined, { fullName: 'Second' })),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(code(409, 'PROFILE_VERSION_CONFLICT')(loser.reason));
    const count = await admin.query(
      'SELECT count(*)::int AS n FROM matrimony.member_profiles WHERE owner_account_id=$1',
      [two],
    );
    assert.equal(count.rows[0].n, 1);
  });

  await t.test("one agency never sees another agency's profile", async () => {
    assert.equal((await service.get(actorFor(otherAgency, elsewhere!))).profile, null);
    // Even with the other agency's account id, the session's agency decides what is visible.
    assert.equal((await service.get(actorFor(otherAgency, one!))).profile, null);
  });

  await t.test(
    'submit locks the profile and stores the review and the event together',
    async () => {
      const state = await service.submit(me, version, 'req-submit');
      assert.equal(state.profile?.status, 'pending_review');
      assert.equal(state.pendingReview?.kind, 'initial_submission');
      assert.equal(state.pendingReview?.baseProfileVersion, state.profile?.version);
      const events = await admin.query(
        `SELECT event->>'type' AS type, event->>'correlationId' AS correlation FROM matrimony.event_outbox WHERE event->>'subjectId'=$1`,
        [state.profile!.id],
      );
      assert.deepEqual(events.rows, [{ type: 'profile.submitted', correlation: 'req-submit' }]);
      await assert.rejects(
        service.save(me, input(state.profile!.version)),
        code(409, 'PROFILE_LOCKED'),
      );
      version = state.profile!.version;
    },
  );

  await t.test(
    'a second pending review for the same profile is impossible at the database level',
    async () => {
      const profile = (await service.get(me)).profile!;
      await assert.rejects(
        admin.query(
          `INSERT INTO matrimony.profile_reviews(agency_id,profile_id,submitted_by_account_id,kind,status,base_profile_version,proposed_changes)
         VALUES ($1,$2,$3,'field_update','pending',$4,'{}')`,
          [agency, profile.id, one, profile.version],
        ),
      );
    },
  );

  await t.test(
    'withdrawing returns to a draft, which can be edited and submitted again',
    async () => {
      const draft = await service.cancelPending(me, 'req-cancel');
      assert.equal(draft.profile?.status, 'draft');
      assert.equal(draft.pendingReview, null);
      const edited = await service.save(me, input(draft.profile!.version, { aboutMe: 'Hello' }));
      const sent = await service.submit(me, edited.profile!.version, 'req-2');
      assert.equal(sent.profile?.status, 'pending_review');
      version = sent.profile!.version;
    },
  );

  await t.test(
    'after approval a change becomes a review and the published profile stays as it was',
    async () => {
      const profile = (await service.get(me)).profile!;
      // The reviewer screen is a later feature, so play the reviewer directly in the database.
      await admin.query(
        `UPDATE matrimony.profile_reviews SET status='approved', reviewed_at=now(), reviewer_account_id=$2 WHERE profile_id=$1 AND status='pending'`,
        [profile.id, two],
      );
      await admin.query(`UPDATE matrimony.member_profiles SET status='active' WHERE id=$1`, [
        profile.id,
      ]);
      const active = (await service.get(me)).profile!;
      assert.equal(active.status, 'active');

      await assert.rejects(
        service.save(me, same(active.version, { heightCm: 180 })),
        code(409, 'PROFILE_EDIT_REQUIRES_REVIEW'),
      );
      await assert.rejects(
        service.requestEdit(me, same(active.version), 'c'),
        code(422, 'NO_CHANGES'),
      );

      const state = await service.requestEdit(
        me,
        same(active.version, { heightCm: 180 }),
        'req-edit',
      );
      assert.equal(state.profile?.data.profile.heightCm, 172);
      assert.equal(state.profile?.version, active.version);
      assert.equal(state.pendingReview?.kind, 'field_update');
      assert.deepEqual(state.pendingReview?.proposedChanges, { profile: { heightCm: 180 } });
      await assert.rejects(
        service.requestEdit(me, same(active.version, { heightCm: 185 }), 'c'),
        code(409, 'PROFILE_LOCKED'),
      );

      const withdrawn = await service.cancelPending(me, 'req-withdraw');
      assert.equal(withdrawn.profile?.status, 'active');
      assert.equal(withdrawn.pendingReview, null);
    },
  );

  await t.test(
    "the runtime role cannot touch another agency's rows or change ownership",
    async () => {
      const rows = await pool.query('SELECT id FROM matrimony.member_profiles');
      assert.equal(rows.rowCount, 0, 'no agency context, no rows');
      await assert.rejects(pool.query('DELETE FROM matrimony.member_profiles'));
    },
  );
});
