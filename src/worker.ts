import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createWorkerContainer } from './container.js';
import { runEventScheduler } from './scheduler/event-scheduler.js';
async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const container = await createWorkerContainer(config, logger);
  const stop = new AbortController();
  let deadline: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await runEventScheduler(
      container.delivery,
      [...new Set(Object.values(config.TENANT_HOSTS))],
      config.WORKER_POLL_MS,
      stop.signal,
      logger,
    );
  } finally {
    await container.close();
    clearTimeout(deadline);
  }
}
main().catch((error: unknown) => {
  if (error instanceof Error && error.message.startsWith('Invalid configuration:')) {
    process.stderr.write(`${error.message}\n`);
  }
  process.stderr.write('Worker startup/runtime failed. Check dependency availability.\n');
  process.exitCode = 1;
});
