import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { staffInviteInputSchema, type StaffInvitation } from '../bo/staff.js';
import type { StaffInvitationProcess } from '../process/staff-invitation-process.js';
import './context.js';

const adminOnly = { roles: ['admin' as const] };
const params = z.object({ invitationId: z.uuid() });

const invitationResponse = (invitation: StaffInvitation) => ({
  id: invitation.id,
  email: invitation.email,
  displayName: invitation.displayName,
  role: invitation.role,
  locale: invitation.locale,
  invitedByName: invitation.invitedByName,
  createdAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
  status: invitation.status,
});

/**
 * Inviting staff. Admins only. The pages the invited person uses (previewing and accepting the
 * link) are public and live with the other sign-in routes in the auth controller.
 */
export function registerStaffController(
  app: FastifyInstance,
  invitations: Pick<StaffInvitationProcess, 'invite' | 'resend' | 'list' | 'revoke'>,
) {
  const context = (req: FastifyRequest) => ({
    agencyId: req.tenant!.id,
    agencyName: req.tenant!.name,
    origin: req.canonicalOrigin,
  });
  const admin = (req: FastifyRequest) => ({
    id: req.principal!.id,
    role: req.principal!.role,
    displayName: req.principal!.displayName,
  });
  const invitationId = (req: FastifyRequest) => params.parse(req.params).invitationId;

  app.get('/api/v1/admin/staff/invitations', { config: adminOnly }, async (req) => ({
    invitations: (await invitations.list(context(req), admin(req))).map(invitationResponse),
  }));

  // Each request can send an email, so this has a tighter limit than the other staff routes.
  app.post(
    '/api/v1/admin/staff/invitations',
    { config: { ...adminOnly, rateLimit: { max: 30, timeWindow: 600000 } } },
    async (req, reply) => {
      const created = await invitations.invite(
        context(req),
        admin(req),
        staffInviteInputSchema.parse(req.body),
        req.id,
      );
      return reply.code(201).send(invitationResponse(created));
    },
  );

  app.post(
    '/api/v1/admin/staff/invitations/:invitationId/resend',
    { config: { ...adminOnly, rateLimit: { max: 30, timeWindow: 600000 } } },
    async (req) =>
      invitationResponse(
        await invitations.resend(context(req), admin(req), invitationId(req), req.id),
      ),
  );

  app.delete(
    '/api/v1/admin/staff/invitations/:invitationId',
    { config: adminOnly },
    async (req, reply) => {
      await invitations.revoke(context(req), admin(req), invitationId(req), req.id);
      return reply.code(204).send();
    },
  );
}
