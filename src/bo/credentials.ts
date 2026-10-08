import { z } from 'zod';
import { phoneSchema } from './phone-number.js';

/**
 * What a person types to register, sign in or recover access, and the rules for a password.
 *
 * Validation messages are stable keys (such as "tooShort"), as for the profile, so the frontend
 * can show them in Bengali or English. They never include the value that was entered.
 */
const fail = (key: string) => ({ error: key });

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
/** Upper bound for what login accepts, so an oversized input cannot make hashing expensive. */
const LOGIN_PASSWORD_MAX_LENGTH = 256;

/**
 * Passwords people choose most often. NIST asks services to refuse these. It is a short list on
 * purpose: it stops the obvious, while length does the real work. A larger breached-password
 * check could be added later.
 */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  '12345678910',
  '123456789012',
  '1234512345',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'qwertyuiop',
  'qwerty12345',
  'qwerty123456',
  'abcdefghij',
  'abcd123456',
  'iloveyou12',
  'iloveyou123',
  'welcome123',
  'welcome1234',
  'letmein1234',
  'admin12345',
  'admin123456',
  'administrator',
  'changeme123',
  'bangladesh1',
  'bangladesh123',
  'dhaka123456',
  'matrimony1',
  'matrimony123',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'asdfghjkl1',
  'asdfghjkl123',
  'zxcvbnm123',
  '0000000000',
  '1111111111',
  '9876543210',
]);

/** NFKC makes visually identical text (for example full-width letters) the same password. */
export const normalizePassword = (value: string) => value.normalize('NFKC');

const passwordPolicy = z.string().superRefine((value, ctx) => {
  // Counted in characters a person sees, not UTF-16 units, so Bengali and emoji are not penalised.
  const length = [...value].length;
  if (length < PASSWORD_MIN_LENGTH) ctx.addIssue({ code: 'custom', message: 'tooShort' });
  else if (length > PASSWORD_MAX_LENGTH) ctx.addIssue({ code: 'custom', message: 'tooLong' });
  else if (COMMON_PASSWORDS.has(value.toLowerCase()) || new Set(value).size < 5)
    ctx.addIssue({ code: 'custom', message: 'tooWeak' });
});

/** A new password: the rules above apply. */
export const newPasswordSchema = z
  .string(fail('required'))
  .transform(normalizePassword)
  .pipe(passwordPolicy);

/** The email as the accounts table stores it: trimmed and lower-case. */
export const emailSchema = z
  .string(fail('required'))
  .trim()
  .toLowerCase()
  .min(1, fail('required'))
  .max(254, fail('tooLong'))
  .pipe(z.email(fail('invalidEmail')));

/** True when the password is just the email, or the part before the @. */
export function passwordMatchesEmail(password: string, email: string): boolean {
  const lower = password.toLowerCase();
  return lower === email || lower === email.split('@')[0];
}

/**
 * Signing in with a password: an email, or a phone number, with the password. Exactly one of
 * the two. Which account it is, and whether it has a password, is never told apart in the answer.
 */
export const loginInputSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    // No strength rules here: an older, weaker password must still be able to sign in.
    password: z
      .string(fail('required'))
      .min(1, fail('required'))
      .max(LOGIN_PASSWORD_MAX_LENGTH, fail('tooLong'))
      .transform(normalizePassword),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.email === undefined && value.phone === undefined)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['email'] });
    if (value.email !== undefined && value.phone !== undefined)
      ctx.addIssue({ code: 'custom', message: 'invalid', path: ['phone'] });
  });
export type LoginInput = z.output<typeof loginInputSchema>;

/** The one-time secret in an emailed link: 32 random bytes, base64url. */
export const oneTimeTokenSchema = z
  .string(fail('invalid'))
  .regex(/^[A-Za-z0-9_-]{43}$/, fail('invalid'));

export const verifyEmailInputSchema = z.object({ token: oneTimeTokenSchema }).strict();

export const forgotPasswordInputSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordInputSchema = z
  .object({ token: oneTimeTokenSchema, password: newPasswordSchema })
  .strict();
