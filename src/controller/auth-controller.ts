import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthProcess } from '../process/auth-process.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
import { browserSecretSchema, tokensResponseSchema } from '../io/http/contracts.js';
import './context.js';
export function registerAuthController(
  app: FastifyInstance,
  auth: Pick<AuthProcess, 'begin' | 'complete' | 'refresh' | 'logout'>,
  config: AppConfig,
) {
  const prefix = config.NODE_ENV === 'production' ? '__Host-' : '';
  const sessionCookie = `${prefix}matrimony-session`;
  const challengeCookie = `${prefix}matrimony-challenge`;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
  };
  function browserSession(req: FastifyRequest) {
    if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
    return {
      id: browserSecretSchema.parse(req.cookies[sessionCookie]),
      csrf: browserSecretSchema.parse(req.headers['x-csrf-token']),
    };
  }
  app.get(
    '/api/v1/auth/authorize',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: {
        response: { 200: { type: 'object', properties: { authorizationUrl: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const result = await auth.begin(
        req.tenant!.id,
        `${req.canonicalOrigin}/api/v1/auth/callback`,
      );
      reply.setCookie(challengeCookie, result.challengeId, { ...cookieOptions, maxAge: 300 });
      return { authorizationUrl: result.authorizationUrl };
    },
  );
  app.get(
    '/api/v1/auth/callback',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      const id = browserSecretSchema.parse(req.cookies[challengeCookie]);
      reply.clearCookie(challengeCookie, cookieOptions);
      const result = await auth.complete(
        req.tenant!.id,
        id,
        new URL(req.url, req.canonicalOrigin),
        req.id,
      );
      reply.setCookie(sessionCookie, result.sessionId, {
        ...cookieOptions,
        maxAge: config.SESSION_TTL_SECONDS,
      });
      return {
        accessToken: result.accessToken,
        csrfToken: result.csrfToken,
        expiresIn: result.expiresIn,
      };
    },
  );
  app.post(
    '/api/v1/auth/refresh',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req) => {
      const session = browserSession(req);
      return auth.refresh(req.tenant!.id, session.id, session.csrf, req.id);
    },
  );
  app.post('/api/v1/auth/logout', { config: { public: true } }, async (req, reply) => {
    const session = browserSession(req);
    await auth.logout(req.tenant!.id, session.id, session.csrf, req.id);
    reply.clearCookie(sessionCookie, cookieOptions);
    return reply.code(204).send();
  });
}
