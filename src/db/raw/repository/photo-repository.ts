import type { PhotoFile, PhotoRecord } from '../../../bo/photo.js';
import type { Transaction } from '../../config/database.js';
import { profileRef } from '../../entity/photo.js';
import { mapPhoto, mapPhotoFile } from '../mapper/photo.js';
import { photoQueries } from '../query/photo.js';

/** All photo reads and writes. Every method runs inside the transaction it is given. */
export class PhotoRepository {
  /** The member's profile (id and status), locked when `lock` is set. Null when they have none. */
  async profileOf(tx: Transaction, agencyId: string, ownerId: string, lock: boolean) {
    const result = await tx.query(lock ? photoQueries.lockProfile : photoQueries.findProfile, [
      agencyId,
      ownerId,
    ]);
    return result.rows[0] ? profileRef.parse(result.rows[0]) : null;
  }

  async list(tx: Transaction, agencyId: string, profileId: string): Promise<PhotoRecord[]> {
    const result = await tx.query(photoQueries.list, [agencyId, profileId]);
    return result.rows.map(mapPhoto);
  }

  async find(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    photoId: string,
  ): Promise<PhotoFile | null> {
    const result = await tx.query(photoQueries.find, [agencyId, profileId, photoId]);
    return result.rows[0] ? mapPhotoFile(result.rows[0]) : null;
  }

  async count(tx: Transaction, agencyId: string, profileId: string): Promise<number> {
    const result = await tx.query(photoQueries.count, [agencyId, profileId]);
    return Number((result.rows[0] as { n: number }).n);
  }

  async insert(
    tx: Transaction,
    agencyId: string,
    profileId: string,
    photoId: string,
    storageKey: string,
    byteSize: number,
    uploadedBy: string,
  ) {
    await tx.query(photoQueries.insert, [
      agencyId,
      photoId,
      profileId,
      storageKey,
      byteSize,
      uploadedBy,
    ]);
    await tx.query(photoQueries.insertReview, [agencyId, profileId, uploadedBy, photoId]);
  }

  /** Removes the photo from the member's list and cancels any review waiting on it. */
  async remove(tx: Transaction, agencyId: string, photoId: string) {
    await tx.query(photoQueries.markRemoved, [agencyId, photoId]);
    await tx.query(photoQueries.cancelReview, [agencyId, photoId]);
  }

  async makePrimary(tx: Transaction, agencyId: string, profileId: string, photoId: string) {
    // The database allows one main photo per profile, so the old one must go first.
    await tx.query(photoQueries.clearPrimary, [agencyId, profileId]);
    await tx.query(photoQueries.setPrimary, [agencyId, photoId]);
  }

  async promoteNext(tx: Transaction, agencyId: string, profileId: string) {
    await tx.query(photoQueries.promoteNext, [agencyId, profileId]);
  }
}
