import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import type { CredentialRecord } from '../src/bo/credentials-record.js';
import { AppError } from '../src/exception/app-error.js';
import { PasswordHasher } from '../src/security/password-hasher.js';
import { CredentialService } from '../src/service/credential-service.js';
import { account, agency } from './fixtures.js';

const weak = new PasswordHasher({ memory: 32, passes: 1, parallelism: 1 });
const hasher = new PasswordHasher({ memory: 64, passes: 1, parallelism: 1 });
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

async function setup(record: Partial<CredentialRecord> | null, passwordHash?: string | null) {
  const stored: CredentialRecord | null = record && {
    account,
    status: 'active',
    email: 'rahim@example.com',
    locale: 'bn',
    passwordHash:
      passwordHash === undefined ? await hasher.hash('the right password') : passwordHash,
    ...record,
  };
  const rehashes: { next: string; expected: string }[] = [];
  const events: unknown[] = [];
  let dummyChecks = 0;
  let rehashFails = false;
  const service = new CredentialService(
    {
      byEmail: async () => stored,
      byPhone: async () => stored,
      byId: async () => stored,
      rehash: async (_agency, _id, next, expected) => {
        if (rehashFails) throw new Error('database down');
        rehashes.push({ next, expected });
        return true;
      },
      setPasswordWithEvent: async (_agency, _id, _hash, event) => {
        events.push(event);
        return stored?.status === 'active';
      },
    },
    {
      hash: (password) => hasher.hash(password),
      verify: (password, hash) => hasher.verify(password, hash),
      needsRehash: (hash) => hasher.needsRehash(hash),
      verifyAgainstNothing: async () => {
        dummyChecks++;
        return false as const;
      },
    },
    pino({ level: 'silent' }),
    () => new Date('2026-10-07T00:00:00Z'),
  );
  return {
    service,
    rehashes,
    events,
    dummyChecks: () => dummyChecks,
    failRehash: () => {
      rehashFails = true;
    },
  };
}

await test('the right email and password give the account', async () => {
  const { service } = await setup({});
  assert.deepEqual(
    await service.verify(agency, 'rahim@example.com', 'the right password'),
    account,
  );
});

await test('a wrong password is refused', async () => {
  const { service } = await setup({});
  await assert.rejects(
    () => service.verify(agency, 'rahim@example.com', 'a wrong password'),
    code(401, 'INVALID_CREDENTIALS'),
  );
});

await test('an unknown email, an account with no password and an invited account all fail the same way, after the same work', async () => {
  for (const record of [null, { passwordHash: null }, { status: 'invited' as const }]) {
    const { service, dummyChecks } = await setup(record);
    await assert.rejects(
      () => service.verify(agency, 'rahim@example.com', 'the right password'),
      code(401, 'INVALID_CREDENTIALS'),
    );
    // The stand-in check ran, so these did as much work as a real wrong password.
    assert.equal(dummyChecks(), 1, JSON.stringify(record));
  }
});

await test('a disabled account is told so only after the right password', async () => {
  const { service } = await setup({ status: 'disabled' });
  await assert.rejects(
    () => service.verify(agency, 'rahim@example.com', 'the right password'),
    code(403, 'ACCOUNT_NOT_ACTIVE'),
  );
  // With a wrong password a stranger learns nothing about the account.
  await assert.rejects(
    () => service.verify(agency, 'rahim@example.com', 'a wrong password'),
    code(401, 'INVALID_CREDENTIALS'),
  );
});

await test('a hash made with older settings is replaced by a stronger one after a correct sign-in', async () => {
  const old = await weak.hash('the right password');
  const { service, rehashes } = await setup({}, old);
  await service.verify(agency, 'rahim@example.com', 'the right password');
  assert.equal(rehashes.length, 1);
  assert.equal(rehashes[0]!.expected, old);
  assert.match(rehashes[0]!.next, /\$m=64,t=1,p=1\$/);
  assert.equal(await hasher.verify('the right password', rehashes[0]!.next), true);
});

await test('a current hash is left alone, and a wrong password never upgrades anything', async () => {
  const current = await setup({});
  await current.service.verify(agency, 'rahim@example.com', 'the right password');
  assert.equal(current.rehashes.length, 0);

  const old = await setup({}, await weak.hash('the right password'));
  await assert.rejects(() => old.service.verify(agency, 'rahim@example.com', 'wrong'));
  assert.equal(old.rehashes.length, 0);
});

await test('failing to store the upgraded hash never fails the sign-in', async () => {
  const { service, failRehash } = await setup({}, await weak.hash('the right password'));
  failRehash();
  assert.deepEqual(
    await service.verify(agency, 'rahim@example.com', 'the right password'),
    account,
  );
});

await test('setting a password records an event in the same call, with ids only', async () => {
  const { service, events } = await setup({});
  assert.equal(await service.setPassword(agency, account.id, '$argon2id$v=19$x', 'req-9'), true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: (events[0] as { id: string }).id,
    agencyId: agency,
    actorId: account.id,
    subjectId: account.id,
    type: 'auth.password_reset',
    version: 1,
    occurredAt: '2026-10-07T00:00:00.000Z',
    correlationId: 'req-9',
  });
});

await test('a disabled account cannot have its password set', async () => {
  const { service } = await setup({ status: 'disabled' });
  assert.equal(await service.setPassword(agency, account.id, '$argon2id$v=19$x', 'req'), false);
});

await test('the right phone number and password give the account', async () => {
  const { service } = await setup({});
  assert.deepEqual(
    await service.verifyPhone(agency, '+8801712345678', 'the right password'),
    account,
  );
});

await test('an unknown number, a number with no password and a wrong password all fail the same way, with the same work done', async () => {
  const cases: [string, Awaited<ReturnType<typeof setup>>][] = [
    ['unknown', await setup(null)],
    ['no password', await setup({}, null)],
    ['wrong', await setup({})],
  ];
  for (const [name, { service, dummyChecks }] of cases) {
    await assert.rejects(
      () => service.verifyPhone(agency, '+8801712345678', 'a wrong password'),
      (error) =>
        error instanceof AppError && error.status === 401 && error.code === 'INVALID_CREDENTIALS',
      name,
    );
    // The two cases without a hash still pay for a hash check, so timing shows nothing.
    if (name !== 'wrong') assert.equal(dummyChecks(), 1, name);
  }
});

await test('a disabled account is refused by phone only after the right password, so strangers learn nothing', async () => {
  const { service } = await setup({ status: 'disabled' });
  await assert.rejects(
    () => service.verifyPhone(agency, '+8801712345678', 'the wrong one'),
    (error) => error instanceof AppError && error.status === 401,
  );
  await assert.rejects(
    () => service.verifyPhone(agency, '+8801712345678', 'the right password'),
    (error) =>
      error instanceof AppError && error.status === 403 && error.code === 'ACCOUNT_NOT_ACTIVE',
  );
});
