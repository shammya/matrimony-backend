import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { CredentialRecord } from '../src/bo/credentials-record.js';
import type { Account } from '../src/bo/identity.js';
import type { Registration } from '../src/bo/registration.js';
import type { FoundAccount } from '../src/db/raw/repository/registration-repository.js';
import type { GoogleStartInput } from '../src/bo/google.js';
import { AppError } from '../src/exception/app-error.js';
import { GoogleAuthProcess, GoogleSignInError } from '../src/process/google-auth-process.js';
import type {
  GoogleAttempt,
  GoogleIdentityProvider,
  GoogleProfile,
} from '../src/security/google-provider.js';
import { SecretBox, digest } from '../src/security/secret-box.js';
import type { CreateResult, ExternalIdentity } from '../src/service/registration-service.js';
import { agency, otherAgency } from './fixtures.js';

const origin = 'https://marriage.example';
const callback = new URL(`${origin}/api/v1/auth/google/callback?code=abc&state=xyz`);
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

const profile = (over: Partial<GoogleProfile> = {}): GoogleProfile => ({
  subject: 'google-sub-1',
  email: 'rahim@example.com',
  emailVerified: true,
  name: 'Rahim Uddin',
  ...over,
});

interface Member {
  account: Account;
  email: string;
  status: FoundAccount['status'];
  password?: string;
}

function setup() {
  const box = new SecretBox('ab'.repeat(32));
  const members: Member[] = [];
  const links: { accountId: string; provider: string; subject: string }[] = [];
  const registered: {
    identity: ExternalIdentity & { displayName: string };
    registration: Registration;
  }[] = [];
  const challenges = new Map<string, string>();
  const stored = new Map<string, string>();
  const sessionsStarted: string[] = [];
  const attempts: GoogleAttempt[] = [];
  let exchanged: { url: URL; attempt: GoogleAttempt }[] = [];
  let googleDown = false;
  let next: GoogleProfile | Error = profile();
  let linkRefused = false;
  let paused = false;
  let wrongPasswords = 0;

  const provider: GoogleIdentityProvider = {
    authorize: async (attempt) => {
      if (googleDown) throw new AppError(502, 'GOOGLE_UNAVAILABLE');
      attempts.push(attempt);
      return `https://accounts.google.example/auth?state=${attempt.state}`;
    },
    exchange: async (url, attempt) => {
      exchanged.push({ url, attempt });
      if (next instanceof Error) throw next;
      return next;
    },
  };

  const process = new GoogleAuthProcess(
    provider,
    {
      putChallenge: async (id, value) => void challenges.set(id, value),
      takeChallenge: async (id) => {
        const value = challenges.get(id) ?? null;
        challenges.delete(id);
        return value;
      },
    },
    {
      put: async (_purpose, scope, key, sealed) => {
        // A newer pending link for an account cancels the older one, like the real store.
        for (const [k, v] of [...stored]) if (v.startsWith(`${scope}|`)) stored.delete(k);
        stored.set(key, `${scope}|${sealed}`);
      },
      peek: async (_purpose, key) => stored.get(key)?.split('|').slice(1).join('|') ?? null,
      take: async (_purpose, key) => {
        const value = stored.get(key)?.split('|').slice(1).join('|') ?? null;
        stored.delete(key);
        return value;
      },
    },
    {
      findByIdentity: async (agencyId, providerName, subject) => {
        const link = links.find((l) => l.provider === providerName && l.subject === subject);
        const member = link && members.find((m) => m.account.id === link.accountId);
        return member && member.account.agencyId === agencyId
          ? { account: member.account, status: member.status }
          : null;
      },
      registerExternal: async (agencyId, identity, registration): Promise<CreateResult> => {
        if (members.some((m) => m.email === identity.email)) return { created: false };
        const account: Account = {
          id: randomUUID(),
          agencyId,
          role: 'member',
          displayName: identity.displayName,
        };
        members.push({ account, email: identity.email, status: 'active' });
        links.push({
          accountId: account.id,
          provider: identity.provider,
          subject: identity.subject,
        });
        registered.push({ identity, registration });
        return { created: true, account };
      },
      linkIdentity: async (_agencyId, accountId, identity) => {
        if (linkRefused) return false;
        links.push({ accountId, provider: identity.provider, subject: identity.subject });
        return true;
      },
    },
    {
      findByEmail: async (_agencyId, email): Promise<CredentialRecord | null> => {
        const member = members.find((m) => m.email === email);
        return member
          ? {
              account: member.account,
              status: member.status,
              email: member.email,
              locale: 'bn',
              passwordHash: member.password ? 'hash' : null,
            }
          : null;
      },
    },
    {
      checkPassword: async (_agencyId, email, password) => {
        if (paused) throw new AppError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 600 });
        const member = members.find((m) => m.email === email);
        if (!member || member.password !== password) {
          wrongPasswords++;
          throw new AppError(401, 'INVALID_CREDENTIALS');
        }
        return member.account;
      },
      startSession: async (_agencyId, account) => {
        const sessionId = `session-for-${account.id}`;
        sessionsStarted.push(account.id);
        return { sessionId, accessToken: 'access', csrfToken: 'csrf', expiresIn: 600 };
      },
    },
    box,
    pino({ level: 'silent' }),
  );

  const addMember = (over: Partial<Member> = {}): Member => {
    const member: Member = {
      account: { id: randomUUID(), agencyId: agency, role: 'member', displayName: 'Existing' },
      email: 'rahim@example.com',
      status: 'active',
      password: 'the right password',
      ...over,
    };
    members.push(member);
    return member;
  };

  const login: GoogleStartInput = {
    intent: 'login',
    locale: 'bn',
    acceptTerms: false,
    acceptPrivacy: false,
    onBehalfOfOther: false,
    confirmAuthority: false,
  };
  const registerInput = {
    ...login,
    intent: 'register' as const,
    acceptTerms: true,
    acceptPrivacy: true,
  };

  /** Starts a sign-in and comes back from Google, as the browser would. */
  async function run(input: GoogleStartInput = login, agencyId = agency) {
    const started = await process.start(agency, origin, input);
    return process.complete(agencyId, started.challengeId, callback, 'req-1');
  }

  return {
    process,
    members,
    links,
    registered,
    challenges,
    stored,
    sessionsStarted,
    attempts,
    exchanged: () => exchanged,
    wrongPasswords: () => wrongPasswords,
    addMember,
    login,
    registerInput,
    run,
    box,
    setProfile: (p: GoogleProfile | Error) => void (next = p),
    setGoogleDown: () => void (googleDown = true),
    refuseLink: () => void (linkRefused = true),
    pause: () => void (paused = true),
    resetExchanged: () => void (exchanged = []),
  };
}

await test('starting a sign-in keeps its secrets sealed and sends the browser to Google', async () => {
  const f = setup();
  const started = await f.process.start(agency, origin, f.login);
  assert.match(started.authorizationUrl, /^https:\/\/accounts\.google\.example\/auth\?state=/);
  assert.equal(started.challengeId.length, 43);

  const attempt = f.attempts[0]!;
  assert.equal(attempt.redirectUri, `${origin}/api/v1/auth/google/callback`);
  for (const secret of [attempt.state, attempt.nonce, attempt.verifier])
    assert.equal(secret.length, 43);
  // What is stored is sealed: the verifier and nonce cannot be read from it.
  const sealed = f.challenges.get(digest(started.challengeId))!;
  assert.equal(sealed.includes(attempt.verifier), false);
  assert.equal(sealed.includes(attempt.nonce), false);
});

await test('every attempt has its own state, nonce and verifier', async () => {
  const f = setup();
  await f.process.start(agency, origin, f.login);
  await f.process.start(agency, origin, f.login);
  const [a, b] = f.attempts;
  assert.notEqual(a!.state, b!.state);
  assert.notEqual(a!.nonce, b!.nonce);
  assert.notEqual(a!.verifier, b!.verifier);
});

await test('if Google cannot be reached nothing is stored', async () => {
  const f = setup();
  f.setGoogleDown();
  await assert.rejects(
    () => f.process.start(agency, origin, f.login),
    code(502, 'GOOGLE_UNAVAILABLE'),
  );
  assert.equal(f.challenges.size, 0);
});

await test('coming back hands Google the exact attempt that was started, and the address it came to', async () => {
  const f = setup();
  f.addMember();
  f.members[0]!.password = 'x';
  f.links.push({
    accountId: f.members[0]!.account.id,
    provider: 'google',
    subject: 'google-sub-1',
  });
  await f.run();
  const [call] = f.exchanged();
  assert.equal(call!.url.href, callback.href);
  assert.deepEqual(call!.attempt.state, f.attempts[0]!.state);
  assert.equal(call!.attempt.verifier, f.attempts[0]!.verifier);
});

await test('an attempt can be completed once, only with its own cookie, and only at its own agency', async () => {
  const f = setup();
  const mine = f.addMember();
  f.links.push({ accountId: mine.account.id, provider: 'google', subject: 'google-sub-1' });
  const started = await f.process.start(agency, origin, f.login);

  await assert.rejects(
    () => f.process.complete(otherAgency, started.challengeId, callback, 'r'),
    code(401, 'OAUTH_CONTEXT_MISMATCH'),
  );
  // Using it up, even by a refused try, means it cannot be replayed.
  await assert.rejects(
    () => f.process.complete(agency, started.challengeId, callback, 'r'),
    code(401, 'OAUTH_CHALLENGE_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.complete(agency, 'x'.repeat(43), callback, 'r'),
    code(401, 'OAUTH_CHALLENGE_EXPIRED'),
  );
});

await test('coming back to a different address than the one registered with Google is refused', async () => {
  const f = setup();
  const started = await f.process.start(agency, origin, f.login);
  const elsewhere = new URL('https://evil.example/api/v1/auth/google/callback?code=abc&state=xyz');
  await assert.rejects(
    () => f.process.complete(agency, started.challengeId, elsewhere, 'r'),
    code(401, 'OAUTH_CONTEXT_MISMATCH'),
  );
  const otherPath = new URL(`${origin}/api/v1/other?code=abc`);
  const second = await f.process.start(agency, origin, f.login);
  await assert.rejects(
    () => f.process.complete(agency, second.challengeId, otherPath, 'r'),
    code(401, 'OAUTH_CONTEXT_MISMATCH'),
  );
});

await test('a failed exchange with Google (bad state, nonce, signature, cancelled) signs nobody in and creates nothing', async () => {
  const f = setup();
  f.setProfile(new AppError(401, 'GOOGLE_AUTH_FAILED'));
  await assert.rejects(() => f.run(f.registerInput), code(401, 'GOOGLE_AUTH_FAILED'));
  assert.equal(f.members.length, 0);
  assert.equal(f.sessionsStarted.length, 0);
});

await test('an email Google has not confirmed proves nothing: no sign-in, no account, no link', async () => {
  const f = setup();
  f.setProfile(profile({ emailVerified: false }));
  await assert.rejects(() => f.run(f.registerInput), code(403, 'GOOGLE_EMAIL_UNVERIFIED'));
  f.addMember();
  await assert.rejects(() => f.run(), code(403, 'GOOGLE_EMAIL_UNVERIFIED'));
  assert.equal(f.members.length, 1);
  assert.equal(f.links.length, 0);
  assert.equal(f.stored.size, 0);
});

await test('a linked Google identity signs in to its own account', async () => {
  const f = setup();
  const member = f.addMember();
  f.links.push({ accountId: member.account.id, provider: 'google', subject: 'google-sub-1' });
  const outcome = await f.run();
  assert.deepEqual(outcome, {
    kind: 'session',
    locale: 'bn',
    sessionId: `session-for-${member.account.id}`,
  });
  assert.equal(f.registered.length, 0);
});

await test("the identity is found by Google's id, not by the email, so a changed email still signs in", async () => {
  const f = setup();
  const member = f.addMember({ email: 'old@example.com' });
  f.links.push({ accountId: member.account.id, provider: 'google', subject: 'google-sub-1' });
  f.setProfile(profile({ email: 'brand.new@example.com' }));
  assert.equal((await f.run()).kind, 'session');
});

await test('a linked account that was disabled cannot sign in with Google either', async () => {
  const f = setup();
  const member = f.addMember({ status: 'disabled' });
  f.links.push({ accountId: member.account.id, provider: 'google', subject: 'google-sub-1' });
  await assert.rejects(() => f.run(), code(403, 'ACCOUNT_NOT_ACTIVE'));
  assert.equal(f.sessionsStarted.length, 0);
});

await test('signing in with Google never creates an account for someone who has none: they are asked to agree first', async () => {
  const f = setup();
  const outcome = await f.run(f.login);
  assert.equal(outcome.kind, 'signup');
  assert.equal(f.members.length, 0);
  assert.equal(f.registered.length, 0);
  assert.equal(f.links.length, 0);
  assert.equal(f.sessionsStarted.length, 0);
});

await test("registering with Google creates a member from Google's confirmed email and name, then signs in", async () => {
  const f = setup();
  const outcome = await f.run({ ...f.registerInput, locale: 'en' });
  assert.equal(outcome.kind, 'session');
  assert.equal(outcome.locale, 'en');
  assert.equal(f.members.length, 1);
  assert.equal(f.members[0]!.account.role, 'member');
  assert.equal(f.members[0]!.email, 'rahim@example.com');
  assert.equal(f.registered[0]!.identity.displayName, 'Rahim Uddin');
  assert.equal(f.registered[0]!.registration.locale, 'en');
  assert.equal(f.sessionsStarted.length, 1);
});

await test('registering for someone else is recorded, with the versions of the texts that were agreed to', async () => {
  const f = setup();
  await f.run({ ...f.registerInput, onBehalfOfOther: true, confirmAuthority: true });
  const { registration } = f.registered[0]!;
  assert.equal(registration.onBehalfOfOther, true);
  assert.ok(registration.termsVersion.length > 0 && registration.privacyVersion.length > 0);
});

await test('the name is tidied, and falls back to the start of the email when Google gives none', async () => {
  const messy = setup();
  messy.setProfile(profile({ name: '  Rahim \n  Uddin  ' }));
  await messy.run(messy.registerInput);
  assert.equal(messy.registered[0]!.identity.displayName, 'Rahim Uddin');

  const none = setup();
  none.setProfile(profile({ name: undefined, email: 'karim.b@example.com' }));
  await none.run(none.registerInput);
  assert.equal(none.registered[0]!.identity.displayName, 'karim.b');

  const long = setup();
  long.setProfile(profile({ name: 'x'.repeat(300) }));
  await long.run(long.registerInput);
  assert.equal(long.registered[0]!.identity.displayName.length, 100);
});

await test('the same Google identity registering twice is just a sign-in', async () => {
  const f = setup();
  await f.run(f.registerInput);
  const again = await f.run(f.registerInput);
  assert.equal(again.kind, 'session');
  assert.equal(f.members.length, 1);
  assert.equal(f.registered.length, 1);
});

await test('Google is never attached to an existing account on the email alone: the owner must prove it with the password', async () => {
  for (const input of [setup().login, setup().registerInput]) {
    const f = setup();
    const member = f.addMember();
    const outcome = await f.run(input);
    assert.equal(outcome.kind, 'link');
    // Nothing was linked, created or signed in.
    assert.equal(f.links.length, 0);
    assert.equal(f.members.length, 1);
    assert.equal(f.registered.length, 0);
    assert.equal(f.sessionsStarted.length, 0);
    assert.ok(member);
  }
});

await test('an account with no password cannot be linked by email, and is told how to get one', async () => {
  const f = setup();
  f.addMember({ password: undefined });
  await assert.rejects(() => f.run(), code(409, 'ACCOUNT_HAS_NO_PASSWORD'));
  assert.equal(f.links.length, 0);
});

await test('a disabled account is never offered a link', async () => {
  const f = setup();
  f.addMember({ status: 'disabled' });
  await assert.rejects(() => f.run(), code(403, 'ACCOUNT_NOT_ACTIVE'));
  assert.equal(f.stored.size, 0);
});

async function pending(f: ReturnType<typeof setup>) {
  f.addMember();
  const outcome = await f.run();
  assert.equal(outcome.kind, 'link');
  return outcome.kind === 'link' ? outcome.pendingId : '';
}

await test('the page that asks for the password is told whose account it is, and nothing secret', async () => {
  const f = setup();
  const id = await pending(f);
  assert.deepEqual(await f.process.pending(agency, id), { email: 'rahim@example.com' });
  const everything = JSON.stringify([...f.stored.values()]);
  assert.equal(everything.includes('google-sub-1'), false);
  assert.equal(everything.includes('rahim@example.com'), false);
});

await test('the pending link is unknown to another agency and to a made-up id', async () => {
  const f = setup();
  const id = await pending(f);
  await assert.rejects(
    () => f.process.pending(otherAgency, id),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.pending(agency, 'z'.repeat(43)),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

await test('the right password links Google and signs in, and the link cannot be used twice', async () => {
  const f = setup();
  const id = await pending(f);
  const result = await f.process.link(agency, id, 'the right password', 'req-link');
  assert.equal(result.locale, 'bn');
  assert.equal(result.accessToken, 'access');
  assert.equal(f.links.length, 1);
  assert.equal(f.links[0]!.subject, 'google-sub-1');
  assert.equal(f.sessionsStarted.length, 1);
  await assert.rejects(
    () => f.process.link(agency, id, 'the right password', 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.links.length, 1);
});

await test('a wrong password links nothing, counts toward the pause, and lets the person try again', async () => {
  const f = setup();
  const id = await pending(f);
  await assert.rejects(
    () => f.process.link(agency, id, 'not it', 'r'),
    code(401, 'INVALID_CREDENTIALS'),
  );
  assert.equal(f.links.length, 0);
  assert.equal(f.wrongPasswords(), 1);
  // The pending link survives a mistyped password.
  assert.deepEqual(await f.process.pending(agency, id), { email: 'rahim@example.com' });
  assert.equal(
    (await f.process.link(agency, id, 'the right password', 'r')).sessionId.length > 0,
    true,
  );
});

await test('while sign-in is paused for that email, linking is paused too', async () => {
  const f = setup();
  const id = await pending(f);
  f.pause();
  await assert.rejects(
    () => f.process.link(agency, id, 'the right password', 'r'),
    (error: unknown) =>
      error instanceof AppError && error.status === 429 && error.code === 'TOO_MANY_ATTEMPTS',
  );
  assert.equal(f.links.length, 0);
});

await test('if the account turns out to have a Google identity already, the link is refused', async () => {
  const f = setup();
  const id = await pending(f);
  f.refuseLink();
  await assert.rejects(
    () => f.process.link(agency, id, 'the right password', 'r'),
    code(409, 'GOOGLE_ALREADY_LINKED'),
  );
  assert.equal(f.sessionsStarted.length, 0);
});

await test('a new Google attempt for the same account cancels the older pending link', async () => {
  const f = setup();
  const first = await pending(f);
  const second = await f.run();
  assert.equal(second.kind, 'link');
  await assert.rejects(
    () => f.process.pending(agency, first),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
});

await test('a failure after the attempt was read carries the language the person was reading, with the same status and code', async () => {
  const f = setup();
  f.setProfile(profile({ emailVerified: false }));
  await assert.rejects(
    () => f.run({ ...f.login, locale: 'en' }),
    (error: unknown) =>
      error instanceof GoogleSignInError &&
      error.locale === 'en' &&
      error.status === 403 &&
      error.code === 'GOOGLE_EMAIL_UNVERIFIED',
  );
  f.setProfile(new AppError(401, 'GOOGLE_AUTH_FAILED'));
  await assert.rejects(
    () => f.run({ ...f.registerInput, locale: 'bn' }),
    (error: unknown) =>
      error instanceof GoogleSignInError &&
      error.locale === 'bn' &&
      error.code === 'GOOGLE_AUTH_FAILED',
  );
});

await test('an attempt that cannot be read has no language to carry', async () => {
  const f = setup();
  await assert.rejects(
    () => f.process.complete(agency, 'x'.repeat(43), callback, 'r'),
    (error: unknown) =>
      error instanceof AppError &&
      !(error instanceof GoogleSignInError) &&
      error.code === 'OAUTH_CHALLENGE_EXPIRED',
  );
});

// ---- a login that found no account: agree to the terms, then the account is created ----

async function waitingToSignUp(
  f: ReturnType<typeof setup>,
  over: Parameters<typeof f.run>[0] = f.login,
) {
  const outcome = await f.run(over);
  assert.equal(outcome.kind, 'signup');
  return outcome.kind === 'signup' ? outcome.pendingId : '';
}
const agreed = {
  acceptTerms: true,
  acceptPrivacy: true,
  onBehalfOfOther: false,
  confirmAuthority: false,
};

await test('the page that asks for the agreements is told who Google says is signing up, and nothing secret', async () => {
  const f = setup();
  const id = await waitingToSignUp(f);
  assert.deepEqual(await f.process.pendingSignup(agency, id), {
    email: 'rahim@example.com',
    name: 'Rahim Uddin',
  });
  const everything = JSON.stringify([...f.stored.values()]);
  assert.equal(everything.includes('google-sub-1'), false);
  assert.equal(everything.includes('rahim@example.com'), false);
});

await test('the pending sign-up is unknown to another agency and to a made-up id', async () => {
  const f = setup();
  const id = await waitingToSignUp(f);
  await assert.rejects(
    () => f.process.pendingSignup(otherAgency, id),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.pendingSignup(agency, 'z'.repeat(43)),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.signup(otherAgency, id, agreed, 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.members.length, 0);
});

await test('agreeing creates the member from what Google vouched for, records the versions agreed to, and signs in', async () => {
  const f = setup();
  const id = await waitingToSignUp(f, { ...f.login, locale: 'en' });
  const result = await f.process.signup(agency, id, agreed, 'req-s');
  assert.equal(result.locale, 'en');
  assert.equal(result.accessToken, 'access');
  assert.equal(f.members.length, 1);
  assert.equal(f.members[0]!.account.role, 'member');
  assert.equal(f.members[0]!.email, 'rahim@example.com');
  assert.equal(f.registered[0]!.identity.displayName, 'Rahim Uddin');
  assert.equal(f.registered[0]!.identity.subject, 'google-sub-1');
  assert.equal(f.registered[0]!.registration.locale, 'en');
  assert.equal(f.registered[0]!.registration.onBehalfOfOther, false);
  assert.ok(f.registered[0]!.registration.termsVersion.length > 0);
  assert.equal(f.links.length, 1);
  assert.equal(f.sessionsStarted.length, 1);
});

await test('registering for someone else is passed on', async () => {
  const f = setup();
  const id = await waitingToSignUp(f);
  await f.process.signup(
    agency,
    id,
    { ...agreed, onBehalfOfOther: true, confirmAuthority: true },
    'r',
  );
  assert.equal(f.registered[0]!.registration.onBehalfOfOther, true);
});

await test('the step can be used once, so pressing twice cannot create two accounts', async () => {
  const f = setup();
  const id = await waitingToSignUp(f);
  await f.process.signup(agency, id, agreed, 'r');
  await assert.rejects(
    () => f.process.signup(agency, id, agreed, 'r'),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  await assert.rejects(
    () => f.process.pendingSignup(agency, id),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal(f.members.length, 1);
});

await test('if an account for the email appeared in the meantime, nothing is created and the person starts again', async () => {
  const f = setup();
  const id = await waitingToSignUp(f);
  f.addMember();
  await assert.rejects(() => f.process.signup(agency, id, agreed, 'r'), code(409, 'GOOGLE_RETRY'));
  assert.equal(f.members.length, 1);
  assert.equal(f.registered.length, 0);
  assert.equal(f.sessionsStarted.length, 0);
});

await test('a newer Google attempt by the same person cancels the older pending sign-up', async () => {
  const f = setup();
  const first = await waitingToSignUp(f);
  const second = await waitingToSignUp(f);
  await assert.rejects(
    () => f.process.pendingSignup(agency, first),
    code(400, 'LINK_INVALID_OR_EXPIRED'),
  );
  assert.equal((await f.process.pendingSignup(agency, second)).email, 'rahim@example.com');
});

await test('a person whose email already has an account is sent to the password step, not to agree and create', async () => {
  const f = setup();
  f.addMember();
  const outcome = await f.run(f.login);
  assert.equal(outcome.kind, 'link');
});
