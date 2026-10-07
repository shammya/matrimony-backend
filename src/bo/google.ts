import { z } from 'zod';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Starting a sign-in with Google. Registering needs the same agreements as registering with an
 * email, so they are checked before the person leaves for Google, and travel sealed with the
 * attempt. Validation messages are stable keys, as elsewhere, so the frontend can translate them.
 */
const fail = (key: string) => ({ error: key });

export const googleStartInputSchema = z
  .object({
    intent: z.enum(['login', 'register'], fail('invalidOption')),
    /** The language the person is reading, so they come back to the same one. */
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
    acceptTerms: z.boolean(fail('invalid')).default(false),
    acceptPrivacy: z.boolean(fail('invalid')).default(false),
    onBehalfOfOther: z.boolean(fail('invalid')).default(false),
    confirmAuthority: z.boolean(fail('invalid')).default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.intent !== 'register') return;
    if (!value.acceptTerms)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['acceptTerms'] });
    if (!value.acceptPrivacy)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['acceptPrivacy'] });
    if (value.onBehalfOfOther && !value.confirmAuthority)
      ctx.addIssue({ code: 'custom', message: 'required', path: ['confirmAuthority'] });
  });
export type GoogleStartInput = z.output<typeof googleStartInputSchema>;

/** What was agreed to, with the versions of the texts as they were. The name comes from Google. */
export const googleAgreementsSchema = z.object({
  onBehalfOfOther: z.boolean(),
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
});
export type GoogleAgreements = z.output<typeof googleAgreementsSchema>;

/** The sealed record of one sign-in attempt, kept for 5 minutes and used once. */
export const googleChallengeSchema = z.object({
  agencyId: z.uuid(),
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(1),
  redirectUri: z.url(),
  intent: z.enum(['login', 'register']),
  locale: z.enum(REGISTRATION_LOCALES),
  agreements: googleAgreementsSchema.optional(),
});
export type GoogleChallenge = z.output<typeof googleChallengeSchema>;

/**
 * An account that already uses the email Google vouched for. Google cannot be linked to it on the
 * email alone, so the person proves they own it with its password. Sealed, kept for 10 minutes.
 */
export const pendingGoogleLinkSchema = z.object({
  accountId: z.uuid(),
  subject: z.string().min(1),
  email: z.string().min(1),
  locale: z.enum(REGISTRATION_LOCALES),
});
export type PendingGoogleLink = z.output<typeof pendingGoogleLinkSchema>;

/**
 * A Google person with no account yet, waiting to agree to the terms before one is created for them.
 * Sealed, kept for 10 minutes. The name is Google's, tidied.
 */
export const pendingGoogleSignupSchema = z.object({
  subject: z.string().min(1),
  email: z.string().min(1),
  name: z.string().min(1).max(100),
  locale: z.enum(REGISTRATION_LOCALES),
});
export type PendingGoogleSignup = z.output<typeof pendingGoogleSignupSchema>;

/** The agreements a person gives to create the account Google already vouched for. */
export const googleSignupInputSchema = z
  .object({
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
export type GoogleSignupInput = z.output<typeof googleSignupInputSchema>;

export const googleLinkInputSchema = z
  .object({
    password: z
      .string(fail('required'))
      .min(1, fail('required'))
      .max(256, fail('tooLong'))
      .transform((value) => value.normalize('NFKC')),
  })
  .strict();

/** The name to give a new account: Google's, tidied, or the part of the email before the @. */
export function displayNameFrom(name: string | undefined, email: string): string {
  const tidy = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return tidy || email.split('@')[0]!.slice(0, 100);
}
