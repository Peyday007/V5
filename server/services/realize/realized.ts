/**
 * The five dimensions nothing moved, and the one nothing here may.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 *
 * `faculties` carries six independent states and `moveDimension` can write all
 * of them. In production it had exactly one caller — `promoteCandidate` — and
 * that caller moves `DEFINITION` and nothing else. So five of the six columns
 * were written by nothing at all, which is §29's sentence at a new altitude: a
 * column nothing writes is not a state, it is a default with a name on it, and
 * every reader of `describeFaculty` was reading `ABSENT` and `UNTESTED` off a
 * row that had never been asked.
 *
 * That is not a small defect here, because `docs/CAPABILITY-KERNEL.md` §8 says
 * in as many words that no faculty is implemented and nothing in the kernel can
 * move either dimension. It was an honest report of a real absence. This is the
 * absence closed, and closing it is only worth anything if the readings are
 * refusable — a derivation that always produced an answer would turn six honest
 * columns into six confident wrong ones.
 *
 * ---------------------------------------------------------------------------
 * The three rules that decide every branch below
 * ---------------------------------------------------------------------------
 *
 * **A packet with an unclassified gap yields no implementation reading.** Not
 * `ABSENT`, not `PARTIAL` — no reading at all. `NEEDS_A_READING` is the kernel
 * saying a name comparison matched nothing and somebody has to look; deriving
 * an implementation state over it would be answering the question the gap
 * exists to ask. §30's rule, at the column that decides whether work gets
 * created: *we could not tell* must never read the same as *we checked*.
 *
 * **An `UNKNOWN` answer may raise a state and may never lower one.** The
 * deployed image carries `server` and `client` and not `tests`, so a running
 * Brain reads `EVALUATED: UNKNOWN` about everything it is made of. A reading
 * that took that as `NO` would walk a proven faculty back to `UNTESTED` on
 * every scan taken in production, and the next reader would rebuild something
 * that works. So a state only ever moves down on evidence that is itself a
 * reading.
 *
 * **`AVAILABILITY` is a person's and there is no function here that moves it.**
 * Not a check inside a mover — the absence of a mover, asserted by a test that
 * reads this file. Whether a faculty is switched on for real work is the one
 * dimension whose wrong answer is not a wrong belief but a wrong action, and
 * the kernel's own table already says a person moves it. A Brain that could
 * switch its own faculties on would be §22's worker creating its own work, one
 * altitude up.
 */
import type { FacultyDimension } from '../../domain/faculties.ts';
import type { Faculty } from '../../repos/faculties.ts';
import { getFaculty, moveDimension } from '../../repos/faculties.ts';
import { getComponent } from '../selfmodel/scan.ts';
import type { Answer, EvidenceLevel } from '../selfmodel/levels.ts';
import { getPacket, listGaps, currentSections } from './packet.ts';
import type { PacketGap } from './packet.ts';

/**
 * The dimensions this module may read.
 *
 * `DEFINITION` is ingestion's and stays there; `AVAILABILITY` is a person's and
 * is deliberately absent. `FRESHNESS` is a fact about a *later source* rather
 * than about a packet, so it belongs to whatever registers that source — this
 * module can see a packet and cannot see a document nobody has filed yet.
 */
export const DERIVED_DIMENSIONS: readonly FacultyDimension[] = [
  'CONTRACT',
  'IMPLEMENTATION',
  'EVALUATION',
];

/**
 * The dimensions nothing in this module may move, and why each one is out.
 *
 * A constant rather than a sentence in a comment, so a later change that wants
 * one of them has to delete an entry somebody wrote a reason next to.
 */
export const REFUSED_DIMENSIONS: Readonly<Record<string, string>> = {
  DEFINITION:
    'A definition becomes canonical by being read out of an audited source. Deriving one from ' +
    'the state of the code would make the implementation the authority on what it was supposed ' +
    'to be.',
  AVAILABILITY:
    'Whether a faculty is switched on for real work is a person\'s decision. Nothing here moves ' +
    'it, and that is the absence of a mover rather than a check inside one.',
  FRESHNESS:
    'A definition goes stale because a later source says something different. That is a fact ' +
    'about a document, and this module can only see a packet.',
};

export interface DimensionReading {
  dimension: FacultyDimension;
  /** The state the rows support, or null when they support none. */
  to: string | null;
  /** Why, in one sentence, whichever way it went. */
  reason: string;
  /** What was read: gap ids, component keys, section names. Never a summary. */
  basis: string[];
  /** Set when a reading exists but is refused for lowering a state on an unknown. */
  withheld: string | null;
}

export interface RealizationReading {
  packetId: string;
  facultyId: string;
  facultySlug: string;
  readings: DimensionReading[];
}

/* ------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* ------------------------------------------------------------------------- */

const IMPLEMENTATION_ORDER = ['ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE'] as const;
const EVALUATION_ORDER = ['UNTESTED', 'FAILING', 'PASSING', 'PRODUCTION_PROVEN'] as const;
const CONTRACT_ORDER = ['MISSING', 'DRAFT', 'COMPILED'] as const;

const ORDERS: Record<string, readonly string[]> = {
  IMPLEMENTATION: IMPLEMENTATION_ORDER,
  EVALUATION: EVALUATION_ORDER,
  CONTRACT: CONTRACT_ORDER,
};

/**
 * Is `to` below `from` on that dimension's own ladder?
 *
 * `FAILING` is deliberately *above* `UNTESTED` and not beside it: a suite that
 * ran and failed is more known than one that never ran, and a reading that
 * moved a failing faculty back to untested would erase the failure.
 */
export function lowers(dimension: string, from: string, to: string): boolean {
  const order = ORDERS[dimension];
  if (!order) return false;
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return false;
  return b < a;
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * What the rows say about this faculty's contract, implementation and
 * evaluation — and where they say nothing.
 *
 * Read-only by construction: it writes nothing, so it can be called from a
 * projection, a report or a tick without any of them having to know which.
 */
export async function readRealization(packetId: string): Promise<RealizationReading> {
  const packet = await getPacket(packetId);
  if (!packet) throw new Error(`No such packet: ${packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) throw new Error(`Packet ${packetId} names a faculty that does not exist.`);

  const gaps = await listGaps(packetId);
  const sections = await currentSections(packetId);

  const readings: DimensionReading[] = [
    contractReading(faculty, sections),
    await implementationReading(faculty, gaps),
    await evaluationReading(faculty, gaps),
  ];

  return {
    packetId,
    facultyId: faculty.id,
    facultySlug: faculty.slug,
    readings,
  };
}

/**
 * A cognitive contract exists, or it is a draft, or nobody has written one.
 *
 * The cheapest of the three and the only one that is purely a fact about rows
 * this packet owns. `COMPILED` needs the target topology as well as the
 * contract, because a contract with nothing to build against is a description
 * rather than a specification.
 */
function contractReading(
  faculty: Faculty,
  sections: Array<{ section: string; version: number; authorKind: string }>,
): DimensionReading {
  const contract = sections.find((row) => row.section === 'COGNITIVE_CONTRACT');
  const topology = sections.find((row) => row.section === 'TARGET_TOPOLOGY');
  const basis = sections
    .filter((row) => row.section === 'COGNITIVE_CONTRACT' || row.section === 'TARGET_TOPOLOGY')
    .map((row) => `${row.section} v${row.version} (${row.authorKind})`);

  if (!contract) {
    return {
      dimension: 'CONTRACT',
      to: guard(faculty.contractState, 'MISSING', 'CONTRACT'),
      reason: 'No cognitive contract has been written for this faculty.',
      basis,
      withheld: withheldFor(faculty.contractState, 'MISSING', 'CONTRACT'),
    };
  }
  if (!topology) {
    return {
      dimension: 'CONTRACT',
      to: guard(faculty.contractState, 'DRAFT', 'CONTRACT'),
      reason:
        'A cognitive contract is written, and the target topology it would be built against is ' +
        'not, so it states an intent rather than a specification.',
      basis,
      withheld: withheldFor(faculty.contractState, 'DRAFT', 'CONTRACT'),
    };
  }
  return {
    dimension: 'CONTRACT',
    to: guard(faculty.contractState, 'COMPILED', 'CONTRACT'),
    reason: 'A cognitive contract and the topology it is built against are both written.',
    basis,
    withheld: withheldFor(faculty.contractState, 'COMPILED', 'CONTRACT'),
  };
}

/**
 * How much of what this faculty requires actually exists and is reached.
 *
 * The gap kinds are the input and the self-model decides the last step. A
 * requirement served by a component nobody imports is `EXISTS_BUT_DISCONNECTED`
 * — which is exactly the defect this repository has recorded five times under
 * *a mechanism nothing calls is not a mechanism* — so a faculty whose every
 * requirement is matched but whose components are unreached reads `CONNECTED`
 * rather than `LIVE`, and the difference is the whole point of having four
 * values instead of two.
 */
async function implementationReading(
  faculty: Faculty,
  gaps: PacketGap[],
): Promise<DimensionReading> {
  const live = gaps.filter((gap) => gap.state === 'OPEN' || gap.state === 'ASSIGNED');
  const unread = live.filter((gap) => gap.kind === 'NEEDS_A_READING');

  if (gaps.length === 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: null,
      reason:
        'This packet has no gaps yet, so nothing has been compared against anything. Derive it ' +
        'first; an implementation state over an underived packet would be a statement about an ' +
        'empty list.',
      basis: [],
      withheld: null,
    };
  }

  if (unread.length > 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: null,
      reason:
        `${unread.length} gap(s) still need a reading, so how much of this faculty exists is ` +
        'not established. Answering anyway would settle by derivation the exact question the ' +
        'gap exists to ask somebody.',
      basis: unread.slice(0, 20).map((gap) => `${gap.id} ${gap.aspect}: ${gap.requirement}`),
      withheld: null,
    };
  }

  const served = gaps.filter(
    (gap) =>
      gap.kind === 'EXISTS_AND_LIVE' ||
      gap.kind === 'EXISTS_BUT_DISCONNECTED' ||
      gap.state === 'CLOSED' ||
      gap.state === 'WAIVED',
  );
  const outstanding = live.filter(
    (gap) =>
      gap.kind === 'MUST_BE_BUILT' ||
      gap.kind === 'MUST_BE_REPLACED' ||
      gap.kind === 'EXISTS_BUT_INSUFFICIENT' ||
      gap.kind === 'MUST_BE_RESEARCHED',
  );

  const basis = [
    `${served.length} of ${gaps.length} requirement(s) are served, closed or waived`,
    `${outstanding.length} still need building, replacing, deepening or researching`,
  ];

  if (served.length === 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: guard(faculty.implementationState, 'ABSENT', 'IMPLEMENTATION'),
      reason: 'No requirement of this faculty is served by anything the self-model can see.',
      basis,
      withheld: withheldFor(faculty.implementationState, 'ABSENT', 'IMPLEMENTATION'),
    };
  }

  if (outstanding.length > 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: guard(faculty.implementationState, 'PARTIAL', 'IMPLEMENTATION'),
      reason:
        `${served.length} requirement(s) are served and ${outstanding.length} are not, so this ` +
        'faculty is partly built.',
      basis,
      withheld: withheldFor(faculty.implementationState, 'PARTIAL', 'IMPLEMENTATION'),
    };
  }

  // Everything is served. Whether it is *reached* is the self-model's answer,
  // and an UNKNOWN there is not a yes.
  const disconnected = gaps.filter((gap) => gap.kind === 'EXISTS_BUT_DISCONNECTED');
  // Asked of the requirements something actually serves. A closed or waived gap
  // is not a component whose reach could be observed, so counting it would make
  // every waiver an unknown and put a genuinely live faculty at CONNECTED.
  const matched = gaps.filter(
    (gap) => gap.kind === 'EXISTS_AND_LIVE' || gap.kind === 'EXISTS_BUT_DISCONNECTED',
  );
  const reach = await reachOf(matched);
  basis.push(
    `${reach.connected} component(s) read CONNECTED: YES, ${reach.unknown} UNKNOWN, ${reach.no} NO`,
  );

  /*
   * A packet whose every requirement was closed or waived says nothing about
   * whether the faculty runs.
   *
   * Found by re-reading the diff rather than by a test, which is why it is
   * worth naming: `served` counts a `CLOSED` or `WAIVED` gap, correctly — those
   * requirements are genuinely not outstanding — and `reach` is asked only of
   * the gaps something actually serves. With every gap waived that set is
   * empty, every count is zero, and the branch below fell through to `LIVE`. A
   * waiver means *another faculty's packet owns this*, which is the opposite of
   * a reading that it works.
   *
   * So `LIVE` needs at least one requirement served by a component whose reach
   * was observed. With none there is no reading at all — not `CONNECTED`, which
   * would be the same invention one rung lower.
   */
  if (matched.length === 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: null,
      reason:
        'Nothing outstanding remains, and no requirement is matched to anything — every one was ' +
        'closed or waived. That says where the requirements went rather than whether this ' +
        'faculty runs.',
      basis,
      withheld: null,
    };
  }

  if (disconnected.length > 0 || reach.no > 0 || reach.unknown > 0) {
    return {
      dimension: 'IMPLEMENTATION',
      to: guard(faculty.implementationState, 'CONNECTED', 'IMPLEMENTATION'),
      reason:
        'Every requirement is served by something that exists, and at least one of those things ' +
        'is not established to be reached by anything running. A module nobody imports is not a ' +
        'mechanism.',
      basis,
      withheld: withheldFor(faculty.implementationState, 'CONNECTED', 'IMPLEMENTATION'),
    };
  }

  return {
    dimension: 'IMPLEMENTATION',
    to: guard(faculty.implementationState, 'LIVE', 'IMPLEMENTATION'),
    reason:
      'Every requirement is served, and every component serving one is reached by something in ' +
      'the running process.',
    basis,
    withheld: withheldFor(faculty.implementationState, 'LIVE', 'IMPLEMENTATION'),
  };
}

/**
 * Whether this faculty has been tested, and whether it has run for real.
 *
 * The one branch worth reading twice is the absence of a `FAILING` derivation.
 * A suite that fails is a fact this module cannot see: the self-model records
 * that a suite *exists*, deliberately and by its own header, and says nothing
 * about whether it passes. So `FAILING` is reachable only from something that
 * actually ran one, and never from here — an evaluator that inferred failure
 * from an absence would produce exactly the alarm nobody can act on.
 */
async function evaluationReading(faculty: Faculty, gaps: PacketGap[]): Promise<DimensionReading> {
  const declared = faculty.definition.evaluationRequirements ?? [];
  if (declared.length === 0) {
    return {
      dimension: 'EVALUATION',
      to: null,
      reason:
        'This faculty declares no evaluation requirements, so there is no standard to report it ' +
        'against. An evaluation state here would be a verdict with no exam behind it.',
      basis: [],
      withheld: null,
    };
  }

  const evaluationGaps = gaps.filter((gap) => gap.aspect === 'evaluationRequirements');
  const open = evaluationGaps.filter((gap) => gap.state === 'OPEN' || gap.state === 'ASSIGNED');
  const unread = open.filter((gap) => gap.kind === 'NEEDS_A_READING');
  const unmet = open.filter(
    (gap) =>
      gap.kind === 'MUST_BE_BUILT' ||
      gap.kind === 'MUST_BE_REPLACED' ||
      gap.kind === 'EXISTS_BUT_INSUFFICIENT',
  );

  const basis = [
    `${declared.length} declared evaluation requirement(s)`,
    `${evaluationGaps.length} gap(s) on the evaluation aspect`,
  ];

  if (evaluationGaps.length === 0 || unread.length > 0) {
    return {
      dimension: 'EVALUATION',
      to: null,
      reason:
        evaluationGaps.length === 0
          ? 'The packet holds no gap on the evaluation aspect, so its evaluation requirements ' +
            'have not been compared against anything.'
          : `${unread.length} evaluation requirement(s) still need a reading.`,
      basis,
      withheld: null,
    };
  }

  if (unmet.length > 0) {
    return {
      dimension: 'EVALUATION',
      to: guard(faculty.evaluationState, 'UNTESTED', 'EVALUATION'),
      reason:
        `${unmet.length} of this faculty's own evaluation requirements are not served by ` +
        'anything, so it has not been tested against the standard it declares.',
      basis,
      withheld: withheldFor(faculty.evaluationState, 'UNTESTED', 'EVALUATION'),
    };
  }

  const proof = await proofOf(evaluationGaps);
  basis.push(
    `${proof.evaluated} component(s) read EVALUATED: YES, ${proof.proven} PRODUCTION_PROVEN: YES, ` +
      `${proof.unknown} unknown`,
  );

  if (proof.evaluated === 0) {
    return {
      dimension: 'EVALUATION',
      to: null,
      reason:
        'Every evaluation requirement is served by something, and nothing establishes that any ' +
        'of it is covered by a suite. A running Brain cannot see `tests/` at all, so this is ' +
        'most often a reading that has to be taken from a checkout rather than a finding.',
      basis,
      withheld: null,
    };
  }

  if (proof.proven > 0 && proof.proven === proof.evaluated) {
    return {
      dimension: 'EVALUATION',
      to: guard(faculty.evaluationState, 'PRODUCTION_PROVEN', 'EVALUATION'),
      reason:
        'Every evaluation requirement is served, covered by a suite, and has rows showing it ran ' +
        'in production to a terminal result.',
      basis,
      withheld: withheldFor(faculty.evaluationState, 'PRODUCTION_PROVEN', 'EVALUATION'),
    };
  }

  return {
    dimension: 'EVALUATION',
    to: guard(faculty.evaluationState, 'PASSING', 'EVALUATION'),
    reason:
      'Every evaluation requirement is served and covered by a suite, and nothing here ' +
      'establishes that it has run in production.',
    basis,
    withheld: withheldFor(faculty.evaluationState, 'PASSING', 'EVALUATION'),
  };
}

/* ------------------------------------------------------------------------- */
/* The self-model, asked about the components a packet actually matched        */
/* ------------------------------------------------------------------------- */

/**
 * Count the self-model's answer at one level, over the components these gaps
 * matched — and count a gap that matched *nothing* as an unknown.
 *
 * That last clause is the one that matters and it was missing. A gap classified
 * `EXISTS_AND_LIVE` by a reader who named no component says something serves
 * the requirement and gives nothing to ask the self-model about; counting only
 * the named keys made an empty set read as "no unknowns", which walked straight
 * to `LIVE`. So a served requirement with no component behind it is an unknown
 * here, which is the honest reading and the one that cannot manufacture a
 * reach nobody observed.
 */
async function answersFor(
  gaps: PacketGap[],
  level: EvidenceLevel,
): Promise<{ yes: number; no: number; unknown: number }> {
  const keys = [...new Set(gaps.map((gap) => gap.componentKey).filter((k): k is string => !!k))];
  let yes = 0;
  let no = 0;
  let unknown = gaps.filter((gap) => !gap.componentKey).length;
  for (const key of keys) {
    const component = await getComponent(key);
    const answer: Answer = component?.answers[level] ?? 'UNKNOWN';
    if (answer === 'YES') yes += 1;
    else if (answer === 'NO') no += 1;
    else unknown += 1;
  }
  return { yes, no, unknown };
}

async function reachOf(
  gaps: PacketGap[],
): Promise<{ connected: number; no: number; unknown: number }> {
  const counts = await answersFor(gaps, 'CONNECTED');
  return { connected: counts.yes, no: counts.no, unknown: counts.unknown };
}

async function proofOf(
  gaps: PacketGap[],
): Promise<{ evaluated: number; proven: number; unknown: number }> {
  const evaluated = await answersFor(gaps, 'EVALUATED');
  const proven = await answersFor(gaps, 'PRODUCTION_PROVEN');
  return { evaluated: evaluated.yes, proven: proven.yes, unknown: evaluated.unknown };
}

/* ------------------------------------------------------------------------- */
/* The lowering guard                                                         */
/* ------------------------------------------------------------------------- */

/**
 * `to`, unless taking it would walk the dimension backwards.
 *
 * Every reading in this module is built partly out of `UNKNOWN` answers, and an
 * unknown is not a refutation. So a reading may raise a state freely and may
 * never lower one: a Brain scanning itself in production, where `tests/` is not
 * in the image, would otherwise report every proven faculty as untested on
 * every pass. Lowering a state is a real event and belongs to whatever actually
 * observed the regression.
 */
function guard(current: string, to: string, dimension: string): string | null {
  return lowers(dimension, current, to) ? null : to;
}

function withheldFor(current: string, to: string, dimension: string): string | null {
  if (!lowers(dimension, current, to)) return null;
  return (
    `The rows read ${to} and this faculty is recorded as ${current}. A reading built partly out ` +
    'of unknowns may raise a state and never lower one, so nothing was moved.'
  );
}

/* ------------------------------------------------------------------------- */
/* Applying                                                                   */
/* ------------------------------------------------------------------------- */

export interface RealizationApplied {
  packetId: string;
  facultySlug: string;
  moved: Array<{ dimension: FacultyDimension; to: string; reason: string }>;
  unchanged: Array<{ dimension: FacultyDimension; why: string }>;
}

/**
 * Take the readings that exist, and record the ones that do not as unchanged.
 *
 * `moveDimension` writes the column and the event together and returns false
 * for a move to the state a faculty is already in, so applying twice records
 * one event — idempotent by the state rather than by a flag, which is the shape
 * this repository already settled on for the audit reopen.
 *
 * `viaIngestion` is never passed. This is not an ingestion path and must not
 * borrow the scope assertion written for one.
 */
export async function applyRealization(input: {
  packetId: string;
  actorType: string;
  actorId?: string | null;
}): Promise<RealizationApplied> {
  const reading = await readRealization(input.packetId);
  const moved: RealizationApplied['moved'] = [];
  const unchanged: RealizationApplied['unchanged'] = [];

  for (const row of reading.readings) {
    if (row.to === null) {
      unchanged.push({ dimension: row.dimension, why: row.withheld ?? row.reason });
      continue;
    }
    const changed = await moveDimension({
      facultyId: reading.facultyId,
      dimension: row.dimension,
      to: row.to,
      reason: `${row.reason} Read from packet ${input.packetId}: ${row.basis.join('; ')}`,
      evidenceRef: input.packetId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
    });
    if (changed) moved.push({ dimension: row.dimension, to: row.to, reason: row.reason });
    else
      unchanged.push({
        dimension: row.dimension,
        why: `Already ${row.to}; a move to the state a faculty is already in records nothing.`,
      });
  }

  return {
    packetId: input.packetId,
    facultySlug: reading.facultySlug,
    moved,
    unchanged,
  };
}
