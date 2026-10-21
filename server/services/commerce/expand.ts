/**
 * Opening the commerce kernel's questions, and filing what comes back (§73).
 *
 * An entrance, not a pipeline: a round is a Russell candidate, and the path
 * that already exists does all of it — the archive check, the compiler, the
 * approval envelope, the evidence gate and all three audit roles. Filing is a
 * lookup, never a reading: every row comes from a claim that cleared the gate
 * and carries a declaration from a closed set, and a declaration that cannot
 * be filed is reported as refused rather than attached to the nearest
 * plausible product.
 */
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { byClaimTime, everyPage, missionsForRounds } from '../russell/roundMissions.ts';
import { commerceClaims } from '../../repos/research.ts';
import {
  createCommerceProduct,
  getCommerceProgramme,
  openCommerceRound,
  openCommerceRoundsByCandidate,
  recordCommerceFact,
  settleCommerceRound,
} from '../../repos/commerce.ts';
import {
  isCommerceCostComponent,
  isCommerceDemandKind,
  isCommerceRestriction,
} from '../../domain/commerce.ts';
import {
  costsQuestion,
  costsTitle,
  DISCOVER_TITLE,
  discoverQuestion,
  nicheQuestion,
  nicheTitle,
  priceQuestion,
  priceTitle,
  sourceQuestion,
  sourceTitle,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { CommerceSnapshot } from './graph.ts';
import type { CommerceFact, CommerceProduct, CommerceRound, ResearchClaim } from '../../domain/types.ts';

const OPENED = 'COMMERCE_ROUND_OPENED';
const FILED = 'COMMERCE_FINDINGS_FILED';

/**
 * Serialize two callers asking the same question on Postgres, inside the
 * transaction the candidate and the round share. `expand.ts` in the puzzle
 * kernel has the whole argument; SQLite serializes writers and needs none.
 */
async function lockRoundKey(key: {
  projectId: string;
  purpose: string;
  productKey: string | null;
  round: number;
}): Promise<void> {
  const db = getDb();
  if (db.dialect !== 'postgres') return;
  const NAMESPACE = 0x43_4f_4d_51; // 'COMQ', arbitrary and stable
  const material = `${key.projectId}:${key.purpose}:${key.productKey ?? '-'}:${key.round}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  await db.run('SELECT pg_advisory_xact_lock($1, $2)', [NAMESPACE, hash | 0]);
}

export interface OpenedCommerceRound {
  roundId: string;
  purpose: Ask['purpose'];
  productKey: string | null;
  candidateId: string;
  round: number;
  question: string;
  why: string;
}

class RoundNotOpened extends Error {}

/**
 * Turn allocated asks into Russell candidates and rounds, each pair committed
 * together, so a lost race leaves no candidate nothing points at — a SHARED
 * candidate is judged and can launch whether or not a round names it.
 */
export async function openCommerceAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: CommerceSnapshot;
}): Promise<OpenedCommerceRound[]> {
  const mode = await getCashMode(input.projectId);
  const programme = await getCommerceProgramme(input.projectId);
  if (!mode || !programme) return [];

  const out: OpenedCommerceRound[] = [];
  for (const ask of input.asks) {
    const composed = compose({ ask, objective: programme.objective, snapshot: input.snapshot });
    if (!composed) continue;

    let round: CommerceRound;
    try {
      round = await getDb().transaction(async (): Promise<CommerceRound> => {
        await lockRoundKey({
          projectId: input.projectId,
          purpose: ask.purpose,
          productKey: ask.productKey,
          round: ask.round,
        });
        const candidate = await createCandidate({
          projectId: input.projectId,
          visibility: 'SHARED',
          conversationId: null,
          sourceMessageId: null,
          title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
          statement: composed.question,
        });
        const result = await openCommerceRound({
          projectId: input.projectId,
          cashModeId: mode.id,
          purpose: ask.purpose,
          productKey: ask.productKey,
          candidateId: candidate.id,
          round: ask.round,
        });
        if (!result.created) throw new RoundNotOpened();
        return result.round;
      });
    } catch (error) {
      if (error instanceof RoundNotOpened) continue;
      throw error;
    }

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: round.id,
        purpose: ask.purpose,
        productKey: ask.productKey,
        candidateId: round.candidateId,
        round: ask.round,
        why: ask.why,
        rank: ask.rank,
      },
    });
    out.push({
      roundId: round.id,
      purpose: ask.purpose,
      productKey: ask.productKey,
      candidateId: round.candidateId,
      round: ask.round,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

function compose(input: {
  ask: Ask;
  objective: string;
  snapshot: CommerceSnapshot;
}): { title: string; question: string } | null {
  const { ask, objective, snapshot } = input;
  if (ask.purpose === 'DISCOVER') {
    return {
      title: DISCOVER_TITLE,
      question: discoverQuestion({
        objective,
        round: ask.round,
        known: snapshot.products.filter((one) => !one.retiredAt).map((one) => one.name),
      }),
    };
  }
  const standing = snapshot.standing.find((one) => one.productKey === ask.productKey);
  if (!standing) return null;
  const product = standing.name;
  if (ask.purpose === 'SOURCE') return { title: sourceTitle(product), question: sourceQuestion({ product, objective }) };
  if (ask.purpose === 'PRICE') return { title: priceTitle(product), question: priceQuestion({ product, objective }) };
  if (ask.purpose === 'COSTS') {
    return { title: costsTitle(product), question: costsQuestion({ product, objective, standing }) };
  }
  return { title: nicheTitle(product), question: nicheQuestion({ product, objective }) };
}

/* --------------------------------------------------------------------------
 * Filing what came back
 * ------------------------------------------------------------------------ */

export interface Filed {
  products: CommerceProduct[];
  facts: CommerceFact[];
  settled: { roundId: string; found: number }[];
  refused: { claimId: string; why: string }[];
}

function emptyFiled(): Filed {
  return { products: [], facts: [], settled: [], refused: [] };
}

/**
 * File every declared finding from the rounds still open, and settle the
 * rounds whose idea has ended.
 *
 * Not gated by the programme's state or the sprint's lifecycle: filing what
 * research already found is not new discovery — the spending happened when it
 * ran — and dropping it would throw away work already paid for.
 *
 * `found` counts what a round **established**, read from its own claims on a
 * complete paged read when it settles, never what one pass happened to write —
 * §38's recorded defect, where a productive round settled as barren.
 */
export async function fileCommerceFindings(input: { projectId: string; limit?: number }): Promise<Filed> {
  const out = emptyFiled();
  const live = await openCommerceRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  const rounds = await missionsForRounds([...live.keys()]);
  const working = [...live]
    .filter(([candidateId]) => !rounds.get(candidateId)?.outcome)
    .flatMap(([candidateId]) => rounds.get(candidateId)?.orchestrationIds ?? []);
  const workingClaims = await commerceClaims({
    projectId: input.projectId,
    orchestrationIds: working,
    limit: Math.max(1, input.limit ?? 200),
  });

  const ending = [...live].filter(([candidateId]) => rounds.get(candidateId)?.outcome);
  const endingRound = new Map<string, string>();
  const endingClaims: { claim: ResearchClaim; orchestrationId: string }[] = [];
  for (const [candidateId, round] of ending) {
    const entry = rounds.get(candidateId)!;
    for (const id of entry.orchestrationIds) endingRound.set(id, round.id);
    endingClaims.push(
      ...(await everyPage((offset, size) =>
        commerceClaims({
          projectId: input.projectId,
          orchestrationIds: entry.orchestrationIds,
          limit: size,
          offset,
        }),
      )),
    );
  }

  const foundPerRound = new Map<string, number>();
  for (const entry of byClaimTime([...workingClaims, ...endingClaims])) {
    const filed = await file({ projectId: input.projectId, claim: entry.claim, out });
    const roundId = endingRound.get(entry.orchestrationId);
    if (roundId && filed !== 'REFUSED') foundPerRound.set(roundId, (foundPerRound.get(roundId) ?? 0) + 1);
  }
  for (const [candidateId, round] of ending) {
    const entry = rounds.get(candidateId)!;
    const found = foundPerRound.get(round.id) ?? 0;
    if (
      await settleCommerceRound({
        roundId: round.id,
        found,
        to: entry.outcome === 'HARVESTED' ? 'SETTLED' : 'ABANDONED',
      })
    ) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  if (out.products.length + out.facts.length > 0) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: FILED,
      actorRef: 'BRAIN',
      summary:
        `${out.products.length} product(s) and ${out.facts.length} fact(s) were filed from what ` +
        'the commerce kernel established.',
      detail: {
        productIds: out.products.map((one) => one.id),
        factIds: out.facts.map((one) => one.id),
        refused: out.refused,
      },
    });
  }
  return out;
}

type Filing = 'CREATED' | 'EXISTS' | 'REFUSED';

async function file(input: { projectId: string; claim: ResearchClaim; out: Filed }): Promise<Filing> {
  const { claim, out } = input;
  const finding = claim.commerceFinding;
  if (!finding) return 'REFUSED';
  if (!claim.commerceProduct || !claim.commerceSubject) {
    out.refused.push({ claimId: claim.id, why: 'the finding named no product or no subject' });
    return 'REFUSED';
  }

  /*
   * An undated demand signal is refused here as well as in the question:
   * "selling now" is a claim about a date, and one with no date cannot be told
   * apart from a list somebody remembers from last year (§30).
   */
  const observedOn = claim.sourceDate && Number.isFinite(Date.parse(claim.sourceDate)) ? claim.sourceDate : null;
  if (finding === 'PRODUCT_DEMAND' && !observedOn) {
    out.refused.push({ claimId: claim.id, why: 'a demand signal carried no date the source published' });
    return 'REFUSED';
  }
  const value = claim.commerceValue;
  if (finding === 'PRODUCT_DEMAND' && !isCommerceDemandKind(value)) {
    out.refused.push({ claimId: claim.id, why: 'a demand signal named no kind of signal' });
    return 'REFUSED';
  }
  if (finding === 'COST_LINE' && !isCommerceCostComponent(value)) {
    out.refused.push({ claimId: claim.id, why: 'a cost line named no line' });
    return 'REFUSED';
  }
  if (finding === 'RESTRICTION' && !isCommerceRestriction(value)) {
    out.refused.push({ claimId: claim.id, why: 'a restriction named no kind of rule' });
    return 'REFUSED';
  }

  const { product, created: productCreated } = await createCommerceProduct({
    projectId: input.projectId,
    name: claim.commerceProduct,
    note: claim.claim,
    origin: 'DISCOVERED',
    sourceClaimId: claim.id,
  });
  if (productCreated) out.products.push(product);

  const { fact, created } = await recordCommerceFact({
    projectId: input.projectId,
    productId: product.id,
    finding,
    subject: claim.commerceSubject,
    value: value ?? null,
    amountCents: claim.commerceAmountCents,
    rateBps: claim.commerceRateBps,
    currency: claim.commerceCurrency,
    days: claim.commerceDays,
    statement: claim.claim,
    publisher: claim.sourcePublisher,
    observedOn,
    sourceClaimId: claim.id,
  });
  if (created) out.facts.push(fact);
  return created ? 'CREATED' : 'EXISTS';
}
