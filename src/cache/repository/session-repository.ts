import type { Redis } from 'ioredis';
import { z } from 'zod';
const sessionSchema = z.object({
  agencyId: z.uuid(),
  accountId: z.uuid(),
  accessHash: z.string(),
  csrf: z.string(),
  expiresAt: z.number(),
  claim: z.string().optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export class SessionRepository {
  constructor(private readonly redis: Redis) {}
  private key(id: string) {
    return `matrimony:session:${id}`;
  }
  /** Every live session of one account, so they can all be ended together. */
  private index(accountId: string) {
    return `matrimony:account-sessions:${accountId}`;
  }
  async put(id: string, session: Session, accessTtl: number) {
    const ttl = Math.max(1, Math.floor(session.expiresAt - Date.now() / 1000));
    const results = await this.redis
      .multi()
      .set(this.key(id), JSON.stringify(session), 'EX', ttl)
      .set(
        `matrimony:access:${session.accessHash}`,
        id,
        'EX',
        Math.max(1, Math.min(ttl, accessTtl)),
      )
      // Scored by when it was made, to the millisecond, so "oldest" is exact even when two
      // sign-ins happen in the same second.
      .zadd(this.index(session.accountId), Date.now(), id)
      .expire(this.index(session.accountId), ttl)
      .exec();
    if (!results || results.some(([err]) => err)) throw new Error('Session storage failed');
  }
  async get(id: string): Promise<Session | null> {
    const value = await this.redis.get(this.key(id));
    return value ? sessionSchema.parse(JSON.parse(value)) : null;
  }
  async forAccess(hash: string) {
    const id = await this.redis.get(`matrimony:access:${hash}`);
    if (!id) return null;
    const session = await this.get(id);
    return session?.accessHash === hash ? session : null;
  }
  async remove(id: string) {
    const session = await this.get(id);
    const multi = this.redis.multi().del(this.key(id));
    if (session) multi.zrem(this.index(session.accountId), id);
    await multi.exec();
  }
  /**
   * Ends the oldest sessions beyond `max`, so one account cannot pile up sessions without limit
   * (a person on a new phone is let in; the oldest device is signed out).
   */
  async limit(accountId: string, max: number) {
    const index = this.index(accountId);
    // Entries of sessions that have expired are older than every live one (all sessions last the
    // same time), so they are the first to go and never cost a live session its place.
    const count = await this.redis.zcard(index);
    if (count <= max) return;
    const oldest = await this.redis.zrange(index, 0, count - max - 1);
    if (oldest.length === 0) return;
    await this.redis
      .multi()
      .del(...oldest.map((id) => this.key(id)))
      .zrem(index, ...oldest)
      .exec();
  }
  /** Ends every session of an account (for example after its password was reset). */
  async removeAll(accountId: string) {
    const index = this.index(accountId);
    const ids = await this.redis.zrange(index, 0, -1);
    const multi = this.redis.multi();
    if (ids.length > 0) multi.del(...ids.map((id) => this.key(id)));
    multi.del(index);
    await multi.exec();
  }
  async claim(
    id: string,
    expectedCsrf: string,
    agencyId: string,
    claim: string,
  ): Promise<Session | null> {
    const value = await this.redis.eval(
      `
     local raw=redis.call('GET',KEYS[1]); if not raw then return nil end
     local s=cjson.decode(raw)
     if s.claim or s.csrf~=ARGV[1] or s.agencyId~=ARGV[2] then return nil end
     s.claim=ARGV[3]; redis.call('SET',KEYS[1],cjson.encode(s),'KEEPTTL'); return raw
   `,
      1,
      this.key(id),
      expectedCsrf,
      agencyId,
      claim,
    );
    return typeof value === 'string' ? sessionSchema.parse(JSON.parse(value)) : null;
  }
  async finalize(id: string, claim: string, session: Session, accessTtl: number) {
    const result = await this.redis.eval(
      `
     local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
     if cjson.decode(raw).claim~=ARGV[1] then return 0 end
     redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL')
     redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[4]); return 1
   `,
      2,
      this.key(id),
      `matrimony:access:${session.accessHash}`,
      claim,
      JSON.stringify(session),
      id,
      Math.max(1, Math.min(accessTtl, Math.floor(session.expiresAt - Date.now() / 1000))),
    );
    return result === 1;
  }
}
