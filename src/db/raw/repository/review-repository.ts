import type { Cursor, QueueItem, QueueKind, ReviewStatus } from '../../../bo/review.js';
import type { Transaction } from '../../config/database.js';
import { countRow, photoFileRow } from '../../entity/review.js';
import { mapQueueItem, mapReviewDetail, type ReviewRecordDetail } from '../mapper/review.js';
import { listQuery, reviewQueries } from '../query/review.js';

export interface QueuePhoto {
  id: string;
  profileId: string;
  storageKey: string;
  status: 'staged' | 'published' | 'removed';
}

/** All approval-queue reads and writes. Every method runs inside the transaction it is given. */
export class ReviewRepository {
  /**
   * One page of the queue. `viewer` is the agent whose view this is, or null for an admin. Asks for
   * one more than `limit`, so the caller can tell whether there is a next page.
   */
  async list(
    tx: Transaction,
    agencyId: string,
    query: {
      status: ReviewStatus;
      kind: QueueKind | undefined;
      limit: number;
      after: Cursor | null;
    },
    viewer: string | null,
  ): Promise<QueueItem[]> {
    const direction = query.status === 'pending' ? 'ASC' : 'DESC';
    const result = await tx.query(listQuery(direction), [
      agencyId,
      query.status,
      query.kind ?? null,
      viewer,
      query.after?.createdAt ?? null,
      query.after?.id ?? null,
      query.limit + 1,
    ]);
    return result.rows.map(mapQueueItem);
  }

  async find(
    tx: Transaction,
    agencyId: string,
    reviewId: string,
    lock: boolean,
  ): Promise<ReviewRecordDetail | null> {
    const result = await tx.query(lock ? reviewQueries.detailForUpdate : reviewQueries.detail, [
      agencyId,
      reviewId,
    ]);
    return result.rows[0] ? mapReviewDetail(result.rows[0]) : null;
  }

  async pendingCount(tx: Transaction, agencyId: string, viewer: string | null): Promise<number> {
    const result = await tx.query(reviewQueries.pendingCount, [agencyId, viewer]);
    return countRow.parse(result.rows[0]).n;
  }

  async findPhoto(
    tx: Transaction,
    agencyId: string,
    photoId: string,
    lock: boolean,
  ): Promise<QueuePhoto | null> {
    const result = await tx.query(lock ? reviewQueries.photoForUpdate : reviewQueries.photo, [
      agencyId,
      photoId,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    const photo = photoFileRow.parse(row);
    return {
      id: photo.id,
      profileId: photo.profile_id,
      storageKey: photo.storage_key,
      status: photo.status,
    };
  }

  /** Makes the photo visible to others, and the main photo if the profile has none yet. */
  async publishPhoto(tx: Transaction, agencyId: string, profileId: string, photoId: string) {
    await tx.query(reviewQueries.publishPhoto, [agencyId, photoId]);
    await tx.query(reviewQueries.makeMainIfNone, [agencyId, photoId, profileId]);
  }

  /** Records the decision. False when the request was no longer waiting. */
  async decide(
    tx: Transaction,
    agencyId: string,
    reviewId: string,
    outcome: 'approved' | 'rejected',
    reviewerId: string,
    note: string | null,
  ): Promise<boolean> {
    const result = await tx.query(reviewQueries.decide, [
      agencyId,
      reviewId,
      outcome,
      reviewerId,
      note,
    ]);
    return result.rows.length > 0;
  }
}
