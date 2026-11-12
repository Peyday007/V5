/**
 * The alternatives a commitment may be moved to when its dependency is down
 * or its account is suspended (CONT-35, S-0485).
 *
 * `planContinuation` can move a commitment only to an alternative somebody
 * declared permitted — and, for a supplier, contractually workable — because
 * an unknown is never a yes (invariant 39). Before this module the send path
 * named no alternative at all, so REROUTE could never be decided and the two
 * S-0485 clauses it serves were owned in name only.
 *
 * A declaration is a person's statement, kept as an append-only cash event
 * (`ALTERNATIVE_DECLARED_KIND`): which action, which alternative namespace
 * (`<primary>.via.<name>`, served by its own registered adapter), the channel
 * it reaches people through, and whether it is permitted and contractually
 * workable. The latest statement for one namespace governs; one made for a
 * single opportunity governs that opportunity over a project-wide one. No
 * table, store or scheduler of its own (§10.3, §20.4), and no kind of channel,
 * supplier or industry is a whitelist (R01-A1): the alternatives are whatever a
 * person declared.
 *
 * What is read back is what the planner needs, with what only the running
 * Brain can know filled in from its own rows: the alternative's health from
 * the same ledger `namespaceHealth` reads, and whether a usable adapter is
 * registered for it now (`performable`), so a reroute is only ever decided
 * towards something Brain can actually send through.
 */
import { cashEventsOfKindInProject, recordCashEvent } from '../../repos/cashMode.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { namespaceHealth, type ContinuationAlternative } from '../effects/posture.ts';
import {
  ALTERNATIVE_DECLARED_KIND,
  COMMERCIAL_EFFECTS,
  isAlternativeNamespaceFor,
  isPerformable,
  performedNamespace,
  usableAdapter,
  type PerformableAction,
} from './effects.ts';
import type { CashEvent } from '../../domain/types.ts';
import type { Outcome } from './opportunities.ts';

export interface AlternativeDeclaration {
  action: PerformableAction;
  namespace: string;
  channel: string | null;
  permitted: boolean | null;
  contractuallyWorkable: boolean | null;
  requiresContract: boolean;
  /** Null: project-wide. */
  opportunityId: string | null;
  note: string;
  declaredBy: string;
  declaredAt: string;
}

function triState(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function declarationOf(event: CashEvent): AlternativeDeclaration | null {
  const d = event.detail;
  const action = d['action'];
  const namespace = d['namespace'];
  if (typeof action !== 'string' || !isPerformable(action)) return null;
  if (typeof namespace !== 'string' || !isAlternativeNamespaceFor(action, namespace)) return null;
  return {
    action,
    namespace,
    channel: typeof d['channel'] === 'string' && d['channel'].trim() ? d['channel'].trim().toLowerCase() : null,
    permitted: triState(d['permitted']),
    contractuallyWorkable: triState(d['contractuallyWorkable']),
    requiresContract: d['requiresContract'] === true,
    opportunityId: event.opportunityId,
    note: typeof d['note'] === 'string' ? d['note'] : '',
    declaredBy: event.actorRef,
    declaredAt: event.createdAt,
  };
}

/**
 * The channel an action's own namespace reaches people through, in the words a
 * declaration uses. Reaching a buyer is one email to the one address the
 * buyer published (`outreach.ts` refuses anything else), so its channel is
 * `email`, and a suspended email account is never "replaced" by another email
 * account. Issuing an invoice and taking a payment are not channels.
 */
export function primaryChannel(action: PerformableAction): string | null {
  return action === 'CONTACT_BUYER' ? 'email' : null;
}

/**
 * Record a person's statement about one alternative for one action on one
 * opportunity. Append-only: a later statement supersedes an earlier one by
 * being later, and the earlier stays in the history.
 */
export async function declareContinuationAlternative(input: {
  opportunityId: string;
  action: string;
  namespace: string;
  channel?: string | null;
  permitted: boolean | null;
  contractuallyWorkable?: boolean | null;
  requiresContract?: boolean;
  actorRef: string;
  note: string;
}): Promise<Outcome<AlternativeDeclaration>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return { ok: false, reason: 'No opportunity with that id.' };
  if (!isPerformable(input.action)) {
    return {
      ok: false,
      reason: `"${input.action}" is not something Brain performs. One of: ${Object.keys(COMMERCIAL_EFFECTS).join(', ')}.`,
    };
  }
  const action = input.action;
  const primary = COMMERCIAL_EFFECTS[action].namespace.name;
  if (!isAlternativeNamespaceFor(action, input.namespace)) {
    return {
      ok: false,
      reason:
        `An alternative for ${action} is named "${primary}.via.<name>" (lowercase letters, digits, "_" or "-"), ` +
        'the namespace its own adapter serves.',
    };
  }
  const note = input.note.trim();
  if (!note) return { ok: false, reason: 'Say what the permission rests on. It is kept with the declaration.' };
  const requiresContract = input.requiresContract === true;
  const detail = {
    action,
    namespace: input.namespace,
    channel: input.channel?.trim().toLowerCase() || null,
    permitted: input.permitted,
    contractuallyWorkable: requiresContract ? (input.contractuallyWorkable ?? null) : null,
    requiresContract,
    note,
  };
  const event = await recordCashEvent({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    kind: ALTERNATIVE_DECLARED_KIND,
    actorRef: input.actorRef,
    summary:
      `${input.namespace} declared ${input.permitted === true ? 'permitted' : input.permitted === false ? 'not permitted' : 'undecided'} ` +
      `for ${COMMERCIAL_EFFECTS[action].doing}` +
      (requiresContract ? `, contract ${detail.contractuallyWorkable === true ? 'workable' : detail.contractuallyWorkable === false ? 'not workable' : 'not established'}` : '') +
      '.',
    detail,
  });
  const declaration = declarationOf(event)!;
  return { ok: true, value: declaration, message: event.summary };
}

/**
 * The declarations that govern one action on one opportunity now: the latest
 * per namespace, an opportunity's own over a project-wide one.
 */
export async function governingDeclarations(
  projectId: string,
  opportunityId: string,
  action: PerformableAction,
): Promise<AlternativeDeclaration[]> {
  const projectWide = new Map<string, AlternativeDeclaration>();
  const own = new Map<string, AlternativeDeclaration>();
  for (const event of await cashEventsOfKindInProject(projectId, ALTERNATIVE_DECLARED_KIND)) {
    const declaration = declarationOf(event);
    if (!declaration || declaration.action !== action) continue;
    if (declaration.opportunityId === null) projectWide.set(declaration.namespace, declaration);
    else if (declaration.opportunityId === opportunityId) own.set(declaration.namespace, declaration);
  }
  const merged = new Map(projectWide);
  for (const [namespace, declaration] of own) merged.set(namespace, declaration);
  return [...merged.values()].sort((a, b) => a.declaredAt.localeCompare(b.declaredAt) || a.namespace.localeCompare(b.namespace));
}

/**
 * What `planContinuation` is handed for one commitment: every governing
 * declaration, with its health and whether Brain can perform through it now
 * read from this Brain's own rows. A declaration that is not a yes stays in
 * the list, so the decision records it as skipped and why.
 */
export async function continuationAlternativesFor(
  projectId: string,
  opportunityId: string,
  action: PerformableAction,
  now?: string,
): Promise<ContinuationAlternative[]> {
  const out: ContinuationAlternative[] = [];
  for (const declaration of await governingDeclarations(projectId, opportunityId, action)) {
    const health = await namespaceHealth(projectId, declaration.namespace, now);
    out.push({
      namespace: declaration.namespace,
      channel: declaration.channel,
      permitted: declaration.permitted,
      contractuallyWorkable: declaration.contractuallyWorkable,
      requiresContract: declaration.requiresContract,
      status: health.status,
      performable: usableAdapter(performedNamespace(action, declaration.namespace)) !== null,
    });
  }
  return out;
}
