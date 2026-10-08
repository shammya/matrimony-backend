import { randomBytes, randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { asciiDigits } from '../bo/phone-number.js';
import {
  PHONE_CODE_LENGTH,
  pendingPhoneSignupSchema,
  type PhonePurpose,
  type PhoneSignupInput,
} from '../bo/phone.js';
import { PRIVACY_VERSION, TERMS_VERSION, type Registration } from '../bo/registration.js';
import type { Account } from '../bo/identity.js';
import type { OneTimeTokenRepository } from '../cache/repository/one-time-token-repository.js';
import type { PhoneCodeRepository } from '../cache/repository/phone-code-repository.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import { SecretBox, digest } from '../security/secret-box.js';
import type { CredentialService } from '../service/credential-service.js';
import type { RegistrationService } from '../service/registration-service.js';
import { codeMessage } from '../sms/messages.js';
import type { SmsMessage, SmsSender } from '../sms/sender.js';
import type { AuthProcess } from './auth-process.js';

/** How long a code works. The text message states these minutes, so change both together. */
const CODE_SECONDS = 300;
/** Wrong guesses a code survives. The last one cancels it, so a new code must be asked for. */
const MAX_WRONG_GUESSES = 5;
/** The wait before another code can be sent to the same number. */
const RESEND_SECONDS = 60;
/** Codes one number can be sent per hour, and one agency per day: every text costs money. */
const CODES_PER_NUMBER_PER_HOUR = 5;
const CODES_PER_AGENCY_PER_DAY = 2000;
const PENDING_SECONDS = 600;

const secret = () => randomBytes(32).toString('base64url');

/** True when the password is the number itself, in either form (+8801712345678 or 01712345678). */
export function passwordIsPhone(password: string, phone: string): boolean {
  const typed = asciiDigits(password).replace(/[\s().+-]/g, '');
  const digits = phone.replace(/\D/g, '');
  return typed === digits || (digits.startsWith('880') && typed === `0${digits.slice(3)}`);
}

/** The agency the request is for, which the text message names. */
export interface PhoneContext {
  agencyId: string;
  agencyName: string;
}

/**
 * How checking a code ended.
 *  - `session`: the number belongs to an account, so they are signed in (the session cookie must
 *    be set).
 *  - `signup`: the number is proven but has no account, so they are asked for their name and the
 *    terms before one is created (the pending-signup cookie must be set).
 */
export type PhoneOutcome =
  | ({ kind: 'session' } & Awaited<ReturnType<AuthProcess['startSession']>>)
  | { kind: 'signup'; pendingId: string };

/**
 * Signing in, registering, and adding a number with a code sent by text message.
 *
 * - A code only proves who holds a number. After that it is our own session, exactly like any other
 *   way of signing in.
 * - A code to log in is sent only to a number with an active account; any other number is told
 *   PHONE_NOT_REGISTERED, so the person can register instead of waiting for a text that never comes.
 *   That does reveal who has an account, so the same per-number and per-address limits apply first.
 * - A code works once, for five minutes, survives five wrong guesses, and asking again replaces it.
 *   Only a keyed fingerprint of it is stored. How often codes can be sent is limited per number and
 *   per agency, since each one is a cost and a way to annoy someone.
 * - A number is never attached to an account that already exists unless that account's owner is
 *   signed in and proves the number with a code (adding a number), or has the number as their own.
 * - Nothing is created until the person agrees to the terms.
 */
export class PhoneAuthProcess {
  constructor(
    private readonly sms: SmsSender,
    private readonly codes: Pick<PhoneCodeRepository, 'put' | 'check'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit' | 'peek'>,
    private readonly tokens: Pick<OneTimeTokenRepository, 'put' | 'peek' | 'take'>,
    private readonly registrations: Pick<
      RegistrationService,
      'findByPhone' | 'registerPhone' | 'attachPhone'
    >,
    private readonly credentials: Pick<CredentialService, 'hash'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly box: SecretBox,
    private readonly logger: Logger,
    /** Calling codes (without +) whose numbers may be sent a code. Bangladesh only, by default. */
    private readonly allowedCountryCodes: readonly string[] = ['880'],
  ) {}

  private readonly sending = new Set<Promise<void>>();

  /**
   * Sends a code to log in or to register with this number. To log in, a code goes only to a
   * number that has an active account, so the login page cannot be used to make the agency pay for
   * texts to strangers; any other number gets 404 PHONE_NOT_REGISTERED (a disabled account too, so
   * that is not revealed). To register, a code goes to any allowed number.
   */
  async sendCode(context: PhoneContext, phone: string, locale: 'bn' | 'en', purpose: PhonePurpose) {
    return this.send(context, purpose, phone, locale, { onlyIfAccount: purpose === 'login' });
  }

  /** Resolves when every text handed over so far has been sent or has failed. For shutdown and tests. */
  async idle() {
    await Promise.allSettled([...this.sending]);
  }

  /** Sends a code to prove a number the signed-in account wants to add or change to. */
  async sendAttachCode(
    context: PhoneContext,
    account: Account,
    phone: string,
    locale: 'bn' | 'en',
  ) {
    return this.send(context, `add:${account.id}`, phone, locale);
  }

  /**
   * Sends a code to the signed-in account's own number, to prove it is the owner before something
   * sensitive (adding an email). The code belongs to this account and cannot sign anyone in.
   */
  async sendReauthCode(
    context: PhoneContext,
    account: Account,
    phone: string,
    locale: 'bn' | 'en',
  ) {
    return this.send(context, `reauth:${account.id}`, phone, locale);
  }

  /** Checks that code. Throws CODE_INVALID (try again) or CODE_EXPIRED (ask for a new one). */
  async checkReauthCode(agencyId: string, account: Account, phone: string, code: string) {
    await this.checkCode(this.scope(agencyId, `reauth:${account.id}`, phone), code);
  }

  /** Checks the code. A right code signs the person in, or asks them to finish registering. */
  async verifyCode(
    agencyId: string,
    phone: string,
    code: string,
    locale: 'bn' | 'en',
    purpose: PhonePurpose,
    correlationId: string,
  ): Promise<PhoneOutcome> {
    await this.checkCode(this.scope(agencyId, purpose, phone), code);
    const found = await this.registrations.findByPhone(agencyId, phone);
    if (found) {
      if (found.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
      return {
        kind: 'session',
        ...(await this.auth.startSession(agencyId, found.account, correlationId)),
      };
    }
    // No account yet, and the code was right: nothing is created until they agree to the terms.
    const pendingId = secret();
    const key = this.pendingKey(agencyId, pendingId);
    await this.tokens.put(
      'phone-signup',
      digest(`${agencyId}.${phone}`),
      key,
      this.box.seal(JSON.stringify({ phone, locale }), key),
      PENDING_SECONDS,
    );
    return { kind: 'signup', pendingId };
  }

  /** The number waiting to finish registering, for the page that asks for the name and the terms. */
  async pendingSignup(agencyId: string, pendingId: string) {
    const key = this.pendingKey(agencyId, pendingId);
    const sealed = await this.tokens.peek('phone-signup', key);
    if (!sealed) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingPhoneSignupSchema.parse(JSON.parse(this.box.open(sealed, key)));
    return { phone: pending.phone };
  }

  /**
   * Creates the account for a person who proved their number and agreed to the terms, and signs
   * them in. The step is used up first, so a double press cannot create twice. The number is the
   * one the code proved, never anything sent now.
   */
  async signup(
    agencyId: string,
    pendingId: string,
    input: PhoneSignupInput,
    correlationId: string,
  ) {
    const key = this.pendingKey(agencyId, pendingId);
    // Read first: a refused password must leave the step open for another try.
    const waiting = await this.tokens.peek('phone-signup', key);
    if (!waiting) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const pending = pendingPhoneSignupSchema.parse(JSON.parse(this.box.open(waiting, key)));
    // A password that is just the phone number is among the first things guessed.
    if (passwordIsPhone(input.password, pending.phone))
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'password', code: 'sameAsPhone' }],
      });
    const passwordHash = await this.credentials.hash(input.password);
    // Now the step is used up, so a double press cannot create two accounts.
    if (!(await this.tokens.take('phone-signup', key)))
      throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    const registration: Registration = {
      displayName: input.displayName,
      locale: pending.locale,
      onBehalfOfOther: input.onBehalfOfOther,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    };
    const created = await this.registrations.registerPhone(
      agencyId,
      { phone: pending.phone, displayName: input.displayName, passwordHash },
      registration,
      correlationId,
    );
    // Someone made an account for this number in the meantime: start again, it will sign in.
    if (!created.created) throw new AppError(409, 'PHONE_RETRY');
    this.logger.info({ code: 'PHONE_REGISTERED' }, 'A member registered with a phone number');
    return this.auth.startSession(agencyId, created.account, correlationId);
  }

  /** Adds or changes the number of the signed-in account, once its code is right. */
  async confirmAttach(
    agencyId: string,
    account: Account,
    phone: string,
    code: string,
    correlationId: string,
  ) {
    await this.checkCode(this.scope(agencyId, `add:${account.id}`, phone), code);
    const result = await this.registrations.attachPhone(agencyId, account.id, phone, correlationId);
    // They hold this number, so telling them another account has it reveals nothing they lack.
    if (result === 'taken') throw new AppError(409, 'PHONE_IN_USE');
    if (result === 'inactive') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE');
  }

  private async send(
    context: PhoneContext,
    kind: string,
    phone: string,
    locale: 'bn' | 'en',
    options: { onlyIfAccount?: boolean } = {},
  ): Promise<{ resendAfter: number; expiresIn: number }> {
    // Only the number's country decides this, so it says nothing about who has an account.
    if (!this.isAllowedCountry(phone)) throw new AppError(400, 'PHONE_COUNTRY_NOT_SUPPORTED');
    const number = digest(phone);
    const answer = { resendAfter: RESEND_SECONDS, expiresIn: CODE_SECONDS };
    // The same limits whether or not the number has an account, so numbers cannot be scanned.
    await this.limit(`phone-gap:${context.agencyId}:${number}`, 1, RESEND_SECONDS);
    await this.limit(`phone-hour:${context.agencyId}:${number}`, CODES_PER_NUMBER_PER_HOUR, 3600);
    const day = `phone-day:${context.agencyId}`;
    const spent = await this.throttle.peek(day);
    if (spent.count >= CODES_PER_AGENCY_PER_DAY)
      throw new AppError(429, 'CODE_RATE_LIMITED', { retryAfter: spent.retryAfter });

    if (options.onlyIfAccount) {
      const found = await this.registrations.findByPhone(context.agencyId, phone);
      // No account, or one that cannot sign in: nothing is sent and nothing is paid for.
      if (!found || found.status !== 'active') throw new AppError(404, 'PHONE_NOT_REGISTERED');
    }
    await this.limit(day, CODES_PER_AGENCY_PER_DAY, 86400);

    const scope = this.scope(context.agencyId, kind, phone);
    const code = String(randomInt(0, 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, '0');
    await this.codes.put(scope, this.box.mac(`${scope}.${code}`), CODE_SECONDS);
    const message = codeMessage({ to: phone, locale, agencyName: context.agencyName, code });
    if (options.onlyIfAccount) {
      this.sendInBackground(message);
      return answer;
    }
    try {
      await this.sms.send(message);
    } catch (error) {
      this.logSendFailure(error);
      throw new AppError(502, 'SMS_UNAVAILABLE');
    }
    return answer;
  }

  /** True when the number's country is one that may be sent codes. */
  private isAllowedCountry(phone: string) {
    const digits = phone.replace(/\D/g, '');
    return this.allowedCountryCodes.some((code) => digits.startsWith(code));
  }

  private sendInBackground(message: SmsMessage) {
    const attempt: Promise<void> = this.sms
      .send(message)
      .catch((error: unknown) => this.logSendFailure(error))
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }

  /** Never the number or the text: they are personal, and the text carries the code. */
  private logSendFailure(error: unknown) {
    this.logger.error(
      { code: 'SMS_SEND_FAILED', error: error instanceof Error ? error.name : 'unknown' },
      'The SMS gateway did not accept a code message',
    );
  }

  private async limit(name: string, max: number, windowSeconds: number) {
    const hits = await this.throttle.hit(name, windowSeconds);
    if (hits.count > max)
      throw new AppError(429, 'CODE_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }

  private async checkCode(scope: string, code: string) {
    const result = await this.codes.check(
      scope,
      this.box.mac(`${scope}.${code}`),
      MAX_WRONG_GUESSES,
    );
    if (result === 'ok') return;
    // A wrong code can be tried again. A code that is gone (expired, used, or cancelled by too many
    // wrong guesses) cannot, and the person must ask for a new one.
    throw new AppError(400, result === 'wrong' ? 'CODE_INVALID' : 'CODE_EXPIRED');
  }

  /** The agency is part of every key, so a code and a pending step only exist where they began. */
  private scope(agencyId: string, kind: string, phone: string) {
    return `${agencyId}:${kind}:${digest(phone)}`;
  }

  private pendingKey(agencyId: string, pendingId: string) {
    return digest(`${agencyId}.${pendingId}`);
  }
}
