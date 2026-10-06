import { z } from 'zod';
import { QUEUE_KINDS, REVIEW_STATUSES } from '../../bo/review.js';

export const queueItemRow = z.object({
  id: z.uuid(),
  kind: z.enum(QUEUE_KINDS),
  status: z.enum(REVIEW_STATUSES),
  created_at: z.date(),
  position: z.string(),
  photo_id: z.uuid().nullable(),
  submitted_by_account_id: z.uuid(),
  submitter_name: z.string(),
  profile_id: z.uuid(),
  member_code: z.string(),
  full_name: z.string(),
  service_mode: z.enum(['self_service', 'assisted']),
  assigned_agent_id: z.uuid().nullable(),
});

export const reviewDetailRow = queueItemRow.extend({
  base_profile_version: z.number().int().nullable(),
  proposed_changes: z.record(z.string(), z.unknown()).nullable(),
  reviewer_notes: z.string().nullable(),
  reviewed_at: z.date().nullable(),
  reviewer_account_id: z.uuid().nullable(),
  reviewer_name: z.string().nullable(),
});

export const photoFileRow = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  storage_key: z.string(),
  status: z.enum(['staged', 'published', 'removed']),
});

export const countRow = z.object({ n: z.number().int() });
