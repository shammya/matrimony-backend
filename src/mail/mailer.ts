export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. The links in it carry one-time secrets, so a message is never logged. */
  text: string;
}

/**
 * The boundary to whatever delivers email. A real delivery service plugs in here without any
 * other code changing; until one is chosen, development prints the message instead.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development only: prints the message (including its link) in the backend's terminal, so the
 * flow can be followed without sending email. The configuration refuses it in production.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly write: (line: string) => void) {}

  async send(message: MailMessage): Promise<void> {
    this.write(
      [
        `[dev mail] to=${message.to}`,
        `[dev mail] subject=${message.subject}`,
        ...message.text.split('\n').map((line) => `[dev mail] ${line}`),
      ].join('\n'),
    );
  }
}
