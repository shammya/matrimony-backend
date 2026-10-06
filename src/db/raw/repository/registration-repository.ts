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
  async findBySubject(
    tx: Transaction,
    agencyId: string,
    issuer: string,
    subject: string,
  ): Promise<FoundAccount | null> {
    const result = await tx.query(registrationQueries.accountBySubject, [
      agencyId,
      issuer,
      subject,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = accountWithStatusRow.parse(row);
    return { account: mapAccount(parsed), status: parsed.status };
  }

  async phoneTaken(tx: Transaction, agencyId: string, phone: string): Promise<boolean> {
    const result = await tx.query(registrationQueries.accountByPhone, [agencyId, phone]);
    return result.rows.length > 0;
  }

  /** The new member, or null when the identity or the phone number already has an account. */
  async createMember(
    tx: Transaction,
    agencyId: string,
    member: { displayName: string; phone: string; issuer: string; subject: string; locale: string },
  ): Promise<Account | null> {
    const result = await tx.query(registrationQueries.insertAccount, [
      agencyId,
      member.displayName,
      member.phone,
      member.issuer,
      member.subject,
      member.locale,
    ]);
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
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
