import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import type { AuthProcess } from '../process/auth-process.js';
import type { AccountAccessProcess } from '../process/account-access-process.js';
import type { GoogleAuthProcess } from '../process/google-auth-process.js';
import type { PhoneAuthProcess } from '../process/phone-auth-process.js';
import type { StaffInvitationProcess } from '../process/staff-invitation-process.js';
import type { RegistrationService } from '../service/registration-service.js';
import type { IdentityService } from '../service/identity-service.js';
import { bearerSchema, selfResponseSchema } from '../io/http/contracts.js';
import { accountResponse } from '../factory/account-response.js';
import { AppError } from '../exception/app-error.js';
import { registerAuthController } from './auth-controller.js';
import { registerProfileController } from './profile-controller.js';
import { registerPhotoController } from './photo-controller.js';
import { registerReviewController } from './review-controller.js';
import { registerClientController } from './client-controller.js';
import { registerCandidateController } from './candidate-controller.js';
import { registerMatchController } from './match-controller.js';
import { registerConnectionController } from './connection-controller.js';
import type { ConnectionService } from '../service/connection-service.js';
import type { MatchProcess } from '../process/match-process.js';
import type { CandidateService } from '../service/candidate-service.js';
import { registerStaffController } from './staff-controller.js';
import type { ReviewProcess } from '../process/review-process.js';
import type { ClientService } from '../service/client-service.js';
import type { PhotoProcess } from '../process/photo-process.js';
import { fieldProblems } from '../io/http/validation.js';
import type { ProfileService } from '../service/profile-service.js';
import './context.js';
export interface AppDependencies {
  reviews: Pick<ReviewProcess, 'list' | 'pendingCount' | 'detail' | 'approve' | 'reject' | 'photo'>;
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
  >;
  matches: Pick<MatchProcess, 'page' | 'detail' | 'photo'>;
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
  >;
  candidates: Pick<
    CandidateService,
    'generate' | 'list' | 'settings' | 'saveSettings' | 'release' | 'remove'
  >;
  config: AppConfig;
  logger: Logger;
  redis: Redis;
  auth: Pick<AuthProcess, 'login' | 'bootstrap' | 'authenticate' | 'refresh' | 'logout'>;
  /** Undefined when Google sign-in is not configured. */
  google?: Pick<
    GoogleAuthProcess,
    'start' | 'complete' | 'pending' | 'link' | 'pendingSignup' | 'signup'
  >;
  /** Undefined when no SMS sender is configured. */
  phone?: Pick<
    PhoneAuthProcess,
    'sendCode' | 'verifyCode' | 'pendingSignup' | 'signup' | 'sendAttachCode' | 'confirmAttach'
  >;
  registrations: Pick<RegistrationService, 'signInMethods'>;
  access: Pick<
    AccountAccessProcess,
    | 'startRegistration'
    | 'verifyEmail'
    | 'requestPasswordReset'
    | 'resetPassword'
    | 'sendReauthCode'
    | 'startAddEmail'
    | 'confirmAddEmail'
    | 'changePassword'
  >;
  invitations: Pick<
    StaffInvitationProcess,
    'invite' | 'resend' | 'list' | 'revoke' | 'preview' | 'accept'
  >;
  identities: Pick<IdentityService, 'tenant'>;
  photos: Pick<PhotoProcess, 'list' | 'upload' | 'remove' | 'makePrimary' | 'image'>;
  profiles: Pick<ProfileService, 'get' | 'save' | 'submit' | 'requestEdit' | 'cancelPending'>;
  ready: () => Promise<void>;
}
export async function buildApp(deps: AppDependencies) {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 15000,
    connectionTimeout: 15000,
  });
  await app.register(cookie);
  await app.register(helmet, { referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, {
    redis: deps.redis,
    max: 120,
    timeWindow: 60000,
    skipOnError: false,
    keyGenerator: (req) => req.ip,
    nameSpace: 'matrimony:rate:',
  });
  app.decorateRequest('tenant', null);
  app.decorateRequest('principal', null);
  app.decorateRequest('canonicalOrigin', '');
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id).header('cache-control', 'no-store');
    if (req.routeOptions.config.tenantRequired === false) return;
    const host = req.headers.host?.toLowerCase();
    if (!host || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host))
      throw new AppError(400, 'HOST_INVALID');
    const hostname = host.split(':')[0]!;
    if (config.NODE_ENV === 'production' && host !== hostname)
      throw new AppError(400, 'HOST_INVALID');
    req.tenant = await deps.identities.tenant(hostname);
    req.canonicalOrigin = `${config.NODE_ENV === 'production' ? 'https' : 'http'}://${host}`;
    if (req.routeOptions.config.public === true) return;
    const parsed = bearerSchema.safeParse(req.headers.authorization);
    if (!parsed.success) throw new AppError(401, 'BEARER_TOKEN_REQUIRED');
    req.principal = await deps.auth.authenticate(req.tenant.id, parsed.data);
    const roles = req.routeOptions.config.roles;
    if (roles && !roles.includes(req.principal.role)) throw new AppError(403, 'ROLE_FORBIDDEN');
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof AppError;
    const transport =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 0;
    const status = known
      ? error.status
      : error instanceof ZodError
        ? 400
        : transport >= 400 && transport < 500
          ? transport
          : 500;
    const code = known
      ? error.code
      : status === 400
        ? 'INVALID_REQUEST'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 415
            ? 'UNSUPPORTED_MEDIA_TYPE'
            : status === 429
              ? 'RATE_LIMITED'
              : status < 500
                ? 'REQUEST_REJECTED'
                : 'INTERNAL_ERROR';
    if (status >= 500)
      req.log.error(
        { code, errorType: error instanceof Error ? error.name : 'Unknown' },
        'Request failed',
      );
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    // A pause (too many attempts, too many emails) says how long to wait.
    if (known && typeof error.details?.retryAfter === 'number')
      reply.header('retry-after', String(error.details.retryAfter));
    const details = known
      ? error.details
      : error instanceof ZodError
        ? { fields: fieldProblems(error) }
        : undefined;
    return reply
      .code(status)
      .send({ error: { code, requestId: req.id, ...(details && { details }) } });
  });
  app.get(
    '/health/live',
    { config: { public: true, tenantRequired: false, rateLimit: false } },
    async () => ({ status: 'ok' }),
  );
  app.get(
    '/health/ready',
    { config: { public: true, tenantRequired: false, rateLimit: false } },
    async (_req, reply) => {
      try {
        await deps.ready();
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
  app.get('/api/v1/public/tenant', { config: { public: true } }, async (req) => ({
    id: req.tenant!.id,
    name: req.tenant!.name,
    locale: req.tenant!.locale,
    content: req.tenant!.publicConfig,
  }));
  app.get('/api/v1/me', { schema: { response: { 200: selfResponseSchema } } }, async (req) =>
    accountResponse(req.principal!),
  );
  registerAuthController(
    app,
    deps.auth,
    deps.google,
    deps.phone,
    deps.registrations,
    deps.access,
    deps.invitations,
    config,
  );
  registerProfileController(app, deps.profiles);
  registerPhotoController(app, deps.photos);
  registerReviewController(app, deps.reviews);
  registerClientController(app, deps.clients);
  registerCandidateController(app, deps.candidates);
  registerMatchController(app, deps.matches);
  registerConnectionController(app, deps.connections);
  registerStaffController(app, deps.invitations);
  return app;
}
