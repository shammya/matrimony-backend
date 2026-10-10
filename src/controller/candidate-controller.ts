import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { candidateListQuerySchema } from '../bo/candidate.js';
import { candidateIdsSchema, settingsInputSchema } from '../bo/release.js';
import {
  candidateListResponse,
  generationResponse,
  outcomeResponse,
  settingsResponse,
} from '../factory/candidate-response.js';
import type { CandidateService } from '../service/candidate-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const params = z.object({ profileId: z.uuid() });

/**
 * The candidate list of a client, for staff. What each may reach is decided by the service (an agent
 * only their own clients). Nothing here is ever sent to the client the list is about.
 */
export function registerCandidateController(
  app: FastifyInstance,
  candidates: Pick<
    CandidateService,
    'generate' | 'list' | 'settings' | 'saveSettings' | 'release' | 'remove'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const id = (req: { params: unknown }) => params.parse(req.params).profileId;

  app.post(
    '/api/v1/staff/clients/:profileId/candidates/generate',
    { config: staffOnly },
    async (req) => generationResponse(await candidates.generate(actor(req), id(req))),
  );

  app.get('/api/v1/staff/clients/:profileId/candidates', { config: staffOnly }, async (req) =>
    candidateListResponse(
      await candidates.list(actor(req), id(req), candidateListQuerySchema.parse(req.query)),
    ),
  );

  app.get('/api/v1/staff/clients/:profileId/release-settings', { config: staffOnly }, async (req) =>
    settingsResponse(await candidates.settings(actor(req), id(req))),
  );

  app.put('/api/v1/staff/clients/:profileId/release-settings', { config: staffOnly }, async (req) =>
    settingsResponse(
      await candidates.saveSettings(
        actor(req),
        id(req),
        settingsInputSchema.parse(req.body),
        req.id,
      ),
    ),
  );

  app.post(
    '/api/v1/staff/clients/:profileId/candidates/release',
    { config: staffOnly },
    async (req) =>
      outcomeResponse(
        await candidates.release(actor(req), id(req), candidateIdsSchema.parse(req.body), req.id),
      ),
  );

  app.post(
    '/api/v1/staff/clients/:profileId/candidates/remove',
    { config: staffOnly },
    async (req) =>
      outcomeResponse(
        await candidates.remove(actor(req), id(req), candidateIdsSchema.parse(req.body), req.id),
      ),
  );
}
