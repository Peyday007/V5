/**
 * The industry map as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Derived on the read path, like everything else about this kernel
 * ---------------------------------------------------------------------------
 *
 * The verdict, the coverage, the capital reading and what Brain would do next
 * are all computed here and stored nowhere. `tier.ts` and `placements` both
 * settled this and the argument does not change: a stored reading is stale the
 * moment the evidence it was waiting on arrives, and two readers deriving it
 * separately is how one screen comes to disagree with another.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to say
 * ---------------------------------------------------------------------------
 *
 * There is no score, no percentage and no confidence anywhere in this view. A
 * subject with two settled rounds and one opening is described by those three
 * numbers, not by a figure composed from them — because composing one needs
 * weights nobody set, and the result reads like a measurement. §29's rule
 * about progress arrives here as a rule about coverage.
 */
import { cashPosition } from '../cash/money.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { listCapitalForProject } from '../../repos/industry.ts';
import { graphSnapshot, type NodeCoverage } from './graph.ts';
import { planFrom } from './kernel.ts';
import { readCapital, executableNow, tierFor, type CapitalTierId } from './capital.ts';
import { readStanding, standingOf, type PathVerdict } from './verdict.ts';
import type { CapitalUnknownReason } from './capital.ts';
import type { CashOpportunity, IndustryNodeKind } from '../../domain/types.ts';

export interface SubjectView {
  id: string;
  parentId: string | null;
  kind: IndustryNodeKind;
  name: string;
  /** Root-first, because a leaf name on its own says nothing. */
  path: string[];
  depth: number;
  origin: string;
  description: string | null;
  verdict: PathVerdict;
  because: string;
  children: number;
  openings: number;
  constraints: number;
  /** Settled rounds, and whether a question about it is live right now. */
  mapRounds: number;
  scanRounds: number;
  live: boolean;
  /** Of the ten ways money is reachable, how many have been asked here. */
  bucketsAsked: number;
  bucketsTotal: number;
  lastAskedAt: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

export interface CapitalView {
  opportunityId: string;
  title: string;
  /** What the owner actually has to fund, or null with the reason. */
  minimumOwnerCents: number | null;
  unknown: CapitalUnknownReason | null;
  /** The band it falls in. Presentation — the decision is the comparison. */
  tier: CapitalTierId | null;
  /** Measured against the money that exists, never against a band. */
  executableNow: 'YES' | 'NO' | 'UNKNOWN';
  requirements: { requirement: string; grossCents: number | null; netCents: number | null }[];
  mechanisms: string[];
  removedCents: number | null;
  cashNow: { facts: string[]; unknown: string[] };
  positionLater: { facts: string[]; unknown: string[] };
  constraints: string[];
}

export interface IndustryView {
  projectId: string;
  /** Every live subject, root-first then by name, so the order is stable. */
  subjects: SubjectView[];
  /** Subjects a person retired, kept and shown rather than hidden. */
  retired: SubjectView[];
  /** Whether the map has been started at all, and how. */
  bootstrap: { asked: boolean; open: boolean; found: number | null };
  /** What Brain would ask next, and why. Reading this creates nothing. */
  next: { purpose: string; subject: string; why: string }[];
  /** Why something was considered and not asked. */
  declined: { subject: string; why: string }[];
  /** Openings whose capital has been taken apart. */
  capital: CapitalView[];
  /** The money the comparison above was made against, stated rather than implied. */
  deployableCents: number;
  /** How many kinds of subject the map currently holds, by kind. */
  byKind: Record<string, number>;
}

export async function industryView(projectId: string): Promise<IndustryView> {
  const snapshot = await graphSnapshot(projectId);
  const mode = await getCashMode(projectId);
  const [plan, entries, position] = await Promise.all([
    planFrom(snapshot),
    listCapitalForProject(projectId),
    /*
     * The money the executable-now comparison is made against.
     *
     * `deployableCents` and not available funds: §30's arithmetic — what has
     * already left the account is gone from the balance, and only what has not
     * left reduces what may be deployed. A comparison against the wrong one of
     * those would say a piece was reachable with money that is already spent.
     */
    cashPosition({ projectId, currency: mode?.currency }),
  ]);
  const deployable = position.deployableCents;

  const subjects = snapshot.coverage
    .map((coverage) => toSubject(coverage, snapshot.opportunities))
    .sort(compareSubjects);

  const retired = snapshot.nodes
    .filter((one) => one.retiredAt !== null)
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      kind: node.kind,
      name: node.name,
      path: [node.name],
      depth: 0,
      origin: node.origin,
      description: node.description,
      verdict: 'DEAD_END' as PathVerdict,
      because: node.retiredReason ?? 'A person retired this subject.',
      children: 0,
      openings: 0,
      constraints: 0,
      mapRounds: 0,
      scanRounds: 0,
      live: false,
      bucketsAsked: 0,
      bucketsTotal: BUCKET_TOTAL,
      lastAskedAt: null,
      retiredAt: node.retiredAt,
      retiredReason: node.retiredReason,
    }));

  const byOpportunity = new Map<string, typeof entries>();
  for (const entry of entries) {
    byOpportunity.set(entry.opportunityId, [...(byOpportunity.get(entry.opportunityId) ?? []), entry]);
  }

  const capital: CapitalView[] = [];
  for (const [opportunityId, rows] of byOpportunity) {
    const opportunity = snapshot.opportunities.find((one) => one.id === opportunityId);
    if (!opportunity) continue;
    const reading = readCapital(opportunityId, rows);
    const standing = readStanding(opportunity, reading, snapshot.constraints);
    capital.push({
      opportunityId,
      title: opportunity.title,
      minimumOwnerCents: reading.minimumOwnerCents,
      unknown: reading.unknown,
      tier: tierFor(reading.minimumOwnerCents),
      executableNow: executableNow(reading, deployable),
      requirements: reading.requirements.map((one) => ({
        requirement: one.requirement,
        grossCents: one.grossCents,
        netCents: one.netCents,
      })),
      mechanisms: reading.mechanisms,
      removedCents: reading.removedCents,
      cashNow: standing.cashNow,
      positionLater: standing.positionLater,
      constraints: standing.constraints,
    });
  }

  const byKind: Record<string, number> = {};
  for (const subject of subjects) {
    byKind[subject.kind] = (byKind[subject.kind] ?? 0) + 1;
  }

  return {
    projectId,
    subjects,
    retired,
    bootstrap: snapshot.bootstrap,
    // The ask names its own subject, so no reader has to resolve one and
    // none of them can resolve it differently.
    next: plan.asks.map((ask) => ({
      purpose: ask.purpose,
      subject: ask.subject,
      why: ask.why,
    })),
    declined: plan.declined,
    capital: capital.sort((a, b) => a.title.localeCompare(b.title)),
    deployableCents: deployable,
    byKind,
  };
}

const BUCKET_TOTAL = 10;

function toSubject(
  coverage: NodeCoverage,
  opportunities: readonly CashOpportunity[],
): SubjectView {
  const standing = standingOf(coverage, opportunities);
  return {
    id: coverage.node.id,
    parentId: coverage.node.parentId,
    kind: coverage.node.kind,
    name: coverage.node.name,
    path: coverage.path,
    depth: coverage.depth,
    origin: coverage.node.origin,
    description: coverage.node.description,
    verdict: standing.verdict,
    because: standing.because,
    children: coverage.children,
    openings: coverage.openings,
    constraints: coverage.constraints,
    mapRounds: coverage.mapRounds,
    scanRounds: coverage.scanRounds,
    live: coverage.mapOpen || coverage.scanOpen,
    bucketsAsked: coverage.bucketsAsked.size,
    bucketsTotal: BUCKET_TOTAL,
    lastAskedAt: coverage.lastAskedAt,
    retiredAt: null,
    retiredReason: null,
  };
}

/** Root-first then alphabetical, so the order is the same on both backends. */
function compareSubjects(a: SubjectView, b: SubjectView): number {
  return a.path.join(' → ').localeCompare(b.path.join(' → '));
}
