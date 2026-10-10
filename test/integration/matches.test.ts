import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { clientInputSchema } from '../../src/bo/client.js';
import { matchQuerySchema } from '../../src/bo/matches.js';
import { profileInputSchema } from '../../src/bo/profile.js';
import { variantKey } from '../../src/bo/photo.js';
import { Database } from '../../src/db/config/database.js';
import { CandidateRepository } from '../../src/db/raw/repository/candidate-repository.js';
import { ClientRepository } from '../../src/db/raw/repository/client-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { MatchRepository } from '../../src/db/raw/repository/match-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../../src/db/raw/repository/review-repository.js';
import { CandidateDbService } from '../../src/db/service/candidate-db-service.js';
import { ClientDbService } from '../../src/db/service/client-db-service.js';
import { MatchDbService } from '../../src/db/service/match-db-service.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { MatchProcess } from '../../src/process/match-process.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { ClientService } from '../../src/service/client-service.js';
import { MatchService } from '../../src/service/match-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';
import { LocalFileStorage } from '../../src/storage/repository/local-file-storage.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date();
const refused = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;
const query = (over: Record<string, unknown> = {}) => matchQuerySchema.parse(over);

await test("a member's matches on real PostgreSQL", async (t) => {
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
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,$2,$3,'Matches one'),($4,$5,$6,'Matches two')`,
    [
      agencyId,
      `mat-${tag}`,
      `mat-${tag}.localhost`,
      elsewhereId,
      `mat2-${tag}`,
      `mat2-${tag}.localhost`,
    ],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const db = new Database(new Pool({ connectionString: runtimeUrl.href, max: 6 }));
  const directory = await mkdtemp(join(tmpdir(), 'matrimony-matches-'));
  t.after(async () => {
    await db.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

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
    pino({ level: 'silent' }),
  );
  const storage = new LocalFileStorage(directory);
  const matches = new MatchProcess(
    new MatchService(new MatchDbService(db, new MatchRepository(), new CandidateRepository())),
    storage,
  );
  const service = new MatchService(
    new MatchDbService(db, new MatchRepository(), new CandidateRepository()),
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
  const foreignBoss = await account('admin', 'Foreign boss', elsewhereId);
  const BASE = {
    maritalStatus: 'never_married',
    heightCm: 165,
    religionCode: 'islam',
    currentDistrictCode: 'dhaka',
    highestDegreeCode: 'bachelors',
    occupationCode: 'salaried',
  };

  /** A published profile of a client the agency runs. Its phone is a secret that must never reach a match. */
  const published = async (name: string, profile: Record<string, unknown>) => {
    const created = await clients.create(
      boss.actor,
      clientInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, dateOfBirth: '1998-01-01', ...profile },
        contact: { phone: '+8801799999999', permanentAddress: 'SECRET ADDRESS' },
      }),
      'c',
    );
    const sent = await clients.submit(
      boss.actor,
      created.id,
      created.detail.state.profile!.version,
      'c',
    );
    await reviews.approve(boss.actor, sent.state.pendingReview!.id, {}, 'c');
    return created.id;
  };
  /** A member who runs their own profile, published. */
  const memberWithProfile = async (name: string, inAgency = agencyId) => {
    const me = await account('member', name, inAgency);
    const saved = await profiles.save(
      me.actor,
      profileInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, gender: 'male', dateOfBirth: '1990-01-01' },
        contact: { phone: '+8801711111111' },
      }),
    );
    const sent = await profiles.submit(me.actor, saved.profile!.version, 'c');
    await reviews.approve(
      inAgency === agencyId ? boss.actor : foreignBoss.actor,
      sent.pendingReview!.id,
      {},
      'c',
    );
    return { ...me, profileId: saved.profile!.id };
  };

  const me = await memberWithProfile('Client Man');
  const other = await memberWithProfile('Other Man');
  const A = await published('Ayesha', {
    gender: 'female',
    professionCode: 'doctor',
    currentDistrictCode: 'dhaka',
    religionCode: 'islam',
    dateOfBirth: '1998-01-01',
    highestDegreeCode: 'masters',
    aboutMe: 'About Ayesha',
    hobbies: 'Reading',
    heightCm: 175,
    monthlyIncomeBandCode: '100k_200k',
    familyStatusCode: 'upper_middle',
    originDistrictCode: 'sylhet',
  });
  const B = await published('Bushra', {
    gender: 'female',
    professionCode: 'nurse',
    currentDistrictCode: 'chattogram',
    religionCode: 'islam',
    dateOfBirth: '2002-01-01',
    highestDegreeCode: 'hsc',
    heightCm: 155,
    monthlyIncomeBandCode: '20k_50k',
    familyStatusCode: 'lower_middle',
    originDistrictCode: 'dhaka',
  });
  const C = await published('Chitra', {
    gender: 'female',
    professionCode: 'teacher',
    currentDistrictCode: 'dhaka',
    religionCode: 'hinduism',
    dateOfBirth: '1995-06-06',
    highestDegreeCode: 'bachelors',
    heightCm: 165,
    monthlyIncomeBandCode: '50k_100k',
    familyStatusCode: 'middle',
    originDistrictCode: 'chattogram',
  });
  const D = await published('Dilruba', { gender: 'female', professionCode: 'doctor' });

  await candidates.generate(boss.actor, me.profileId);
  // Released one at a time, so each has its own moment and the order is certain.
  for (const id of [A, B, C]) {
    await candidates.release(boss.actor, me.profileId, { candidateIds: [id] }, 'c');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const names = async (actor: ProfileActor, over: Record<string, unknown> = {}) =>
    (await service.page(actor, query(over))).items.map((item) => item.fullName);

  await t.test('a member sees only what was released to them, newest first', async () => {
    const page = await service.page(me.actor, query());
    assert.deepEqual(
      page.items.map((i) => i.fullName),
      ['Chitra', 'Bushra', 'Ayesha'],
    );
    assert.equal(page.profileStatus, 'active');
    assert.equal(page.releasedTotal, 3);
    // Dilruba was proposed but never released.
    assert.ok(!page.items.some((i) => i.candidateId === D));
  });

  await t.test(
    'the list is a preview: headline fields only, no contact, no degree, no about',
    async () => {
      const ayesha = (await service.page(me.actor, query({ profession: 'doctor' }))).items[0]!;
      assert.deepEqual(Object.keys(ayesha).sort(), [
        'age',
        'candidateId',
        'connection',
        'currentDistrictCode',
        'fullName',
        'hasPhoto',
        'memberCode',
        'position',
        'professionCode',
        'religionCode',
      ]);
      assert.equal(ayesha.fullName, 'Ayesha');
      assert.equal(ayesha.age, 28);
      assert.equal(ayesha.connection, null);
      assert.equal(JSON.stringify(ayesha).includes('SECRET'), false);
      assert.equal(JSON.stringify(ayesha).includes('+88017'), false);
    },
  );

  await t.test(
    'the full view carries every field staff allowed, and never a contact or an address',
    async () => {
      const detail = await service.detail(me.actor, A);
      assert.equal(detail.profile.fullName, 'Ayesha');
      assert.equal(detail.profile.aboutMe, 'About Ayesha');
      assert.equal(detail.profile.age, 28);
      assert.equal(detail.profile.professionCode, 'doctor');
      // Hobbies and education are not among the default fields: not even read.
      assert.equal('hobbies' in detail.profile, false);
      assert.equal('highestDegreeCode' in detail.profile, false);
      assert.equal(detail.connection, null);
      assert.equal(detail.contact, null);
      assert.deepEqual(detail.visibleFields.slice(0, 2), ['fullName', 'age']);
      assert.equal(JSON.stringify(detail).includes('SECRET'), false);
      assert.equal(JSON.stringify(detail).includes('+88017'), false);
      // Someone proposed but never released, and someone in no window, are not theirs to open.
      await assert.rejects(service.detail(me.actor, D), refused(404, 'PROFILE_NOT_FOUND'));
      await assert.rejects(
        service.detail(me.actor, other.profileId),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(service.detail(boss.actor, A), refused(403, 'ROLE_FORBIDDEN'));
    },
  );

  await t.test('another member, and another agency, see nothing of this window', async () => {
    assert.deepEqual(await names(other.actor), []);
    const foreign = await memberWithProfile('Foreign Man', elsewhereId);
    assert.deepEqual(await names(foreign.actor), []);
    assert.equal((await service.page(foreign.actor, query())).releasedTotal, 0);
  });

  await t.test(
    'search inside the window: member code, age, religion, profession, district',
    async () => {
      const code = (await service.page(me.actor, query({ profession: 'nurse' }))).items[0]!
        .memberCode;
      assert.deepEqual(await names(me.actor, { q: code.toLowerCase() }), ['Bushra']);
      assert.deepEqual(await names(me.actor, { q: 'M0000000' }), []);
      assert.deepEqual(await names(me.actor, { district: 'dhaka' }), ['Chitra', 'Ayesha']);
      assert.deepEqual(await names(me.actor, { religion: 'hinduism' }), ['Chitra']);
      assert.deepEqual(await names(me.actor, { profession: 'doctor' }), ['Ayesha']);
      assert.deepEqual(await names(me.actor, { ageMin: 25, ageMax: 30 }), ['Ayesha']);
      assert.deepEqual(await names(me.actor, { ageMax: 24 }), ['Bushra']);
      assert.deepEqual(await names(me.actor, { ageMin: 40 }), []);
      assert.deepEqual(await names(me.actor, { district: 'dhaka', religion: 'islam' }), ['Ayesha']);
    },
  );

  await t.test('a hidden field cannot be searched, so it cannot be found out', async () => {
    // Education is not in the default fields: asking for it is refused, not quietly empty.
    await assert.rejects(
      service.page(me.actor, query({ educationMin: 'masters' })),
      refused(400, 'FILTER_NOT_AVAILABLE'),
    );
    await candidates.saveSettings(
      boss.actor,
      me.profileId,
      { cap: 50, visibleFields: ['fullName', 'highestDegreeCode'] },
      'c',
    );
    assert.deepEqual(await names(me.actor, { educationMin: 'bachelors' }), ['Chitra', 'Ayesha']);
    assert.deepEqual(await names(me.actor, { educationMin: 'masters' }), ['Ayesha']);
    // And now the district is hidden: it neither shows nor filters.
    await assert.rejects(
      service.page(me.actor, query({ district: 'dhaka' })),
      refused(400, 'FILTER_NOT_AVAILABLE'),
    );
    const [first] = (await service.page(me.actor, query())).items;
    assert.equal('currentDistrictCode' in first!, false);
    assert.equal('aboutMe' in first!, false);
    // Education is shown in the full view, not the preview.
    assert.equal('highestDegreeCode' in first!, false);
    assert.equal(
      (await service.detail(me.actor, first!.candidateId)).profile.highestDegreeCode,
      'bachelors',
    );
    await candidates.saveSettings(
      boss.actor,
      me.profileId,
      {
        cap: 50,
        visibleFields: [
          'fullName',
          'age',
          'photo',
          'aboutMe',
          'professionCode',
          'currentDistrictCode',
          'religionCode',
        ],
      },
      'c',
    );
  });

  await t.test(
    'advanced search: height, income, family status and district of origin',
    async () => {
      const everyone = ['Chitra', 'Bushra', 'Ayesha'];
      // None of these are shown by default, so none can be searched.
      for (const hidden of [
        { heightMin: 170 },
        { incomeMin: '50k_100k' },
        { familyStatusMin: 'middle' },
        { originDistrict: 'dhaka' },
      ])
        await assert.rejects(
          service.page(me.actor, query(hidden)),
          refused(400, 'FILTER_NOT_AVAILABLE'),
        );

      await candidates.saveSettings(
        boss.actor,
        me.profileId,
        {
          cap: 50,
          visibleFields: [
            'fullName',
            'heightCm',
            'monthlyIncomeBandCode',
            'familyStatusCode',
            'originDistrictCode',
          ],
        },
        'c',
      );
      assert.deepEqual(await names(me.actor), everyone);
      assert.deepEqual(await names(me.actor, { heightMin: 170 }), ['Ayesha']);
      assert.deepEqual(await names(me.actor, { heightMax: 160 }), ['Bushra']);
      assert.deepEqual(await names(me.actor, { heightMin: 160, heightMax: 170 }), ['Chitra']);
      assert.deepEqual(await names(me.actor, { incomeMin: '50k_100k' }), ['Chitra', 'Ayesha']);
      assert.deepEqual(await names(me.actor, { incomeMax: '50k_100k' }), ['Chitra', 'Bushra']);
      assert.deepEqual(await names(me.actor, { incomeMin: '50k_100k', incomeMax: '50k_100k' }), [
        'Chitra',
      ]);
      assert.deepEqual(await names(me.actor, { familyStatusMin: 'middle' }), ['Chitra', 'Ayesha']);
      assert.deepEqual(await names(me.actor, { familyStatusMin: 'upper' }), []);
      assert.deepEqual(await names(me.actor, { originDistrict: 'dhaka' }), ['Bushra']);
      // They combine, and a basic filter on a hidden field is still refused.
      assert.deepEqual(await names(me.actor, { heightMin: 160, familyStatusMin: 'upper_middle' }), [
        'Ayesha',
      ]);
      await assert.rejects(
        service.page(me.actor, query({ district: 'dhaka' })),
        refused(400, 'FILTER_NOT_AVAILABLE'),
      );
      // The preview shows only the headline fields, but the full view has these.
      const detail = await service.detail(me.actor, A);
      assert.deepEqual(
        [
          detail.profile.heightCm,
          detail.profile.monthlyIncomeBandCode,
          detail.profile.familyStatusCode,
          detail.profile.originDistrictCode,
        ],
        [175, '100k_200k', 'upper_middle', 'sylhet'],
      );
      assert.equal('heightCm' in (await service.page(me.actor, query())).items[0]!, false);
      await candidates.saveSettings(
        boss.actor,
        me.profileId,
        {
          cap: 50,
          visibleFields: [
            'fullName',
            'age',
            'photo',
            'aboutMe',
            'professionCode',
            'currentDistrictCode',
            'religionCode',
          ],
        },
        'c',
      );
    },
  );

  await t.test(
    'ranges that run backwards are refused, and a complexion filter does not exist',
    async () => {
      assert.throws(() => query({ heightMin: 180, heightMax: 150 }), /rangeOrder/);
      assert.throws(() => query({ incomeMin: 'above_200k', incomeMax: 'below_20k' }), /rangeOrder/);
      assert.throws(() => query({ complexion: 'fair' }), /Unrecognized key/);
    },
  );

  await t.test('pages follow one another without gaps or repeats', async () => {
    const first = await service.page(me.actor, query({ limit: 2 }));
    assert.equal(first.items.length, 2);
    assert.ok(first.next);
    const second = await service.page(me.actor, query({ limit: 2, after: first.next! }));
    assert.equal(second.items.length, 1);
    assert.equal(second.next, null);
    assert.deepEqual(
      [...first.items, ...second.items].map((i) => i.fullName),
      ['Chitra', 'Bushra', 'Ayesha'],
    );
  });

  await t.test(
    'a profile that stops being published, or is removed, leaves the window',
    async () => {
      await admin.query(`UPDATE matrimony.member_profiles SET status = 'paused' WHERE id = $1`, [
        B,
      ]);
      assert.deepEqual(await names(me.actor), ['Chitra', 'Ayesha']);
      assert.equal((await service.page(me.actor, query())).releasedTotal, 2);
      await admin.query(`UPDATE matrimony.member_profiles SET status = 'active' WHERE id = $1`, [
        B,
      ]);
      await candidates.remove(boss.actor, me.profileId, { candidateIds: [C] }, 'c');
      assert.deepEqual(await names(me.actor), ['Bushra', 'Ayesha']);
    },
  );

  await t.test(
    'a member whose own profile is not published gets an empty window and their status',
    async () => {
      const fresh = await account('member', 'Fresh');
      assert.equal((await service.page(fresh.actor, query())).profileStatus, null);
      const saved = await profiles.save(
        fresh.actor,
        profileInputSchema(NOW).parse({ profile: { fullName: 'Fresh', gender: 'male' } }),
      );
      assert.equal(saved.profile?.status, 'draft');
      const page = await service.page(fresh.actor, query());
      assert.deepEqual(page, {
        items: [],
        next: null,
        profileStatus: 'draft',
        releasedTotal: 0,
        visibleFields: [],
      });
    },
  );

  await t.test(
    'a photo is streamed only for a released profile, when photos are shown',
    async () => {
      const key = `${agencyId}/${A}/ayesha`;
      await admin.query(
        `INSERT INTO matrimony.profile_photos (agency_id, profile_id, storage_key, mime_type, byte_size, uploaded_by_account_id, status, is_primary)
       VALUES ($1, $2, $3, 'image/webp', 3, $4, 'published', true)`,
        [agencyId, A, key, boss.id],
      );
      await storage.put(variantKey(key, 'thumb'), Buffer.from([7, 7, 7]));

      const page = await service.page(me.actor, query());
      assert.equal(page.items.find((i) => i.candidateId === A)?.hasPhoto, true);
      assert.equal(page.items.find((i) => i.candidateId === B)?.hasPhoto, false);

      assert.deepEqual(await matches.photo(me.actor, A, 'thumb'), Buffer.from([7, 7, 7]));
      // B has no photo; D was never released; another member has no window.
      await assert.rejects(matches.photo(me.actor, B, 'thumb'), refused(404, 'PHOTO_NOT_FOUND'));
      await assert.rejects(matches.photo(me.actor, D, 'thumb'), refused(404, 'PHOTO_NOT_FOUND'));
      await assert.rejects(matches.photo(other.actor, A, 'thumb'), refused(404, 'PHOTO_NOT_FOUND'));
      // A removed profile's photo is gone with it.
      await candidates.remove(boss.actor, me.profileId, { candidateIds: [A] }, 'c');
      await assert.rejects(matches.photo(me.actor, A, 'thumb'), refused(404, 'PHOTO_NOT_FOUND'));
      // Staff switch photos off: nothing is streamed even for a released profile.
      await candidates.saveSettings(
        boss.actor,
        me.profileId,
        { cap: 50, visibleFields: ['fullName'] },
        'c',
      );
      await assert.rejects(matches.photo(me.actor, B, 'thumb'), refused(404, 'PHOTO_NOT_FOUND'));
    },
  );

  await t.test('staff and other roles never reach a member view', async () => {
    await assert.rejects(service.page(boss.actor, query()), refused(403, 'ROLE_FORBIDDEN'));
  });
});
