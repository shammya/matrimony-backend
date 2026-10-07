import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodType } from 'zod';
import {
  forgotPasswordInputSchema,
  loginInputSchema,
  newPasswordSchema,
  resetPasswordInputSchema,
  verifyEmailInputSchema,
} from '../src/bo/credentials.js';
import { registrationInputSchema } from '../src/bo/registration.js';
import { fieldProblems } from '../src/io/http/validation.js';

const codes = (schema: ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? [] : fieldProblems(result.error).map((p) => `${p.path}:${p.code}`);
};

await test('a new password has to be long enough, not too long, and not a well-known one', () => {
  assert.equal(newPasswordSchema.safeParse('a long enough one').success, true);
  assert.deepEqual(codes(newPasswordSchema, 'short'), [':tooShort']);
  assert.deepEqual(codes(newPasswordSchema, 'x'.repeat(129)), [':tooLong']);
  assert.equal(newPasswordSchema.safeParse('x'.repeat(10) + 'ab').success, false);
  for (const weak of [
    'password123',
    'PASSWORD123',
    '1234567890',
    'qwertyuiop',
    '0000000000',
    'aaaaaaaaaaaa',
  ])
    assert.deepEqual(codes(newPasswordSchema, weak), [':tooWeak'], weak);
});

await test('length counts what a person sees, so Bengali and emoji are not penalised', () => {
  // Ten Bengali letters are more than ten UTF-16 units; nine are well under the limit either way.
  assert.equal(newPasswordSchema.safeParse('আমারসোনারবাংলা').success, true);
  assert.deepEqual(codes(newPasswordSchema, 'আমারসোনার'), [':tooShort']);
  assert.equal(newPasswordSchema.safeParse('🔒'.repeat(5) + 'ab c d e').success, true);
});

await test('a password is normalised, so look-alike forms are one password', () => {
  // Full-width "ｐａｓｓｗｏｒｄ" becomes plain ASCII under NFKC.
  assert.equal(newPasswordSchema.parse('ｓｅｃｒｅｔ－ｐａｓｓ'), 'secret-pass');
});

await test('a missing or non-text password is "required", never a crash', () => {
  assert.deepEqual(codes(newPasswordSchema, undefined), [':required']);
  assert.deepEqual(codes(newPasswordSchema, 12345678901), [':required']);
});

await test('an email is trimmed and lower-cased, and must look like an email', () => {
  const parsed = forgotPasswordInputSchema.parse({ email: '  Rahim@Example.COM ' });
  assert.equal(parsed.email, 'rahim@example.com');
  for (const bad of ['', 'no-at-sign', 'a@', '@b.com', 'a b@c.com'])
    assert.equal(forgotPasswordInputSchema.safeParse({ email: bad }).success, false, bad);
  assert.deepEqual(codes(forgotPasswordInputSchema, { email: 'x'.repeat(250) + '@e.com' }), [
    'email:tooLong',
  ]);
});

await test('sign-in does not apply password strength rules, so an older password still works', () => {
  assert.equal(loginInputSchema.safeParse({ email: 'a@b.com', password: 'abc' }).success, true);
  assert.deepEqual(codes(loginInputSchema, { email: 'a@b.com', password: '' }), [
    'password:required',
  ]);
  assert.deepEqual(codes(loginInputSchema, { email: 'a@b.com', password: 'x'.repeat(257) }), [
    'password:tooLong',
  ]);
});

await test('requests carry only the fields they should: extra ones are refused', () => {
  assert.equal(
    loginInputSchema.safeParse({ email: 'a@b.com', password: 'x', role: 'admin' }).success,
    false,
  );
  assert.equal(
    forgotPasswordInputSchema.safeParse({ email: 'a@b.com', agencyId: 'x' }).success,
    false,
  );
  assert.equal(verifyEmailInputSchema.safeParse({ token: 'a'.repeat(43), x: 1 }).success, false);
});

await test('a link token has the exact shape we issue: 43 URL-safe characters', () => {
  assert.equal(verifyEmailInputSchema.safeParse({ token: 'a'.repeat(43) }).success, true);
  for (const bad of [
    '',
    'a'.repeat(42),
    'a'.repeat(44),
    'a'.repeat(42) + '+',
    'a'.repeat(42) + '/',
  ])
    assert.equal(verifyEmailInputSchema.safeParse({ token: bad }).success, false, bad);
});

await test('resetting a password checks the new password against the same rules', () => {
  const token = 'b'.repeat(43);
  assert.equal(
    resetPasswordInputSchema.safeParse({ token, password: 'a fine new pass' }).success,
    true,
  );
  assert.deepEqual(codes(resetPasswordInputSchema, { token, password: 'short' }), [
    'password:tooShort',
  ]);
});

const registration = {
  email: 'Rahim@Example.com',
  password: 'a good long password',
  displayName: '  Rahim Uddin ',
  locale: 'bn',
  acceptTerms: true,
  acceptPrivacy: true,
};

await test('a registration is cleaned up and must agree to the terms and privacy text', () => {
  const parsed = registrationInputSchema.parse(registration);
  assert.equal(parsed.email, 'rahim@example.com');
  assert.equal(parsed.displayName, 'Rahim Uddin');
  assert.equal(parsed.onBehalfOfOther, false);
  assert.deepEqual(codes(registrationInputSchema, { ...registration, acceptTerms: false }), [
    'acceptTerms:required',
  ]);
  assert.deepEqual(codes(registrationInputSchema, { ...registration, acceptPrivacy: undefined }), [
    'acceptPrivacy:required',
  ]);
});

await test('a registration cannot use the email, or the part before the @, as the password', () => {
  assert.deepEqual(
    codes(registrationInputSchema, {
      ...registration,
      email: 'rahim.uddin@example.com',
      password: 'Rahim.Uddin',
    }),
    ['password:sameAsEmail'],
  );
  assert.deepEqual(
    codes(registrationInputSchema, {
      ...registration,
      email: 'longaddress@example.com',
      password: 'longaddress@example.com',
    }),
    ['password:sameAsEmail'],
  );
});

await test('a registration cannot ask for a role, a status, an agency or a phone number', () => {
  for (const extra of [
    { role: 'admin' },
    { status: 'active' },
    { agencyId: '11111111-1111-4111-8111-111111111111' },
    { phone: '+8801700000000' },
  ])
    assert.equal(registrationInputSchema.safeParse({ ...registration, ...extra }).success, false);
});

await test('registering for someone else needs the confirmation of authority', () => {
  assert.deepEqual(codes(registrationInputSchema, { ...registration, onBehalfOfOther: true }), [
    'confirmAuthority:required',
  ]);
  assert.equal(
    registrationInputSchema.safeParse({
      ...registration,
      onBehalfOfOther: true,
      confirmAuthority: true,
    }).success,
    true,
  );
});
