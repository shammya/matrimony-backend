import { z } from 'zod';
export const eventSchema = z
  .object({
    id: z.uuid(),
    agencyId: z.uuid(),
    actorId: z.uuid().nullable(),
    type: z.enum([
      'auth.login',
      'auth.refresh',
      'auth.logout',
      'auth.password_reset',
      'auth.identity_linked',
      'auth.phone_added',
      'account.registered',
      'profile.approved',
      'profile.submitted',
      'profile.edit_requested',
      'profile.review_cancelled',
      'profile.rejected',
      'profile.status_changed',
      'profile.assigned',
      'client.created',
      'photo.approved',
      'photo.rejected',
      'photo.uploaded',
      'photo.removed',
      'interest.accepted',
      'payment.confirmed',
    ]),
    version: z.literal(1),
    occurredAt: z.iso.datetime(),
    correlationId: z.string().min(1).max(100),
    subjectId: z.uuid().nullable(),
  })
  .strict();
export type WorkflowEvent = z.infer<typeof eventSchema>;
export interface LeasedEvent {
  event: WorkflowEvent;
  leaseToken: string;
  attempts: number;
}
