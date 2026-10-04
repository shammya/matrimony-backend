import { z } from 'zod';

const integer = (value: number, min = 1, max = 65535) =>
  z.coerce.number().int().min(min).max(max).default(value);
const url = z.string().url();
const tenantMap = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Expected hostname-to-agency JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().regex(/^[a-z0-9.-]+$/), z.uuid()))
  .refine((v) => Object.keys(v).length > 0);
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: integer(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    DATABASE_URL: url,
    DB_POOL_MAX: integer(10, 1, 100),
    DB_CONNECT_TIMEOUT_MS: integer(5000),
    DB_STATEMENT_TIMEOUT_MS: integer(10000),
    DB_LOCK_TIMEOUT_MS: integer(3000),
    DB_SSL: z.enum(['disable', 'verify-full']).default('verify-full'),
    MONGO_URL: url,
    MONGO_DATABASE: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('matrimony_events'),
    MONGO_POOL_MAX: integer(5, 1, 50),
    IO_TIMEOUT_MS: integer(5000),
    REDIS_URL: url,
    TENANT_HOSTS: tenantMap,
    OIDC_ISSUER: url,
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_AUDIENCE: z.string().min(1),
    OIDC_SCOPE: z.string().default('openid offline_access matrimony:api'),
    OIDC_REQUIRED_SCOPE: z.string().regex(/^\S+$/).default('matrimony:api'),
    SESSION_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    SESSION_TTL_SECONDS: integer(28800, 300, 86400),
    WORKER_POLL_MS: integer(1000, 100),
    EVENT_MAX_ATTEMPTS: integer(12, 1, 100),
  })
  .superRefine((c, ctx) => {
    const protocols: [string, string, string[]][] = [
      ['DATABASE_URL', c.DATABASE_URL, ['postgres:', 'postgresql:']],
      ['REDIS_URL', c.REDIS_URL, ['redis:', 'rediss:']],
      ['MONGO_URL', c.MONGO_URL, ['mongodb:', 'mongodb+srv:']],
      ['OIDC_ISSUER', c.OIDC_ISSUER, ['https:']],
    ];
    for (const [field, value, allowed] of protocols) {
      if (!allowed.includes(new URL(value).protocol))
        ctx.addIssue({ code: 'custom', path: [field], message: 'Unsupported protocol' });
    }
    // URL SSL flags can override pg's explicit ssl object. Use only DB_SSL.
    const database = new URL(c.DATABASE_URL);
    if (['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some((k) => database.searchParams.has(k)))
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'Configure TLS with DB_SSL, not URL flags',
      });
    if (c.NODE_ENV === 'production') {
      if (c.DB_SSL !== 'verify-full')
        ctx.addIssue({ code: 'custom', path: ['DB_SSL'], message: 'Verified TLS required' });
      if (!c.REDIS_URL.startsWith('rediss:'))
        ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'TLS required' });
      const mongo = new URL(c.MONGO_URL);
      if (
        !(mongo.protocol === 'mongodb+srv:' || mongo.searchParams.get('tls') === 'true') ||
        mongo.searchParams.has('tlsAllowInvalidCertificates') ||
        mongo.searchParams.has('tlsInsecure') ||
        mongo.searchParams.has('tlsAllowInvalidHostnames') ||
        mongo.searchParams.get('tls') === 'false' ||
        mongo.searchParams.get('ssl') === 'false'
      )
        ctx.addIssue({ code: 'custom', path: ['MONGO_URL'], message: 'Verified TLS required' });
    }
  });
export type AppConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${[...new Set(result.error.issues.map((i) => i.path.join('.')))].join(', ')}`,
    );
  return Object.freeze(result.data);
}
