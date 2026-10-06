import type { ProposedChanges, ProfileData } from '../../../bo/profile.js';
import type { QueueItem } from '../../../bo/review.js';
import { queueItemRow, reviewDetailRow } from '../../entity/review.js';

export function mapQueueItem(value: unknown): QueueItem {
  const row = queueItemRow.parse(value);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    position: row.position,
    profile: {
      id: row.profile_id,
      memberCode: row.member_code,
      fullName: row.full_name,
      serviceMode: row.service_mode,
      assignedAgentId: row.assigned_agent_id,
    },
    submittedBy: { id: row.submitted_by_account_id, displayName: row.submitter_name },
    photoId: row.photo_id,
  };
}

/** A request as stored, with its decision. What was proposed is kept as the database holds it. */
export interface ReviewRecordDetail extends QueueItem {
  baseProfileVersion: number | null;
  /** The whole content for a first submission, only the changed fields for an update, else null. */
  proposed: ProposedChanges | ProfileData | null;
  reviewerNotes: string | null;
  reviewedAt: string | null;
  decidedBy: { id: string; displayName: string } | null;
}

export function mapReviewDetail(value: unknown): ReviewRecordDetail {
  const row = reviewDetailRow.parse(value);
  return {
    ...mapQueueItem(row),
    baseProfileVersion: row.base_profile_version,
    proposed: row.proposed_changes as ProposedChanges | ProfileData | null,
    reviewerNotes: row.reviewer_notes,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    decidedBy:
      row.reviewer_account_id && row.reviewer_name
        ? { id: row.reviewer_account_id, displayName: row.reviewer_name }
        : null,
  };
}
