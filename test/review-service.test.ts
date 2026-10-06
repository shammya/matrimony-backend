import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { listQuerySchema, type ListQuery } from '../src/bo/review.js';
import { AppError } from '../src/exception/app-error.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { ReviewService } from '../src/service/review-service.js';
import { agency } from './fixtures.js';
import { FakeReviewStore } from './fake-review-store.js';

const query = (over: Partial<ListQuery> = {}): ListQuery => ({
  ...listQuerySchema.parse({}),
  ...over,
});

function setup() {
  const store = new FakeReviewStore();
  const service = new ReviewService(store.db, () => new Date('2026-10-06T10:00:00Z'));
  const member = store.person('Niha');
  const admin = store.person('Admin');
  const abir = store.person('Abir');
  const other = store.person('Other agent');
  const as = (person: { id: string }, role: ProfileActor['role']): ProfileActor => ({
    agencyId: agency,
    accountId: person.id,
    role,
  });
  return {
    store,
    service,
    member,
    admin,
    abir,
    other,
    asAdmin: as(admin, 'admin'),
    asAbir: as(abir, 'agent'),
    asOther: as(other, 'agent'),
    asMember: as(member, 'member'),
  };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `an AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

/** A member's profile that has just been sent for review, and the request waiting on it. */
function submitted(t: ReturnType<typeof setup>, assignedAgentId: string | null = null) {
  const profile = t.store.addProfile({ status: 'pending_review', assignedAgentId });
  const review = t.store.addReview(profile.id, t.member);
  return { profile, review };
}

await test('only staff can use the queue', async () => {
  const t = setup();
  const { review } = submitted(t);
  await rejects(t.service.list(t.asMember, query()), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.detail(t.asMember, review.id), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.pendingCount(t.asMember), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.approve(t.asMember, review.id, {}, 'c'), 403, 'ROLE_FORBIDDEN');
  await rejects(
    t.service.reject(t.asMember, review.id, { note: 'no' }, 'c'),
    403,
    'ROLE_FORBIDDEN',
  );
});

await test('an admin sees every waiting request, the longest wait first', async () => {
  const t = setup();
  const first = submitted(t, t.abir.id).review;
  const second = submitted(t, null).review;
  const third = submitted(t, t.other.id).review;
  const page = await t.service.list(t.asAdmin, query());
  assert.deepEqual(
    page.items.map((i) => i.id),
    [first.id, second.id, third.id],
  );
  assert.equal(page.next, null);
});

await test("an agent sees requests for their own clients and for unassigned profiles, and no one else's", async () => {
  const t = setup();
  const mine = submitted(t, t.abir.id).review;
  const unassigned = submitted(t, null).review;
  const theirs = submitted(t, t.other.id).review;

  const seen = (await t.service.list(t.asAbir, query())).items.map((i) => i.id);
  assert.deepEqual(seen, [mine.id, unassigned.id]);
  assert.equal(await t.service.pendingCount(t.asAbir), 2);
  assert.equal(await t.service.pendingCount(t.asAdmin), 3);

  await t.service.detail(t.asAbir, mine.id);
  await t.service.detail(t.asAbir, unassigned.id);
  // Not theirs: reported as not found, so an agent cannot tell what exists.
  await rejects(t.service.detail(t.asAbir, theirs.id), 404, 'REVIEW_NOT_FOUND');
  await rejects(t.service.approve(t.asAbir, theirs.id, {}, 'c'), 404, 'REVIEW_NOT_FOUND');
  await rejects(t.service.reject(t.asAbir, theirs.id, { note: 'x' }, 'c'), 404, 'REVIEW_NOT_FOUND');
  await rejects(t.service.photoKey(t.asAbir, theirs.id), 404, 'REVIEW_NOT_FOUND');
});

await test('the queue can be filtered by status and kind', async () => {
  const t = setup();
  const { review } = submitted(t);
  const update = t.store.addReview(t.store.addProfile().id, t.member, { kind: 'field_update' });
  t.store.addReview(t.store.addProfile().id, t.member, { status: 'approved' });

  assert.equal(
    (await t.service.list(t.asAdmin, query({ kind: 'field_update' }))).items[0]?.id,
    update.id,
  );
  assert.equal(
    (await t.service.list(t.asAdmin, query({ kind: 'initial_submission' }))).items[0]?.id,
    review.id,
  );
  assert.equal((await t.service.list(t.asAdmin, query({ status: 'approved' }))).items.length, 1);
  assert.equal((await t.service.list(t.asAdmin, query({ status: 'rejected' }))).items.length, 0);
});

await test('a long queue is read a page at a time, with nothing missed or repeated', async () => {
  const t = setup();
  const ids = Array.from({ length: 5 }, () => submitted(t).review.id);

  const seen: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await t.service.list(t.asAdmin, query({ limit: 2, after }));
    seen.push(...page.items.map((i) => i.id));
    after = page.next ?? undefined;
    pages += 1;
  } while (after);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);
});

await test('a made-up position in the queue is refused', async () => {
  const t = setup();
  await rejects(
    t.service.list(t.asAdmin, query({ after: 'not-a-cursor' })),
    400,
    'INVALID_REQUEST',
  );
});

await test('a first submission is shown as everything that was filled in', async () => {
  const t = setup();
  const { review } = submitted(t);
  const detail = await t.service.detail(t.asAdmin, review.id);
  assert.equal(detail.kind, 'initial_submission');
  assert.ok(detail.changes.some((c) => c.path === 'profile.fullName' && c.after === 'Rahim Uddin'));
  assert.ok(detail.changes.every((c) => c.before === null));
  assert.equal(detail.canDecide, true);
  assert.equal(detail.blockedBy, null);
  assert.equal(detail.stale, false);
  assert.equal(detail.submittedBy.displayName, 'Niha');
});

await test('a change request is shown as old and new values, only for what changed', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'field_update',
    proposed: { profile: { heightCm: 180 }, contact: { email: 'a@example.com' } },
  });
  const detail = await t.service.detail(t.asAdmin, review.id);
  assert.deepEqual(detail.changes, [
    { path: 'profile.heightCm', before: 172, after: 180 },
    { path: 'contact.email', before: null, after: 'a@example.com' },
  ]);
});

await test('approving a first submission publishes the profile and records who and why', async () => {
  const t = setup();
  const { profile, review } = submitted(t);
  const detail = await t.service.approve(t.asAdmin, review.id, { note: 'Looks good.' }, 'req-1');

  assert.equal(detail.status, 'approved');
  assert.equal(detail.reviewerNotes, 'Looks good.');
  assert.equal(detail.decidedBy?.displayName, 'Admin');
  assert.equal(t.store.profiles.get(profile.id)?.status, 'active');
  assert.equal(t.store.events.at(-1)?.type, 'profile.approved');
  assert.equal(t.store.events.at(-1)?.subjectId, profile.id);
  assert.equal(t.store.events.at(-1)?.correlationId, 'req-1');
  assert.equal(detail.canDecide, false);
  assert.equal(detail.blockedBy, 'decided');
});

await test('rejecting a first submission sends it back with the reason', async () => {
  const t = setup();
  const { profile, review } = submitted(t);
  const detail = await t.service.reject(
    t.asAdmin,
    review.id,
    { note: 'Add a clearer description.' },
    'c',
  );

  assert.equal(detail.status, 'rejected');
  assert.equal(detail.reviewerNotes, 'Add a clearer description.');
  assert.equal(t.store.profiles.get(profile.id)?.status, 'rejected');
  assert.equal(t.store.events.at(-1)?.type, 'profile.rejected');
});

await test('approving a change request applies only the changed fields, and keeps the profile live', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'field_update',
    proposed: { profile: { heightCm: 180, aboutMe: 'Hello' } },
  });
  await t.service.approve(t.asAdmin, review.id, {}, 'c');

  const after = t.store.profiles.get(profile.id)!;
  assert.equal(after.data.profile.heightCm, 180);
  assert.equal(after.data.profile.aboutMe, 'Hello');
  assert.equal(after.data.profile.fullName, 'Rahim Uddin', 'untouched fields stay');
  assert.equal(after.status, 'active');
  assert.equal(after.version, 4, 'the content change is a new version');
});

await test('rejecting a change request leaves the published profile exactly as it was', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const before = structuredClone(profile.data);
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'field_update',
    proposed: { profile: { heightCm: 180 } },
  });
  await t.service.reject(t.asAdmin, review.id, { note: 'Please give a source.' }, 'c');

  const after = t.store.profiles.get(profile.id)!;
  assert.deepEqual(after.data, before);
  assert.equal(after.version, 3);
  assert.equal(after.status, 'active');
});

await test('a request cannot be approved once the profile has changed since it was made', async () => {
  const t = setup();
  const { profile, review } = submitted(t);
  // Something changed the profile after the request (for example a staff edit).
  t.store.profiles.get(profile.id)!.version += 1;

  const detail = await t.service.detail(t.asAdmin, review.id);
  assert.equal(detail.stale, true);
  assert.equal(detail.canDecide, false);
  assert.equal(detail.blockedBy, 'stale');
  await rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), 409, 'REVIEW_OUT_OF_DATE');
  await rejects(
    t.service.reject(t.asAdmin, review.id, { note: 'x' }, 'c'),
    409,
    'REVIEW_OUT_OF_DATE',
  );
  assert.equal(t.store.profiles.get(profile.id)?.status, 'pending_review', 'nothing was applied');
  assert.equal(t.store.reviews[0]?.status, 'pending');
});

await test('an approval is refused if the profile moved on while the reviewer was reading it', async () => {
  const t = setup();
  const { profile, review } = submitted(t);
  await rejects(
    t.service.approve(t.asAdmin, review.id, { profileVersion: profile.version - 1 }, 'c'),
    409,
    'REVIEW_OUT_OF_DATE',
  );
  // The version the reviewer saw is accepted.
  const detail = await t.service.approve(
    t.asAdmin,
    review.id,
    { profileVersion: profile.version },
    'c',
  );
  assert.equal(detail.status, 'approved');
});

await test('a change request cannot be applied to a profile that is no longer live', async () => {
  const t = setup();
  const profile = t.store.addProfile({ status: 'closed' });
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'field_update',
    proposed: { profile: { heightCm: 180 } },
  });
  await rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), 409, 'REVIEW_OUT_OF_DATE');
  assert.equal(t.store.profiles.get(profile.id)?.data.profile.heightCm, 172);
});

await test('a change that would leave a required field empty is refused', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'field_update',
    proposed: { profile: { religionCode: null } },
  });
  await assert.rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, 'PROFILE_INCOMPLETE');
    return true;
  });
  assert.equal(t.store.profiles.get(profile.id)?.data.profile.religionCode, 'islam');
});

await test('a request that was decided is not decided again, and one that was withdrawn cannot be decided', async () => {
  const t = setup();
  const { review } = submitted(t);
  await t.service.approve(t.asAdmin, review.id, {}, 'c');
  await rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), 409, 'REVIEW_ALREADY_DECIDED');
  await rejects(
    t.service.reject(t.asAdmin, review.id, { note: 'late' }, 'c'),
    409,
    'REVIEW_ALREADY_DECIDED',
  );

  const withdrawn = t.store.addReview(t.store.addProfile().id, t.member, { status: 'cancelled' });
  await rejects(t.service.approve(t.asAdmin, withdrawn.id, {}, 'c'), 409, 'REVIEW_CANCELLED');
  assert.equal((await t.service.detail(t.asAdmin, withdrawn.id)).blockedBy, 'cancelled');
});

await test('when two reviewers decide at once, the one who loses is told, not silently ignored', async () => {
  const t = setup();
  const { review } = submitted(t);
  t.store.loseNextDecision = true;
  await rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), 409, 'REVIEW_ALREADY_DECIDED');
});

await test('nobody decides their own submission, except an admin', async () => {
  const t = setup();
  // A client the agent made and submitted for review.
  const profile = t.store.addProfile({
    status: 'pending_review',
    serviceMode: 'assisted',
    ownerId: null,
    assignedAgentId: t.abir.id,
  });
  const review = t.store.addReview(profile.id, t.abir);

  const detail = await t.service.detail(t.asAbir, review.id);
  assert.equal(detail.canDecide, false);
  assert.equal(detail.blockedBy, 'own_submission');
  await rejects(t.service.approve(t.asAbir, review.id, {}, 'c'), 409, 'REVIEW_OWN_SUBMISSION');
  await rejects(
    t.service.reject(t.asAbir, review.id, { note: 'x' }, 'c'),
    409,
    'REVIEW_OWN_SUBMISSION',
  );

  // A colleague, or an admin, can.
  const asAdminOwn = t.store.addReview(
    t.store.addProfile({ status: 'pending_review', assignedAgentId: null }).id,
    t.admin,
  );
  assert.equal((await t.service.detail(t.asAdmin, asAdminOwn.id)).canDecide, true);
  const approved = await t.service.approve(t.asAdmin, review.id, {}, 'c');
  assert.equal(approved.status, 'approved');
});

await test('approving a photo makes it visible, and the first approved photo becomes the main one', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const first = t.store.addPhoto(profile.id);
  const second = t.store.addPhoto(profile.id);
  const r1 = t.store.addReview(profile.id, t.member, {
    kind: 'photo_add',
    photoId: first,
    proposed: null,
  });
  const r2 = t.store.addReview(profile.id, t.member, {
    kind: 'photo_add',
    photoId: second,
    proposed: null,
  });

  const detail = await t.service.detail(t.asAdmin, r1.id);
  assert.equal(detail.changes.length, 0);
  assert.equal(detail.photoId, first);
  assert.equal(detail.stale, false, 'photos do not depend on the profile version');

  await t.service.approve(t.asAdmin, r1.id, {}, 'c');
  await t.service.approve(t.asAdmin, r2.id, {}, 'c');
  assert.equal(t.store.photos.get(first)?.status, 'published');
  assert.equal(t.store.photos.get(first)?.isPrimary, true);
  assert.equal(t.store.photos.get(second)?.status, 'published');
  assert.equal(t.store.photos.get(second)?.isPrimary, false, 'only one main photo');
  assert.equal(t.store.events.at(-1)?.type, 'photo.approved');
  assert.equal(t.store.events.at(-1)?.subjectId, second);
});

await test('rejecting a photo leaves it with its owner, unpublished', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const photo = t.store.addPhoto(profile.id);
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'photo_add',
    photoId: photo,
    proposed: null,
  });
  await t.service.reject(t.asAdmin, review.id, { note: 'Face not visible.' }, 'c');
  assert.equal(t.store.photos.get(photo)?.status, 'staged');
  assert.equal(t.store.events.at(-1)?.type, 'photo.rejected');
});

await test('a photo that was removed after it was uploaded cannot be approved', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const photo = t.store.addPhoto(profile.id, 'removed');
  const review = t.store.addReview(profile.id, t.member, {
    kind: 'photo_add',
    photoId: photo,
    proposed: null,
  });
  await rejects(t.service.approve(t.asAdmin, review.id, {}, 'c'), 409, 'REVIEW_OUT_OF_DATE');
  await rejects(t.service.photoKey(t.asAdmin, review.id), 404, 'PHOTO_NOT_FOUND');
});

await test('a reviewer can see the photo they are asked to approve, and only that', async () => {
  const t = setup();
  const profile = t.store.addProfile();
  const photo = t.store.addPhoto(profile.id);
  const withPhoto = t.store.addReview(profile.id, t.member, {
    kind: 'photo_add',
    photoId: photo,
    proposed: null,
  });
  const key = await t.service.photoKey(t.asAdmin, withPhoto.id);
  assert.ok(key.storageKey.startsWith(`${agency}/${profile.id}/`));

  const { review } = submitted(t);
  await rejects(t.service.photoKey(t.asAdmin, review.id), 404, 'PHOTO_NOT_FOUND');
  await rejects(t.service.photoKey(t.asAdmin, randomUUID()), 404, 'REVIEW_NOT_FOUND');
});

await test('a request that does not exist is a not-found', async () => {
  const t = setup();
  await rejects(t.service.detail(t.asAdmin, randomUUID()), 404, 'REVIEW_NOT_FOUND');
  await rejects(t.service.approve(t.asAdmin, randomUUID(), {}, 'c'), 404, 'REVIEW_NOT_FOUND');
});
