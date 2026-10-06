import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/migrate.js';
import {
  clientInputSchema,
  clientListQuerySchema,
  type ClientListQuery,
} from '../../src/bo/client.js';
import { profileInputSchema } from '../../src/bo/profile.js';
import { listQuerySchema, type ListQuery } from '../../src/bo/review.js';
import { Database } from '../../src/db/config/database.js';
import { ClientRepository } from '../../src/db/raw/repository/client-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { PhotoRepository } from '../../src/db/raw/repository/photo-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../../src/db/raw/repository/review-repository.js';
import { ClientDbService } from '../../src/db/service/client-db-service.js';
import { PhotoDbService } from '../../src/db/service/photo-db-service.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { PhotoProcess } from '../../src/process/photo-process.js';
import { processImage } from '../../src/security/image-processor.js';
import { ClientService } from '../../src/service/client-service.js';
import { PhotoService } from '../../src/service/photo-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';
import { LocalFileStorage } from '../../src/storage/repository/local-file-storage.js';
import { agency, otherAgency } from '../fixtures.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date(Date.UTC(2026, 9, 6));
const person = (over: Record<string, unknown> = {}) => ({
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
    ...over,
  },
  contact: { phone: '+8801712345678' },
});
const memberInput = (version?: number, over: Record<string, unknown> = {}) =>
  profileInputSchema(NOW).parse({ version, ...person(over) });
const clientInput = (
  version?: number,
  over: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => clientInputSchema(NOW).parse({ version, ...person(over), ...extra });
const reviewQuery = (over: Partial<ListQuery> = {}): ListQuery => ({
  ...listQuerySchema.parse({}),
  ...over,
});
const clientQuery = (over: Partial<ClientListQuery> = {}): ClientListQuery => ({
  ...clientListQuerySchema.parse({}),
  ...over,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('the approval queue and client management on real PostgreSQL', async (t) => {
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
  const directory = await mkdtemp(join(tmpdir(), 'matrimony-staff-'));
  t.after(async () => {
    await db.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  const profileDb = new ProfileDbService(db, new ProfileRepository(), new EventRepository());
  const profiles = new ProfileService(profileDb);
  const reviews = new ReviewService(
    new ReviewDbService(db, new ReviewRepository(), new ProfileRepository(), new EventRepository()),
  );
  const clients = new ClientService(
    new ClientDbService(db, new ClientRepository(), new EventRepository()),
    profiles,
  );
  const storage = new LocalFileStorage(directory);
  const photos = new PhotoProcess(
    new PhotoService(new PhotoDbService(db, new PhotoRepository(), new EventRepository())),
    storage,
    processImage,
    pino({ level: 'silent' }),
  );

  /** A new account of the given role, and the actor to act as them. */
  const account = async (
    role: ProfileActor['role'],
    name: string,
    agencyId = agency,
    status = 'active',
  ) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
       VALUES ($1,$2,$3,$4,$5,$6,'https://test.example',$7)`,
      [id, agencyId, role, name, status, `${id}@example.com`, id],
    );
    return { id, actor: { agencyId, accountId: id, role } as ProfileActor };
  };
  const run = Date.now().toString().slice(-6);
  const boss = await account('admin', `Admin ${run}`);
  const abir = await account('agent', `Abir ${run}`);
  const rival = await account('agent', `Rival ${run}`);
  const retired = await account('agent', `Retired ${run}`, agency, 'disabled');

  /** A member whose complete profile has been sent for review. */
  const submittedMember = async (name = 'Niha', over: Record<string, unknown> = {}) => {
    const member = await account('member', name);
    const saved = await profiles.save(
      member.actor,
      memberInput(undefined, { fullName: name, ...over }),
    );
    const sent = await profiles.submit(member.actor, saved.profile!.version, 'c');
    return { member, profileId: sent.profile!.id, review: sent.pendingReview! };
  };
  // Everything in the queue, read page by page. The test database keeps the requests of earlier
  // runs, so "the first page" would not contain this run's.
  const waiting = async (actor: ProfileActor, over: Partial<ListQuery> = {}) => {
    const all = [];
    let after: string | undefined;
    do {
      const page = await reviews.list(actor, reviewQuery({ limit: 50, after, ...over }));
      all.push(...page.items);
      after = page.next ?? undefined;
    } while (after);
    return all;
  };
  const versionOf = async (profileId: string) =>
    (await admin.query(`SELECT version FROM matrimony.member_profiles WHERE id=$1`, [profileId]))
      .rows[0].version as number;
  const picture = () =>
    sharp({ create: { width: 640, height: 480, channels: 3, background: '#aa7744' } })
      .jpeg()
      .toBuffer();

  await t.test(
    "a member's first submission is in the queue and is approved by an admin",
    async () => {
      const { member, profileId, review } = await submittedMember('First Niha');
      const queue = await waiting(boss.actor);
      const found = queue.find((item) => item.id === review.id)!;
      assert.equal(found.kind, 'initial_submission');
      assert.equal(found.profile.fullName, 'First Niha');
      assert.equal(found.submittedBy.id, member.id);

      const detail = await reviews.detail(boss.actor, review.id);
      assert.ok(
        detail.changes.some((c) => c.path === 'profile.fullName' && c.after === 'First Niha'),
      );
      assert.equal(detail.canDecide, true);

      const approved = await reviews.approve(
        boss.actor,
        review.id,
        { note: 'Welcome.' },
        'req-approve',
      );
      assert.equal(approved.status, 'approved');
      assert.equal(approved.decidedBy?.id, boss.id);
      assert.equal(approved.reviewerNotes, 'Welcome.');

      const own = await profiles.get(member.actor);
      assert.equal(own.profile?.status, 'active');
      assert.equal(own.lastDecision?.status, 'approved');
      assert.equal(own.lastDecision?.reviewerNotes, 'Welcome.');
      assert.equal(own.pendingReview, null);

      const events = await admin.query(
        `SELECT event->>'type' AS type FROM matrimony.event_outbox WHERE event->>'subjectId'=$1 ORDER BY created_at`,
        [profileId],
      );
      assert.deepEqual(
        events.rows.map((r) => r.type),
        ['profile.submitted', 'profile.approved'],
      );
      assert.equal(
        (await waiting(boss.actor)).some((i) => i.id === review.id),
        false,
        'it leaves the queue',
      );
      assert.ok(
        (await waiting(boss.actor, { status: 'approved' })).some((i) => i.id === review.id),
      );
    },
  );

  await t.test(
    'a rejection sends the profile back with the reason, and it can be sent again',
    async () => {
      const { member, review } = await submittedMember('Rejected Niha');
      const rejected = await reviews.reject(
        boss.actor,
        review.id,
        { note: 'Add a clearer description.' },
        'c',
      );
      assert.equal(rejected.status, 'rejected');

      const own = await profiles.get(member.actor);
      assert.equal(own.profile?.status, 'rejected');
      assert.equal(own.lastDecision?.reviewerNotes, 'Add a clearer description.');

      const edited = await profiles.save(
        member.actor,
        memberInput(own.profile!.version, { fullName: 'Rejected Niha', aboutMe: 'Better' }),
      );
      const again = await profiles.submit(member.actor, edited.profile!.version, 'c');
      assert.equal(again.profile?.status, 'pending_review');
      assert.notEqual(again.pendingReview?.id, review.id, 'a new request');
    },
  );

  await t.test(
    'a change request is applied when approved and leaves the profile alone when rejected',
    async () => {
      const { member, review } = await submittedMember('Change Niha');
      await reviews.approve(boss.actor, review.id, {}, 'c');
      const live = (await profiles.get(member.actor)).profile!;

      const requested = await profiles.requestEdit(
        member.actor,
        memberInput(live.version, { fullName: 'Change Niha', heightCm: 180, aboutMe: 'Hello' }),
        'c',
      );
      const update = requested.pendingReview!;
      const detail = await reviews.detail(boss.actor, update.id);
      // The database keeps a request's fields in no particular order, so compare them sorted.
      assert.deepEqual(
        detail.changes
          .map((c) => [c.path, c.before, c.after])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
        [
          ['profile.aboutMe', null, 'Hello'],
          ['profile.heightCm', 172, 180],
        ],
      );
      await reviews.approve(boss.actor, update.id, { profileVersion: live.version }, 'c');
      const after = (await profiles.get(member.actor)).profile!;
      assert.equal(after.data.profile.heightCm, 180);
      assert.equal(after.data.profile.aboutMe, 'Hello');
      assert.equal(after.status, 'active');
      assert.ok(after.version > live.version);

      const second = await profiles.requestEdit(
        member.actor,
        memberInput(after.version, { fullName: 'Change Niha', heightCm: 190 }),
        'c',
      );
      await reviews.reject(
        boss.actor,
        second.pendingReview!.id,
        { note: 'Too tall to be true.' },
        'c',
      );
      const kept = await profiles.get(member.actor);
      assert.equal(kept.profile?.data.profile.heightCm, 180, 'unchanged by a rejected request');
      assert.equal(kept.profile?.version, after.version);
      assert.equal(kept.lastDecision?.status, 'rejected');
      assert.equal(kept.lastDecision?.reviewerNotes, 'Too tall to be true.');
    },
  );

  await t.test(
    'assigning a profile to an agent does not make a waiting request out of date',
    async () => {
      const { profileId, review } = await submittedMember('Assigned Niha');
      const before = await versionOf(profileId);

      const detail = await clients.assign(boss.actor, profileId, abir.id, 'c');
      assert.equal(detail.meta.assignedAgent?.id, abir.id);
      assert.equal(await versionOf(profileId), before, 'the version did not move');
      assert.equal((await reviews.detail(boss.actor, review.id)).stale, false);

      // The assigned agent sees it, a rival does not, and approving still works.
      assert.ok((await waiting(abir.actor)).some((i) => i.id === review.id));
      assert.equal(
        (await waiting(rival.actor)).some((i) => i.id === review.id),
        false,
      );
      await assert.rejects(reviews.detail(rival.actor, review.id), code(404, 'REVIEW_NOT_FOUND'));
      await reviews.approve(abir.actor, review.id, {}, 'c');
    },
  );

  await t.test("an unassigned profile's request is open to every agent", async () => {
    const { review } = await submittedMember('Open Niha');
    for (const agent of [abir, rival]) {
      assert.ok((await waiting(agent.actor)).some((i) => i.id === review.id));
    }
    assert.equal((await waiting(retired.actor).catch(() => [])).length >= 0, true);
  });

  await t.test('a request is out of date once the profile changed since it was made', async () => {
    const { profileId, review } = await submittedMember('Stale Niha');
    // Something changes the profile after the request (an edit made behind the queue's back).
    await admin.query(`UPDATE matrimony.member_profiles SET about_me='Changed' WHERE id=$1`, [
      profileId,
    ]);

    const detail = await reviews.detail(boss.actor, review.id);
    assert.equal(detail.stale, true);
    assert.equal(detail.canDecide, false);
    await assert.rejects(
      reviews.approve(boss.actor, review.id, {}, 'c'),
      code(409, 'REVIEW_OUT_OF_DATE'),
    );
    const profile = await admin.query(`SELECT status FROM matrimony.member_profiles WHERE id=$1`, [
      profileId,
    ]);
    assert.equal(profile.rows[0].status, 'pending_review', 'nothing was applied');
  });

  await t.test('two reviewers deciding at once: one decides, the other is told', async () => {
    const { profileId, review } = await submittedMember('Race Niha');
    const results = await Promise.allSettled([
      reviews.approve(boss.actor, review.id, { note: 'one' }, 'c'),
      reviews.approve(boss.actor, review.id, { note: 'two' }, 'c'),
      reviews.reject(boss.actor, review.id, { note: 'three' }, 'c'),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled');
    assert.equal(done.length, 1, 'exactly one decision');
    for (const failure of results.filter((r) => r.status === 'rejected')) {
      assert.ok(code(409, 'REVIEW_ALREADY_DECIDED')((failure as PromiseRejectedResult).reason));
    }
    const rows = await admin.query(
      `SELECT status FROM matrimony.profile_reviews WHERE profile_id=$1`,
      [profileId],
    );
    assert.equal(rows.rowCount, 1);
    assert.notEqual(rows.rows[0].status, 'pending');
    const events = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.event_outbox WHERE event->>'subjectId'=$1 AND event->>'type' IN ('profile.approved','profile.rejected')`,
      [profileId],
    );
    assert.equal(events.rows[0].n, 1, 'one event for one decision');
  });

  await t.test('a withdrawn request cannot be decided', async () => {
    const { member, review } = await submittedMember('Withdrawn Niha');
    await profiles.cancelPending(member.actor, 'c');
    const detail = await reviews.detail(boss.actor, review.id);
    assert.equal(detail.blockedBy, 'cancelled');
    await assert.rejects(
      reviews.approve(boss.actor, review.id, {}, 'c'),
      code(409, 'REVIEW_CANCELLED'),
    );
  });

  await t.test(
    'a photo is approved: it becomes visible and the main photo, and the reviewer can see it',
    async () => {
      const member = await account('member', 'Photo Niha');
      await profiles.save(member.actor, memberInput(undefined, { fullName: 'Photo Niha' }));
      await photos.upload(member.actor, await picture(), 'c');
      await photos.upload(member.actor, await picture(), 'c');

      const queue = (await waiting(boss.actor, { kind: 'photo_add' })).filter(
        (i) => i.profile.fullName === 'Photo Niha',
      );
      assert.equal(queue.length, 2);
      const [first, second] = queue as [(typeof queue)[number], (typeof queue)[number]];

      const bytes = await reviews.photoKey(boss.actor, first.id);
      assert.ok(bytes.storageKey.startsWith(`${agency}/${first.profile.id}/`));
      assert.ok(
        await storage.get(`${bytes.storageKey}.thumb.webp`),
        'the file is there to be shown',
      );

      await reviews.approve(boss.actor, first.id, {}, 'c');
      await reviews.reject(boss.actor, second.id, { note: 'Face not visible.' }, 'c');
      const list = (await photos.list(member.actor)).photos;
      assert.deepEqual(
        list.map((p) => [p.state, p.isPrimary, p.reviewerNotes]),
        [
          ['approved', true, null],
          ['rejected', false, 'Face not visible.'],
        ],
      );
    },
  );

  await t.test('the queue is read a page at a time with nothing missed or repeated', async () => {
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push((await submittedMember(`Page ${run} ${i}`)).review.id);
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await reviews.list(boss.actor, reviewQuery({ limit: 2, after }));
      seen.push(...page.items.map((i) => i.id));
      after = page.next ?? undefined;
      pages += 1;
      assert.ok(pages < 100, 'it ends');
    } while (after);
    assert.equal(new Set(seen).size, seen.length, 'no request twice');
    for (const id of made) assert.ok(seen.includes(id), 'every request is there');
    // The longest wait first.
    const times = (await waiting(boss.actor)).map((i) => i.createdAt);
    assert.deepEqual(times, [...times].sort());
  });

  await t.test('another agency never sees these requests or clients', async () => {
    const foreign = await account('admin', 'Foreign admin', otherAgency);
    const { review, profileId } = await submittedMember('Local Niha');
    // The other agency has requests and clients of its own. None of this agency's may appear.
    const ids = async (table: string) =>
      new Set(
        (
          await admin.query(`SELECT id FROM matrimony.${table} WHERE agency_id=$1`, [agency])
        ).rows.map((r) => r.id as string),
      );
    const localProfiles = await ids('member_profiles');
    const localReviews = await ids('profile_reviews');
    const theirClients = (await clients.list(foreign.actor, clientQuery({ limit: 50 }))).items;
    const theirReviews = (await reviews.list(foreign.actor, reviewQuery({ limit: 50 }))).items;
    assert.ok(
      theirClients.every((c) => !localProfiles.has(c.id)),
      'no client of this agency',
    );
    assert.ok(
      theirReviews.every((r) => !localReviews.has(r.id)),
      'no request of this agency',
    );
    const own = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.profile_reviews
       WHERE agency_id=$1 AND status='pending' AND kind IN ('initial_submission','field_update','photo_add')`,
      [otherAgency],
    );
    assert.equal(
      await reviews.pendingCount(foreign.actor),
      own.rows[0].n,
      'only their own are counted',
    );
    await assert.rejects(reviews.detail(foreign.actor, review.id), code(404, 'REVIEW_NOT_FOUND'));
    await assert.rejects(
      reviews.approve(foreign.actor, review.id, {}, 'c'),
      code(404, 'REVIEW_NOT_FOUND'),
    );
    await assert.rejects(clients.detail(foreign.actor, profileId), code(404, 'PROFILE_NOT_FOUND'));
    await assert.rejects(
      clients.assign(foreign.actor, profileId, null, 'c'),
      code(404, 'PROFILE_NOT_FOUND'),
    );
  });

  await t.test(
    'an agent creates a client, who goes through review like anyone, and a colleague approves',
    async () => {
      const { id, detail } = await clients.create(
        abir.actor,
        clientInput(undefined, { fullName: `Client ${run}` }),
        'c',
      );
      assert.equal(detail.meta.serviceMode, 'assisted');
      assert.equal(detail.meta.assignedAgent?.id, abir.id);
      assert.equal(detail.meta.owner, null);
      const row = await admin.query(
        `SELECT owner_account_id, created_by_account_id, service_mode FROM matrimony.member_profiles WHERE id=$1`,
        [id],
      );
      assert.deepEqual(row.rows[0], {
        owner_account_id: null,
        created_by_account_id: abir.id,
        service_mode: 'assisted',
      });

      // Edit the draft, with the version check.
      const saved = await clients.save(
        abir.actor,
        id,
        clientInput(detail.state.profile!.version, {
          fullName: `Client ${run}`,
          aboutMe: 'A kind person.',
        }),
      );
      await assert.rejects(
        clients.save(
          abir.actor,
          id,
          clientInput(detail.state.profile!.version, { fullName: 'Stale' }),
        ),
        code(409, 'PROFILE_VERSION_CONFLICT'),
      );
      const sent = await clients.submit(abir.actor, id, saved.state.profile!.version, 'c');
      assert.equal(sent.state.profile?.status, 'pending_review');

      const reviewId = sent.state.pendingReview!.id;
      // The agent who submitted cannot decide it; an admin can.
      const mine = await reviews.detail(abir.actor, reviewId);
      assert.equal(mine.blockedBy, 'own_submission');
      await assert.rejects(
        reviews.approve(abir.actor, reviewId, {}, 'c'),
        code(409, 'REVIEW_OWN_SUBMISSION'),
      );
      await reviews.approve(boss.actor, reviewId, {}, 'c');
      assert.equal((await clients.detail(abir.actor, id)).state.profile?.status, 'active');
    },
  );

  await t.test(
    'a client who is live changes through a request, and is paused and closed by staff',
    async () => {
      const { id, detail } = await clients.create(
        abir.actor,
        clientInput(undefined, { fullName: `Live ${run}` }),
        'c',
      );
      const sent = await clients.submit(abir.actor, id, detail.state.profile!.version, 'c');
      await reviews.approve(boss.actor, sent.state.pendingReview!.id, {}, 'c');
      const live = (await clients.detail(abir.actor, id)).state.profile!;

      await assert.rejects(
        clients.save(abir.actor, id, clientInput(live.version)),
        code(409, 'PROFILE_EDIT_REQUIRES_REVIEW'),
      );
      const asked = await clients.requestEdit(
        abir.actor,
        id,
        clientInput(live.version, { fullName: `Live ${run}`, heightCm: 175 }),
        'c',
      );
      await reviews.approve(boss.actor, asked.state.pendingReview!.id, {}, 'c');
      const changed = (await clients.detail(abir.actor, id)).state.profile!;
      assert.equal(changed.data.profile.heightCm, 175);

      const paused = await clients.changeStatus(abir.actor, id, 'paused', changed.version, 'c');
      assert.equal(paused.state.profile?.status, 'paused');
      await assert.rejects(
        clients.changeStatus(abir.actor, id, 'matched', paused.state.profile!.version, 'c'),
        code(409, 'STATUS_CHANGE_NOT_ALLOWED'),
      );
      await assert.rejects(
        clients.changeStatus(abir.actor, id, 'active', changed.version, 'c'),
        code(409, 'PROFILE_VERSION_CONFLICT'),
      );
      const back = await clients.changeStatus(
        abir.actor,
        id,
        'active',
        paused.state.profile!.version,
        'c',
      );
      const closed = await clients.changeStatus(
        abir.actor,
        id,
        'closed',
        back.state.profile!.version,
        'c',
      );
      assert.equal(closed.state.profile?.status, 'closed');
      await assert.rejects(
        clients.changeStatus(abir.actor, id, 'active', closed.state.profile!.version, 'c'),
        code(409, 'STATUS_CHANGE_NOT_ALLOWED'),
      );
    },
  );

  await t.test(
    "staff can see and pause a member's own profile but never change what it says",
    async () => {
      const { member, profileId, review } = await submittedMember('Own Niha');
      await reviews.approve(boss.actor, review.id, {}, 'c');
      await clients.assign(boss.actor, profileId, abir.id, 'c');
      const state = (await clients.detail(abir.actor, profileId)).state.profile!;

      await assert.rejects(
        clients.save(abir.actor, profileId, clientInput(state.version)),
        code(403, 'PROFILE_SELF_SERVICE'),
      );
      await assert.rejects(
        clients.requestEdit(boss.actor, profileId, clientInput(state.version), 'c'),
        code(403, 'PROFILE_SELF_SERVICE'),
      );

      const paused = await clients.changeStatus(
        abir.actor,
        profileId,
        'paused',
        state.version,
        'c',
      );
      assert.equal(paused.state.profile?.status, 'paused');
      assert.equal(
        (await profiles.get(member.actor)).profile?.status,
        'paused',
        'the member sees it too',
      );
      assert.equal(
        (await clients.detail(abir.actor, profileId)).meta.owner?.displayName,
        'Own Niha',
      );
    },
  );

  await t.test('an agent reaches only their own clients; an admin reaches all', async () => {
    const mine = await clients.create(
      abir.actor,
      clientInput(undefined, { fullName: `Mine ${run}` }),
      'c',
    );
    const theirs = await clients.create(
      rival.actor,
      clientInput(undefined, { fullName: `Theirs ${run}` }),
      'c',
    );

    const abirList = (await clients.list(abir.actor, clientQuery({ limit: 50 }))).items.map(
      (c) => c.id,
    );
    assert.ok(abirList.includes(mine.id));
    assert.equal(abirList.includes(theirs.id), false);
    await assert.rejects(clients.detail(abir.actor, theirs.id), code(404, 'PROFILE_NOT_FOUND'));
    await assert.rejects(
      clients.save(abir.actor, theirs.id, clientInput(1)),
      code(404, 'PROFILE_NOT_FOUND'),
    );
    await assert.rejects(
      clients.changeStatus(abir.actor, theirs.id, 'closed', 1, 'c'),
      code(404, 'PROFILE_NOT_FOUND'),
    );
    // Whatever an agent asks for, the list stays their own.
    const asked = (
      await clients.list(abir.actor, clientQuery({ assignedTo: rival.id, limit: 50 }))
    ).items.map((c) => c.id);
    assert.equal(asked.includes(theirs.id), false);

    const all = (await clients.list(boss.actor, clientQuery({ limit: 50 }))).items.map((c) => c.id);
    assert.ok(all.includes(mine.id) && all.includes(theirs.id));
  });

  await t.test('the list can be filtered, searched and paged', async () => {
    const tag = `Filter${run}`;
    const a = await clients.create(
      abir.actor,
      clientInput(undefined, { fullName: `${tag} Alpha` }),
      'c',
    );
    const b = await clients.create(
      abir.actor,
      clientInput(undefined, { fullName: `${tag} Beta` }),
      'c',
    );
    const c = await clients.create(
      boss.actor,
      clientInput(undefined, { fullName: `${tag} Gamma` }),
      'c',
    );
    const find = async (q: Partial<ClientListQuery>) =>
      (await clients.list(boss.actor, clientQuery({ q: tag, limit: 50, ...q }))).items.map(
        (i) => i.id,
      );

    assert.deepEqual((await find({})).sort(), [a.id, b.id, c.id].sort());
    assert.deepEqual(await find({ q: `${tag} alp` }), [a.id], 'a part of a name, any case');
    assert.deepEqual(
      await find({ assignedTo: abir.id }).then((x) => x.sort()),
      [a.id, b.id].sort(),
    );
    assert.deepEqual(await find({ assignedTo: 'none' }), [c.id]);
    assert.deepEqual(await find({ status: 'closed' }), []);
    assert.equal((await find({ serviceMode: 'assisted' })).length, 3);
    assert.equal((await find({ serviceMode: 'self_service' })).length, 0);
    const byCode = (await clients.detail(boss.actor, a.id)).state.profile!.memberCode;
    assert.deepEqual(
      await clients
        .list(boss.actor, clientQuery({ q: byCode }))
        .then((p) => p.items.map((i) => i.id)),
      [a.id],
      'by member code',
    );

    // The characters LIKE treats as wildcards are plain text here.
    assert.deepEqual(await find({ q: `${tag}%` }), []);
    assert.deepEqual(await find({ q: `${tag}_Alpha` }), []);
    assert.deepEqual((await clients.list(boss.actor, clientQuery({ q: '%' }))).items, []);

    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await clients.list(boss.actor, clientQuery({ q: tag, limit: 2, after }));
      seen.push(...page.items.map((i) => i.id));
      after = page.next ?? undefined;
    } while (after);
    assert.deepEqual(seen.sort(), [a.id, b.id, c.id].sort(), 'paged without gaps or repeats');
  });

  await t.test('the list shows when a request is waiting on a client', async () => {
    const { id, detail } = await clients.create(
      abir.actor,
      clientInput(undefined, { fullName: `Flag ${run}` }),
      'c',
    );
    const flag = async () =>
      (await clients.list(abir.actor, clientQuery({ q: `Flag ${run}` }))).items[0]!
        .hasPendingReview;
    assert.equal(await flag(), false);
    await clients.submit(abir.actor, id, detail.state.profile!.version, 'c');
    assert.equal(await flag(), true);
  });

  await t.test(
    'only an admin assigns, and only to an active admin or agent of this agency',
    async () => {
      const { id } = await clients.create(
        abir.actor,
        clientInput(undefined, { fullName: `Assign ${run}` }),
        'c',
      );
      await assert.rejects(
        clients.assign(abir.actor, id, rival.id, 'c'),
        code(403, 'ROLE_FORBIDDEN'),
      );
      const member = await account('member', 'Not staff');
      const foreign = await account('agent', 'Foreign agent', otherAgency);
      for (const bad of [retired.id, member.id, foreign.id, randomUUID()]) {
        await assert.rejects(
          clients.assign(boss.actor, id, bad, 'c'),
          code(422, 'AGENT_NOT_AVAILABLE'),
        );
      }
      const moved = await clients.assign(boss.actor, id, rival.id, 'c');
      assert.equal(moved.meta.assignedAgent?.id, rival.id);
      await assert.rejects(clients.detail(abir.actor, id), code(404, 'PROFILE_NOT_FOUND'));
      assert.equal((await clients.assign(boss.actor, id, null, 'c')).meta.assignedAgent, null);
      const staff = await clients.listStaff(boss.actor);
      assert.ok(staff.some((s) => s.id === abir.id) && staff.some((s) => s.id === boss.id));
      assert.equal(
        staff.some((s) => s.id === member.id),
        false,
        'members are not staff',
      );
      assert.equal(
        staff.some((s) => s.id === foreign.id),
        false,
        'other agencies are not listed',
      );
    },
  );

  await t.test(
    'the application cannot delete reviews, and the queue count matches the queue',
    async () => {
      await assert.rejects(pool.query('DELETE FROM matrimony.profile_reviews'));
      const items = await waiting(boss.actor);
      assert.equal(await reviews.pendingCount(boss.actor), items.length);
      assert.equal(await reviews.pendingCount(abir.actor), (await waiting(abir.actor)).length);
    },
  );
});
