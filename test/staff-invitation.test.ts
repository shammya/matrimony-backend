import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { StaffInvitationProcess } from '../src/process/staff-invitation-process.js';
import { digest } from '../src/security/secret-box.js';
import { AppError } from '../src/exception/app-error.js';
import type { MailMessage } from '../src/mail/mailer.js';
import type { StaffInvitation } from '../src/bo/staff.js';
import { agency } from './fixtures.js';

const context = { agencyId: agency, agencyName: 'MSBD', origin: 'https://marriage.example' };
const boss = {
  id: '55555555-5555-4555-8555-555555555555',
  role: 'admin' as const,
  displayName: 'Boss',
};
const input = {
  email: 'new.agent@example.com',
  displayName: 'New Agent',
  role: 'agent' as const,
  locale: 'en' as const,
};
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function setup(options: { mailFails?: boolean; passwordHash?: string } = {}) {
  const mails: MailMessage[] = [];
  const logs: string[] = [];
  const hits = new Map<string, number>();
  const hashes: string[] = [];
  const stored: StaffInvitation = {
    id: '66666666-6666-4666-8666-666666666666',
    email: input.email,
    displayName: input.displayName,
    role: 'agent',
    locale: 'en',
    invitedByName: 'Boss',
    createdAt: '2026-10-09T00:00:00.000Z',
    expiresAt: '2026-10-16T00:00:00.000Z',
    status: 'pending',
  };
  const seen: { name: string; args: unknown[] }[] = [];
  let good: string | null = null;
  const process = new StaffInvitationProcess(
    {
      invite: async (...args: unknown[]) => {
        seen.push({ name: 'invite', args });
        good = args[2] as string;
        const { locale, role } = args[1] as StaffInvitation;
        return { ...stored, locale, role };
      },
      reissue: async (...args: unknown[]) => {
        seen.push({ name: 'reissue', args });
        good = args[2] as string;
        return stored;
      },
      open: async () => [stored],
      revoke: async () => {},
      preview: async (_agency: string, hash: string) =>
        hash === good
          ? { email: input.email, displayName: input.displayName, role: 'agent' as const }
          : null,
      accept: async (...args: unknown[]) => {
        seen.push({ name: 'accept', args });
        return args[1] === good
          ? { id: 'a', agencyId: agency, role: 'agent' as const, displayName: 'New Agent' }
          : null;
      },
    } as never,
    {
      hash: async (password: string) => {
        hashes.push(password);
        return 'HASH';
      },
    },
    {
      startSession: async () => ({
        sessionId: 's',
        accessToken: 't',
        csrfToken: 'c',
        expiresIn: 600,
      }),
    },
    {
      hit: async (name: string) => {
        const count = (hits.get(name) ?? 0) + 1;
        hits.set(name, count);
        return { count, retryAfter: 3000 };
      },
    },
    {
      send: async (message) => {
        if (options.mailFails) throw new Error(`gateway refused ${message.to}`);
        mails.push(message);
      },
    },
    pino(
      { level: 'error' },
      {
        write: (line: string) => {
          logs.push(line);
        },
      },
    ),
  );
  return { process, mails, logs, seen, hashes };
}

await test('the invitation email goes to the invited address with a link to the accept page', async () => {
  const f = setup();
  await f.process.invite(context, boss, input, 'r1');
  await f.process.idle();
  const [mail] = f.mails;
  assert.equal(mail?.to, input.email);
  assert.match(mail!.text, /MSBD/);
  assert.match(mail!.text, /Boss/);
  assert.match(mail!.text, /an agent/);
  const token = /https:\/\/marriage\.example\/en\/accept-invite\?token=([A-Za-z0-9_-]{43})/.exec(
    mail!.text,
  )?.[1];
  assert.ok(token);
  // What is stored is a hash of the secret tied to the agency, never the secret.
  const stored = f.seen[0]?.args[2] as string;
  assert.equal(stored, digest(`${agency}.${token}`));
  assert.equal(stored.includes(token!), false);
});

await test('the email reads in Bengali for a Bengali invitation, and names an admin invitation', async () => {
  const f = setup();
  await f.process.invite(context, boss, { ...input, locale: 'bn', role: 'admin' }, 'r1');
  await f.process.idle();
  assert.match(f.mails[0]!.subject, /আমন্ত্রণ/);
  assert.match(f.mails[0]!.text, /\/en\/accept-invite|\/bn\/accept-invite/);
});

await test('only an admin invites, and nothing is sent or counted otherwise', async () => {
  const f = setup();
  for (const role of ['agent', 'member'] as const)
    await assert.rejects(
      () => f.process.invite(context, { ...boss, role }, input, 'r1'),
      code(403, 'ROLE_FORBIDDEN'),
    );
  await f.process.idle();
  assert.equal(f.mails.length, 0);
  assert.equal(f.seen.length, 0);
});

await test('one address is sent at most three invitation emails an hour, and one admin thirty', async () => {
  const f = setup();
  for (let i = 0; i < 3; i++) await f.process.invite(context, boss, input, `r${i}`);
  await assert.rejects(
    () => f.process.invite(context, boss, input, 'r4'),
    (e) => e instanceof AppError && e.status === 429 && e.code === 'EMAIL_RATE_LIMITED',
  );
  const g = setup();
  for (let i = 0; i < 30; i++)
    await g.process.invite(context, boss, { ...input, email: `p${i}@example.com` }, `r${i}`);
  await assert.rejects(
    () => g.process.invite(context, boss, { ...input, email: 'one.more@example.com' }, 'x'),
    code(429, 'EMAIL_RATE_LIMITED'),
  );
});

await test('resending sends a new link, and an invitation can be resent three times an hour', async () => {
  const f = setup();
  await f.process.invite(context, boss, input, 'r1');
  await f.process.resend(context, boss, '66666666-6666-4666-8666-666666666666', 'r2');
  await f.process.idle();
  const links = f.mails.map((m) => /token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1]);
  assert.equal(links.length, 2);
  assert.notEqual(links[0], links[1]);
  for (let i = 0; i < 2; i++)
    await f.process.resend(context, boss, '66666666-6666-4666-8666-666666666666', 'r');
  await assert.rejects(
    () => f.process.resend(context, boss, '66666666-6666-4666-8666-666666666666', 'r'),
    code(429, 'EMAIL_RATE_LIMITED'),
  );
});

await test('a mail failure is logged without the address or the link, and the invitation still stands', async () => {
  const f = setup({ mailFails: true });
  const created = await f.process.invite(context, boss, input, 'r1');
  await f.process.idle();
  assert.equal(created.email, input.email);
  const written = f.logs.join('\n');
  assert.match(written, /MAIL_SEND_FAILED/);
  assert.equal(written.includes(input.email), false);
  assert.equal(written.includes('accept-invite'), false);
  assert.equal(written.includes('gateway refused'), false);
});

await test('accepting hashes the password, signs the person in, and a wrong link creates nothing', async () => {
  const f = setup();
  await f.process.invite(context, boss, input, 'r1');
  await f.process.idle();
  const token = /token=([A-Za-z0-9_-]{43})/.exec(f.mails[0]!.text)![1]!;
  await assert.rejects(
    () =>
      f.process.accept(
        agency,
        { token: 'B'.repeat(43), password: 'a long and strong password' },
        'r',
      ),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.hashes.length, 0);
  const session = await f.process.accept(
    agency,
    { token, password: 'a long and strong password' },
    'r',
  );
  assert.equal(session.accessToken, 't');
  assert.deepEqual(f.hashes, ['a long and strong password']);
  // What the service got is the hash, not the password.
  const accept = f.seen.find((s) => s.name === 'accept')!;
  assert.equal(accept.args[2], 'HASH');
});

await test('a password that is the email is refused before anything is created', async () => {
  const f = setup();
  await f.process.invite(context, boss, input, 'r1');
  await f.process.idle();
  const token = /token=([A-Za-z0-9_-]{43})/.exec(f.mails[0]!.text)![1]!;
  for (const password of ['new.agent@example.com', 'new.agent']) {
    await assert.rejects(
      () => f.process.accept(agency, { token, password }, 'r'),
      (e) =>
        e instanceof AppError &&
        e.status === 400 &&
        JSON.stringify(e.details).includes('sameAsEmail'),
    );
  }
  assert.equal(f.hashes.length, 0);
  assert.equal(
    f.seen.some((s) => s.name === 'accept'),
    false,
  );
});
