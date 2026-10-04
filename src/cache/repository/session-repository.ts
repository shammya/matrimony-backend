import type { Redis } from 'ioredis';
import { z } from 'zod';
const sessionSchema = z.object({
  agencyId: z.uuid(),
  subject: z.string(),
  issuer: z.string(),
  accountId: z.uuid(),
  refreshSecret: z.string(),
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
    await this.redis.del(this.key(id));
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
  async putChallenge(id: string, value: string) {
    await this.redis.set(`matrimony:challenge:${id}`, value, 'EX', 300);
  }
  async takeChallenge(id: string) {
    return this.redis.getdel(`matrimony:challenge:${id}`);
  }
}
