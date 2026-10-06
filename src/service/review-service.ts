import { randomUUID } from 'node:crypto';
import { canReview, isStaff, mayDecideOwn } from '../bo/access.js';
import type { WorkflowEvent } from '../bo/event.js';
import {
  applyChanges,
  describeChanges,
  describeContent,
  missingRequired,
  type FieldChange,
  type ProfileData,
  type ProposedChanges,
} from '../bo/profile.js';
import {
  decodeCursor,
  encodeCursor,
  type ApproveInput,
  type ListQuery,
  type QueuePage,
  type RejectInput,
  type ReviewDetail,
} from '../bo/review.js';
import type { ReviewRecordDetail } from '../db/raw/mapper/review.js';
import type { ReviewDbService, ReviewUnit } from '../db/service/review-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<
  WorkflowEvent['type'],
  'profile.approved' | 'profile.rejected' | 'photo.approved' | 'photo.rejected'
>;

/** A profile a request can still be applied to. A closed profile is no longer changed. */
const LIVE_STATUSES = ['active', 'paused', 'matched'];

/**
 * The approval queue: what is waiting, what each request would change, and the decision.
 *
 * - Only staff review. An admin sees every request; an agent sees those for profiles assigned to
 *   them and for profiles nobody has been assigned to yet. One an agent may not see is reported as
 *   not found.
 * - Nobody decides what they submitted themselves, except an admin.
 * - A request can only be approved while the profile is exactly as it was when the request was
 *   made. If it changed since (an edit by staff, a status change), the request is out of date and
 *   must be made again: approving it could undo or overwrite something newer.
 * - The reviewer says which version they looked at. If the profile moved on while they read, the
 *   approval is refused rather than applied to something they did not see.
 * - Deciding is atomic: the request and the profile stay locked, the decision, its effect and an
 *   event are written together, and a request already decided cannot be decided again.
 */
export class ReviewService {
  constructor(
    private readonly db: Pick<ReviewDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(actor: ProfileActor, query: ListQuery): Promise<QueuePage> {
    this.requireStaff(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const rows = await unit.list(
        actor.agencyId,
        { status: query.status, kind: query.kind, limit: query.limit, after },
        this.viewer(actor),
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > query.limit && last
            ? encodeCursor({ createdAt: last.position, id: last.id })
            : null,
      };
    });
  }

  /** How many requests are waiting for this reviewer. */
  async pendingCount(actor: ProfileActor): Promise<number> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, (unit) =>
      unit.pendingCount(actor.agencyId, this.viewer(actor)),
    );
  }

  async detail(actor: ProfileActor, reviewId: string): Promise<ReviewDetail> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, (unit) => this.detailOf(unit, actor, reviewId));
  }

  /** Where the files of the photo a request is about are. A reviewer may see a photo they review. */
  async photoKey(actor: ProfileActor, reviewId: string): Promise<{ storageKey: string }> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const review = await this.mustSee(unit, actor, reviewId, false);
      if (!review.photoId) throw new AppError(404, 'PHOTO_NOT_FOUND');
      const photo = await unit.findPhoto(actor.agencyId, review.photoId, false);
      if (!photo || photo.status === 'removed') throw new AppError(404, 'PHOTO_NOT_FOUND');
      return { storageKey: photo.storageKey };
    });
  }

  approve(
    actor: ProfileActor,
    reviewId: string,
    input: ApproveInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    return this.decide(
      actor,
      reviewId,
      'approved',
      input.note ?? null,
      input.profileVersion,
      correlationId,
    );
  }

  reject(
    actor: ProfileActor,
    reviewId: string,
    input: RejectInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    return this.decide(actor, reviewId, 'rejected', input.note, undefined, correlationId);
  }

  // ------------------------------------------------------------------------------------------

  private async decide(
    actor: ProfileActor,
    reviewId: string,
    outcome: 'approved' | 'rejected',
    note: string | null,
    seenVersion: number | undefined,
    correlationId: string,
  ): Promise<ReviewDetail> {
    this.requireStaff(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const review = await this.mustSee(unit, actor, reviewId, true);
      if (review.status === 'cancelled') throw new AppError(409, 'REVIEW_CANCELLED');
      if (review.status !== 'pending') throw new AppError(409, 'REVIEW_ALREADY_DECIDED');
      if (review.submittedBy.id === actor.accountId && !mayDecideOwn(actor)) {
        throw new AppError(409, 'REVIEW_OWN_SUBMISSION');
      }

      const profile = await unit.findProfile(actor.agencyId, review.profile.id, true);
      if (!profile) throw new AppError(404, 'REVIEW_NOT_FOUND');

      if (review.kind === 'photo_add') {
        await this.decidePhoto(unit, actor, review, outcome);
      } else {
        // The profile must be exactly as it was when the request was made, and as the reviewer saw it.
        if (review.baseProfileVersion !== profile.version) {
          throw new AppError(409, 'REVIEW_OUT_OF_DATE');
        }
        if (seenVersion !== undefined && seenVersion !== profile.version) {
          throw new AppError(409, 'REVIEW_OUT_OF_DATE');
        }
        if (review.kind === 'initial_submission') {
          if (profile.status !== 'pending_review') throw new AppError(409, 'REVIEW_OUT_OF_DATE');
          if (outcome === 'approved') this.requireComplete(profile.data);
          await unit.setProfileStatus(
            actor.agencyId,
            profile.id,
            outcome === 'approved' ? 'active' : 'rejected',
          );
        } else if (outcome === 'approved') {
          if (!LIVE_STATUSES.includes(profile.status))
            throw new AppError(409, 'REVIEW_OUT_OF_DATE');
          const merged = applyChanges(profile.data, (review.proposed ?? {}) as ProposedChanges);
          this.requireComplete(merged);
          await unit.saveProfileContent(actor.agencyId, profile.id, profile.status, merged);
        }
        // Rejecting a change request leaves the published profile exactly as it was.
      }

      const recorded = await unit.decide(actor.agencyId, review.id, outcome, actor.accountId, note);
      // Only a request still waiting can be decided: if it was not, another reviewer won.
      if (!recorded) throw new AppError(409, 'REVIEW_ALREADY_DECIDED');

      await unit.appendEvent(
        this.event(
          review.kind === 'photo_add'
            ? outcome === 'approved'
              ? 'photo.approved'
              : 'photo.rejected'
            : outcome === 'approved'
              ? 'profile.approved'
              : 'profile.rejected',
          actor,
          review.kind === 'photo_add' && review.photoId ? review.photoId : profile.id,
          correlationId,
        ),
      );
      return this.detailOf(unit, actor, reviewId);
    });
  }

  private async decidePhoto(
    unit: ReviewUnit,
    actor: ProfileActor,
    review: ReviewRecordDetail,
    outcome: 'approved' | 'rejected',
  ) {
    if (!review.photoId) throw new AppError(409, 'REVIEW_OUT_OF_DATE');
    const photo = await unit.findPhoto(actor.agencyId, review.photoId, true);
    // A photo removed after it was uploaded cannot be approved. Its request is cancelled with it.
    if (!photo || photo.status !== 'staged') throw new AppError(409, 'REVIEW_OUT_OF_DATE');
    if (outcome === 'approved') {
      await unit.publishPhoto(actor.agencyId, photo.profileId, photo.id);
    }
    // A rejected photo stays with its owner, who sees the reason and can remove it.
  }

  private async detailOf(
    unit: ReviewUnit,
    actor: ProfileActor,
    reviewId: string,
  ): Promise<ReviewDetail> {
    const review = await this.mustSee(unit, actor, reviewId, false);
    const profile = await unit.findProfile(actor.agencyId, review.profile.id, false);
    if (!profile) throw new AppError(404, 'REVIEW_NOT_FOUND');

    const { stale, blockedBy } = this.verdict(actor, review, profile.version);
    return {
      ...review,
      profileDetail: { status: profile.status, version: profile.version },
      changes: this.changesOf(review, profile.data),
      stale,
      canDecide: blockedBy === null,
      blockedBy,
      decidedBy: review.decidedBy,
    };
  }

  private changesOf(review: ReviewRecordDetail, current: ProfileData): FieldChange[] {
    if (review.kind === 'photo_add') return [];
    if (review.kind === 'initial_submission') {
      return describeContent((review.proposed ?? current) as ProfileData);
    }
    return describeChanges(current, (review.proposed ?? {}) as ProposedChanges);
  }

  private verdict(actor: ProfileActor, review: ReviewRecordDetail, profileVersion: number) {
    // Photos do not depend on the profile's version.
    const stale =
      review.status === 'pending' &&
      review.kind !== 'photo_add' &&
      review.baseProfileVersion !== profileVersion;
    const blockedBy: ReviewDetail['blockedBy'] =
      review.status === 'cancelled'
        ? 'cancelled'
        : review.status !== 'pending'
          ? 'decided'
          : stale
            ? 'stale'
            : review.submittedBy.id === actor.accountId && !mayDecideOwn(actor)
              ? 'own_submission'
              : null;
    return { stale, blockedBy };
  }

  /** A request this reviewer may see. One they may not is reported as not found. */
  private async mustSee(unit: ReviewUnit, actor: ProfileActor, reviewId: string, lock: boolean) {
    const review = await unit.find(actor.agencyId, reviewId, lock);
    if (!review || !canReview(actor, review.profile)) throw new AppError(404, 'REVIEW_NOT_FOUND');
    return review;
  }

  /** An admin sees everything (no filter); an agent sees their own and the unassigned. */
  private viewer(actor: ProfileActor): string | null {
    return actor.role === 'admin' ? null : actor.accountId;
  }

  private requireStaff(actor: ProfileActor) {
    if (!isStaff(actor.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private requireComplete(data: ProfileData) {
    const missing = missingRequired(data);
    if (missing.length > 0) {
      throw new AppError(422, 'PROFILE_INCOMPLETE', {
        fields: missing.map((path) => ({ path, code: 'required' })),
      });
    }
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    subjectId: string,
    correlationId: string,
  ): WorkflowEvent {
    return {
      id: randomUUID(),
      agencyId: actor.agencyId,
      actorId: actor.accountId,
      type,
      version: 1,
      occurredAt: this.now().toISOString(),
      correlationId,
      subjectId,
    };
  }
}
