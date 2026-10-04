import { z } from 'zod';
export const accountRow = z.object({
  id: z.uuid(),
  agency_id: z.uuid(),
  role: z.enum(['admin', 'agent', 'member']),
  display_name: z.string(),
});
export const tenantRow = z.object({
  id: z.uuid(),
  hostname: z.string(),
  name: z.string(),
  default_locale: z.string(),
  public_config: z.record(z.string(), z.unknown()),
});
