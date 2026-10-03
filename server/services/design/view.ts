/**
 * The design kernel's whole current state, composed and derived nowhere here.
 *
 * §42's kernel already has a priority module, a repository and a capabilities
 * module that do every reading and every ranking this state needs — this file
 * adds none of its own. It exists only because none of those was ever handed
 * to an HTTP route or a terminal report, so what the kernel derives on every
 * tick (which screens it would look at first and why, how weak each of its
 * own abilities is, what it found, what the owner told it, what it learned and
 * what it is trying to become able to do) was readable only by reading the
 * database directly. `services/labor/view.ts` is the sibling this follows: a
 * view module with no principal, callable from a route and from a terminal
 * report alike.
 *
 * Every field on every list element is the raw domain field the objective
 * names — `because`, `abilityState`, `evidenceState`, `stopReason`,
 * `origin`/`scope`/`scopeRef`/`confidence`, `correction`/`lesson`,
 * `demandKnown` — never a paraphrase, a score or an aggregate computed here.
 *
 * This module performs no write and calls no function that writes to a
 * `design_*` table.
 */
import { liveSurfaces } from './surfaces.ts';
import {
  rankSurfaces,
  runtimeAvailability,
  rankCapabilities,
  type SurfaceRanking,
  type RuntimeAvailability,
} from './priority.ts';
import { describeCapability, weakestFirst } from './capabilities.ts';
import {
  listCapabilities,
  listFindings,
  listCycles,
  listPatterns,
  listCorrections,
  listExpansions,
} from '../../repos/design.ts';
import type {
  DesignCapability,
  DesignCorrection,
  DesignCycle,
  DesignExpansion,
  DesignFinding,
  DesignPattern,
} from '../../domain/design.ts';

/**
 * One capability, ordered weakest-first, with its own maturity sentence and
 * the demand reading `rankCapabilities` derives — the two never disagree
 * about which capability this is, only about which order matters for which
 * question.
 */
export interface CapabilityView {
  capability: DesignCapability;
  /** `describeCapability(capability)` — the maturity sentence, composed and stored nowhere. */
  description: string;
  /** From `rankCapabilities`: how many findings have landed on this capability's primitive. */
  demand: number;
  /** False means the demand count is an absent reading rather than a reading of absence. */
  demandKnown: boolean;
  /** `rankCapabilities`' own sentence for why this capability ranks where it does by demand. */
  because: string;
}

/**
 * One expansion, with its liveness decided the same way
 * `repos/design.ts`'s `liveExpansionFor` decides it — `IDENTIFIED` or
 * `ROUTED` is live, everything else carries its own state and is reported as
 * settled rather than dropped.
 */
export interface ExpansionView extends DesignExpansion {
  live: boolean;
}

export interface DesignKernelView {
  /** Which screens the kernel would look at first, and why — `rankSurfaces`' own order and sentences. */
  surfaces: SurfaceRanking[];
  /** What can actually be worked on now: a browser to render with, a fleet to judge with. */
  runtime: RuntimeAvailability;
  /** Every capability, weakest ability first, each with its own maturity sentence and demand reading. */
  capabilities: CapabilityView[];
  /** Every open finding, across every surface. */
  openFindings: DesignFinding[];
  /** Every cycle, open and closed, carrying its own state and stop reason. */
  cycles: DesignCycle[];
  /** Every pattern, carrying its origin, scope and confidence. */
  patterns: DesignPattern[];
  /** Every owner correction, the stored words verbatim, the lesson kept separate. */
  corrections: DesignCorrection[];
  /** Every expansion the kernel has proposed for itself, with liveness decided per row. */
  expansions: ExpansionView[];
}

const LIVE_EXPANSION_STATES = new Set<DesignExpansion['state']>(['IDENTIFIED', 'ROUTED']);

/**
 * The kernel's whole current state, read from existing rows and existing
 * rankings. Composition only: nothing here re-ranks, re-derives or
 * re-orders anything a called function already decided.
 */
export async function designKernelView(): Promise<DesignKernelView> {
  const surfaces = await liveSurfaces();

  const [
    rankedSurfaces,
    runtime,
    rawCapabilities,
    openFindings,
    cycles,
    patterns,
    corrections,
    rawExpansions,
  ] = await Promise.all([
    rankSurfaces(surfaces),
    runtimeAvailability(),
    listCapabilities(),
    listFindings({ state: 'OPEN' }),
    listCycles(),
    listPatterns(),
    listCorrections({}),
    listExpansions(),
  ]);

  const capabilityRankings = await rankCapabilities(rawCapabilities);
  const demandByKey = new Map(capabilityRankings.map((entry) => [entry.capability.capabilityKey, entry]));

  const capabilities: CapabilityView[] = weakestFirst(rawCapabilities).map((capability) => {
    const ranking = demandByKey.get(capability.capabilityKey);
    return {
      capability,
      description: describeCapability(capability),
      demand: ranking?.inputs.demand ?? 0,
      demandKnown: ranking?.inputs.demandKnown ?? false,
      because: ranking?.because ?? '',
    };
  });

  const expansions: ExpansionView[] = rawExpansions.map((expansion) => ({
    ...expansion,
    live: LIVE_EXPANSION_STATES.has(expansion.state),
  }));

  return {
    surfaces: rankedSurfaces,
    runtime,
    capabilities,
    openFindings,
    cycles,
    patterns,
    corrections,
    expansions,
  };
}
