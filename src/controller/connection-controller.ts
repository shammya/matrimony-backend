import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectionListQuerySchema,
  notificationQuerySchema,
  respondSchema,
  sendRequestSchema,
} from '../bo/connection.js';
import {
  connectionPageResponse,
  notificationPageResponse,
  sendResponse,
  staffConnectionsResponse,
} from '../factory/connection-response.js';
import type { ConnectionService } from '../service/connection-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const anyRole = { roles: ['member' as const, 'agent' as const, 'admin' as const] };
const connectionParams = z.object({ connectionId: z.uuid() });
const clientParams = z.object({ profileId: z.uuid(), connectionId: z.uuid() });
const profileParams = z.object({ profileId: z.uuid() });

/**
 * Connection requests and the inbox. A member asks and answers for themselves; staff answer for a
 * client who has no login. Who may touch which connection is decided by the service.
 */
export function registerConnectionController(
  app: FastifyInstance,
  connections: Pick<
    ConnectionService,
    | 'send'
    | 'respond'
    | 'withdraw'
    | 'shareContact'
    | 'list'
    | 'notifications'
    | 'staffList'
    | 'staffRespond'
    | 'staffShareContact'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const connectionId = (req: { params: unknown }) =>
    connectionParams.parse(req.params).connectionId;

  app.post('/api/v1/me/connections', { config: memberOnly }, async (req) =>
    sendResponse(
      await connections.send(actor(req), sendRequestSchema.parse(req.body).candidateId, req.id),
    ),
  );

  app.get('/api/v1/me/connections', { config: memberOnly }, async (req) =>
    connectionPageResponse(
      await connections.list(actor(req), connectionListQuerySchema.parse(req.query)),
    ),
  );

  app.post(
    '/api/v1/me/connections/:connectionId/respond',
    { config: memberOnly },
    async (req, reply) => {
      await connections.respond(
        actor(req),
        connectionId(req),
        respondSchema.parse(req.body).response === 'accept',
        req.id,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/me/connections/:connectionId/withdraw',
    { config: memberOnly },
    async (req, reply) => {
      await connections.withdraw(actor(req), connectionId(req), req.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/me/connections/:connectionId/share-contact',
    { config: memberOnly },
    async (req, reply) => {
      await connections.shareContact(actor(req), connectionId(req), req.id);
      return reply.code(204).send();
    },
  );

  // The inbox: for a member, what happened to them; for staff, what happened to the clients they look after.
  app.get('/api/v1/me/notifications', { config: anyRole }, async (req) =>
    notificationPageResponse(
      await connections.notifications(actor(req), notificationQuerySchema.parse(req.query)),
    ),
  );

  app.get('/api/v1/staff/clients/:profileId/connections', { config: staffOnly }, async (req) =>
    staffConnectionsResponse(
      await connections.staffList(actor(req), profileParams.parse(req.params).profileId),
    ),
  );

  app.post(
    '/api/v1/staff/clients/:profileId/connections/:connectionId/respond',
    { config: staffOnly },
    async (req, reply) => {
      const ids = clientParams.parse(req.params);
      await connections.staffRespond(
        actor(req),
        ids.profileId,
        ids.connectionId,
        respondSchema.parse(req.body).response === 'accept',
        req.id,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/staff/clients/:profileId/connections/:connectionId/share-contact',
    { config: staffOnly },
    async (req, reply) => {
      const ids = clientParams.parse(req.params);
      await connections.staffShareContact(actor(req), ids.profileId, ids.connectionId, req.id);
      return reply.code(204).send();
    },
  );
}
