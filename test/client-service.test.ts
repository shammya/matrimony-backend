import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  clientInputSchema,
  clientListQuerySchema,
  type ClientListItem,
  type ClientListQuery,
  type StaffMember,
} from '../src/bo/client.js';
import type { ClientUnit } from '../src/db/service/client-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { ClientService } from '../src/service/client-service.js';
import { ProfileService, type ProfileActor } from '../src/service/profile-service.js';
import { agency } from './fixtures.js';
import { FakeStore } from './fake-profile-store.js';

const input = (version?: number, profile: Record<string, unknown> = {}, extra = {}) =>
  clientInputSchema(new Date(Date.UTC(2026, 9, 6))).parse({
    version,
    profile: {
      fullName: 'Karima Begum',
      dateOfBirth: '1998-03-02',
      gender: 'female',
      maritalStatus: 'never_married',
      heightCm: 160,
      religionCode: 'islam',
      currentDistrictCode: 'dhaka',
      highestDegreeCode: 'bachelors',
      occupationCode: 'student',
      ...profile,
    },
    contact: { phone: '+8801712345678' },
    ...extra,
  });
const query = (over: Partial<ClientListQuery> = {}): ClientListQuery => ({
  ...clientListQuerySchema.parse({}),
  ...over,
});

function setup() {
  const store = new FakeStore();
  const names = new Map<string, string>();
  const staff: StaffMember[] = [];
  const person = (
    name: string,
    role: 'admin' | 'agent',
    status: StaffMember['status'] = 'active',
  ) => {
    const id = randomUUID();
    names.set(id, name);
    staff.push({ id, displayName: name, email: null, role, status });
    return id;
  };
  const admin = person('Admin', 'admin');
  const abir = person('Abir', 'agent');
  const other = person('Other agent', 'agent');
  const gone = person('Disabled agent', 'agent', 'disabled');

  const calls: { viewer: string | null; filter: unknown; page: unknown }[] = [];
  let rows: ClientListItem[] = [];
  const events: string[] = [];

  const unit: ClientUnit = {
    list: async (_agencyId, filter, viewer, page) => {
      calls.push({ viewer, filter, page });
      return rows.slice(0, page.limit + 1);
    },
    meta: async (_agencyId, profileId) => {
      const p = store.profiles.get(profileId);
      if (!p) return null;
      return {
        serviceMode: p.serviceMode,
        assignedAgent: p.assignedAgentId
          ? { id: p.assignedAgentId, displayName: names.get(p.assignedAgentId) ?? '?' }
          : null,
        owner: null,
      };
    },
    staff: async () => staff,
    staffMember: async (_agencyId, id) => staff.find((s) => s.id === id) ?? null,
    assign: async (_agencyId, profileId, agentId) => {
      const p = store.profiles.get(profileId);
      if (!p) return false;
      p.assignedAgentId = agentId;
      return true;
    },
    appendEvent: async (event) => {
      events.push(event.type);
    },
  };
  const service = new ClientService(
    { inTransaction: (_agencyId, work) => work(unit) },
    new ProfileService(store.db, () => new Date('2026-10-06T10:00:00Z')),
    () => new Date('2026-10-06T10:00:00Z'),
  );
  const as = (id: string, role: ProfileActor['role']): ProfileActor => ({
    agencyId: agency,
    accountId: id,
    role,
  });
  return {
    store,
    service,
    calls,
    events,
    ids: { admin, abir, other, gone },
    setRows: (next: ClientListItem[]) => (rows = next),
    asAdmin: as(admin, 'admin'),
    asAbir: as(abir, 'agent'),
    asOther: as(other, 'agent'),
    asMember: as(randomUUID(), 'member'),
  };
}

const rejects = (promise: Promise<unknown>, status: number, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `an AppError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });

const row = (n: number): ClientListItem => ({
  id: randomUUID(),
  memberCode: `M000000${n}`,
  fullName: `Client ${n}`,
  status: 'active',
  serviceMode: 'assisted',
  version: 1,
  position: new Date(Date.UTC(2026, 9, 6, 12, 0, 0)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 6, 12, 0, 0) - n * 60_000).toISOString(),
  assignedAgent: null,
  districtCode: null,
  hasPendingReview: false,
});

await test('only staff manage clients', async () => {
  const t = setup();
  await rejects(t.service.list(t.asMember, query()), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.create(t.asMember, input(), 'c'), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.detail(t.asMember, randomUUID()), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.assign(t.asMember, randomUUID(), null, 'c'), 403, 'ROLE_FORBIDDEN');
  await rejects(t.service.listStaff(t.asMember), 403, 'ROLE_FORBIDDEN');
});

await test("an agent's list is their own clients, whatever they ask for", async () => {
  const t = setup();
  await t.service.list(t.asAbir, query({ assignedTo: t.ids.other, q: 'karima', status: 'active' }));
  const call = t.calls[0]!;
  assert.equal(call.viewer, t.ids.abir, 'limited to their own');
  assert.deepEqual(call.filter, {
    status: 'active',
    serviceMode: undefined,
    agentId: null,
    unassignedOnly: false,
    search: 'karima',
  });
});

await test('an admin sees every client and may filter by agent or by unassigned', async () => {
  const t = setup();
  await t.service.list(t.asAdmin, query());
  await t.service.list(t.asAdmin, query({ assignedTo: t.ids.abir }));
  await t.service.list(t.asAdmin, query({ assignedTo: 'none' }));
  assert.equal(t.calls[0]?.viewer, null);
  assert.deepEqual(t.calls[1]?.filter, {
    status: undefined,
    serviceMode: undefined,
    agentId: t.ids.abir,
    unassignedOnly: false,
    search: undefined,
  });
  assert.equal((t.calls[2]?.filter as { unassignedOnly: boolean }).unassignedOnly, true);
});

await test('the list is paged: one more is asked for to know if there is a next page', async () => {
  const t = setup();
  t.setRows([row(1), row(2), row(3)]);
  const page = await t.service.list(t.asAdmin, query({ limit: 2 }));
  assert.equal((t.calls[0]?.page as { limit: number }).limit, 2);
  assert.equal(page.items.length, 2);
  assert.ok(page.next, 'there is a next page');

  t.setRows([row(1), row(2)]);
  assert.equal((await t.service.list(t.asAdmin, query({ limit: 2 }))).next, null);
  await rejects(t.service.list(t.asAdmin, query({ after: 'nonsense' })), 400, 'INVALID_REQUEST');
});

await test("an agent's new client is assigned to that agent, and has no login", async () => {
  const t = setup();
  const { id, detail } = await t.service.create(t.asAbir, input(), 'req-1');
  const profile = t.store.profiles.get(id)!;
  assert.equal(profile.serviceMode, 'assisted');
  assert.equal(profile.ownerId, null);
  assert.equal(profile.assignedAgentId, t.ids.abir);
  assert.equal(profile.status, 'draft');
  assert.equal(t.store.createdBy, t.ids.abir);
  assert.equal(detail.meta.assignedAgent?.displayName, 'Abir');
  assert.equal(t.store.events.at(-1)?.type, 'client.created');
  assert.equal(t.store.events.at(-1)?.correlationId, 'req-1');
});

await test('an agent cannot hand a new client to someone else', async () => {
  const t = setup();
  const { id } = await t.service.create(
    t.asAbir,
    input(undefined, {}, { assignedAgentId: t.ids.other }),
    'c',
  );
  assert.equal(t.store.profiles.get(id)?.assignedAgentId, t.ids.abir);
});

await test("an admin's new client can be handed to an active agent or left unassigned", async () => {
  const t = setup();
  const handed = await t.service.create(
    t.asAdmin,
    input(undefined, {}, { assignedAgentId: t.ids.other }),
    'c',
  );
  assert.equal(t.store.profiles.get(handed.id)?.assignedAgentId, t.ids.other);
  const unassigned = await t.service.create(t.asAdmin, input(), 'c');
  assert.equal(t.store.profiles.get(unassigned.id)?.assignedAgentId, null);

  for (const bad of [t.ids.gone, randomUUID()]) {
    await rejects(
      t.service.create(t.asAdmin, input(undefined, {}, { assignedAgentId: bad }), 'c'),
      422,
      'AGENT_NOT_AVAILABLE',
    );
  }
});

await test("an agent reaches only their own clients; another agent's are not found", async () => {
  const t = setup();
  const { id } = await t.service.create(t.asAbir, input(), 'c');
  await t.service.detail(t.asAbir, id);
  await t.service.detail(t.asAdmin, id);
  await rejects(t.service.detail(t.asOther, id), 404, 'PROFILE_NOT_FOUND');
  await rejects(t.service.save(t.asOther, id, input(1)), 404, 'PROFILE_NOT_FOUND');
  await rejects(t.service.submit(t.asOther, id, 1, 'c'), 404, 'PROFILE_NOT_FOUND');
  await rejects(t.service.cancelPending(t.asOther, id, 'c'), 404, 'PROFILE_NOT_FOUND');
  await rejects(t.service.changeStatus(t.asOther, id, 'closed', 1, 'c'), 404, 'PROFILE_NOT_FOUND');
});

await test("staff edit a client's draft, send it for review under their own name, and withdraw it", async () => {
  const t = setup();
  const { id, detail } = await t.service.create(t.asAbir, input(), 'c');

  const saved = await t.service.save(
    t.asAbir,
    id,
    input(detail.state.profile!.version, { aboutMe: 'Hello' }),
  );
  assert.equal(saved.state.profile?.data.profile?.aboutMe, 'Hello');

  const sent = await t.service.submit(t.asAbir, id, saved.state.profile!.version, 'c');
  assert.equal(sent.state.profile?.status, 'pending_review');
  assert.equal(sent.state.pendingReview?.kind, 'initial_submission');
  assert.equal(
    t.store.reviews[0]?.submittedBy,
    t.ids.abir,
    "recorded as the staff member's submission",
  );

  const back = await t.service.cancelPending(t.asAbir, id, 'c');
  assert.equal(back.state.profile?.status, 'draft');
  assert.equal(back.state.pendingReview, null);
});

await test("a published client's change goes through review, like a member's", async () => {
  const t = setup();
  const { id, detail } = await t.service.create(t.asAbir, input(), 'c');
  await t.service.submit(t.asAbir, id, detail.state.profile!.version, 'c');
  // Play the reviewer.
  const profile = t.store.profiles.get(id)!;
  profile.status = 'active';
  profile.version += 1;
  t.store.reviews[0]!.status = 'approved';

  await rejects(
    t.service.save(t.asAbir, id, input(profile.version)),
    409,
    'PROFILE_EDIT_REQUIRES_REVIEW',
  );
  const requested = await t.service.requestEdit(
    t.asAbir,
    id,
    input(profile.version, { heightCm: 165 }),
    'c',
  );
  assert.equal(requested.state.pendingReview?.kind, 'field_update');
  assert.deepEqual(requested.state.pendingReview?.proposedChanges, { profile: { heightCm: 165 } });
  assert.equal(requested.state.profile?.data.profile?.heightCm, 160, 'published content unchanged');
});

await test('staff cannot change the content of a member who runs their own profile', async () => {
  const t = setup();
  const member = randomUUID();
  const own = t.store.addAndGet(member, t.ids.abir);

  // They can look at it, because it is assigned to them.
  const detail = await t.service.detail(t.asAbir, own);
  assert.equal(detail.meta.serviceMode, 'self_service');
  // But not change what it says.
  await rejects(t.service.save(t.asAbir, own, input(1)), 403, 'PROFILE_SELF_SERVICE');
  await rejects(t.service.submit(t.asAbir, own, 1, 'c'), 403, 'PROFILE_SELF_SERVICE');
  await rejects(t.service.requestEdit(t.asAbir, own, input(1), 'c'), 403, 'PROFILE_SELF_SERVICE');
  await rejects(t.service.cancelPending(t.asAbir, own, 'c'), 403, 'PROFILE_SELF_SERVICE');
  await rejects(t.service.save(t.asAdmin, own, input(1)), 403, 'PROFILE_SELF_SERVICE');
});

await test('a profile can be moved between its live states, but not while a review waits, and closed is final', async () => {
  const t = setup();
  const own = t.store.addAndGet(randomUUID(), t.ids.abir);
  const profile = t.store.profiles.get(own)!;
  profile.status = 'active';
  profile.version = 5;

  let state = await t.service.changeStatus(t.asAbir, own, 'paused', 5, 'c');
  assert.equal(state.state.profile?.status, 'paused');
  assert.equal(t.store.events.at(-1)?.type, 'profile.status_changed');
  state = await t.service
    .changeStatus(t.asAbir, own, 'matched', profile.version, 'c')
    .catch((e) => e);
  // paused cannot go straight to matched.
  assert.ok(state instanceof AppError);
  assert.equal((state as AppError).code, 'STATUS_CHANGE_NOT_ALLOWED');

  const reactivated = await t.service.changeStatus(t.asAbir, own, 'active', profile.version, 'c');
  assert.equal(reactivated.state.profile?.status, 'active');
  const closed = await t.service.changeStatus(t.asAbir, own, 'closed', profile.version, 'c');
  assert.equal(closed.state.profile?.status, 'closed');
  await rejects(
    t.service.changeStatus(t.asAbir, own, 'active', profile.version, 'c'),
    409,
    'STATUS_CHANGE_NOT_ALLOWED',
  );

  profile.status = 'pending_review';
  await rejects(
    t.service.changeStatus(t.asAdmin, own, 'closed', profile.version, 'c'),
    409,
    'STATUS_CHANGE_NOT_ALLOWED',
  );
});

await test('a status change made against an out-of-date page is refused', async () => {
  const t = setup();
  const own = t.store.addAndGet(randomUUID(), t.ids.abir);
  const profile = t.store.profiles.get(own)!;
  profile.status = 'active';
  await rejects(
    t.service.changeStatus(t.asAbir, own, 'paused', profile.version - 1, 'c'),
    409,
    'PROFILE_VERSION_CONFLICT',
  );
  assert.equal(profile.status, 'active');
});

await test('only an admin hands a client to an agent, to an active one, or takes them back', async () => {
  const t = setup();
  const { id } = await t.service.create(t.asAbir, input(), 'c');

  await rejects(t.service.assign(t.asAbir, id, t.ids.other, 'c'), 403, 'ROLE_FORBIDDEN');
  assert.equal(t.store.profiles.get(id)?.assignedAgentId, t.ids.abir);

  const moved = await t.service.assign(t.asAdmin, id, t.ids.other, 'c');
  assert.equal(moved.meta.assignedAgent?.displayName, 'Other agent');
  assert.equal(t.events.at(-1), 'profile.assigned');
  // The first agent no longer reaches it; the new one does.
  await rejects(t.service.detail(t.asAbir, id), 404, 'PROFILE_NOT_FOUND');
  await t.service.detail(t.asOther, id);

  const freed = await t.service.assign(t.asAdmin, id, null, 'c');
  assert.equal(freed.meta.assignedAgent, null);

  await rejects(t.service.assign(t.asAdmin, id, t.ids.gone, 'c'), 422, 'AGENT_NOT_AVAILABLE');
  await rejects(t.service.assign(t.asAdmin, id, randomUUID(), 'c'), 422, 'AGENT_NOT_AVAILABLE');
  await rejects(
    t.service.assign(t.asAdmin, randomUUID(), t.ids.other, 'c'),
    404,
    'PROFILE_NOT_FOUND',
  );
});

await test('the list of staff an admin can choose from', async () => {
  const t = setup();
  const staff = await t.service.listStaff(t.asAdmin);
  assert.deepEqual(
    staff.map((s) => s.displayName),
    ['Admin', 'Abir', 'Other agent', 'Disabled agent'],
  );
  await rejects(t.service.listStaff(t.asAbir), 403, 'ROLE_FORBIDDEN');
});
