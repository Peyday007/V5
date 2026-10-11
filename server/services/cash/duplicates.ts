/**
 * One opening, one piece of work.
 *
 * Discovery asks broad questions, and several rounds read the same published
 * request: production held three openings for one St. Louis RFP, each harvested
 * from its own claim, each owed its own deep dive. The unique index on
 * `(project, source_claim_id)` stops one claim becoming two openings and cannot
 * see two claims about one opening.
 *
 * The identity is read from rows rather than from prose: the claim's own
 * canonical source URL, reduced to what addresses the document, together with
 * the claim's own declared `opportunity_signal`. Two claims citing the same
 * document as the same kind of opening are one opening. Titles are never
 * compared — a similarity threshold nobody can audit would weld two different
 * openings together, and an invented match is worse than a second row a person
 * can see (§37).
 *
 * The cost is stated rather than hidden: one listing page that publishes
 * several distinct requests reads as one opening here. The second row is kept,
 * linked and visible, never deleted, and clearing `duplicate_of_id` undoes it.
 */

import {
  markOpportunityDuplicate,
  openingsWithSourceUrl,
  releaseDuplicatesOfArchived,
} from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import type { CashOpportunity } from '../../domain/types.ts';

/**
 * Query parameters that name a visitor rather than a document. Deliberately
 * not `ref` or `source`: on procurement sites those are the document id.
 */
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid)$/i;

/**
 * What addresses the document: scheme-less, host lower-cased without `www.`,
 * no fragment, no tracking parameters, no trailing slash. Null for anything
 * that is not an http(s) URL, which then matches nothing.
 */
export function openingSourceKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const kept = [...parsed.searchParams.entries()]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length
    ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
    : '';
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${query}`;
}

function identity(url: string | null, signal: string | null): string | null {
  const key = openingSourceKey(url);
  return key && signal ? `${signal}|${key}` : null;
}

interface Opening {
  opportunity: CashOpportunity;
  hasWork: boolean;
}

/**
 * The order a survivor is chosen in: dived further first, then one somebody
 * has already answered or asked something on (the guarded write would refuse
 * to mark it anyway), then oldest, then id.
 */
function survivorFirst(a: Opening, b: Opening): number {
  const x = a.opportunity;
  const y = b.opportunity;
  if (x.validationRounds !== y.validationRounds) return y.validationRounds - x.validationRounds;
  if (a.hasWork !== b.hasWork) return a.hasWork ? -1 : 1;
  if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? -1 : 1;
  return x.id < y.id ? -1 : 1;
}

async function identities(projectId: string): Promise<Map<string, Opening[]>> {
  const groups = new Map<string, Opening[]>();
  for (const { opportunity, sourceUrl, hasWork } of await openingsWithSourceUrl(projectId)) {
    const key = identity(sourceUrl, opportunity.opportunitySignal);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push({ opportunity, hasWork });
    groups.set(key, group);
  }
  return groups;
}

/**
 * The live opening an about-to-be-harvested claim would duplicate, if any.
 * Asked before the row is written so a new duplicate is never dived at all.
 */
export async function existingOpeningFor(input: {
  projectId: string;
  sourceUrl: string | null;
  signal: string | null;
}): Promise<CashOpportunity | null> {
  const key = identity(input.sourceUrl, input.signal);
  if (!key) return null;
  const groups = await identities(input.projectId);
  const group = (groups.get(key) ?? []).filter((one) => !one.opportunity.duplicateOfId);
  return group.sort(survivorFirst)[0]?.opportunity ?? null;
}

/**
 * Link every later record of an opening to its survivor.
 *
 * Derived on the tick rather than hooked to the harvest, so it reaches the
 * openings already written. Idempotent: the guarded write marks a row once and
 * never marks one whose dive has started.
 */
export async function markDuplicateOpenings(projectId: string): Promise<string[]> {
  await releaseDuplicatesOfArchived(projectId);
  const groups = await identities(projectId);
  const marked: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(survivorFirst).map((one) => one.opportunity);
    const survivor = ordered.find((one) => !one.duplicateOfId) ?? ordered[0]!;
    for (const other of ordered) {
      if (other.id === survivor.id || other.duplicateOfId) continue;
      if (!(await markOpportunityDuplicate(other.id, survivor.id))) continue;
      marked.push(other.id);
      await recordCashEvent({
        projectId,
        opportunityId: other.id,
        kind: 'CASH_OPPORTUNITY_DUPLICATE',
        actorRef: 'BRAIN',
        summary: `A second record of "${survivor.title.slice(0, 80)}": same source, same kind of opening.`,
        detail: { duplicateOf: survivor.id, claimId: other.sourceClaimId },
      });
    }
  }
  return marked;
}
