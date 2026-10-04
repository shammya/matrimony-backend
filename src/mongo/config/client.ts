import { MongoClient } from 'mongodb';
import type { AppConfig } from '../../config/env.js';
export function createMongo(config: AppConfig) {
  return new MongoClient(config.MONGO_URL, {
    maxPoolSize: config.MONGO_POOL_MAX,
    minPoolSize: 0,
    serverSelectionTimeoutMS: config.IO_TIMEOUT_MS,
    connectTimeoutMS: config.IO_TIMEOUT_MS,
    socketTimeoutMS: config.IO_TIMEOUT_MS,
    waitQueueTimeoutMS: config.IO_TIMEOUT_MS,
    timeoutMS: config.IO_TIMEOUT_MS,
    retryWrites: true,
    appName: 'matrimony-event-worker',
  });
}
