import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  pendingAddEmailSchema,
  type AddEmailStartInput,
  type ChangePasswordInput,
} from '../bo/account-email.js';
import type { Account } from '../bo/identity.js';
import { passwordMatchesEmail } from '../bo/credentials.js';
import { toRegistration, registrationSchema, type RegistrationInput } from '../bo/registration.js';
import type { OneTimeTokenRepository } from '../cache/repository/one-time-token-repository.js';
import type { SessionRepository } from '../cache/repository/session-repository.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import {
  addEmailEmail,
  alreadyRegisteredEmail,
  emailInUseNotice,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
  type MailLocale,
} from '../mail/messages.js';
import type { Mailer, MailMessage } from '../mail/mailer.js';
import { SecretBox, digest } from '../security/secret-box.js';
import type { AuthProcess } from './auth-process.js';
import { passwordIsPhone, type PhoneAuthProcess } from './phone-auth-process.js';
import type { CredentialService } from '../service/credential-service.js';
import type { RegistrationService } from '../service/registration-service.js';

/** How long an emailed link works. The emails state these hours, so change both together. */
const REGISTRATION_LINK_SECONDS = 24 * 3600;
const RESET_LINK_SECONDS = 3600;
/** The link that adds an email to an account is shorter-lived: it is a sensitive change. */
const ADD_EMAIL_LINK_SECONDS = 3600;
/** Emails one address can be sent per hour for each purpose, whether or not it has an account. */
const EMAILS_PER_HOUR = 3;
const HOUR = 3600;

/** The agency the request is for, which the emails name and link back to. */
export interface AccessContext {
  agencyId: string;
  agencyName: string;
  /** The address the person's browser used, for example https://marriage.example. */
  origin: string;
}

const pendingRegistrationSchema = z.object({
  email: z.string(),
  passwordHash: z.string(),
  registration: registrationSchema,
});
const resetSchema = z.object({ accountId: z.uuid() });

const newToken = () => randomBytes(32).toString('base64url');
/** The agency is part of what is hashed, so a link only works on the agency that sent it. */
const tokenKey = (agencyId: string, token: string) => digest(`${agencyId}.${token}`);

/**
 * Registering, proving an email address, and getting back into an account.
 *
 * Every step that takes an email address answers the same way whether or not the address has an
 * account, because on a matrimony site "this person is a member" is itself private. What differs
 * goes in the email, which only the owner of the address can read.
 */
export class AccountAccessProcess {
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly registrations: Pick<
      RegistrationService,
      'emailRegistered' | 'createVerified' | 'signInMethods' | 'attachEmail'
    >,
    private readonly credentials: Pick<
      CredentialService,
      'hash' | 'findByEmail' | 'findById' | 'setPassword'
    >,
    private readonly tokens: Pick<OneTimeTokenRepository, 'put' | 'take'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly sessions: Pick<SessionRepository, 'removeAll'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly mailer: Mailer,
    private readonly box: SecretBox,
    private readonly logger: Logger,
    /** Undefined when phone codes are not set up; adding an email then is not possible. */
    private readonly phone?: Pick<PhoneAuthProcess, 'sendReauthCode' | 'checkReauthCode'>,
  ) {}

  /**
   * Step one of registering. Nothing is created: the answers and the hashed password are kept,
   * sealed, until the person opens the link sent to their email.
   */
  async startRegistration(context: AccessContext, input: RegistrationInput) {
    const scope = `${context.agencyId}:${digest(input.email)}`;
    await this.limitEmails(`register-mail:${scope}`);
    // Always done, so the time taken does not show whether the address is already registered.
    const passwordHash = await this.credentials.hash(input.password);
    const common = { to: input.email, locale: input.locale, agencyName: context.agencyName };

    if (await this.registrations.emailRegistered(context.agencyId, input.email)) {
      this.sendInBackground(
        alreadyRegisteredEmail({
          ...common,
          signInLink: this.link(context, input.locale, 'login'),
          resetLink: this.link(context, input.locale, 'forgot-password'),
        }),
      );
      return;
    }

    const token = newToken();
    const key = tokenKey(context.agencyId, token);
    const pending = { email: input.email, passwordHash, registration: toRegistration(input) };
    await this.tokens.put(
      'registration',
      scope,
      key,
      this.box.seal(JSON.stringify(pending), key),
      REGISTRATION_LINK_SECONDS,
    );
    this.sendInBackground(
      verificationEmail({
        ...common,
        name: input.displayName,
        link: this.link(context, input.locale, 'verify-email', token),
      }),
    );
  }

  /**
   * Step two: the link was opened and confirmed, so the address is proven, the account is created
   * and the person is signed in like after a login. Only the request that creates the account
   * gets a session: if the address already has one (another route, or another link), the link is
   * refused like an used one, so a link can never sign anyone into an account it did not create.
   */
  async verifyEmail(agencyId: string, token: string, correlationId: string) {
    const key = tokenKey(agencyId, token);
    const sealed = await this.tokens.take('registration', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingRegistrationSchema.parse(JSON.parse(this.box.open(sealed, key)));
    const created = await this.registrations.createVerified(agencyId, pending, correlationId);
    if (!created.created) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return this.auth.startSession(agencyId, created.account, correlationId);
  }

  /**
   * Step one of a sensitive change (adding an email, choosing a new password): a code to the
   * account's own phone, to prove it is the owner and not someone holding a stolen session.
   */
  async sendReauthCode(context: AccessContext, account: Account, locale: 'bn' | 'en') {
    const phone = this.phone ?? this.noPhone();
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (!methods?.phone) throw new AppError(409, 'PHONE_REQUIRED');
    return phone.sendReauthCode(
      { agencyId: context.agencyId, agencyName: context.agencyName },
      account,
      methods.phone,
      locale,
    );
  }

  /**
   * Step two: with the code, a link is sent to the address. Nothing is added yet: the address is
   * only proven, and added, when the link is opened. The answer is the same whether or not the
   * address already belongs to an account; that account's owner is told by email instead.
   */
  async startAddEmail(context: AccessContext, account: Account, input: AddEmailStartInput) {
    const phone = this.phone ?? this.noPhone();
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (methods?.email) throw new AppError(409, 'EMAIL_ALREADY_SET');
    if (!methods?.phone) throw new AppError(409, 'PHONE_REQUIRED');
    // The code only the owner of the phone has. A wrong one is counted and cancels the code.
    await phone.checkReauthCode(context.agencyId, account, methods.phone, input.code);

    await this.limitEmails(`add-email-mail:${context.agencyId}:${digest(input.email)}`);
    const common = { to: input.email, locale: input.locale, agencyName: context.agencyName };
    if (await this.registrations.emailRegistered(context.agencyId, input.email)) {
      this.sendInBackground(
        emailInUseNotice({ ...common, signInLink: this.link(context, input.locale, 'login') }),
      );
      return;
    }
    const token = newToken();
    const key = tokenKey(context.agencyId, token);
    // Asking again cancels the earlier link of this account, so only the newest works.
    await this.tokens.put(
      'email-add',
      account.id,
      key,
      this.box.seal(JSON.stringify({ accountId: account.id, email: input.email }), key),
      ADD_EMAIL_LINK_SECONDS,
    );
    this.sendInBackground(
      addEmailEmail({ ...common, link: this.link(context, input.locale, 'confirm-email', token) }),
    );
  }

  /**
   * Step three: the link was opened and confirmed, so the address is proven and added to the
   * account that asked. It signs nobody in: the link may be opened on another device.
   */
  async confirmAddEmail(agencyId: string, token: string, correlationId: string) {
    const key = tokenKey(agencyId, token);
    const sealed = await this.tokens.take('email-add', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingAddEmailSchema.parse(JSON.parse(this.box.open(sealed, key)));
    const result = await this.registrations.attachEmail(
      agencyId,
      pending.accountId,
      pending.email,
      correlationId,
    );
    if (result === 'taken') throw new AppError(409, 'EMAIL_IN_USE');
    if (result === 'unavailable') throw new AppError(409, 'EMAIL_ALREADY_SET');
  }

  /**
   * Sets a new password for the signed-in account, proved by a code sent to its own phone. Every
   * session of the account ends, as for any password reset, and the owner is told by email when
   * there is one.
   */
  async changePassword(
    context: AccessContext,
    account: Account,
    input: ChangePasswordInput,
    correlationId: string,
  ) {
    const phone = this.phone ?? this.noPhone();
    const methods = await this.registrations.signInMethods(context.agencyId, account.id);
    if (!methods?.phone) throw new AppError(409, 'PHONE_REQUIRED');
    // A password that is the email or the number is among the first things guessed.
    const same = methods.email && passwordMatchesEmail(input.password, methods.email);
    if (same || passwordIsPhone(input.password, methods.phone))
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'password', code: same ? 'sameAsEmail' : 'sameAsPhone' }],
      });
    await phone.checkReauthCode(context.agencyId, account, methods.phone, input.code);

    const hash = await this.credentials.hash(input.password);
    if (!(await this.credentials.setPassword(context.agencyId, account.id, hash, correlationId)))
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
    await this.sessions.removeAll(account.id);
    if (methods.email) {
      const locale =
        (await this.credentials.findById(context.agencyId, account.id))?.locale ?? 'en';
      this.sendInBackground(
        passwordChangedEmail({
          to: methods.email,
          locale,
          agencyName: context.agencyName,
          resetLink: this.link(context, locale, 'forgot-password'),
        }),
      );
    }
  }

  private noPhone(): never {
    throw new AppError(404, 'PHONE_NOT_CONFIGURED');
  }

  /** Emails a reset link when the address has an account; either way the answer is the same. */
  async requestPasswordReset(context: AccessContext, email: string) {
    const scope = `${context.agencyId}:${digest(email)}`;
    await this.limitEmails(`reset-mail:${scope}`);
    const found = await this.credentials.findByEmail(context.agencyId, email);
    if (!found || found.status !== 'active') return;

    const token = newToken();
    const key = tokenKey(context.agencyId, token);
    await this.tokens.put(
      'password-reset',
      found.account.id,
      key,
      this.box.seal(JSON.stringify({ accountId: found.account.id }), key),
      RESET_LINK_SECONDS,
    );
    this.sendInBackground(
      passwordResetEmail({
        to: email,
        locale: found.locale,
        agencyName: context.agencyName,
        link: this.link(context, found.locale, 'reset-password', token),
      }),
    );
  }

  /** Sets the new password, ends every session of the account, and tells its owner. */
  async resetPassword(
    context: AccessContext,
    token: string,
    password: string,
    correlationId: string,
  ) {
    const key = tokenKey(context.agencyId, token);
    const sealed = await this.tokens.take('password-reset', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const { accountId } = resetSchema.parse(JSON.parse(this.box.open(sealed, key)));

    const hash = await this.credentials.hash(password);
    if (!(await this.credentials.setPassword(context.agencyId, accountId, hash, correlationId)))
      throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    // Whoever knew the old password, or held a stolen session, is signed out.
    await this.sessions.removeAll(accountId);

    const account = await this.credentials.findById(context.agencyId, accountId);
    if (account?.email) {
      this.sendInBackground(
        passwordChangedEmail({
          to: account.email,
          locale: account.locale,
          agencyName: context.agencyName,
          resetLink: this.link(context, account.locale, 'forgot-password'),
        }),
      );
    }
  }

  /** Resolves when every email handed over so far has been sent or has failed. For shutdown and tests. */
  async idle() {
    await Promise.allSettled([...this.sending]);
  }

  /** 429 once one address has been sent too many emails of one kind, known or unknown alike. */
  private async limitEmails(name: string) {
    const hits = await this.throttle.hit(name, HOUR);
    if (hits.count > EMAILS_PER_HOUR)
      throw new AppError(429, 'EMAIL_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }

  private link(context: AccessContext, locale: MailLocale, page: string, token?: string) {
    const path = `${context.origin}/${locale}/${page}`;
    return token ? `${path}?token=${token}` : path;
  }

  /**
   * Sending is not waited for: the time a mail service takes would otherwise tell a stranger
   * whether the address has an account. A failure is logged, without the address or the link,
   * and the person can ask again.
   */
  private sendInBackground(message: MailMessage) {
    const attempt: Promise<void> = this.mailer
      .send(message)
      .catch(() => {
        this.logger.error({ code: 'MAIL_SEND_FAILED' }, 'An account email could not be sent');
      })
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }
}
