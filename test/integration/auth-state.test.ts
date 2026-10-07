import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { OneTimeTokenRepository } from '../../src/cache/repository/one-time-token-repository.js';
import { SessionRepository, type Session } from '../../src/cache/repository/session-repository.js';
import { ThrottleRepository } from '../../src/cache/repository/throttle-repository.js';
import { digest } from '../../src/security/secret-box.js';
import { agency } from '../fixtures.js';

// Needs only Redis. Every key below carries a random id, so a shared Redis is left clean.
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('Set TEST_REDIS_URL to a Redis that is safe to write test keys to');

const session = (accountId: string, over: Partial<Session> = {}): Session => ({
  agencyId: agency,
  accountId,
  accessHash: randomUUID(),
  csrf: 'csrf',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  ...over,
});

await test('sessions, one-time tokens and counters on real Redis', async (t) => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  t.after(() => redis.quit());
  const sessions = new SessionRepository(redis);
  const tokens = new OneTimeTokenRepository(redis);
  const throttle = new ThrottleRepository(redis);

  await t.test(
    'a session is found by its id and by its access token, and ends on remove',
    async () => {
      const accountId = randomUUID();
      const id = randomUUID();
      const value = session(accountId);
      await sessions.put(id, value, 60);
      assert.deepEqual(await sessions.get(id), value);
      assert.deepEqual(await sessions.forAccess(value.accessHash), value);
      await sessions.remove(id);
      assert.equal(await sessions.get(id), null);
      assert.equal(await sessions.forAccess(value.accessHash), null);
      // The account's list of sessions no longer holds it.
      assert.equal(await redis.zcard(`matrimony:account-sessions:${accountId}`), 0);
    },
  );

  await t.test('ending every session of an account leaves other accounts alone', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await sessions.put(a, session(mine), 60);
    await sessions.put(b, session(mine), 60);
    await sessions.put(c, session(theirs), 60);
    await sessions.removeAll(mine);
    assert.equal(await sessions.get(a), null);
    assert.equal(await sessions.get(b), null);
    assert.notEqual(await sessions.get(c), null);
    assert.equal(await redis.exists(`matrimony:account-sessions:${mine}`), 0);
    await sessions.remove(c);
  });

  await t.test('ending all sessions of an account with none is not an error', async () => {
    await sessions.removeAll(randomUUID());
  });

  await t.test('the oldest sessions are ended once an account has too many', async () => {
    const accountId = randomUUID();
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      await sessions.put(id, session(accountId), 60);
      // A few milliseconds apart, so the order they were made in is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await sessions.limit(accountId, 3);
    const alive = await Promise.all(ids.map(async (id) => (await sessions.get(id)) !== null));
    assert.deepEqual(alive, [false, false, true, true, true]);
    // Within the limit nothing more is ended.
    await sessions.limit(accountId, 3);
    assert.equal((await Promise.all(ids.map((id) => sessions.get(id)))).filter(Boolean).length, 3);
    await sessions.removeAll(accountId);
  });

  await t.test('refresh claims are atomic and sign-out defeats a stale finalize', async () => {
    const id = randomUUID();
    const value = session(randomUUID());
    await sessions.put(id, value, 60);
    const claims = await Promise.all([
      sessions.claim(id, 'csrf', agency, 'first'),
      sessions.claim(id, 'csrf', agency, 'second'),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    await sessions.remove(id);
    assert.equal(await sessions.finalize(id, 'first', value, 60), false);
    assert.equal(await sessions.forAccess(value.accessHash), null);
  });

  await t.test('a one-time token can be taken once, and expires on its own', async () => {
    const key = digest(randomUUID());
    await tokens.put('registration', randomUUID(), key, 'sealed-payload', 60);
    assert.equal(await tokens.take('registration', key), 'sealed-payload');
    assert.equal(await tokens.take('registration', key), null);

    const short = digest(randomUUID());
    await tokens.put('password-reset', randomUUID(), short, 'x', 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await tokens.take('password-reset', short), null);
  });

  await t.test('two people taking the same token at once: exactly one gets it', async () => {
    const key = digest(randomUUID());
    await tokens.put('registration', randomUUID(), key, 'payload', 60);
    const taken = await Promise.all(
      Array.from({ length: 6 }, () => tokens.take('registration', key)),
    );
    assert.equal(taken.filter((value) => value === 'payload').length, 1);
  });

  await t.test('a new token for the same subject cancels the earlier one', async () => {
    const scope = randomUUID();
    const [first, second] = [digest(randomUUID()), digest(randomUUID())];
    await tokens.put('password-reset', scope, first, 'one', 60);
    await tokens.put('password-reset', scope, second, 'two', 60);
    assert.equal(await tokens.take('password-reset', first), null);
    assert.equal(await tokens.take('password-reset', second), 'two');
  });

  await t.test('a token of one kind is not found as the other kind', async () => {
    const key = digest(randomUUID());
    await tokens.put('registration', randomUUID(), key, 'x', 60);
    assert.equal(await tokens.take('password-reset', key), null);
    assert.equal(await tokens.take('registration', key), 'x');
  });

  await t.test('a counter counts, starts its window with the first hit, and clears', async () => {
    const name = `test:${randomUUID()}`;
    assert.deepEqual(await throttle.peek(name), { count: 0, retryAfter: 1 });
    const first = await throttle.hit(name, 30);
    assert.equal(first.count, 1);
    assert.ok(first.retryAfter > 25 && first.retryAfter <= 30);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await throttle.hit(name, 30);
    assert.equal(second.count, 2);
    // The window was not stretched by the second hit.
    assert.ok(second.retryAfter <= first.retryAfter - 1);
    assert.equal((await throttle.peek(name)).count, 2);
    await throttle.clear(name);
    assert.equal((await throttle.peek(name)).count, 0);
  });

  await t.test('many hits at once are all counted', async () => {
    const name = `test:${randomUUID()}`;
    await Promise.all(Array.from({ length: 20 }, () => throttle.hit(name, 30)));
    assert.equal((await throttle.peek(name)).count, 20);
    await throttle.clear(name);
  });

  await t.test('a counter ends by itself when its window ends', async () => {
    const name = `test:${randomUUID()}`;
    await throttle.hit(name, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await throttle.peek(name)).count, 0);
  });
});
