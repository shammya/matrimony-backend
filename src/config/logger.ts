import { pino } from 'pino';
import type { AppConfig } from './env.js';
export function createLogger(config: AppConfig) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'password',
        'token',
        'authorization',
        'cookie',
        'refreshToken',
        'accessToken',
        'clientSecret',
      ],
      remove: true,
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
