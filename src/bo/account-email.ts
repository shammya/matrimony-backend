import { z } from 'zod';
import { emailSchema, newPasswordSchema } from './credentials.js';
import { phoneCodeSchema } from './phone.js';
import { REGISTRATION_LOCALES } from './registration.js';

/**
 * Adding an email to an account that has none. The signed-in member first proves it is them with a
 * code sent to their own phone, then gives the address; a link sent to it finishes the job. Which
 * account, and which phone, always come from the session, never from the request.
 */
const fail = (key: string) => ({ error: key });

/** Asking for the code that proves it is the owner. */
export const reauthStartInputSchema = z
  .object({ locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')) })
  .strict();

export const addEmailStartInputSchema = z
  .object({
    email: emailSchema,
    code: phoneCodeSchema,
    /** The language of the email and of the page its link opens. */
    locale: z.enum(REGISTRATION_LOCALES, fail('invalidOption')),
  })
  .strict();
export type AddEmailStartInput = z.output<typeof addEmailStartInputSchema>;

/** What the emailed link carries, sealed: which account the address is for, and the address. */
export const pendingAddEmailSchema = z.object({
  accountId: z.uuid(),
  email: z.string().min(1),
});

/**
 * Setting a new password while signed in, for an account that has a verified phone: the code sent
 * to that phone proves it is the owner (and not someone holding a stolen session), as for adding an
 * email. It is how a member who forgot the password gets a new one, since they may have no email.
 */
export const changePasswordInputSchema = z
  .object({ code: phoneCodeSchema, password: newPasswordSchema })
  .strict();
export type ChangePasswordInput = z.output<typeof changePasswordInputSchema>;
