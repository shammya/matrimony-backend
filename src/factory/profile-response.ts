import type { OwnProfileState, ReviewRecord } from '../bo/profile-state.js';

const review = (r: ReviewRecord | null) =>
  r && {
    id: r.id,
    kind: r.kind,
    status: r.status,
    baseProfileVersion: r.baseProfileVersion,
    proposedChanges: r.proposedChanges,
    reviewerNotes: r.reviewerNotes,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
  };

/** The member's own profile as the API returns it. Fields are listed so nothing new leaks by accident. */
export function profileResponse(state: OwnProfileState) {
  const p = state.profile;
  return {
    profile: p && {
      id: p.id,
      memberCode: p.memberCode,
      status: p.status,
      version: p.version,
      currentDivisionCode: p.currentDivisionCode,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      data: p.data,
    },
    pendingReview: review(state.pendingReview),
    lastDecision: review(state.lastDecision),
  };
}
