/**
 * The constructed-arrangement library (§81/§82, Surge B K-1..K-8).
 *
 * Construction (`construct.ts`) stays a pure composition over rows. This is
 * the thin layer that makes what it composes durable: each arrangement is a
 * `CONSTRUCTED` row of the §49 ledger keyed by its structural signature, so it
 * survives a restart, a deploy, a new goal, a new project and a model change,
 * and every later use of it — a research round asked, a goal model weighing
 * it, research confirming or refuting it — is written to that one row.
 *
 * Hypothesis and observation stay apart by construction: the stored design,
 * value and unknown parts are Brain's reconstruction (`design_json`); what
 * research observed is an EVIDENCE fact on the path, which the ledger's CHECK
 * ties to a gated claim; a verdict carries the inputs digest it was reached
 * under, so new evidence about a part reopens a refuted arrangement.
 */
import { getDb } from '../../db/database.ts';
import {
  arrangementForLegacyKey,
  noteArrangementAsked,
  pathFact,
  recordArrangementEvaluations,
  recordArrangementVerdict,
  recordConstructedArrangements,
  recordPathFact,
  type ArrangementToRecord,
} from '../../repos/monetization.ts';
import type { ConstructedArrangementRecord, MonetizationMethod } from '../../domain/types.ts';
import { EQUIPMENT_WORDS } from '../../domain/construction.ts';
import { designToPosition } from '../industry/construction/designs.ts';
import { positionKey } from '../industry/construction/businesses.ts';
import type { ConstructedArrangement, Structure } from './construct.ts';

/**
 * The §49 vocabulary's word for each construction structure, so a constructed
 * row speaks the ledger's one closed method set rather than a third. The
 * design (funding, pooling, repeat) is in `design_json`.
 */
const METHOD_FOR: Record<Structure, MonetizationMethod> = {
  PRODUCE: 'PRODUCTIZED_SERVICE',
  BROKER: 'BROKERAGE',
  REFERRAL: 'REFERRAL_FEE',
  SUBCONTRACT: 'SUBCONTRACTED_FULFILMENT',
  POOL: 'RESALE',
};

export const ARRANGEMENT_BUCKET_MARK = '-mx-';

/** The 12-hex arrangement key a `goal-<id>-mx-<key>` bucket names, or null for any other bucket (pathway rounds included). */
export function arrangementKeyOfBucket(bucketId: string): string | null {
  const at = bucketId.lastIndexOf(ARRANGEMENT_BUCKET_MARK);
  if (!bucketId.startsWith('goal-') || at < 0) return null;
  const key = bucketId.slice(at + ARRANGEMENT_BUCKET_MARK.length);
  return /^[0-9a-f]{12}$/.test(key) ? key : null;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Write a construction pass into the library: one row per structure, new or
 * changed ones only. Geography is carried from the parts' own claims and legal
 * or structural constraints by reference to the `opportunity_constraints`
 * rows on the parts (K-8) — references, never copied prose.
 */
export async function rememberArrangements(
  projectId: string,
  goalId: string | null,
  arrangements: readonly ConstructedArrangement[],
  at: string = new Date().toISOString(),
): Promise<{ created: number; updated: number; unchanged: number }> {
  const stored = arrangements.filter((one) => one.signature && one.inputsDigest);
  if (stored.length === 0) return { created: 0, updated: 0, unchanged: 0 };
  const parts = (one: ConstructedArrangement) => [one.demand, one.need, one.supply].filter((p): p is NonNullable<typeof p> => p !== null);
  const claimIds = [...new Set(stored.flatMap((one) => parts(one).map((p) => p.claimId).filter((id): id is string => !!id)))];
  const geography = new Map<string, string>();
  for (let i = 0; i < claimIds.length; i += 500) {
    const chunk = claimIds.slice(i, i + 500);
    for (const row of await getDb().all<{ id: string; geography: string | null }>(
      `SELECT id, geography FROM research_claims WHERE id IN (${placeholders(chunk.length)})`,
      chunk,
    )) {
      if (row.geography) geography.set(row.id, row.geography);
    }
  }
  const constraintsByRef = new Map<string, Array<{ id: string; kind: string }>>();
  for (const row of await getDb().all<{ id: string; kind: string; node_id: string | null; opportunity_id: string | null }>(
    'SELECT id, kind, node_id, opportunity_id FROM opportunity_constraints WHERE project_id = ? ORDER BY id',
    [projectId],
  )) {
    const ref = row.node_id ?? row.opportunity_id;
    if (ref) constraintsByRef.set(ref, [...(constraintsByRef.get(ref) ?? []), { id: row.id, kind: row.kind }]);
  }
  const records: ArrangementToRecord[] = stored.map((one) => {
    const own = parts(one);
    const design = {
      version: 1,
      arrangement: one,
      geography: [...new Set(own.map((p) => (p.claimId ? geography.get(p.claimId) : undefined)).filter((g): g is string => !!g))].sort(),
      constraints: own.flatMap((p) => constraintsByRef.get(p.ref) ?? []),
      paymentTiming: { funding: one.design.funding, beforeDelivery: one.design.funding !== 'ON_DELIVERY', days: null },
    };
    /*
     * The §92 position this design occupies (K-6, W-8), so positions are rows:
     * countable, and comparable with the arrangement's predecessor. Whose
     * assets do the work is read from the parts' own words, as §92 reads it.
     */
    const position = designToPosition(one.design, EQUIPMENT_WORDS.test(own.map((p) => p.name).join(' ')));
    return {
      signature: one.signature!,
      legacyKey: one.key,
      method: METHOD_FOR[one.structure],
      title: one.label,
      thesis: one.origin === 'REVERSE' ? null : `${one.demand.name} pay${one.need ? ` to deal with ${one.need.name}` : ''}`.slice(0, 300),
      constructionOrigin: one.origin,
      opportunityId: one.demand.from === 'OPENING' ? one.demand.ref : null,
      industryNodeId: one.demand.from === 'INDUSTRY_MAP' ? one.demand.ref : null,
      precedentOpportunityId: one.precedent?.opportunityId ?? null,
      inputsDigest: one.inputsDigest!,
      designJson: JSON.stringify(design),
      positionJson: JSON.stringify(position),
      positionKey: positionKey(position),
    };
  });
  return recordConstructedArrangements(projectId, goalId, records, at);
}

/**
 * Whether research already refuted this arrangement under the inputs it has
 * now. A refuted arrangement is not asked again until something about its
 * parts — a claim, a row, a price from this buyer, a precedent — changes.
 */
export function refutedUnderSameInputs(record: Pick<ConstructedArrangementRecord, 'verdict'> | undefined, arrangement: Pick<ConstructedArrangement, 'inputsDigest'>): boolean {
  return !!record?.verdict && record.verdict.verdict === 'REFUTED' && !!arrangement.inputsDigest && record.verdict.inputsDigest === arrangement.inputsDigest;
}

/** A constructed round was opened: count it on the arrangement it asks about. */
export async function noteConstructedRoundOpened(projectId: string, key: string, at?: string): Promise<boolean> {
  return noteArrangementAsked(projectId, key, at);
}

/**
 * One stored plan reading's weighing of the constructed arrangements in its
 * model: which entered, whether the best combination picked each, and its
 * settled-cash p50 there (major units, stored as cents).
 */
export async function recordReadingEvaluations(input: {
  projectId: string;
  goalId: string;
  readingId: string;
  demand: ReadonlyArray<{ opportunityId: string; refused: string | null; revenue: { p50: number } }>;
  picked: ReadonlySet<string>;
  prefix: string;
  at?: string;
}): Promise<number> {
  const entries = input.demand
    .filter((one) => one.opportunityId.startsWith(input.prefix))
    .map((one) => ({
      legacyKey: one.opportunityId.slice(input.prefix.length),
      picked: input.picked.has(one.opportunityId),
      refused: one.refused !== null,
      contributionCents: Number.isFinite(one.revenue.p50) ? Math.round(one.revenue.p50 * 100) : null,
    }));
  return recordArrangementEvaluations({ projectId: input.projectId, goalId: input.goalId, readingId: input.readingId, entries, ...(input.at ? { at: input.at } : {}) });
}

/**
 * What a closed constructed round says about its arrangement (K-4).
 *
 * Research that finished and filed openings CONFIRMS it, and the first
 * opening's gated claim becomes an EVIDENCE fact on the path. Research that
 * finished, filed nothing, and established an absence — an accepted
 * NEGATIVE_EXISTENCE claim, which is what the question asks a worker to state
 * when no source shows buyers pay — REFUTES it, with that claim as the
 * evidence. Finding nothing without stating an absence is neither: a dead end
 * is a watch, not a verdict (§65), and the round's backoff already handles it.
 * An ABANDONED round says nothing (§53).
 */
export async function noteConstructedRoundOutcome(input: {
  projectId: string;
  round: { id: string; bucketId: string; candidateId: string };
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
  at?: string;
}): Promise<'CONFIRMED' | 'REFUTED' | null> {
  const key = arrangementKeyOfBucket(input.round.bucketId);
  if (!key) return null;
  const path = await arrangementForLegacyKey(input.projectId, key);
  if (!path) return null;
  const at = input.at ?? new Date().toISOString();
  if (input.found > 0) {
    const opening = await getDb().get<{ source_claim_id: string | null; title: string; price_cents: number | null }>(
      `SELECT source_claim_id, title, price_cents FROM cash_opportunities
        WHERE discovery_round_id = ? AND source_claim_id IS NOT NULL
        ORDER BY created_at, id`,
      [input.round.id],
    );
    await recordArrangementVerdict({ pathId: path.pathId, verdict: 'CONFIRMED', inputsDigest: path.inputsDigest, roundId: input.round.id, at });
    if (opening?.source_claim_id) await evidence(path, opening.source_claim_id, `Research found ${input.found} opening(s) for it, first "${opening.title.slice(0, 160)}"`, opening.price_cents);
    return 'CONFIRMED';
  }
  if (input.to !== 'HARVESTED') return null;
  const absence = await getDb().get<{ id: string; claim: string }>(
    `SELECT c.id AS id, c.claim AS claim FROM russell_missions m
       JOIN research_claims c ON c.orchestration_id = m.orchestration_id
      WHERE m.candidate_id = ? AND c.accepted = 1 AND c.claim_type = 'NEGATIVE_EXISTENCE'
      ORDER BY c.created_at, c.id`,
    [input.round.candidateId],
  );
  if (!absence) return null;
  await recordArrangementVerdict({ pathId: path.pathId, verdict: 'REFUTED', inputsDigest: path.inputsDigest, roundId: input.round.id, at });
  await evidence(path, absence.id, `Research established no buyers pay for it: ${absence.claim.slice(0, 300)}`, null);
  return 'REFUTED';
}

/** An observed fact on the arrangement, resolving to the claim — written once, never over an earlier one. */
async function evidence(path: ConstructedArrangementRecord, claimId: string, value: string, amountCents: number | null): Promise<void> {
  if (await pathFact(path.pathId, 'expectedRevenue')) return;
  await recordPathFact({
    projectId: path.projectId,
    pathId: path.pathId,
    attribute: 'expectedRevenue',
    kind: 'EVIDENCE',
    value,
    amountCents: amountCents !== null && amountCents >= 0 ? amountCents : null,
    claimId,
    decidedBy: 'BRAIN',
  });
}
