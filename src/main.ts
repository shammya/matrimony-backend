import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createApiContainer } from './container.js';
import { buildApp } from './controller/app.js';
async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const container = await createApiContainer(config, logger);
  try {
    const app = await buildApp(container);
    app.addHook('onClose', () => container.close());
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 15000);
      deadline.unref();
      try {
        await app.close();
      } catch {
        logger.error({ code: 'SHUTDOWN_FAILED' }, 'Shutdown failed');
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    };
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    await container.close();
    throw error;
  }
}
main().catch((error: unknown) => {
  if (error instanceof Error && error.message.startsWith('Invalid configuration:')) {
    process.stderr.write(`${error.message}\n`);
  }
  process.stderr.write('API startup failed. Check configuration and dependency availability.\n');
  process.exitCode = 1;
});
