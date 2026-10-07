import { z } from 'zod';
import { accountRow } from './identity.js';

export const credentialLookupRow = accountRow.extend({
  status: z.enum(['invited', 'active', 'disabled']),
  email: z.string().nullable(),
  locale: z.enum(['bn', 'en']),
  password_hash: z.string().nullable(),
});
