import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { PhoneCodeRepository } from '../../src/cache/repository/phone-code-repository.js';

// Needs only Redis. Every scope below carries a random id, so a shared Redis is left clean.
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('Set TEST_REDIS_URL to a Redis that is safe to write test keys to');

await test('codes on real Redis', async (t) => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  t.after(() => redis.quit());
  const codes = new PhoneCodeRepository(redis);
  const scope = () => `test:${randomUUID()}`;

  await t.test('a right guess is accepted once and uses the code up', async () => {
    const s = scope();
    await codes.put(s, 'fingerprint', 60);
    assert.equal(await codes.check(s, 'fingerprint', 5), 'ok');
    assert.equal(await codes.check(s, 'fingerprint', 5), 'none');
  });

  await t.test('there is nothing to check before a code was asked for', async () => {
    assert.equal(await codes.check(scope(), 'anything', 5), 'none');
  });

  await t.test('a wrong guess is counted, and the last allowed one cancels the code', async () => {
    const s = scope();
    await codes.put(s, 'right', 60);
    assert.deepEqual(
      [
        await codes.check(s, 'wrong', 3),
        await codes.check(s, 'wrong', 3),
        await codes.check(s, 'wrong', 3),
      ],
      ['wrong', 'wrong', 'locked'],
    );
    // Even the right one is refused now: a new code must be asked for.
    assert.equal(await codes.check(s, 'right', 3), 'none');
  });

  await t.test('a right guess among wrong ones still works until the limit', async () => {
    const s = scope();
    await codes.put(s, 'right', 60);
    assert.equal(await codes.check(s, 'wrong', 5), 'wrong');
    assert.equal(await codes.check(s, 'right', 5), 'ok');
  });

  await t.test('a new code replaces the old one and starts counting again', async () => {
    const s = scope();
    await codes.put(s, 'first', 60);
    assert.equal(await codes.check(s, 'wrong', 3), 'wrong');
    assert.equal(await codes.check(s, 'wrong', 3), 'wrong');
    await codes.put(s, 'second', 60);
    assert.equal(await codes.check(s, 'first', 3), 'wrong');
    assert.equal(await codes.check(s, 'second', 3), 'ok');
  });

  await t.test('a code expires on its own', async () => {
    const s = scope();
    await codes.put(s, 'fingerprint', 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await codes.check(s, 'fingerprint', 5), 'none');
  });

  await t.test('only a fingerprint is stored, never anything that reads as a code', async () => {
    const s = scope();
    await codes.put(s, 'f'.repeat(64), 60);
    const stored = await redis.hgetall(`matrimony:phone-code:${s}`);
    assert.deepEqual(stored, { h: 'f'.repeat(64), n: '0' });
    const ttl = await redis.ttl(`matrimony:phone-code:${s}`);
    assert.ok(ttl > 0 && ttl <= 60);
  });

  await t.test('many guesses at once cannot get more tries than the limit', async () => {
    const s = scope();
    await codes.put(s, 'right', 60);
    const results = await Promise.all(Array.from({ length: 30 }, () => codes.check(s, 'wrong', 5)));
    // Four are told "wrong", the fifth cancels the code, everyone after finds nothing.
    assert.equal(results.filter((r) => r === 'wrong').length, 4);
    assert.equal(results.filter((r) => r === 'locked').length, 1);
    assert.equal(results.filter((r) => r === 'none').length, 25);
    assert.equal(await codes.check(s, 'right', 5), 'none');
  });

  await t.test('the right code at the same moment from two places is accepted once', async () => {
    const s = scope();
    await codes.put(s, 'right', 60);
    const results = await Promise.all(Array.from({ length: 10 }, () => codes.check(s, 'right', 5)));
    assert.equal(results.filter((r) => r === 'ok').length, 1);
    assert.equal(results.filter((r) => r === 'none').length, 9);
  });
});
