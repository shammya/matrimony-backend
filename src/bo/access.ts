/**
 * Who may do what with a profile. These are the application's rules, applied before any change;
 * row-level security separately keeps every agency to its own rows.
 */
export type Role = 'admin' | 'agent' | 'member';

export interface Actor {
  accountId: string;
  role: Role;
}

export const isStaff = (role: Role) => role === 'admin' || role === 'agent';

/**
 * Whether a staff member may work on a profile at all (see it, change its status, work on an
 * assisted client's content). An admin may work on every profile of the agency. An agent only on
 * the profiles assigned to them.
 */
export function canManage(actor: Actor, profile: { assignedAgentId: string | null }): boolean {
  if (actor.role === 'admin') return true;
  return actor.role === 'agent' && profile.assignedAgentId === actor.accountId;
}

/**
 * Whether a staff member may see a request waiting for review. An admin sees every request. An
 * agent sees those for profiles assigned to them and for profiles nobody has been assigned to yet,
 * so a new member's first submission does not wait for an admin to hand it out.
 */
export function canReview(actor: Actor, profile: { assignedAgentId: string | null }): boolean {
  if (actor.role === 'admin') return true;
  return (
    actor.role === 'agent' &&
    (profile.assignedAgentId === null || profile.assignedAgentId === actor.accountId)
  );
}

/**
 * Who may decide a review. Nobody decides their own submission (a second pair of eyes), except
 * an admin, so an agency with a single admin can still run.
 */
export function mayDecideOwn(actor: Actor): boolean {
  return actor.role === 'admin';
}

/** The statuses a staff member may move a profile to, from each status. */
export const STATUS_MOVES = {
  draft: ['closed'],
  pending_review: [],
  rejected: ['closed'],
  active: ['paused', 'matched', 'closed'],
  paused: ['active', 'closed'],
  matched: ['active', 'closed'],
  closed: [],
} as const;

export type MovableStatus = keyof typeof STATUS_MOVES;
