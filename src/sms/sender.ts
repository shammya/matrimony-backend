export interface SmsMessage {
  /** The number in E.164 form. */
  to: string;
  /** Plain text. It carries a one-time code, so a message is never logged. */
  text: string;
}

/**
 * The boundary to whatever delivers text messages. A real gateway plugs in here without any other
 * code changing; until one is chosen, development prints the message instead. An implementation
 * must time out, and must throw when the gateway did not accept the message.
 */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/**
 * Development only: prints the message (including its code) in the backend's terminal, so the
 * flow can be followed without sending a text. The configuration refuses it in production.
 */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly write: (line: string) => void) {}

  async send(message: SmsMessage): Promise<void> {
    this.write(
      [`[dev sms] to=${message.to}`, ...message.text.split('\n').map((l) => `[dev sms] ${l}`)].join(
        '\n',
      ),
    );
  }
}
