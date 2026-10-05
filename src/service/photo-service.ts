import { randomUUID } from 'node:crypto';
import type { WorkflowEvent } from '../bo/event.js';
import { MAX_PHOTOS, type PhotoList, type PhotoReservation } from '../bo/photo.js';
import type { PhotoDbService, PhotoUnit } from '../db/service/photo-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

type EventType = Extract<WorkflowEvent['type'], 'photo.uploaded' | 'photo.removed'>;

/**
 * The rules for a member's photos.
 *
 * - Only a member has photos, and only on a profile they have already saved.
 * - At most `MAX_PHOTOS` at a time. The check is repeated inside the transaction that holds the
 *   profile's row lock, so two uploads at once cannot both pass the same check.
 * - A new photo waits for a reviewer. Only an approved photo can be made the main photo.
 * - Removing a photo is immediate: a member may always take back their own picture.
 *
 * Files are not handled here. See `PhotoProcess`, which stores them and calls this.
 */
export class PhotoService {
  constructor(
    private readonly db: Pick<PhotoDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async list(actor: ProfileActor): Promise<PhotoList> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await unit.profileOf(actor.agencyId, actor.accountId, false);
      return {
        photos: profile ? await unit.list(actor.agencyId, profile.id) : [],
        limit: MAX_PHOTOS,
      };
    });
  }

  /**
   * Holds a place for an upload and says where its files will go. Fails early, so a member who is
   * over the limit does not wait for a large picture to be processed first.
   */
  async reserve(actor: ProfileActor): Promise<PhotoReservation> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, false);
      await this.requireRoom(unit, actor, profile.id);
      const photoId = this.newId();
      return {
        profileId: profile.id,
        photoId,
        // Begins with the agency and the profile, as the database requires.
        storageKey: `${actor.agencyId}/${profile.id}/${photoId}`,
      };
    });
  }

  /** Records the photo once its files are stored. It starts as waiting for review. */
  async attach(
    actor: ProfileActor,
    reservation: PhotoReservation,
    byteSize: number,
    correlationId: string,
  ): Promise<PhotoList> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, true);
      // The reservation belongs to the profile it was made for.
      if (profile.id !== reservation.profileId) throw new AppError(409, 'PROFILE_STATE_INVALID');
      await this.requireRoom(unit, actor, profile.id);
      await unit.insert(
        actor.agencyId,
        profile.id,
        reservation.photoId,
        reservation.storageKey,
        byteSize,
        actor.accountId,
      );
      await unit.appendEvent(
        this.event('photo.uploaded', actor, reservation.photoId, correlationId),
      );
      return this.listOf(unit, actor, profile.id);
    });
  }

  /** Removes a photo. Returns the new list and the key whose files must now be deleted. */
  async remove(
    actor: ProfileActor,
    photoId: string,
    correlationId: string,
  ): Promise<{ list: PhotoList; storageKey: string }> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, true);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');

      await unit.remove(actor.agencyId, photo.id);
      // The main photo went: the next approved one takes its place.
      if (photo.isPrimary) await unit.promoteNext(actor.agencyId, profile.id);
      await unit.appendEvent(this.event('photo.removed', actor, photo.id, correlationId));
      return { list: await this.listOf(unit, actor, profile.id), storageKey: photo.storageKey };
    });
  }

  async makePrimary(actor: ProfileActor, photoId: string): Promise<PhotoList> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, true);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');
      // Only a photo others can see may be the one shown first.
      if (photo.status !== 'published') throw new AppError(409, 'PHOTO_NOT_APPROVED');
      await unit.makePrimary(actor.agencyId, profile.id, photo.id);
      return this.listOf(unit, actor, profile.id);
    });
  }

  /** Where the files of one of the member's own photos are. A member may see their waiting photos. */
  async locate(actor: ProfileActor, photoId: string): Promise<{ storageKey: string }> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const profile = await this.mustHaveProfile(unit, actor, false);
      const photo = await unit.find(actor.agencyId, profile.id, photoId);
      if (!photo) throw new AppError(404, 'PHOTO_NOT_FOUND');
      return { storageKey: photo.storageKey };
    });
  }

  // Only members have photos of their own. Agents and admins work on clients' profiles elsewhere.
  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private async mustHaveProfile(unit: PhotoUnit, actor: ProfileActor, lock: boolean) {
    const profile = await unit.profileOf(actor.agencyId, actor.accountId, lock);
    if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND');
    // A closed profile is kept for the record and is no longer changed.
    if (profile.status === 'closed') throw new AppError(409, 'PROFILE_STATE_INVALID');
    return profile;
  }

  private async requireRoom(unit: PhotoUnit, actor: ProfileActor, profileId: string) {
    if ((await unit.count(actor.agencyId, profileId)) >= MAX_PHOTOS) {
      throw new AppError(409, 'PHOTO_LIMIT_REACHED');
    }
  }

  private async listOf(
    unit: PhotoUnit,
    actor: ProfileActor,
    profileId: string,
  ): Promise<PhotoList> {
    return { photos: await unit.list(actor.agencyId, profileId), limit: MAX_PHOTOS };
  }

  private event(
    type: EventType,
    actor: ProfileActor,
    photoId: string,
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
      subjectId: photoId,
    };
  }
}
