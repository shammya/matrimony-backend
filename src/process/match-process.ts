import { variantKey, type PhotoVariant } from '../bo/photo.js';
import { AppError } from '../exception/app-error.js';
import type { MatchService } from '../service/match-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';

/**
 * A member's matches as the API uses them. The rules are the service's; this adds the one thing that
 * needs the file storage: streaming the photo of a profile released to the member, after the service
 * has checked that it is theirs to see.
 */
export class MatchProcess {
  constructor(
    private readonly matches: Pick<MatchService, 'page' | 'detail' | 'photoKey'>,
    private readonly storage: FileStorage,
  ) {}

  page(...args: Parameters<MatchService['page']>) {
    return this.matches.page(...args);
  }

  detail(...args: Parameters<MatchService['detail']>) {
    return this.matches.detail(...args);
  }

  async photo(actor: ProfileActor, candidateId: string, variant: PhotoVariant): Promise<Buffer> {
    const { storageKey } = await this.matches.photoKey(actor, candidateId);
    const data = await this.storage.get(variantKey(storageKey, variant));
    if (!data) throw new AppError(404, 'PHOTO_NOT_FOUND');
    return data;
  }
}
