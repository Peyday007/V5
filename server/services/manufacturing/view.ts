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
import { ladderSnapshot } from './ladder.ts';
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
  capabilities: Capability[];
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
const VERDICT_ORDER: Readonly<Record<EntryVerdict, number>> = Object.freeze({
  ENTER: 0,
  BUILD_CAPABILITY_FIRST: 1,
  NO_ROUTE_FOUND: 2,
  INVESTIGATING: 3,
  UNEXAMINED: 4,
  NO_DEMAND_FOUND: 5,
  RETIRED: 6,
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
    capabilities: [...snapshot.capabilities].sort(
      (a, b) =>
        Number(b.heldAt !== null) - Number(a.heldAt !== null) || a.name.localeCompare(b.name),
    ),
  };
}
