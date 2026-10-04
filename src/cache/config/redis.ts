import { Redis } from 'ioredis';
import type { AppConfig } from '../../config/env.js';
import type { Logger } from 'pino';
export function createRedis(config: AppConfig, logger: Logger) {
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: config.IO_TIMEOUT_MS,
    commandTimeout: config.IO_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5000) + Math.floor(Math.random() * 200),
  });
  redis.on('error', () =>
    logger.error({ code: 'REDIS_CONNECTION_FAILED' }, 'Redis connection failed'),
  );
  return redis;
}
