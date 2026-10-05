import type { WorkflowEvent } from '../../bo/event.js';
import type { ProfileData, ProposedChanges } from '../../bo/profile.js';
import type {
  OwnProfileState,
  ProfileRecord,
  ReviewKind,
  ReviewRecord,
} from '../../bo/profile-state.js';
import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { ProfileRepository } from '../raw/repository/profile-repository.js';

/**
 * Everything a profile workflow may do, bound to one open transaction. The business rules run
 * between these calls, inside the same transaction, so a rule that checks the current state
 * cannot be overtaken by a concurrent request, and an event is stored together with its change.
 */
export interface ProfileUnit {
  /** `lock` holds the row until the transaction ends, for anything that changes it. */
  findByOwner(agencyId: string, ownerId: string, lock: boolean): Promise<ProfileRecord | null>;
  /** The new profile's id, or null when the owner already has one or the code is taken. */
  create(
    agencyId: string,
    ownerId: string,
    memberCode: string,
    data: ProfileData,
  ): Promise<string | null>;
  saveContent(
    agencyId: string,
    profileId: string,
    status: ProfileRecord['status'],
    data: ProfileData,
  ): Promise<void>;
  setStatus(agencyId: string, profileId: string, status: ProfileRecord['status']): Promise<void>;
  insertReview(
    agencyId: string,
    profileId: string,
    submittedBy: string,
    kind: ReviewKind,
    baseVersion: number,
    changes: ProposedChanges | ProfileData,
  ): Promise<ReviewRecord>;
  pendingReview(agencyId: string, profileId: string): Promise<ReviewRecord | null>;
  cancelReview(agencyId: string, reviewId: string): Promise<void>;
  lastDecision(agencyId: string, profileId: string): Promise<ReviewRecord | null>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class ProfileDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: ProfileRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: ProfileUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): ProfileUnit {
    const repo = this.repository;
    return {
      findByOwner: (agencyId, ownerId, lock) => repo.findByOwner(tx, agencyId, ownerId, lock),
      create: (agencyId, ownerId, memberCode, data) =>
        repo.create(tx, agencyId, ownerId, memberCode, data),
      saveContent: (agencyId, profileId, status, data) =>
        repo.saveContent(tx, agencyId, profileId, status, data),
      setStatus: (agencyId, profileId, status) => repo.setStatus(tx, agencyId, profileId, status),
      insertReview: (agencyId, profileId, by, kind, baseVersion, changes) =>
        repo.insertReview(tx, agencyId, profileId, by, kind, baseVersion, changes),
      pendingReview: (agencyId, profileId) => repo.pendingReview(tx, agencyId, profileId),
      cancelReview: (agencyId, reviewId) => repo.cancelReview(tx, agencyId, reviewId),
      lastDecision: (agencyId, profileId) => repo.lastDecision(tx, agencyId, profileId),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }

  /** The member's whole picture in one consistent read. */
  read(agencyId: string, ownerId: string): Promise<OwnProfileState> {
    return this.inTransaction(agencyId, async (unit) => {
      const profile = await unit.findByOwner(agencyId, ownerId, false);
      if (!profile) return { profile: null, pendingReview: null, lastDecision: null };
      const [pendingReview, lastDecision] = await Promise.all([
        unit.pendingReview(agencyId, profile.id),
        unit.lastDecision(agencyId, profile.id),
      ]);
      return { profile, pendingReview, lastDecision };
    });
  }
}
