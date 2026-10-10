import type { CandidateItem, CandidateState, ProposalRow } from '../../bo/candidate.js';
import type { WorkflowEvent } from '../../bo/event.js';
import type { ProfileRecord } from '../../bo/profile-state.js';
import type { VisibleField } from '../../bo/release.js';
import type { Database, Transaction } from '../config/database.js';
import type { CandidateRepository } from '../raw/repository/candidate-repository.js';
import type { EventRepository } from '../raw/repository/event-repository.js';

/** What candidate lists may do, bound to one open transaction. */
export interface CandidateUnit {
  lockClient(agencyId: string, clientId: string): Promise<ProfileRecord | null>;
  readClient(agencyId: string, clientId: string): Promise<ProfileRecord | null>;
  pool(
    agencyId: string,
    clientId: string,
    clientGender: string,
    limit: number,
  ): Promise<ProfileRecord[]>;
  saveProposals(agencyId: string, clientId: string, rows: readonly ProposalRow[]): Promise<void>;
  list(
    agencyId: string,
    clientId: string,
    state: CandidateState,
    limit: number,
    today: Date,
  ): Promise<CandidateItem[]>;
  settings(
    agencyId: string,
    clientId: string,
  ): Promise<{ cap: number; visibleFields: VisibleField[] } | null>;
  saveSettings(
    agencyId: string,
    clientId: string,
    input: { cap: number; visibleFields: readonly VisibleField[] },
    accountId: string,
  ): Promise<void>;
  releasedCount(agencyId: string, clientId: string): Promise<number>;
  releasable(agencyId: string, clientId: string, ids: readonly string[]): Promise<string[]>;
  markReleased(
    agencyId: string,
    clientId: string,
    ids: readonly string[],
    accountId: string,
  ): Promise<string[]>;
  markRemoved(
    agencyId: string,
    clientId: string,
    ids: readonly string[],
    accountId: string,
  ): Promise<string[]>;
  appendEvent(event: WorkflowEvent): Promise<void>;
}

export class CandidateDbService {
  constructor(
    private readonly db: Database,
    private readonly repository: CandidateRepository,
    private readonly events: EventRepository,
  ) {}

  /** Runs `work` in one transaction for the agency; everything in it commits or none of it does. */
  inTransaction<T>(agencyId: string, work: (unit: CandidateUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): CandidateUnit {
    const repo = this.repository;
    return {
      lockClient: (agencyId, clientId) => repo.lockClient(tx, agencyId, clientId),
      readClient: (agencyId, clientId) => repo.readClient(tx, agencyId, clientId),
      pool: (agencyId, clientId, gender, limit) => repo.pool(tx, agencyId, clientId, gender, limit),
      saveProposals: (agencyId, clientId, rows) => repo.saveProposals(tx, agencyId, clientId, rows),
      list: (agencyId, clientId, state, limit, today) =>
        repo.list(tx, agencyId, clientId, state, limit, today),
      settings: (agencyId, clientId) => repo.settings(tx, agencyId, clientId),
      saveSettings: (agencyId, clientId, input, accountId) =>
        repo.saveSettings(tx, agencyId, clientId, input, accountId),
      releasedCount: (agencyId, clientId) => repo.releasedCount(tx, agencyId, clientId),
      releasable: (agencyId, clientId, ids) => repo.releasable(tx, agencyId, clientId, ids),
      markReleased: (agencyId, clientId, ids, accountId) =>
        repo.markReleased(tx, agencyId, clientId, ids, accountId),
      markRemoved: (agencyId, clientId, ids, accountId) =>
        repo.markRemoved(tx, agencyId, clientId, ids, accountId),
      appendEvent: (event) => this.events.append(tx, event),
    };
  }
}
