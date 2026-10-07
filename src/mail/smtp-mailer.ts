import nodemailer from 'nodemailer';
import type { Mailer, MailMessage } from './mailer.js';

export interface SmtpSettings {
  host: string;
  port: number;
  /**
   * `starttls`: connect, then require an upgrade to TLS before anything is sent (port 587).
   * `implicit`: TLS from the first byte (port 465). `none`: no encryption, for a local test server
   * only; the configuration refuses it in production.
   */
  tls: 'starttls' | 'implicit' | 'none';
  user?: string;
  password?: string;
  /** The sender, for example `Marriage Solution BD <no-reply@example.com>`. */
  from: string;
  timeoutMs: number;
}

/**
 * Delivers email through any SMTP service (Amazon SES, Brevo, SendGrid, Mailgun, a company mail
 * server). The certificate of the server is always checked, and a message is never sent in clear
 * text unless the settings say `none`.
 */
export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly settings: SmtpSettings) {
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.tls === 'implicit',
      requireTLS: settings.tls === 'starttls',
      ignoreTLS: settings.tls === 'none',
      ...(settings.user && settings.password
        ? { auth: { user: settings.user, pass: settings.password } }
        : {}),
      // Without these, a stuck mail server would hold a connection open for minutes.
      connectionTimeout: settings.timeoutMs,
      greetingTimeout: settings.timeoutMs,
      socketTimeout: settings.timeoutMs * 3,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      // Tells mail systems this is an automatic message, so they do not send auto-replies to it.
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
  }
}
