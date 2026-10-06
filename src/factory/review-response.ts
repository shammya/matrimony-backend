import type { QueueItem, QueuePage, ReviewDetail } from '../bo/review.js';

const item = (r: QueueItem) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  createdAt: r.createdAt,
  profile: {
    id: r.profile.id,
    memberCode: r.profile.memberCode,
    fullName: r.profile.fullName,
    serviceMode: r.profile.serviceMode,
    assignedAgentId: r.profile.assignedAgentId,
  },
  submittedBy: { id: r.submittedBy.id, displayName: r.submittedBy.displayName },
  photoId: r.photoId,
});

/** One page of the queue as the API returns it. Fields are listed so nothing leaks by accident. */
export const queuePageResponse = (page: QueuePage) => ({
  items: page.items.map(item),
  next: page.next,
});

export const reviewDetailResponse = (r: ReviewDetail) => ({
  ...item(r),
  baseProfileVersion: r.baseProfileVersion,
  reviewerNotes: r.reviewerNotes,
  reviewedAt: r.reviewedAt,
  decidedBy: r.decidedBy && { id: r.decidedBy.id, displayName: r.decidedBy.displayName },
  profileStatus: r.profileDetail.status,
  profileVersion: r.profileDetail.version,
  changes: r.changes.map((c) => ({
    path: c.path,
    before: c.before ?? null,
    after: c.after ?? null,
  })),
  stale: r.stale,
  canDecide: r.canDecide,
  blockedBy: r.blockedBy,
});
