import type { Account } from '../../../bo/identity.js';
import type { ConsentRecord } from '../../../bo/registration.js';
import type { Transaction } from '../../config/database.js';
import { accountRow } from '../../entity/identity.js';
import { accountWithStatusRow } from '../../entity/registration.js';
import { mapAccount } from '../mapper/identity.js';
import { registrationQueries } from '../query/registration.js';

export interface FoundAccount {
  account: Account;
  status: 'invited' | 'active' | 'disabled';
}

/** All registration reads and writes. Every method runs inside the transaction it is given. */
export class RegistrationRepository {
  async findByEmail(
    tx: Transaction,
    agencyId: string,
    email: string,
  ): Promise<FoundAccount | null> {
    const result = await tx.query(registrationQueries.accountByEmail, [agencyId, email]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = accountWithStatusRow.parse(row);
    return { account: mapAccount(parsed), status: parsed.status };
  }

  /** The new member, or null when the email already has an account. */
  async createMember(
    tx: Transaction,
    agencyId: string,
    member: { id: string; displayName: string; email: string; locale: string },
  ): Promise<Account | null> {
    const result = await tx.query(registrationQueries.insertAccount, [
      agencyId,
      member.id,
      member.displayName,
      member.email,
      member.locale,
    ]);
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
  }

  async createCredential(tx: Transaction, agencyId: string, accountId: string, hash: string) {
    await tx.query(registrationQueries.insertCredential, [agencyId, accountId, hash]);
  }

  async recordConsents(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    consents: readonly ConsentRecord[],
  ) {
    for (const consent of consents) {
      await tx.query(registrationQueries.insertConsent, [
        agencyId,
        accountId,
        consent.purpose,
        consent.documentVersion,
      ]);
    }
  }
}
