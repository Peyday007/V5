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
import { readFailureRecoveries, recordFailureRecovery, type FailureRecoveryInput, type FailureRecoveryRecord } from './ledger.ts';

export const FALLBACK_PLAN_EVENT = 'FALLBACK_PLAN_RECORDED';

/** The occurrence key prefix of an acquisition path's failure records. */
export const ACQUISITION_FAILURE_PREFIX = 'acquisition-failure:';

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
): { dependency: Dependency; model: EconomicModel; primary: MeasuredPath } | null {
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
  return { dependency, model, primary };
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

/* ------------------------------------------------------------------------- */
/* The acquisition dependency's own failures (FALL-37-4, FALL-37-6)           */
/* ------------------------------------------------------------------------- */

/** One contact result on a path, in the order its rows were written. */
export interface ContactResult {
  id: string;
  /** The row's `value_text`: CONTACT_UNDELIVERABLE, BUYER_SILENT or an answer. */
  result: string;
  at: string;
}

/**
 * The significance a run of failed results must reach before it is read as the
 * path failing rather than ordinary noise: the run's probability under the
 * path's own record before it. The same 5% bar a two-sided test at the
 * calibrator's z of ~2 uses; it is a bar on evidence, never a fixed count.
 */
export const ACQUISITION_FAILURE_SIGNIFICANCE = 0.05;

/**
 * Each time a failure mode of the acquisition primary happened, read from its
 * own ordered contact results, as failure-and-recovery records under the
 * dependency's key — the key the preparation ranking reads a live failure by.
 *
 * A mode happened when a run of consecutive failed results is improbable under
 * the path's own record before the run (Laplace-smoothed, so a short history is
 * never read as certainty): P(run) = (1 − rate)^length below
 * `ACQUISITION_FAILURE_SIGNIFICANCE`. For `channel-stops-delivering` a failed
 * result is CONTACT_UNDELIVERABLE over every result; for
 * `prospects-stop-answering` it is BUYER_SILENT over delivered results. The
 * occurrence is the run's first row, so it is stable while the run grows; the
 * path recovered when a good result follows the run, and recovery is unknown
 * while the run is still the latest thing its rows say. Time to harm, cash and
 * reputation no row states, so they stay unknown; nothing is claimed tried. Pure.
 */
export function acquisitionFailures(dependencyKey: string, pathKey: string, results: readonly ContactResult[]): FailureRecoveryInput[] {
  const modes: { mode: string; considered: (r: ContactResult) => boolean; failed: (r: ContactResult) => boolean }[] = [
    { mode: 'channel-stops-delivering', considered: () => true, failed: (r) => r.result === 'CONTACT_UNDELIVERABLE' },
    { mode: 'prospects-stop-answering', considered: (r) => r.result !== 'CONTACT_UNDELIVERABLE', failed: (r) => r.result === 'BUYER_SILENT' },
  ];
  assertModesNamed(modes.map((m) => m.mode));
  const out: FailureRecoveryInput[] = [];
  for (const { mode, considered, failed } of modes) {
    const seq = results.filter(considered);
    let good = 0;
    let total = 0;
    let i = 0;
    while (i < seq.length) {
      if (!failed(seq[i]!)) {
        good++;
        total++;
        i++;
        continue;
      }
      // A run of failed results starting at i, judged against the record before it.
      const rate = (good + 1) / (total + 2);
      let j = i;
      let crossedAt: number | null = null;
      while (j < seq.length && failed(seq[j]!)) {
        if (crossedAt === null && Math.pow(1 - rate, j - i + 1) < ACQUISITION_FAILURE_SIGNIFICANCE) crossedAt = j;
        j++;
      }
      // A path that never once succeeded did not stop: it never started, and there is no record to fall from.
      if (crossedAt !== null && good > 0) {
        const start = seq[i]!;
        const seen = seq[crossedAt]!;
        const delay = (Date.parse(seen.at) - Date.parse(start.at)) / DAY_MS;
        out.push({
          occurrence: `${ACQUISITION_FAILURE_PREFIX}${dependencyKey}:${pathKey}:${mode}:${start.id}`,
          dependency: dependencyKey,
          path: pathKey,
          failureMode: mode,
          failureClass: `ACQUISITION:${mode}`,
          detectionDelayDays: Number.isFinite(delay) ? Math.max(0, delay) : null,
          timeToHarmDays: null,
          tried: [],
          recovered: j < seq.length ? true : null,
          cashLostCents: null,
          cashPreservedCents: null,
          timeLostDays: null,
          reputation: null,
          methodsToImprove: [...ACQUISITION_METHODS[mode]!],
        });
      }
      total += j - i;
      i = j;
    }
  }
  return out;
}

/**
 * The general methods a failure of each acquisition mode says need improving:
 * how early the mode is detected on a path's own results, and whether the
 * dependency had an independent path ready to carry it. They are what a
 * recurring failure class hands Factory (`fallbackWatch.ts`), so a class that
 * keeps recurring becomes an improvement objective rather than a count.
 */
export const ACQUISITION_METHODS: Readonly<Record<string, readonly string[]>> = {
  'channel-stops-delivering': [
    'detecting an outreach channel that stops delivering (runs of CONTACT_UNDELIVERABLE results) early on the path\'s own results',
    'keeping an independent acquisition path, on a different channel account, prepared to carry the dependency',
  ],
  'prospects-stop-answering': [
    'detecting delivered prospects going silent (runs of BUYER_SILENT results) early on the path\'s own results',
    'changing the segment or offer of a path whose delivered prospects stop answering',
  ],
};

/** The method a failure names when no qualified substitute could carry the dependency. */
export const NO_REPLACEMENT_METHOD = 'qualifying an eligible, independent substitute for the acquisition dependency before its primary fails';

function assertModesNamed(modes: readonly string[]): void {
  for (const mode of modes) if (!ACQUISITION_METHODS[mode]) throw new Error(`acquisition failure mode ${mode} names no method to improve`);
}

/* ------------------------------------------------------------------------- */
/* What Brain tried, and whether it worked (FALL-37-4, S-0500, S-0506)        */
/* ------------------------------------------------------------------------- */

/**
 * Each switch decision `fallbackApply.ts` takes on an open failure, recorded
 * on the append-only ledger (`bin_events`) when it changes: what Brain tried
 * for that failure. The failure record itself is settled once — when its
 * recovery is known — and carries these as its `tried`.
 */
export const FALLBACK_SWITCH_EVENT = 'FALLBACK_SWITCH_DECIDED';

/** The `tried` entry a switch writes; a failure settled under it recovered by the switch, not on its own path. */
export const SWITCH_TRIED_PREFIX = 'switched: ';

export interface SwitchDecisionRecord {
  /** The failure occurrence the decision answered. */
  occurrence: string;
  dependency: string;
  state: 'SWITCHED' | 'NO_REPLACEMENT';
  /** The failed path the decision moved off. */
  primaryPath: string;
  replacement: string | null;
  /** What Brain tried, in words, in order: the switch (or that none qualified) and each substitute passed over. */
  tried: string[];
  at: string;
}

/** Every recorded switch decision of a project, in write order. */
export async function readSwitchDecisionRecords(projectId: string): Promise<SwitchDecisionRecord[]> {
  const rows = await getDb().all<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at ASC, id ASC`,
    [FALLBACK_SWITCH_EVENT, projectId],
  );
  const out: SwitchDecisionRecord[] = [];
  for (const r of rows) {
    try {
      const value = (JSON.parse(r.measures ?? '{}') as { switchDecision?: SwitchDecisionRecord }).switchDecision;
      if (value && typeof value.occurrence === 'string') out.push(value);
    } catch {
      continue;
    }
  }
  return out;
}

/** What the recorded decisions on one failure say Brain tried, de-duplicated, in order. Pure. */
export function triedFor(occurrence: string, decisions: readonly SwitchDecisionRecord[]): string[] {
  return [...new Set(decisions.filter((d) => d.occurrence === occurrence).flatMap((d) => d.tried))];
}

/** Whether a failure was settled by switching the dependency to a substitute, rather than by its own path recovering. Pure. */
export function recoveredBySwitch(f: Pick<FailureRecoveryRecord, 'recovered' | 'tried'>): boolean {
  return f.recovered === true && f.tried.some((t) => t.startsWith(SWITCH_TRIED_PREFIX));
}

/** Whether a failure still holds its path down: unrecovered, or recovered only by a switch while its own rows show no recovery. Pure. */
function stillFailing(f: FailureRecoveryRecord, ownRecovered: ReadonlySet<string> | undefined): boolean {
  if (f.recovered !== true) return true;
  return ownRecovered !== undefined && recoveredBySwitch(f) && !ownRecovered.has(f.occurrence);
}

/**
 * The occurrences whose own path's results show it recovered, re-read from
 * every path's rows (the same reading `recordAcquisitionFailures` records
 * from). A failure the dependency recovered from by switching stays a failure
 * of its path until these say otherwise.
 */
export async function ownPathRecoveries(
  projectId: string,
  dependencyKey: string,
  paths: readonly AcquisitionPath[],
  results: (path: AcquisitionPath) => Promise<ContactResult[]> = (p) => readContactResults(projectId, p),
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const path of paths) {
    if (path.contacts <= 0) continue;
    for (const f of acquisitionFailures(dependencyKey, keyOf(path), await results(path))) if (f.recovered === true) out.add(f.occurrence);
  }
  return out;
}

/** A path's contact results in write order. */
export async function readContactResults(projectId: string, path: AcquisitionPath): Promise<ContactResult[]> {
  const rows = await getDb().all<{ id: string; value_text: string | null; created_at: string }>(
    `SELECT id, value_text, created_at FROM cash_outcomes
      WHERE project_id = ? AND kind = 'CONTACT_RESULT'
        AND COALESCE(mechanism, 'unspecified') = ? AND COALESCE(channel, 'unspecified') = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId, path.mechanism, path.channel],
  );
  return rows.map((r) => ({ id: r.id, result: r.value_text ?? '', at: r.created_at }));
}

/**
 * The path a failure record happened on: the path it names, or — for a record
 * written before records named one — the path inside its acquisition
 * occurrence key. Null when neither says, which is a failure of the
 * dependency as a whole. Pure.
 */
export function failedPathOf(f: Pick<FailureRecoveryRecord, 'occurrence' | 'dependency' | 'failureMode' | 'path'>): string | null {
  if (typeof f.path === 'string' && f.path.length > 0) return f.path;
  const prefix = `${ACQUISITION_FAILURE_PREFIX}${f.dependency}:`;
  if (!f.occurrence.startsWith(prefix)) return null;
  const rest = f.occurrence.slice(prefix.length);
  const end = rest.lastIndexOf(`:${f.failureMode}:`);
  return end > 0 ? rest.slice(0, end) : null;
}

/** Whether a stated primary path (`key (N prospect(s) reached)`, or the bare key) is this path. Pure. */
export function isPrimaryPath(primaryPath: string, path: string): boolean {
  return primaryPath === path || primaryPath.startsWith(`${path} (`);
}

/**
 * The unrecovered failures that are failures of the dependency's current
 * primary: of this dependency, not recovered, and on the primary path (or on
 * no stated path, which is the dependency as a whole). A failure of a path
 * that has since stopped being primary stays on the ledger, but it is that
 * path's failure, not the primary's, and never makes a healthy primary read
 * as failed. Pure.
 */
export function openPrimaryFailures(
  failures: readonly FailureRecoveryRecord[],
  dependencyKey: string,
  primaryPath: string,
  ownRecovered?: ReadonlySet<string>,
): FailureRecoveryRecord[] {
  return failures.filter((f) => {
    if (f.dependency !== dependencyKey || !stillFailing(f, ownRecovered)) return false;
    const path = failedPathOf(f);
    return path === null || isPrimaryPath(primaryPath, path);
  });
}

/** The unrecovered failures of one named path of a dependency (a substitute's own failures). Pure. */
export function openPathFailures(
  failures: readonly FailureRecoveryRecord[],
  dependencyKey: string,
  path: string,
  ownRecovered?: ReadonlySet<string>,
): FailureRecoveryRecord[] {
  return failures.filter((f) => f.dependency === dependencyKey && stillFailing(f, ownRecovered) && failedPathOf(f) === path);
}

/**
 * The production producer of the acquisition dependency's failure records:
 * read every path's own ordered results — the primary's and each
 * substitute's — and record every failure its rows show, under the path it
 * happened on, and its recovery once the rows show that, through the
 * ledger's one writer. Reading every path is what settles a failure on a path
 * that has since stopped being the primary, and what keeps a substitute that
 * is itself failing from being switched to.
 */
export async function recordAcquisitionFailures(
  projectId: string,
  dependencyKey: string,
  paths: readonly AcquisitionPath[],
  deps: {
    results?: (path: AcquisitionPath) => Promise<ContactResult[]>;
    record?: NonNullable<Parameters<typeof recordFailureRecovery>[1]>['record'];
    decisions?: () => Promise<SwitchDecisionRecord[]>;
  } = {},
): Promise<{ occurrence: string; recovered: boolean | null; written: boolean }[]> {
  const found: FailureRecoveryInput[] = [];
  for (const path of paths) {
    if (path.contacts <= 0) continue;
    const results = await (deps.results ?? ((p: AcquisitionPath) => readContactResults(projectId, p)))(path);
    found.push(...acquisitionFailures(dependencyKey, keyOf(path), results));
  }
  if (found.length === 0) return [];
  let held = await readFailureRecoveries(projectId);
  const decisions = found.some((f) => f.recovered !== null) ? await (deps.decisions ?? (() => readSwitchDecisionRecords(projectId)))() : [];
  const out: { occurrence: string; recovered: boolean | null; written: boolean }[] = [];
  for (const candidate of found) {
    // A failure settled by its own path's results carries what Brain tried for it meanwhile (each recorded
    // switch decision), and the path's own recovery as the verification that it worked.
    const input: FailureRecoveryInput = candidate.recovered === null ? candidate : settledOnOwnPath(candidate, decisions);
    const { record, written } = await recordFailureRecovery(input, { projectId, caller: 'fallback-acquisition', read: async () => held, ...(deps.record ? { record: deps.record } : {}) });
    if (written) held = [...held.filter((r) => r.occurrence !== record.occurrence), record];
    out.push({ occurrence: record.occurrence, recovered: record.recovered, written });
  }
  return out;
}

/**
 * A failure its own path recovered from, with what Brain tried for it: every
 * recorded decision on the occurrence, then the verification. When no
 * substitute could carry it, that is named as a method to improve. Pure.
 */
export function settledOnOwnPath(found: FailureRecoveryInput, decisions: readonly SwitchDecisionRecord[]): FailureRecoveryInput {
  const tried = triedFor(found.occurrence, decisions);
  const noReplacement = decisions.some((d) => d.occurrence === found.occurrence && d.state === 'NO_REPLACEMENT');
  return {
    ...found,
    tried: [...tried, `recovery verified: ${found.path ?? 'the path'} recorded a good result after the failure on its own rows`],
    methodsToImprove: noReplacement && !found.methodsToImprove.includes(NO_REPLACEMENT_METHOD) ? [...found.methodsToImprove, NO_REPLACEMENT_METHOD] : found.methodsToImprove,
  };
}
