import type { Logger } from 'pino';
import { PHOTO_VARIANTS, variantKey, type PhotoList, type PhotoVariant } from '../bo/photo.js';
import { AppError } from '../exception/app-error.js';
import type { ProcessedImage } from '../security/image-processor.js';
import type { PhotoService } from '../service/photo-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';

const VARIANTS = Object.keys(PHOTO_VARIANTS) as PhotoVariant[];

/**
 * A member's photos from the file's point of view. It joins the three things an upload touches,
 * the image check, the file storage and the database, and keeps them consistent:
 *
 * - The image is checked and converted before anything is stored.
 * - The database record is written only after the files are stored, so a photo in the list
 *   always has its files.
 * - If the record cannot be written, the files just stored are deleted again.
 * - When a photo is removed, the record goes first and the files after. A file that cannot be
 *   deleted is logged and left behind harmlessly: nothing points to it any more.
 */
export class PhotoProcess {
  constructor(
    private readonly photos: Pick<
      PhotoService,
      'list' | 'reserve' | 'attach' | 'remove' | 'makePrimary' | 'locate'
    >,
    private readonly storage: FileStorage,
    private readonly process: (input: Buffer) => Promise<ProcessedImage>,
    private readonly logger: Logger,
  ) {}

  list(actor: ProfileActor): Promise<PhotoList> {
    return this.photos.list(actor);
  }

  makePrimary(actor: ProfileActor, photoId: string): Promise<PhotoList> {
    return this.photos.makePrimary(actor, photoId);
  }

  async upload(actor: ProfileActor, bytes: Buffer, correlationId: string): Promise<PhotoList> {
    const reservation = await this.photos.reserve(actor);
    const image = await this.process(bytes);
    const files: [PhotoVariant, Buffer][] = [
      ['full', image.full],
      ['thumb', image.thumb],
    ];

    const stored: string[] = [];
    try {
      for (const [variant, data] of files) {
        const key = variantKey(reservation.storageKey, variant);
        await this.storage.put(key, data, 'image/webp');
        stored.push(key);
      }
      return await this.photos.attach(actor, reservation, image.full.length, correlationId);
    } catch (error) {
      await this.deleteQuietly(stored);
      throw error;
    }
  }

  async remove(actor: ProfileActor, photoId: string, correlationId: string): Promise<PhotoList> {
    const { list, storageKey } = await this.photos.remove(actor, photoId, correlationId);
    await this.deleteQuietly(VARIANTS.map((variant) => variantKey(storageKey, variant)));
    return list;
  }

  /** The bytes of one size of the member's own photo. */
  async image(actor: ProfileActor, photoId: string, variant: PhotoVariant): Promise<Buffer> {
    const { storageKey } = await this.photos.locate(actor, photoId);
    const data = await this.storage.get(variantKey(storageKey, variant));
    if (!data) throw new AppError(404, 'PHOTO_NOT_FOUND');
    return data;
  }

  private async deleteQuietly(keys: string[]) {
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch {
        // Only the code is logged: a storage error can carry the bucket or the path.
        this.logger.error({ code: 'PHOTO_FILE_DELETE_FAILED' }, 'Could not delete a photo file');
      }
    }
  }
}
