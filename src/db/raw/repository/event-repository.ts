import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../config/database.js';
import { eventSchema, type WorkflowEvent, type LeasedEvent } from '../../../bo/event.js';
import { eventQueries } from '../query/event.js';
export class EventRepository {
  async append(tx: Transaction, event: WorkflowEvent) {
    const safe = eventSchema.parse(event);
    await tx.query(eventQueries.append, [safe.agencyId, safe.id, safe]);
  }
  async claim(tx: Transaction, agencyId: string, maxAttempts: number): Promise<LeasedEvent | null> {
    const result = await tx.query(eventQueries.claim, [agencyId, maxAttempts, randomUUID()]);
    const row = result.rows[0];
    return row
      ? {
          event: eventSchema.parse(row.event),
          leaseToken: String(row.lease_token),
          attempts: Number(row.attempts),
        }
      : null;
  }
  async acknowledge(tx: Transaction, item: LeasedEvent) {
    await tx.query(eventQueries.acknowledge, [item.event.agencyId, item.event.id, item.leaseToken]);
  }
  async retry(tx: Transaction, item: LeasedEvent, delayMs: number) {
    await tx.query(eventQueries.retry, [
      item.event.agencyId,
      item.event.id,
      item.leaseToken,
      delayMs,
    ]);
  }
}
