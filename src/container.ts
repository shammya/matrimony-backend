import type { AppConfig } from './config/env.js';
import type { Logger } from 'pino';
import { createDatabase } from './db/config/database.js';
import { IdentityRepository } from './db/raw/repository/identity-repository.js';
import { IdentityDbService } from './db/service/identity-db-service.js';
import { EventRepository } from './db/raw/repository/event-repository.js';
import { EventDbService } from './db/service/event-db-service.js';
import { IdentityService } from './service/identity-service.js';
import { createRedis } from './cache/config/redis.js';
import { SessionRepository } from './cache/repository/session-repository.js';
import { OidcProvider } from './security/oidc-provider.js';
import { JwtVerifier } from './security/jwt-verifier.js';
import { SecretBox } from './security/secret-box.js';
import { AuthProcess } from './process/auth-process.js';
import { createMongo } from './mongo/config/client.js';
import { MongoEventRepository } from './mongo/repository/event-repository.js';
import { MongoEventService } from './mongo/service/event-service.js';
import type { EventDocument } from './mongo/entity/workflow-event.js';
import { ProfileRepository } from './db/raw/repository/profile-repository.js';
import { ProfileDbService } from './db/service/profile-db-service.js';
import { ProfileService } from './service/profile-service.js';
import { PhotoRepository } from './db/raw/repository/photo-repository.js';
import { PhotoDbService } from './db/service/photo-db-service.js';
import { PhotoService } from './service/photo-service.js';
import { PhotoProcess } from './process/photo-process.js';
import { processImage } from './security/image-processor.js';
import { createFileStorage } from './storage/config/storage.js';
import { EventDeliveryProcess } from './process/event-delivery-process.js';
export async function createApiContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const redis = createRedis(config, logger);
  try {
    await db.ready();
    await redis.connect();
    const { provider, jwksUri } = await OidcProvider.discover(config);
    const identities = new IdentityService(
      new IdentityDbService(db, new IdentityRepository()),
      config.TENANT_HOSTS,
    );
    const auth = new AuthProcess(
      provider,
      JwtVerifier.remote(
        jwksUri,
        config.OIDC_ISSUER,
        config.OIDC_AUDIENCE,
        config.OIDC_REQUIRED_SCOPE,
        config.IO_TIMEOUT_MS,
      ),
      new SessionRepository(redis),
      identities,
      new EventDbService(db, new EventRepository()),
      new SecretBox(config.SESSION_ENCRYPTION_KEY),
      config.SESSION_TTL_SECONDS,
      logger,
    );
    return {
      config,
      logger,
      redis,
      identities,
      auth,
      photos: new PhotoProcess(
        new PhotoService(new PhotoDbService(db, new PhotoRepository(), new EventRepository())),
        createFileStorage(config),
        processImage,
        logger,
      ),
      profiles: new ProfileService(
        new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
      ),
      ready: async () => {
        await db.ping();
        await redis.ping();
      },
      close: async () => {
        redis.disconnect();
        await db.close();
      },
    };
  } catch (error) {
    redis.disconnect();
    await db.close();
    throw error;
  }
}
export async function createWorkerContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const mongo = createMongo(config);
  try {
    await db.ready();
    await mongo.connect();
    const repository = new MongoEventRepository(
      mongo.db(config.MONGO_DATABASE).collection<EventDocument>('workflow_events'),
    );
    await repository.ready();
    return {
      delivery: new EventDeliveryProcess(
        new EventDbService(db, new EventRepository()),
        new MongoEventService(repository),
        logger,
        config.EVENT_MAX_ATTEMPTS,
      ),
      close: async () => {
        await mongo.close();
        await db.close();
      },
    };
  } catch (error) {
    await mongo.close();
    await db.close();
    throw error;
  }
}
