/**
 * Opening the kernel's questions, and filing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets
 * the path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this kernel
 * adds is a new way *in* to machinery Steps 4 to 12C already built, and none
 * of it is a second set of rules.
 *
 * ---------------------------------------------------------------------------
 * Filing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. `targetForFinding` decides which table a
 * finding lands in; nothing here inspects a sentence, infers a product class,
 * or decides that a figure *sounds* like receipts rather than a shelf price.
 * That last one is the whole point: the difference between the two is most of
 * the margin, it is invisible in prose, and it is decided by the person who
 * read the source rather than by anything downstream.
 *
 * ---------------------------------------------------------------------------
 * Every branch refuses rather than improvises
 * ---------------------------------------------------------------------------
 *
 * A figure with no product class, a route with no format, a constraint with no
 * subject — each is *reported as refused* rather than attached to the nearest
 * plausible thing. Attaching it would be Brain deciding what a fact was about,
 * which is the confidently wrong answer §25 records.
 */
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { puzzleClaims } from '../../repos/research.ts';
import {
  createPuzzleFormat,
  openPuzzleRound,
  openPuzzleRoundsByCandidate,
  recordPuzzleConstraint,
  recordPuzzleDemand,
  recordPuzzleEconomic,
  recordPuzzleRoute,
  settlePuzzleRound,
} from '../../repos/puzzle.ts';
import {
  isPuzzleEconomicComponent,
  isPuzzleRightsConstraint,
  routeKindForFinding,
  targetForFinding,
} from '../../domain/puzzle.ts';
import {
  channelQuestion,
  channelTitle,
  demandQuestion,
  demandTitle,
  economicsQuestion,
  economicsTitle,
  productionQuestion,
  productionTitle,
  rightsQuestion,
  rightsTitle,
  seedQuestion,
  SEED_TITLE,
} from './questions.ts';
import { loadBearingFor } from '../../domain/puzzle.ts';
import type { Ask } from './allocate.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type {
  PuzzleConstraint,
  PuzzleDemand,
  PuzzleEconomic,
  PuzzleFormatEntry,
  PuzzleRound,
  PuzzleRoute,
  ResearchClaim,
} from '../../domain/types.ts';

const OPENED = 'PUZZLE_ROUND_OPENED';
const FILED = 'PUZZLE_FINDINGS_FILED';

export interface OpenedPuzzleRound {
  roundId: string;
  purpose: Ask['purpose'];
  formatKey: string | null;
  productClass: Ask['productClass'];
  candidateId: string;
  round: number;
  question: string;
  why: string;
}

/**
 * A round insert lost its `ON CONFLICT DO NOTHING` race.
 *
 * Thrown to roll back the candidate created in the same transaction, never
 * caught outside `openPuzzleAsks`'s own loop.
 */
class RoundNotOpened extends Error {}

/**
 * Turn allocated asks into Russell candidates and rounds.
 *
 * The candidate and its round commit together, in one transaction. A round
 * insert that loses its `ON CONFLICT DO NOTHING` race means another pass
 * already opened this exact question, and the candidate this call just
 * created would otherwise be left committed with nothing pointing at it —
 * **not** harmless: the candidate is created `SHARED` with a project, and
 * Russell's tick judges and can launch any unjudged `SHARED` candidate,
 * orphan or not. So a crash between the two writes, or two passes racing on
 * the same round key, could produce a research mission Brain pays for while
 * no round points at it and its answer is never absorbed. Rolling both writes
 * back together makes a lost race exactly as if this call had never happened.
 */
export async function openPuzzleAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: PuzzleSnapshot;
}): Promise<OpenedPuzzleRound[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const out: OpenedPuzzleRound[] = [];
  for (const ask of input.asks) {
    const composed = compose({ ask, objective: mode.objective, snapshot: input.snapshot });
    if (!composed) continue;

    let round: PuzzleRound;
    try {
      round = await getDb().transaction(async (): Promise<PuzzleRound> => {
        const candidate = await createCandidate({
          projectId: input.projectId,
          visibility: 'SHARED',
          conversationId: null,
          sourceMessageId: null,
          title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
          statement: composed.question,
        });

        const result = await openPuzzleRound({
          projectId: input.projectId,
          cashModeId: mode.id,
          purpose: ask.purpose,
          formatKey: ask.formatKey,
          productClass: ask.productClass,
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

    const candidateId = round.candidateId;
    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: round.id,
        purpose: ask.purpose,
        formatKey: ask.formatKey,
        productClass: ask.productClass,
        candidateId,
        round: ask.round,
        /*
         * The allocator's own reason, recorded beside the work it produced —
         * so "why did Brain research this" resolves to a sentence written at
         * the moment it was decided, over a snapshot that has since moved.
         */
        why: ask.why,
        rank: ask.rank,
      },
    });

    out.push({
      roundId: round.id,
      purpose: ask.purpose,
      formatKey: ask.formatKey,
      productClass: ask.productClass,
      candidateId,
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
  snapshot: PuzzleSnapshot;
}): { title: string; question: string } | null {
  const { ask, objective } = input;

  if (ask.purpose === 'SEED_FORMATS') {
    return { title: SEED_TITLE, question: seedQuestion(objective, ask.round) };
  }

  const view = ask.formatKey
    ? input.snapshot.formats.find((one) => one.key === ask.formatKey)
    : null;
  const name = ask.formatName ?? view?.name ?? null;
  if (!name) return null;

  if (ask.purpose === 'DEMAND') {
    return {
      title: demandTitle(name),
      question: demandQuestion({
        format: name,
        objective,
        round: ask.round,
        knownBuyers: (view?.demand ?? []).map((one) => one.buyer),
      }),
    };
  }

  if (ask.purpose === 'CHANNEL') {
    return {
      title: channelTitle(name),
      question: channelQuestion({
        format: name,
        objective,
        round: ask.round,
        knownChannels: (view?.channels ?? []).map((one) => one.name),
      }),
    };
  }

  if (ask.purpose === 'PRODUCTION') {
    return {
      title: productionTitle(name),
      question: productionQuestion({ format: name, objective, round: ask.round }),
    };
  }

  if (ask.purpose === 'RIGHTS') {
    return {
      title: rightsTitle(name),
      question: rightsQuestion({ format: name, objective, round: ask.round }),
    };
  }

  if (!ask.productClass) return null;

  /*
   * The lines this class cannot be costed without and has no figure for,
   * named in the question. A worker told which four numbers are missing looks
   * for those four; one told to establish the economics reports the shelf
   * price, which is the number that is easy to find and the one that settles
   * nothing.
   */
  const held = new Set(
    (view?.economics ?? [])
      .filter((one) => one.productClass === ask.productClass)
      .map((one) => one.component),
  );
  const missing = [
    'NET_RECEIPT_PER_UNIT',
    ...loadBearingFor(ask.productClass),
  ].filter((one) => !held.has(one as PuzzleEconomic['component']));

  return {
    title: economicsTitle(name, ask.productClass),
    question: economicsQuestion({
      format: name,
      productClass: ask.productClass,
      objective,
      round: ask.round,
      missing,
    }),
  };
}

/* --------------------------------------------------------------------------
 * Filing what came back
 * ------------------------------------------------------------------------ */

export interface Filed {
  formats: PuzzleFormatEntry[];
  demand: PuzzleDemand[];
  routes: PuzzleRoute[];
  economics: PuzzleEconomic[];
  constraints: PuzzleConstraint[];
  settled: { roundId: string; found: number }[];
  /** Reported rather than guessed at. A refusal is evidence, not a silence. */
  refused: { claimId: string; why: string }[];
}

/**
 * A fresh, empty report.
 *
 * A function rather than a shared constant, because every field is an array
 * and a constant spread into a new object hands out the *same* array to every
 * caller — which works until somebody adds a field and forgets to override it,
 * at which point two passes append to one list and nobody sees why.
 */
function emptyFiled(): Filed {
  return {
    formats: [],
    demand: [],
    routes: [],
    economics: [],
    constraints: [],
    settled: [],
    refused: [],
  };
}

/**
 * File every declared finding from the rounds that are still open.
 *
 * Not gated by the sprint's lifecycle, deliberately and for `harvest`'s own
 * reason: filing what research already found is not new discovery — the
 * spending happened when it ran — and dropping results because the sprint
 * wound down would throw away work already paid for.
 */
export async function filePuzzleFindings(input: {
  projectId: string;
  limit?: number;
}): Promise<Filed> {
  const out: Filed = emptyFiled();
  const mode = await getCashMode(input.projectId);
  if (!mode) return out;

  const live = await openPuzzleRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to, through the mission — because
   * a mission is what links a round's candidate to the orchestration it
   * launched. An orchestration with no mission belongs to no kernel round,
   * which is honest rather than a gap: nobody asked a kernel question for it,
   * and filing its claims would put facts into the map under a subject nothing
   * chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<string, { round: PuzzleRound; missionDone: boolean }>();
  for (const mission of missions) {
    if (!mission.orchestrationId || !mission.candidateId) continue;
    const round = live.get(mission.candidateId);
    if (round) {
      byOrchestration.set(mission.orchestrationId, {
        round,
        missionDone: mission.state === 'DONE',
      });
    }
  }
  if (byOrchestration.size === 0) return out;

  const foundPerRound = new Map<string, number>();
  const claims = await puzzleClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit: Math.max(1, input.limit ?? 200),
  });

  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    const filed = await file({ projectId: input.projectId, claim: entry.claim, out });
    /*
     * `found` counts what the round *established*, not what this pass wrote.
     *
     * §38 records the defect exactly: a round's claims are filed on the pass
     * they are gated and the round settles on the pass its mission reaches
     * DONE, which is routinely a later one. Counting creations would record
     * `found = 0` for a round that produced everything it produced, and
     * `BARREN_ROUNDS` of those retires the question that was working best.
     */
    if (filed !== 'REFUSED') {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   * A round whose mission has finished records what it produced — **including
   * nothing** — because leaving a barren round OPEN would stop it ever being
   * asked again while looking like it was still running.
   */
  for (const [, { round, missionDone }] of byOrchestration) {
    if (!missionDone) continue;
    const found = foundPerRound.get(round.id) ?? 0;
    const settled = await settlePuzzleRound({ roundId: round.id, found });
    if (settled?.state === 'SETTLED') out.settled.push({ roundId: round.id, found });
  }

  const written =
    out.formats.length +
    out.demand.length +
    out.routes.length +
    out.economics.length +
    out.constraints.length;
  if (written > 0) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: FILED,
      actorRef: 'BRAIN',
      summary:
        `${out.formats.length} format(s), ${out.demand.length} buyer(s), ` +
        `${out.routes.length} route(s), ${out.economics.length} figure(s) and ` +
        `${out.constraints.length} rule(s) were filed from what the puzzle kernel established.`,
      detail: {
        formatIds: out.formats.map((one) => one.id),
        demandIds: out.demand.map((one) => one.id),
        routeIds: out.routes.map((one) => one.id),
        economicIds: out.economics.map((one) => one.id),
        constraintIds: out.constraints.map((one) => one.id),
        refused: out.refused,
      },
    });
  }
  return out;
}

/**
 * One declared finding into the one table its kind belongs in.
 *
 * Three answers rather than two, and the third is what makes the round's
 * `found` honest. `CREATED` is a row this pass wrote; `EXISTS` is one an
 * earlier pass already wrote from the same claim, which the round still
 * established; `REFUSED` is a declaration that could not be filed at all.
 */
type Filing = 'CREATED' | 'EXISTS' | 'REFUSED';

async function file(input: {
  projectId: string;
  claim: ResearchClaim;
  out: Filed;
}): Promise<Filing> {
  const { claim, out } = input;
  const finding = claim.puzzleFinding;
  if (!finding) return 'REFUSED';
  const subject = claim.puzzleSubject;
  if (!subject) {
    out.refused.push({ claimId: claim.id, why: 'the finding named no subject' });
    return 'REFUSED';
  }

  const target = targetForFinding(finding);

  /*
   * Every finding that names a format puts that format on the map, whatever
   * else it does. A demand signal for a kind of puzzle nobody has recorded is
   * evidence that the kind exists, and requiring a separate FORMAT_EVIDENCE
   * claim to say so would lose it — the two facts arrive together and the
   * second is implied by the first.
   */
  if (claim.puzzleFormat) {
    const { format, created } = await createPuzzleFormat({
      projectId: input.projectId,
      name: claim.puzzleFormat,
      note: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created) out.formats.push(format);
  }

  if (target === 'FORMAT') {
    if (!claim.puzzleFormat) {
      out.refused.push({ claimId: claim.id, why: 'a format finding named no format' });
      return 'REFUSED';
    }
    /*
     * The format row is the finding. Whether this pass created it or an
     * earlier one did, the round established that the format exists.
     */
    return out.formats.some((one) => one.sourceClaimId === claim.id) ? 'CREATED' : 'EXISTS';
  }

  if (target === 'DEMAND') {
    if (!claim.puzzleFormat) {
      out.refused.push({ claimId: claim.id, why: 'a demand signal named no format' });
      return 'REFUSED';
    }
    const { demand, created } = await recordPuzzleDemand({
      projectId: input.projectId,
      formatName: claim.puzzleFormat,
      buyer: subject,
      statement: claim.claim,
      publisher: claim.sourcePublisher,
      observedOn: claim.sourceDate,
      sourceClaimId: claim.id,
    });
    if (created) out.demand.push(demand);
    return created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'ROUTE') {
    const kind = routeKindForFinding(finding);
    if (!kind || !claim.puzzleFormat) {
      out.refused.push({ claimId: claim.id, why: 'a route finding named no format' });
      return 'REFUSED';
    }
    const { route, created } = await recordPuzzleRoute({
      projectId: input.projectId,
      kind,
      formatName: claim.puzzleFormat,
      name: subject,
      terms: claim.claim,
      publisher: claim.sourcePublisher,
      observedOn: claim.sourceDate,
      sourceClaimId: claim.id,
    });
    if (created) out.routes.push(route);
    return created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'ECONOMIC') {
    const component = claim.puzzleValue;
    if (
      !isPuzzleEconomicComponent(component) ||
      !claim.puzzleFormat ||
      !claim.puzzleProductClass ||
      claim.puzzleAmountCents === null ||
      !claim.puzzleCurrency
    ) {
      out.refused.push({
        claimId: claim.id,
        why: 'a figure was missing its line, format, product class, amount or currency',
      });
      return 'REFUSED';
    }
    const { economic, created } = await recordPuzzleEconomic({
      projectId: input.projectId,
      formatName: claim.puzzleFormat,
      productClass: claim.puzzleProductClass,
      component,
      amountCents: claim.puzzleAmountCents,
      currency: claim.puzzleCurrency,
      /*
       * The basis is `puzzle_subject`, which for an economic finding is
       * defined as what the figure is *per*. A figure whose basis Brain
       * guessed at is a figure nobody can check, and adding a per-run cost to
       * a per-unit price is the arithmetic this kernel most needs not to do.
       */
      basisNote: subject,
      publisher: claim.sourcePublisher,
      observedOn: claim.sourceDate,
      sourceClaimId: claim.id,
    });
    if (created) out.economics.push(economic);
    return created ? 'CREATED' : 'EXISTS';
  }

  const kind = claim.puzzleValue;
  if (!isPuzzleRightsConstraint(kind)) {
    out.refused.push({ claimId: claim.id, why: 'a rights constraint named no kind of rule' });
    return 'REFUSED';
  }
  const { constraint, created } = await recordPuzzleConstraint({
    projectId: input.projectId,
    kind,
    subject,
    statement: claim.claim,
    authority: claim.sourcePublisher,
    sourceClaimId: claim.id,
  });
  if (created) out.constraints.push(constraint);
  return created ? 'CREATED' : 'EXISTS';
}
