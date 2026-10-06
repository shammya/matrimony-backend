import { z } from 'zod';
import { accountRow } from './identity.js';

export const accountWithStatusRow = accountRow.extend({
  status: z.enum(['invited', 'active', 'disabled']),
});
export const idRow = z.object({ id: z.uuid() });
