import type { CredentialRecord } from '../../../bo/credentials-record.js';
import type { Transaction } from '../../config/database.js';
import { credentialLookupRow } from '../../entity/credentials.js';
import { mapAccount } from '../mapper/identity.js';
import { credentialQueries } from '../query/credentials.js';

function toRecord(value: unknown): CredentialRecord {
  const row = credentialLookupRow.parse(value);
  return {
    account: mapAccount(row),
    status: row.status,
    email: row.email,
    locale: row.locale,
    passwordHash: row.password_hash,
  };
}

/** Reads and writes of passwords. Every method runs inside the transaction it is given. */
export class CredentialRepository {
  async byEmail(tx: Transaction, agencyId: string, email: string) {
    const result = await tx.query(credentialQueries.byEmail, [agencyId, email]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async byId(tx: Transaction, agencyId: string, accountId: string) {
    const result = await tx.query(credentialQueries.byId, [agencyId, accountId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async setPassword(tx: Transaction, agencyId: string, accountId: string, hash: string) {
    await tx.query(credentialQueries.setPassword, [agencyId, accountId, hash]);
  }

  /** True when the hash was replaced. */
  async rehash(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    next: string,
    expected: string,
  ) {
    const result = await tx.query(credentialQueries.rehash, [agencyId, accountId, next, expected]);
    return result.rowCount === 1;
  }
}
