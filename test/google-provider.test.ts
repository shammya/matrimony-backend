import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';
import { AppError } from '../src/exception/app-error.js';
import { GoogleProvider, type GoogleAttempt } from '../src/security/google-provider.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const failed = (error: unknown) =>
  error instanceof AppError && error.status === 401 && error.code === 'GOOGLE_AUTH_FAILED';

interface Approval {
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
  key: CryptoKey;
  consumed: boolean;
}

/** A small stand-in for Google's sign-in: discovery, keys and the token endpoint. */
async function fakeGoogle() {
  const signing = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Approval>();
  let issuer = '';
  let discoveryDown = false;
  let tokenCalls = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      if (discoveryDown) return json(503, { error: 'down' });
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname.endsWith('/jwks')) return json(200, { keys: [jwk] });
    if (url.pathname.endsWith('/token') && req.method === 'POST') {
      tokenCalls++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          const approval = codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const pkceOk =
            approval &&
            createHash('sha256').update(verifier).digest('base64url') === approval.challenge;
          if (
            !approval ||
            approval.consumed ||
            !pkceOk ||
            form.get('client_id') !== CLIENT_ID ||
            form.get('client_secret') !== CLIENT_SECRET ||
            form.get('grant_type') !== 'authorization_code'
          )
            return json(400, { error: 'invalid_grant' });
          approval.consumed = true;
          const now = Math.floor(Date.now() / 1000);
          const claims = {
            iss: issuer,
            aud: CLIENT_ID,
            sub: 'google-sub-1',
            email: 'Rahim@Example.com',
            email_verified: true,
            name: 'Rahim Uddin',
            nonce: approval.nonce,
            iat: now,
            exp: now + 300,
            ...approval.claims,
          };
          const idToken = await new SignJWT(
            Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined)),
          )
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .sign(approval.key);
          json(200, {
            access_token: 'google-access',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        })();
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/google`;

  return {
    issuer,
    server,
    tokenCalls: () => tokenCalls,
    goDown: () => void (discoveryDown = true),
    comeBack: () => void (discoveryDown = false),
    /** What the person does at Google: approving the request. Returns the code Google redirects with. */
    approve(
      authorizationUrl: URL,
      over: { claims?: Record<string, unknown>; wrongKey?: boolean } = {},
    ) {
      const code = randomBytes(8).toString('hex');
      codes.set(code, {
        challenge: authorizationUrl.searchParams.get('code_challenge') ?? '',
        nonce: authorizationUrl.searchParams.get('nonce') ?? '',
        claims: over.claims ?? {},
        key: over.wrongKey ? other.privateKey : signing.privateKey,
        consumed: false,
      });
      return code;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const attemptFor = (): GoogleAttempt => ({
  state: randomBytes(32).toString('base64url'),
  nonce: randomBytes(32).toString('base64url'),
  verifier: randomBytes(32).toString('base64url'),
  redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
});

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const google = await fakeGoogle();
  t.after(google.close);
  const provider = new GoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    timeoutMs: 2000,
    issuer: google.issuer,
    allowInsecure: true,
  });
  /** A whole sign-in: start, approve at Google, come back. */
  async function signIn(
    over: Parameters<typeof google.approve>[1] = {},
    mutate?: (url: URL, attempt: GoogleAttempt) => URL,
  ) {
    const attempt = attemptFor();
    const authorizationUrl = new URL(await provider.authorize(attempt));
    const code = google.approve(authorizationUrl, over);
    const back = new URL(attempt.redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', attempt.state);
    return provider.exchange(mutate ? mutate(back, attempt) : back, attempt);
  }
  return { google, provider, signIn };
}

await test('the sign-in address asks for the right things: code flow, PKCE, state, nonce and the three scopes', async (t) => {
  const { provider } = await setup(t);
  const attempt = attemptFor();
  const url = new URL(await provider.authorize(attempt));
  const p = url.searchParams;
  // It is Google's authorization address, found by discovery.
  assert.ok(url.pathname.endsWith('/auth'));
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), attempt.redirectUri);
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('state'), attempt.state);
  assert.equal(p.get('nonce'), attempt.nonce);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(
    p.get('code_challenge'),
    createHash('sha256').update(attempt.verifier).digest('base64url'),
  );
  assert.equal(p.get('prompt'), 'select_account');
  // The verifier and the secret never go to the browser.
  assert.equal(url.href.includes(attempt.verifier), false);
  assert.equal(url.href.includes(CLIENT_SECRET), false);
});

await test("a good sign-in gives Google's stable id, the email in lower case, whether it is confirmed, and the name", async (t) => {
  const { signIn } = await setup(t);
  assert.deepEqual(await signIn(), {
    subject: 'google-sub-1',
    email: 'rahim@example.com',
    emailVerified: true,
    name: 'Rahim Uddin',
  });
});

await test('an email Google does not confirm is reported as unconfirmed, whatever the form of the flag', async (t) => {
  const { signIn } = await setup(t);
  for (const flag of [false, 'true', 1, undefined, null]) {
    const result = await signIn({ claims: { email_verified: flag } });
    assert.equal(result.emailVerified, false, String(flag));
  }
  assert.equal((await signIn({ claims: { email: undefined } })).emailVerified, false);
  assert.equal((await signIn({ claims: { email: '   ' } })).emailVerified, false);
});

await test('a missing name is simply absent', async (t) => {
  const { signIn } = await setup(t);
  assert.equal((await signIn({ claims: { name: undefined } })).name, undefined);
});

await test('a reply with the wrong state is refused', async (t) => {
  const { signIn } = await setup(t);
  await assert.rejects(
    () => signIn({}, (url) => (url.searchParams.set('state', 'forged'), url)),
    failed,
  );
});

await test('an ID token made for another sign-in attempt (wrong nonce) is refused', async (t) => {
  const { signIn } = await setup(t);
  await assert.rejects(() => signIn({ claims: { nonce: 'someone-elses-nonce' } }), failed);
});

await test('an ID token for another application, another issuer or one that has expired is refused', async (t) => {
  const { signIn } = await setup(t);
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(
    () => signIn({ claims: { aud: 'another-app.apps.googleusercontent.com' } }),
    failed,
  );
  await assert.rejects(() => signIn({ claims: { iss: 'https://evil.example' } }), failed);
  await assert.rejects(() => signIn({ claims: { iat: past - 300, exp: past } }), failed);
});

await test('an ID token signed with a key Google does not publish is refused', async (t) => {
  const { signIn } = await setup(t);
  await assert.rejects(() => signIn({ wrongKey: true }), failed);
});

await test('an ID token with no subject is refused', async (t) => {
  const { signIn } = await setup(t);
  await assert.rejects(() => signIn({ claims: { sub: undefined } }), failed);
  await assert.rejects(() => signIn({ claims: { sub: '' } }), failed);
});

await test('the person cancelling at Google, or Google reporting an error, is a failed sign-in', async (t) => {
  const { provider } = await setup(t);
  const attempt = attemptFor();
  await provider.authorize(attempt);
  const back = new URL(attempt.redirectUri);
  back.searchParams.set('error', 'access_denied');
  back.searchParams.set('state', attempt.state);
  await assert.rejects(() => provider.exchange(back, attempt), failed);
});

await test('a code that is not valid, or that has already been used, is refused by Google and so by us', async (t) => {
  const { google, provider } = await setup(t);
  const attempt = attemptFor();
  const authorizationUrl = new URL(await provider.authorize(attempt));
  const back = new URL(attempt.redirectUri);
  back.searchParams.set('state', attempt.state);

  back.searchParams.set('code', 'never-issued');
  await assert.rejects(() => provider.exchange(back, attempt), failed);

  const code = google.approve(authorizationUrl);
  back.searchParams.set('code', code);
  assert.equal((await provider.exchange(back, attempt)).subject, 'google-sub-1');
  await assert.rejects(() => provider.exchange(back, attempt), failed);
});

await test('the code only works with the verifier it was started with (PKCE)', async (t) => {
  const { google, provider } = await setup(t);
  const attempt = attemptFor();
  const code = google.approve(new URL(await provider.authorize(attempt)));
  const back = new URL(attempt.redirectUri);
  back.searchParams.set('code', code);
  back.searchParams.set('state', attempt.state);
  // Someone who intercepted the code does not have the verifier.
  await assert.rejects(
    () => provider.exchange(back, { ...attempt, verifier: 'a-guess'.padEnd(43, 'x') }),
    failed,
  );
});

await test('if Google cannot be reached the sign-in cannot start, and works again when it is back', async (t) => {
  const google = await fakeGoogle();
  t.after(google.close);
  google.goDown();
  const provider = new GoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    timeoutMs: 1000,
    issuer: google.issuer,
    allowInsecure: true,
  });
  await assert.rejects(
    () => provider.authorize(attemptFor()),
    (error: unknown) =>
      error instanceof AppError && error.status === 502 && error.code === 'GOOGLE_UNAVAILABLE',
  );
  google.comeBack();
  assert.match(await provider.authorize(attemptFor()), /code_challenge=/);
});

await test('the server can start while Google is out of reach: nothing is contacted until a sign-in', async (t) => {
  const google = await fakeGoogle();
  t.after(google.close);
  google.goDown();
  new GoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    timeoutMs: 1000,
    issuer: google.issuer,
    allowInsecure: true,
  });
  assert.equal(google.tokenCalls(), 0);
});

await test('over plain http a real deployment would refuse Google (the stand-in is allowed only in tests)', async (t) => {
  const google = await fakeGoogle();
  t.after(google.close);
  const strict = new GoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    timeoutMs: 1000,
    issuer: google.issuer,
  });
  await assert.rejects(
    () => strict.authorize(attemptFor()),
    (error: unknown) => error instanceof AppError && error.code === 'GOOGLE_UNAVAILABLE',
  );
});
