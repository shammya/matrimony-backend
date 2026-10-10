import { DEFAULT_VISIBLE_FIELDS, type VisibleField } from '../bo/release.js';
import {
  PREVIEW_FIELDS,
  hiddenFilters,
  type MatchPage,
  type MatchQuery,
  type ProfileDetail,
} from '../bo/matches.js';
import { decodeCursor, encodeCursor } from '../bo/review.js';
import type { MatchDbService, MatchUnit } from '../db/service/match-db-service.js';
import { AppError } from '../exception/app-error.js';
import type { ProfileActor } from './profile-service.js';

/**
 * A client's own matches (slices 3.D and 3.E, docs/features/discovery-loop.md).
 *
 * - Only a member sees this, and only through their own profile. Staff and other members get 403.
 * - Only profiles staff released into this member's window, and still published, are listed. A
 *   profile can also be looked at by someone who asked to connect with this member and is waiting
 *   for an answer, and by someone this member is connected to. Nothing else is reachable.
 * - Each profile carries only the fields staff allowed for this member (or the defaults when staff
 *   set nothing). Those are the only columns read, and contact details are not among the choices.
 *   The list is a preview of a few headline fields; the full view shows every allowed field.
 * - A search filter on a field the member may not see is refused: otherwise a hidden value could be
 *   found out by filtering for it.
 * - Contact details are shown only when the other person chose to share them after the connection was
 *   accepted.
 * - A member whose own profile is not published yet gets an empty window and their status, so the
 *   page can say what to wait for.
 */
export class MatchService {
  constructor(
    private readonly db: Pick<MatchDbService, 'inTransaction'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async page(actor: ProfileActor, query: MatchQuery): Promise<MatchPage> {
    this.requireMember(actor);
    const after = query.after ? decodeCursor(query.after) : null;
    if (query.after && !after) throw new AppError(400, 'INVALID_REQUEST');
    const { limit, after: _cursor, ...filters } = query;
    void _cursor;

    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own) {
        return { items: [], next: null, profileStatus: null, releasedTotal: 0, visibleFields: [] };
      }
      if (own.status !== 'active') {
        return {
          items: [],
          next: null,
          profileStatus: own.status,
          releasedTotal: 0,
          visibleFields: [],
        };
      }
      const visible = await this.visibleFields(unit, actor.agencyId, own.id);
      const hidden = hiddenFilters(filters, visible);
      if (hidden.length > 0) {
        throw new AppError(400, 'FILTER_NOT_AVAILABLE', {
          fields: hidden.map((path) => ({ path, code: 'notAvailable' })),
        });
      }
      const preview = visible.filter((field) => PREVIEW_FIELDS.includes(field));
      const rows = await unit.page(
        actor.agencyId,
        own.id,
        preview,
        filters,
        { limit, after },
        this.now(),
      );
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        next:
          rows.length > limit && last
            ? encodeCursor({ createdAt: last.position, id: last.candidateId })
            : null,
        profileStatus: own.status,
        releasedTotal: await unit.releasedTotal(actor.agencyId, own.id),
        visibleFields: [...visible],
      };
    });
  }

  /** The full view of one profile, with where the connection with them stands. */
  async detail(actor: ProfileActor, candidateId: string): Promise<ProfileDetail> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own || own.status !== 'active') throw new AppError(404, 'PROFILE_NOT_FOUND');
      const visible = await this.visibleFields(unit, actor.agencyId, own.id);
      const found = await unit.person(actor.agencyId, own.id, candidateId, visible, this.now());
      if (!found) throw new AppError(404, 'PROFILE_NOT_FOUND');
      const contact = found.link?.theyShared
        ? await unit.sharedContact(actor.agencyId, own.id, candidateId)
        : null;
      return {
        profile: found.item,
        connection: found.link,
        contact,
        visibleFields: [...visible],
      };
    });
  }

  /** The storage key of a profile's photo, if staff allow the member to see photos and may look at it. */
  async photoKey(actor: ProfileActor, candidateId: string): Promise<{ storageKey: string }> {
    this.requireMember(actor);
    return this.db.inTransaction(actor.agencyId, async (unit) => {
      const own = await unit.ownProfile(actor.agencyId, actor.accountId);
      if (!own || own.status !== 'active') throw new AppError(404, 'PHOTO_NOT_FOUND');
      const visible = await this.visibleFields(unit, actor.agencyId, own.id);
      if (!visible.includes('photo')) throw new AppError(404, 'PHOTO_NOT_FOUND');
      const key = await unit.viewablePhotoKey(actor.agencyId, own.id, candidateId);
      if (!key) throw new AppError(404, 'PHOTO_NOT_FOUND');
      return { storageKey: key };
    });
  }

  private async visibleFields(
    unit: MatchUnit,
    agencyId: string,
    clientId: string,
  ): Promise<readonly VisibleField[]> {
    const saved = await unit.settings(agencyId, clientId);
    return saved?.visibleFields ?? DEFAULT_VISIBLE_FIELDS;
  }

  private requireMember(actor: ProfileActor) {
    if (actor.role !== 'member') throw new AppError(403, 'ROLE_FORBIDDEN');
  }
}
