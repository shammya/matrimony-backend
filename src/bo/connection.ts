import { z } from 'zod';
import type { MatchItem } from './matches.js';

/**
 * Connection requests and the inbox (slice 3.F, docs/features/discovery-loop.md).
 *
 * - A client asks to connect with someone in their window. Two people asking each other end as one
 *   accepted connection. A declined pair stays declined. A pending request can be withdrawn and asked
 *   again.
 * - The other person is told in their inbox. A client managed by an agent has no login, so the
 *   agent is told, and answers for them.
 * - Contact details stay private. After a connection is accepted, each person may share theirs with
 *   the other, each on their own say.
 */
const fail = (key: string) => ({ error: key });

export const CONNECTION_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** received: waiting for my answer. sent: waiting for theirs. connected: accepted. */
export const CONNECTION_BOXES = ['received', 'sent', 'connected'] as const;
export type ConnectionBox = (typeof CONNECTION_BOXES)[number];

export const MAX_CONNECTION_PAGE = 50;
export const DEFAULT_CONNECTION_PAGE = 20;

const pageSize = z.coerce
  .number(fail('invalid'))
  .int(fail('invalid'))
  .min(1, fail('outOfRange'))
  .max(MAX_CONNECTION_PAGE, fail('outOfRange'))
  .default(DEFAULT_CONNECTION_PAGE);

export const connectionListQuerySchema = z
  .object({
    box: z.enum(CONNECTION_BOXES, fail('invalidOption')).default('received'),
    limit: pageSize,
    after: z.string().max(300, fail('tooLong')).optional(),
  })
  .strict();
export type ConnectionListQuery = z.output<typeof connectionListQuerySchema>;

export const notificationQuerySchema = z
  .object({ limit: pageSize, after: z.string().max(300, fail('tooLong')).optional() })
  .strict();
export type NotificationQuery = z.output<typeof notificationQuerySchema>;

export const sendRequestSchema = z.object({ candidateId: z.uuid(fail('invalid')) }).strict();
export const respondSchema = z
  .object({ response: z.enum(['accept', 'decline'], fail('invalidOption')) })
  .strict();

/** A profile as the connection code needs it. */
export interface ProfileLite {
  id: string;
  status: string;
  serviceMode: 'self_service' | 'assisted';
  ownerId: string | null;
  assignedAgentId: string | null;
}

/** The account that is told when something happens to this profile: its owner, or the agent who looks after it. */
export const recipientOf = (profile: ProfileLite): string | null =>
  profile.serviceMode === 'self_service' ? profile.ownerId : profile.assignedAgentId;

/** A connection as stored. */
export interface ConnectionRecord {
  id: string;
  fromProfileId: string;
  toProfileId: string;
  status: ConnectionStatus;
  fromShared: boolean;
  toShared: boolean;
}

/** What happened when a client asked to connect. */
export type SendOutcome = 'requested' | 'accepted' | 'unchanged';

export interface SendResult {
  outcome: SendOutcome;
  connectionId: string;
  status: ConnectionStatus;
}

/** One connection in a list, with the other person as the viewer may see them. */
export interface ConnectionRow {
  connectionId: string;
  status: ConnectionStatus;
  direction: 'sent' | 'received';
  createdAt: string;
  respondedAt: string | null;
  iShared: boolean;
  theyShared: boolean;
  position: string;
  profile: MatchItem;
}

export interface ConnectionPage {
  items: ConnectionRow[];
  next: string | null;
}

export type NotificationKind = 'connection_request' | 'connection_accepted' | 'connection_declined';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  position: string;
  connectionId: string;
  /** The profile this is about for the recipient: their own, or the client they look after. */
  forProfileId: string;
  about: {
    profileId: string;
    memberCode: string;
    /** Null when the recipient may not see names. */
    fullName: string | null;
  };
}

export interface NotificationPage {
  items: NotificationItem[];
  next: string | null;
}

/** A connection on a client's page, for staff: who asked whom and where it stands. */
export interface StaffConnectionRow {
  connectionId: string;
  status: ConnectionStatus;
  /** From the client's side: they asked (`sent`) or the other person did (`received`). */
  direction: 'sent' | 'received';
  createdAt: string;
  respondedAt: string | null;
  /** The client has shared their contact details. */
  clientShared: boolean;
  /** The other person has shared theirs. */
  otherShared: boolean;
  other: {
    profileId: string;
    memberCode: string;
    fullName: string;
    age: number | null;
    professionCode: string | null;
    currentDistrictCode: string | null;
    serviceMode: 'self_service' | 'assisted';
  };
}
