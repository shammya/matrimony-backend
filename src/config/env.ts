import { z } from 'zod';
import { parseSigningKey } from '../security/access-token.js';

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
    // The key that signs access tokens: an elliptic-curve P-256 private key in PKCS#8 PEM form.
    // Generate one with `npm run auth:keygen`. Keep it out of the repository.
    AUTH_JWT_PRIVATE_KEY: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: integer(600, 60, 3600),
    // The oldest sessions of an account are ended beyond this many.
    MAX_SESSIONS_PER_ACCOUNT: integer(10, 1, 50),
    // How account emails (verification, password reset) are delivered. `console` prints them in
    // the backend's terminal, for development only. `smtp` sends through any SMTP service.
    MAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
    MAIL_FROM: z
      .string()
      // `name@example.com` or `Display Name <name@example.com>`; no line breaks, so no header injection.
      .regex(/^([^<>\r\n@]+<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/)
      .optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: integer(587),
    SMTP_TLS: z.enum(['starttls', 'implicit', 'none']).default('starttls'),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SESSION_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    SESSION_TTL_SECONDS: integer(28800, 300, 86400),
    WORKER_POLL_MS: integer(1000, 100),
    EVENT_MAX_ATTEMPTS: integer(12, 1, 100),
    // Where uploaded files (member photos) are kept. `local` is for development; `s3` works with
    // Amazon S3 and S3-compatible stores. Switching needs these values and no code change.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().min(1).default('./storage'),
    S3_BUCKET: z.string().min(3).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ENDPOINT: url.optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  })
  .superRefine((c, ctx) => {
    try {
      parseSigningKey(c.AUTH_JWT_PRIVATE_KEY);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_JWT_PRIVATE_KEY'],
        message: 'Expected an elliptic-curve P-256 private key in PKCS#8 PEM form',
      });
    }
    const protocols: [string, string, string[]][] = [
      ['DATABASE_URL', c.DATABASE_URL, ['postgres:', 'postgresql:']],
      ['REDIS_URL', c.REDIS_URL, ['redis:', 'rediss:']],
      ['MONGO_URL', c.MONGO_URL, ['mongodb:', 'mongodb+srv:']],
    ];
    for (const [field, value, allowed] of protocols) {
      if (!allowed.includes(new URL(value).protocol))
        ctx.addIssue({ code: 'custom', path: [field], message: 'Unsupported protocol' });
    }
    if (c.MAIL_DRIVER === 'smtp') {
      for (const [field, value] of [
        ['MAIL_FROM', c.MAIL_FROM],
        ['SMTP_HOST', c.SMTP_HOST],
      ] as const)
        if (!value)
          ctx.addIssue({ code: 'custom', path: [field], message: 'Required for smtp email' });
      if (Boolean(c.SMTP_USER) !== Boolean(c.SMTP_PASSWORD))
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_PASSWORD'],
          message: 'Set both the SMTP user and password, or neither',
        });
    }
    if (c.STORAGE_DRIVER === 's3') {
      if (!c.S3_BUCKET)
        ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'Required for s3 storage' });
      if (Boolean(c.S3_ACCESS_KEY_ID) !== Boolean(c.S3_SECRET_ACCESS_KEY))
        ctx.addIssue({
          code: 'custom',
          path: ['S3_SECRET_ACCESS_KEY'],
          message: 'Set both access keys or neither',
        });
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
      if (c.MAIL_DRIVER !== 'smtp')
        ctx.addIssue({
          code: 'custom',
          path: ['MAIL_DRIVER'],
          message: 'Production needs a real email delivery service, not the development console',
        });
      if (c.SMTP_TLS === 'none')
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_TLS'],
          message: 'Production email must be encrypted',
        });
      if (c.STORAGE_DRIVER !== 's3')
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message: 'Production needs shared storage (s3), not a local disk',
        });
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
