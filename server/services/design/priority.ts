/**
 * What to work on, at three altitudes, with no invented score.
 *
 * ---------------------------------------------------------------------------
 * Why there is no weighted score anywhere in this file
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation is `0.4 * severity + 0.3 * frequency + 0.3 *
 * uncertainty`. It is refused for the reason §38 gives about the industry
 * allocator and §30 about the portfolio: **a score needs weights, weights are a
 * judgement nobody made, and the resulting number then reads like a
 * measurement.** Somebody looking at `0.72` cannot tell that it encodes three
 * coefficients that were typed once.
 *
 * So ordering is **lexicographic over observable facts**, in a stated sequence.
 * Every comparison is a fact somebody can disagree with individually, and the
 * order of the comparisons is the design decision — visible, arguable, and in
 * one place.
 *
 * ---------------------------------------------------------------------------
 * Three altitudes, because they answer different questions
 * ---------------------------------------------------------------------------
 *
 *   **Brain-wide** — does this surface serve something Brain is currently doing?
 *   A beautiful screen for a faculty nobody is using is polish. The signal is
 *   rows: live missions, open campaigns, outstanding decisions.
 *
 *   **Design-local** — which design problem most reduces the owner's repair
 *   time? Severity, whether a person has already complained about it, whether it
 *   keeps coming back, and whether it is the kind of defect that will recur on
 *   the next screen too.
 *
 *   **Runtime** — what can actually be worked on *now*? A judged review needs a
 *   healthy execution surface; a render needs a browser. A ranking that ignored
 *   what is available would put an unrunnable job at the top for ever.
 *
 * They are separate functions because they are separate questions, and the third
 * is a **filter** rather than a term in the first two: something that cannot run
 * now has not become less important.
 */
import { getDb } from '../../db/database.ts';
import type {
  DesignCapability,
  DesignFinding,
  DesignSeverity,
  DesignSurface,
} from '../../domain/design.ts';
import { ABILITY_RANK, EVIDENCE_RANK, SEVERITY_RANK } from '../../domain/design.ts';
import {
  findingCountsByPrimitive,
  listCaptures,
  listCorrections,
  listFindings,
} from '../../repos/design.ts';
import { probeRenderRuntime } from './renderRuntime.ts';

/* =========================================================================
 * Brain-wide: is this part of Brain being used right now
 * ====================================================================== */

export interface FacultyActivity {
  faculty: string;
  /** Live rows in whatever this faculty's work actually is. */
  active: number;
  because: string;
}

/**
 * How busy each faculty is, from its own rows.
 *
 * A declared query per faculty rather than a generic one, because "how much is
 * happening in RESEARCH" has no generic answer — it is live packets, and for
 * FACTORY it is open campaigns, and for RUSSELL it is running missions. A
 * faculty with no query answers zero **and says so**, so a surface belonging to
 * one is not quietly demoted for want of a reading.
 */
export async function facultyActivity(): Promise<FacultyActivity[]> {
  const queries: { faculty: string; sql: string; what: string }[] = [
    {
      faculty: 'RUSSELL',
      sql: `SELECT COUNT(*) AS count FROM russell_missions WHERE state IN ('RUNNING', 'NEEDS_HUMAN')`,
      what: 'missions running or waiting on somebody',
    },
    {
      faculty: 'RESEARCH',
      sql: `SELECT COUNT(*) AS count FROM research_orchestrations
              WHERE status NOT IN ('COMPLETE', 'FAILED', 'CANCELLED')`,
      what: 'research packets still live',
    },
    {
      faculty: 'FACTORY',
      sql: `SELECT COUNT(*) AS count FROM factory_campaigns
              WHERE state NOT IN ('COMPLETE', 'FAILED', 'CANCELLED', 'RELEASED')`,
      what: 'campaigns still live',
    },
    {
      faculty: 'FLEET',
      sql: `SELECT COUNT(*) AS count FROM bins WHERE state IN ('READY', 'LEASED')`,
      what: 'bins ready or leased',
    },
  ];

  const out: FacultyActivity[] = [];
  for (const query of queries) {
    try {
      const row = await getDb().get<{ count: number }>(query.sql);
      const active = Number(row?.count ?? 0);
      out.push({
        faculty: query.faculty,
        active,
        because: `${active} ${query.what}.`,
      });
    } catch {
      out.push({
        faculty: query.faculty,
        active: 0,
        /*
         * A table this Brain does not have is an honest zero with the reason
         * beside it, never an omission: a faculty missing from this list would
         * sort last for a reason nobody could see.
         */
        because: `the rows behind ${query.what} could not be read on this Brain.`,
      });
    }
  }
  return out;
}

/* =========================================================================
 * Design-local: which problem costs the owner most
 * ====================================================================== */

export interface SurfaceRanking {
  surface: DesignSurface;
  rank: number;
  /** Every input the order was decided from, recorded rather than recomputed. */
  inputs: {
    worstSeverity: DesignSeverity | null;
    openFindings: number;
    ownerCorrections: number;
    recurringKinds: number;
    facultyActivity: number;
    neverCaptured: boolean;
  };
  because: string;
}

/**
 * Order the surfaces by how much working on them would actually save.
 *
 * The sequence, and why it is in this order:
 *
 *  1. **A surface nobody has ever rendered comes first.** Not because it is
 *     likely to be broken but because it is the only one about which *nothing*
 *     is known, and the cheapest thing a kernel can do is turn an unknown into a
 *     reading. §39's rule that an unknown is a task rather than a favourable
 *     assumption, applied to attention.
 *  2. **A blocker beats everything else.** A control nobody can press is a
 *     feature that is gone.
 *  3. **The owner having already said something about it.** The single best
 *     predictor that this screen costs them time, and the whole point of the
 *     kernel is to reduce that.
 *  4. **A defect kind that keeps recurring here.** A repeated kind is a rule
 *     that has not been learned, and learning it is worth more than fixing the
 *     instance.
 *  5. **How busy the faculty is**, so effort follows what Brain is doing.
 *  6. **How many findings are open**, as the tiebreak rather than the headline:
 *     ten nits are not worse than one blocker, and a count-led order would say
 *     they were.
 */
export async function rankSurfaces(
  surfaces: readonly DesignSurface[],
): Promise<SurfaceRanking[]> {
  const activity = new Map((await facultyActivity()).map((one) => [one.faculty, one.active]));
  const rankings: Omit<SurfaceRanking, 'rank'>[] = [];

  for (const surface of surfaces) {
    const open = await listFindings({ surfaceKey: surface.surfaceKey, state: 'OPEN', limit: 200 });
    const everything = await listFindings({ surfaceKey: surface.surfaceKey, limit: 400 });
    const corrections = await listCorrections({ surfaceKey: surface.surfaceKey, limit: 100 });

    const byKind = new Map<string, number>();
    for (const finding of everything) byKind.set(finding.kind, (byKind.get(finding.kind) ?? 0) + 1);
    const recurringKinds = [...byKind.values()].filter((count) => count >= 2).length;

    const worstSeverity = worstOf(open);
    const captured = await listCaptures({ surfaceKey: surface.surfaceKey, limit: 1 });

    rankings.push({
      surface,
      inputs: {
        worstSeverity,
        openFindings: open.length,
        ownerCorrections: corrections.length,
        recurringKinds,
        facultyActivity: surface.faculty ? (activity.get(surface.faculty) ?? 0) : 0,
        neverCaptured: captured.length === 0,
      },
      because: '',
    });
  }

  const ordered = rankings.sort((a, b) => {
    if (a.inputs.neverCaptured !== b.inputs.neverCaptured) return a.inputs.neverCaptured ? -1 : 1;

    const severity = (value: DesignSeverity | null) => (value === null ? 99 : SEVERITY_RANK[value]);
    const bySeverity = severity(a.inputs.worstSeverity) - severity(b.inputs.worstSeverity);
    if (bySeverity !== 0) return bySeverity;

    if (a.inputs.ownerCorrections !== b.inputs.ownerCorrections) {
      return b.inputs.ownerCorrections - a.inputs.ownerCorrections;
    }
    if (a.inputs.recurringKinds !== b.inputs.recurringKinds) {
      return b.inputs.recurringKinds - a.inputs.recurringKinds;
    }
    if (a.inputs.facultyActivity !== b.inputs.facultyActivity) {
      return b.inputs.facultyActivity - a.inputs.facultyActivity;
    }
    if (a.inputs.openFindings !== b.inputs.openFindings) {
      return b.inputs.openFindings - a.inputs.openFindings;
    }
    return a.surface.surfaceKey.localeCompare(b.surface.surfaceKey);
  });

  return ordered.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    because: explainSurface(entry.inputs),
  }));
}

function worstOf(findings: readonly DesignFinding[]): DesignSeverity | null {
  if (findings.length === 0) return null;
  return findings.reduce<DesignSeverity>(
    (best, one) => (SEVERITY_RANK[one.severity] < SEVERITY_RANK[best] ? one.severity : best),
    'NIT',
  );
}

function explainSurface(inputs: SurfaceRanking['inputs']): string {
  const parts: string[] = [];
  if (inputs.neverCaptured) parts.push('it has never been rendered, so nothing is known about it');
  if (inputs.worstSeverity) parts.push(`its worst open finding is a ${inputs.worstSeverity}`);
  if (inputs.ownerCorrections > 0) {
    parts.push(`the owner has corrected it ${inputs.ownerCorrections} time(s)`);
  }
  if (inputs.recurringKinds > 0) {
    parts.push(`${inputs.recurringKinds} kind(s) of defect have recurred here`);
  }
  if (inputs.facultyActivity > 0) parts.push(`its faculty has ${inputs.facultyActivity} live item(s)`);
  if (parts.length === 0) return 'nothing is outstanding on it.';
  return `${parts.join('; ')}.`;
}

/* =========================================================================
 * Runtime: what can actually be worked on now
 * ====================================================================== */

export interface RuntimeAvailability {
  canRender: boolean;
  canJudge: boolean;
  /** Why not, per lane, so a skipped lane is never silent. */
  reasons: { lane: 'RENDER' | 'JUDGE'; reason: string }[];
}

/**
 * What the machine and the fleet can do at this moment.
 *
 * A filter and never a term in the ranking above: a surface that cannot be
 * rendered right now has not become less important, and folding availability
 * into importance is how a permanently unavailable thing quietly stops being
 * anybody's problem.
 */
export async function runtimeAvailability(): Promise<RuntimeAvailability> {
  const reasons: RuntimeAvailability['reasons'] = [];

  const runtime = probeRenderRuntime();
  if (!runtime.available) reasons.push({ lane: 'RENDER', reason: runtime.reason });

  let canJudge = false;
  try {
    const row = await getDb().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM fleet_routines WHERE state = 'ENABLED'`,
    );
    canJudge = Number(row?.count ?? 0) > 0;
    if (!canJudge) {
      reasons.push({
        lane: 'JUDGE',
        reason:
          'No execution surface is enabled, so there is nowhere to send a review. The blocker is ' +
          'NO_HEALTHY_EXECUTION_SURFACE — an operational fact with an operational remedy.',
      });
    }
  } catch {
    reasons.push({
      lane: 'JUDGE',
      reason: 'The fleet could not be read on this Brain, so whether a review can run is unknown.',
    });
  }

  return { canRender: runtime.available, canJudge, reasons };
}

/* =========================================================================
 * Expansion: which gap in itself is worth closing
 * ====================================================================== */

export interface CapabilityRanking {
  capability: DesignCapability;
  rank: number;
  inputs: {
    ability: number;
    evidence: number;
    /**
     * How often work has actually wanted this, from findings on its primitive.
     *
     * **Zero means two different things and only one of them is "nobody needs
     * it".** A capability nothing implements cannot have produced a finding, so
     * an empty count there is the absence of a *reading* rather than a reading
     * of absence — §30's rule that an unknown is never a favourable assumption,
     * and it fails in the direction that matters most here: it would make the
     * abilities the kernel most obviously lacks permanently invisible to the
     * loop that exists to find them. `demandKnown` is which it is.
     */
    demand: number;
    demandKnown: boolean;
    /** How often using it has gone wrong. */
    failures: number;
    /** Whether anything at all implements it. */
    unimplemented: boolean;
  };
  because: string;
}

/**
 * Order the kernel's own weaknesses by how much closing one would be worth.
 *
 * **Demand is the load-bearing term, and it is measured rather than assumed.**
 * A capability's demand is how many findings have landed on its primitive — so
 * *mobile interaction* rises because work keeps producing findings about
 * interaction at phone width, not because somebody thought mobile was important.
 * That is what makes this loop able to originate work with nothing having
 * failed: a capability can be weak, in demand, and never have thrown an error.
 *
 * The sequence:
 *
 *  1. **Demand first.** A perfect capability nobody needs is worth nothing, and
 *     the weakest capability in the registry is often one of those.
 *  2. **Then how weak it is**, ability before evidence — something that does not
 *     exist beats something that exists and is unchecked.
 *  3. **Then how often it has gone wrong**, which is the reactive signal and is
 *     deliberately third: making it first is how a kernel only ever improves in
 *     response to failure, which is the thing this loop exists not to be.
 */
export async function rankCapabilities(
  capabilities: readonly DesignCapability[],
): Promise<CapabilityRanking[]> {
  const counts = await findingCountsByPrimitive();
  const demandByPrimitive = new Map<string, number>();
  for (const row of counts) {
    demandByPrimitive.set(row.primitive, (demandByPrimitive.get(row.primitive) ?? 0) + Number(row.count));
  }

  const entries = capabilities.map((capability) => ({
    capability,
    inputs: {
      ability: ABILITY_RANK[capability.abilityState],
      evidence: EVIDENCE_RANK[capability.evidenceState],
      demand: demandByPrimitive.get(capability.primitive) ?? 0,
      demandKnown: capability.route !== null,
      failures: capability.failures,
      unimplemented: capability.route === null,
    },
  }));

  const ordered = entries.sort((a, b) => {
    /*
     * Measured demand first, and only where it was measurable. A capability with
     * an unknown demand sorts between "wanted" and "measured and not wanted",
     * because it is neither — and putting it last would be reading the unknown
     * as a zero, which is the thing `demandKnown` exists to prevent.
     */
    const weight = (input: { demand: number; demandKnown: boolean }) =>
      input.demandKnown ? input.demand : -0.5;
    if (weight(a.inputs) !== weight(b.inputs)) return weight(b.inputs) - weight(a.inputs);
    if (a.inputs.ability !== b.inputs.ability) return a.inputs.ability - b.inputs.ability;
    if (a.inputs.evidence !== b.inputs.evidence) return a.inputs.evidence - b.inputs.evidence;
    if (a.inputs.failures !== b.inputs.failures) return b.inputs.failures - a.inputs.failures;
    // Deterministic rather than meaningful, and deliberately so: with every
    // measurable input equal there is nothing left to prefer, and a random or
    // insertion-ordered tiebreak would make "why that one" unanswerable.
    return a.capability.capabilityKey.localeCompare(b.capability.capabilityKey);
  });

  return ordered.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    because: explainCapability(entry.capability, entry.inputs),
  }));
}

function explainCapability(
  capability: DesignCapability,
  inputs: CapabilityRanking['inputs'],
): string {
  const parts: string[] = [];
  parts.push(
    !inputs.demandKnown
      ? `nothing can look for ${capability.primitive} problems of this kind, so the absence of ` +
        'findings is not evidence that nobody needs it'
      : inputs.demand === 0
        ? `no finding has landed on ${capability.primitive}, so nothing has wanted this yet`
        : `${inputs.demand} finding(s) have landed on ${capability.primitive}, so work keeps needing it`,
  );
  parts.push(
    inputs.unimplemented
      ? 'nothing implements it at all'
      : `it is ${capability.abilityState.toLowerCase()} and ${capability.evidenceState.toLowerCase()}`,
  );
  if (inputs.failures > 0) parts.push(`it has gone wrong ${inputs.failures} time(s)`);
  return `${parts.join('; ')}.`;
}
