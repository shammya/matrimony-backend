import { z } from 'zod';

export const clientListRow = z.object({
  id: z.uuid(),
  member_code: z.string(),
  full_name: z.string(),
  status: z.string(),
  service_mode: z.enum(['self_service', 'assisted']),
  version: z.number().int(),
  updated_at: z.date(),
  position: z.string(),
  assigned_agent_id: z.uuid().nullable(),
  agent_name: z.string().nullable(),
  current_district_code: z.string().nullable(),
  has_pending_review: z.boolean(),
});

export const clientMetaRow = z.object({
  service_mode: z.enum(['self_service', 'assisted']),
  assigned_agent_id: z.uuid().nullable(),
  agent_name: z.string().nullable(),
  owner_account_id: z.uuid().nullable(),
  owner_name: z.string().nullable(),
});

export const staffRow = z.object({
  id: z.uuid(),
  display_name: z.string(),
  email: z.string().nullable(),
  role: z.enum(['admin', 'agent']),
  status: z.enum(['invited', 'active', 'disabled']),
});
