import type { ConnectionLink, MatchFilters, MatchItem, SharedContact } from '../../bo/matches.js';
import type { Cursor } from '../../bo/review.js';
import type { VisibleField } from '../../bo/release.js';
import type { Database, Transaction } from '../config/database.js';
import type { CandidateRepository } from '../raw/repository/candidate-repository.js';
import type { MatchRepository } from '../raw/repository/match-repository.js';

/** What a member's matches view may do, bound to one open transaction. */
export interface MatchUnit {
  ownProfile(agencyId: string, accountId: string): Promise<{ id: string; status: string } | null>;
  settings(
    agencyId: string,
    clientId: string,
  ): Promise<{ cap: number; visibleFields: VisibleField[] } | null>;
  releasedTotal(agencyId: string, clientId: string): Promise<number>;
  page(
    agencyId: string,
    clientId: string,
    visible: readonly VisibleField[],
    filters: MatchFilters,
    page: { limit: number; after: Cursor | null },
    today: Date,
  ): Promise<MatchItem[]>;
  person(
    agencyId: string,
    clientId: string,
    candidateId: string,
    visible: readonly VisibleField[],
    today: Date,
  ): Promise<{ item: MatchItem; link: ConnectionLink | null } | null>;
  sharedContact(agencyId: string, clientId: string, otherId: string): Promise<SharedContact | null>;
  viewablePhotoKey(agencyId: string, clientId: string, candidateId: string): Promise<string | null>;
}

export class MatchDbService {
  constructor(
    private readonly db: Database,
    private readonly matches: MatchRepository,
    private readonly candidates: CandidateRepository,
  ) {}

  /** Runs `work` in one transaction for the agency. Reads only: nothing here changes data. */
  inTransaction<T>(agencyId: string, work: (unit: MatchUnit) => Promise<T>): Promise<T> {
    return this.db.transaction(agencyId, (tx) => work(this.unit(tx)));
  }

  private unit(tx: Transaction): MatchUnit {
    return {
      ownProfile: (agencyId, accountId) => this.matches.ownProfile(tx, agencyId, accountId),
      settings: (agencyId, clientId) => this.candidates.settings(tx, agencyId, clientId),
      releasedTotal: (agencyId, clientId) => this.matches.releasedTotal(tx, agencyId, clientId),
      page: (agencyId, clientId, visible, filters, page, today) =>
        this.matches.page(tx, agencyId, clientId, visible, filters, page, today),
      person: (agencyId, clientId, candidateId, visible, today) =>
        this.matches.person(tx, agencyId, clientId, candidateId, visible, today),
      sharedContact: (agencyId, clientId, otherId) =>
        this.matches.sharedContact(tx, agencyId, clientId, otherId),
      viewablePhotoKey: (agencyId, clientId, candidateId) =>
        this.matches.viewablePhotoKey(tx, agencyId, clientId, candidateId),
    };
  }
}
