import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assignmentSchema,
  clientInputSchema,
  clientListQuerySchema,
  statusChangeSchema,
} from '../bo/client.js';
import {
  clientDetailResponse,
  clientPageResponse,
  staffListResponse,
} from '../factory/client-response.js';
import type { ClientService } from '../service/client-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const adminOnly = { roles: ['admin' as const] };
const params = z.object({ profileId: z.uuid() });
const submitSchema = z.object({ version: z.number().int().min(1) }).strict();

/**
 * Staff managing their clients. Admins and agents only; what each may reach is decided by the
 * service (an agent only their own clients, only an admin assigns).
 */
export function registerClientController(
  app: FastifyInstance,
  clients: Pick<
    ClientService,
    | 'list'
    | 'detail'
    | 'create'
    | 'save'
    | 'submit'
    | 'requestEdit'
    | 'cancelPending'
    | 'changeStatus'
    | 'assign'
    | 'listStaff'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  // Dates of birth are judged against today when the request arrives.
  const input = (body: unknown) => clientInputSchema(new Date()).parse(body);
  const id = (req: { params: unknown }) => params.parse(req.params).profileId;

  app.get('/api/v1/staff/clients', { config: staffOnly }, async (req) =>
    clientPageResponse(await clients.list(actor(req), clientListQuerySchema.parse(req.query))),
  );

  app.post('/api/v1/staff/clients', { config: staffOnly }, async (req, reply) => {
    const created = await clients.create(actor(req), input(req.body), req.id);
    return reply.code(201).send(clientDetailResponse(created.detail));
  });

  app.get('/api/v1/staff/clients/:profileId', { config: staffOnly }, async (req) =>
    clientDetailResponse(await clients.detail(actor(req), id(req))),
  );

  app.put('/api/v1/staff/clients/:profileId', { config: staffOnly }, async (req) =>
    clientDetailResponse(await clients.save(actor(req), id(req), input(req.body))),
  );

  app.post('/api/v1/staff/clients/:profileId/submit', { config: staffOnly }, async (req) =>
    clientDetailResponse(
      await clients.submit(actor(req), id(req), submitSchema.parse(req.body).version, req.id),
    ),
  );

  app.post('/api/v1/staff/clients/:profileId/edit-requests', { config: staffOnly }, async (req) =>
    clientDetailResponse(await clients.requestEdit(actor(req), id(req), input(req.body), req.id)),
  );

  app.delete(
    '/api/v1/staff/clients/:profileId/pending-review',
    { config: staffOnly },
    async (req) => clientDetailResponse(await clients.cancelPending(actor(req), id(req), req.id)),
  );

  app.post('/api/v1/staff/clients/:profileId/status', { config: staffOnly }, async (req) => {
    const change = statusChangeSchema.parse(req.body);
    return clientDetailResponse(
      await clients.changeStatus(actor(req), id(req), change.status, change.version, req.id),
    );
  });

  app.put('/api/v1/staff/clients/:profileId/assignment', { config: adminOnly }, async (req) =>
    clientDetailResponse(
      await clients.assign(actor(req), id(req), assignmentSchema.parse(req.body).agentId, req.id),
    ),
  );

  // The people an admin may hand clients to.
  app.get('/api/v1/admin/staff', { config: adminOnly }, async (req) =>
    staffListResponse(await clients.listStaff(actor(req))),
  );
}
