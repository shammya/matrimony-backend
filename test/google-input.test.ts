import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayNameFrom,
  googleLinkInputSchema,
  googleSignupInputSchema,
  googleStartInputSchema,
} from '../src/bo/google.js';
import { loadConfig } from '../src/config/env.js';
import { fieldProblems } from '../src/io/http/validation.js';
import { env } from './fixtures.js';

const problems = (value: unknown) => {
  const result = googleStartInputSchema.safeParse(value);
  return result.success
    ? []
    : fieldProblems(result.error)
        .map((p) => `${p.path}:${p.code}`)
        .sort();
};

await test('logging in with Google needs only the intent and the language', () => {
  assert.deepEqual(problems({ intent: 'login', locale: 'bn' }), []);
  assert.deepEqual(problems({ intent: 'login', locale: 'en', acceptTerms: false }), []);
});

await test('registering with Google needs both agreements, as an email registration does', () => {
  assert.deepEqual(problems({ intent: 'register', locale: 'bn' }), [
    'acceptPrivacy:required',
    'acceptTerms:required',
  ]);
  assert.deepEqual(
    problems({ intent: 'register', locale: 'bn', acceptTerms: true, acceptPrivacy: true }),
    [],
  );
});

await test('registering for someone else needs the confirmation of authority', () => {
  const base = { intent: 'register', locale: 'bn', acceptTerms: true, acceptPrivacy: true };
  assert.deepEqual(problems({ ...base, onBehalfOfOther: true }), ['confirmAuthority:required']);
  assert.deepEqual(problems({ ...base, onBehalfOfOther: true, confirmAuthority: true }), []);
});

await test('the intent and the language are choices from a short list, and nothing else is accepted', () => {
  assert.deepEqual(problems({ intent: 'delete', locale: 'bn' }), ['intent:invalidOption']);
  assert.deepEqual(problems({ intent: 'login', locale: 'fr' }), ['locale:invalidOption']);
  for (const extra of [{ role: 'admin' }, { email: 'a@b.com' }, { agencyId: 'x' }, { name: 'X' }])
    assert.notDeepEqual(problems({ intent: 'login', locale: 'bn', ...extra }), []);
});

await test('the password of a link is required, bounded and normalised, and nothing else is accepted', () => {
  assert.equal(googleLinkInputSchema.parse({ password: 'ｓｅｃｒｅｔ' }).password, 'secret');
  assert.equal(googleLinkInputSchema.safeParse({ password: '' }).success, false);
  assert.equal(googleLinkInputSchema.safeParse({ password: 'x'.repeat(257) }).success, false);
  assert.equal(googleLinkInputSchema.safeParse({ password: 'x', email: 'a@b.com' }).success, false);
});

await test('a new account is named from Google, tidied, or from the start of the email', () => {
  assert.equal(displayNameFrom('Rahim Uddin', 'a@b.com'), 'Rahim Uddin');
  assert.equal(displayNameFrom('  Rahim \n\t Uddin ', 'a@b.com'), 'Rahim Uddin');
  assert.equal(displayNameFrom(undefined, 'karim.b@example.com'), 'karim.b');
  assert.equal(displayNameFrom('   ', 'karim.b@example.com'), 'karim.b');
  assert.equal(displayNameFrom('x'.repeat(300), 'a@b.com').length, 100);
  assert.equal(displayNameFrom(undefined, `${'y'.repeat(200)}@example.com`).length, 100);
});

await test('Google is off unless both the client id and the secret are given', () => {
  assert.equal(loadConfig(env).GOOGLE_CLIENT_ID, undefined);
  const on = loadConfig({
    ...env,
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-x',
  });
  assert.equal(on.GOOGLE_CLIENT_ID, 'id.apps.googleusercontent.com');
  assert.throws(() => loadConfig({ ...env, GOOGLE_CLIENT_ID: 'id' }), /GOOGLE_CLIENT_SECRET/);
  assert.throws(
    () => loadConfig({ ...env, GOOGLE_CLIENT_SECRET: 'secret' }),
    /GOOGLE_CLIENT_SECRET/,
  );
});

await test('a bad configuration does not print the Google secret', () => {
  assert.throws(
    () => loadConfig({ ...env, GOOGLE_CLIENT_SECRET: 'GOCSPX-never-print-this' }),
    (error) => error instanceof Error && !error.message.includes('GOCSPX-never-print-this'),
  );
});

const signupProblems = (value: unknown) => {
  const result = googleSignupInputSchema.safeParse(value);
  return result.success
    ? []
    : fieldProblems(result.error)
        .map((p) => `${p.path}:${p.code}`)
        .sort();
};

await test('creating the account after Google needs both agreements, and says which is missing', () => {
  assert.deepEqual(signupProblems({}), ['acceptPrivacy:required', 'acceptTerms:required']);
  assert.deepEqual(signupProblems({ acceptTerms: true }), ['acceptPrivacy:required']);
  assert.deepEqual(signupProblems({ acceptTerms: true, acceptPrivacy: true }), []);
});

await test('registering for someone else needs the confirmation of authority at this step too', () => {
  const base = { acceptTerms: true, acceptPrivacy: true };
  assert.deepEqual(signupProblems({ ...base, onBehalfOfOther: true }), [
    'confirmAuthority:required',
  ]);
  assert.deepEqual(signupProblems({ ...base, onBehalfOfOther: true, confirmAuthority: true }), []);
});

await test('nothing about who the person is can be sent: no name, email, role or agency', () => {
  const base = { acceptTerms: true, acceptPrivacy: true };
  for (const extra of [
    { email: 'a@b.com' },
    { name: 'X' },
    { displayName: 'X' },
    { role: 'admin' },
    { agencyId: 'x' },
  ])
    assert.notDeepEqual(signupProblems({ ...base, ...extra }), []);
});
