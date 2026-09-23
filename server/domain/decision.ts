/**
 * What a decision about an objective is made of, and the one pure function
 * that makes it.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Brain could already discover openings, qualify them, enumerate every way of
 * being paid for one, rank those, commission research on their unknowns, and
 * start execution inside a grant a person set. What nothing did was answer the
 * question a person actually asks: *given what we are trying to do, what can we
 * actually do, and what is the first step?* The answer had to be assembled by
 * hand from a portfolio, a ledger, a capability reading, a grant and a queue —
 * and the research kept going wherever a column count pointed rather than
 * where the choice was undecided.
 *
 * So a decision is a **derivation**, never a stored verdict (§43's rule: a
 * register stores an intent and derives everything else). The objective is a
 * row because what somebody meant is not recoverable from any other row; the
 * candidate paths, their tests, the recommendation and the first step are all
 * read from the rows the rest of Brain already writes, every time.
 *
 * ---------------------------------------------------------------------------
 * The rules that keep it honest
 * ---------------------------------------------------------------------------
 *
 *  - **A transaction type is not an executable opportunity.** A path qualifies
 *    only when every criterion that applies to it reads MET. A possible way of
 *    being paid with nothing established about it is OPEN, and it never ranks
 *    as if it were further along than it is.
 *  - **An unknown is never a favourable assumption** (invariant 39). UNKNOWN is
 *    a reading in its own right; it never reads as MET and it never makes a
 *    path rank higher.
 *  - **A path is rejected only for an evidenced reason.** NOT_MET on a reading
 *    backed by a fact or a measured row rejects it; NOT_MET resting on an
 *    estimate is reported and does not, because an estimate is not grounds for
 *    discarding a possibility (invariant 47).
 *  - **A boundary is not a rejection.** Missing authority or a missing
 *    integration is `NEEDS_PERSON`: the path may be the right one and still be
 *    waiting on a decision only a person can make.
 *  - **No probability and no score.** The order is lexicographic over named
 *    facts, so *why is this above that* resolves to the first criterion they
 *    differ on — the same reason `monetization/rank.ts` refuses weights.
 *  - **Research serves the pending choice.** The only research this proposes is
 *    the first unknown on the leading path — the one question whose answer can
 *    change what Brain recommends. Nothing on a rejected path is researched, and
 *    once a path qualifies no research is proposed at all.
 */

/**
 * The tests a candidate path is put to, in the order they are asked.
 *
 * The order is load-bearing: it is the order the lexicographic ranking reads,
 * and it is upstream first — there is no point establishing what delivery costs
 * for something nobody is shown to want.
 */
export const DECISION_CRITERIA = [
  'DEMAND',
  'REACH',
  'PRODUCTION',
  'DELIVERY',
  'COST',
  'TIME',
  'CAPACITY',
  'AUTHORITY',
] as const;
export type DecisionCriterion = (typeof DECISION_CRITERIA)[number];

export const CRITERION_LABEL: Readonly<Record<DecisionCriterion, string>> = Object.freeze({
  DEMAND: 'Evidence somebody wants it',
  REACH: 'A buyer or user we can actually reach',
  PRODUCTION: 'Our ability to produce it',
  DELIVERY: 'How it is delivered',
  COST: 'What it costs, against what we have',
  TIME: 'How long it takes, and whether the window is open',
  CAPACITY: 'Capacity to run it now',
  AUTHORITY: 'Authority to take the first step',
});

/**
 * What one test said.
 *
 * `NEEDS_PERSON` is a boundary rather than a failure: the path could be right
 * and is waiting on a grant, an integration or a decision only a person can
 * supply. `NOT_APPLICABLE` is a real answer — a purely creative project has no
 * buyer to reach — and is never counted as MET or as missing.
 */
export const CRITERION_READINGS = ['MET', 'NOT_MET', 'UNKNOWN', 'NEEDS_PERSON', 'NOT_APPLICABLE'] as const;
export type CriterionReading = (typeof CRITERION_READINGS)[number];

/**
 * What kind of statement a reading rests on.
 *
 * Kept visibly apart because a proposal shown the way a source is shown has
 * told somebody a guess was checked. `MEASURED` is a figure Brain read from its
 * own rows (a ledger balance, a capability reading, a date that has passed);
 * `FACT` is a gated claim; `ESTIMATE` is Brain's proposal with its basis;
 * `DECISION` is something a person recorded.
 */
export const EVIDENCE_KINDS = ['FACT', 'MEASURED', 'ESTIMATE', 'DECISION', 'UNKNOWN'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface CriterionAssessment {
  criterion: DecisionCriterion;
  reading: CriterionReading;
  kind: EvidenceKind;
  /** One sentence, composed by the server. */
  statement: string;
  /** Where to check it: a claim id, a row id, or the reading that produced it. */
  evidenceRef: string | null;
  /** What would answer it, when it is not answered. */
  task: string | null;
}

/** Where a candidate path came from. Each is a row some other part of Brain wrote. */
export const PATH_SOURCES = [
  'CASH_OPPORTUNITY',
  'DEAL',
  'IDEA',
  'SOFTWARE_REQUEST',
] as const;
export type PathSource = (typeof PATH_SOURCES)[number];

/** What the first executable step on a path would be, by kind of work. */
export const STEP_KINDS = [
  /** The existing bounded deep dive on one opening, steered to go first. */
  'QUALIFY_OPENING',
  /** One bounded research question, as a Russell idea the loop judges and launches. */
  'RESEARCH_QUESTION',
  /** A change to code, as an unauthorized factory request a person authorizes. */
  'SOFTWARE_REQUEST',
  /** An effect on the world that needs a commercial grant: prepared, never performed here. */
  'COMMERCIAL_ACTION',
  /** Something already running; the step is to wait for it and read the answer. */
  'AWAIT_EXISTING',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface CandidatePath {
  /** `SOURCE:id`, stable across reads. */
  ref: string;
  source: PathSource;
  title: string;
  /** The claim or row it rests on. */
  sourceRef: string | null;
  /** How it would pay, or what it would produce, where anything says. */
  how: string | null;
  assessments: CriterionAssessment[];
  /**
   * What the path's own first step would be once it qualifies — a commercial
   * action for a Cash opening, a software request, a mission. Null where the
   * source says nothing about it.
   */
  executionStep: PlannedStep | null;
  /**
   * What would resolve its first unknown, where Brain has a way to ask. Null
   * when there is no route left — both deep dives spent, nothing published.
   */
  researchStep: PlannedStep | null;
  /** The economics and effort, each with its kind. Never invented. */
  economics: { label: string; value: string | null; kind: EvidenceKind; basis: string | null }[];
  /**
   * Where the machinery that owns this path already ranks it, 0 first — Cash's
   * own portfolio order for an opening. Null where the owner has no order.
   *
   * Used only to break a tie these tests cannot, so equals are ordered by a
   * ranking somebody already argued for rather than by an identifier.
   */
  ownerRank?: number | null;
}

export interface PlannedStep {
  kind: StepKind;
  /** What the step does, in a sentence a person reads. */
  description: string;
  /** Which criterion it serves — the question it is asked to settle. */
  serves: DecisionCriterion | null;
  /** Whether it may run now, or needs a person first. */
  authority: 'AUTHORIZED' | 'NEEDS_PERSON';
  /** When it needs a person: exactly what decision, and where it is made. */
  boundary: string | null;
  /** The concrete action prepared for a person to approve, where there is one. */
  prepared: Record<string, unknown> | null;
  /** The existing work item, where the step is to wait for one already running. */
  existingWork: { kind: string; id: string } | null;
}

export type PathStanding = 'QUALIFIES' | 'OPEN' | 'REJECTED';

export interface JudgedPath extends CandidatePath {
  standing: PathStanding;
  /** Why it stands where it does. */
  because: string;
  /** For a rejection: the evidenced reading that decided it. */
  rejectedOn: CriterionAssessment | null;
  /** The first criterion that is not yet MET, which is what research would ask. */
  firstOpen: CriterionAssessment | null;
}

export type DecisionVerdict = 'RECOMMEND' | 'NO_PATH_QUALIFIES' | 'STOP';

export interface DecisionOutcome {
  verdict: DecisionVerdict;
  /** The path that leads, if any is not rejected. */
  leading: JudgedPath | null;
  /** The other live paths, each with why it ranks lower than the one above it. */
  alternatives: { path: JudgedPath; whyLower: string }[];
  rejected: JudgedPath[];
  /** The step Brain proposes to take next, or null for a justified stop. */
  nextStep: PlannedStep | null;
  /** The path that step belongs to. */
  nextStepPath: string | null;
  /** Why this verdict: the decisive reasons, in words. */
  reasons: string[];
  /** What would make Brain continue, revise or stop — derived, never guessed. */
  watch: { continueIf: string | null; reviseIf: string | null; stopIf: string | null };
}

/** How many live alternatives a brief names. The rest are counted, never dropped. */
export const ALTERNATIVES_SHOWN = 3;

/** Readings that decide a rejection: a sourced fact or a measured row, never an estimate. */
const DECISIVE_KINDS: ReadonlySet<EvidenceKind> = new Set(['FACT', 'MEASURED', 'DECISION']);

export function judgePath(path: CandidatePath): JudgedPath {
  const rejectedOn =
    path.assessments.find((one) => one.reading === 'NOT_MET' && DECISIVE_KINDS.has(one.kind)) ?? null;
  if (rejectedOn) {
    return {
      ...path,
      standing: 'REJECTED',
      because: `${CRITERION_LABEL[rejectedOn.criterion]}: ${rejectedOn.statement}`,
      rejectedOn,
      firstOpen: null,
    };
  }
  const firstOpen =
    path.assessments.find(
      (one) => one.reading === 'UNKNOWN' || one.reading === 'NOT_MET',
    ) ?? null;
  if (firstOpen) {
    return {
      ...path,
      standing: 'OPEN',
      because:
        `Not yet established — ${CRITERION_LABEL[firstOpen.criterion].toLowerCase()}: ` +
        firstOpen.statement,
      rejectedOn: null,
      firstOpen,
    };
  }
  return {
    ...path,
    standing: 'QUALIFIES',
    because: path.assessments.some((one) => one.reading === 'NEEDS_PERSON')
      ? 'Every test that applies is met; what remains is a decision or an integration only a person can supply.'
      : 'Every test that applies is met.',
    rejectedOn: null,
    firstOpen: null,
  };
}

/** How far a path has got, as the index of its first criterion that is not settled. */
function depth(path: JudgedPath): number {
  if (!path.firstOpen) return DECISION_CRITERIA.length;
  return DECISION_CRITERIA.indexOf(path.firstOpen.criterion);
}

function met(path: JudgedPath): number {
  return path.assessments.filter((one) => one.reading === 'MET').length;
}

function sourced(path: JudgedPath): number {
  return path.assessments.filter((one) => one.reading === 'MET' && one.kind !== 'ESTIMATE').length;
}

function boundaries(path: JudgedPath): number {
  return path.assessments.filter((one) => one.reading === 'NEEDS_PERSON').length;
}

/**
 * The order, and the reason for it, as one list of named comparisons.
 *
 * Lexicographic: the first rule two paths differ on decides, and nothing below
 * it was consulted. Each rule is a count of readings — never a weight.
 */
const ORDER: readonly {
  name: string;
  compare: (a: JudgedPath, b: JudgedPath) => number;
  sentence: (lower: JudgedPath, higher: JudgedPath) => string;
}[] = [
  {
    name: 'standing',
    compare: (a, b) => standingRank(b.standing) - standingRank(a.standing),
    sentence: (lower) =>
      lower.standing === 'OPEN'
        ? `it does not qualify yet — ${lower.because}`
        : `it is ${lower.standing.toLowerCase()}`,
  },
  {
    name: 'depth',
    compare: (a, b) => depth(b) - depth(a),
    sentence: (lower, higher) =>
      `it stops earlier: its first open test is ${
        lower.firstOpen ? CRITERION_LABEL[lower.firstOpen.criterion].toLowerCase() : 'none'
      }, where the leading path has already settled that and stops at ${
        higher.firstOpen ? CRITERION_LABEL[higher.firstOpen.criterion].toLowerCase() : 'nothing'
      }`,
  },
  {
    name: 'sourced',
    compare: (a, b) => sourced(b) - sourced(a),
    sentence: (lower, higher) =>
      `fewer of its tests rest on a source or a measurement (${sourced(lower)} against ${sourced(higher)})`,
  },
  {
    name: 'met',
    compare: (a, b) => met(b) - met(a),
    sentence: (lower, higher) => `fewer of its tests are met (${met(lower)} against ${met(higher)})`,
  },
  {
    name: 'boundaries',
    compare: (a, b) => boundaries(a) - boundaries(b),
    sentence: (lower, higher) =>
      `it waits on more decisions only a person can make (${boundaries(lower)} against ${boundaries(higher)})`,
  },
  {
    name: 'researchable',
    compare: (a, b) => Number(b.researchStep !== null) - Number(a.researchStep !== null),
    sentence: () => 'Brain has no route left to establish its first open test',
  },
  {
    name: 'ownerRank',
    compare: (a, b) => (a.ownerRank ?? Number.MAX_SAFE_INTEGER) - (b.ownerRank ?? Number.MAX_SAFE_INTEGER),
    sentence: (lower, higher) =>
      `nothing in these tests separates them, and the ranking that already owns them puts it lower (${
        (lower.ownerRank ?? 0) + 1
      } against ${(higher.ownerRank ?? 0) + 1})`,
  },
  {
    name: 'ref',
    compare: (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    sentence: () =>
      'nothing recorded separates the two; the order between them is only their identifiers',
  },
];

function standingRank(standing: PathStanding): number {
  return standing === 'QUALIFIES' ? 2 : standing === 'OPEN' ? 1 : 0;
}

export function comparePaths(a: JudgedPath, b: JudgedPath): number {
  for (const rule of ORDER) {
    const order = rule.compare(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

/** Why `lower` ranks below `higher`, named from the first rule they differ on. */
export function whyLower(lower: JudgedPath, higher: JudgedPath): string {
  for (const rule of ORDER) {
    if (rule.compare(higher, lower) !== 0) return rule.sentence(lower, higher);
  }
  return 'nothing recorded separates them';
}

/**
 * The decision itself. Pure over the paths handed to it.
 *
 * It cannot be used as a safety mechanism and is not one: taking a step goes
 * through the machinery that owns that kind of work, which decides again.
 */
export function decide(paths: CandidatePath[]): DecisionOutcome {
  const judged = paths.map(judgePath);
  const rejected = judged.filter((one) => one.standing === 'REJECTED');
  const live = judged.filter((one) => one.standing !== 'REJECTED').sort(comparePaths);
  const leading = live[0] ?? null;
  const alternatives = live.slice(1, 1 + ALTERNATIVES_SHOWN).map((path, index) => ({
    path,
    whyLower: whyLower(path, index === 0 ? leading! : live[index]!),
  }));

  if (leading && leading.standing === 'QUALIFIES') {
    const step = leading.executionStep;
    const reasons = [
      `"${leading.title}" is the one path where every applicable test is met.`,
      ...(step?.authority === 'NEEDS_PERSON' && step.boundary ? [step.boundary] : []),
    ];
    const runnerUp = live[1] ?? null;
    return {
      verdict: 'RECOMMEND',
      leading,
      alternatives,
      rejected,
      nextStep: step,
      nextStepPath: step ? leading.ref : null,
      reasons,
      watch: {
        continueIf: step
          ? `the first step (${step.description}) produces a response from the buyer or user it names.`
          : null,
        reviseIf: runnerUp
          ? `the first step shows a test that read as met is not — then "${runnerUp.title}" leads.`
          : 'the first step shows a test that read as met is not.',
        stopIf: 'the first step is refused outright, or what it costs turns out larger than what may be deployed.',
      },
    };
  }

  if (leading) {
    /*
     * Nothing qualifies. The one research step worth taking is the leading
     * path's first open test — the only question whose answer can change what
     * Brain recommends. A path further down cannot overtake the leader without
     * the leader's own question being answered first, so asking about it now
     * would be research that does not change the choice.
     *
     * If the leader has no route left, the next live path that does is taken,
     * and saying so is part of the reason.
     */
    const researchable = live.find((one) => one.researchStep !== null) ?? null;
    const reasons: string[] = [
      `No candidate path passes every test yet. ${live.length} ${
        live.length === 1 ? 'is' : 'are'
      } still open and ${rejected.length} ${rejected.length === 1 ? 'was' : 'were'} rejected on evidence.`,
      ...decisiveGaps(live),
    ];
    if (!researchable) {
      reasons.push(
        'Brain has no route left to establish the open tests on any live path: the bounded research on each is spent or has nothing published to ask about.',
      );
      return {
        verdict: 'STOP',
        leading,
        alternatives,
        rejected,
        nextStep: null,
        nextStepPath: null,
        reasons,
        watch: {
          continueIf: null,
          reviseIf: 'new evidence arrives about a live path — a new opening, or a person answering one of its tests.',
          stopIf: 'already: nothing can be established from here without new evidence or a decision.',
        },
      };
    }
    if (researchable !== leading) {
      reasons.push(
        `"${leading.title}" leads but Brain has no route left to settle its first open test, so the next path Brain can move is "${researchable.title}".`,
      );
    }
    const question = researchable.firstOpen!;
    return {
      verdict: 'NO_PATH_QUALIFIES',
      leading,
      alternatives,
      rejected,
      nextStep: { ...researchable.researchStep!, serves: question.criterion },
      nextStepPath: researchable.ref,
      reasons,
      watch: {
        continueIf: `the research establishes ${CRITERION_LABEL[question.criterion].toLowerCase()} for "${researchable.title}" — then its next open test is asked, or it qualifies.`,
        reviseIf: `it establishes that ${CRITERION_LABEL[question.criterion].toLowerCase()} is not met — then that path is rejected and ${
          live.find((one) => one !== researchable)?.title
            ? `"${live.find((one) => one !== researchable)!.title}" leads`
            : 'nothing is left open'
        }.`,
        stopIf: 'every live path is rejected or has no route left to establish its open tests.',
      },
    };
  }

  return {
    verdict: 'STOP',
    leading: null,
    alternatives: [],
    rejected,
    nextStep: null,
    nextStepPath: null,
    reasons:
      rejected.length > 0
        ? [
            `Every candidate path was rejected on evidence (${rejected.length}).`,
            ...rejected.slice(0, 3).map((one) => `"${one.title}" — ${one.because}`),
          ]
        : ['Brain holds no candidate path for this objective yet: nothing has been discovered, captured or requested under it.'],
    watch: {
      continueIf: null,
      reviseIf: 'a new opening, idea or request is recorded against this project.',
      stopIf: 'already.',
    },
  };
}

/**
 * The gaps that decide *no path qualifies*, counted across the live paths.
 *
 * A count of first-open tests by criterion, so "most of these stop at the same
 * question" is a sentence about rows rather than a feeling.
 */
function decisiveGaps(live: JudgedPath[]): string[] {
  const counts = new Map<DecisionCriterion, number>();
  for (const one of live) {
    if (!one.firstOpen) continue;
    counts.set(one.firstOpen.criterion, (counts.get(one.firstOpen.criterion) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || DECISION_CRITERIA.indexOf(a[0]) - DECISION_CRITERIA.indexOf(b[0]))
    .slice(0, 3)
    .map(
      ([criterion, count]) =>
        `${count} of ${live.length} stop at the same test: ${CRITERION_LABEL[criterion].toLowerCase()}.`,
    );
}

/**
 * A stable fingerprint of what the decision *is*, so a snapshot is appended
 * only when it changes — the verdict, the leading path, and the step.
 */
export function decisionFingerprint(outcome: DecisionOutcome): string {
  return [
    outcome.verdict,
    outcome.leading?.ref ?? '-',
    outcome.leading?.standing ?? '-',
    outcome.leading?.firstOpen?.criterion ?? '-',
    // The step's authority matters only once a path qualifies: a grant being
    // set is then what moves the recommendation from "waiting on you" to
    // "Brain can do this". Before that, the research step moving from
    // proposed to running is progress, not a changed recommendation.
    outcome.verdict === 'RECOMMEND' ? (outcome.nextStep?.authority ?? '-') : '-',
  ].join('|');
}
