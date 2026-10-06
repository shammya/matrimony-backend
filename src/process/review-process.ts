import type { PhotoVariant } from '../bo/photo.js';
import { variantKey } from '../bo/photo.js';
import type {
  ApproveInput,
  ListQuery,
  QueuePage,
  RejectInput,
  ReviewDetail,
} from '../bo/review.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from '../service/profile-service.js';
import type { ReviewService } from '../service/review-service.js';
import type { FileStorage } from '../storage/service/file-storage.js';

/**
 * The approval queue as the API uses it. The decisions are the service's; this adds the one thing
 * that needs the file storage: showing a reviewer the photo they are asked to approve.
 */
export class ReviewProcess {
  constructor(
    private readonly reviews: Pick<
      ReviewService,
      'list' | 'pendingCount' | 'detail' | 'approve' | 'reject' | 'photoKey'
    >,
    private readonly storage: FileStorage,
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

  approve(
    actor: ProfileActor,
    reviewId: string,
    input: ApproveInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    return this.reviews.approve(actor, reviewId, input, correlationId);
  }

  reject(
    actor: ProfileActor,
    reviewId: string,
    input: RejectInput,
    correlationId: string,
  ): Promise<ReviewDetail> {
    return this.reviews.reject(actor, reviewId, input, correlationId);
  }

  /** The bytes of one size of the photo a request is about. */
  async photo(actor: ProfileActor, reviewId: string, variant: PhotoVariant): Promise<Buffer> {
    const { storageKey } = await this.reviews.photoKey(actor, reviewId);
    const data = await this.storage.get(variantKey(storageKey, variant));
    if (!data) throw new AppError(404, 'PHOTO_NOT_FOUND');
    return data;
  }
}
