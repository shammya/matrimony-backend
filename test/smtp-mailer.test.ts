import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { SmtpMailer, type SmtpSettings } from '../src/mail/smtp-mailer.js';

interface Received {
  from: string;
  to: string[];
  raw: string;
  user?: string;
}

/** A real SMTP server on a random local port that records what it is sent. */
async function smtpServer(options: Partial<SMTPServerOptions> & { reject?: string } = {}) {
  const received: Received[] = [];
  const { reject, ...serverOptions } = options;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onRcptTo: (address, _session, done) => {
      if (reject && address.address === reject) return done(new Error('550 mailbox unavailable'));
      done();
    },
    onData: (stream, session, done) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          ...(session.user ? { user: String(session.user) } : {}),
        });
        done();
      });
    },
    ...serverOptions,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { server, received, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const settings = (port: number, over: Partial<SmtpSettings> = {}): SmtpSettings => ({
  host: '127.0.0.1',
  port,
  tls: 'none',
  from: 'Marriage Solution BD <no-reply@marriage.example>',
  timeoutMs: 2000,
  ...over,
});

/** The text of the message body, whatever transfer encoding it was sent with. */
function bodyOf(raw: string): string {
  const [head = '', ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join('\n\n');
  if (/content-transfer-encoding:\s*base64/i.test(head))
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    const bytes: number[] = [];
    const joined = body.replace(/=\r?\n/g, '');
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] === '=' && /^[0-9A-F]{2}$/i.test(joined.slice(i + 1, i + 3))) {
        bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(joined[i]!, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return body;
}

await test('a message is delivered with the right sender, recipient, subject and text', async (t) => {
  const smtp = await smtpServer();
  t.after(smtp.close);
  const mailer = new SmtpMailer(settings(smtp.port));
  await mailer.send({
    to: 'rahim@example.com',
    subject: 'MSBD: confirm your email',
    text: 'Open the link below.\n\nhttps://marriage.example/en/verify-email?token=abc',
  });
  assert.equal(smtp.received.length, 1);
  const mail = smtp.received[0]!;
  assert.equal(mail.from, 'no-reply@marriage.example');
  assert.deepEqual(mail.to, ['rahim@example.com']);
  assert.match(mail.raw, /^From: "?Marriage Solution BD"? <no-reply@marriage\.example>/im);
  assert.match(mail.raw, /^To: rahim@example\.com/im);
  assert.match(mail.raw, /^Subject: MSBD: confirm your email/im);
  assert.match(mail.raw, /^Auto-Submitted: auto-generated/im);
  assert.match(bodyOf(mail.raw), /https:\/\/marriage\.example\/en\/verify-email\?token=abc/);
});

await test('Bengali text arrives intact', async (t) => {
  const smtp = await smtpServer();
  t.after(smtp.close);
  const mailer = new SmtpMailer(settings(smtp.port));
  await mailer.send({
    to: 'rahim@example.com',
    subject: 'আপনার ইমেইল নিশ্চিত করুন',
    text: 'প্রিয় রহিম,\n\nনিচের লিংকটি খুলুন।',
  });
  const mail = smtp.received[0]!;
  assert.match(mail.raw, /charset=utf-8/i);
  const normalised = (text: string) => text.replace(/\r\n/g, '\n').trim();
  assert.equal(normalised(bodyOf(mail.raw)), 'প্রিয় রহিম,\n\nনিচের লিংকটি খুলুন।');
});

await test('a recipient or subject cannot carry extra headers or another recipient', async (t) => {
  const smtp = await smtpServer();
  t.after(smtp.close);
  const mailer = new SmtpMailer(settings(smtp.port));
  await mailer
    .send({
      to: 'rahim@example.com',
      subject: 'Hello\r\nBcc: attacker@example.com',
      text: 'Hi',
    })
    .catch(() => undefined);
  for (const mail of smtp.received) {
    assert.deepEqual(mail.to, ['rahim@example.com']);
    assert.doesNotMatch(mail.raw.split(/\r?\n\r?\n/)[0]!, /^Bcc:/im);
  }
});

await test('the user and password are used when set, and a wrong password stops the message', async (t) => {
  const smtp = await smtpServer({
    authOptional: false,
    allowInsecureAuth: true,
    onAuth: (auth, _session, done) =>
      auth.username === 'mailer' && auth.password === 'correct-secret'
        ? done(null, { user: auth.username })
        : done(new Error('Invalid login')),
  });
  t.after(smtp.close);
  const message = { to: 'rahim@example.com', subject: 'Hi', text: 'Hi' };

  await new SmtpMailer(settings(smtp.port, { user: 'mailer', password: 'correct-secret' })).send(
    message,
  );
  assert.equal(smtp.received.length, 1);
  assert.equal(smtp.received[0]!.user, 'mailer');
  assert.equal(smtp.received[0]!.raw.includes('correct-secret'), false);

  await assert.rejects(() =>
    new SmtpMailer(settings(smtp.port, { user: 'mailer', password: 'wrong' })).send(message),
  );
  await assert.rejects(() => new SmtpMailer(settings(smtp.port)).send(message));
  assert.equal(smtp.received.length, 1);
});

await test('a refused recipient is an error, not a silent success', async (t) => {
  const smtp = await smtpServer({ reject: 'nobody@example.com' });
  t.after(smtp.close);
  await assert.rejects(() =>
    new SmtpMailer(settings(smtp.port)).send({
      to: 'nobody@example.com',
      subject: 'Hi',
      text: 'Hi',
    }),
  );
  assert.equal(smtp.received.length, 0);
});

await test('with encryption required, a server that cannot encrypt gets nothing at all', async (t) => {
  const smtp = await smtpServer();
  t.after(smtp.close);
  await assert.rejects(() =>
    new SmtpMailer(settings(smtp.port, { tls: 'starttls' })).send({
      to: 'rahim@example.com',
      subject: 'A reset link',
      text: 'https://marriage.example/en/reset-password?token=secret',
    }),
  );
  assert.equal(smtp.received.length, 0);
});

await test('a mail server that never answers is given up on, not waited for', async (t) => {
  // Accepts the connection and says nothing.
  const silent = createTcpServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => silent.close());
  const port = (silent.address() as AddressInfo).port;
  const started = Date.now();
  await assert.rejects(() =>
    new SmtpMailer(settings(port, { timeoutMs: 300 })).send({
      to: 'rahim@example.com',
      subject: 'Hi',
      text: 'Hi',
    }),
  );
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
