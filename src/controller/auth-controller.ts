import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthProcess } from '../process/auth-process.js';
import type { AccountAccessProcess } from '../process/account-access-process.js';
import { GoogleSignInError, type GoogleAuthProcess } from '../process/google-auth-process.js';
import type { PhoneAuthProcess } from '../process/phone-auth-process.js';
import type { RegistrationService } from '../service/registration-service.js';
import {
  maskPhone,
  phoneAttachConfirmInputSchema,
  phoneAttachStartInputSchema,
  phoneSignupInputSchema,
  phoneStartInputSchema,
  phoneVerifyInputSchema,
} from '../bo/phone.js';
import {
  addEmailStartInputSchema,
  changePasswordInputSchema,
  reauthStartInputSchema,
} from '../bo/account-email.js';
import { ZodError } from 'zod';
import {
  googleLinkInputSchema,
  googleSignupInputSchema,
  googleStartInputSchema,
} from '../bo/google.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../exception/app-error.js';
import {
  authorizationResponseSchema,
  browserSecretSchema,
  methodsResponseSchema,
  codeSentResponseSchema,
  pendingLinkResponseSchema,
  pendingPhoneSignupResponseSchema,
  pendingSignupResponseSchema,
  signInMethodsResponseSchema,
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
  /** Undefined when Google sign-in is not configured. */
  google:
    | Pick<
        GoogleAuthProcess,
        'start' | 'complete' | 'pending' | 'link' | 'pendingSignup' | 'signup'
      >
    | undefined,
  /** Undefined when no SMS sender is configured. */
  phone:
    | Pick<
        PhoneAuthProcess,
        'sendCode' | 'verifyCode' | 'pendingSignup' | 'signup' | 'sendAttachCode' | 'confirmAttach'
      >
    | undefined,
  registrations: Pick<RegistrationService, 'signInMethods'>,
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
  // Coming back from Google is a cross-site navigation, so the cookie that carries the attempt
  // must be Lax to be sent. It is single use, lasts 5 minutes and is cleared when it is read.
  const challengeCookie = `${prefix}matrimony-challenge`;
  const challengeOptions = { ...cookieOptions, sameSite: 'lax' as const };
  // Holds the id of a Google link waiting for the account's password. Only this site's own pages
  // use it, so it is strict. It lasts 10 minutes.
  const linkCookie = `${prefix}matrimony-link`;
  // The same, for a person who has no account yet and is about to agree to the terms.
  const signupCookie = `${prefix}matrimony-signup`;
  const phoneOrFail = () => {
    if (!phone) throw new AppError(404, 'PHONE_NOT_CONFIGURED');
    return phone;
  };
  const googleOrFail = () => {
    if (!google) throw new AppError(404, 'GOOGLE_NOT_CONFIGURED');
    return google;
  };
  // The frontend page the browser is sent to, in the language the person was reading (or the
  // agency's when that is not known).
  function frontendPath(req: FastifyRequest, page: string, locale?: string) {
    const language = (locale ?? req.tenant?.locale) === 'en' ? 'en' : 'bn';
    return `/${language}/${page}`;
  }
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
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const { token } = verifyEmailInputSchema.parse(req.body);
      const result = await access.verifyEmail(req.tenant!.id, token, req.id);
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
  // Which ways of signing in are on, so the pages only show buttons that work.
  app.get(
    '/api/v1/auth/methods',
    { config: { public: true }, schema: { response: { 200: methodsResponseSchema } } },
    async () => ({
      password: true,
      google: google !== undefined,
      phone: phone !== undefined,
      phoneCountries: config.SMS_ALLOWED_COUNTRIES,
    }),
  );
  // Starts a Google sign-in or registration. Registering needs the same agreements as an email
  // registration, checked here before the person leaves. Nothing is created yet.
  app.post(
    '/api/v1/auth/google/start',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: authorizationResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = googleOrFail();
      const input = googleStartInputSchema.parse(req.body);
      const started = await process.start(req.tenant!.id, req.canonicalOrigin, input);
      reply.setCookie(challengeCookie, started.challengeId, { ...challengeOptions, maxAge: 300 });
      return { authorizationUrl: started.authorizationUrl };
    },
  );
  // Where Google sends the browser back. It never returns tokens: it sets the session cookie and
  // redirects to a frontend page, which fetches its tokens like after a reload. A failure goes back
  // to the login page with a stable code.
  app.get(
    '/api/v1/auth/google/callback',
    { config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req, reply) => {
      try {
        const process = googleOrFail();
        const id = browserSecretSchema.parse(req.cookies[challengeCookie]);
        reply.clearCookie(challengeCookie, challengeOptions);
        const outcome = await process.complete(
          req.tenant!.id,
          id,
          new URL(req.url, req.canonicalOrigin),
          req.id,
        );
        if (outcome.kind === 'session') {
          reply.setCookie(sessionCookie, outcome.sessionId, {
            ...cookieOptions,
            maxAge: config.SESSION_TTL_SECONDS,
          });
          return reply.redirect(frontendPath(req, 'dashboard', outcome.locale));
        }
        if (outcome.kind === 'signup') {
          reply.setCookie(signupCookie, outcome.pendingId, { ...cookieOptions, maxAge: 600 });
          return reply.redirect(frontendPath(req, 'signup-google', outcome.locale));
        }
        reply.setCookie(linkCookie, outcome.pendingId, { ...cookieOptions, maxAge: 600 });
        return reply.redirect(frontendPath(req, 'link-google', outcome.locale));
      } catch (error) {
        const code =
          error instanceof AppError
            ? error.code
            : error instanceof ZodError
              ? 'INVALID_REQUEST'
              : null;
        if (!code) throw error;
        reply.clearCookie(challengeCookie, challengeOptions);
        const locale = error instanceof GoogleSignInError ? error.locale : undefined;
        return reply.redirect(`${frontendPath(req, 'login', locale)}?error=${code}`);
      }
    },
  );
  // Whose account is waiting for its password before Google is linked to it.
  app.get(
    '/api/v1/auth/google/pending',
    {
      config: { public: true, rateLimit: { max: 20, timeWindow: 60000 } },
      schema: { response: { 200: pendingLinkResponseSchema } },
    },
    async (req) => {
      const process = googleOrFail();
      return process.pending(req.tenant!.id, browserSecretSchema.parse(req.cookies[linkCookie]));
    },
  );
  // For a person Google found no account for: who they are, and then, once they agree to the terms,
  // the account is created and they are signed in like after a login.
  app.get(
    '/api/v1/auth/google/signup',
    {
      config: { public: true, rateLimit: { max: 20, timeWindow: 60000 } },
      schema: { response: { 200: pendingSignupResponseSchema } },
    },
    async (req) => {
      const process = googleOrFail();
      return process.pendingSignup(
        req.tenant!.id,
        browserSecretSchema.parse(req.cookies[signupCookie]),
      );
    },
  );
  app.post(
    '/api/v1/auth/google/signup',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = googleOrFail();
      const input = googleSignupInputSchema.parse(req.body);
      const pendingId = browserSecretSchema.parse(req.cookies[signupCookie]);
      const result = await process.signup(req.tenant!.id, pendingId, input, req.id);
      reply.clearCookie(signupCookie, cookieOptions);
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
  // Approves the link with the account's password and signs the person in, like a login.
  app.post(
    '/api/v1/auth/google/link',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = googleOrFail();
      const { password } = googleLinkInputSchema.parse(req.body);
      const pendingId = browserSecretSchema.parse(req.cookies[linkCookie]);
      const result = await process.link(req.tenant!.id, pendingId, password, req.id);
      reply.clearCookie(linkCookie, cookieOptions);
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
  // ---- Sign in and register with a phone number and a code ----
  // Sends a code. The same answer and the same text whether or not the number has an account.
  // A tight limit by address, on top of the limits by number and by agency inside the process.
  app.post(
    '/api/v1/auth/phone/start',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: codeSentResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = phoneOrFail();
      const input = phoneStartInputSchema.parse(req.body);
      const sent = await process.sendCode(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name },
        input.phone,
        input.locale,
        input.purpose,
      );
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );
  // Checks the code. Signs in when the number has an account (200, like a login). Otherwise 202
  // and the pending-signup cookie: the person finishes on the page that asks for the terms.
  app.post(
    '/api/v1/auth/phone/verify',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema, 202: statusResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = phoneOrFail();
      const input = phoneVerifyInputSchema.parse(req.body);
      const outcome = await process.verifyCode(
        req.tenant!.id,
        input.phone,
        input.code,
        input.locale,
        input.purpose,
        req.id,
      );
      if (outcome.kind === 'signup') {
        reply.setCookie(signupCookie, outcome.pendingId, { ...cookieOptions, maxAge: 600 });
        return reply.code(202).send({ status: 'signup_required' });
      }
      reply.setCookie(sessionCookie, outcome.sessionId, {
        ...cookieOptions,
        maxAge: config.SESSION_TTL_SECONDS,
      });
      return {
        accessToken: outcome.accessToken,
        csrfToken: outcome.csrfToken,
        expiresIn: outcome.expiresIn,
      };
    },
  );
  // The proven number that has no account yet, for the page that asks for the name and the terms.
  app.get(
    '/api/v1/auth/phone/signup',
    {
      config: { public: true, rateLimit: { max: 20, timeWindow: 60000 } },
      schema: { response: { 200: pendingPhoneSignupResponseSchema } },
    },
    async (req) =>
      phoneOrFail().pendingSignup(
        req.tenant!.id,
        browserSecretSchema.parse(req.cookies[signupCookie]),
      ),
  );
  // Gives the name and agrees to the terms: the account is created and the person is signed in.
  app.post(
    '/api/v1/auth/phone/signup',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: tokensResponseSchema } },
    },
    async (req, reply) => {
      requireSameOrigin(req);
      const process = phoneOrFail();
      const input = phoneSignupInputSchema.parse(req.body);
      const pendingId = browserSecretSchema.parse(req.cookies[signupCookie]);
      const result = await process.signup(req.tenant!.id, pendingId, input, req.id);
      reply.clearCookie(signupCookie, cookieOptions);
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
  // ---- The signed-in member's own sign-in methods ----
  // These are called with the access token, so they need no cookie and no CSRF token.
  app.get(
    '/api/v1/me/sign-in-methods',
    { schema: { response: { 200: signInMethodsResponseSchema } } },
    async (req) => {
      const found = await registrations.signInMethods(req.tenant!.id, req.principal!.id);
      if (!found) throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
      return {
        email: found.email,
        emailVerified: found.emailVerified,
        phone: found.phone ? maskPhone(found.phone) : null,
        hasPassword: found.hasPassword,
        google: found.google,
      };
    },
  );
  // Sends a code to a number the member wants to add or change to.
  app.post(
    '/api/v1/me/phone/start',
    {
      config: { rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: codeSentResponseSchema } },
    },
    async (req, reply) => {
      const process = phoneOrFail();
      const input = phoneAttachStartInputSchema.parse(req.body);
      const sent = await process.sendAttachCode(
        { agencyId: req.tenant!.id, agencyName: req.tenant!.name },
        req.principal!,
        input.phone,
        input.locale,
      );
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );
  // Checks that code and makes the number the member's own, for signing in as well.
  app.post(
    '/api/v1/me/phone/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: statusResponseSchema } },
    },
    async (req) => {
      const process = phoneOrFail();
      const input = phoneAttachConfirmInputSchema.parse(req.body);
      await process.confirmAttach(req.tenant!.id, req.principal!, input.phone, input.code, req.id);
      return { status: 'phone_added' };
    },
  );
  // ---- Adding an email to a phone-only account ----
  // Step one: a code to the account's own phone, to prove it is the owner.
  app.post(
    '/api/v1/me/reauth/start',
    {
      config: { rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: codeSentResponseSchema } },
    },
    async (req, reply) => {
      const input = reauthStartInputSchema.parse(req.body);
      const sent = await access.sendReauthCode(accessContext(req), req.principal!, input.locale);
      return reply.code(202).send({ status: 'code_sent', ...sent });
    },
  );
  // Step two: with that code and the address, a link is emailed. Nothing is added yet, and the
  // answer is the same whether or not the address already belongs to an account.
  app.post(
    '/api/v1/me/email/start',
    {
      config: { rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 202: statusResponseSchema } },
    },
    async (req, reply) => {
      const input = addEmailStartInputSchema.parse(req.body);
      await access.startAddEmail(accessContext(req), req.principal!, input);
      return reply.code(202).send({ status: 'email_sent' });
    },
  );
  // A new password for the signed-in account, proved by a code sent to its own phone. It ends every
  // session, this one included, like any password reset.
  app.post(
    '/api/v1/me/password',
    {
      config: { rateLimit: { max: 10, timeWindow: 600000 } },
      schema: { response: { 200: statusResponseSchema } },
    },
    async (req) => {
      const input = changePasswordInputSchema.parse(req.body);
      await access.changePassword(accessContext(req), req.principal!, input, req.id);
      return { status: 'password_changed' };
    },
  );
  // Step three: the link, opened and confirmed on its page. Public like the other emailed links,
  // since it may be opened on another device; it signs nobody in.
  app.post(
    '/api/v1/auth/email/confirm',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: 60000 } },
      schema: { response: { 200: statusResponseSchema } },
    },
    async (req) => {
      requireSameOrigin(req);
      const { token } = verifyEmailInputSchema.parse(req.body);
      await access.confirmAddEmail(req.tenant!.id, token, req.id);
      return { status: 'email_added' };
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
