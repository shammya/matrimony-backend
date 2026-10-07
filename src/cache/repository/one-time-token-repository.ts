import type { Redis } from 'ioredis';

export type TokenPurpose = 'registration' | 'password-reset';

/**
 * Single-use secrets that travel by email (a link to open). Only the SHA-256 of the secret is
 * used as the Redis key, so a copy of Redis cannot be used to open a link, and the stored payload
 * is sealed by the caller. A token expires on its own, and can be taken only once.
 */
export class OneTimeTokenRepository {
  constructor(private readonly redis: Redis) {}

  private key(purpose: TokenPurpose, digest: string) {
    return `matrimony:otk:${purpose}:${digest}`;
  }

  /** Points at the newest token for one subject, so asking again cancels the earlier link. */
  private latest(purpose: TokenPurpose, scope: string) {
    return `matrimony:otk-latest:${purpose}:${scope}`;
  }

  /**
   * Stores a token. Any earlier token for the same `scope` (an account or an email) stops
   * working, so only the most recent link is ever valid.
   */
  async put(
    purpose: TokenPurpose,
    scope: string,
    digest: string,
    sealed: string,
    ttlSeconds: number,
  ) {
    const pointer = this.latest(purpose, scope);
    const previous = await this.redis.get(pointer);
    const multi = this.redis.multi();
    if (previous && previous !== digest) multi.del(this.key(purpose, previous));
    multi.set(this.key(purpose, digest), sealed, 'EX', ttlSeconds);
    multi.set(pointer, digest, 'EX', ttlSeconds);
    const results = await multi.exec();
    if (!results || results.some(([error]) => error)) throw new Error('Token storage failed');
  }

  /** Returns the stored payload and removes it in one step, or null if it is unknown or expired. */
  take(purpose: TokenPurpose, digest: string): Promise<string | null> {
    return this.redis.getdel(this.key(purpose, digest));
  }
}
