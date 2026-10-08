import { z } from 'zod';

const role = z.enum(['admin', 'agent']);
const locale = z.enum(['bn', 'en']);

/** One open invitation with the name of the admin who sent it. */
export const invitationRow = z.object({
  id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  role,
  locale,
  invited_by_name: z.string(),
  created_at: z.date(),
  expires_at: z.date(),
  expired: z.boolean(),
});

/** What accepting needs to know about the invitation a link belongs to. */
export const invitationLinkRow = z.object({
  id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  role,
  locale,
});
