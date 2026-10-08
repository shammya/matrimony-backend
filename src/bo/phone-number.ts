import { z } from 'zod';

/**
 * A phone number as the accounts table stores it. Kept apart from the rest of the phone rules so
 * that signing in (which needs a number and a password) and the phone flows can both use it.
 * Validation messages are stable keys, as elsewhere.
 */
const fail = (key: string) => ({ error: key });

/** Bengali digits (০-৯) are typed on a Bengali keyboard; the code and numbers use 0-9. */
export function asciiDigits(value: string): string {
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
