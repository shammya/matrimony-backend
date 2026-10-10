import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate.js';
import { clientInputSchema } from '../../src/bo/client.js';
import { connectionListQuerySchema, notificationQuerySchema } from '../../src/bo/connection.js';
import { profileInputSchema } from '../../src/bo/profile.js';
import { Database } from '../../src/db/config/database.js';
import { CandidateRepository } from '../../src/db/raw/repository/candidate-repository.js';
import { ClientRepository } from '../../src/db/raw/repository/client-repository.js';
import { ConnectionRepository } from '../../src/db/raw/repository/connection-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { MatchRepository } from '../../src/db/raw/repository/match-repository.js';
import { ProfileRepository } from '../../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../../src/db/raw/repository/review-repository.js';
import { CandidateDbService } from '../../src/db/service/candidate-db-service.js';
import { ClientDbService } from '../../src/db/service/client-db-service.js';
import { ConnectionDbService } from '../../src/db/service/connection-db-service.js';
import { MatchDbService } from '../../src/db/service/match-db-service.js';
import { ProfileDbService } from '../../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../../src/db/service/review-db-service.js';
import { AppError } from '../../src/exception/app-error.js';
import { CandidateService } from '../../src/service/candidate-service.js';
import { ClientService } from '../../src/service/client-service.js';
import { ConnectionService } from '../../src/service/connection-service.js';
import { MatchService } from '../../src/service/match-service.js';
import { ProfileService, type ProfileActor } from '../../src/service/profile-service.js';
import { ReviewService } from '../../src/service/review-service.js';

// Needs only PostgreSQL. The database must be the isolated test one.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/matrimony_scaffold_test')
  throw new Error('Set TEST_DATABASE_URL to the isolated database matrimony_scaffold_test');

const NOW = new Date();
const refused = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;
const inbox = (limit = 20, after?: string) => notificationQuerySchema.parse({ limit, after });
const box = (name: 'received' | 'sent' | 'connected') =>
  connectionListQuerySchema.parse({ box: name });

await test('connection requests and the inbox on real PostgreSQL', async (t) => {
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
    `INSERT INTO matrimony.agencies(id,slug,hostname,name) VALUES ($1,$2,$3,'Connect one'),($4,$5,$6,'Connect two')`,
    [
      agencyId,
      `con-${tag}`,
      `con-${tag}.localhost`,
      elsewhereId,
      `con2-${tag}`,
      `con2-${tag}.localhost`,
    ],
  );
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = 'scaffold_test_app';
  runtimeUrl.password = 'test-only';
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 10 });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.end();
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
  const matches = new MatchService(
    new MatchDbService(db, new MatchRepository(), new CandidateRepository()),
  );
  const connections = new ConnectionService(
    new ConnectionDbService(
      db,
      new ConnectionRepository(),
      new MatchRepository(),
      new CandidateRepository(),
      new EventRepository(),
    ),
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
  const abir = await account('agent', 'Abir');
  const rival = await account('agent', 'Rival');
  const foreignBoss = await account('admin', 'Foreign boss', elsewhereId);

  const BASE = {
    maritalStatus: 'never_married',
    heightCm: 165,
    religionCode: 'islam',
    currentDistrictCode: 'dhaka',
    highestDegreeCode: 'bachelors',
    occupationCode: 'salaried',
    dateOfBirth: '1996-01-01',
  };
  /** A member who runs their own profile, published. Their contact details are secrets that must stay hidden. */
  const member = async (name: string, gender: 'male' | 'female', inAgency = agencyId) => {
    const me = await account('member', name, inAgency);
    const saved = await profiles.save(
      me.actor,
      profileInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, gender },
        contact: {
          contactName: `${name} contact`,
          contactRelationship: 'self',
          phone: '+8801711111111',
          email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`,
          permanentAddress: `SECRET ADDRESS of ${name}`,
        },
      }),
    );
    const sent = await profiles.submit(me.actor, saved.profile!.version, 'c');
    await reviews.approve(
      inAgency === agencyId ? boss.actor : foreignBoss.actor,
      sent.pendingReview!.id,
      {},
      'c',
    );
    return { ...me, name, profileId: saved.profile!.id };
  };
  /** A client the agency runs, with an agent, published. */
  const assisted = async (name: string, gender: 'male' | 'female', agent: typeof abir | null) => {
    const created = await clients.create(
      boss.actor,
      clientInputSchema(NOW).parse({
        profile: { fullName: name, ...BASE, gender },
        contact: {
          contactName: 'Agency desk',
          phone: '+8801722222222',
          permanentAddress: 'SECRET ADDRESS of client',
        },
        assignedAgentId: agent?.id ?? null,
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
  /** Puts `other` in `of`'s released window. */
  const release = async (of: string, other: string) => {
    await candidates.generate(boss.actor, of);
    await candidates.release(boss.actor, of, { candidateIds: [other] }, 'c');
  };
  const connectionRows = async (a: string, b: string) =>
    (
      await admin.query(
        `SELECT status, sender_profile_id AS from_profile_id, recipient_profile_id AS to_profile_id, (sender_contact_consent_at IS NOT NULL) AS from_shared_contact, (recipient_contact_consent_at IS NOT NULL) AS to_shared_contact FROM matrimony.interests
          WHERE agency_id = $1 AND ((sender_profile_id = $2 AND recipient_profile_id = $3) OR (sender_profile_id = $3 AND recipient_profile_id = $2))`,
        [agencyId, a, b],
      )
    ).rows;

  const m1 = await member('Mahir One', 'male');
  const m2 = await member('Nila Two', 'female');
  const z = await assisted('Zara Client', 'female', abir);
  const orphan = await assisted('Olive Client', 'female', null);
  await release(m1.profileId, m2.profileId);
  await release(m1.profileId, z);
  await release(m1.profileId, orphan);
  // M2's window does not hold M1: a request will be what lets M2 look at M1.

  await t.test('a request is stored once and tells the person asked, by name', async () => {
    const sent = await connections.send(m1.actor, m2.profileId, 'c');
    assert.equal(sent.outcome, 'requested');
    const again = await connections.send(m1.actor, m2.profileId, 'c');
    assert.deepEqual([again.outcome, again.connectionId], ['unchanged', sent.connectionId]);
    assert.equal((await connectionRows(m1.profileId, m2.profileId)).length, 1);

    const told = await connections.notifications(m2.actor, inbox());
    assert.equal(told.items.length, 1);
    assert.equal(told.items[0]!.kind, 'connection_request');
    assert.equal(told.items[0]!.about.fullName, 'Mahir One');
    assert.equal(told.items[0]!.forProfileId, m2.profileId);
    // The one who asked is not told about their own request.
    assert.deepEqual((await connections.notifications(m1.actor, inbox())).items, []);
  });

  await t.test(
    'the person asked sees who asked, and the asker sees the request waiting',
    async () => {
      const received = await connections.list(m2.actor, box('received'));
      assert.deepEqual(
        received.items.map((i) => [i.profile.fullName, i.status, i.direction]),
        [['Mahir One', 'pending', 'received']],
      );
      const sentList = await connections.list(m1.actor, box('sent'));
      assert.deepEqual(
        sentList.items.map((i) => [i.profile.fullName, i.status, i.direction]),
        [['Nila Two', 'pending', 'sent']],
      );
      assert.deepEqual((await connections.list(m1.actor, box('connected'))).items, []);
      // Nobody else sees it.
      assert.deepEqual(
        (await connections.list(await (await member('Third Man', 'male')).actor, box('received')))
          .items,
        [],
      );
    },
  );

  await t.test(
    'a request lets the person asked look at the asker, though they were never released to them',
    async () => {
      const detail = await matches.detail(m2.actor, m1.profileId);
      assert.equal(detail.profile.fullName, 'Mahir One');
      assert.deepEqual(
        [detail.connection?.status, detail.connection?.direction],
        ['pending', 'received'],
      );
      assert.equal(detail.contact, null);
      // An unrelated profile is still not theirs to look at.
      const stranger = await member('Stranger', 'male');
      await assert.rejects(
        matches.detail(m2.actor, stranger.profileId),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
    },
  );

  await t.test('only the person asked answers; an acceptance tells both', async () => {
    const id = (await connections.list(m2.actor, box('received'))).items[0]!.connectionId;
    await assert.rejects(
      connections.respond(m1.actor, id, true, 'c'),
      refused(404, 'CONNECTION_NOT_FOUND'),
    );
    await connections.respond(m2.actor, id, true, 'c');
    await assert.rejects(
      connections.respond(m2.actor, id, false, 'c'),
      refused(409, 'CONNECTION_NOT_PENDING'),
    );
    assert.equal((await connectionRows(m1.profileId, m2.profileId))[0].status, 'accepted');
    assert.deepEqual(
      (await connections.notifications(m1.actor, inbox())).items.map((n) => n.kind),
      ['connection_accepted'],
    );
    const second = await connections.notifications(m2.actor, inbox());
    assert.deepEqual(
      second.items.map((n) => n.kind),
      ['connection_accepted', 'connection_request'],
    );
    assert.equal((await connections.list(m1.actor, box('connected'))).items.length, 1);
    assert.equal((await connections.list(m2.actor, box('connected'))).items.length, 1);
  });

  await t.test('the inbox pages without gaps or repeats, newest first', async () => {
    const first = await connections.notifications(m2.actor, inbox(1));
    assert.equal(first.items.length, 1);
    assert.ok(first.next);
    const second = await connections.notifications(m2.actor, inbox(1, first.next!));
    assert.deepEqual(
      [first.items[0]!.kind, second.items[0]!.kind],
      ['connection_accepted', 'connection_request'],
    );
    assert.equal(second.next, null);
  });

  await t.test(
    'contact stays private until the other person shares it, and the address never leaves',
    async () => {
      const connectionId = (await connections.list(m1.actor, box('connected'))).items[0]!
        .connectionId;
      assert.equal((await matches.detail(m1.actor, m2.profileId)).contact, null);
      assert.equal((await matches.detail(m2.actor, m1.profileId)).contact, null);

      // M1 shares: M2 can now see M1's contact, but M1 still cannot see M2's.
      await connections.shareContact(m1.actor, connectionId, 'c');
      const seenByM2 = await matches.detail(m2.actor, m1.profileId);
      assert.deepEqual(seenByM2.contact, {
        name: 'Mahir One contact',
        relationship: 'self',
        phone: '+8801711111111',
        email: 'mahirone@example.com',
      });
      assert.equal(seenByM2.connection?.theyShared, true);
      assert.equal(seenByM2.connection?.iShared, false);
      assert.equal((await matches.detail(m1.actor, m2.profileId)).contact, null);
      assert.equal(JSON.stringify(seenByM2).includes('SECRET'), false);

      await connections.shareContact(m2.actor, connectionId, 'c');
      const seenByM1 = await matches.detail(m1.actor, m2.profileId);
      assert.equal(seenByM1.contact?.phone, '+8801711111111');
      assert.equal(JSON.stringify(seenByM1).includes('SECRET'), false);
    },
  );

  await t.test('the database refuses contact shared outside an accepted connection', async () => {
    const m3 = await member('Pending Pat', 'male');
    const m4 = await member('Pending Pia', 'female');
    await release(m3.profileId, m4.profileId);
    await connections.send(m3.actor, m4.profileId, 'c');
    await assert.rejects(
      admin.query(
        `UPDATE matrimony.interests SET sender_contact_consent_at = now() WHERE agency_id = $1 AND sender_profile_id = $2`,
        [agencyId, m3.profileId],
      ),
      /interests_contact_only_when_accepted|check constraint/,
    );
  });

  await t.test('a declined pair stays declined for both, and is not asked again', async () => {
    const a = await member('Decline Dan', 'male');
    const b = await member('Decline Dee', 'female');
    await release(a.profileId, b.profileId);
    await release(b.profileId, a.profileId);
    const { connectionId } = await connections.send(a.actor, b.profileId, 'c');
    await connections.respond(b.actor, connectionId, false, 'c');
    assert.deepEqual(
      (await connections.notifications(a.actor, inbox())).items.map((n) => n.kind),
      ['connection_declined'],
    );
    assert.deepEqual(
      (await connections.notifications(b.actor, inbox())).items.map((n) => n.kind),
      ['connection_request'],
    );
    await assert.rejects(
      connections.send(a.actor, b.profileId, 'c'),
      refused(409, 'CONNECTION_DECLINED'),
    );
    await assert.rejects(
      connections.send(b.actor, a.profileId, 'c'),
      refused(409, 'CONNECTION_DECLINED'),
    );
    assert.equal((await connectionRows(a.profileId, b.profileId)).length, 1);
  });

  await t.test(
    'a withdrawn request can be asked again, by either side, on the same row',
    async () => {
      const a = await member('Withdraw Wes', 'male');
      const b = await member('Withdraw Win', 'female');
      await release(a.profileId, b.profileId);
      await release(b.profileId, a.profileId);
      const first = await connections.send(a.actor, b.profileId, 'c');
      await assert.rejects(
        connections.withdraw(b.actor, first.connectionId, 'c'),
        refused(404, 'CONNECTION_NOT_FOUND'),
      );
      await connections.withdraw(a.actor, first.connectionId, 'c');
      await assert.rejects(
        connections.respond(b.actor, first.connectionId, true, 'c'),
        refused(409, 'CONNECTION_NOT_PENDING'),
      );
      const again = await connections.send(b.actor, a.profileId, 'c');
      assert.deepEqual([again.outcome, again.connectionId], ['requested', first.connectionId]);
      const [row] = await connectionRows(a.profileId, b.profileId);
      assert.equal(row.from_profile_id, b.profileId);
      assert.equal(row.status, 'pending');
    },
  );

  await t.test(
    'two people asking each other at the same moment end as one accepted pair, never a deadlock',
    async () => {
      for (let round = 0; round < 6; round += 1) {
        const a = await member(`Race A${round}`, 'male');
        const b = await member(`Race B${round}`, 'female');
        await release(a.profileId, b.profileId);
        await release(b.profileId, a.profileId);
        const results = await Promise.all([
          connections.send(a.actor, b.profileId, 'c'),
          connections.send(b.actor, a.profileId, 'c'),
        ]);
        const rows = await connectionRows(a.profileId, b.profileId);
        assert.equal(rows.length, 1, `round ${round}`);
        assert.equal(rows[0].status, 'accepted', `round ${round}`);
        assert.deepEqual(results.map((r) => r.outcome).sort(), ['accepted', 'requested']);
        assert.equal(results[0]!.connectionId, results[1]!.connectionId);
      }
    },
  );

  await t.test(
    'only someone in the window can be asked, and anything else is simply not found',
    async () => {
      const outsider = await member('Outside Ola', 'female');
      await assert.rejects(
        connections.send(m1.actor, outsider.profileId, 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.send(m1.actor, randomUUID(), 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.send(m1.actor, m1.profileId, 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      // A profile in another agency does not exist here at all.
      const foreign = await member('Foreign Fay', 'female', elsewhereId);
      await assert.rejects(
        connections.send(m1.actor, foreign.profileId, 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      // Staff and members who run nothing cannot ask.
      await assert.rejects(
        connections.send(abir.actor, m2.profileId, 'c'),
        refused(403, 'ROLE_FORBIDDEN'),
      );
      assert.equal((await connectionRows(m1.profileId, outsider.profileId)).length, 0);
    },
  );

  await t.test(
    'a client with a login is answered for only by themselves, never by staff',
    async () => {
      const x = await member('Own Ozzy', 'male');
      const y = await member('Own Yara', 'female');
      await release(x.profileId, y.profileId);
      const { connectionId } = await connections.send(x.actor, y.profileId, 'c');
      await assert.rejects(
        connections.staffRespond(boss.actor, y.profileId, connectionId, true, 'c'),
        refused(403, 'PROFILE_SELF_SERVICE'),
      );
      assert.equal((await connectionRows(x.profileId, y.profileId))[0].status, 'pending');
    },
  );

  await t.test(
    'a client with no login: the agent who looks after them is told, and answers for them',
    async () => {
      const { connectionId } = await connections.send(m1.actor, z, 'c');
      const told = await connections.notifications(abir.actor, inbox());
      assert.equal(told.items.length, 1);
      assert.equal(told.items[0]!.kind, 'connection_request');
      assert.equal(told.items[0]!.forProfileId, z);
      assert.equal(told.items[0]!.about.fullName, 'Mahir One');
      // Not the rival, not a member; and not the other agency.
      assert.deepEqual((await connections.notifications(rival.actor, inbox())).items, []);

      const listed = await connections.staffList(abir.actor, z);
      assert.deepEqual(
        listed.map((r) => [r.other.fullName, r.status, r.direction, r.other.serviceMode]),
        [['Mahir One', 'pending', 'received', 'self_service']],
      );
      await assert.rejects(
        connections.staffList(rival.actor, z),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.staffRespond(rival.actor, z, connectionId, true, 'c'),
        refused(404, 'PROFILE_NOT_FOUND'),
      );
      await assert.rejects(
        connections.staffRespond(abir.actor, z, randomUUID(), true, 'c'),
        refused(404, 'CONNECTION_NOT_FOUND'),
      );

      await connections.staffRespond(abir.actor, z, connectionId, true, 'c');
      assert.equal((await connectionRows(m1.profileId, z))[0].status, 'accepted');
      assert.ok(
        (await connections.notifications(m1.actor, inbox())).items.some(
          (n) => n.kind === 'connection_accepted' && n.about.profileId === z,
        ),
      );

      // Her contact is shared only when staff share it for her; the address never is.
      assert.equal((await matches.detail(m1.actor, z)).contact, null);
      await connections.staffShareContact(abir.actor, z, connectionId, 'c');
      const contact = (await matches.detail(m1.actor, z)).contact;
      assert.equal(contact?.phone, '+8801722222222');
      assert.equal(JSON.stringify(await matches.detail(m1.actor, z)).includes('SECRET'), false);
    },
  );

  await t.test(
    'a client nobody looks after can be asked; nobody is told, and an admin can still answer',
    async () => {
      const { connectionId } = await connections.send(m1.actor, orphan, 'c');
      const told = await connections.notifications(abir.actor, inbox());
      assert.ok(!told.items.some((n) => n.forProfileId === orphan));
      await connections.staffRespond(boss.actor, orphan, connectionId, false, 'c');
      assert.equal((await connectionRows(m1.profileId, orphan))[0].status, 'declined');
    },
  );

  await t.test('a name appears in the inbox only if staff let the member see names', async () => {
    const a = await member('Hidden Hal', 'male');
    const b = await member('Hidden Hana', 'female');
    await release(a.profileId, b.profileId);
    await connections.send(a.actor, b.profileId, 'c');
    assert.equal(
      (await connections.notifications(b.actor, inbox())).items[0]!.about.fullName,
      'Hidden Hal',
    );
    await candidates.saveSettings(
      boss.actor,
      b.profileId,
      { cap: 50, visibleFields: ['age'] },
      'c',
    );
    const item = (await connections.notifications(b.actor, inbox())).items[0]!;
    assert.equal(item.about.fullName, null);
    assert.ok(item.about.memberCode);
    // And the profile they may open shows no name either.
    assert.equal((await matches.detail(b.actor, a.profileId)).profile.fullName, undefined);
  });

  await t.test(
    'the events are recorded, and the application cannot delete a connection or a notification',
    async () => {
      const events = await admin.query(
        `SELECT DISTINCT event->>'type' AS type FROM matrimony.event_outbox WHERE agency_id = $1 AND event->>'type' LIKE 'interest.%'`,
        [agencyId],
      );
      const types = events.rows.map((r) => r.type);
      for (const type of [
        'interest.requested',
        'interest.accepted',
        'interest.declined',
        'interest.withdrawn',
        'interest.contact_shared',
      ])
        assert.ok(types.includes(type), type);
      await assert.rejects(pool.query('DELETE FROM matrimony.interests'), /permission denied/);
      await assert.rejects(pool.query('DELETE FROM matrimony.notifications'), /permission denied/);
      await assert.rejects(
        pool.query(`UPDATE matrimony.notifications SET template_key = 'interest.received'`),
        /permission denied/,
      );
    },
  );

  await t.test('another agency never sees any of it', async () => {
    const foreign = await member('Foreign Fred', 'male', elsewhereId);
    assert.deepEqual((await connections.notifications(foreign.actor, inbox())).items, []);
    assert.deepEqual((await connections.list(foreign.actor, box('connected'))).items, []);
    await assert.rejects(
      matches.detail(foreign.actor, m1.profileId),
      refused(404, 'PROFILE_NOT_FOUND'),
    );
    await assert.rejects(
      connections.staffList(foreignBoss.actor, z),
      refused(404, 'PROFILE_NOT_FOUND'),
    );
  });
});
