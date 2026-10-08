import type { Account } from '../../../bo/identity.js';
import type { ConsentRecord } from '../../../bo/registration.js';
import type { Transaction } from '../../config/database.js';
import { accountRow } from '../../entity/identity.js';
import { accountWithStatusRow, signInMethodsRow } from '../../entity/registration.js';
import { mapAccount } from '../mapper/identity.js';
import { identityLinkQueries, registrationQueries } from '../query/registration.js';

/** What an account can sign in with. */
export interface SignInMethods {
  email: string | null;
  emailVerified: boolean;
  /** The number, in E.164 form, only when a code proved it. */
  phone: string | null;
  hasPassword: boolean;
  google: boolean;
}

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

  /** The account whose proven phone number this is, whatever its status. Null when none is. */
  async findByPhone(
    tx: Transaction,
    agencyId: string,
    phone: string,
  ): Promise<FoundAccount | null> {
    const result = await tx.query(registrationQueries.accountByPhone, [agencyId, phone]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = accountWithStatusRow.parse(row);
    return { account: mapAccount(parsed), status: parsed.status };
  }

  /** The new member, or null when the number already has an account. */
  async createPhoneMember(
    tx: Transaction,
    agencyId: string,
    member: { id: string; displayName: string; phone: string; locale: string },
  ): Promise<Account | null> {
    const result = await tx.query(registrationQueries.insertPhoneAccount, [
      agencyId,
      member.id,
      member.displayName,
      member.phone,
      member.locale,
    ]);
    return result.rows[0] ? mapAccount(accountRow.parse(result.rows[0])) : null;
  }

  /** True when another account already uses this number. */
  async phoneTakenByOther(
    tx: Transaction,
    agencyId: string,
    phone: string,
    accountId: string,
  ): Promise<boolean> {
    const result = await tx.query(registrationQueries.phoneTakenByOther, [
      agencyId,
      phone,
      accountId,
    ]);
    return result.rowCount === 1;
  }

  /** True when the active account now has the number. */
  async setPhone(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    phone: string,
  ): Promise<boolean> {
    const result = await tx.query(registrationQueries.setPhone, [agencyId, accountId, phone]);
    return result.rowCount === 1;
  }

  /** True when the active account, which had no email, now has this one. */
  async setEmail(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    email: string,
  ): Promise<boolean> {
    const result = await tx.query(registrationQueries.setEmail, [agencyId, accountId, email]);
    return result.rowCount === 1;
  }

  async signInMethods(
    tx: Transaction,
    agencyId: string,
    accountId: string,
  ): Promise<SignInMethods | null> {
    const result = await tx.query(registrationQueries.signInMethods, [agencyId, accountId]);
    if (!result.rows[0]) return null;
    const row = signInMethodsRow.parse(result.rows[0]);
    return {
      email: row.email,
      emailVerified: row.email_verified,
      phone: row.phone_verified ? row.phone_e164 : null,
      hasPassword: row.has_password,
      google: row.google,
    };
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

  /** The account linked to this provider identity, whatever its status. Null when none is. */
  async findByIdentity(
    tx: Transaction,
    agencyId: string,
    provider: string,
    subject: string,
  ): Promise<FoundAccount | null> {
    const result = await tx.query(identityLinkQueries.accountByIdentity, [
      agencyId,
      provider,
      subject,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = accountWithStatusRow.parse(row);
    return { account: mapAccount(parsed), status: parsed.status };
  }

  /** True when linked. False when this identity, or this provider for this account, already is. */
  async linkIdentity(
    tx: Transaction,
    agencyId: string,
    accountId: string,
    identity: { provider: string; subject: string; email: string },
  ): Promise<boolean> {
    const result = await tx.query(identityLinkQueries.insertIdentity, [
      agencyId,
      accountId,
      identity.provider,
      identity.subject,
      identity.email,
    ]);
    return result.rowCount === 1;
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
