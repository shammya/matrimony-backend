import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchQuerySchema, hiddenFilters, type MatchItem } from '../src/bo/matches.js';
import type { VisibleField } from '../src/bo/release.js';
import type { MatchUnit } from '../src/db/service/match-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { MatchService } from '../src/service/match-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';

const agencyId = '11111111-1111-4111-8111-111111111111';
const member: ProfileActor = {
  agencyId,
  accountId: '22222222-2222-4222-8222-222222222222',
  role: 'member',
};
const agent: ProfileActor = { ...member, role: 'agent' };
const OWN = '33333333-3333-4333-8333-333333333333';
const query = (over: Record<string, unknown> = {}) => matchQuerySchema.parse(over);

type Start = {
  own?: { id: string; status: string } | null;
  visible?: VisibleField[] | null;
  rows?: MatchItem[];
  photoKey?: string | null;
  total?: number;
};

function fake(start: Start = {}) {
  const seen: {
    visible: readonly VisibleField[];
    filters: unknown;
    limit: number;
    after: unknown;
  }[] = [];
  const unit: MatchUnit = {
    ownProfile: async () => (start.own === undefined ? { id: OWN, status: 'active' } : start.own),
    settings: async () =>
      start.visible === null
        ? null
        : { cap: 50, visibleFields: start.visible ?? ['fullName', 'age'] },
    releasedTotal: async () => start.total ?? (start.rows ?? []).length,
    page: async (_a, _c, visible, filters, page) => {
      seen.push({ visible, filters, limit: page.limit, after: page.after });
      return start.rows ?? [];
    },
    person: async () => null,
    sharedContact: async () => null,
    viewablePhotoKey: async () => (start.photoKey === undefined ? 'k/1' : start.photoKey),
  };
  const service = new MatchService({ inTransaction: async (_agency, work) => work(unit) });
  return { service, seen };
}

const row = (n: number): MatchItem => ({
  candidateId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  memberCode: `M${n}`,
  position: `2026-10-10T08:00:0${n}.000000Z`,
  connection: null,
  fullName: `P${n}`,
});

const refused = (status: number, code?: string) => (e: unknown) =>
  e instanceof AppError && e.status === status && (code === undefined || e.code === code);

await test('only a member sees their matches', async () => {
  const { service } = fake();
  await assert.rejects(service.page(agent, query()), refused(403));
  await assert.rejects(service.photoKey(agent, OWN), refused(403));
});

await test('a member with no profile, or one not published, gets an empty window and their status', async () => {
  assert.deepEqual(await fake({ own: null }).service.page(member, query()), {
    items: [],
    next: null,
    profileStatus: null,
    releasedTotal: 0,
    visibleFields: [],
  });
  const waiting = await fake({
    own: { id: OWN, status: 'pending_review' },
    rows: [row(1)],
  }).service.page(member, query());
  assert.deepEqual(waiting, {
    items: [],
    next: null,
    profileStatus: 'pending_review',
    releasedTotal: 0,
    visibleFields: [],
  });
});

await test('the staff-chosen fields (or the defaults) are the only ones asked for', async () => {
  const chosen = fake({ visible: ['fullName', 'photo'] });
  await chosen.service.page(member, query());
  assert.deepEqual(chosen.seen[0]?.visible, ['fullName', 'photo']);
  const defaults = fake({ visible: null });
  await defaults.service.page(member, query());
  assert.ok(defaults.seen[0]!.visible.includes('fullName'));
  assert.ok(!defaults.seen[0]!.visible.includes('hobbies'));
});

await test('a filter on a field the member may not see is refused', async () => {
  const { service, seen } = fake({ visible: ['fullName', 'age'] });
  await assert.rejects(
    service.page(member, query({ district: 'dhaka' })),
    (e) =>
      refused(400, 'FILTER_NOT_AVAILABLE')(e) &&
      JSON.stringify((e as AppError).details) ===
        JSON.stringify({ fields: [{ path: 'district', code: 'notAvailable' }] }),
  );
  assert.equal(seen.length, 0);
  // Age is allowed here, and a member code is always allowed.
  await service.page(member, query({ ageMin: 25, q: 'M1' }));
  assert.equal(seen.length, 1);
  assert.deepEqual(hiddenFilters({ profession: 'doctor', religion: 'islam' }, ['religionCode']), [
    'profession',
  ]);
});

await test('pages: one more than the limit tells there is a next page, with a usable cursor', async () => {
  const rows = [row(1), row(2), row(3)];
  const { service } = fake({ rows, total: 9 });
  const first = await service.page(member, query({ limit: 2 }));
  assert.equal(first.items.length, 2);
  assert.ok(first.next);
  assert.equal(first.releasedTotal, 9);
  const last = await fake({ rows: [row(1), row(2)] }).service.page(member, query({ limit: 2 }));
  assert.equal(last.next, null);
  await assert.rejects(
    service.page(member, query({ after: 'garbage' })),
    refused(400, 'INVALID_REQUEST'),
  );
});

await test('a photo is only given for a released profile, and only when staff allow photos', async () => {
  assert.deepEqual(await fake({ visible: ['photo'] }).service.photoKey(member, OWN), {
    storageKey: 'k/1',
  });
  await assert.rejects(
    fake({ visible: ['fullName'] }).service.photoKey(member, OWN),
    refused(404, 'PHOTO_NOT_FOUND'),
  );
  await assert.rejects(
    fake({ visible: ['photo'], photoKey: null }).service.photoKey(member, OWN),
    refused(404, 'PHOTO_NOT_FOUND'),
  );
  await assert.rejects(
    fake({ own: null }).service.photoKey(member, OWN),
    refused(404, 'PHOTO_NOT_FOUND'),
  );
  await assert.rejects(
    fake({ own: { id: OWN, status: 'draft' } }).service.photoKey(member, OWN),
    refused(404, 'PHOTO_NOT_FOUND'),
  );
});
