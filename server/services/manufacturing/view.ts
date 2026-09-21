/**
 * The programme as a person reads it.
 *
 * One projection, derived on the read path, for §29's reason: two surfaces
 * inferring their own status from the same rows is how a person comes to read
 * two different answers about one programme.
 *
 * Nothing here is stored and nothing here writes. Reading the programme
 * performs no effect at all — no round opened, no capability held, no category
 * created — which is asserted by the tests rather than stated in this comment.
 */
import { ladderSnapshot, type LadderSnapshot } from './ladder.ts';
import { listEvents } from '../../repos/events.ts';
import { pathOf } from '../../domain/manufacturing.ts';
import { planFrom } from './kernel.ts';
import { bridgesTo, readLadder, type CategoryReading, type EntryVerdict } from './readiness.ts';
import { programmeAuthority } from './program.ts';
import type {
  Capability,
  ManufacturingProgram,
  ManufacturingRound,
} from '../../domain/types.ts';

export interface NextCategory {
  reading: CategoryReading;
  /** Categories already on the ladder that develop what it is missing. */
  bridges: { categoryId: string; name: string; supplies: string[] }[];
}

export interface ProgrammeView {
  program: ManufacturingProgram;
  /**
   * Whether a research grant currently covers this programme.
   *
   * Reported beside the state rather than instead of it: a paused programme
   * with a live grant and an archived one with none are different facts with
   * different remedies, and §35 records what collapsing two such readings into
   * one costs.
   */
  authorized: boolean;

  counts: {
    categories: number;
    retired: number;
    capabilities: number;
    capabilitiesHeld: number;
    openRounds: number;
    settledRounds: number;
  };

  /**
   * Every live category's reading, strongest verdict first.
   *
   * The brief's *"continuously calculate the strongest next expansion"* as a
   * derivation. Nothing about this order is stored, so an acquisition, a
   * breakthrough or one new piece of evidence moves it on the next read.
   */
  ladder: CategoryReading[];

  /** The categories that are enterable now, if any. Usually none, honestly. */
  enterable: CategoryReading[];

  /**
   * The nearest thing to enterable that is not, with what would close the gap.
   *
   * The brief's capability chain as an answer rather than a diagram. It names
   * categories rather than a sequence: a sequence would be the rigid roadmap,
   * and which bridge to take depends on their own readings, which are right
   * here beside it.
   */
  next: NextCategory[];

  /** What Brain would ask next, and what it considered and did not. */
  plan: {
    asks: { purpose: string; subject: string; why: string }[];
    declined: { subject: string; why: string }[];
  };

  /** What is running now. */
  open: ManufacturingRound[];

  /**
   * The capability ledger, held first.
   *
   * Held and unheld are kept plainly apart rather than counted together,
   * because the difference between them is the whole kernel and a single
   * "47 capabilities" would read as competence.
   */
  capabilities: CapabilityReading[];

  /**
   * Every round ever asked, newest first — including the barren ones.
   *
   * A round that found nothing is a reading of a market, and dropping it from
   * the history would make the map look like it had only ever been productive.
   * `found` is null while a round is OPEN rather than 0, because *not counted
   * yet* and *nothing found* are different facts (§33).
   */
  history: RoundReading[];

  /**
   * Declarations Brain could not file, from the passes that reported them.
   *
   * Read from the append-only event rather than recomputed, so what is shown is
   * what was actually refused at the time rather than what would be refused
   * now. Reported and never acted on.
   */
  refusals: { at: string; claimId: string; why: string }[];

  /**
   * The decisions genuinely waiting on a person, and nothing else.
   *
   * Narrow on purpose. A list that included everything Brain is merely *doing*
   * would be a list nobody finishes reading, and §29 records what a status
   * nobody reads costs. A decision qualifies only when research has done
   * everything it can and the remaining condition is one no amount of evidence
   * could close.
   */
  decisions: PersonDecision[];
}

/** One capability, and what holding it would unlock. */
export interface CapabilityReading {
  capability: Capability;
  /** Categories established to require it — what it unlocks if held. */
  requiredBy: { categoryId: string; name: string; path: string[] }[];
  /** Categories established to develop it — how it could be acquired. */
  taughtBy: { categoryId: string; name: string; path: string[] }[];
}

export interface RoundReading {
  id: string;
  purpose: string;
  state: string;
  round: number;
  /** Null for the opening question, which is about no one category. */
  subject: string | null;
  openedAt: string;
  harvestedAt: string | null;
  found: number | null;
  /** True for a settled round that established nothing. Not a failure. */
  barren: boolean;
}

export interface PersonDecision {
  kind: 'RESUME_PROGRAMME' | 'CAPABILITY_IS_THE_ONLY_GAP';
  /** What is being decided, in words the server composed. */
  what: string;
  /** Why it is a person's and not Brain's. */
  why: string;
  categoryId: string | null;
  /** The capabilities that would have to be held. Never auto-filled. */
  capabilities: { id: string; name: string; taughtBy: string[] }[];
}

/**
 * What a reader wants to see first.
 *
 * A `Record` over the whole union rather than an array, so a verdict added
 * later is a compile error until somebody says where it ranks. An array would
 * have let `indexOf` return `-1` and sort an unnamed verdict silently to the
 * top — §27 records what two collections that must be total between them cost,
 * and this is the same shape at a sort.
 *
 * It is presentation only. Nothing here decides anything: the verdict itself is
 * derived in `readiness.ts` from rows, and this says only which order to read
 * them in.
 */
export const VERDICT_ORDER: Readonly<Record<EntryVerdict, number>> = Object.freeze({
  ENTER: 0,
  // Directly under ENTER, because it is one question away from it and every
  // other verdict below is a capability, a route or a buyer away.
  COST_UNKNOWN: 1,
  BUILD_CAPABILITY_FIRST: 2,
  NO_ROUTE_FOUND: 3,
  INVESTIGATING: 4,
  UNEXAMINED: 5,
  NO_DEMAND_FOUND: 6,
  RETIRED: 7,
});

export async function programmeView(projectId: string): Promise<ProgrammeView | null> {
  const snapshot = await ladderSnapshot(projectId);
  if (!snapshot) return null;

  const readings = readLadder(snapshot);
  const ranked = [...readings].sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      a.missing.length - b.missing.length ||
      a.path.join(' → ').localeCompare(b.path.join(' → ')),
  );

  const plan = planFrom(snapshot);

  const next = ranked
    .filter((one) => one.verdict === 'BUILD_CAPABILITY_FIRST')
    .slice(0, 5)
    .map((reading) => ({
      reading,
      bridges: bridgesTo(reading, readings).map((one) => ({
        categoryId: one.category.id,
        name: one.category.name,
        supplies: one.supplies.map((capability) => capability.name),
      })),
    }));

  return {
    program: snapshot.program,
    authorized: (await programmeAuthority(projectId)) !== null,
    counts: {
      categories: snapshot.categories.filter((one) => one.retiredAt === null).length,
      retired: snapshot.categories.filter((one) => one.retiredAt !== null).length,
      capabilities: snapshot.capabilities.length,
      capabilitiesHeld: snapshot.capabilities.filter((one) => one.heldAt !== null).length,
      openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
      settledRounds: snapshot.rounds.filter((one) => one.state !== 'OPEN').length,
    },
    ladder: ranked,
    enterable: ranked.filter((one) => one.verdict === 'ENTER'),
    next,
    plan: {
      asks: plan.asks.map((one) => ({
        purpose: one.purpose,
        subject: one.subject,
        why: one.why,
      })),
      declined: plan.declined,
    },
    open: snapshot.rounds.filter((one) => one.state === 'OPEN'),
    capabilities: capabilityReadings(snapshot),
    history: historyOf(snapshot),
    refusals: await recentRefusals(projectId),
    decisions: decisionsFrom(snapshot, ranked),
  };
}

/**
 * Each capability, with what requires it and what develops it.
 *
 * *What does holding this unlock* is `requiredBy`, and it is derived from the
 * same edges the chain is — never stored, so it moves the moment a category
 * establishes that it needs something.
 */
function capabilityReadings(snapshot: LadderSnapshot): CapabilityReading[] {
  const byId = new Map(snapshot.categories.map((one) => [one.id, one]));
  const pathFor = (categoryId: string) => pathOf(categoryId, byId);

  const out = snapshot.capabilities.map((capability) => {
    const edges = snapshot.edges.filter((one) => one.capabilityId === capability.id);
    const sideOf = (relation: 'REQUIRES' | 'TEACHES') =>
      edges
        .filter((one) => one.relation === relation)
        .map((one) => byId.get(one.categoryId))
        .filter((one): one is NonNullable<typeof one> => one !== undefined)
        .filter((one) => one.retiredAt === null)
        .map((one) => ({ categoryId: one.id, name: one.name, path: pathFor(one.id) }));
    return {
      capability,
      requiredBy: sideOf('REQUIRES'),
      taughtBy: sideOf('TEACHES'),
    };
  });

  return out.sort(
    (a, b) =>
      Number(b.capability.heldAt !== null) - Number(a.capability.heldAt !== null) ||
      b.requiredBy.length - a.requiredBy.length ||
      a.capability.name.localeCompare(b.capability.name),
  );
}

function historyOf(snapshot: LadderSnapshot): RoundReading[] {
  const byId = new Map(snapshot.categories.map((one) => [one.id, one]));
  return [...snapshot.rounds]
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id))
    .map((one) => ({
      id: one.id,
      purpose: one.purpose,
      state: one.state,
      round: one.round,
      subject: one.categoryId ? pathOf(one.categoryId, byId).join(' → ') : null,
      openedAt: one.openedAt,
      harvestedAt: one.harvestedAt,
      found: one.found,
      // A settled round that established nothing. Shown rather than dropped: a
      // market Brain looked at and found nothing in is a reading of that market.
      barren: one.state !== 'OPEN' && one.found === 0,
    }));
}

/**
 * What the last few absorption passes could not file.
 *
 * From the append-only event, so this is what was refused at the time rather
 * than what would be refused now.
 */
async function recentRefusals(
  projectId: string,
): Promise<{ at: string; claimId: string; why: string }[]> {
  const rows = await listEvents(projectId, 200);
  const out: { at: string; claimId: string; why: string }[] = [];
  for (const event of rows) {
    if (event.eventType !== 'MANUFACTURING_FINDINGS_ABSORBED') continue;
    const refused = event.payload['refused'];
    if (!Array.isArray(refused)) continue;
    for (const one of refused) {
      const row = one as { claimId?: unknown; why?: unknown };
      if (typeof row.claimId !== 'string' || typeof row.why !== 'string') continue;
      out.push({ at: event.createdAt, claimId: row.claimId, why: row.why });
    }
  }
  return out.slice(0, 20);
}

/**
 * The decisions no amount of research could take.
 *
 * Two, and both are narrow. A paused programme, because resuming is a person's.
 * And a category where every condition research can answer is `MET` and the
 * only remaining one is whether this company holds what producing requires —
 * which is the one fact in this kernel no claim can establish.
 *
 * It offers the capabilities and never fills one in. §33 records what a form
 * that asks a person to attest to Brain's own work costs, and this is the
 * opposite case: work only a person can do, offered where they will see it.
 */
function decisionsFrom(
  snapshot: LadderSnapshot,
  readings: readonly CategoryReading[],
): PersonDecision[] {
  const out: PersonDecision[] = [];

  if (snapshot.program.state !== 'ACTIVE') {
    out.push({
      kind: 'RESUME_PROGRAMME',
      what: `This programme is ${snapshot.program.state.toLowerCase()}, so Brain is opening no new questions.`,
      why:
        snapshot.program.state === 'PAUSED'
          ? 'Everything already running still finishes and is filed. Resuming is yours.'
          : 'Archiving withdrew the research authority. Reactivating writes it again.',
      categoryId: null,
      capabilities: [],
    });
  }

  const byId = new Map(snapshot.categories.map((one) => [one.id, one]));
  for (const reading of readings) {
    if (reading.verdict !== 'BUILD_CAPABILITY_FIRST') continue;
    const answered = (condition: string) =>
      reading.conditions.find((one) => one.condition === condition)?.answer;
    // Everything research can settle is settled, and only holding is not.
    if (answered('DEMAND_ESTABLISHED') !== 'MET') continue;
    if (answered('ROUTE_TO_BUYER_ESTABLISHED') !== 'MET') continue;
    if (answered('REQUIREMENTS_KNOWN') !== 'MET') continue;
    if (reading.missing.length === 0) continue;

    out.push({
      kind: 'CAPABILITY_IS_THE_ONLY_GAP',
      what:
        `${reading.path.join(' → ')} has published buyers, a published route to them, and ` +
        `${reading.missing.length} established requirement` +
        (reading.missing.length === 1 ? '' : 's') +
        ' this company is not recorded as holding.',
      why:
        'What producing requires is research. Whether this company can do it is not — no ' +
        'claim can establish that, so it is recorded only when you say so.',
      categoryId: reading.categoryId,
      capabilities: reading.missing.map((gap) => ({
        id: gap.capability.id,
        name: gap.capability.name,
        taughtBy: gap.taughtBy
          .map((one) => byId.get(one.id)?.name)
          .filter((one): one is string => one !== undefined),
      })),
    });
  }
  return out;
}
