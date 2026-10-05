import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import sharp from 'sharp';
import type { WorkflowEvent } from '../src/bo/event.js';
import { MAX_PHOTOS, variantKey, type PhotoFile, type PhotoRecord } from '../src/bo/photo.js';
import type { PhotoUnit } from '../src/db/service/photo-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { PhotoProcess } from '../src/process/photo-process.js';
import { processImage } from '../src/security/image-processor.js';
import { PhotoService } from '../src/service/photo-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import type { FileStorage } from '../src/storage/service/file-storage.js';
import { agency, otherAgency } from './fixtures.js';

interface Stored extends PhotoFile {
  agencyId: string;
  profileId: string;
  reviewState: 'pending' | 'rejected' | null;
  notes: string | null;
  removed: boolean;
  createdAt: string;
}

/** An in-memory stand-in for one transaction's worth of photo storage. */
class FakeStore {
  profiles = new Map<string, { id: string; status: string }>(); // `${agency}/${owner}`
  photos: Stored[] = [];
  events: WorkflowEvent[] = [];
  failOnInsert = false;

  db = {
    inTransaction: <T>(_agencyId: string, work: (unit: PhotoUnit) => Promise<T>) =>
      work(this.unit()),
  };

  addProfile(agencyId: string, ownerId: string, status = 'active') {
    const profile = { id: randomUUID(), status };
    this.profiles.set(`${agencyId}/${ownerId}`, profile);
    return profile;
  }

  private visible(agencyId: string, profileId: string) {
    return this.photos.filter(
      (p) => p.agencyId === agencyId && p.profileId === profileId && !p.removed,
    );
  }

  private record(p: Stored): PhotoRecord {
    return {
      id: p.id,
      state:
        p.status === 'published'
          ? 'approved'
          : p.reviewState === 'rejected'
            ? 'rejected'
            : 'waiting',
      isPrimary: p.isPrimary,
      createdAt: p.createdAt,
      reviewerNotes: p.reviewState === 'rejected' ? p.notes : null,
    };
  }

  unit(): PhotoUnit {
    return {
      profileOf: async (agencyId, ownerId) => this.profiles.get(`${agencyId}/${ownerId}`) ?? null,
      list: async (agencyId, profileId) =>
        this.visible(agencyId, profileId).map((p) => this.record(p)),
      find: async (agencyId, profileId, photoId) => {
        const found = this.visible(agencyId, profileId).find((p) => p.id === photoId);
        return found
          ? {
              id: found.id,
              storageKey: found.storageKey,
              status: found.status,
              isPrimary: found.isPrimary,
            }
          : null;
      },
      count: async (agencyId, profileId) => this.visible(agencyId, profileId).length,
      insert: async (agencyId, profileId, photoId, storageKey) => {
        if (this.failOnInsert) throw new Error('database down');
        this.photos.push({
          agencyId,
          profileId,
          id: photoId,
          storageKey,
          status: 'staged',
          isPrimary: false,
          reviewState: 'pending',
          notes: null,
          removed: false,
          createdAt: new Date().toISOString(),
        });
      },
      remove: async (agencyId, photoId) => {
        const photo = this.photos.find((p) => p.agencyId === agencyId && p.id === photoId)!;
        photo.removed = true;
        photo.isPrimary = false;
      },
      makePrimary: async (agencyId, profileId, photoId) => {
        for (const p of this.visible(agencyId, profileId)) p.isPrimary = p.id === photoId;
      },
      promoteNext: async (agencyId, profileId) => {
        const next = this.visible(agencyId, profileId).find((p) => p.status === 'published');
        if (next) next.isPrimary = true;
      },
      appendEvent: async (event) => {
        this.events.push(event);
      },
    };
  }

  /** Play the reviewer, who is not built yet. */
  approve(photoId: string) {
    const photo = this.photos.find((p) => p.id === photoId)!;
    photo.status = 'published';
    photo.reviewState = null;
    if (!this.visible(photo.agencyId, photo.profileId).some((p) => p.isPrimary))
      photo.isPrimary = true;
  }

  reject(photoId: string, notes: string) {
    const photo = this.photos.find((p) => p.id === photoId)!;
    photo.reviewState = 'rejected';
    photo.notes = notes;
  }
}

class MemoryStorage implements FileStorage {
  files = new Map<string, Buffer>();
  failPutAt: number | null = null;
  failDelete = false;
  puts = 0;
  async put(key: string, data: Buffer) {
    this.puts += 1;
    if (this.failPutAt === this.puts) throw new Error('disk full');
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('bucket unreachable');
    this.files.delete(key);
  }
}

const picture = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: '#996633' } })
    .jpeg()
    .toBuffer();

function setup() {
  const store = new FakeStore();
  const storage = new MemoryStorage();
  const service = new PhotoService(store.db, () => new Date('2026-10-06T10:00:00Z'));
  const photos = new PhotoProcess(service, storage, processImage, pino({ level: 'silent' }));
  const member: ProfileActor = { agencyId: agency, accountId: randomUUID(), role: 'member' };
  const profile = store.addProfile(agency, member.accountId);
  return { store, storage, service, photos, member, profile };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `an AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

await test('a member with no photos sees an empty list and the limit', async () => {
  const { photos, member } = setup();
  assert.deepEqual(await photos.list(member), { photos: [], limit: MAX_PHOTOS });
});

await test('agents and admins have no photos of their own and are refused everywhere', async () => {
  const { service, member } = setup();
  const id = randomUUID();
  for (const role of ['agent', 'admin'] as const) {
    const actor = { ...member, role };
    await rejects(service.list(actor), 403, 'ROLE_FORBIDDEN');
    await rejects(service.reserve(actor), 403, 'ROLE_FORBIDDEN');
    await rejects(service.remove(actor, id, 'c'), 403, 'ROLE_FORBIDDEN');
    await rejects(service.makePrimary(actor, id), 403, 'ROLE_FORBIDDEN');
    await rejects(service.locate(actor, id), 403, 'ROLE_FORBIDDEN');
  }
});

await test('photos need a saved profile first', async () => {
  const store = new FakeStore();
  const service = new PhotoService(store.db);
  const member: ProfileActor = { agencyId: agency, accountId: randomUUID(), role: 'member' };
  await rejects(service.reserve(member), 404, 'PROFILE_NOT_FOUND');
  assert.deepEqual(await service.list(member), { photos: [], limit: MAX_PHOTOS });
});

await test('an uploaded photo is stored in both sizes and waits for review', async () => {
  const { photos, storage, store, member, profile } = setup();
  const list = await photos.upload(member, await picture(), 'req-1');

  assert.equal(list.photos.length, 1);
  assert.equal(list.photos[0]?.state, 'waiting');
  assert.equal(list.photos[0]?.isPrimary, false);

  const key = store.photos[0]!.storageKey;
  assert.ok(key.startsWith(`${agency}/${profile.id}/`), 'under the agency and the profile');
  assert.ok(storage.files.has(variantKey(key, 'full')));
  assert.ok(storage.files.has(variantKey(key, 'thumb')));
  assert.equal(store.events[0]?.type, 'photo.uploaded');
  assert.equal(store.events[0]?.subjectId, list.photos[0]?.id);
  assert.equal(store.events[0]?.correlationId, 'req-1');
});

await test('a picture that is refused stores nothing and records nothing', async () => {
  const { photos, storage, store, member } = setup();
  await rejects(photos.upload(member, Buffer.from('not a picture'), 'c'), 422, 'PHOTO_INVALID');
  assert.equal(storage.files.size, 0);
  assert.equal(store.photos.length, 0);
  assert.equal(store.events.length, 0);
});

await test('a member who is over the limit is told before any picture is processed', async () => {
  const { photos, storage, member } = setup();
  for (let i = 0; i < MAX_PHOTOS; i += 1) await photos.upload(member, await picture(), 'c');
  const before = storage.puts;
  // Not even a picture: the limit is checked first, so this never reaches the image check.
  await rejects(photos.upload(member, Buffer.from('x'), 'c'), 409, 'PHOTO_LIMIT_REACHED');
  assert.equal(storage.puts, before);
  assert.equal((await photos.list(member)).photos.length, MAX_PHOTOS);
});

await test('a removed photo makes room for another', async () => {
  const { photos, member } = setup();
  let list = await photos.upload(member, await picture(), 'c');
  for (let i = 1; i < MAX_PHOTOS; i += 1) list = await photos.upload(member, await picture(), 'c');
  list = await photos.remove(member, list.photos[0]!.id, 'c');
  assert.equal(list.photos.length, MAX_PHOTOS - 1);
  list = await photos.upload(member, await picture(), 'c');
  assert.equal(list.photos.length, MAX_PHOTOS);
});

await test('if the record cannot be saved, the files just stored are deleted again', async () => {
  const { photos, storage, store, member } = setup();
  store.failOnInsert = true;
  await assert.rejects(photos.upload(member, await picture(), 'c'), /database down/);
  assert.equal(storage.files.size, 0, 'no orphan files');
  assert.equal(store.photos.length, 0);
});

await test('if the second file cannot be stored, the first is deleted and nothing is recorded', async () => {
  const { photos, storage, store, member } = setup();
  storage.failPutAt = 2;
  await assert.rejects(photos.upload(member, await picture(), 'c'), /disk full/);
  assert.equal(storage.files.size, 0);
  assert.equal(store.photos.length, 0);
});

await test('removing a photo deletes its record first and then its files, in both sizes', async () => {
  const { photos, storage, store, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  const key = store.photos[0]!.storageKey;

  const after = await photos.remove(member, list.photos[0]!.id, 'req-2');
  assert.deepEqual(after.photos, []);
  assert.equal(storage.files.size, 0);
  assert.equal(store.events.at(-1)?.type, 'photo.removed');
  assert.equal(await storage.get(variantKey(key, 'full')), null);
});

await test('a file that cannot be deleted does not undo the removal', async () => {
  const { photos, storage, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  storage.failDelete = true;
  const after = await photos.remove(member, list.photos[0]!.id, 'c');
  assert.deepEqual(after.photos, [], 'the member no longer sees it');
});

await test('removing something that is not yours or does not exist is a not-found', async () => {
  const { photos, store, member } = setup();
  await rejects(photos.remove(member, randomUUID(), 'c'), 404, 'PHOTO_NOT_FOUND');

  const other: ProfileActor = { agencyId: agency, accountId: randomUUID(), role: 'member' };
  store.addProfile(agency, other.accountId);
  const theirs = await photos.upload(other, await picture(), 'c');
  await rejects(photos.remove(member, theirs.photos[0]!.id, 'c'), 404, 'PHOTO_NOT_FOUND');
  await rejects(photos.image(member, theirs.photos[0]!.id, 'full'), 404, 'PHOTO_NOT_FOUND');
  assert.equal((await photos.list(other)).photos.length, 1, 'their photo is untouched');
});

await test('only an approved photo can be the main photo', async () => {
  const { photos, store, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  const id = list.photos[0]!.id;
  await rejects(photos.makePrimary(member, id), 409, 'PHOTO_NOT_APPROVED');

  store.approve(id);
  const after = await photos.makePrimary(member, id);
  assert.equal(after.photos[0]?.state, 'approved');
  assert.equal(after.photos[0]?.isPrimary, true);
});

await test('choosing a main photo moves the badge, it never leaves two', async () => {
  const { photos, store, member } = setup();
  await photos.upload(member, await picture(), 'c');
  const list = await photos.upload(member, await picture(), 'c');
  const [a, b] = list.photos.map((p) => p.id) as [string, string];
  store.approve(a);
  store.approve(b);

  const after = await photos.makePrimary(member, b);
  assert.deepEqual(
    after.photos.map((p) => [p.id === a ? 'a' : 'b', p.isPrimary]),
    [
      ['a', false],
      ['b', true],
    ],
  );
});

await test('removing the main photo hands the badge to the next approved one', async () => {
  const { photos, store, member } = setup();
  await photos.upload(member, await picture(), 'c');
  const list = await photos.upload(member, await picture(), 'c');
  const [a, b] = list.photos.map((p) => p.id) as [string, string];
  store.approve(a);
  store.approve(b);
  await photos.makePrimary(member, a);

  const after = await photos.remove(member, a, 'c');
  assert.equal(after.photos.length, 1);
  assert.equal(after.photos[0]?.id, b);
  assert.equal(after.photos[0]?.isPrimary, true);
});

await test('a rejected photo shows the reviewer note and can be removed', async () => {
  const { photos, store, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  store.reject(list.photos[0]!.id, 'Your face is not visible.');

  const after = await photos.list(member);
  assert.equal(after.photos[0]?.state, 'rejected');
  assert.equal(after.photos[0]?.reviewerNotes, 'Your face is not visible.');
  assert.deepEqual((await photos.remove(member, list.photos[0]!.id, 'c')).photos, []);
});

await test('the owner can see their own waiting photo, in either size', async () => {
  const { photos, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  const full = await photos.image(member, list.photos[0]!.id, 'full');
  const thumb = await photos.image(member, list.photos[0]!.id, 'thumb');
  assert.equal((await sharp(full).metadata()).width, 800);
  assert.equal((await sharp(thumb).metadata()).width, 400);
});

await test('a photo whose file has gone missing is a not-found, not a crash', async () => {
  const { photos, storage, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  storage.files.clear();
  await rejects(photos.image(member, list.photos[0]!.id, 'full'), 404, 'PHOTO_NOT_FOUND');
});

await test('a closed profile can no longer have its photos changed', async () => {
  const { photos, store, member } = setup();
  const list = await photos.upload(member, await picture(), 'c');
  store.profiles.get(`${agency}/${member.accountId}`)!.status = 'closed';
  await rejects(photos.upload(member, await picture(), 'c'), 409, 'PROFILE_STATE_INVALID');
  await rejects(photos.remove(member, list.photos[0]!.id, 'c'), 409, 'PROFILE_STATE_INVALID');
});

await test('two uploads that reserve the last place cannot both be recorded', async () => {
  const { photos, service, store, member } = setup();
  for (let i = 0; i < MAX_PHOTOS - 1; i += 1) await photos.upload(member, await picture(), 'c');
  // Both pass the early check, then race for the last place.
  const first = await service.reserve(member);
  const second = await service.reserve(member);
  await service.attach(member, first, 100, 'c');
  await rejects(service.attach(member, second, 100, 'c'), 409, 'PHOTO_LIMIT_REACHED');
  assert.equal(store.photos.filter((p) => !p.removed).length, MAX_PHOTOS);
});

await test('agencies are kept apart', async () => {
  const { photos, store, member } = setup();
  await photos.upload(member, await picture(), 'c');
  const elsewhere: ProfileActor = {
    agencyId: otherAgency,
    accountId: member.accountId,
    role: 'member',
  };
  assert.deepEqual((await photos.list(elsewhere)).photos, []);
  await rejects(photos.upload(elsewhere, await picture(), 'c'), 404, 'PROFILE_NOT_FOUND');
  assert.equal(store.photos.length, 1);
});
