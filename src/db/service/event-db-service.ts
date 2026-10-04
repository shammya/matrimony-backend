import type { Database, Transaction } from '../config/database.js';
import type { EventRepository } from '../raw/repository/event-repository.js';
import type { WorkflowEvent, LeasedEvent } from '../../bo/event.js';
export class EventDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: EventRepository,
  ) {}
  // A domain process supplies its existing transaction so event and mutation commit together.
  append(tx: Transaction, event: WorkflowEvent) {
    return this.repository.append(tx, event);
  }
  record(event: WorkflowEvent) {
    return this.db.transaction(event.agencyId, (tx) => this.append(tx, event));
  }
  claim(agencyId: string, maxAttempts: number) {
    return this.db.transaction(agencyId, (tx) => this.repository.claim(tx, agencyId, maxAttempts));
  }
  acknowledge(item: LeasedEvent) {
    return this.db.transaction(item.event.agencyId, (tx) => this.repository.acknowledge(tx, item));
  }
  retry(item: LeasedEvent, delay: number) {
    return this.db.transaction(item.event.agencyId, (tx) => this.repository.retry(tx, item, delay));
  }
}
