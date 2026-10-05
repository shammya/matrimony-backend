import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { Pool } from 'pg';
import sharp from 'sharp';
import { migrate } from '../../scripts/migrate.js';
import { MAX_PHOTOS } from '../../src/bo/photo.js';
import { Database } from '../../src/db/config/database.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { PhotoRepository } from '../../src/db/raw/repository/photo-repository.js';
import { PhotoDbService } from '../../src/db/service/photo-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { PhotoProcess } from '../../src/process/photo-process.js';
import { processImage } from '../../src/security/image-processor.js';
import { PhotoService } from '../../src/service/photo-service.js';
import type { ProfileActor } from '../../src/service/profile-service.js';
import { LocalFileStorage } from '../../src/storage/repository/local-file-storage.js';
import { agency, otherAgency } from '../fixtures.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const picture = () =>
  sharp({ create: { width: 640, height: 480, channels: 3, background: '#aa7744' } })
    .jpeg()
    .toBuffer();

const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

await test('member photos on real PostgreSQL with real files', async (t) => {
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='scaffold_test_app') THEN
 CREATE ROLE scaffold_test_app LOGIN PASSWORD 'test-only' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
 GRANT matrimony_runtime TO scaffold_test_app;`);
  await admin.query(
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,'test-one','localhost','Test one'),($2,'test-two','other.localhost','Test two') ON CONFLICT(id) DO NOTHING`,
    [agency, otherAgency],
  );

  /** A member with a saved profile (photos need one), and the actor to act as them. */
  const member = async (agencyId: string) => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO matrimony.accounts(id,agency_id,role,display_name,status,email,auth_issuer,auth_subject)
       VALUES ($1,$2,'member','Member',$3,$4,'https://test.example',$5)`,
      [id, agencyId, 'active', `${id}@example.com`, id],
    );
    const profile = await admin.query(
      `INSERT INTO matrimony.member_profiles(agency_id,member_code,owner_account_id,created_by_account_id,full_name)
       VALUES ($1,$2,$3,$3,'Test') RETURNING id`,
      [agencyId, `M${Math.floor(Math.random() * 1e7)}`.padEnd(8, '0'), id],
    );
    const actor: ProfileActor = { agencyId, accountId: id, role: 'member' };
    return { actor, profileId: profile.rows[0].id as string };
  };

  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 6 });
  const db = new Database(pool);
  const directory = await mkdtemp(join(tmpdir(), 'matrimony-photos-'));
  t.after(async () => {
    await db.close();
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  const photos = new PhotoProcess(
    new PhotoService(new PhotoDbService(db, new PhotoRepository(), new EventRepository())),
    new LocalFileStorage(directory),
    processImage,
    pino({ level: 'silent' }),
  );
  const filesFor = async (profileId: string) =>
    (await readdir(join(directory, agency, profileId)).catch(() => [])).sort();

  /** Play the reviewer, who is not built yet. */
  const review = async (photoId: string, outcome: 'approved' | 'rejected', notes?: string) => {
    const reviewer = (
      await admin.query(`SELECT id FROM matrimony.accounts WHERE role='member' LIMIT 1`)
    ).rows[0].id;
    await admin.query(
      `UPDATE matrimony.profile_reviews SET status=$2, reviewed_at=now(), reviewer_account_id=$3, reviewer_notes=$4
       WHERE photo_id=$1 AND status='pending'`,
      [photoId, outcome, reviewer, notes ?? null],
    );
    if (outcome === 'approved') {
      await admin.query(`UPDATE matrimony.profile_photos SET status='published' WHERE id=$1`, [
        photoId,
      ]);
    }
  };

  const one = await member(agency);

  await t.test('an upload stores two real files and a waiting record', async () => {
    const list = await photos.upload(one.actor, await picture(), 'req-1');
    assert.equal(list.photos.length, 1);
    assert.equal(list.photos[0]?.state, 'waiting');
    assert.equal(list.limit, MAX_PHOTOS);
    const files = await filesFor(one.profileId);
    assert.equal(files.length, 2);
    assert.ok(
      files.some((f) => f.endsWith('.full.webp')) && files.some((f) => f.endsWith('.thumb.webp')),
    );

    const row = await admin.query(
      `SELECT status, mime_type, byte_size, storage_key FROM matrimony.profile_photos WHERE profile_id=$1`,
      [one.profileId],
    );
    assert.equal(row.rows[0].status, 'staged');
    assert.equal(row.rows[0].mime_type, 'image/webp');
    assert.ok(row.rows[0].storage_key.startsWith(`${agency}/${one.profileId}/`));

    const pending = await admin.query(
      `SELECT kind, status FROM matrimony.profile_reviews WHERE photo_id=$1`,
      [list.photos[0]!.id],
    );
    assert.deepEqual(pending.rows, [{ kind: 'photo_add', status: 'pending' }]);

    const events = await admin.query(
      `SELECT event->>'type' AS type FROM matrimony.event_outbox WHERE event->>'subjectId'=$1`,
      [list.photos[0]!.id],
    );
    assert.deepEqual(events.rows, [{ type: 'photo.uploaded' }]);
  });

  await t.test('the member can fetch their own photo in both sizes', async () => {
    const [photo] = (await photos.list(one.actor)).photos;
    const full = await photos.image(one.actor, photo!.id, 'full');
    const thumb = await photos.image(one.actor, photo!.id, 'thumb');
    assert.equal((await sharp(full).metadata()).format, 'webp');
    assert.equal((await sharp(thumb).metadata()).width, 400);
  });

  await t.test('approval shows in the list, and a rejection shows its note', async () => {
    const [first] = (await photos.list(one.actor)).photos;
    await review(first!.id, 'approved');
    await admin.query(`UPDATE matrimony.profile_photos SET is_primary=true WHERE id=$1`, [
      first!.id,
    ]);

    const second = (await photos.upload(one.actor, await picture(), 'c')).photos[1]!;
    await review(second.id, 'rejected', 'Your face is not visible.');

    const list = (await photos.list(one.actor)).photos;
    assert.deepEqual(
      list.map((p) => [p.state, p.isPrimary, p.reviewerNotes]),
      [
        ['approved', true, null],
        ['rejected', false, 'Your face is not visible.'],
      ],
    );
    await assert.rejects(photos.makePrimary(one.actor, second.id), code(409, 'PHOTO_NOT_APPROVED'));
  });

  await t.test(
    'the main photo moves to another approved photo without ever being two',
    async () => {
      const third = (await photos.upload(one.actor, await picture(), 'c')).photos[2]!;
      await review(third.id, 'approved');
      const after = await photos.makePrimary(one.actor, third.id);
      assert.deepEqual(
        after.photos.map((p) => p.isPrimary),
        [false, false, true],
      );
      const primaries = await admin.query(
        `SELECT count(*)::int AS n FROM matrimony.profile_photos WHERE profile_id=$1 AND is_primary`,
        [one.profileId],
      );
      assert.equal(primaries.rows[0].n, 1);
    },
  );

  await t.test(
    'removing the main photo promotes the next approved one and deletes the files',
    async () => {
      const before = (await photos.list(one.actor)).photos;
      const filesBefore = (await filesFor(one.profileId)).length;
      const after = await photos.remove(one.actor, before[2]!.id, 'req-remove');

      assert.equal(after.photos.length, 2);
      assert.equal(after.photos[0]?.isPrimary, true, 'the first approved photo took over');
      assert.equal((await filesFor(one.profileId)).length, filesBefore - 2);

      const row = await admin.query(
        `SELECT status, is_primary FROM matrimony.profile_photos WHERE id=$1`,
        [before[2]!.id],
      );
      assert.deepEqual(row.rows[0], { status: 'removed', is_primary: false }, 'the record is kept');
      await assert.rejects(
        photos.image(one.actor, before[2]!.id, 'full'),
        code(404, 'PHOTO_NOT_FOUND'),
      );
    },
  );

  await t.test('removing a photo that is waiting cancels its review', async () => {
    const waiting = (await photos.upload(one.actor, await picture(), 'c')).photos.at(-1)!;
    await photos.remove(one.actor, waiting.id, 'c');
    const review = await admin.query(
      `SELECT status, cancelled_at IS NOT NULL AS cancelled FROM matrimony.profile_reviews WHERE photo_id=$1`,
      [waiting.id],
    );
    assert.deepEqual(review.rows, [{ status: 'cancelled', cancelled: true }]);
  });

  await t.test('simultaneous uploads cannot get past the limit', async () => {
    const racer = await member(agency);
    const files = await Promise.all(Array.from({ length: 8 }, () => picture()));
    const results = await Promise.allSettled(
      files.map((file) => photos.upload(racer.actor, file, 'c')),
    );

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, MAX_PHOTOS);
    for (const failure of results.filter((r) => r.status === 'rejected')) {
      assert.ok(code(409, 'PHOTO_LIMIT_REACHED')((failure as PromiseRejectedResult).reason));
    }
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM matrimony.profile_photos WHERE profile_id=$1 AND status<>'removed'`,
      [racer.profileId],
    );
    assert.equal(rows.rows[0].n, MAX_PHOTOS);
    // No files are left behind by the uploads that lost the race.
    assert.equal((await filesFor(racer.profileId)).length, MAX_PHOTOS * 2);
  });

  await t.test('a member only reaches their own photos, and agencies are kept apart', async () => {
    const stranger = await member(agency);
    const mine = (await photos.list(one.actor)).photos[0]!;
    await assert.rejects(photos.remove(stranger.actor, mine.id, 'c'), code(404, 'PHOTO_NOT_FOUND'));
    await assert.rejects(
      photos.image(stranger.actor, mine.id, 'full'),
      code(404, 'PHOTO_NOT_FOUND'),
    );
    await assert.rejects(photos.makePrimary(stranger.actor, mine.id), code(404, 'PHOTO_NOT_FOUND'));

    const elsewhere = await member(otherAgency);
    assert.deepEqual((await photos.list(elsewhere.actor)).photos, []);
    const asOther: ProfileActor = {
      agencyId: otherAgency,
      accountId: one.actor.accountId,
      role: 'member',
    };
    assert.deepEqual((await photos.list(asOther)).photos, []);
    await assert.rejects(photos.image(asOther, mine.id, 'full'), code(404, 'PROFILE_NOT_FOUND'));
  });

  await t.test(
    'the database itself refuses a file path outside the profile, and deletion',
    async () => {
      await assert.rejects(
        admin.query(
          `INSERT INTO matrimony.profile_photos(agency_id,profile_id,storage_key,mime_type,byte_size,uploaded_by_account_id)
         VALUES ($1,$2,'somewhere/else.webp','image/webp',10,$3)`,
          [agency, one.profileId, one.actor.accountId],
        ),
      );
      await assert.rejects(pool.query('DELETE FROM matrimony.profile_photos'));
      const rows = await pool.query('SELECT id FROM matrimony.profile_photos');
      assert.equal(rows.rowCount, 0, 'no agency context, no rows');
    },
  );
});
