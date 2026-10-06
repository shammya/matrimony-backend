import { z } from 'zod';
import type { FieldChange } from './profile.js';

/**
 * The approval queue: requests waiting for a reviewer (a new profile, a change to a published
 * profile, a new photo), and the reviewer's decision on each. Validation messages are stable keys,
 * as for the profile.
 */
export const QUEUE_KINDS = ['initial_submission', 'field_update', 'photo_add'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MAX_NOTE = 1000;
export const DEFAULT_PAGE = 20;
export const MAX_PAGE = 50;

const fail = (key: string) => ({ error: key });

const cursorSchema = z.object({ t: z.iso.datetime(), i: z.uuid() });
export interface Cursor {
  createdAt: string;
  id: string;
}

/** An opaque position in the queue, so a client can ask for "the next page" without understanding it. */
export const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify({ t: cursor.createdAt, i: cursor.id })).toString('base64url');

export function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { createdAt: parsed.t, id: parsed.i };
  } catch {
    return null;
  }
}

export const listQuerySchema = z
  .object({
    status: z.enum(REVIEW_STATUSES, fail('invalidOption')).default('pending'),
    kind: z.enum(QUEUE_KINDS, fail('invalidOption')).optional(),
    limit: z.coerce
      .number(fail('invalid'))
      .int(fail('invalid'))
      .min(1, fail('outOfRange'))
      .max(MAX_PAGE, fail('outOfRange'))
      .default(DEFAULT_PAGE),
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ListQuery = z.output<typeof listQuerySchema>;

const text = z.string(fail('invalid')).trim().max(MAX_NOTE, fail('tooLong'));
const optionalNote = text.optional();
// A missing note is a missing note, not an "invalid" one: the reviewer is told it is required.
const requiredNote = z
  .string(fail('required'))
  .trim()
  .min(1, fail('required'))
  .max(MAX_NOTE, fail('tooLong'));

/** Approving: the reviewer may leave a note, and says which version of the profile they looked at. */
export const approveInputSchema = z
  .object({
    note: optionalNote,
    profileVersion: z
      .number(fail('invalid'))
      .int(fail('invalid'))
      .positive(fail('invalid'))
      .optional(),
  })
  .strict();
export type ApproveInput = z.output<typeof approveInputSchema>;

/** Rejecting needs a reason: the member sees it and knows what to fix. */
export const rejectInputSchema = z.object({ note: requiredNote }).strict();
export type RejectInput = z.output<typeof rejectInputSchema>;

export interface QueueItem {
  id: string;
  /** Where this request sits in the queue, to the microsecond. Used only to build the next page's cursor. */
  position: string;
  kind: QueueKind;
  status: ReviewStatus;
  createdAt: string;
  profile: {
    id: string;
    memberCode: string;
    fullName: string;
    serviceMode: 'self_service' | 'assisted';
    assignedAgentId: string | null;
  };
  submittedBy: { id: string; displayName: string };
  photoId: string | null;
}

export interface QueuePage {
  items: QueueItem[];
  /** Pass as `after` for the next page. Null when this is the last page. */
  next: string | null;
}

export interface ReviewDetail extends QueueItem {
  baseProfileVersion: number | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  decidedBy: { id: string; displayName: string } | null;
  profileDetail: { status: string; version: number };
  /** What the reviewer is asked to look at. */
  changes: FieldChange[];
  /** True when the profile has changed since the request was made: it can no longer be approved. */
  stale: boolean;
  /** Whether this reviewer may approve or reject it now. */
  canDecide: boolean;
  /** Why not, when `canDecide` is false. */
  blockedBy: 'decided' | 'cancelled' | 'stale' | 'own_submission' | null;
}
