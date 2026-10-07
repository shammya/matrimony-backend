import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto';

/**
 * Password hashing with Argon2id (OWASP's first choice), using Node's built-in implementation,
 * so there is no native add-on to build or patch.
 *
 * Hashes are stored as PHC strings (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). The parameters live
 * inside each hash, so they can be raised later: `needsRehash` tells the login to store a stronger
 * hash the next time the person signs in with the right password.
 */
export interface HashParameters {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

/** OWASP minimum for Argon2id: 19 MiB, 2 passes, 1 lane (about tens of milliseconds a hash). */
export const DEFAULT_PARAMETERS: HashParameters = { memory: 19456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

const derive = (
  password: string,
  nonce: Buffer,
  parameters: HashParameters,
  tagLength: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const options: Argon2Parameters = {
      message: Buffer.from(password, 'utf8'),
      nonce,
      memory: parameters.memory,
      passes: parameters.passes,
      parallelism: parameters.parallelism,
      tagLength,
    };
    argon2('argon2id', options, (error, key) => (error ? reject(error) : resolve(key)));
  });

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

interface Parsed {
  parameters: HashParameters;
  salt: Buffer;
  tag: Buffer;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function parse(stored: string): Parsed | null {
  const match = PHC.exec(stored);
  if (!match) return null;
  const [, memory, passes, parallelism, salt, tag] = match;
  const parameters = {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
  };
  // A corrupted or hostile value must not make the server allocate gigabytes.
  if (
    parameters.memory < 8 ||
    parameters.memory > 262144 ||
    parameters.passes < 1 ||
    parameters.passes > 10 ||
    parameters.parallelism < 1 ||
    parameters.parallelism > 8
  )
    return null;
  return { parameters, salt: Buffer.from(salt!, 'base64'), tag: Buffer.from(tag!, 'base64') };
}

export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  constructor(private readonly parameters: HashParameters = DEFAULT_PARAMETERS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, this.parameters, TAG_BYTES);
    const { memory, passes, parallelism } = this.parameters;
    return `$argon2id$v=${VERSION}$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
  }

  /** True when the password matches. A malformed stored value simply does not match. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const tag = await derive(password, parsed.salt, parsed.parameters, parsed.tag.length);
    return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
  }

  /** True when the stored hash was made with weaker settings than the current ones. */
  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const { memory, passes, parallelism } = parsed.parameters;
    return (
      memory < this.parameters.memory ||
      passes < this.parameters.passes ||
      parallelism !== this.parameters.parallelism
    );
  }

  /**
   * Does the same work as a real check against a hash nobody can match. Login calls it when the
   * email is unknown, so the response time does not reveal whether an account exists.
   */
  async verifyAgainstNothing(password: string): Promise<false> {
    this.dummy ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(password, await this.dummy);
    return false;
  }
}
