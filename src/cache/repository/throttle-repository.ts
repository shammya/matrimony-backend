import type { Redis } from 'ioredis';

export interface Hits {
  count: number;
  /** Seconds until the window ends and the count starts again from zero. */
  retryAfter: number;
}

/**
 * Counters with a time window, for limits that depend on what is being asked for (one email
 * address) and not only on who is asking (the route-level limit by client address).
 */
export class ThrottleRepository {
  constructor(private readonly redis: Redis) {}

  private key(name: string) {
    return `matrimony:throttle:${name}`;
  }

  /** Counts one more hit. The window starts with the first hit and is not extended by later ones. */
  async hit(name: string, windowSeconds: number): Promise<Hits> {
    const result = (await this.redis.eval(
      `local n=redis.call('INCR',KEYS[1])
       if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end
       return {n, redis.call('TTL',KEYS[1])}`,
      1,
      this.key(name),
      windowSeconds,
    )) as [number, number];
    return { count: result[0], retryAfter: Math.max(1, result[1]) };
  }

  async peek(name: string): Promise<Hits> {
    const [count, ttl] = await Promise.all([
      this.redis.get(this.key(name)),
      this.redis.ttl(this.key(name)),
    ]);
    return { count: count ? Number(count) : 0, retryAfter: Math.max(1, ttl) };
  }

  async clear(name: string) {
    await this.redis.del(this.key(name));
  }
}
