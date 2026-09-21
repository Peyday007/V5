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
 * finding lands in; nothing here inspects a sentence, infers a format from
 * prose, or decides that a requirement *sounds* like a uniqueness rule. That
 * is §8 at the tables that decide whether a book of puzzles can be solved, and
 * it is what makes this kernel's contents about published reality rather than
 * about what a model expected the trade to contain.
 *
 * ---------------------------------------------------------------------------
 * Every branch refuses rather than improvises
 * ---------------------------------------------------------------------------
 *
 * A standard whose claim names no format, an economic line with no basis, a
 * demand signal on a round that names no route — each is *reported as refused*
 * rather than attached to the nearest plausible thing. Attaching it would be
 * Brain deciding what a fact was about, which is the confidently wrong answer
 * §25 records.
 *
 * ---------------------------------------------------------------------------
 * `found` is counted from rows, never tallied from one pass
 * ---------------------------------------------------------------------------
 *
 * §33 and §45 both record the defect: claims are filed on the pass they are
 * gated and a round settles on a later one, so a tick that dies between them
 * makes a round that established five things record none — and `BARREN_ROUNDS`
 * of those retires the question that was working best. So `file` answers
 * CREATED, EXISTS or REFUSED, and `found` counts the first two: a claim that
 * collided with a row an earlier pass wrote still established that row.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { puzzleClaims } from '../../repos/research.ts';
import {
  createFormat,
  createRoute,
  getFormatByKey,
  listRoutes,
  openRound,
  openRoundsByCandidate,
  recordEconomicLine,
  recordRightsConstraint,
  recordRouteEvidence,
  recordStandard,
  settleRound,
} from '../../repos/puzzle.ts';
import {
  formatKey,
  isEconomicComponent,
  isRightsKind,
  isRouteClass,
  isValidationCheck,
  postureForFinding,
  targetForFinding,
} from '../../domain/puzzle.ts';
import { readPuzzleDirective } from './directive.ts';
import {
  CHEAP_BOOK_TITLE,
  cheapBookQuestion,
  demandQuestion,
  demandTitle,
  economicsQuestion,
  economicsTitle,
  rightsQuestion,
  rightsTitle,
  ROUTE_TITLE,
  routeQuestion,
  standardQuestion,
  standardTitle,
  UNIVERSE_TITLE,
  universeQuestion,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type { PuzzleRound, ResearchClaim } from '../../domain/types.ts';

const OPENED = 'PUZZLE_ROUND_OPENED';
const FILED = 'PUZZLE_FINDINGS_FILED';

export interface OpenedPuzzleRound {
  roundId: string;
  purpose: Ask['purpose'];
  subjectKey: string | null;
  subjectLabel: string | null;
  candidateId: string;
  round: number;
  title: string;
  question: string;
  why: string;
}

/**
 * Turn allocated asks into Russell candidates and rounds.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything.
 */
export async function openPuzzleAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: PuzzleSnapshot;
}): Promise<{ opened: OpenedPuzzleRound[]; blocked: string | null }> {
  if (input.asks.length === 0) return { opened: [], blocked: null };

  const read = await readPuzzleDirective();
  if (!read.ok) {
    /*
     * Reported rather than thrown, and nothing is opened. A kernel that asked
     * its questions without the directive would be asking different questions
     * from the ones it was given — §39's defect, where a hash proved integrity
     * and not one word reached a worker.
     */
    return { opened: [], blocked: read.reason };
  }
  const directive = read.directive;

  const opened: OpenedPuzzleRound[] = [];
  for (const ask of input.asks) {
    const composed = compose({ ask, directive, snapshot: input.snapshot });
    if (!composed) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const result = await openRound({
      projectId: input.projectId,
      purpose: ask.purpose,
      subjectKey: ask.subjectKey,
      subjectLabel: ask.subjectLabel,
      round: ask.round,
      candidateId: candidate.id,
      why: ask.why,
    });
    if (!result.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: result.round.id,
        purpose: ask.purpose,
        subjectKey: ask.subjectKey,
        candidateId: candidate.id,
        round: ask.round,
        /*
         * The allocator's own reason, recorded beside the work it produced —
         * so "why did Brain research this" resolves to a sentence written at
         * the moment it was decided, over a snapshot that has since moved.
         */
        why: ask.why,
        rank: ask.rank,
        directive: { path: directive.path, digest: directive.digest },
      },
    });

    opened.push({
      roundId: result.round.id,
      purpose: ask.purpose,
      subjectKey: ask.subjectKey,
      subjectLabel: ask.subjectLabel,
      candidateId: candidate.id,
      round: ask.round,
      title: composed.title,
      question: composed.question,
      why: ask.why,
    });
  }
  return { opened, blocked: null };
}

/** The title and the question for one ask. Exported so a test can read what a worker would. */
export function compose(input: {
  ask: Ask;
  directive: Parameters<typeof universeQuestion>[0];
  snapshot: PuzzleSnapshot;
}): { title: string; question: string } | null {
  const { ask, directive, snapshot } = input;

  if (ask.purpose === 'UNIVERSE') {
    return { title: UNIVERSE_TITLE, question: universeQuestion(directive, ask.round) };
  }
  if (ask.purpose === 'ROUTE') {
    return { title: ROUTE_TITLE, question: routeQuestion(directive, ask.round) };
  }
  if (ask.purpose === 'CHEAP_BOOK') {
    return { title: CHEAP_BOOK_TITLE, question: cheapBookQuestion(directive, ask.round) };
  }

  const label = ask.subjectLabel;
  if (!label) return null;

  if (ask.purpose === 'DEMAND') {
    const format = snapshot.formats.find((one) => one.formatKey === ask.subjectKey);
    return {
      title: demandTitle(label),
      question: demandQuestion({
        directive,
        subject: label,
        formatName: format?.name ?? null,
        round: ask.round,
      }),
    };
  }
  if (ask.purpose === 'ECONOMICS') {
    return {
      title: economicsTitle(label),
      question: economicsQuestion({ directive, subject: label, round: ask.round }),
    };
  }
  if (ask.purpose === 'RIGHTS') {
    return {
      title: rightsTitle(label),
      question: rightsQuestion({ directive, formatName: label, round: ask.round }),
    };
  }
  if (ask.purpose === 'STANDARD') {
    return {
      title: standardTitle(label),
      question: standardQuestion({ directive, formatName: label, round: ask.round }),
    };
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Filing what came back
 * ------------------------------------------------------------------------ */

export interface Filed {
  formats: string[];
  standards: string[];
  rights: string[];
  routes: string[];
  routeEvidence: string[];
  economics: string[];
  settled: { roundId: string; found: number }[];
  /** Reported rather than guessed at. A refusal is evidence, not a silence. */
  refused: { claimId: string; why: string }[];
}

function emptyFiled(): Filed {
  return {
    formats: [],
    standards: [],
    rights: [],
    routes: [],
    routeEvidence: [],
    economics: [],
    settled: [],
    refused: [],
  };
}

type Outcome = 'CREATED' | 'EXISTS' | 'REFUSED';

/**
 * File every declared finding from the rounds that are still open.
 *
 * Not gated by the sprint's lifecycle, deliberately: filing what research
 * already found is not new discovery — the spending happened when it ran — and
 * dropping results because the sprint wound down would throw away work already
 * paid for. §30's rule that winding down ends new discovery and never a
 * customer's obligation, applied one kernel along.
 */
export async function fileFindings(input: {
  projectId: string;
  limit?: number;
}): Promise<Filed> {
  const out = emptyFiled();
  const mode = await getCashMode(input.projectId);
  if (!mode) return out;

  const live = await openRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to, through the mission — because a
   * mission is what links a round's candidate to the orchestration it
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

  const found = new Map<string, number>();
  const claims = await puzzleClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit: input.limit,
  });

  // Routes are looked up by key rather than re-queried per claim, because a
  // demand signal has to attach to the route it is about and most rounds
  // carry several signals for one route.
  const routes = new Map<string, string>();
  for (const route of await listRoutes(input.projectId)) routes.set(route.routeKey, route.id);

  for (const { claim, orchestrationId } of claims) {
    const belongs = byOrchestration.get(orchestrationId);
    if (!belongs) continue;
    const outcome = await fileOne({
      projectId: input.projectId,
      claim,
      round: belongs.round,
      routes,
      out,
    });
    if (outcome !== 'REFUSED') {
      found.set(belongs.round.id, (found.get(belongs.round.id) ?? 0) + 1);
    }
  }

  /*
   * Settle only the rounds whose mission has actually finished. A round whose
   * research is still running has claims arriving; settling it now would
   * record a count that is true of this instant and false a pass later, and
   * `BARREN_ROUNDS` reads exactly that count.
   */
  for (const [, belongs] of byOrchestration) {
    if (!belongs.missionDone) continue;
    const count = found.get(belongs.round.id) ?? 0;
    const settled = await settleRound({
      id: belongs.round.id,
      state: count > 0 ? 'HARVESTED' : 'ABANDONED',
      found: count,
      reason:
        count > 0
          ? `The research finished and ${count} declared finding(s) were filed.`
          : 'The research finished and nothing it established carried a declaration this ' +
            'kernel could file. That is an answer rather than a failure, and two of them ' +
            'retire the question.',
    });
    if (settled) out.settled.push({ roundId: settled.id, found: count });
  }

  if (
    out.formats.length +
      out.standards.length +
      out.rights.length +
      out.routes.length +
      out.routeEvidence.length +
      out.economics.length >
    0
  ) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: FILED,
      actorRef: 'BRAIN',
      summary:
        `${out.formats.length} format(s), ${out.standards.length} standard(s), ` +
        `${out.rights.length} rights rule(s), ${out.routes.length} route(s), ` +
        `${out.routeEvidence.length} demand row(s) and ${out.economics.length} figure(s) filed.`,
      detail: {
        formats: out.formats,
        standards: out.standards,
        rights: out.rights,
        routes: out.routes,
        routeEvidence: out.routeEvidence,
        economics: out.economics,
        refused: out.refused.length,
      },
    });
  }

  return out;
}

/** One claim, into whichever table its declaration names. */
async function fileOne(input: {
  projectId: string;
  claim: ResearchClaim;
  round: PuzzleRound;
  routes: Map<string, string>;
  out: Filed;
}): Promise<Outcome> {
  const { claim, round, routes, out } = input;
  const finding = claim.puzzleFinding;
  if (!finding) return 'REFUSED';

  const refuse = (why: string): Outcome => {
    out.refused.push({ claimId: claim.id, why });
    return 'REFUSED';
  };

  const subject = claim.puzzleSubject?.trim();
  if (!subject) return refuse('The claim carries a finding and names no subject.');

  const target = targetForFinding(finding);

  if (target === 'FORMAT') {
    const result = await createFormat({
      projectId: input.projectId,
      name: subject,
      audience: null,
      note: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (result.created) out.formats.push(result.format.id);
    return result.created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'STANDARD') {
    if (!isValidationCheck(claim.puzzleValue)) {
      return refuse('The claim declares a standard whose check is not one a validator can run.');
    }
    const key = claim.puzzleFormat ? formatKey(claim.puzzleFormat) : null;
    if (!key) return refuse('A standard names no format, so nothing could be judged by it.');
    /*
     * The format has to exist first. A standard filed against a format nothing
     * has discovered would be a requirement nobody could ever satisfy, and
     * inventing the format from a standard's own field would be Brain deciding
     * the universe from a claim about something else.
     */
    if (!(await getFormatByKey(input.projectId, key))) {
      return refuse(
        `A standard was declared for "${claim.puzzleFormat}", which is not a format on the ` +
          'map. The format has to be established before what it demands can be.',
      );
    }
    const result = await recordStandard({
      projectId: input.projectId,
      formatKey: key,
      checkKind: claim.puzzleValue,
      statement: claim.claim,
      authority: claim.sourcePublisher,
      sourceClaimId: claim.id,
    });
    if (result.created) out.standards.push(result.standard.id);
    return result.created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'RIGHTS') {
    if (!isRightsKind(claim.puzzleValue)) {
      return refuse('The claim declares a rights rule whose kind is not one of the closed set.');
    }
    const key = claim.puzzleFormat ? formatKey(claim.puzzleFormat) : null;
    if (!key) return refuse('A rights rule names no format, so nothing is bound by it.');
    if (!(await getFormatByKey(input.projectId, key))) {
      return refuse(
        `A rights rule was declared for "${claim.puzzleFormat}", which is not a format on the ` +
          'map.',
      );
    }
    const result = await recordRightsConstraint({
      projectId: input.projectId,
      formatKey: key,
      rightsKind: claim.puzzleValue,
      statement: claim.claim,
      authority: claim.sourcePublisher,
      sourceClaimId: claim.id,
    });
    if (result.created) out.rights.push(result.constraint.id);
    return result.created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'ROUTE') {
    if (!isRouteClass(claim.puzzleValue)) {
      return refuse('The claim declares a route whose class is not one of the closed set.');
    }
    const result = await createRoute({
      projectId: input.projectId,
      name: subject,
      routeClass: claim.puzzleValue,
      note: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    routes.set(result.route.routeKey, result.route.id);
    if (result.created) out.routes.push(result.route.id);
    return result.created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'ROUTE_EVIDENCE') {
    const posture = postureForFinding(finding);
    if (!posture) return refuse('The finding declares no posture, so the row would say nothing.');
    /*
     * The round decides which route this is about where it names one, and the
     * claim's own subject is the buyer rather than the route — so a signal
     * from a round about no particular route has nowhere to attach, and is
     * refused rather than filed against whichever route happened to be first.
     */
    const resolved = round.subjectKey ? findRouteById(routes, round.subjectKey) : null;
    if (!resolved) {
      return refuse(
        'The round this came from names no route on the ledger, so a demand signal from it ' +
          'has nothing to attach to. Attaching it to the nearest route would be Brain deciding ' +
          'what the fact was about.',
      );
    }
    if (posture === 'DEMAND_FOUND' && !claim.puzzleObservedOn) {
      return refuse(
        'A demand signal arrived with no observation date, which the door should have refused.',
      );
    }
    const evidence = await recordRouteEvidence({
      projectId: input.projectId,
      routeId: resolved,
      posture,
      buyer: subject,
      formatKey: claim.puzzleFormat ?? null,
      statement: claim.claim,
      observedOn: claim.puzzleObservedOn,
      sourceClaimId: claim.id,
    });
    out.routeEvidence.push(evidence.id);
    return 'CREATED';
  }

  /* ECONOMICS */
  if (!isEconomicComponent(claim.puzzleValue)) {
    return refuse('The claim declares a figure whose component is not one of the closed set.');
  }
  if (claim.puzzleAmountMinor === null || !claim.puzzleCurrency || !claim.puzzleBasis) {
    return refuse(
      'A figure arrived without its amount, its currency or its basis. All three only mean ' +
        'anything together, and the door should have refused it.',
    );
  }
  const line = await recordEconomicLine({
    projectId: input.projectId,
    routeId: round.subjectKey ? findRouteById(routes, round.subjectKey) : null,
    formatKey: claim.puzzleFormat ?? null,
    component: claim.puzzleValue,
    basis: claim.puzzleBasis,
    amountMinor: claim.puzzleAmountMinor,
    currency: claim.puzzleCurrency,
    statement: claim.claim,
    observedOn: claim.puzzleObservedOn,
    sourceClaimId: claim.id,
  });
  out.economics.push(line.id);
  return 'CREATED';
}

/**
 * A round's subject key is a route **id** for the route-scoped purposes and a
 * format key for the format-scoped ones, so this answers only for the former.
 * Returning null rather than guessing is the point: a figure filed against the
 * wrong route is a figure in somebody else's arithmetic.
 */
function findRouteById(routes: Map<string, string>, subjectKey: string): string | null {
  for (const id of routes.values()) if (id === subjectKey) return id;
  return null;
}
