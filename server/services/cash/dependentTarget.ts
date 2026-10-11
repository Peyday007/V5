/**
 * A question about an opening has to name the opening.
 *
 * `reconcileDiscoverableGaps` raises a need for every researchable blank on a
 * card, and `startDependentWork` turns each one into a Russell idea. The idea's
 * statement is what the compiler researches — with no conversation behind it,
 * the statement *is* the question — and it was composed from the need's
 * explanation and the field's generic task:
 *
 *   "This card cannot be tested without it, and it is a fact about the world
 *    rather than a decision of yours — so Brain looks it up rather than asking
 *    you. State the maximum cash out before the money is usable."
 *
 * That names no market, no product, no request and no source. The title carried
 * the opportunity's own sentence, cut short, and still not where it was
 * published. Production, 2026-10-11: every worker handed one of these packets
 * reported the fragment BLOCKED — "the question names no market, product or
 * RFP, so it cannot be researched as written" — which was correct, and the
 * packets then spent bin after bin re-asking it. Seventy such bins were already
 * exhausted (`bin_8131dbc5044f4ece9e97`, `bin_853479a8c376474ea529` among them).
 *
 * The opening was never unknown. An opportunity Brain harvested points at the
 * accepted claim it came from, and that claim carries the URL, the publisher,
 * the date and the sentence a worker would need. So:
 *
 *   - **A question is composed with its target** — the field's task, then the
 *     opening in the source's own words with where and by whom it was published.
 *   - **No target, no question.** An opportunity with no resolvable source launches
 *     nothing; the need stays open and visible rather than becoming research
 *     nobody can do.
 *   - **Research already asked without one is held, never destroyed.** Its bins
 *     are held out of dispatch (`holdUntargetedBin`), every row stays as written,
 *     and where a target exists the need is re-pointed at a new idea that names
 *     it. A packet's question is never edited — the old one stays the history of
 *     what was asked.
 *
 * Whether an idea is targeted is decided by `TARGET_MARKER`, which only this
 * module writes. It is Brain reading its own composition back, not a guess about
 * prose somebody else wrote.
 */
import { createCandidate, getCandidate } from '../../repos/russellCandidates.ts';
import { getClaim } from '../../repos/research.ts';
import { holdUntargetedBin } from '../../repos/bins.ts';
import {
  getOpportunity,
  listNeeds,
  repointNeedCandidate,
  setNeedCandidate,
  untargetedDependentBins,
} from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';
import { evidenceCard } from './card.ts';
import { questionKey } from './conditions.ts';

/** The phrase Brain writes only when it named the opening a question is about. */
export const TARGET_MARKER = 'The opening this is about:';

/** Longest the opening's own sentence is quoted at. A claim is a sentence, not a report. */
const MAX_QUOTED_CHARS = 600;

export interface ResearchTarget {
  claimId: string;
  statement: string;
  sourceUrl: string;
  publisher: string | null;
  publishedOn: string | null;
}

/**
 * The opening an opportunity is about, from the claim it was harvested from.
 * Null when there is nothing a worker could open: no claim, or a claim with no
 * URL. Not knowing is an answer, and it is never filled in.
 */
export async function researchTargetFor(opportunity: CashOpportunity): Promise<ResearchTarget | null> {
  if (!opportunity.sourceClaimId) return null;
  const claim = await getClaim(opportunity.sourceClaimId);
  const url = claim?.sourceUrl?.trim();
  if (!claim || !url) return null;
  return {
    claimId: claim.id,
    statement: claim.claim.trim(),
    sourceUrl: url,
    publisher: claim.sourcePublisher?.trim() || null,
    publishedOn: claim.sourceDate?.trim() || null,
  };
}

function quoted(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_QUOTED_CHARS ? flat : `${flat.slice(0, MAX_QUOTED_CHARS - 1).trimEnd()}…`;
}

/**
 * The idea a need asks through, with its target in the words the compiler will
 * research. The task comes first because the compiled objective is
 * "Establish, from published sources, <statement>".
 */
export function composeDependentQuestion(input: {
  fieldLabel: string;
  task: string;
  opportunityTitle: string;
  target: ResearchTarget;
}): { title: string; statement: string } {
  const { target } = input;
  const by = target.publisher ? ` by ${target.publisher}` : '';
  const on = target.publishedOn ? ` on ${target.publishedOn}` : '';
  const statement =
    `${input.task.trim()} ${TARGET_MARKER} "${quoted(target.statement)}", ` +
    `published at ${target.sourceUrl}${by}${on}. Answer for that specific opening, ` +
    'starting from that page.';
  const where = target.publisher ?? new URL(target.sourceUrl).hostname;
  const title = `${input.fieldLabel} for ${where}: ${quoted(input.opportunityTitle).slice(0, 100)}`;
  return { title, statement };
}

/** Is this statement one Brain composed with a target? */
export function isTargeted(statement: string): boolean {
  return statement.includes(TARGET_MARKER);
}

function fieldFor(need: CashNeed, opportunity: CashOpportunity): { label: string; task: string } | null {
  const field = evidenceCard(opportunity).fields.find(
    (one) => questionKey(opportunity.id, one.key) === need.requestKey,
  );
  return field ? { label: field.label, task: field.task } : null;
}

export interface DependentTargetPass {
  held: Array<{ binId: string; needId: string }>;
  retargeted: Array<{ needId: string; from: string; to: string }>;
  started: Array<{ needId: string; candidateId: string }>;
  /** Needs that stay open because their opening names nothing to research. */
  untargeted: string[];
}

/**
 * Hold what was asked without a target, re-ask it with one where one exists,
 * and start nothing that has none. Idempotent by rows: a held bin is not held
 * twice, a re-pointed need is guarded on the idea it moved from, and a need
 * with a targeted idea is left alone.
 */
export async function advanceDependentWork(projectId: string): Promise<DependentTargetPass> {
  const out: DependentTargetPass = { held: [], retargeted: [], started: [], untargeted: [] };

  for (const row of await untargetedDependentBins(projectId, TARGET_MARKER)) {
    const held = await holdUntargetedBin({
      binId: row.binId,
      holderId: row.needId,
      reason:
        `Held: packet ${row.orchestrationId} was asked through idea ${row.candidateId}, whose question ` +
        'names no opening, market or source, so no worker can research it as written. Nothing was ' +
        'cancelled or reset; the need is re-asked with its opening named where Brain can resolve one.',
    });
    if (held) out.held.push({ binId: row.binId, needId: row.needId });
  }

  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.opportunityId || !need.requestKey?.startsWith('question:')) continue;
    const current = need.candidateId ? await getCandidate(need.candidateId) : null;
    if (current && isTargeted(current.statement)) continue;
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    const field = fieldFor(need, opportunity);
    const target = await researchTargetFor(opportunity);
    if (!field || !target) {
      out.untargeted.push(need.id);
      continue;
    }
    const composed = composeDependentQuestion({
      fieldLabel: field.label,
      task: field.task,
      opportunityTitle: opportunity.title,
      target,
    });
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: composed.title,
      statement: composed.statement,
    });
    if (current) {
      if (!(await repointNeedCandidate(need.id, current.id, candidate.id))) continue;
      out.retargeted.push({ needId: need.id, from: current.id, to: candidate.id });
      await recordCashEvent({
        projectId,
        opportunityId: opportunity.id,
        kind: 'CASH_NEED_RETARGETED',
        actorRef: 'BRAIN',
        summary:
          `Re-asked "${need.blockedAction}" naming its opening (${target.sourceUrl}); the earlier ` +
          'question named none and its work is held.',
        detail: { needId: need.id, from: current.id, to: candidate.id, claimId: target.claimId },
      });
    } else {
      if (!(await setNeedCandidate(need.id, candidate.id))) continue;
      out.started.push({ needId: need.id, candidateId: candidate.id });
    }
  }
  return out;
}
