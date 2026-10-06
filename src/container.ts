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
import { RegistrationRepository } from './db/raw/repository/registration-repository.js';
import { RegistrationDbService } from './db/service/registration-db-service.js';
import { RegistrationService } from './service/registration-service.js';
import { ReviewRepository } from './db/raw/repository/review-repository.js';
import { ReviewDbService } from './db/service/review-db-service.js';
import { ReviewService } from './service/review-service.js';
import { ReviewProcess } from './process/review-process.js';
import { ClientRepository } from './db/raw/repository/client-repository.js';
import { ClientDbService } from './db/service/client-db-service.js';
import { ClientService } from './service/client-service.js';
import { EventDeliveryProcess } from './process/event-delivery-process.js';
export async function createApiContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const redis = createRedis(config, logger);
  try {
    await db.ready();
    await redis.connect();
    const { provider, jwksUri } = await OidcProvider.discover(config);
    const storage = createFileStorage(config);
    const profiles = new ProfileService(
      new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
    );
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
      new RegistrationService(
        new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
      ),
      new EventDbService(db, new EventRepository()),
      new SecretBox(config.SESSION_ENCRYPTION_KEY),
      config.SESSION_TTL_SECONDS,
      logger,
    );
    return {
      config,
      logger,
      redis,
      // Development only. Never set in production: the configuration refuses it there.
      devSms:
        config.NODE_ENV !== 'production' && config.DEV_SMS_SINK_SECRET
          ? {
              secret: config.DEV_SMS_SINK_SECRET,
              write: (line: string) => process.stdout.write(`${line}\n`),
            }
          : undefined,
      identities,
      auth,
      photos: new PhotoProcess(
        new PhotoService(new PhotoDbService(db, new PhotoRepository(), new EventRepository())),
        storage,
        processImage,
        logger,
      ),
      profiles,
      reviews: new ReviewProcess(
        new ReviewService(
          new ReviewDbService(
            db,
            new ReviewRepository(),
            new ProfileRepository(),
            new EventRepository(),
          ),
        ),
        storage,
      ),
      clients: new ClientService(
        new ClientDbService(db, new ClientRepository(), new EventRepository()),
        profiles,
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
