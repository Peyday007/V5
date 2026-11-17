/**
 * One project's manufacturing kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * programme started before a rule existed gets the rule on the next tick with
 * nobody pressing anything; a tick that dies halfway leaves rows the next one
 * reads correctly; and two instances running it produce one round, because the
 * arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * Absorb first, deliberately
 * ---------------------------------------------------------------------------
 *
 * A round that settled on the previous pass has categories, capabilities or
 * evidence to file, and filing them changes what the allocator sees: a category
 * that has just gained its first demand signal should be having its capability
 * question asked on *this* pass rather than the next one. Allocating first
 * would make every decision a tick late, for ever.
 *
 * ---------------------------------------------------------------------------
 * It refuses to ask where asking is refused
 * ---------------------------------------------------------------------------
 *
 * Opening a round is new research, so it is behind `programmeMayAsk`. Absorbing
 * is not: filing what research already found is not new discovery, the spending
 * happened when it ran, and dropping results because somebody paused the
 * programme would throw away work already paid for. §30's rule that winding a
 * section down ends new discovery and never an obligation already incurred,
 * applied one table along.
 */
import { getProgram } from '../../repos/manufacturing.ts';
import { allocate, MAX_OPEN_PROGRAMME_ROUNDS, type Ask } from './allocate.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { ladderSnapshot, type LadderSnapshot } from './ladder.ts';
import { ensureProgrammeAuthority, programmeMayAsk } from './program.ts';
import { readDirective, type Directive } from './directive.ts';
import { readLadder, type CategoryReading } from './readiness.ts';
import {
  alternativesFor,
  assessResources,
  buildVenturePath,
  challengeVenture,
  economicsFromReading,
  stagesFromReading,
  type Challenge,
  type Feasibility,
  type Money,
  type VenturePath,
  type VentureVerdict,
} from './venturePath.ts';
import type { AcquisitionCandidate } from '../../domain/types.ts';
import { competitiveSystemsFor, type CompetitiveSystem } from './competitiveSystem.ts';
import { institutionsForLadder, type CategoryInstitutions } from './institutionReading.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  /**
   * Every live category's competitive system, reconstructed from the category
   * evidence research has filed (VENT-24-1): mechanisms named by sourced claims,
   * open questions for the rest, and the product / selling-company / durable-
   * position readings. A read, derived every pass; never new research.
   */
  competitive: CompetitiveSystem[];
  /**
   * Every live category's institutional machinery (INST-30), derived from the
   * ladder's rows: the elements those rows trigger, each costed or withheld,
   * the structures they admit with four separate readings, and what needs a
   * person's approval. A read, derived every pass; nothing is formed or signed.
   */
  institutions: CategoryInstitutions[];
  /**
   * Whether the programme's directive actually reached the questions, and why
   * not when it did not.
   *
   * Reported rather than assumed, because *hashed* and *operative* are two
   * facts and the whole point of `directive.ts` is that recording the first
   * proves nothing about the second. A pass that opened work without it is
   * visible here and on the surface, instead of producing assignments that
   * read almost right.
   */
  directive: { reaching: boolean; path: string | null; why: string | null };
  /**
   * Every category on the ladder re-read as a venture against the capital and
   * capabilities recorded now (VENT-24-2). Derived on every pass from rows, so a
   * category that was out of reach becomes reachable on the first tick after
   * deployable capital or a held capability changes, with nobody restating it.
   * Read before the gate: reading what is now possible is not new research.
   */
  ventures: VentureReconsideration[];
  /** The ladder as it stood when the decision was made. */
  categories: number;
  capabilitiesHeld: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: {
    categories: [],
    capabilities: [],
    edges: [],
    evidence: [],
    capital: [],
    candidates: [],
    settled: [],
    refused: [],
  },
  declined: [],
  competitive: [],
  institutions: [],
  directive: { reaching: false, path: null, why: null },
  ventures: [],
  categories: 0,
  capabilitiesHeld: 0,
  openRounds: 0,
};

export async function runManufacturingKernel(projectId: string): Promise<KernelPass> {
  // One read answers it for the many projects that hold no programme at all,
  // which is what makes this cheap enough to run for every project every tick.
  if (!(await getProgram(projectId))) return EMPTY;

  /*
   * The grant, reconciled from rows.
   *
   * Idempotent by its index, and here rather than only at activation for the
   * reason `ensureDiscoveryAuthority` is called from the tick: a programme
   * started before this existed, or one whose grant was revoked and whose
   * programme was then resumed, has nothing to run under and no hook would
   * reach it.
   */
  await ensureProgrammeAuthority(projectId);

  const absorbed = await absorb({ projectId });

  const snapshot = await ladderSnapshot(projectId);
  if (!snapshot) return { ...EMPTY, absorbed };

  const counts = {
    categories: snapshot.categories.filter((one) => one.retiredAt === null).length,
    capabilitiesHeld: snapshot.capabilities.filter((one) => one.heldAt !== null).length,
    openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
  };

  /*
   * The directive, read once for the whole pass.
   *
   * Read *before* the gate so that a paused programme still reports whether
   * its directive is readable — that is a setup fact somebody may need to fix,
   * and hiding it behind the gate would mean the one state where nothing else
   * is happening is also the one where nobody can see it.
   */
  const directive = await directiveFor(snapshot.program.blueprintPath);

  const readings = readLadder(snapshot);
  const ventures = await reconsiderVentures(projectId, readings, snapshot.capabilities, snapshot.candidates);

  const competitive = await competitiveSystemsFor(snapshot);
  // The same readings the venture path is costed from, so both read one scenario and one set of figures.
  const institutions = institutionsForLadder(snapshot, readings);

  const gate = await programmeMayAsk(projectId);
  if (!gate.allowed) {
    return {
      opened: [],
      absorbed,
      declined: [{ subject: 'every category on the ladder', why: gate.reason }],
      competitive,
      institutions,
      directive: directive.report,
      ventures,
      ...counts,
    };
  }

  const plan = planFrom(snapshot);
  const opened = await openAsks({
    projectId,
    asks: plan.asks,
    snapshot,
    directive: directive.parsed,
  });

  return {
    opened,
    absorbed,
    declined: plan.declined,
    competitive,
    institutions,
    directive: directive.report,
    ventures,
    ...counts,
  };
}

/* ------------------------------------------------------------------------- */
/* Revisiting earlier ventures as capital and capabilities change             */
/* ------------------------------------------------------------------------- */

export interface VentureReconsideration {
  categoryId: string;
  path: string[];
  feasibility: Feasibility;
  challenges: Challenge[];
  /** The cheapest fully priced entry, high end, in its currency; null when not fully priced. */
  cost: Money | null;
  /** Deployable capital it was read against, from the money ledger; null when unreadable. */
  available: Money | null;
  /**
   * The newest recorded input the reading rests on — the latest capability
   * held that it requires — so a reading that just turned FEASIBLE says what
   * turned it. Null when it rests on no held capability.
   */
  newestInput: { kind: 'CAPABILITY_HELD'; capabilityId: string; at: string } | null;
  /**
   * The venture as a dependency-ordered path of stages, built from the
   * category's own rows (`stagesFromReading`), challenged against the same
   * capital and capabilities, with the materially different feasible
   * alternatives the rows admit. Re-derived every tick, like the rest.
   */
  venture: {
    path: VenturePath;
    /** Null when the path was refused (a cycle, an unknown or duplicate stage). */
    verdict: VentureVerdict | null;
    /** Each with its own stage graph and verdict, so what it would take is recorded, not only that it exists. */
    alternatives: {
      kind: 'SUBSTITUTED' | 'VALIDATE_FIRST';
      differs: string[];
      total: Money | null;
      path: Extract<VenturePath, { ok: true }>;
      verdict: VentureVerdict;
    }[];
  };
}

/**
 * The per-category venture reading for given resources. Pure, so a test — or a
 * person — can ask what is reachable at a stated capital without any row.
 *
 * Nothing is stored: the reading is re-derived on every tick from the ladder
 * (the existing possibility store) and the money ledger, so the transition from
 * INFEASIBLE to FEASIBLE is observed by the next pass rather than remembered.
 */
export function reconsiderFrom(
  readings: readonly CategoryReading[],
  availableByCurrency: ReadonlyMap<string, Money | null>,
  capabilities: readonly { id: string; heldAt: string | null }[],
  candidates: readonly AcquisitionCandidate[] = [],
): VentureReconsideration[] {
  const heldIds = new Set(capabilities.filter((c) => c.heldAt !== null).map((c) => c.id));
  const heldAt = new Map(capabilities.filter((c) => c.heldAt !== null).map((c) => [c.id, c.heldAt as string]));
  return readings.map((reading) => {
    const total = reading.capital.cheapestFullyPriced?.totals[0] ?? null;
    const cost: Money | null = total ? { currency: total.currency, amountMinor: total.highMinor } : null;
    const available = cost ? (availableByCurrency.get(cost.currency) ?? null) : null;
    const { feasibility, challenges } = assessResources({
      budget: cost,
      missingCapabilities: reading.missing.map((gap) => ({ id: gap.capability.id, stage: reading.path.join(' → ') })),
      situation: { available, heldCapabilityIds: heldIds },
    });
    const newest = reading.held
      .map((c) => ({ id: c.id, at: heldAt.get(c.id) }))
      .filter((c): c is { id: string; at: string } => typeof c.at === 'string')
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
    const stages = stagesFromReading(reading, candidates.filter((one) => one.categoryId === reading.categoryId || one.categoryId === null));
    const path = buildVenturePath(stages);
    const pathCurrency = path.ok ? (path.total?.currency ?? stages.find((one) => one.budget)?.budget?.currency ?? null) : null;
    const situation = {
      available: pathCurrency ? (availableByCurrency.get(pathCurrency) ?? null) : available,
      heldCapabilityIds: heldIds,
    };
    // The economics from the same rows: what buyers are stated to spend bounds any return, so a weak strategy is named.
    const economics = economicsFromReading(reading.evidence, pathCurrency);
    const verdict = path.ok ? challengeVenture(path, situation, economics) : null;
    const alternatives =
      path.ok && verdict && verdict.feasibility !== 'FEASIBLE'
        ? alternativesFor(stages, situation, economics).map((one) => ({ kind: one.kind, differs: one.differs, total: one.path.total, path: one.path, verdict: one.verdict }))
        : [];
    return {
      categoryId: reading.categoryId,
      path: reading.path,
      feasibility,
      challenges,
      cost,
      available,
      newestInput: newest ? { kind: 'CAPABILITY_HELD', capabilityId: newest.id, at: newest.at } : null,
      venture: { path, verdict, alternatives },
    };
  });
}

async function reconsiderVentures(
  projectId: string,
  readings: readonly CategoryReading[],
  capabilities: readonly { id: string; heldAt: string | null }[],
  candidates: readonly AcquisitionCandidate[],
): Promise<VentureReconsideration[]> {
  // Every currency a reading or a stage is priced in, so the stage graph is read against the same ledger.
  const currencies = new Set(
    readings.flatMap((r) => [
      ...(r.capital.cheapestFullyPriced?.totals[0] ? [r.capital.cheapestFullyPriced.totals[0].currency] : []),
      ...(r.capital.scenarios[0]?.priced ?? []).flatMap((e) => (e.currency ? [e.currency] : [])),
    ]),
  );
  const available = new Map<string, Money | null>();
  for (const currency of currencies) {
    try {
      // The one deployable figure, from append-only entries (invariant 37); never a second calculation.
      const { cashPosition } = await import('../cash/money.ts');
      const position = await cashPosition({ projectId, currency });
      available.set(currency, { currency, amountMinor: position.deployableCents });
    } catch (error) {
      // An unreadable ledger is an unknown, and an unknown never makes a venture feasible.
      console.warn(`[manufacturing] deployable ${currency} unreadable for ${projectId}: ${String((error as Error)?.message ?? error)}`);
      available.set(currency, null);
    }
  }
  return reconsiderFrom(readings, available, capabilities, candidates);
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so that a person — or a
 * test — can ask *what would Brain do next* without anything being created.
 * `services/realize/prove.ts` splits reading from applying for the same reason:
 * somebody should be able to look before anything moves.
 */
export function planFrom(snapshot: LadderSnapshot): { asks: Ask[]; declined: { subject: string; why: string }[] } {
  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;
  return allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_PROGRAMME_ROUNDS - openRounds),
  });
}

/**
 * The directive behind one programme, and an honest report of whether it
 * arrived.
 *
 * Three answers and not two. A programme that names no directive is a
 * different fact from one that names a file nobody can open, and both are
 * different from one whose file parsed — §30's and §37's rule that *we could
 * not tell* must never read the same as *we checked*, arriving at a setup
 * step. Nothing here is fatal: a programme with an unreadable directive still
 * researches, and the assignment says out loud that it went out without one.
 */
async function directiveFor(
  blueprintPath: string | null,
): Promise<{ parsed: Directive | null; report: KernelPass['directive'] }> {
  if (!blueprintPath) {
    return {
      parsed: null,
      report: {
        reaching: false,
        path: null,
        why:
          'This programme names no directive, so its questions carry the objective alone. A ' +
          'programme started today names one and refuses to start without it.',
      },
    };
  }
  const read = await readDirective(blueprintPath);
  if (!read.ok) {
    return {
      parsed: null,
      report: { reaching: false, path: blueprintPath, why: read.reason },
    };
  }
  return {
    parsed: read.directive,
    report: { reaching: true, path: read.directive.path, why: null },
  };
}
