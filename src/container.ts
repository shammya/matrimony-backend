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
import { AccessTokens, parseSigningKey } from './security/access-token.js';
import { PasswordHasher } from './security/password-hasher.js';
import { OneTimeTokenRepository } from './cache/repository/one-time-token-repository.js';
import { ThrottleRepository } from './cache/repository/throttle-repository.js';
import { ConsoleMailer, type Mailer } from './mail/mailer.js';
import { SmtpMailer } from './mail/smtp-mailer.js';
import { CredentialRepository } from './db/raw/repository/credential-repository.js';
import { CredentialDbService } from './db/service/credential-db-service.js';
import { CredentialService } from './service/credential-service.js';
import { AccountAccessProcess } from './process/account-access-process.js';
import { GoogleAuthProcess } from './process/google-auth-process.js';
import { GoogleProvider } from './security/google-provider.js';
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
/** The console driver is for development only: the configuration refuses it in production. */
function createMailer(config: AppConfig): Mailer {
  if (config.MAIL_DRIVER === 'console')
    return new ConsoleMailer((text) =>
      process.stdout.write(`${text}
`),
    );
  return new SmtpMailer({
    host: config.SMTP_HOST!,
    port: config.SMTP_PORT,
    tls: config.SMTP_TLS,
    ...(config.SMTP_USER && config.SMTP_PASSWORD
      ? { user: config.SMTP_USER, password: config.SMTP_PASSWORD }
      : {}),
    from: config.MAIL_FROM!,
    timeoutMs: config.IO_TIMEOUT_MS * 2,
  });
}
export async function createApiContainer(config: AppConfig, logger: Logger) {
  const db = createDatabase(config, logger);
  const redis = createRedis(config, logger);
  try {
    await db.ready();
    await redis.connect();
    const storage = createFileStorage(config);
    const profiles = new ProfileService(
      new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
    );
    const identities = new IdentityService(
      new IdentityDbService(db, new IdentityRepository()),
      config.TENANT_HOSTS,
    );
    const box = new SecretBox(config.SESSION_ENCRYPTION_KEY);
    const sessions = new SessionRepository(redis);
    const throttle = new ThrottleRepository(redis);
    const credentials = new CredentialService(
      new CredentialDbService(db, new CredentialRepository(), new EventRepository()),
      new PasswordHasher(),
      logger,
    );
    const accessTokens = new AccessTokens(parseSigningKey(config.AUTH_JWT_PRIVATE_KEY));
    const auth = new AuthProcess(
      credentials,
      accessTokens,
      sessions,
      identities,
      throttle,
      new EventDbService(db, new EventRepository()),
      {
        sessionTtl: config.SESSION_TTL_SECONDS,
        accessTtl: config.ACCESS_TOKEN_TTL_SECONDS,
        maxSessions: config.MAX_SESSIONS_PER_ACCOUNT,
      },
    );
    const registrations = new RegistrationService(
      new RegistrationDbService(db, new RegistrationRepository(), new EventRepository()),
    );
    const oneTimeTokens = new OneTimeTokenRepository(redis);
    const access = new AccountAccessProcess(
      registrations,
      credentials,
      oneTimeTokens,
      throttle,
      sessions,
      auth,
      createMailer(config),
      box,
      logger,
    );
    // Sign-in with Google is on only when both settings are given.
    const google =
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? new GoogleAuthProcess(
            new GoogleProvider({
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              timeoutMs: config.IO_TIMEOUT_MS,
            }),
            sessions,
            oneTimeTokens,
            registrations,
            credentials,
            auth,
            box,
            logger,
          )
        : undefined;
    return {
      config,
      logger,
      redis,
      identities,
      auth,
      access,
      google,
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
        await access.idle();
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
