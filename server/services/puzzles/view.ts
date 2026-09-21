/**
 * The whole kernel as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Numbers first, and every one of them counted from rows
 * ---------------------------------------------------------------------------
 *
 * Nothing here is estimated, projected or scored. Where a figure cannot be
 * counted it is `null` with the thing that would measure it named — §41
 * reports four figures that way and §30 records why: an invented number about
 * money or production is read as a measurement by somebody deciding whether to
 * spend.
 *
 * ---------------------------------------------------------------------------
 * The monetization ledger is Cash Mode's, and this points at it
 * ---------------------------------------------------------------------------
 *
 * The brief asks for a persistent ledger of every credible monetization route,
 * with a Top 5 Now and nothing ever deleted. That is `cash_opportunities` and
 * `services/cash/portfolio.ts` — tiers, ranking, blocked and archived with
 * reasons, all of it already built and already read by a surface. Building a
 * second one here would be the duplicate dashboard the order forbids, and it
 * would be the one that drifts.
 *
 * What this kernel contributes to that ledger is claims: a worker answering a
 * DEMAND or CHANNEL question sets `opportunity_signal` beside its
 * `puzzle_finding` — the axes are independent and the submission tool says so
 * — and Cash Mode's own bridge turns a signalled claim into an opening. So the
 * route from "a publisher publishes what it pays" to "this is a ranked
 * opening" is one that already exists, and this file names where to read it
 * rather than reproducing it.
 *
 * ---------------------------------------------------------------------------
 * The physical ladder is the manufacturing programme's
 * ---------------------------------------------------------------------------
 *
 * Same argument. §39 holds machine categories, what capabilities this company
 * actually has, demand-before-capability ordering and the rule that only a
 * person may record a holding. A second ladder here would be a second answer
 * to "can we make this ourselves", and the quieter of the two would be wrong.
 */
import { listRounds } from '../../repos/puzzles.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../russell/launch.ts';
import { allocate, MAX_OPEN_PUZZLE_ROUNDS } from './allocate.ts';
import { puzzleSnapshot, type PuzzleSnapshot } from './map.ts';
import { supportFor, supportedSlugs, unimplementedReason } from './registry.ts';
import { readValidation } from './validate.ts';
import { rightsPermitPublication } from '../../domain/puzzles.ts';
import { TICK_STOCK } from './kernel.ts';
import type { FormatMaturity } from '../../domain/types.ts';

export interface QualityReading {
  /** Puzzles that passed every check their format requires. */
  validated: number;
  /** Puzzles with a failing required check. Each one is a generator defect. */
  failing: number;
  /** Puzzles a check could not establish anything about. */
  unproven: number;
  /** Puzzles in a format nothing in this repository can check at all. */
  uncheckable: number;
  /** Of everything checkable, the share that passed. Null when nothing is. */
  passRate: number | null;
  /** Generation attempts that re-found a puzzle already held. */
  duplicatesRejected: number | null;
  /** Masters stopped because their output was systematically wrong. */
  blockedMasters: { id: string; name: string; reason: string }[];
  /** What this Brain's checking does not establish, declared by the registry. */
  knownGaps: string[];
}

export interface PuzzleView {
  projectId: string;
  at: string;

  rightNow: {
    formats: number;
    generatableFormats: number;
    masters: number;
    puzzles: number;
    validatedPuzzles: number;
    editions: number;
    qualifiedEditions: number;
    compiledEditions: number;
    /** Revenue is not readable from here. Said, rather than reported as zero. */
    revenue: { value: null; wouldMeasureIt: string };
  };

  /** Every format, with the rung it has reached and what stops the next one. */
  standing: {
    formatId: string;
    name: string;
    reached: FormatMaturity;
    blocker: string | null;
    generatable: boolean;
    validated: number;
    qualifiedEditions: number;
  }[];

  /** What Brain is producing unattended right now, and what it is waiting on. */
  beingMade: {
    masterId: string;
    name: string;
    format: string | null;
    held: number;
    validated: number;
    stock: string;
    publishable: boolean;
  }[];

  leverage: PuzzleSnapshot['leverage'];
  quality: QualityReading;

  /** Every edition, qualified or not, with the conditions still outstanding. */
  catalog: {
    editionId: string;
    name: string;
    productClass: string;
    qualified: boolean;
    carried: number;
    validated: number;
    compiled: boolean;
    axis: string;
    outstanding: { key: string; why: string }[];
  }[];

  research: {
    open: { roundId: string; purpose: string; format: string | null; since: string }[];
    settled: number;
    /** What the allocator would ask next, and why. A projection; it opens nothing. */
    next: { purpose: string; subject: string; why: string }[];
    /** Why nothing is being asked, when nothing is. */
    declined: { subject: string; why: string }[];
  };

  /** Where the things this kernel deliberately does not hold actually live. */
  elsewhere: { what: string; where: string }[];

  /** Decisions only a person can make, each naming what it unblocks. */
  needsPerson: { what: string; why: string }[];

  /** What Brain will do by itself on the next tick. */
  next: string[];
}

export async function puzzleView(projectId: string): Promise<PuzzleView> {
  const snapshot = await puzzleSnapshot(projectId);
  const rounds = await listRounds(projectId);

  let validated = 0;
  let failing = 0;
  let unproven = 0;
  let uncheckable = 0;
  for (const instance of snapshot.context.instances.values()) {
    const format = snapshot.context.formats.get(instance.formatId);
    const reading = readValidation({
      formatSlug: format?.slug ?? '',
      instance,
      validations: snapshot.context.validations.get(instance.id) ?? [],
    });
    if (reading.state === 'VALIDATED') validated += 1;
    else if (reading.state === 'FAILED') failing += 1;
    else if (reading.state === 'UNCHECKABLE') uncheckable += 1;
    else unproven += 1;
  }
  const checkable = validated + failing + unproven;

  const knownGaps = [
    ...new Set(
      snapshot.formats.flatMap((one) => [...one.knownGaps]).concat([
        'Nothing here compiles a press-ready artifact. An edition compiles to a proof sheet — ' +
          'every puzzle and its answer key, rendered as text — with no typography, page ' +
          'architecture, trim, bleed or imposition. A layout compiler is a Software Factory ' +
          'change somebody approves.',
      ]),
    ),
  ];

  const openRounds = rounds.filter((one) => one.state === 'OPEN');
  const planned = allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_PUZZLE_ROUNDS - openRounds.length),
  });

  const formatName = (id: string | null) =>
    id ? (snapshot.context.formats.get(id)?.name ?? null) : null;

  /* ---------------------------------------------------------------------
   * What only a person can settle. Each one names what it unblocks, because
   * §24's rule is that an escalation with no answering transition is stuck
   * rather than waiting.
   * ------------------------------------------------------------------- */
  const needsPerson: PuzzleView['needsPerson'] = [];

  /*
   * Asked through the same check the kernel asks, rather than by reading the
   * grant row directly. Two readers of one authorization eventually disagree,
   * and the one on a screen disagreeing with the one that decides is §29's
   * status contradicting the control beside it.
   */
  const grant = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  if (!grant.ok) {
    needsPerson.push({
      what: 'Authorize standing research on this project.',
      why:
        `Nothing may be spent asking a published question here: ${grant.reason} Brain produces ` +
        'and checks puzzles either way — that spends nothing and is arithmetic on this ' +
        'machine — and it cannot establish who buys them, what they sell for or what the ' +
        'rights position is until somebody grants it.',
    });
  }

  for (const reading of snapshot.masters) {
    if (reading.blocked) {
      needsPerson.push({
        what: `Repair the generator behind "${reading.master.name}", then unblock it.`,
        why:
          `${reading.master.blockedReason ?? 'Its output failed a required check.'} Brain will ` +
          'not clear this itself: the block exists because the output was systematically ' +
          'wrong, and what makes it right is a code change somebody reviews. Patching the ' +
          'puzzles it already made is the one remedy this rule exists to refuse.',
      });
      continue;
    }
    if (!reading.publishable && reading.validated > 0) {
      needsPerson.push({
        what: `Record what "${reading.master.name}" stands on, or establish it by research.`,
        why:
          `It holds ${reading.validated} validated puzzle(s) and none of them may be sold, ` +
          'because nobody has said whether its content is public domain, this operation’s own ' +
          'work, or licensed. It may keep generating and checking — that publishes nothing — ' +
          'and it cannot reach a qualified edition.',
      });
    }
  }

  for (const edition of snapshot.editions) {
    if (edition.qualified || snapshot.context.editions.find((one) => one.id === edition.editionId)?.compiledAt) {
      continue;
    }
    const content = edition.conditions.find((one) => one.key === 'HAS_CONTENT');
    if (content?.state === 'NOT_MET') {
      needsPerson.push({
        what: `Put puzzles into the edition "${snapshot.context.editions.find((one) => one.id === edition.editionId)?.name ?? edition.editionId}".`,
        why: 'It carries none, so there is nothing for a buyer to receive and nothing to compile.',
      });
    }
  }

  if (snapshot.masters.length === 0) {
    const makeable = snapshot.formatRows.filter((one) => supportFor(one.slug) !== null);
    needsPerson.push({
      what: 'Declare a master — a reusable system — for a format Brain can generate.',
      why:
        makeable.length > 0
          ? `Brain can produce ${makeable.map((one) => one.name).join(', ')} and has no master ` +
            'to produce from. A master is the generator plus its parameters plus what its ' +
            'content stands on, and it is the thing the whole leverage argument multiplies.'
          : 'No format on the map is one this Brain can generate. Adding a generator is a ' +
            'Software Factory change somebody approves; what the registry currently implements ' +
            `is ${supportedSlugs().join(', ')}.`,
    });
  }

  /* ---------------------------------------------------------------------
   * What happens next without anybody.
   * ------------------------------------------------------------------- */
  const next: string[] = [];
  const topping = snapshot.masters.filter(
    (one) => !one.blocked && !one.master.retiredAt && one.instances < TICK_STOCK,
  );
  if (topping.length > 0) {
    next.push(
      `Produce and check more puzzles from ${topping.length} master(s), up to ${TICK_STOCK} ` +
        'each. Every one is checked as it is made, and a failing check stops that master ' +
        'rather than being patched.',
    );
  }
  if (planned.asks.length > 0) {
    next.push(
      `Open ${planned.asks.length} research question(s): ` +
        planned.asks.map((one) => `${one.purpose} on ${one.subject}`).join(', ') +
        '.',
    );
  }
  if (openRounds.length > 0) {
    next.push(
      `Absorb what ${openRounds.length} open question(s) establish, as their missions finish. ` +
        'A format a gated claim names goes on the map by itself.',
    );
  }
  if (next.length === 0) {
    next.push(
      'Nothing. Every master is at stock or blocked, no question can be opened, and nothing ' +
        'is outstanding — which is a statement about where this is rather than a failure.',
    );
  }

  return {
    projectId,
    at: snapshot.at,

    rightNow: {
      formats: snapshot.formatRows.length,
      generatableFormats: snapshot.formatRows.filter((one) => supportFor(one.slug) !== null).length,
      masters: snapshot.masters.length,
      puzzles: snapshot.context.instances.size,
      validatedPuzzles: validated,
      editions: snapshot.editions.length,
      qualifiedEditions: snapshot.editions.filter((one) => one.qualified).length,
      compiledEditions: snapshot.context.editions.filter((one) => one.compiledAt !== null).length,
      revenue: {
        value: null,
        wouldMeasureIt:
          'Nothing links an edition to a money entry, so revenue cannot be read from here. ' +
          'Cash Mode holds the ledger; until that link exists, silence about revenue is ' +
          'silence rather than zero.',
      },
    },

    standing: snapshot.formats.map((one) => ({
      formatId: one.formatId,
      name: one.name,
      reached: one.reached,
      blocker: one.blocker ? `${one.blocker.rung}: ${one.blocker.why}` : null,
      generatable: supportFor(one.slug) !== null,
      validated: one.counts.validated,
      qualifiedEditions: one.counts.qualifiedEditions,
    })),

    beingMade: snapshot.masters.map((one) => ({
      masterId: one.master.id,
      name: one.master.name,
      format: one.format?.name ?? null,
      held: one.instances,
      validated: one.validated,
      stock: one.blocked
        ? 'blocked — the generator is producing wrong puzzles'
        : one.master.retiredAt
          ? 'retired'
          : one.instances >= TICK_STOCK
            ? `at stock (${TICK_STOCK}); ask for a batch to make more`
            : 'topping up on every tick',
      publishable: rightsPermitPublication(one.master.rightsBasis),
    })),

    leverage: snapshot.leverage,

    quality: {
      validated,
      failing,
      unproven,
      uncheckable,
      passRate: checkable > 0 ? Number((validated / checkable).toFixed(3)) : null,
      /*
       * Not counted here, and said rather than reported as zero.
       *
       * A duplicate is refused by a unique index at the moment of generation,
       * so the only record of one is the batch event that reported it. Reading
       * the rate would mean summing those events, which is a real thing to
       * build and is not the same as a count of rows this reading can take.
       */
      duplicatesRejected: null,
      blockedMasters: snapshot.masters
        .filter((one) => one.blocked)
        .map((one) => ({
          id: one.master.id,
          name: one.master.name,
          reason: one.master.blockedReason ?? 'no reason recorded',
        })),
      knownGaps,
    },

    catalog: snapshot.editions.map((one) => {
      const row = snapshot.context.editions.find((edition) => edition.id === one.editionId);
      return {
        editionId: one.editionId,
        name: row?.name ?? one.editionId,
        productClass: row?.productClass ?? 'UNKNOWN',
        qualified: one.qualified,
        carried: one.carried,
        validated: one.validated,
        compiled: row?.compiledAt !== null && row?.compiledAt !== undefined,
        axis: row?.distinctnessAxis ?? 'UNKNOWN',
        outstanding: one.conditions
          .filter((condition) => condition.state !== 'MET')
          .map((condition) => ({ key: condition.key, why: condition.why })),
      };
    }),

    research: {
      open: openRounds.map((one) => ({
        roundId: one.id,
        purpose: one.purpose,
        format: formatName(one.formatId),
        since: one.openedAt,
      })),
      settled: rounds.filter((one) => one.state !== 'OPEN').length,
      next: planned.asks.map((one) => ({
        purpose: one.purpose,
        subject: one.subject,
        why: one.why,
      })),
      declined: planned.declined,
    },

    elsewhere: [
      {
        what: 'The monetization ledger — every credible route, ranked, with nothing deleted.',
        where:
          'Cash Mode’s portfolio (§30). A worker answering a DEMAND or CHANNEL question here ' +
          'sets opportunity_signal beside its puzzle_finding, and Cash Mode’s own bridge turns ' +
          'a signalled claim into a ranked opening. A second ledger here would be the one that ' +
          'drifts.',
      },
      {
        what: 'The physical production ladder, and what equipment this operation owns.',
        where:
          'The manufacturing programme (§39). It holds machine classes, demand-before- ' +
          'capability ordering, and the rule that only a person may record a capability as ' +
          'held. This kernel’s PRODUCTION questions establish what published sources say ' +
          'things cost; what is owned is recorded there.',
      },
      {
        what: 'Who or what produces each step of the work, and whether a person is needed.',
        where: 'The labor kernel (§41).',
      },
      {
        what: 'Building a generator or a validator for a format Brain cannot yet make.',
        where:
          'The Software Factory (§27), through a change request somebody approves. No row here ' +
          'can make a format generatable — that is what the registry being code rather than a ' +
          'column means.',
      },
    ],

    needsPerson,
    next,
  };
}

/** The honest sentence about a format nothing implements, for a caller that needs one. */
export function whyNotGeneratable(slug: string, name: string): string {
  return unimplementedReason(slug, name);
}
