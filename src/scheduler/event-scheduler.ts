import { setTimeout as delay } from 'node:timers/promises';
import type { EventDeliveryProcess } from '../process/event-delivery-process.js';
import type { Logger } from 'pino';
export async function runEventScheduler(
  delivery: EventDeliveryProcess,
  agencies: string[],
  pollMs: number,
  signal: AbortSignal,
  logger: Logger,
) {
  while (!signal.aborted) {
    for (const agency of agencies) {
      if (signal.aborted) break;
      try {
        await delivery.deliverOne(agency);
      } catch {
        logger.error(
          { agencyId: agency, code: 'EVENT_WORKER_FAILED' },
          'Event worker iteration failed',
        );
      }
    }
    try {
      await delay(pollMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
