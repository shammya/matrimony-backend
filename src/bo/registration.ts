import { z } from 'zod';

/**
 * Registration of a new member. Only members register themselves; agents and admins are
 * created by an admin. The phone number is not part of this input: it is entered at the
 * identity provider, which verifies it with a one-time code, and read back from the provider.
 *
 * Validation messages are stable keys, as for the profile, so the frontend can translate them.
 */

/**
 * The versions of the terms and privacy texts a person accepts. Each acceptance is stored with
 * the version, so it is clear what was agreed to. These are development drafts: change the
 * version whenever the real text is published or revised.
 */
export const TERMS_VERSION = 'draft-2026-10';
export const PRIVACY_VERSION = 'draft-2026-10';

export const REGISTRATION_LOCALES = ['bn', 'en'] as const;

const fail = (key: string) => ({ error: key });

export const registrationInputSchema = z
  .object({
    displayName: z
      .string(fail('required'))
      .trim()
      .min(1, fail('required'))
      .max(100, fail('tooLong')),
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    acceptTerms: z.literal(true, fail('required')),
    acceptPrivacy: z.literal(true, fail('required')),
    /** The person is registering for a son, daughter, sibling or relative, not for themselves. */
    onBehalfOfOther: z.boolean(fail('invalid')).default(false),
    /** Needed when registering for someone else: they confirm they have that person's permission. */
    confirmAuthority: z.boolean(fail('invalid')).default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.onBehalfOfOther && !value.confirmAuthority) {
      ctx.addIssue({ code: 'custom', message: 'required', path: ['confirmAuthority'] });
    }
  });

export type RegistrationInput = z.output<typeof registrationInputSchema>;

/** What is kept with the login attempt until the provider has verified the phone. */
export const registrationSchema = z.object({
  displayName: z.string().min(1).max(100),
  locale: z.enum(REGISTRATION_LOCALES),
  onBehalfOfOther: z.boolean(),
});
export type Registration = z.output<typeof registrationSchema>;

export function toRegistration(input: RegistrationInput): Registration {
  return {
    displayName: input.displayName,
    locale: input.locale,
    onBehalfOfOther: input.onBehalfOfOther,
  };
}

/** A phone number as the accounts table stores it (E.164). */
export const PHONE_E164 = /^\+[1-9][0-9]{7,14}$/;

export type ConsentPurpose = 'terms' | 'privacy' | 'profile_representation';

export interface ConsentRecord {
  purpose: ConsentPurpose;
  documentVersion: string;
}

/** The acceptances to record for a registration. Representing someone else is its own consent. */
export function consentsFor(registration: Registration): ConsentRecord[] {
  const records: ConsentRecord[] = [
    { purpose: 'terms', documentVersion: TERMS_VERSION },
    { purpose: 'privacy', documentVersion: PRIVACY_VERSION },
  ];
  if (registration.onBehalfOfOther) {
    // The authority statement has no document of its own, so it carries the terms' version.
    records.push({ purpose: 'profile_representation', documentVersion: TERMS_VERSION });
  }
  return records;
}
