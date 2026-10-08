import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { passwordMatchesEmail } from '../bo/credentials.js';
import type { Role } from '../bo/access.js';
import type { AcceptInvitationInput, StaffInviteInput } from '../bo/staff.js';
import type { ThrottleRepository } from '../cache/repository/throttle-repository.js';
import { AppError } from '../exception/app-error.js';
import { staffInvitationEmail } from '../mail/messages.js';
import type { Mailer, MailMessage } from '../mail/mailer.js';
import { digest } from '../security/secret-box.js';
import type { CredentialService } from '../service/credential-service.js';
import type { StaffInvitationService } from '../service/staff-invitation-service.js';
import type { AuthProcess } from './auth-process.js';

/** Invitations one admin can send or resend per hour, and emails one address can be sent per hour. */
const INVITATIONS_PER_ADMIN_PER_HOUR = 30;
const EMAILS_PER_ADDRESS_PER_HOUR = 3;
const RESENDS_PER_INVITATION_PER_HOUR = 3;
const HOUR = 3600;

/** The agency the request is for, which the email names and links back to. */
export interface InvitationContext {
  agencyId: string;
  agencyName: string;
  /** The address the admin's browser used, for example https://marriage.example. */
  origin: string;
}

/** The signed-in admin sending the invitation. */
export interface InvitationAdmin {
  id: string;
  role: Role;
  displayName: string;
}

const newToken = () => randomBytes(32).toString('base64url');
/** The agency is part of what is hashed, so a link only works on the agency that sent it. */
const linkHash = (agencyId: string, token: string) => digest(`${agencyId}.${token}`);

/**
 * Bringing staff into the agency: an admin invites a person by email, the person opens the link
 * and chooses a password, and is signed in.
 *
 * The link's secret is random and only its hash is stored. A failure to send the email is logged
 * without the address or the link, and the admin can send the invitation again.
 */
export class StaffInvitationProcess {
  private readonly sending = new Set<Promise<void>>();

  constructor(
    private readonly invitations: Pick<
      StaffInvitationService,
      'invite' | 'reissue' | 'open' | 'revoke' | 'preview' | 'accept'
    >,
    private readonly credentials: Pick<CredentialService, 'hash'>,
    private readonly auth: Pick<AuthProcess, 'startSession'>,
    private readonly throttle: Pick<ThrottleRepository, 'hit'>,
    private readonly mailer: Mailer,
    private readonly logger: Logger,
  ) {}

  async invite(
    context: InvitationContext,
    admin: InvitationAdmin,
    input: StaffInviteInput,
    correlationId: string,
  ) {
    this.requireAdmin(admin);
    await this.limit(
      `staff-invite:${context.agencyId}:${admin.id}`,
      INVITATIONS_PER_ADMIN_PER_HOUR,
    );
    await this.limit(
      `staff-invite-mail:${context.agencyId}:${digest(input.email)}`,
      EMAILS_PER_ADDRESS_PER_HOUR,
    );
    const token = newToken();
    const invitation = await this.invitations.invite(
      this.actor(context, admin),
      input,
      linkHash(context.agencyId, token),
      correlationId,
    );
    this.sendLink(context, admin, invitation, token);
    return invitation;
  }

  /** A new link for an open invitation; the earlier link stops working. */
  async resend(
    context: InvitationContext,
    admin: InvitationAdmin,
    invitationId: string,
    correlationId: string,
  ) {
    this.requireAdmin(admin);
    await this.limit(
      `staff-invite:${context.agencyId}:${admin.id}`,
      INVITATIONS_PER_ADMIN_PER_HOUR,
    );
    await this.limit(
      `staff-invite-resend:${context.agencyId}:${invitationId}`,
      RESENDS_PER_INVITATION_PER_HOUR,
    );
    const token = newToken();
    const invitation = await this.invitations.reissue(
      this.actor(context, admin),
      invitationId,
      linkHash(context.agencyId, token),
      correlationId,
    );
    this.sendLink(context, admin, invitation, token);
    return invitation;
  }

  list(context: InvitationContext, admin: InvitationAdmin) {
    return this.invitations.open(this.actor(context, admin));
  }

  revoke(
    context: InvitationContext,
    admin: InvitationAdmin,
    invitationId: string,
    correlationId: string,
  ) {
    return this.invitations.revoke(this.actor(context, admin), invitationId, correlationId);
  }

  /** What the link is for, so the page can greet the person. Does not use the link up. */
  async preview(agencyId: string, token: string) {
    const found = await this.invitations.preview(agencyId, linkHash(agencyId, token));
    if (!found) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return found;
  }

  /** Creates the account, with the role the admin chose, and signs the person in. */
  async accept(agencyId: string, input: AcceptInvitationInput, correlationId: string) {
    const hash = linkHash(agencyId, input.token);
    const found = await this.invitations.preview(agencyId, hash);
    if (!found) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    // A password that is the email is among the first things guessed.
    if (passwordMatchesEmail(input.password, found.email))
      throw new AppError(400, 'INVALID_REQUEST', {
        fields: [{ path: 'password', code: 'sameAsEmail' }],
      });
    const account = await this.invitations.accept(
      agencyId,
      hash,
      await this.credentials.hash(input.password),
      correlationId,
    );
    if (!account) throw new AppError(400, 'LINK_INVALID_OR_EXPIRED');
    return this.auth.startSession(agencyId, account, correlationId);
  }

  /** Resolves when every email handed over so far has been sent or has failed. For shutdown and tests. */
  async idle() {
    await Promise.allSettled([...this.sending]);
  }

  private actor(context: InvitationContext, admin: InvitationAdmin) {
    return { agencyId: context.agencyId, accountId: admin.id, role: admin.role };
  }

  private requireAdmin(admin: InvitationAdmin) {
    if (admin.role !== 'admin') throw new AppError(403, 'ROLE_FORBIDDEN');
  }

  private async limit(name: string, max: number) {
    const hits = await this.throttle.hit(name, HOUR);
    if (hits.count > max)
      throw new AppError(429, 'EMAIL_RATE_LIMITED', { retryAfter: hits.retryAfter });
  }

  private sendLink(
    context: InvitationContext,
    admin: InvitationAdmin,
    invitation: {
      email: string;
      displayName: string;
      role: 'admin' | 'agent';
      locale: 'bn' | 'en';
    },
    token: string,
  ) {
    this.sendInBackground(
      staffInvitationEmail({
        to: invitation.email,
        locale: invitation.locale,
        agencyName: context.agencyName,
        name: invitation.displayName,
        role: invitation.role,
        invitedBy: admin.displayName,
        link: `${context.origin}/${invitation.locale}/accept-invite?token=${token}`,
      }),
    );
  }

  /** Not waited for, so a slow mail service does not slow the admin's page. A failure is logged. */
  private sendInBackground(message: MailMessage) {
    const attempt: Promise<void> = this.mailer
      .send(message)
      .catch(() => {
        this.logger.error({ code: 'MAIL_SEND_FAILED' }, 'An invitation email could not be sent');
      })
      .finally(() => this.sending.delete(attempt));
    this.sending.add(attempt);
  }
}
