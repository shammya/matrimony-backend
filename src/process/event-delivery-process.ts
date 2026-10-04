import type { EventDbService } from '../db/service/event-db-service.js';
import type { MongoEventService } from '../mongo/service/event-service.js';
import type { Logger } from 'pino';
export function retryDelay(attempt: number, random = Math.random) {
  return Math.floor(Math.min(300000, 1000 * 2 ** Math.min(attempt, 9)) * (0.5 + random() * 0.5));
}
export class EventDeliveryProcess {
  constructor(
    private readonly outbox: Pick<EventDbService, 'claim' | 'acknowledge' | 'retry'>,
    private readonly mongo: Pick<MongoEventService, 'store'>,
    private readonly logger: Logger,
    private readonly maxAttempts: number,
  ) {}
  async deliverOne(agencyId: string) {
    const item = await this.outbox.claim(agencyId, this.maxAttempts);
    if (!item) return false;
    try {
      await this.mongo.store(item.event);
      await this.outbox.acknowledge(item);
    } catch {
      await this.outbox.retry(item, retryDelay(item.attempts));
      this.logger.error(
        {
          eventId: item.event.id,
          agencyId,
          attempt: item.attempts,
          exhausted: item.attempts >= this.maxAttempts,
          code: 'EVENT_DELIVERY_FAILED',
        },
        'Event delivery failed',
      );
    }
    return true;
  }
}
