import type { WorkflowEvent } from '../../bo/event.js';
import type { ProfileData } from '../../bo/profile.js';
import type { ProfileRecord } from '../../bo/profile-state.js';
import type { Cursor, QueueItem, QueueKind, ReviewStatus } from '../../bo/review.js';
import type { Database, Transaction } from '../config/database.js';
import type { ReviewRecordDetail } from '../raw/mapper/review.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { ProfileRepository } from '../raw/repository/profile-repository.js';
import type { QueuePhoto, ReviewRepository } from '../raw/repository/review-repository.js';

/**
 * Everything the approval workflow may do, bound to one open transaction. A decision, the change
 * it makes and its event are written together or not at all, and the request and the profile it is
 * about stay locked while the rules run, so two reviewers cannot both decide the same request.
 */
export interface ReviewUnit {
  list(
    agencyId: string,
    query: {
      status: ReviewStatus;
      kind: QueueKind | undefined;
      limit: number;
      after: Cursor | null;
    },
    viewer: string | null,
  ): Promise<QueueItem[]>;
  find(agencyId: string, reviewId: string, lock: boolean): Promise<ReviewRecordDetail | null>;
  pendingCount(agencyId: string, viewer: string | null): Promise<number>;
  findProfile(agencyId: string, profileId: string, lock: boolean): Promise<ProfileRecord | null>;
  saveProfileContent(
    agencyId: string,
    profileId: string,
    status: ProfileRecord['status'],
    data: ProfileData,
  ): Promise<void>;
  setProfileStatus(
    agencyId: string,
    profileId: string,
    status: ProfileRecord['status'],
  ): Promise<void>;
  findPhoto(agencyId: string, photoId: string, lock: boolean): Promise<QueuePhoto | null>;
  publishPhoto(agencyId: string, profileId: string, photoId: string): Promise<void>;
  decide(
    agencyId: string,
    reviewId: string,
    outcome: 'approved' | 'rejected',
    reviewerId: string,
    note: string | null,
  ): Promise<boolean>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ReviewDbService {
  constructor(
    private readonly db: Database,
    private readonly reviews: ReviewRepository,
    private readonly profiles: ProfileRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: ReviewUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ReviewUnit {
    return {
      list: (agencyId, query, viewer) => this.reviews.list(tx, agencyId, query, viewer),
      find: (agencyId, reviewId, lock) => this.reviews.find(tx, agencyId, reviewId, lock),
      pendingCount: (agencyId, viewer) => this.reviews.pendingCount(tx, agencyId, viewer),
      findProfile: (agencyId, profileId, lock) =>
        this.profiles.findById(tx, agencyId, profileId, lock),
      saveProfileContent: (agencyId, profileId, status, data) =>
        this.profiles.saveContent(tx, agencyId, profileId, status, data),
      setProfileStatus: (agencyId, profileId, status) =>
        this.profiles.setStatus(tx, agencyId, profileId, status),
      findPhoto: (agencyId, photoId, lock) => this.reviews.findPhoto(tx, agencyId, photoId, lock),
      publishPhoto: (agencyId, profileId, photoId) =>
        this.reviews.publishPhoto(tx, agencyId, profileId, photoId),
      decide: (agencyId, reviewId, outcome, reviewerId, note) =>
        this.reviews.decide(tx, agencyId, reviewId, outcome, reviewerId, note),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
