import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { profileInputSchema } from '../src/bo/profile.js';
import {
  CONTACT_COLUMNS,
  PREFERENCE_COLUMNS,
  PROFILE_COLUMNS,
} from '../src/db/raw/query/profile-columns.js';
import { AppError } from '../src/exception/app-error.js';
import { ProfileService, type ProfileActor } from '../src/service/profile-service.js';
import { agency, otherAgency } from './fixtures.js';
import { FakeStore } from './fake-profile-store.js';

const schema = profileInputSchema(new Date(Date.UTC(2026, 9, 6)));
const parse = (input: unknown) => schema.parse(input);

const completeProfile = {
  fullName: 'Rahim Uddin',
  dateOfBirth: '1996-05-12',
  gender: 'male',
  maritalStatus: 'never_married',
  heightCm: 172,
  religionCode: 'islam',
  currentDistrictCode: 'dhaka',
  highestDegreeCode: 'bachelors',
  occupationCode: 'salaried',
};
const completeInput = (version?: number, profile: Record<string, unknown> = {}, contact = {}) =>
  parse({
    version,
    profile: { ...completeProfile, ...profile },
    contact: { phone: '+8801712345678', ...contact },
  });

function setup(memberCode?: () => string) {
  const store = new FakeStore();
  const service = new ProfileService(store.db, () => new Date('2026-10-06T10:00:00Z'), memberCode);
  const member: ProfileActor = { agencyId: agency, accountId: randomUUID(), role: 'member' };
  return { store, service, member };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, 'an AppError');
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

await test('a member with no profile sees nothing yet', async () => {
  const { service, member } = setup();
  assert.deepEqual(await service.get(member), {
    profile: null,
    pendingReview: null,
    lastDecision: null,
  });
});

await test('agents and admins have no profile of their own and are refused everywhere', async () => {
  const { service, member } = setup();
  for (const role of ['agent', 'admin'] as const) {
    const actor = { ...member, role };
    await rejects(service.get(actor), 403, 'ROLE_FORBIDDEN');
    await rejects(service.save(actor, completeInput()), 403, 'ROLE_FORBIDDEN');
    await rejects(service.submit(actor, 1, 'c'), 403, 'ROLE_FORBIDDEN');
    await rejects(service.requestEdit(actor, completeInput(1), 'c'), 403, 'ROLE_FORBIDDEN');
    await rejects(service.cancelPending(actor, 'c'), 403, 'ROLE_FORBIDDEN');
  }
});

await test('the first save creates a draft owned by the member, with a member code', async () => {
  const { service, member, store } = setup();
  const state = await service.save(member, parse({ profile: { fullName: 'Rahim' } }));
  assert.equal(state.profile?.status, 'draft');
  assert.equal(state.profile?.version, 1);
  assert.match(state.profile!.memberCode, /^M\d{7}$|^M[0-9a-f-]{7}$/);
  assert.equal(state.profile?.data.profile.fullName, 'Rahim');
  assert.equal(store.profiles.size, 1);
  assert.equal(state.pendingReview, null);
});

await test('later saves need the current version and raise it', async () => {
  const { service, member } = setup();
  const first = await service.save(member, parse({ profile: { fullName: 'Rahim' } }));
  const second = await service.save(
    member,
    parse({ version: first.profile!.version, profile: { fullName: 'Rahim U' } }),
  );
  assert.equal(second.profile?.version, 2);
  assert.equal(second.profile?.data.profile.fullName, 'Rahim U');

  // A stale or missing version means another tab got there first.
  await rejects(
    service.save(member, parse({ version: 1, profile: { fullName: 'Stale' } })),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  await rejects(
    service.save(member, parse({ profile: { fullName: 'No version' } })),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  assert.equal((await service.get(member)).profile?.data.profile.fullName, 'Rahim U');
});

await test('a first save that claims a version refers to a profile that does not exist', async () => {
  const { service, member, store } = setup();
  await rejects(
    service.save(member, parse({ version: 3, profile: { fullName: 'X' } })),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  assert.equal(store.profiles.size, 0);
});

await test('a member code that is already taken is replaced by a fresh one', async () => {
  const codes = ['M0000001', 'M0000001', 'M0000002'];
  const { service, member, store } = setup(() => codes.shift()!);
  store.takenCodes.add('M0000001');
  const state = await service.save(member, parse({ profile: { fullName: 'A' } }));
  assert.equal(state.profile?.memberCode, 'M0000002');
  assert.equal(store.createCalls, 3);
});

await test('it gives up cleanly when no free member code can be found', async () => {
  const { service, member, store } = setup(() => 'M0000001');
  store.takenCodes.add('M0000001');
  await rejects(
    service.save(member, parse({ profile: { fullName: 'A' } })),
    503,
    'MEMBER_CODE_UNAVAILABLE',
  );
  assert.equal(store.createCalls, 5);
  assert.equal(store.profiles.size, 0);
});

await test('two first saves at once end in a conflict for the loser, not a duplicate profile', async () => {
  const { service, member, store } = setup();
  store.raceOnNextCreate = true;
  await rejects(
    service.save(member, parse({ profile: { fullName: 'A' } })),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  assert.equal(store.profiles.size, 1);
});

await test('submitting an incomplete profile says exactly what is missing and changes nothing', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, parse({ profile: { fullName: 'Rahim' } }));
  await assert.rejects(service.submit(member, draft.profile!.version, 'c'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'PROFILE_INCOMPLETE');
    const fields = (error.details as { fields: { path: string; code: string }[] }).fields;
    assert.ok(fields.some((f) => f.path === 'contact.phone' && f.code === 'required'));
    assert.ok(!fields.some((f) => f.path === 'profile.fullName'));
    return true;
  });
  assert.equal((await service.get(member)).profile?.status, 'draft');
  assert.equal(store.reviews.length, 0);
  assert.equal(store.events.length, 0);
});

await test('submitting a complete draft locks it, records the review and an event together', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, completeInput());
  const state = await service.submit(member, draft.profile!.version, 'req-1');

  assert.equal(state.profile?.status, 'pending_review');
  assert.equal(state.pendingReview?.kind, 'initial_submission');
  assert.equal(state.pendingReview?.baseProfileVersion, state.profile?.version);
  assert.equal(state.pendingReview?.proposedChanges !== null, true);

  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]?.type, 'profile.submitted');
  assert.equal(store.events[0]?.actorId, member.accountId);
  assert.equal(store.events[0]?.subjectId, state.profile?.id);
  assert.equal(store.events[0]?.correlationId, 'req-1');
});

await test('a submitted profile cannot be changed or submitted again until the review ends', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, completeInput());
  const pending = await service.submit(member, draft.profile!.version, 'c');
  const version = pending.profile!.version;

  await rejects(
    service.save(member, completeInput(version, { aboutMe: 'x' })),
    409,
    'PROFILE_LOCKED',
  );
  await rejects(service.submit(member, version, 'c'), 409, 'PROFILE_LOCKED');
  await rejects(
    service.requestEdit(member, completeInput(version, { aboutMe: 'x' }), 'c'),
    409,
    'PROFILE_LOCKED',
  );
  assert.equal(store.reviews.length, 1);
});

await test('submitting needs the current version', async () => {
  const { service, member } = setup();
  const draft = await service.save(member, completeInput());
  await rejects(
    service.submit(member, draft.profile!.version + 5, 'c'),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  assert.equal((await service.get(member)).profile?.status, 'draft');
});

await test('submitting with no profile at all is a not-found', async () => {
  const { service, member } = setup();
  await rejects(service.submit(member, 1, 'c'), 404, 'PROFILE_NOT_FOUND');
});

await test('withdrawing a first submission returns it to an editable draft', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, completeInput());
  await service.submit(member, draft.profile!.version, 'c');

  const state = await service.cancelPending(member, 'req-2');
  assert.equal(state.profile?.status, 'draft');
  assert.equal(state.pendingReview, null);
  assert.equal(store.reviews[0]?.status, 'cancelled');
  assert.equal(store.events.at(-1)?.type, 'profile.review_cancelled');

  const edited = await service.save(
    member,
    completeInput(state.profile!.version, { aboutMe: 'Edited' }),
  );
  assert.equal(edited.profile?.data.profile.aboutMe, 'Edited');
});

await test('there is nothing to withdraw when nothing is waiting', async () => {
  const { service, member, store } = setup();
  await rejects(service.cancelPending(member, 'c'), 404, 'PROFILE_NOT_FOUND');
  await service.save(member, completeInput());
  await rejects(service.cancelPending(member, 'c'), 404, 'NO_PENDING_REVIEW');
  assert.equal(store.events.length, 0);
});

await test('a rejected profile shows the reviewer note, can be edited and sent again', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, completeInput());
  await service.submit(member, draft.profile!.version, 'c');
  store.decide(member.accountId, 'rejected', 'Please add a clearer description.');

  const rejected = await service.get(member);
  assert.equal(rejected.profile?.status, 'rejected');
  assert.equal(rejected.lastDecision?.status, 'rejected');
  assert.equal(rejected.lastDecision?.reviewerNotes, 'Please add a clearer description.');
  assert.equal(rejected.pendingReview, null);

  const edited = await service.save(
    member,
    completeInput(rejected.profile!.version, { aboutMe: 'Better' }),
  );
  assert.equal(edited.profile?.status, 'draft');
  const again = await service.submit(member, edited.profile!.version, 'c2');
  assert.equal(again.profile?.status, 'pending_review');
  assert.equal(store.reviews.length, 2);
});

await test('a rejected profile can be resubmitted as it is', async () => {
  const { service, member, store } = setup();
  const draft = await service.save(member, completeInput());
  await service.submit(member, draft.profile!.version, 'c');
  store.decide(member.accountId, 'rejected');
  const rejected = await service.get(member);
  const again = await service.submit(member, rejected.profile!.version, 'c');
  assert.equal(again.profile?.status, 'pending_review');
});

async function published() {
  const ctx = setup();
  const draft = await ctx.service.save(ctx.member, completeInput());
  await ctx.service.submit(ctx.member, draft.profile!.version, 'c');
  ctx.store.decide(ctx.member.accountId, 'approved');
  const state = await ctx.service.get(ctx.member);
  assert.equal(state.profile?.status, 'active');
  return { ...ctx, version: state.profile!.version };
}

await test('a published profile is never edited directly', async () => {
  const { service, member, version } = await published();
  await rejects(
    service.save(member, completeInput(version, { aboutMe: 'x' })),
    409,
    'PROFILE_EDIT_REQUIRES_REVIEW',
  );
});

await test('a change to a published profile becomes a review request with only what differs', async () => {
  const { service, member, store, version } = await published();
  const state = await service.requestEdit(
    member,
    completeInput(version, { heightCm: 175, aboutMe: 'Hello' }, { email: 'a@example.com' }),
    'req-3',
  );

  assert.equal(state.pendingReview?.kind, 'field_update');
  assert.equal(state.pendingReview?.baseProfileVersion, version);
  assert.deepEqual(state.pendingReview?.proposedChanges, {
    profile: { heightCm: 175, aboutMe: 'Hello' },
    contact: { email: 'a@example.com' },
  });
  // The published content stays exactly as approved until the change is approved.
  assert.equal(state.profile?.data.profile.heightCm, 172);
  assert.equal(state.profile?.data.profile.aboutMe, null);
  assert.equal(state.profile?.status, 'active');
  assert.equal(store.events.at(-1)?.type, 'profile.edit_requested');
});

await test('only one change request can wait at a time, and an empty one is refused', async () => {
  const { service, member, version } = await published();
  await rejects(service.requestEdit(member, completeInput(version), 'c'), 422, 'NO_CHANGES');
  await service.requestEdit(member, completeInput(version, { aboutMe: 'One' }), 'c');
  await rejects(
    service.requestEdit(member, completeInput(version, { aboutMe: 'Two' }), 'c'),
    409,
    'PROFILE_LOCKED',
  );
});

await test('a change request cannot empty a required field or use an old version', async () => {
  const { service, member, version } = await published();
  const emptied = parse({
    version,
    profile: { ...completeProfile, religionCode: null },
    contact: { phone: '+8801712345678' },
  });
  await rejects(service.requestEdit(member, emptied, 'c'), 422, 'PROFILE_INCOMPLETE');
  await rejects(
    service.requestEdit(member, completeInput(version + 1, { aboutMe: 'x' }), 'c'),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
});

await test('withdrawing a change request leaves the published profile active and untouched', async () => {
  const { service, member, store, version } = await published();
  await service.requestEdit(member, completeInput(version, { aboutMe: 'Hello' }), 'c');
  const state = await service.cancelPending(member, 'c');
  assert.equal(state.profile?.status, 'active');
  assert.equal(state.profile?.version, version);
  assert.equal(state.pendingReview, null);
  assert.equal(store.reviews.at(-1)?.status, 'cancelled');
});

await test('changes can only be requested for a published profile', async () => {
  const { service, member } = setup();
  const draft = await service.save(member, completeInput());
  await rejects(
    service.requestEdit(member, completeInput(draft.profile!.version, { aboutMe: 'x' }), 'c'),
    409,
    'PROFILE_STATE_INVALID',
  );

  const live = await published();
  for (const status of ['paused', 'matched', 'closed'] as const) {
    live.store.setStatus(live.member.accountId, status);
    await rejects(
      live.service.requestEdit(live.member, completeInput(live.version, { aboutMe: 'x' }), 'c'),
      409,
      'PROFILE_STATE_INVALID',
    );
    await rejects(
      live.service.save(live.member, completeInput(live.version, { aboutMe: 'x' })),
      409,
      'PROFILE_EDIT_REQUIRES_REVIEW',
    );
  }
});

await test('each member sees only their own profile, and agencies are kept apart', async () => {
  const { service, member, store } = setup();
  const other: ProfileActor = { agencyId: agency, accountId: randomUUID(), role: 'member' };
  const elsewhere: ProfileActor = {
    agencyId: otherAgency,
    accountId: member.accountId,
    role: 'member',
  };

  await service.save(member, parse({ profile: { fullName: 'Mine' } }));
  await service.save(other, parse({ profile: { fullName: 'Theirs' } }));
  assert.equal((await service.get(member)).profile?.data.profile.fullName, 'Mine');
  assert.equal((await service.get(other)).profile?.data.profile.fullName, 'Theirs');
  assert.equal((await service.get(elsewhere)).profile, null);
  assert.equal(store.profiles.size, 2);
});

await test('the validation schema and the database column list describe exactly the same fields', () => {
  const parsed = parse({ profile: { fullName: 'A' } });
  const keys = (specs: readonly { key: string }[]) => specs.map((s) => s.key).sort();
  assert.deepEqual(Object.keys(parsed.profile).sort(), keys(PROFILE_COLUMNS));
  assert.deepEqual(Object.keys(parsed.contact).sort(), keys(CONTACT_COLUMNS));
  assert.deepEqual(Object.keys(parsed.preferences).sort(), keys(PREFERENCE_COLUMNS));
});
