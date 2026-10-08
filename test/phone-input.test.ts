import { test } from 'node:test';
import type { z } from 'zod';
import assert from 'node:assert/strict';
import {
  PHONE_CODE_LENGTH,
  maskPhone,
  normalizePhone,
  phoneAttachConfirmInputSchema,
  phoneSignupInputSchema,
  phoneStartInputSchema,
  phoneVerifyInputSchema,
} from '../src/bo/phone.js';
import { loadConfig } from '../src/config/env.js';
import { fieldProblems } from '../src/io/http/validation.js';
import { env } from './fixtures.js';

const problems = (schema: z.ZodType) => (value: unknown) => {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : fieldProblems(result.error)
        .map((p) => `${p.path}:${p.code}`)
        .sort();
};

await test('a Bangladeshi mobile number is stored the same way however it is written', () => {
  for (const typed of [
    '01712345678',
    '017 1234 5678',
    '017-1234-5678',
    '8801712345678',
    '+8801712345678',
    '+880 1712 345678',
    '008801712345678',
    '(+880) 1712-345678',
    // Typed on a Bengali keyboard.
    '০১৭১২৩৪৫৬৭৮',
    '+৮৮০১৭১২৩৪৫৬৭৮',
  ])
    assert.equal(normalizePhone(typed), '+8801712345678', typed);
});

await test('numbers that cannot be a Bangladeshi mobile number are refused, not guessed', () => {
  for (const typed of [
    '',
    '017123',
    '0171234567', // one digit short
    '017123456789', // one digit long
    '01212345678', // 012 is not a mobile operator
    '+8801212345678',
    '+88021234567', // a landline
    '1712345678', // no country, no leading zero
    'abcdefghijk',
    '01712-34567x',
  ])
    assert.equal(normalizePhone(typed), null, typed);
});

await test('a number from another country needs its + and country code', () => {
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
  assert.equal(normalizePhone('0014155552671'), '+14155552671');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('4155552671'), null);
  assert.equal(normalizePhone('+0123456789'), null);
  assert.equal(normalizePhone('+1234567'), null); // too short for E.164 here
  assert.equal(normalizePhone('+1234567890123456'), null); // 16 digits
});

const start = problems(phoneStartInputSchema);

await test('asking for a code needs a number and the language, and nothing else', () => {
  assert.deepEqual(start({ phone: '01712345678', locale: 'bn', purpose: 'login' }), []);
  assert.deepEqual(start({ locale: 'bn', purpose: 'login' }), ['phone:required']);
  assert.deepEqual(start({ phone: '', locale: 'bn', purpose: 'login' }), ['phone:required']);
  assert.deepEqual(start({ phone: '12345', locale: 'bn', purpose: 'login' }), [
    'phone:invalidPhone',
  ]);
  assert.deepEqual(start({ phone: '01712345678', locale: 'fr', purpose: 'login' }), [
    'locale:invalidOption',
  ]);
  assert.notDeepEqual(
    start({ phone: '01712345678', locale: 'bn', purpose: 'login', role: 'admin' }),
    [],
  );
});

await test('the number is read as E.164 once it has been accepted', () => {
  const parsed = phoneStartInputSchema.parse({
    phone: ' 017 1234 5678 ',
    locale: 'en',
    purpose: 'login',
  });
  assert.deepEqual(parsed, { phone: '+8801712345678', locale: 'en', purpose: 'login' });
});

const verify = problems(phoneVerifyInputSchema);

await test('a code is exactly six digits, however they were typed', () => {
  assert.equal(PHONE_CODE_LENGTH, 6);
  const base = { phone: '01712345678', locale: 'bn', purpose: 'register' };
  assert.deepEqual(verify({ ...base, code: '123456' }), []);
  assert.equal(phoneVerifyInputSchema.parse({ ...base, code: ' 123 456 ' }).code, '123456');
  assert.equal(phoneVerifyInputSchema.parse({ ...base, code: '১২৩৪৫৬' }).code, '123456');
  for (const code of ['12345', '1234567', 'abcdef', '12 34 5a', '१२३४५६'])
    assert.deepEqual(verify({ ...base, code }), ['code:invalidCode'], code);
  assert.deepEqual(verify({ ...base }), ['code:required']);
  // A number, not text: refused rather than guessed.
  assert.notDeepEqual(verify({ ...base, code: 123456 }), []);
});

await test('adding a number needs the number and the code, and nothing else', () => {
  const ok = { phone: '01712345678', code: '123456' };
  assert.equal(phoneAttachConfirmInputSchema.safeParse(ok).success, true);
  assert.equal(phoneAttachConfirmInputSchema.safeParse({ ...ok, accountId: 'x' }).success, false);
});

const signup = problems(phoneSignupInputSchema);
const GOOD = 'a strong phone password';

await test('creating the account after a code needs a name and both agreements, and says which is missing', () => {
  assert.deepEqual(signup({}), ['displayName:required', 'password:required']);
  assert.deepEqual(signup({ displayName: 'Nina', password: GOOD }), [
    'acceptPrivacy:required',
    'acceptTerms:required',
  ]);
  assert.deepEqual(signup({ displayName: 'Nina', password: GOOD, acceptTerms: true }), [
    'acceptPrivacy:required',
  ]);
  assert.deepEqual(
    signup({ displayName: 'Nina', password: GOOD, acceptTerms: true, acceptPrivacy: true }),
    [],
  );
  assert.deepEqual(
    signup({ displayName: '  ', password: GOOD, acceptTerms: true, acceptPrivacy: true }),
    ['displayName:required'],
  );
  assert.deepEqual(
    signup({
      displayName: 'x'.repeat(101),
      password: GOOD,
      acceptTerms: true,
      acceptPrivacy: true,
    }),
    ['displayName:tooLong'],
  );
});

await test('registering for someone else needs the confirmation of authority at this step too', () => {
  const base = { displayName: 'Nina', password: GOOD, acceptTerms: true, acceptPrivacy: true };
  assert.deepEqual(signup({ ...base, onBehalfOfOther: true }), ['confirmAuthority:required']);
  assert.deepEqual(signup({ ...base, onBehalfOfOther: true, confirmAuthority: true }), []);
});

await test('the number, the role and the agency cannot be sent when creating the account', () => {
  const base = { displayName: 'Nina', password: GOOD, acceptTerms: true, acceptPrivacy: true };
  for (const extra of [
    { phone: '+8801712345678' },
    { role: 'admin' },
    { agencyId: 'x' },
    { email: 'a@b.com' },
  ])
    assert.notDeepEqual(signup({ ...base, ...extra }), []);
});

await test('only the ends of a number are shown on screen', () => {
  assert.equal(maskPhone('+8801712345678'), '+8801••••••678');
  assert.equal(maskPhone('+14155552671'), '+1415••••671');
  assert.equal(maskPhone('+14155552671').includes('5555'), false);
});

await test('phone sign-in is off unless a way to send the codes is set, and production refuses the development console', () => {
  assert.equal(loadConfig(env).SMS_DRIVER, undefined);
  assert.equal(loadConfig({ ...env, SMS_DRIVER: 'console' }).SMS_DRIVER, 'console');
  assert.throws(() => loadConfig({ ...env, SMS_DRIVER: 'twilio' }));
  // Everything else a production deployment needs is valid here, so only the SMS setting decides.
  const production = {
    ...env,
    NODE_ENV: 'production',
    DB_SSL: 'verify-full',
    REDIS_URL: 'rediss://redis.example:6380',
    MONGO_URL: 'mongodb+srv://user:pw@cluster.example/db',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'matrimony-private',
    MAIL_DRIVER: 'smtp',
    MAIL_FROM: 'Marriage Solution BD <no-reply@example.com>',
    SMTP_HOST: 'smtp.example.com',
  };
  assert.doesNotThrow(() => loadConfig(production));
  assert.throws(() => loadConfig({ ...production, SMS_DRIVER: 'console' }), /SMS_DRIVER/);
});

await test('the password chosen at registration follows the same rules as any new password', () => {
  const base = { displayName: 'Nina', acceptTerms: true, acceptPrivacy: true };
  assert.deepEqual(signup({ ...base, password: 'short' }), ['password:tooShort']);
  assert.deepEqual(signup({ ...base, password: 'password123' }), ['password:tooWeak']);
  assert.deepEqual(signup({ ...base, password: 'qwertyuiop' }), ['password:tooWeak']);
  assert.deepEqual(signup({ ...base, password: 'x'.repeat(129) }), ['password:tooLong']);
  assert.deepEqual(signup({ ...base, password: 'a strong phone password' }), []);
  assert.deepEqual(signup({ ...base }), ['password:required']);
});

await test('a code is asked for and checked for a purpose, and only login and register exist', () => {
  for (const purpose of ['login', 'register'])
    assert.deepEqual(start({ phone: '01712345678', locale: 'bn', purpose }), []);
  assert.deepEqual(start({ phone: '01712345678', locale: 'bn' }), ['purpose:invalidOption']);
  for (const purpose of ['signin', 'admin', '', 1, null])
    assert.deepEqual(
      start({ phone: '01712345678', locale: 'bn', purpose }),
      ['purpose:invalidOption'],
      String(purpose),
    );
  assert.deepEqual(verify({ phone: '01712345678', locale: 'bn', code: '123456' }), [
    'purpose:invalidOption',
  ]);
});

await test('the countries that may be sent a code are Bangladesh by default, and can be set', () => {
  assert.deepEqual(loadConfig(env).SMS_ALLOWED_COUNTRIES, ['880']);
  assert.deepEqual(loadConfig({ ...env, SMS_ALLOWED_COUNTRIES: '880,971' }).SMS_ALLOWED_COUNTRIES, [
    '880',
    '971',
  ]);
  for (const bad of ['', '+880', '880,', 'bd', '12345', '880 971'])
    assert.throws(() => loadConfig({ ...env, SMS_ALLOWED_COUNTRIES: bad }), bad);
});
