import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { Account } from '../src/bo/identity.js';
import type { Registration } from '../src/bo/registration.js';
import type { CodeCheck } from '../src/cache/repository/phone-code-repository.js';
import { AppError } from '../src/exception/app-error.js';
import { PhoneAuthProcess } from '../src/process/phone-auth-process.js';
import { SecretBox } from '../src/security/secret-box.js';
import type { CreateResult } from '../src/service/registration-service.js';
import type { SmsMessage } from '../src/sms/sender.js';
import { agency, otherAgency } from './fixtures.js';

const phone = '+8801712345678';
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

interface Member {
  account: Account;
  phone: string | null;
  status: 'invited' | 'active' | 'disabled';
}

function setup() {
  const box = new SecretBox('ab'.repeat(32));
  const messages: SmsMessage[] = [];
  const logs: string[] = [];
  const members: Member[] = [];
  const registered: { phone: string; displayName: string; registration: Registration }[] = [];
  const attached: { accountId: string; phone: string }[] = [];
  const sessions: string[] = [];
  const stored = new Map<string, string>();
  const pendingStore = new Map<string, string>();
  const counters = new Map<string, number>();
  let smsDown = false;
  let attachResult: 'attached' | 'taken' | 'inactive' = 'attached';

  const process = new PhoneAuthProcess(
    {
      send: async (message) => {
        if (smsDown) throw new Error(`gateway refused ${message.to}`);
        messages.push(message);
      },
    },
    {
      // Same rules as the Redis version: a new code replaces the old, a right guess uses it up,
      // and the wrong guess that reaches the limit cancels it.
      put: async (scope, fingerprint) => void stored.set(scope, `${fingerprint}|0`),
      check: async (scope, fingerprint, maxWrong): Promise<CodeCheck> => {
        const value = stored.get(scope);
        if (!value) return 'none';
        const [hash, wrong] = value.split('|') as [string, string];
        if (hash === fingerprint) {
          stored.delete(scope);
          return 'ok';
        }
        if (Number(wrong) + 1 >= maxWrong) {
          stored.delete(scope);
          return 'locked';
        }
        stored.set(scope, `${hash}|${Number(wrong) + 1}`);
        return 'wrong';
      },
    },
    {
      hit: async (name) => {
        counters.set(name, (counters.get(name) ?? 0) + 1);
        return { count: counters.get(name)!, retryAfter: 42 };
      },
    },
    {
      put: async (_purpose, scope, key, sealed) => {
        for (const [k, v] of [...pendingStore])
          if (v.startsWith(`${scope}|`)) pendingStore.delete(k);
        pendingStore.set(key, `${scope}|${sealed}`);
      },
      peek: async (_purpose, key) => pendingStore.get(key)?.split('|').slice(1).join('|') ?? null,
      take: async (_purpose, key) => {
        const value = pendingStore.get(key)?.split('|').slice(1).join('|') ?? null;
        pendingStore.delete(key);
        return value;
      },
    },
    {
      findByPhone: async (agencyId, number) => {
        const member = members.find((m) => m.phone === number && m.account.agencyId === agencyId);
        return member ? { account: member.account, status: member.status } : null;
      },
      registerPhone: async (agencyId, member, registration): Promise<CreateResult> => {
        if (members.some((m) => m.phone === member.phone && m.account.agencyId === agencyId))
          return { created: false };
        const account: Account = {
          id: randomUUID(),
          agencyId,
          role: 'member',
          displayName: member.displayName,
        };
        members.push({ account, phone: member.phone, status: 'active' });
        registered.push({ phone: member.phone, displayName: member.displayName, registration });
        return { created: true, account };
      },
      attachPhone: async (_agencyId, accountId, number) => {
        attached.push({ accountId, phone: number });
        return attachResult;
      },
    },
    {
      startSession: async (_agencyId, account) => {
        sessions.push(account.id);
        return {
          sessionId: `session-for-${account.id}`,
          accessToken: 'access',
          csrfToken: 'csrf',
          expiresIn: 600,
        };
      },
    },
    box,
    pino({ level: 'info' }, { write: (line: string) => logs.push(line) }),
  );

  const context = { agencyId: agency, agencyName: 'Marriage Solution BD' };
  const addMember = (over: Partial<Member> = {}): Member => {
    const member: Member = {
      account: { id: randomUUID(), agencyId: agency, role: 'member', displayName: 'Existing' },
      phone,
      status: 'active',
      ...over,
    };
    members.push(member);
    return member;
  };
  /** The code in the last text message, as the person would read it. */
  const lastCode = () => /\b(\d{6})\b/.exec(messages.at(-1)!.text)![1]!;
  /** Lets another code be sent at once, as if the minute had passed. */
  const passTheMinute = () => {
    for (const name of [...counters.keys()])
      if (name.startsWith('phone-gap:')) counters.delete(name);
  };
  return {
    process,
    context,
    messages,
    logs,
    members,
    registered,
    attached,
    sessions,
    stored,
    pendingStore,
    counters,
    addMember,
    lastCode,
    passTheMinute,
    box,
    breakSms: () => void (smsDown = true),
    attachWill: (result: typeof attachResult) => void (attachResult = result),
  };
}

const signupInput = {
  displayName: 'Nina',
  acceptTerms: true,
  acceptPrivacy: true,
  onBehalfOfOther: false,
  confirmAuthority: false,
};

await test('asking for a code sends one text with a six-digit code, in the language being read', async () => {
  const f = setup();
  const answer = await f.process.sendCode(f.context, phone, 'bn');
  assert.deepEqual(answer, { resendAfter: 60, expiresIn: 300 });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]!.to, phone);
  assert.match(f.messages[0]!.text, /Marriage Solution BD/);
  assert.match(f.messages[0]!.text, /কোড \d{6}/);
  assert.match(f.messages[0]!.text, /৫ মিনিট/);

  await f.process.sendCode({ ...f.context }, '+8801812345678', 'en');
  assert.match(f.messages[1]!.text, /your code is \d{6}\. It works for 5 minutes/);
});

await test('the code is never stored as typed: only a keyed fingerprint is kept', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const code6 = f.lastCode();
  const everything = JSON.stringify([...f.stored]);
  assert.equal(everything.includes(code6), false);
  assert.equal(everything.includes(phone), false);
  assert.match([...f.stored.values()][0]!, /^[0-9a-f]{64}\|0$/);
});

await test('a number that has an account and one that has not are treated exactly alike when asking', async () => {
  const f = setup();
  f.addMember({ phone: '+8801811111111' });
  const known = await f.process.sendCode(f.context, '+8801811111111', 'en');
  const unknown = await f.process.sendCode(f.context, '+8801922222222', 'en');
  assert.deepEqual(known, unknown);
  assert.equal(f.messages.length, 2);
  assert.equal(
    f.messages[0]!.text.replace(/\d{6}/, 'X'),
    f.messages[1]!.text.replace(/\d{6}/, 'X'),
  );
});

await test('a second code cannot be asked for within a minute, and the answer says how long to wait', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  await assert.rejects(
    () => f.process.sendCode(f.context, phone, 'en'),
    (error) =>
      error instanceof AppError &&
      error.status === 429 &&
      error.code === 'CODE_RATE_LIMITED' &&
      error.details?.retryAfter === 42,
  );
  assert.equal(f.messages.length, 1);
  // Another number is not held back by this one.
  await f.process.sendCode(f.context, '+8801812345678', 'en');
  assert.equal(f.messages.length, 2);
});

await test('one number gets at most five codes an hour, so nobody can be flooded with texts', async () => {
  const f = setup();
  for (let i = 0; i < 5; i++) {
    await f.process.sendCode(f.context, phone, 'en');
    f.passTheMinute();
  }
  await assert.rejects(
    () => f.process.sendCode(f.context, phone, 'en'),
    code(429, 'CODE_RATE_LIMITED'),
  );
  assert.equal(f.messages.length, 5);
});

await test('one agency cannot be made to pay for more than a day limit of codes', async () => {
  const f = setup();
  f.counters.set(`phone-day:${agency}`, 2000);
  await assert.rejects(
    () => f.process.sendCode(f.context, phone, 'en'),
    code(429, 'CODE_RATE_LIMITED'),
  );
  assert.equal(f.messages.length, 0);
  // Another agency has its own limit.
  await f.process.sendCode({ agencyId: otherAgency, agencyName: 'Other' }, phone, 'en');
  assert.equal(f.messages.length, 1);
});

await test('a gateway that fails is a plain 502, and nothing personal is logged', async () => {
  const f = setup();
  f.breakSms();
  await assert.rejects(
    () => f.process.sendCode(f.context, phone, 'en'),
    code(502, 'SMS_UNAVAILABLE'),
  );
  const written = f.logs.join('\n');
  assert.match(written, /SMS_SEND_FAILED/);
  assert.equal(written.includes(phone), false);
  assert.equal(written.includes('gateway refused'), false);
});

await test('the right code signs the owner of the number in, as the account that has it', async () => {
  const f = setup();
  const member = f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'req-1');
  assert.equal(outcome.kind, 'session');
  assert.equal(outcome.kind === 'session' && outcome.sessionId, `session-for-${member.account.id}`);
  assert.deepEqual(f.sessions, [member.account.id]);
});

await test('a wrong code signs nobody in and can be tried again', async () => {
  const f = setup();
  f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const right = f.lastCode();
  const wrong = right === '000000' ? '000001' : '000000';
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, wrong, 'en', 'r'),
    code(400, 'CODE_INVALID'),
  );
  assert.equal(f.sessions.length, 0);
  assert.equal((await f.process.verifyCode(agency, phone, right, 'en', 'r')).kind, 'session');
});

await test('five wrong guesses cancel the code: even the right one no longer works', async () => {
  const f = setup();
  f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const right = f.lastCode();
  const wrong = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      () => f.process.verifyCode(agency, phone, wrong, 'en', 'r'),
      code(400, 'CODE_INVALID'),
    );
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, wrong, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, right, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  assert.equal(f.sessions.length, 0);
});

await test('a code works once', async () => {
  const f = setup();
  f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const right = f.lastCode();
  await f.process.verifyCode(agency, phone, right, 'en', 'r');
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, right, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  assert.equal(f.sessions.length, 1);
});

await test('asking again cancels the earlier code, so only the newest works', async () => {
  const f = setup();
  f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const first = f.lastCode();
  f.passTheMinute();
  await f.process.sendCode(f.context, phone, 'en');
  const second = f.lastCode();
  if (first !== second)
    await assert.rejects(
      () => f.process.verifyCode(agency, phone, first, 'en', 'r'),
      code(400, 'CODE_INVALID'),
    );
  assert.equal((await f.process.verifyCode(agency, phone, second, 'en', 'r')).kind, 'session');
});

await test('a code only works for the number and the agency it was sent for', async () => {
  const f = setup();
  f.addMember();
  await f.process.sendCode(f.context, phone, 'en');
  const right = f.lastCode();
  await assert.rejects(
    () => f.process.verifyCode(agency, '+8801812345678', right, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.verifyCode(otherAgency, phone, right, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  assert.equal((await f.process.verifyCode(agency, phone, right, 'en', 'r')).kind, 'session');
});

await test('a disabled account is not signed in, even with the right code', async () => {
  const f = setup();
  f.addMember({ status: 'disabled' });
  await f.process.sendCode(f.context, phone, 'en');
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'r'),
    code(403, 'ACCOUNT_NOT_ACTIVE'),
  );
  assert.equal(f.sessions.length, 0);
});

await test('a right code for a number with no account creates nothing: the person is asked to agree first', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'bn', 'r');
  assert.equal(outcome.kind, 'signup');
  assert.equal(f.members.length, 0);
  assert.equal(f.sessions.length, 0);
  const pendingId = outcome.kind === 'signup' ? outcome.pendingId : '';
  assert.equal(pendingId.length, 43);
  // What waits is sealed, and the page is told only the number.
  assert.equal([...f.pendingStore.values()].join().includes(phone), false);
  assert.deepEqual(await f.process.pendingSignup(agency, pendingId), { phone });
});

await test('agreeing creates the member with the proven number and the name given, and signs them in', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'bn', 'r');
  const pendingId = outcome.kind === 'signup' ? outcome.pendingId : '';
  const session = await f.process.signup(
    agency,
    pendingId,
    { ...signupInput, onBehalfOfOther: true },
    'req-9',
  );
  assert.equal(session.accessToken, 'access');
  assert.equal(f.members.length, 1);
  const made = f.registered[0]!;
  assert.equal(made.phone, phone);
  assert.equal(made.displayName, 'Nina');
  assert.equal(made.registration.locale, 'bn');
  assert.equal(made.registration.onBehalfOfOther, true);
  assert.ok(
    made.registration.termsVersion.length > 0 && made.registration.privacyVersion.length > 0,
  );
  assert.deepEqual(f.sessions, [f.members[0]!.account.id]);
  // From now on the number signs in.
  f.passTheMinute();
  await f.process.sendCode(f.context, phone, 'en');
  assert.equal(
    (await f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'r')).kind,
    'session',
  );
});

await test('the agree step works once, and a double press cannot create two accounts', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'r');
  const pendingId = outcome.kind === 'signup' ? outcome.pendingId : '';
  await Promise.all([
    f.process.signup(agency, pendingId, signupInput, 'r').catch(() => null),
    f.process.signup(agency, pendingId, signupInput, 'r').catch(() => null),
  ]);
  assert.equal(f.members.length, 1);
  await assert.rejects(
    () => f.process.signup(agency, pendingId, signupInput, 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

await test('the agree step belongs to the agency it began at and to nobody else', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'r');
  const pendingId = outcome.kind === 'signup' ? outcome.pendingId : '';
  await assert.rejects(
    () => f.process.pendingSignup(otherAgency, pendingId),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.signup(otherAgency, pendingId, signupInput, 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.pendingSignup(agency, 'z'.repeat(43)),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.members.length, 0);
});

await test('a number that got an account while the step was open is not given a second one', async () => {
  const f = setup();
  await f.process.sendCode(f.context, phone, 'en');
  const outcome = await f.process.verifyCode(agency, phone, f.lastCode(), 'en', 'r');
  const pendingId = outcome.kind === 'signup' ? outcome.pendingId : '';
  f.addMember();
  await assert.rejects(
    () => f.process.signup(agency, pendingId, signupInput, 'r'),
    code(409, 'PHONE_RETRY'),
  );
  assert.equal(f.members.length, 1);
  assert.equal(f.sessions.length, 0);
});

await test('adding a number: a code sent for the account adds it, once the right code is given', async () => {
  const f = setup();
  const member = f.addMember({ phone: null });
  await f.process.sendAttachCode(f.context, member.account, phone, 'en');
  assert.equal(f.messages.length, 1);
  await f.process.confirmAttach(agency, member.account, phone, f.lastCode(), 'req-a');
  assert.deepEqual(f.attached, [{ accountId: member.account.id, phone }]);
});

await test('adding a number: a wrong code adds nothing, and a code is not shared between sign-in and adding', async () => {
  const f = setup();
  const member = f.addMember({ phone: null });
  await f.process.sendAttachCode(f.context, member.account, phone, 'en');
  const attachCode = f.lastCode();
  const wrong = attachCode === '000000' ? '000001' : '000000';
  await assert.rejects(
    () => f.process.confirmAttach(agency, member.account, phone, wrong, 'r'),
    code(400, 'CODE_INVALID'),
  );
  // A code meant for adding cannot sign anyone in.
  await assert.rejects(
    () => f.process.verifyCode(agency, phone, attachCode, 'en', 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  assert.equal(f.attached.length, 0);
  assert.equal(f.sessions.length, 0);
});

await test('adding a number: a code sent for one account cannot add the number to another', async () => {
  const f = setup();
  const mine = f.addMember({ phone: null });
  const theirs = f.addMember({ phone: null });
  await f.process.sendAttachCode(f.context, mine.account, phone, 'en');
  await assert.rejects(
    () => f.process.confirmAttach(agency, theirs.account, phone, f.lastCode(), 'r'),
    code(400, 'CODE_EXPIRED'),
  );
  assert.equal(f.attached.length, 0);
});

await test('adding a number that another account uses, or to an inactive account, is refused after the proof', async () => {
  const f = setup();
  const member = f.addMember({ phone: null });
  f.attachWill('taken');
  await f.process.sendAttachCode(f.context, member.account, phone, 'en');
  await assert.rejects(
    () => f.process.confirmAttach(agency, member.account, phone, f.lastCode(), 'r'),
    code(409, 'PHONE_IN_USE'),
  );
  f.passTheMinute();
  f.attachWill('inactive');
  await f.process.sendAttachCode(f.context, member.account, phone, 'en');
  await assert.rejects(
    () => f.process.confirmAttach(agency, member.account, phone, f.lastCode(), 'r'),
    code(403, 'ACCOUNT_NOT_ACTIVE'),
  );
});

await test('asking for an adding code for a number that has an account looks the same as for a free one', async () => {
  const f = setup();
  f.addMember({ phone: '+8801811111111' });
  const me = f.addMember({ phone: null });
  const taken = await f.process.sendAttachCode(f.context, me.account, '+8801811111111', 'en');
  const free = await f.process.sendAttachCode(f.context, me.account, '+8801922222222', 'en');
  assert.deepEqual(taken, free);
  assert.equal(f.messages.length, 2);
});
