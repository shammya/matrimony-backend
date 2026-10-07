import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthProcess } from '../process/auth-process.js';
import type { AccountAccessProcess } from '../process/account-access-process.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
import {
  browserSecretSchema,
  statusResponseSchema,
  tokensResponseSchema,
} from '../io/http/contracts.js';
import {
  forgotPasswordInputSchema,
  loginInputSchema,
  resetPasswordInputSchema,
  verifyEmailInputSchema,
} from '../bo/credentials.js';
import { registrationInputSchema } from '../bo/registration.js';
import './context.js';
export function registerAuthController(
  app: FastifyInstance,
  auth: Pick<AuthProcess, 'login' | 'bootstrap' | 'refresh' | 'logout'>,
  access: Pick<
    AccountAccessProcess,
    'startRegistration' | 'verifyEmail' | 'requestPasswordReset' | 'resetPassword'
  >,
  config: AppConfig,
) {
  const prefix = config.NODE_ENV === 'production' ? '__Host-' : '';
  const sessionCookie = `${prefix}matrimony-session`;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    // The frontend and the API share one origin and nothing signs in by arriving from another
    // site, so the cookie is never sent on a cross-site request at all.
    sameSite: 'strict' as const,
  };
  function requireSameOrigin(req: FastifyRequest) {
    if (req.headers.origin !== req.canonicalOrigin) throw new AppError(403, 'ORIGIN_INVALID');
  }
  function accessContext(req: FastifyRequest) {
    return {
      agencyId: req.tenant!.id,
      agencyName: req.tenant!.name,
      origin: req.canonicalOrigin,
    };
  }
  function browserSession(req: FastifyRequest) {
    requireSameOrigin(req);
    return {
      id: browserSecretSchema.parse(req.cookies[sessionCookie]),
      csrf: browserSecretSchema.parse(req.headers['x-csrf-token']),
    };
  }
  // Starts registering. Nothing is created yet: a link is emailed, and the account exists once the
  // person opens it. The answer is the same whether or not the address already has an account.
  // A tighter limit than sign-in, since each request can send an email.
  app.post(
    '/api/v1/auth/register',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: statusResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      await access.startRegistration(accessContext(req), registrationInputSchema.parse(req.body));
      return reply.code(202).send({ status: 'verification_sent' });
    },
  );
  app.post(
    '/api/v1/auth/verify-email',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: statusResponseSchema } },
    },
    async (req) => {
      requireSameOrigin(req);
      const { token } = verifyEmailInputSchema.parse(req.body);
      await access.verifyEmail(req.tenant!.id, token, req.id);
      return { status: 'verified' };
    },
  );
  // Checks the email and password, starts the session and returns its tokens in the same response,
  // so the browser needs no second call. The session cookie is HttpOnly; the tokens are for memory.
  app.post(
    '/api/v1/auth/login',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const result = await auth.login(req.tenant!.id, loginInputSchema.parse(req.body), req.id);
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
    '/api/v1/auth/password/forgot',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: statusResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const { email } = forgotPasswordInputSchema.parse(req.body);
      await access.requestPasswordReset(accessContext(req), email);
      return reply.code(202).send({ status: 'reset_link_sent' });
    },
  );
  app.post(
    '/api/v1/auth/password/reset',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 200: statusResponseSchema } },
    },
    async (req) => {
      requireSameOrigin(req);
      const { token, password } = resetPasswordInputSchema.parse(req.body);
      await access.resetPassword(accessContext(req), token, password, req.id);
      return { status: 'password_reset' };
    },
  );
  // Restores the browser session after a reload or in a new tab. It needs only the session cookie
  // and a same-origin Origin header because it is the call that hands the browser its CSRF token.
  app.post(
    '/api/v1/auth/session',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req) => {
      requireSameOrigin(req);
      const id = browserSecretSchema.parse(req.cookies[sessionCookie]);
      return auth.bootstrap(req.tenant!.id, id, req.id);
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
