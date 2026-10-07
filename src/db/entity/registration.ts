import { z } from 'zod';
import { accountRow } from './identity.js';

export const accountWithStatusRow = accountRow.extend({
  status: z.enum(['invited', 'active', 'disabled']),
});
export const signInMethodsRow = z.object({
  email: z.string().nullable(),
  email_verified: z.boolean(),
  phone_e164: z.string().nullable(),
  phone_verified: z.boolean(),
  has_password: z.boolean(),
  google: z.boolean(),
});
export const idRow = z.object({ id: z.uuid() });
