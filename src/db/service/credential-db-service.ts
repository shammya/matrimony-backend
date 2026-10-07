import type { WorkflowEvent } from '../../bo/event.js';
import type { Database } from '../config/database.js';
import type { CredentialRepository } from '../raw/repository/credential-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

export class CredentialDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: CredentialRepository,
    private readonly events: EventRepository,
  ) {}

  byEmail(agencyId: string, email: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.byEmail(tx, agencyId, email));
  }

  byId(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.byId(tx, agencyId, accountId));
  }

  rehash(agencyId: string, accountId: string, next: string, expected: string) {
    return this.db.transaction(agencyId, (tx) =>
      this.repository.rehash(tx, agencyId, accountId, next, expected),
    );
  }

  /**
   * Sets a new password for an active account and records the event in the same transaction, so
   * a password never changes without a record of it. False when the account is not active.
   */
  setPasswordWithEvent(
    agencyId: string,
    accountId: string,
    hash: string,
    event: WorkflowEvent,
  ): Promise<boolean> {
    return this.db.transaction(agencyId, async (tx) => {
      const found = await this.repository.byId(tx, agencyId, accountId);
      if (!found || found.status !== 'active') return false;
      await this.repository.setPassword(tx, agencyId, accountId, hash);
      await this.events.append(tx, event);
      return true;
    });
  }
}
