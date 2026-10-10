import type { CandidateItem, CandidateState, ProposalRow } from '../../../bo/candidate.js';
import type { ProfileRecord } from '../../../bo/profile-state.js';
import type { VisibleField } from '../../../bo/release.js';
import type { Transaction } from '../../config/database.js';
import { mapCandidate } from '../mapper/candidate.js';
import { mapProfile } from '../mapper/profile.js';
import { candidateQueries } from '../query/candidate.js';

/** Every candidate-list read and write. Each method runs inside the transaction it is given. */
export class CandidateRepository {
  /** The client, with their preferences, locked for this transaction. Null when there is no such profile. */
  async lockClient(
    tx: Transaction,
    agencyId: string,
    clientId: string,
  ): Promise<ProfileRecord | null> {
    const result = await tx.query(candidateQueries.client, [agencyId, clientId]);
    const row = result.rows[0];
    return row ? mapProfile(row, undefined, row) : null;
  }

  /** The client as above, without locking, for reading a list. */
  async readClient(
    tx: Transaction,
    agencyId: string,
    clientId: string,
  ): Promise<ProfileRecord | null> {
    const result = await tx.query(candidateQueries.clientRead, [agencyId, clientId]);
    const row = result.rows[0];
    return row ? mapProfile(row, undefined, row) : null;
  }

  /** The published profiles that may be proposed to this client, at most `limit` of them. */
  async pool(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    clientGender: string,
    limit: number,
  ): Promise<ProfileRecord[]> {
    const result = await tx.query(candidateQueries.pool, [agencyId, clientId, clientGender, limit]);
    return result.rows.map((row) => mapProfile(row, undefined, row));
  }

  /** Saves the proposals, and lets the earlier proposals that are not among them lapse. */
  async saveProposals(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    rows: readonly ProposalRow[],
  ): Promise<void> {
    if (rows.length > 0) {
      await tx.query(candidateQueries.upsert, [
        agencyId,
        clientId,
        rows.map((row) => row.candidateId),
        rows.map((row) => row.met),
        rows.map((row) => row.unmet),
        rows.map((row) => row.unknown),
        rows.map((row) => JSON.stringify({ forward: row.forward, reverse: row.reverse })),
      ]);
    }
    await tx.query(candidateQueries.lapse, [
      agencyId,
      clientId,
      rows.map((row) => row.candidateId),
    ]);
  }

  /** What staff set for this client, or null when nothing was set yet. */
  async settings(
    tx: Transaction,
    agencyId: string,
    clientId: string,
  ): Promise<{ cap: number; visibleFields: VisibleField[] } | null> {
    const result = await tx.query(candidateQueries.settings, [agencyId, clientId]);
    const row = result.rows[0] as { cap: number; visible_fields: string[] } | undefined;
    return row ? { cap: row.cap, visibleFields: row.visible_fields as VisibleField[] } : null;
  }

  async saveSettings(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    input: { cap: number; visibleFields: readonly VisibleField[] },
    accountId: string,
  ): Promise<void> {
    await tx.query(candidateQueries.saveSettings, [
      agencyId,
      clientId,
      input.cap,
      [...input.visibleFields],
      accountId,
    ]);
  }

  async releasedCount(tx: Transaction, agencyId: string, clientId: string): Promise<number> {
    const result = await tx.query(candidateQueries.releasedCount, [agencyId, clientId]);
    return (result.rows[0] as { n: number }).n;
  }

  /** Of the asked-for profiles, those that are still proposed and still published. */
  async releasable(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    const result = await tx.query(candidateQueries.releasable, [agencyId, clientId, [...ids]]);
    return result.rows.map((row) => (row as { id: string }).id);
  }

  async markReleased(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    ids: readonly string[],
    accountId: string,
  ): Promise<string[]> {
    const result = await tx.query(candidateQueries.markReleased, [
      agencyId,
      clientId,
      [...ids],
      accountId,
    ]);
    return result.rows.map((row) => (row as { id: string }).id);
  }

  async markRemoved(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    ids: readonly string[],
    accountId: string,
  ): Promise<string[]> {
    const result = await tx.query(candidateQueries.markRemoved, [
      agencyId,
      clientId,
      [...ids],
      accountId,
    ]);
    return result.rows.map((row) => (row as { id: string }).id);
  }

  async list(
    tx: Transaction,
    agencyId: string,
    clientId: string,
    state: CandidateState,
    limit: number,
    today: Date,
  ): Promise<CandidateItem[]> {
    const result = await tx.query(candidateQueries.list, [agencyId, clientId, state, limit]);
    return result.rows.map((row) => mapCandidate(row, today));
  }
}
