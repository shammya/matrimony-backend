import type { Database } from '../config/database.js';
import type { IdentityRepository } from '../raw/repository/identity-repository.js';
export class IdentityDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: IdentityRepository,
  ) {}
  tenant(agencyId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.tenant(tx, agencyId));
  }
  account(agencyId: string, accountId: string) {
    return this.db.transaction(agencyId, (tx) => this.repository.account(tx, agencyId, accountId));
  }
}
