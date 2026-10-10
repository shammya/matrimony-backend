import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionRecord, ProfileLite } from '../src/bo/connection.js';
import type { ConnectionUnit } from '../src/db/service/connection-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { ConnectionService } from '../src/service/connection-service.js';
import type { ProfileActor } from '../src/service/profile-service.js';

const agencyId = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Two members who run their own profiles, one assisted client with an agent, and one with no agent.
const ACCOUNT = { me: id(101), them: id(102), agent: id(103), admin: id(104), stranger: id(105) };
const PROFILE = { me: id(1), them: id(2), assisted: id(3), orphan: id(4), paused: id(5) };
const profiles: ProfileLite[] = [
  {
    id: PROFILE.me,
    status: 'active',
    serviceMode: 'self_service',
    ownerId: ACCOUNT.me,
    assignedAgentId: null,
  },
  {
    id: PROFILE.them,
    status: 'active',
    serviceMode: 'self_service',
    ownerId: ACCOUNT.them,
    assignedAgentId: null,
  },
  {
    id: PROFILE.assisted,
    status: 'active',
    serviceMode: 'assisted',
    ownerId: null,
    assignedAgentId: ACCOUNT.agent,
  },
  {
    id: PROFILE.orphan,
    status: 'active',
    serviceMode: 'assisted',
    ownerId: null,
    assignedAgentId: null,
  },
  {
    id: PROFILE.paused,
    status: 'paused',
    serviceMode: 'self_service',
    ownerId: id(106),
    assignedAgentId: null,
  },
];
const actorOf = (accountId: string, role: ProfileActor['role']): ProfileActor => ({
  agencyId,
  accountId,
  role,
});
const me = actorOf(ACCOUNT.me, 'member');
const them = actorOf(ACCOUNT.them, 'member');
const agent = actorOf(ACCOUNT.agent, 'agent');
const admin = actorOf(ACCOUNT.admin, 'admin');
const stranger = actorOf(ACCOUNT.stranger, 'agent');

type Notice = { to: string; kind: string; forProfile: string; about: string };

/** An in-memory unit: who is in whose window, the connections, what was told to whom, and the events. */
function fake(window: [string, string][] = [[PROFILE.me, PROFILE.them]]) {
  const connections = new Map<string, ConnectionRecord & { by: string }>();
  const notices: Notice[] = [];
  const events: string[] = [];
  let counter = 0;
  const own = (accountId: string) => profiles.find((p) => p.ownerId === accountId);
  const unit = {
    ownProfile: async (_a: string, accountId: string) => {
      const p = own(accountId);
      return p ? { id: p.id, status: p.status } : null;
    },
    settings: async () => null,
    lockProfiles: async (_a: string, ids: readonly string[]) =>
      profiles.filter((p) => ids.includes(p.id)),
    readProfiles: async (_a: string, ids: readonly string[]) =>
      profiles.filter((p) => ids.includes(p.id)),
    released: async (_a: string, client: string, candidate: string) =>
      window.some(([c, k]) => c === client && k === candidate) &&
      profiles.find((p) => p.id === candidate)?.status === 'active',
    pair: async (_a: string, x: string, y: string) =>
      [...connections.values()].find(
        (c) =>
          (c.fromProfileId === x && c.toProfileId === y) ||
          (c.fromProfileId === y && c.toProfileId === x),
      ) ?? null,
    byId: async (_a: string, connectionId: string) => connections.get(connectionId) ?? null,
    insert: async (_a: string, from: string, to: string, by: string) => {
      counter += 1;
      const cid = id(1000 + counter);
      connections.set(cid, {
        id: cid,
        fromProfileId: from,
        toProfileId: to,
        status: 'pending',
        fromShared: false,
        toShared: false,
        by,
      });
      return cid;
    },
    repend: async (_a: string, cid: string, from: string, to: string, by: string) => {
      const c = connections.get(cid);
      if (!c || c.status !== 'withdrawn') return false;
      Object.assign(c, {
        fromProfileId: from,
        toProfileId: to,
        status: 'pending',
        fromShared: false,
        toShared: false,
        by,
      });
      return true;
    },
    respond: async (_a: string, cid: string, status: 'accepted' | 'declined') => {
      const c = connections.get(cid);
      if (!c || c.status !== 'pending') return false;
      c.status = status;
      return true;
    },
    withdraw: async (_a: string, cid: string, from: string) => {
      const c = connections.get(cid);
      if (!c || c.status !== 'pending' || c.fromProfileId !== from) return false;
      c.status = 'withdrawn';
      return true;
    },
    share: async (_a: string, cid: string, profile: string, side: 'from' | 'to') => {
      const c = connections.get(cid);
      if (!c || c.status !== 'accepted') return false;
      if (side === 'from' && c.fromProfileId === profile) c.fromShared = true;
      else if (side === 'to' && c.toProfileId === profile) c.toShared = true;
      else return false;
      return true;
    },
    notify: async (
      _a: string,
      to: string,
      kind: string,
      _c: string,
      forProfile: string,
      about: string,
    ) => {
      notices.push({ to, kind, forProfile, about });
    },
    notifications: async () => [],
    connections: async () => [],
    staffList: async () => [],
    appendEvent: async (event: { type: string }) => {
      events.push(event.type);
    },
  } as unknown as ConnectionUnit;
  const service = new ConnectionService({ inTransaction: async (_a, work) => work(unit) });
  return { service, connections, notices, events };
}

const refused = (status: number, code?: string) => (e: unknown) =>
  e instanceof AppError && e.status === status && (code === undefined || e.code === code);
const only = <T>(list: T[]) => {
  assert.equal(list.length, 1);
  return list[0]!;
};

await test('only a member with a published profile asks, and only for someone in their window', async () => {
  const t = fake();
  await assert.rejects(t.service.send(agent, PROFILE.them, 'c'), refused(403));
  await assert.rejects(
    t.service.send(actorOf(id(900), 'member'), PROFILE.them, 'c'),
    refused(404, 'PROFILE_NOT_FOUND'),
  );
  // Not in the window, unknown, or oneself: all just "not found".
  await assert.rejects(
    t.service.send(me, PROFILE.assisted, 'c'),
    refused(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(t.service.send(me, id(999), 'c'), refused(404, 'PROFILE_NOT_FOUND'));
  await assert.rejects(t.service.send(me, PROFILE.me, 'c'), refused(404, 'PROFILE_NOT_FOUND'));
  assert.equal(t.connections.size, 0);
  assert.equal(t.notices.length, 0);
  // A profile that is not published cannot ask.
  const paused = actorOf(id(106), 'member');
  await assert.rejects(
    fake([[PROFILE.paused, PROFILE.them]]).service.send(paused, PROFILE.them, 'c'),
    refused(409, 'PROFILE_NOT_PUBLISHED'),
  );
});

await test('a request is stored once, tells the person asked, and asking again changes nothing', async () => {
  const t = fake();
  const first = await t.service.send(me, PROFILE.them, 'c');
  assert.deepEqual([first.outcome, first.status], ['requested', 'pending']);
  assert.deepEqual(t.notices, [
    { to: ACCOUNT.them, kind: 'connection_request', forProfile: PROFILE.them, about: PROFILE.me },
  ]);
  assert.deepEqual(t.events, ['interest.requested']);
  const again = await t.service.send(me, PROFILE.them, 'c');
  assert.deepEqual([again.outcome, again.connectionId], ['unchanged', first.connectionId]);
  assert.equal(t.connections.size, 1);
  assert.equal(t.notices.length, 1);
  assert.equal(t.events.length, 1);
});

await test('two people asking each other end as one accepted connection, and both are told', async () => {
  const t = fake([
    [PROFILE.me, PROFILE.them],
    [PROFILE.them, PROFILE.me],
  ]);
  const first = await t.service.send(me, PROFILE.them, 'c');
  const second = await t.service.send(them, PROFILE.me, 'c');
  assert.deepEqual(
    [second.outcome, second.status, second.connectionId],
    ['accepted', 'accepted', first.connectionId],
  );
  assert.equal(t.connections.size, 1);
  assert.equal(only([...t.connections.values()]).status, 'accepted');
  const accepted = t.notices.filter((n) => n.kind === 'connection_accepted');
  assert.deepEqual(accepted.map((n) => n.to).sort(), [ACCOUNT.me, ACCOUNT.them].sort());
  assert.deepEqual(t.events, ['interest.requested', 'interest.accepted']);
  // Asking again after that changes nothing.
  assert.equal((await t.service.send(me, PROFILE.them, 'c')).outcome, 'unchanged');
});

await test('only the person asked answers, once, and the asker is told', async () => {
  const t = fake();
  const { connectionId } = await t.service.send(me, PROFILE.them, 'c');
  await assert.rejects(
    t.service.respond(me, connectionId, true, 'c'),
    refused(404, 'CONNECTION_NOT_FOUND'),
  );
  await assert.rejects(
    t.service.respond(actorOf(id(900), 'member'), connectionId, true, 'c'),
    refused(404),
  );
  await t.service.respond(them, connectionId, true, 'c');
  assert.equal(t.connections.get(connectionId)?.status, 'accepted');
  const told = t.notices
    .filter((n) => n.kind === 'connection_accepted')
    .map((n) => n.to)
    .sort();
  assert.deepEqual(told, [ACCOUNT.me, ACCOUNT.them].sort());
  await assert.rejects(
    t.service.respond(them, connectionId, false, 'c'),
    refused(409, 'CONNECTION_NOT_PENDING'),
  );
});

await test('a declined pair stays declined, and only the asker is told', async () => {
  const t = fake([
    [PROFILE.me, PROFILE.them],
    [PROFILE.them, PROFILE.me],
  ]);
  const { connectionId } = await t.service.send(me, PROFILE.them, 'c');
  await t.service.respond(them, connectionId, false, 'c');
  assert.deepEqual(
    t.notices.filter((n) => n.kind === 'connection_declined'),
    [{ to: ACCOUNT.me, kind: 'connection_declined', forProfile: PROFILE.me, about: PROFILE.them }],
  );
  await assert.rejects(t.service.send(me, PROFILE.them, 'c'), refused(409, 'CONNECTION_DECLINED'));
  await assert.rejects(t.service.send(them, PROFILE.me, 'c'), refused(409, 'CONNECTION_DECLINED'));
});

await test('a request can be withdrawn by the asker only, and asked again by either side', async () => {
  const t = fake([
    [PROFILE.me, PROFILE.them],
    [PROFILE.them, PROFILE.me],
  ]);
  const { connectionId } = await t.service.send(me, PROFILE.them, 'c');
  await assert.rejects(
    t.service.withdraw(them, connectionId, 'c'),
    refused(404, 'CONNECTION_NOT_FOUND'),
  );
  await t.service.withdraw(me, connectionId, 'c');
  await assert.rejects(
    t.service.withdraw(me, connectionId, 'c'),
    refused(409, 'CONNECTION_NOT_PENDING'),
  );
  await assert.rejects(
    t.service.respond(them, connectionId, true, 'c'),
    refused(409, 'CONNECTION_NOT_PENDING'),
  );
  // The other side may now be the one who asks: the same row, turned round.
  const again = await t.service.send(them, PROFILE.me, 'c');
  assert.deepEqual([again.outcome, again.connectionId], ['requested', connectionId]);
  assert.equal(t.connections.size, 1);
  assert.equal(t.connections.get(connectionId)?.fromProfileId, PROFILE.them);
});

await test('contact is shared only inside an accepted connection, and only by one side at a time', async () => {
  const t = fake();
  const { connectionId } = await t.service.send(me, PROFILE.them, 'c');
  await assert.rejects(
    t.service.shareContact(me, connectionId, 'c'),
    refused(409, 'CONNECTION_NOT_ACCEPTED'),
  );
  await t.service.respond(them, connectionId, true, 'c');
  await t.service.shareContact(me, connectionId, 'c');
  const stored = t.connections.get(connectionId)!;
  assert.deepEqual([stored.fromShared, stored.toShared], [true, false]);
  await assert.rejects(
    t.service.shareContact(actorOf(id(900), 'member'), connectionId, 'c'),
    refused(404),
  );
  assert.ok(t.events.includes('interest.contact_shared'));
});

await test('a client with no login is answered for by the agent who looks after them', async () => {
  const t = fake([[PROFILE.me, PROFILE.assisted]]);
  const { connectionId } = await t.service.send(me, PROFILE.assisted, 'c');
  // The agent, not the client, is told.
  assert.deepEqual(t.notices, [
    {
      to: ACCOUNT.agent,
      kind: 'connection_request',
      forProfile: PROFILE.assisted,
      about: PROFILE.me,
    },
  ]);
  // Another agent cannot answer; the agent who looks after the client, and an admin, can.
  await assert.rejects(
    t.service.staffRespond(stranger, PROFILE.assisted, connectionId, true, 'c'),
    refused(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    t.service.staffRespond(me, PROFILE.assisted, connectionId, true, 'c'),
    refused(403),
  );
  await t.service.staffRespond(agent, PROFILE.assisted, connectionId, true, 'c');
  assert.equal(t.connections.get(connectionId)?.status, 'accepted');
  await t.service.staffShareContact(admin, PROFILE.assisted, connectionId, 'c');
  assert.equal(t.connections.get(connectionId)?.toShared, true);
  // The asker is told it was accepted.
  assert.ok(t.notices.some((n) => n.to === ACCOUNT.me && n.kind === 'connection_accepted'));
});

await test('staff never answer for a member who runs their own profile', async () => {
  const t = fake();
  const { connectionId } = await t.service.send(me, PROFILE.them, 'c');
  await assert.rejects(
    t.service.staffRespond(admin, PROFILE.them, connectionId, true, 'c'),
    refused(403, 'PROFILE_SELF_SERVICE'),
  );
  assert.equal(t.connections.get(connectionId)?.status, 'pending');
});

await test('a request to a client nobody looks after is kept, and nobody is told', async () => {
  const t = fake([[PROFILE.me, PROFILE.orphan]]);
  await t.service.send(me, PROFILE.orphan, 'c');
  assert.equal(t.connections.size, 1);
  assert.equal(t.notices.length, 0);
});

await test('the inbox needs a valid cursor', async () => {
  const t = fake();
  await assert.rejects(
    t.service.notifications(me, { limit: 5, after: 'garbage' }),
    refused(400, 'INVALID_REQUEST'),
  );
  assert.deepEqual(await t.service.notifications(me, { limit: 5 }), { items: [], next: null });
});
