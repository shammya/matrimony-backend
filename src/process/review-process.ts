import type { PhotoVariant } from '../bo/photo.js';
import { variantKey } from '../bo/photo.js';
import type {
  ApproveInput,
  ListQuery,
  QueuePage,
  RejectInput,
  ReviewDetail,
} from '../bo/review.js';
import type { Logger } from 'pino';
import { AppError } from '../exception/app-error.js';
import type { CandidateService } from '../service/candidate-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { ReviewService } from '../service/review-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';

/**
 * The approval queue as the API uses it. The decisions are the service's; this adds showing a
 * reviewer the photo they are asked to approve (file storage), and refreshing a profile's candidate
 * list once an approval that changes its content has been committed.
 */
export class ReviewProcess {
  constructor(
    private readonly reviews: Pick<
      ReviewService,
      'list' | 'pendingCount' | 'detail' | 'approve' | 'reject' | 'photoKey'
    >,
    private readonly storage: FileStorage,
    private readonly candidates: Pick<CandidateService, 'refresh'>,
    private readonly logger: Logger,
  ) {}

  list(actor: ProfileActor, query: ListQuery): Promise<QueuePage> {
    return this.reviews.list(actor, query);
  }

  pendingCount(actor: ProfileActor): Promise<number> {
    return this.reviews.pendingCount(actor);
  }

  detail(actor: ProfileActor, reviewId: string): Promise<ReviewDetail> {
    return this.reviews.detail(actor, reviewId);
  }

  async approve(
    actor: ProfileActor,
    reviewId: string,
    input: ApproveInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    const detail = await this.reviews.approve(actor, reviewId, input, correlationId);
    // A photo does not change anyone's preferences. A first submission or a change can.
    if (detail.kind !== 'photo_add') await this.refreshCandidates(actor, detail.profile.id);
    return detail;
  }

  reject(
    actor: ProfileActor,
    reviewId: string,
    input: RejectInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    return this.reviews.reject(actor, reviewId, input, correlationId);
  }

  /**
   * Runs after the approval has committed, in its own transaction, so a failure here can never undo
   * the approval. The list is simply refreshed the next time staff press "Find candidates".
   */
  private async refreshCandidates(actor: ProfileActor, profileId: string) {
    try {
      await this.candidates.refresh(actor.agencyId, profileId);
    } catch (error) {
      this.logger.error(
        { code: 'CANDIDATE_REFRESH_FAILED', agencyId: actor.agencyId, profileId, err: error },
        'candidate refresh failed after approval',
      );
    }
  }

  /** The bytes of one size of the photo a request is about. */
  async photo(actor: ProfileActor, reviewId: string, variant: PhotoVariant): Promise<Buffer> {
    const { storageKey } = await this.reviews.photoKey(actor, reviewId);
    const data = await this.storage.get(variantKey(storageKey, variant));
    if (!data) throw new AppError(404, 'PHOTO_NOT_FOUND');
    return data;
  }
}
