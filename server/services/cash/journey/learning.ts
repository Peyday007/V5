/**
 * What a commercial test actually taught, and what several of them amount to.
 *
 * Two halves, kept apart on purpose:
 *
 *   - `recordOutcomes` writes one `cash_outcomes` row per measured fact about
 *     one deal, each carrying the rows it was read from. Every value is a
 *     difference between two recorded timestamps, a figure off the ledger, or
 *     a closed-vocabulary reading of an observation — never a sentence Brain
 *     composed about what it thinks happened. Keyed per fact, so the tick can
 *     ask every pass and writes each one once; nothing is updated or deleted.
 *   - `cashOutcomeLessons` groups them on the read path by mechanism and
 *     channel with the sample size beside every figure. One result is reported
 *     as one result — `anecdote: true` below `LESSON_MIN_SAMPLE` — and a lesson
 *     informs the ranking as a late tie-break only, never a gate, because one
 *     buyer who did not answer is not a market that does not buy.
 */
import { actionsFor } from '../../../repos/cashActions.ts';
import { insertOutcome, outcomesFor } from '../../../repos/cashJourney.ts';
import { dealPosition } from './position.ts';
import type { CashOpportunity } from '../../../domain/types.ts';
import type { CashOutcome, OutcomeKind } from '../../../domain/cashJourney.ts';

/** Below this many observations a figure is an anecdote, and says so. */
export const LESSON_MIN_SAMPLE = 3;

const TERMINAL = new Set(['COLLECTED', 'DECLINED', 'ARCHIVED']);

function ms(from: string, to: string): number {
  return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}

export async function recordOutcomes(opportunity: CashOpportunity, currency: string): Promise<number> {
  const position = await dealPosition({ opportunity, currency });
  const actions = await actionsFor(opportunity.id);
  const contacts = actions.filter((one) => one.action === 'CONTACT_BUYER');
  if (contacts.length === 0 && position.agreements.length === 0) return 0;

  const base = {
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    mechanism: opportunity.mechanism,
    channel: opportunity.reachableChannel,
  };
  let created = 0;
  const write = async (
    kind: OutcomeKind,
    suffix: string,
    value: { cents?: number | null; ms?: number | null; text?: string | null },
    basis: string,
  ): Promise<void> => {
    const fresh = await insertOutcome({
      ...base,
      kind,
      valueCents: value.cents ?? null,
      valueMs: value.ms ?? null,
      valueText: value.text ?? null,
      currency: value.cents !== undefined && value.cents !== null ? currency : null,
      basis,
      requestKey: `outcome:${opportunity.id}:${kind}:${suffix}`,
    });
    if (fresh) created += 1;
  };

  // What each contact produced: the first reading after it, from a closed set.
  for (const contact of contacts) {
    const first = position.observations.find(
      (one) =>
        one.observedAt >= contact.createdAt &&
        (one.kind.startsWith('BUYER_') || one.kind === 'CONTACT_UNDELIVERABLE'),
    );
    if (first) {
      await write('CONTACT_RESULT', contact.id, { text: first.kind }, `action ${contact.id}; observation ${first.id}`);
    }
    if (opportunity.priceCents !== null) {
      await write('OFFERED_PRICE', contact.id, { cents: opportunity.priceCents }, `action ${contact.id}; card price`);
    }
  }

  const firstContact = contacts[0];
  for (const agreement of position.agreements) {
    await write('ACCEPTED_PRICE', agreement.id, { cents: agreement.amountCents }, `agreement ${agreement.id}`);
    if (firstContact) {
      await write(
        'TIME_TO_AGREEMENT',
        agreement.id,
        { ms: ms(firstContact.createdAt, agreement.createdAt) },
        `action ${firstContact.id} → agreement ${agreement.id}`,
      );
    }
    if (agreement.state === 'RELEASED') {
      await write('FAILURE_REASON', `agreement-${agreement.id}`, { text: agreement.releasedReason ?? 'released' }, `agreement ${agreement.id} released`);
    }
  }

  for (const fulfilment of position.fulfilments) {
    if (fulfilment.state === 'DELIVERED' && fulfilment.deliveredAt) {
      await write(
        'FULFILMENT_DURATION',
        fulfilment.id,
        { ms: ms(fulfilment.createdAt, fulfilment.deliveredAt) },
        `fulfilment ${fulfilment.id} (${fulfilment.path})`,
      );
    }
    if (fulfilment.state === 'FAILED') {
      await write('FAILURE_REASON', `fulfilment-${fulfilment.id}`, { text: fulfilment.stateReason ?? 'failed' }, `fulfilment ${fulfilment.id}`);
    }
  }

  // The money figures are read once the deal has ended, so they are final
  // rather than a snapshot of a deal still moving.
  // A cost or a refund can still land after a deal ends, so each figure is
  // keyed by its value: a changed figure is a later row beside the earlier one,
  // never an edit of it, and readers take the latest per deal.
  if (TERMINAL.has(opportunity.state)) {
    const p = position.pnl;
    const suffix = opportunity.state;
    const cost = p.incrementalCostsCents + p.unpaidCommitmentsCents;
    await write('ACTUAL_COST', `${suffix}:${cost}`, { cents: cost }, 'ledger: COST + outstanding UNPAID_COMMITMENT');
    if (p.refundsCents > 0) await write('REFUNDED', `${suffix}:${p.refundsCents}`, { cents: p.refundsCents }, 'ledger: REFUND');
    await write('REALIZED_CONTRIBUTION', `${suffix}:${p.contributionCents}`, { cents: p.contributionCents }, 'ledger: payments − refunds − costs − owed');
    if (opportunity.state !== 'COLLECTED') {
      await write(
        'FAILURE_REASON',
        `ended-${suffix}`,
        { text: opportunity.declinedReason ?? opportunity.archivedReason ?? opportunity.state },
        `opportunity ended ${suffix.toLowerCase()}`,
      );
    }
  }
  return created;
}

export interface CashLesson {
  mechanism: string | null;
  channel: string | null;
  contacts: number;
  /** Contacts that drew any buyer answer (not silence, not undeliverable). */
  answered: number;
  agreements: number;
  medianTimeToAgreementMs: number | null;
  /** Accepted price over offered price, as a median ratio in basis points. */
  medianAcceptedOverOfferedBp: number | null;
  completed: number;
  realizedContributionCents: number;
  failures: { reason: string; count: number }[];
  /** True below `LESSON_MIN_SAMPLE` contacts: a result, not a pattern. */
  anecdote: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Measured outcomes, grouped by mechanism and channel, with the sample shown. */
export async function cashOutcomeLessons(projectId: string): Promise<CashLesson[]> {
  const rows = await outcomesFor({ projectId });
  const groups = new Map<string, CashOutcome[]>();
  for (const row of rows) {
    const key = `${row.mechanism ?? ''}\u0000${row.channel ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: CashLesson[] = [];
  for (const items of groups.values()) {
    // Money figures can be re-read after a deal ends; the latest row per deal
    // is the figure, and the earlier ones are history.
    const LATEST_ONLY = new Set<OutcomeKind>(['ACTUAL_COST', 'REFUNDED', 'REALIZED_CONTRIBUTION']);
    const of = (kind: OutcomeKind) => {
      const rows = items.filter((one) => one.kind === kind);
      if (!LATEST_ONLY.has(kind)) return rows;
      const latest = new Map<string, CashOutcome>();
      for (const row of rows) latest.set(row.opportunityId, row);
      return [...latest.values()];
    };
    const contactRows = of('CONTACT_RESULT');
    const offered = new Map(of('OFFERED_PRICE').map((one) => [one.opportunityId, one.valueCents ?? 0]));
    const ratios = of('ACCEPTED_PRICE')
      .filter((one) => (offered.get(one.opportunityId) ?? 0) > 0)
      .map((one) => Math.round(((one.valueCents ?? 0) * 10_000) / offered.get(one.opportunityId)!));
    const failures = new Map<string, number>();
    for (const one of of('FAILURE_REASON')) {
      const reason = one.valueText ?? 'unstated';
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    const completed = of('REALIZED_CONTRIBUTION');
    // One contact is one action, whichever of its two readings exists.
    const contacts = new Set(
      [...contactRows, ...of('OFFERED_PRICE')].map((one) => one.requestKey.split(':').at(-1)),
    ).size;
    out.push({
      mechanism: items[0]!.mechanism,
      channel: items[0]!.channel,
      contacts,
      answered: contactRows.filter((one) => one.valueText !== 'BUYER_SILENT' && one.valueText !== 'CONTACT_UNDELIVERABLE').length,
      agreements: of('ACCEPTED_PRICE').length,
      medianTimeToAgreementMs: median(of('TIME_TO_AGREEMENT').map((one) => one.valueMs ?? 0)),
      medianAcceptedOverOfferedBp: median(ratios),
      completed: completed.length,
      realizedContributionCents: completed.reduce((sum, one) => sum + (one.valueCents ?? 0), 0),
      failures: [...failures.entries()].map(([reason, count]) => ({ reason, count })),
      anecdote: contacts < LESSON_MIN_SAMPLE,
    });
  }
  return out.sort((a, b) => b.contacts - a.contacts || String(a.mechanism).localeCompare(String(b.mechanism)));
}

/**
 * The measured reading the ranking may use: realized contribution per contact
 * for a mechanism, only where enough contacts stand behind it. Absent otherwise
 * — an unmeasured mechanism is unknown, and an unknown never helps (§30).
 */
export function measuredByMechanism(lessons: CashLesson[]): Record<string, number> {
  const totals = new Map<string, { contacts: number; contribution: number }>();
  for (const lesson of lessons) {
    if (!lesson.mechanism) continue;
    const seen = totals.get(lesson.mechanism) ?? { contacts: 0, contribution: 0 };
    seen.contacts += lesson.contacts;
    seen.contribution += lesson.realizedContributionCents;
    totals.set(lesson.mechanism, seen);
  }
  const out: Record<string, number> = {};
  for (const [mechanism, seen] of totals) {
    if (seen.contacts >= LESSON_MIN_SAMPLE) out[mechanism] = Math.round(seen.contribution / seen.contacts);
  }
  return out;
}
