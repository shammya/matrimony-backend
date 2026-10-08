import { z } from 'zod';
import { profileInputSchema } from './profile.js';
import { DEFAULT_PAGE, MAX_PAGE } from './review.js';

/**
 * Staff managing the profiles of the clients they look after: an assisted client (who has no
 * login, so the agency keeps their profile) and, for status and assignment only, a member who
 * runs their own. Validation messages are stable keys, as for the profile.
 */
const fail = (key: string) => ({ error: key });

export const SERVICE_MODES = ['self_service', 'assisted'] as const;
export const LIVE_STATUSES = ['active', 'paused', 'matched', 'closed'] as const;
export const ALL_STATUSES = [
  'draft',
  'pending_review',
  'rejected',
  'active',
  'paused',
  'matched',
  'closed',
] as const;

export const MAX_SEARCH = 100;

export const clientListQuerySchema = z
  .object({
    status: z.enum(ALL_STATUSES, fail('invalidOption')).optional(),
    serviceMode: z.enum(SERVICE_MODES, fail('invalidOption')).optional(),
    /** Admin only: an agent's id, or `none` for clients nobody looks after yet. */
    assignedTo: z.union([z.literal('none'), z.uuid(fail('invalid'))]).optional(),
    /** Part of a name or of a member code. */
    q: z.string(fail('invalid')).trim().max(MAX_SEARCH, fail('tooLong')).optional(),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_PAGE, fail('outOfRange'))
      .default(DEFAULT_PAGE),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ClientListQuery = z.output<typeof clientListQuerySchema>;

/** The whole content of a new client, and optionally who looks after them (admins only). */
export const clientInputSchema = (now: Date = new Date()) =>
  profileInputSchema(now).extend({ assignedAgentId: z.uuid(fail('invalid')).nullish() });
export type ClientInput = z.output<ReturnType<typeof clientInputSchema>>;

export const statusChangeSchema = z
  .object({
    status: z.enum(LIVE_STATUSES, fail('invalidOption')),
    version: z.number(fail('invalid')).int(fail('invalid')).positive(fail('invalid')),
  })
  .strict();

export const assignmentSchema = z.object({ agentId: z.uuid(fail('invalid')).nullable() }).strict();

export interface StaffRef {
  id: string;
  displayName: string;
}

export interface ClientListItem {
  id: string;
  /** Where this client sits in the list, to the microsecond. Used only to build the next page's cursor. */
  position: string;
  memberCode: string;
  fullName: string;
  status: string;
  serviceMode: 'self_service' | 'assisted';
  version: number;
  updatedAt: string;
  assignedAgent: StaffRef | null;
  districtCode: string | null;
  /** A request is waiting for review on this profile. */
  hasPendingReview: boolean;
}

export interface ClientPage {
  items: ClientListItem[];
  next: string | null;
}

export interface StaffMember extends StaffRef {
  email: string | null;
  role: 'admin' | 'agent';
  status: 'invited' | 'active' | 'disabled';
}

/** Who a profile belongs to, for the page that shows it. */
export interface ClientMeta {
  serviceMode: 'self_service' | 'assisted';
  assignedAgent: StaffRef | null;
  /** The member who runs a self-service profile. Null for an assisted client. */
  owner: StaffRef | null;
}
