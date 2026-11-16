/**
 * The fallback plan of a project's real acquisition dependency, built and
 * recorded on every cash-knowledge refresh (FALL-37-1, FALL-37-2).
 *
 * `fallbacks.ts` owns the structure — failure modes, substitutes, the
 * alternatives judgment, the machine-readable chain and the re-derived
 * economics of a switch — and until now nothing in production ever built one.
 * This builds it from what Brain's rows state about the one dependency every
 * revenue pathway of a cash project rests on: reaching buyers.
 *
 *  - The dependency and its substitutes are `fallbackIndependence.ts`
 *    `acquisitionDependency`, from the `cash_outcomes` CONTACT_RESULT rows the
 *    outreach funnel reads. Nothing here builds a second one.
 *  - Its failure modes are the two ways an outreach path fails that its own
 *    rows can show: the channel stops delivering (CONTACT_UNDELIVERABLE rows)
 *    and the prospects it reaches stop answering (BUYER_SILENT rows). Each
 *    names the signals that detect it and the rows that would show it
 *    happened. Its recovery window is what is left of the cash sprint a person
 *    set (`cash_modes.horizon_days` from `activated_at`): a recovery after
 *    that is no recovery for this operation. How likely each mode is, and how
 *    soon harm lands, no row states, so they stay unknown.
 *  - The economics are each path's own measured funnel: prospects reached,
 *    the share delivered, the share answering. A switch re-derives delivered
 *    prospects and responders from the substitute's own measured figures
 *    (`switchTo`), so the chain states what changing paths would actually do
 *    to the funnel, not a copy of the primary's numbers.
 *
 * Then `planFallbacks` (which judges how many independent alternatives the
 * dependency needs, `judgeAlternatives`) and `fallbackChain` per failure mode
 * run on it, and the result is recorded on the append-only ledger
 * (`bin_events`, FALLBACK_PLAN_RECORDED) whenever it changes. It switches
 * nothing, sends nothing and decides nothing: it is the structure a switch
 * decision reads.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import {
  fallbackChain,
  planFallbacks,
  type Dependency,
  type EconomicModel,
  type FailureMode,
  type FallbackChain,
  type FallbackPlan,
} from './fallbacks.ts';
import { acquisitionDependency, type AcquisitionPath } from './fallbackIndependence.ts';
import { makeFigure, unknownFigure, type Figure } from './graph.ts';

export const FALLBACK_PLAN_EVENT = 'FALLBACK_PLAN_RECORDED';

/** One acquisition path's measured funnel, from its own contact results. */
export interface MeasuredPath extends AcquisitionPath {
  /** Distinct prospects whose result was CONTACT_UNDELIVERABLE. */
  undeliverable: number;
  /** Distinct delivered prospects whose result is an answer (anything but silence). */
  answered: number;
}

export interface ProjectFallbackPlanRecord {
  /** Stable for one plan: a refresh that plans the same way writes nothing. */
  signature: string;
  plan: FallbackPlan;
  chains: FallbackChain[];
  at: string;
}

const DAY_MS = 86_400_000;

function figure(meaning: string, unit: string, value: number, source: string, status: Figure['status'] = 'OBSERVED'): Figure {
  const made = makeFigure({ meaning, unit, value, status, source });
  return made.ok ? made.figure : unknownFigure(meaning, unit);
}

const keyOf = (p: AcquisitionPath): string => `${p.mechanism} @ ${p.channel}`;

/** A path's measured share, or unknown when it has no denominator. */
function share(meaning: string, numerator: number, denominator: number, source: string): Figure {
  return denominator > 0 ? figure(meaning, 'share', numerator / denominator, source) : unknownFigure(meaning, 'share', ['a contact result on the path']);
}

function funnelOf(p: MeasuredPath, projectId: string): Record<string, Figure> {
  const source = `cash_outcomes CONTACT_RESULT rows of project ${projectId}, mechanism "${p.mechanism}", channel "${p.channel}"`;
  return {
    prospectsReached: figure(`${keyOf(p)}: prospects reached`, 'prospects', p.contacts, source),
    deliverability: share(`${keyOf(p)}: share of prospects delivered`, p.contacts - p.undeliverable, p.contacts, source),
    responseRate: share(`${keyOf(p)}: share of delivered prospects answering`, p.answered, p.contacts - p.undeliverable, source),
  };
}

/** Days left of the project's cash sprint at `nowMs`, as a person set it; unknown when it runs none. */
export async function sprintDaysLeft(projectId: string, nowMs: number): Promise<Figure> {
  const mode = await getCashMode(projectId);
  const meaning = 'days left of the cash sprint inside which a recovery still counts';
  if (!mode || !Number.isFinite(mode.horizonDays) || mode.horizonDays <= 0) return unknownFigure(meaning, 'days', ['a cash sprint horizon']);
  const end = Date.parse(mode.activatedAt) + mode.horizonDays * DAY_MS;
  if (!Number.isFinite(end)) return unknownFigure(meaning, 'days', ['a cash sprint activation time']);
  return figure(meaning, 'days', Math.max(0, (end - nowMs) / DAY_MS), `cash_modes ${mode.id}: horizon_days ${mode.horizonDays} from ${mode.activatedAt}`, 'EVIDENCED');
}

/** The two ways an outreach path fails that its own rows can show. Pure. */
export function acquisitionFailureModes(primary: MeasuredPath, recoveryWindowDays: Figure): FailureMode[] {
  const path = keyOf(primary);
  return [
    {
      key: 'channel-stops-delivering',
      condition: `${path}: the channel account stops delivering (suspended, throttled or its reputation lost)`,
      detectionSignals: [
        `the CONTACT_UNDELIVERABLE share of ${path}'s contact results rises`,
        'the sending accounts\' health in the workspace reading falls',
      ],
      failureEvidence: [`cash_outcomes CONTACT_UNDELIVERABLE rows for ${path}`],
      timeToHarmDays: unknownFigure(`${path}: days from the channel failing to lost pipeline`, 'days', ['a measured lag from send to answer']),
      recoveryWindowDays,
      probability: unknownFigure(`${path}: the channel stops delivering this period`, 'probability', ['a measured history of channel failures']),
    },
    {
      key: 'prospects-stop-answering',
      condition: `${path}: the prospects it reaches stop answering`,
      detectionSignals: [`the share of ${path}'s delivered prospects answering falls`],
      failureEvidence: [`cash_outcomes BUYER_SILENT rows for ${path}`],
      timeToHarmDays: unknownFigure(`${path}: days from answers stopping to lost pipeline`, 'days', ['a measured lag from send to answer']),
      recoveryWindowDays,
      probability: unknownFigure(`${path}: its prospects stop answering this period`, 'probability', ['a measured history of response collapses']),
    },
  ];
}

/**
 * The acquisition dependency with its failure modes and each substitute's own
 * funnel as the overrides a switch applies, and the funnel model a switch
 * re-derives. Null when there is no path. Pure.
 */
export function acquisitionFallbackStructure(
  projectId: string,
  paths: readonly MeasuredPath[],
  authority: { ok: boolean | null; reason: string },
  recoveryWindowDays: Figure,
): { dependency: Dependency; model: EconomicModel } | null {
  const base = acquisitionDependency(projectId, paths, authority);
  if (!base) return null;
  const byKey = new Map(paths.map((p) => [keyOf(p), p]));
  const primary = paths.find((p) => base.primaryPath.startsWith(`${keyOf(p)} (`))!;
  const dependency: Dependency = {
    ...base,
    failureModes: acquisitionFailureModes(primary, recoveryWindowDays),
    substitutes: base.substitutes.map((s) => {
      const funnel = funnelOf(byKey.get(s.key)!, projectId);
      return { ...s, overrides: { deliverability: funnel.deliverability!, responseRate: funnel.responseRate! } };
    }),
  };
  const model: EconomicModel = {
    inputs: funnelOf(primary, projectId),
    capacityInput: 'prospectsReached',
    figures: [
      { key: 'deliveredProspects', meaning: 'prospects delivered', unit: 'prospects', from: ['prospectsReached', 'deliverability'], compute: ([n, d]) => n! * d! },
      { key: 'responders', meaning: 'prospects answering', unit: 'prospects', from: ['deliveredProspects', 'responseRate'], compute: ([n, r]) => n! * r! },
    ],
  };
  return { dependency, model };
}

/** Each acquisition path the project's outcome rows state, with its measured funnel. */
export async function readMeasuredPaths(projectId: string): Promise<MeasuredPath[]> {
  const rows = await getDb().all<{ mechanism: string | null; channel: string | null; n: number; bounced: number; answered: number }>(
    `SELECT mechanism, channel,
            COUNT(DISTINCT opportunity_id) AS n,
            COUNT(DISTINCT CASE WHEN value_text = 'CONTACT_UNDELIVERABLE' THEN opportunity_id END) AS bounced,
            COUNT(DISTINCT CASE WHEN value_text <> 'CONTACT_UNDELIVERABLE' AND value_text <> 'BUYER_SILENT' THEN opportunity_id END) AS answered
       FROM cash_outcomes
      WHERE project_id = ? AND kind = 'CONTACT_RESULT'
      GROUP BY mechanism, channel ORDER BY mechanism, channel`,
    [projectId],
  );
  return rows.map((r) => ({
    mechanism: r.mechanism ?? 'unspecified',
    channel: r.channel ?? 'unspecified',
    contacts: Number(r.n),
    undeliverable: Number(r.bounced),
    answered: Number(r.answered),
  }));
}

/** The last fallback plan recorded for a project, or null. */
export async function readProjectFallbackPlan(projectId: string): Promise<ProjectFallbackPlanRecord | null> {
  const row = await getDb().get<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at DESC, id DESC LIMIT 1`,
    [FALLBACK_PLAN_EVENT, projectId],
  );
  try {
    const value = (JSON.parse(row?.measures ?? '{}') as { fallbackPlan?: ProjectFallbackPlanRecord }).fallbackPlan;
    return value && typeof value.signature === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** What the plan is, without figures that move on every new contact or every day. */
function signatureOf(plan: FallbackPlan, chains: readonly FallbackChain[]): string {
  return JSON.stringify([
    plan.dependency,
    plan.failureModes.map((m) => m.key),
    plan.substitutes.map((s) => [s.key, s.readiness, s.eligible, s.sharedWithPrimary]),
    plan.alternatives.required,
    plan.alternatives.met,
    plan.unrecoverableInTime,
    chains.map((c) => [c.failureCondition, c.replacements.map((r) => [r.substitute, r.eligibility.eligible])]),
  ]);
}

/**
 * The production path: build the project's acquisition fallback structure from
 * its rows, plan it, export the chain per failure mode with each switch's
 * re-derived funnel, and record it when it changes. With no outreach on record
 * there is no dependency to plan and nothing is written.
 */
export async function assessProjectFallbackPlan(
  projectId: string,
  deps: {
    paths?: () => Promise<MeasuredPath[]>;
    authority?: () => Promise<{ ok: boolean | null; reason: string }>;
    recoveryWindow?: () => Promise<Figure>;
    last?: () => Promise<ProjectFallbackPlanRecord | null>;
    record?: typeof recordBinEvent;
    now?: () => Date;
  } = {},
): Promise<{ record: ProjectFallbackPlanRecord | null; written: boolean }> {
  const paths = await (deps.paths ?? (() => readMeasuredPaths(projectId)))();
  if (!paths.some((p) => p.contacts > 0)) return { record: null, written: false };
  const now = deps.now?.() ?? new Date();
  const authority = await (deps.authority ?? (async () => {
    const { authorityForSwitch } = await import('./fallbackSwitch.ts');
    return authorityForSwitch(projectId, 'CONTACT_BUYER');
  }))();
  const window = await (deps.recoveryWindow ?? (() => sprintDaysLeft(projectId, now.getTime())))();
  const built = acquisitionFallbackStructure(projectId, paths, authority, window);
  if (!built) return { record: null, written: false };
  const plan = planFallbacks(built.dependency);
  const chains = built.dependency.failureModes.map((m) => fallbackChain(built.dependency, m.key, built.model));
  const signature = signatureOf(plan, chains);
  const last = await (deps.last ?? (() => readProjectFallbackPlan(projectId)))();
  if (last?.signature === signature) return { record: last, written: false };
  const record: ProjectFallbackPlanRecord = { signature, plan, chains, at: now.toISOString() };
  await (deps.record ?? recordBinEvent)({
    eventType: FALLBACK_PLAN_EVENT,
    projectId,
    workloadClass: 'fallback-plan',
    outcome: 'PLANNED',
    reason: (
      `${plan.dependency}: ${plan.failureModes.length} failure mode(s), ${plan.substitutes.length} substitute(s); ` +
      `alternatives ${plan.alternatives.required === null ? 'not judged' : `${plan.alternatives.required} required, ${plan.alternatives.met ? 'met' : 'not met'}`}`
    ).slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { fallbackPlan: record },
  });
  return { record, written: true };
}
