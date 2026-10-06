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
      'account.registered',
      'profile.approved',
      'profile.submitted',
      'profile.edit_requested',
      'profile.review_cancelled',
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
