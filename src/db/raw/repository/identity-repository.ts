import type { Transaction } from '../../config/database.js';
import { identityQueries } from '../query/identity.js';
import { mapAccount, mapTenant } from '../mapper/identity.js';
export class IdentityRepository {
  async tenant(tx: Transaction, agencyId: string) {
    const result = await tx.query(identityQueries.tenant, [agencyId]);
    return result.rows[0] ? mapTenant(result.rows[0]) : null;
  }
  async account(tx: Transaction, agencyId: string, issuer: string, subject: string) {
    const result = await tx.query(identityQueries.account, [agencyId, issuer, subject]);
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }
}
