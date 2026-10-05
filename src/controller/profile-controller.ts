import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { profileInputSchema } from '../bo/profile.js';
import { profileResponse } from '../factory/profile-response.js';
import type { ProfileActor, ProfileService } from '../service/profile-service.js';
import './context.js';

const submitSchema = z.object({ version: z.number().int().min(1) }).strict();
const memberOnly = { roles: ['member' as const] };

/** A member's own profile. Only members have one, so every route is member-only. */
export function registerProfileController(
  app: FastifyInstance,
  profiles: Pick<ProfileService, 'get' | 'save' | 'submit' | 'requestEdit' | 'cancelPending'>,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  // Dates of birth are judged against today when the request arrives.
  const input = (body: unknown) => profileInputSchema(new Date()).parse(body);

  app.get('/api/v1/me/profile', { config: memberOnly }, async (req) =>
    profileResponse(await profiles.get(actor(req))),
  );
  app.put('/api/v1/me/profile', { config: memberOnly }, async (req) =>
    profileResponse(await profiles.save(actor(req), input(req.body))),
  );
  app.post('/api/v1/me/profile/submit', { config: memberOnly }, async (req) =>
    profileResponse(
      await profiles.submit(actor(req), submitSchema.parse(req.body).version, req.id),
    ),
  );
  app.post('/api/v1/me/profile/edit-requests', { config: memberOnly }, async (req) =>
    profileResponse(await profiles.requestEdit(actor(req), input(req.body), req.id)),
  );
  app.delete('/api/v1/me/profile/pending-review', { config: memberOnly }, async (req) =>
    profileResponse(await profiles.cancelPending(actor(req), req.id)),
  );
}
