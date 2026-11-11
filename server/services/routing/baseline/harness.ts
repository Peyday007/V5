/**
 * The routing baseline: a stored workload replayed through the paths that
 * decide today (code detectors, then the free cheap lane, then the shortlist
 * rules that would create a research packet), with every figure counted from
 * what actually ran. Nothing is estimated: a figure the replay cannot measure
 * is reported as null, never filled in.
 *
 * The replay touches no feed_items row and opens no round. It writes the
 * cheap_results the lane always writes (keyed by the workload's own ids), and
 * one baseline row that later reports compare against.
 *
 * Production records it through `ensureBaseline`, run as a command against the
 * live database before a routing change is released:
 *
 *   tsx --env-file-if-exists=.env server/services/routing/baseline/harness.ts --project <id>
 *
 * The workload is the feed items production has already stored (newest first),
 * screened by the configured free lane. With no lane configured or nothing
 * stored, nothing is recorded and the command says why: a baseline of invented
 * answers would be worse than none.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { recordBaseline, listBaselines } from '../../../repos/workRouting.ts';
import { unlistedFeedItems } from '../../../repos/feeds.ts';
import { CONCENTRATED_HIRING } from '../../feeds/detectors.ts';
import type { Detector, DetectorRecord } from '../../feeds/detectors.ts';
import { leadPassesRules } from '../../feeds/run.ts';
import { httpCompleter, laneConfig, screenLead } from '../../cheap/lane.ts';
import type { Completer, LaneConfig, LeadOutput } from '../../cheap/lane.ts';
import type { StoredFeedItem } from '../../../repos/feeds.ts';

const DAY = 86_400_000;

export interface WorkloadItem {
  id: string; source: string; title: string; organization: string | null; daysAgo: number; body: string;
}
export interface Workload { label: string; items: WorkloadItem[] }

export interface BaselineReadings {
  workload: { label: string; digest: string; items: number };
  /** Items a code detector accounts for, so no model was asked about them. */
  codeCovered: number;
  codeSignals: number;
  /** Items the cheap lane was asked about, and the calls that cost. */
  cheapItems: number;
  cheapCalls: number;
  cheapValidAnswers: number;
  cheapFailedAnswers: number;
  /** Lane answers that said KEEP and passed the shortlist rules. */
  shortlistEligible: number;
  /** Premium (Claude) jobs the replay launched: the replay opens none, so this is a count of zero, not a guess. */
  premiumJobsLaunched: 0;
  /** What the replay cannot see from a stored workload. */
  unknown: string[];
}

export function workloadDigest(w: Workload): string {
  return createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16);
}

/** Replay once. `completer` is the cheap-lane model stand-in; every call it receives is counted. */
export async function replayWorkload(input: {
  workload: Workload; now?: Date; completer: Completer; config?: LaneConfig; detectors?: readonly Detector[];
}): Promise<BaselineReadings> {
  const now = input.now ?? new Date();
  const config: LaneConfig = input.config ?? { url: 'http://baseline.invalid/v1', key: null, models: ['baseline-a', 'baseline-b'], dailyBudget: 100_000, timeoutMs: 1000 };
  const at = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
  const stored: StoredFeedItem[] = input.workload.items.map((i) => ({
    id: `baseline:${input.workload.label}:${i.id}`, source: i.source, externalId: i.id,
    url: `https://baseline.invalid/${i.id}`, title: i.title, body: i.body || null,
    organization: i.organization, publishedAt: at(i.daysAgo), fetchedAt: now.toISOString(), shortlistedRoundId: null,
  }));

  // 1. Code first: pure detectors over the stored records.
  const records: DetectorRecord[] = stored.map((s) => ({
    id: s.id, source: s.source, url: s.url, title: s.title, organization: s.organization,
    publishedAt: s.publishedAt, fetchedAt: s.fetchedAt,
  }));
  const covered = new Set<string>();
  let codeSignals = 0;
  for (const detector of input.detectors ?? [CONCENTRATED_HIRING]) {
    if (detector.mode !== 'ACTIVE') continue;
    for (const signal of detector.detect(records, now)) { codeSignals += 1; signal.memberIds.forEach((m) => covered.add(m)); }
  }

  // 2. The cheap lane for what no rule covers.
  let calls = 0;
  const counting: Completer = async (...args) => { calls += 1; return input.completer(...args); };
  let valid = 0;
  let failed = 0;
  let eligible = 0;
  const asked = stored.filter((s) => !covered.has(s.id));
  for (const item of asked) {
    const out: LeadOutput | null = await screenLead(
      item.id,
      { source: item.source, title: item.title, organization: item.organization, publishedAt: item.publishedAt, body: item.body, url: item.url },
      { config, completer: counting, now },
    );
    if (out) valid += 1; else failed += 1;
    // 3. The shortlist rules: what would go on to a research packet.
    if (leadPassesRules(item, out, now)) eligible += 1;
  }

  return {
    workload: { label: input.workload.label, digest: workloadDigest(input.workload), items: stored.length },
    codeCovered: covered.size, codeSignals, cheapItems: asked.length, cheapCalls: calls,
    cheapValidAnswers: valid, cheapFailedAnswers: failed, shortlistEligible: eligible, premiumJobsLaunched: 0,
    unknown: ['verification pass rate', 'gate rejections', 'wall-clock cost per resource'],
  };
}

/** Replay and store the readings as a baseline row for the project. Returns the row id. */
export async function storeBaseline(input: Parameters<typeof replayWorkload>[0] & { projectId: string }): Promise<{ id: string; readings: BaselineReadings }> {
  const readings = await replayWorkload(input);
  const id = await recordBaseline({ projectId: input.projectId, label: input.workload.label, readings: readings as unknown as Record<string, unknown> });
  return { id, readings };
}

/** The newest stored baseline for a label, for a later report to compare against. */
export async function readBaseline(projectId: string, label: string): Promise<{ id: string; readings: BaselineReadings; takenAt: string } | null> {
  const row = (await listBaselines(projectId)).find((b) => b.label === label);
  return row ? { id: row.id, readings: row.readings as unknown as BaselineReadings, takenAt: row.takenAt } : null;
}

/** The label a production baseline is stored under, and the one reports pass as `--baseline`. */
export const BASELINE_LABEL = 'routing-baseline-v1';

/** A stored feed item as a workload item: its age is measured from `now`, never assumed. */
export function workloadFromStored(label: string, items: readonly StoredFeedItem[], now: Date): Workload {
  return {
    label,
    items: items.map((s) => {
      const t = Date.parse(s.publishedAt ?? s.fetchedAt);
      return {
        id: s.id, source: s.source, title: s.title, organization: s.organization,
        daysAgo: Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / DAY)) : 0,
        body: s.body ?? '',
      };
    }),
  };
}

export type EnsureResult =
  | { status: 'EXISTS'; id: string; takenAt: string; readings: BaselineReadings }
  | { status: 'RECORDED'; id: string; readings: BaselineReadings }
  | { status: 'NOT_RECORDED'; reason: string };

/**
 * Record the project's baseline once, from the stored workload, on the real lane.
 * An existing baseline under the label is kept: the first one is the comparison point.
 */
export async function ensureBaseline(input: {
  projectId: string; label?: string; now?: Date; limit?: number; sinceDays?: number;
  env?: NodeJS.ProcessEnv; completer?: Completer;
}): Promise<EnsureResult> {
  const label = input.label ?? BASELINE_LABEL;
  const existing = await readBaseline(input.projectId, label);
  if (existing) return { status: 'EXISTS', ...existing };
  const config = laneConfig(input.env ?? process.env);
  if (!config) return { status: 'NOT_RECORDED', reason: 'the free cheap lane is not configured (BRAIN_CHEAP_LLM_URL unset), so no answer could be measured' };
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.sinceDays ?? 30) * DAY).toISOString();
  const stored = await unlistedFeedItems({ since, limit: Math.min(500, Math.max(1, input.limit ?? 100)) });
  if (stored.length === 0) return { status: 'NOT_RECORDED', reason: `no stored feed items since ${since} to replay` };
  const workload = workloadFromStored(label, stored, now);
  const { id, readings } = await storeBaseline({ projectId: input.projectId, workload, now, config, completer: input.completer ?? httpCompleter });
  return { status: 'RECORDED', id, readings };
}

/** The command: parse flags, ensure the baseline, print what happened. Returns the exit code. */
export async function runBaselineCommand(argv: readonly string[], out: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const projectId = flag('project');
  if (!projectId) { out('--project <id> is required'); return 2; }
  const limit = flag('limit') ? Number(flag('limit')) : undefined;
  const r = await ensureBaseline({ projectId, label: flag('label'), limit, env });
  if (r.status === 'NOT_RECORDED') { out(`baseline NOT RECORDED: ${r.reason}`); return 1; }
  out(`baseline ${r.status === 'EXISTS' ? 'already recorded' : 'recorded'}: ${r.id} (${r.readings.workload.items} items, digest ${r.readings.workload.digest})`);
  out(JSON.stringify(r.readings));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { initDatabase, closeDatabase } = await import('../../../db/database.ts');
  await initDatabase();
  try { process.exitCode = await runBaselineCommand(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`)); }
  finally { await closeDatabase(); }
}
