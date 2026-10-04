import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { migrate } from '../../scripts/migrate.js';
import { Database } from '../../src/db/config/database.js';
import { SessionRepository, type Session } from '../../src/cache/repository/session-repository.js';
import { EventRepository } from '../../src/db/raw/repository/event-repository.js';
import { EventDbService } from '../../src/db/service/event-db-service.js';
import { MongoEventRepository } from '../../src/mongo/repository/event-repository.js';
import type { EventDocument } from '../../src/mongo/entity/workflow-event.js';
import { agency, otherAgency } from '../fixtures.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const mongoUrl = process.env.TEST_MONGO_URL;
if (
  !databaseUrl ||
  !redisUrl ||
  !mongoUrl ||
  new URL(databaseUrl).pathname !== '/matrimony_scaffold_test'
)
  throw new Error(
    'Set TEST_DATABASE_URL (database matrimony_scaffold_test), TEST_REDIS_URL and TEST_MONGO_URL to isolated test instances',
  );
await test('real PostgreSQL, Redis and MongoDB infrastructure', async (t) => {
  await migrate(databaseUrl, false);
  await migrate(databaseUrl, false);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const redis = new Redis(redisUrl, { connectTimeout: 5000, commandTimeout: 5000 });
  const mongo = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
  await mongo.connect();
  t.after(async () => {
    redis.disconnect();
    await mongo.close();
    await admin.end();
  });
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
  const pool = new Pool({ connectionString: runtimeUrl.href, max: 1 });
  const db = new Database(pool);
  await db.ready();
  t.after(() => db.close());
  await t.test(
    'RLS isolates tenants and pooled connections never retain transaction context',
    async () => {
      assert.equal((await pool.query('SELECT * FROM matrimony.agencies')).rowCount, 0);
      const result = await db.transaction(agency, (tx) =>
        tx.query('SELECT id FROM matrimony.agencies'),
      );
      assert.deepEqual(result.rows, [{ id: agency }]);
      await assert.rejects(() =>
        db.transaction(agency, async (tx) => {
          await tx.query('SELECT 1');
          throw new Error('abort');
        }),
      );
      assert.equal((await pool.query('SELECT * FROM matrimony.agencies')).rowCount, 0);
      const next = await db.transaction(otherAgency, (tx) =>
        tx.query('SELECT id FROM matrimony.agencies'),
      );
      assert.deepEqual(next.rows, [{ id: otherAgency }]);
    },
  );
  const events = new EventDbService(db, new EventRepository());
  const event = {
    id: randomUUID(),
    agencyId: agency,
    actorId: null,
    subjectId: null,
    type: 'auth.login' as const,
    version: 1 as const,
    occurredAt: new Date().toISOString(),
    correlationId: 'integration',
  };
  await t.test('outbox rolls back with its transaction and enforces tenant writes', async () => {
    await assert.rejects(() =>
      db.transaction(agency, async (tx) => {
        await events.append(tx, event);
        throw new Error('rollback');
      }),
    );
    const result = await admin.query('SELECT id FROM matrimony.event_outbox WHERE id=$1', [
      event.id,
    ]);
    assert.equal(result.rowCount, 0);
    await assert.rejects(() => db.transaction(otherAgency, (tx) => events.append(tx, event)));
  });
  await t.test('leases fence stale acknowledgement and Mongo delivery is idempotent', async () => {
    await events.record(event);
    const first = await events.claim(agency, 12);
    assert.ok(first);
    assert.equal(await events.claim(agency, 12), null);
    await admin.query(
      "UPDATE matrimony.event_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",
      [event.id],
    );
    const second = await events.claim(agency, 12);
    assert.ok(second);
    assert.notEqual(first.leaseToken, second.leaseToken);
    await events.acknowledge(first);
    const stale = await admin.query('SELECT delivered_at FROM matrimony.event_outbox WHERE id=$1', [
      event.id,
    ]);
    assert.equal(stale.rows[0].delivered_at, null);
    const collection = mongo
      .db('matrimony_scaffold_test')
      .collection<EventDocument>('workflow_events');
    const repository = new MongoEventRepository(collection);
    await repository.ready();
    await repository.store(event);
    await repository.store(event);
    assert.equal(await collection.countDocuments({ _id: event.id }), 1);
    await events.acknowledge(second);
    assert.equal(await events.claim(agency, 12), null);
    await collection.deleteOne({ _id: event.id });
  });
  await t.test(
    'Redis refresh claims are atomic and logout defeats stale finalization',
    async () => {
      const sessions = new SessionRepository(redis);
      const id = randomUUID();
      const value: Session = {
        agencyId: agency,
        accountId: randomUUID(),
        subject: 'test',
        issuer: 'https://issuer',
        refreshSecret: 'encrypted',
        accessHash: randomUUID(),
        csrf: 'csrf',
        expiresAt: Date.now() / 1000 + 60,
      };
      await sessions.put(id, value, 60);
      const claims = await Promise.all([
        sessions.claim(id, 'csrf', agency, 'first'),
        sessions.claim(id, 'csrf', agency, 'second'),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      await sessions.remove(id);
      assert.equal(await sessions.finalize(id, 'first', value, 60), false);
      assert.equal(await sessions.forAccess(value.accessHash), null);
    },
  );
  await t.test('runtime startup rejects superuser connections', async () => {
    const unsafePool = new Pool({ connectionString: databaseUrl, max: 1 });
    const unsafe = new Database(unsafePool);
    await assert.rejects(() => unsafe.ready());
    await unsafe.close();
  });
});
