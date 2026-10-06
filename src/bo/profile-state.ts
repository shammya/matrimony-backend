import type { ProfileData, ProfileStatus, ProposedChanges } from './profile.js';

export const PROFILE_STATUSES = [
  'draft',
  'pending_review',
  'rejected',
  'active',
  'paused',
  'matched',
  'closed',
] as const satisfies readonly ProfileStatus[];

/** A stored profile: its state, version and the content its owner can edit. */
export interface ProfileRecord {
  id: string;
  memberCode: string;
  status: ProfileStatus;
  /** A member who runs their own profile, or a client whose profile the agency runs. */
  serviceMode: 'self_service' | 'assisted';
  /** The member's account. Null for an assisted client, who has no login. */
  ownerId: string | null;
  /** The agent responsible for this profile, if one has been assigned. */
  assignedAgentId: string | null;
  /** Rises on every change. A request made against an older version is out of date. */
  version: number;
  /** Worked out from the district, never sent by the client. */
  currentDivisionCode: string | null;
  createdAt: string;
  updatedAt: string;
  data: ProfileData;
}

export type ReviewKind = 'initial_submission' | 'field_update';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ReviewRecord {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  baseProfileVersion: number | null;
  proposedChanges: ProposedChanges | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** Everything a member sees about their own profile. */
export interface OwnProfileState {
  profile: ProfileRecord | null;
  pendingReview: ReviewRecord | null;
  lastDecision: ReviewRecord | null;
}
