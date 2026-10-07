import { z } from 'zod';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Signing in and registering with a phone number and a code sent by SMS. Validation messages are
 * stable keys, as elsewhere, so the frontend can translate them. They never include the value that
 * was entered.
 */
const fail = (key: string) => ({ error: key });

/** Digits in a code. Six is what people expect from an SMS code, and it is short enough to type. */
export const PHONE_CODE_LENGTH = 6;

/** Bengali digits (০-৯) are typed on a Bengali keyboard; the code and numbers use 0-9. */
function asciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)));
}

/**
 * The number as the accounts table stores it: E.164 (`+` and the country code, no spaces).
 * Bangladeshi mobile numbers may be written `01712345678`, `8801712345678` or `+8801712345678`.
 * Anything else needs the `+` and its country code, so a number is never guessed to belong to a
 * country.
 */
export function normalizePhone(input: string): string | null {
  const typed = asciiDigits(input).replace(/[\s().-]/g, '');
  let e164: string;
  if (typed.startsWith('+')) e164 = typed;
  else if (typed.startsWith('00')) e164 = `+${typed.slice(2)}`;
  else if (/^01[3-9][0-9]{8}$/.test(typed)) e164 = `+88${typed}`;
  else if (/^8801[3-9][0-9]{8}$/.test(typed)) e164 = `+${typed}`;
  else return null;
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) return null;
  // Bangladesh has fixed mobile numbers: +880, then 1, then an operator digit 3-9 and 8 more digits.
  if (e164.startsWith('+880') && !/^\+8801[3-9][0-9]{8}$/.test(e164)) return null;
  return e164;
}

export const phoneSchema = z
  .string(fail('required'))
  .trim()
  .min(1, fail('required'))
  .max(40, fail('tooLong'))
  .transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'invalidPhone' });
      return z.NEVER;
    }
    return phone;
  });

export const phoneCodeSchema = z
  .string(fail('required'))
  .trim()
  .min(1, fail('required'))
  .transform((value) => asciiDigits(value).replace(/\s/g, ''))
  .pipe(z.string().regex(new RegExp(`^[0-9]{${PHONE_CODE_LENGTH}}$`), fail('invalidCode')));

/** Asking for a code. The same request serves signing in and registering. */
export const phoneStartInputSchema = z
  .object({
    phone: phoneSchema,
    /** The language the person is reading, for the text message and the pages that follow. */
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type PhoneStartInput = z.output<typeof phoneStartInputSchema>;

export const phoneVerifyInputSchema = z
  .object({
    phone: phoneSchema,
    code: phoneCodeSchema,
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type PhoneVerifyInput = z.output<typeof phoneVerifyInputSchema>;

/**
 * What a person gives to create the account after proving their number. The number comes from the
 * proof, never from this request. The name is theirs to give, because a phone does not carry one.
 */
export const phoneSignupInputSchema = z
  .object({
    displayName: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(100, fail('tooLong')),
    acceptTerms: z.boolean(fail('invalid')).default(false),
    acceptPrivacy: z.boolean(fail('invalid')).default(false),
    onBehalfOfOther: z.boolean(fail('invalid')).default(false),
    confirmAuthority: z.boolean(fail('invalid')).default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.acceptTerms)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['acceptTerms'] });
    if (!value.acceptPrivacy)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['acceptPrivacy'] });
    if (value.onBehalfOfOther && !value.confirmAuthority)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['confirmAuthority'] });
  });
export type PhoneSignupInput = z.output<typeof phoneSignupInputSchema>;

/** A number whose code was right but that has no account yet. Sealed, kept for 10 minutes. */
export const pendingPhoneSignupSchema = z.object({
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  locale: z.enum(REGISTRATION_LOCALES),
});
export type PendingPhoneSignup = z.output<typeof pendingPhoneSignupSchema>;

/** Adding or changing the number of the signed-in account. The account is the session's. */
export const phoneAttachStartInputSchema = phoneStartInputSchema;
export const phoneAttachConfirmInputSchema = z
  .object({ phone: phoneSchema, code: phoneCodeSchema })
  .strict();

/** Hides the middle of a number for display: `+8801•••••678`. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 5)}${'•'.repeat(Math.max(0, phone.length - 8))}${phone.slice(-3)}`;
}
