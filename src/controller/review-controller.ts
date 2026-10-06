import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approveInputSchema, listQuerySchema, rejectInputSchema } from '../bo/review.js';
import { queuePageResponse, reviewDetailResponse } from '../factory/review-response.js';
import type { ReviewProcess } from '../process/review-process.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const params = z.object({ reviewId: z.uuid() });
const photoQuery = z.object({ size: z.enum(['full', 'thumb']).default('full') });

/** The approval queue. Admins and agents only; what each may see is decided by the service. */
export function registerReviewController(
  app: FastifyInstance,
  reviews: Pick<ReviewProcess, 'list' | 'pendingCount' | 'detail' | 'approve' | 'reject' | 'photo'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });

  app.get('/api/v1/reviews', { config: staffOnly }, async (req) =>
    queuePageResponse(await reviews.list(actor(req), listQuerySchema.parse(req.query))),
  );

  // How many requests are waiting for this reviewer, for the badge in the navigation.
  app.get('/api/v1/reviews/summary', { config: staffOnly }, async (req) => ({
    pending: await reviews.pendingCount(actor(req)),
  }));

  app.get('/api/v1/reviews/:reviewId', { config: staffOnly }, async (req) =>
    reviewDetailResponse(await reviews.detail(actor(req), params.parse(req.params).reviewId)),
  );

  app.get('/api/v1/reviews/:reviewId/photo', { config: staffOnly }, async (req, reply) => {
    const { reviewId } = params.parse(req.params);
    const { size } = photoQuery.parse(req.query);
    const bytes = await reviews.photo(actor(req), reviewId, size);
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=3600')
      .send(bytes);
  });

  app.post('/api/v1/reviews/:reviewId/approve', { config: staffOnly }, async (req) =>
    reviewDetailResponse(
      await reviews.approve(
        actor(req),
        params.parse(req.params).reviewId,
        approveInputSchema.parse(req.body ?? {}),
        req.id,
      ),
    ),
  );

  app.post('/api/v1/reviews/:reviewId/reject', { config: staffOnly }, async (req) =>
    reviewDetailResponse(
      await reviews.reject(
        actor(req),
        params.parse(req.params).reviewId,
        rejectInputSchema.parse(req.body),
        req.id,
      ),
    ),
  );
}
