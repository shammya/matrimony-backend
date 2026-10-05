import { z } from 'zod';

export const photoRow = z.object({
  id: z.uuid(),
  storage_key: z.string(),
  status: z.enum(['staged', 'published']),
  is_primary: z.boolean(),
  created_at: z.date(),
  review_status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).nullable(),
  reviewer_notes: z.string().nullable(),
});

export const profileRef = z.object({ id: z.uuid(), status: z.string() });
