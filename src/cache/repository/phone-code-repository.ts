import type { Redis } from 'ioredis';

export type CodeCheck = 'ok' | 'wrong' | 'locked' | 'none';

/**
 * One-time codes sent by text message. Only a keyed fingerprint of the code is stored, the code
 * expires on its own, and asking for a new one replaces (and so cancels) the earlier one. Wrong
 * guesses are counted with the code, so a code cannot be guessed however often it is tried.
 */
export class PhoneCodeRepository {
  constructor(private readonly redis: Redis) {}

  private key(scope: string) {
    return `matrimony:phone-code:${scope}`;
  }

  async put(scope: string, fingerprint: string, ttlSeconds: number) {
    const results = await this.redis
      .multi()
      .del(this.key(scope))
      .hset(this.key(scope), 'h', fingerprint, 'n', 0)
      .expire(this.key(scope), ttlSeconds)
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error('Code storage failed');
  }

  /**
   * Checks a guess in one atomic step. A right guess uses the code up. The wrong guess that reaches
   * `maxWrong` cancels it, so the person must ask for a new one.
   */
  async check(scope: string, fingerprint: string, maxWrong: number): Promise<CodeCheck> {
    const result = await this.redis.eval(
      `local stored = redis.call('HGET', KEYS[1], 'h')
       if not stored then return 'none' end
       if stored == ARGV[1] then redis.call('DEL', KEYS[1]) return 'ok' end
       local wrong = redis.call('HINCRBY', KEYS[1], 'n', 1)
       if wrong >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) return 'locked' end
       return 'wrong'`,
      1,
      this.key(scope),
      fingerprint,
      maxWrong,
    );
    return result as CodeCheck;
  }
}
