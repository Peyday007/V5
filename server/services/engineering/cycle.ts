/**
 * Brain's engineering cycle, measured and kept as evidence (§115).
 *
 * The forge already records every stage of the cycle — workflow runs, their
 * jobs and steps, merged pull requests and their commits — so this reads them
 * (`domain/engineeringCycle.ts` does the arithmetic) and stores each reading as
 * one append-only `engineering_evidence` row, property ENGINEERING_CYCLE,
 * source CI. Nothing here is a second store, scheduler or optimizer:
 *
 *   - the operator's deficiency detector (`throughputDeficiencies`, director.ts)
 *     reads the newest reading and names the limiting stage when it moved or
 *     holds the threshold share of the critical path;
 *   - §87's loop commissions, baselines and judges a correction on
 *     ENGINEERING_CYCLE_HOURS_MEDIAN, which `scoreboard.readMetric` reads from
 *     these rows, and keeps or reverts it on the measured before and after.
 *
 * Production reads the forge without a token (sixty reads an hour shared with
 * Factory), and one 72-hour measurement costs a hundred or more, so the reading
 * is taken from a terminal — `npm run engineering -- cycle` — through the forge
 * with BRAIN_FORGE_TOKEN, or from the forge's own JSON fetched with `gh api`
 * (`--input DIR`), and recorded with `--record`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  bottleneckChange,
  measureThroughput,
  type BottleneckChange,
  type CycleReading,
  type CycleSources,
  type ForgeCommit,
  type ForgeJob,
  type ForgePull,
  type ForgeRun,
  type ImprovementMark,
} from '../../domain/engineeringCycle.ts';
import { evidenceMetadata, recordEvidence } from '../../repos/engineering.ts';
import {
  listClosedPullRequestsPage,
  listPullRequestCommits,
  listRunJobs,
  listWorkflowRunsPage,
  type ForgeRepository,
} from '../factory/forge.ts';

export const CYCLE_PROPERTY = 'ENGINEERING_CYCLE';

export interface StoredCycle {
  id: string;
  createdAt: string;
  reading: CycleReading;
  change: BottleneckChange;
}

/** The newest stored readings, newest first. */
export async function storedCycles(options: { repository?: string; limit?: number } = {}): Promise<StoredCycle[]> {
  const rows = await evidenceMetadata(CYCLE_PROPERTY, options);
  return rows
    .filter((row) => row.metadata['reading'] && row.metadata['change'])
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      reading: row.metadata['reading'] as CycleReading,
      change: row.metadata['change'] as BottleneckChange,
    }));
}

/**
 * Improvements whose measurement moved: an evolution experiment ADOPTed on its
 * suite, or an improvement candidate KEPT on its metric. Never a pull request.
 */
export async function verifiedImprovements(): Promise<ImprovementMark[]> {
  const { listExperiments } = await import('../../repos/evolution.ts');
  const { listCandidates } = await import('../../repos/improvement.ts');
  const out: ImprovementMark[] = [];
  for (const e of await listExperiments({ limit: 500 }).catch(() => [])) {
    if (e.verdict === 'ADOPT' && e.decidedAt) out.push({ ref: e.id, kind: 'EVOLUTION_ADOPT', at: e.decidedAt });
  }
  for (const c of await listCandidates().catch(() => [])) {
    if (c.decision === 'KEPT') out.push({ ref: c.id, kind: 'IMPROVEMENT_KEPT', at: c.updatedAt });
  }
  return out;
}

const isDeploy = (run: ForgeRun, canonicalBranch: string): boolean => run.name === 'Deploy' && run.head_branch === canonicalBranch;

/** Read the forge for a window: runs since `from`, Deploy jobs, merged pull requests and their commits. */
export async function fetchCycleSources(
  repository: ForgeRepository,
  canonicalBranch: string,
  window: { from: string; to: string },
): Promise<CycleSources> {
  const runs: ForgeRun[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const reply = await listWorkflowRunsPage(repository, window.from, page);
    if (!reply.ok || !reply.body) throw new Error(`workflow runs: ${reply.reason}`);
    runs.push(...(reply.body.runs as ForgeRun[]));
    if (reply.body.runs.length < 100) break;
  }
  const jobs: Record<string, ForgeJob[]> = {};
  for (const run of runs.filter((r) => isDeploy(r, canonicalBranch) && r.status === 'completed')) {
    const reply = await listRunJobs(repository, run.id);
    if (!reply.ok || !reply.body) throw new Error(`jobs of run ${run.id}: ${reply.reason}`);
    jobs[String(run.id)] = reply.body as ForgeJob[];
  }
  const pulls: ForgePull[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const reply = await listClosedPullRequestsPage(repository, page);
    if (!reply.ok || !reply.body) throw new Error(`pull requests: ${reply.reason}`);
    const rows = reply.body as (ForgePull & { updated_at?: string })[];
    pulls.push(...rows.filter((p) => p.merged_at && p.merged_at >= window.from && p.merged_at <= window.to));
    // Sorted by update: once a page is entirely older than the window, nothing later is in it.
    if (rows.length < 100 || rows.every((p) => (p.updated_at ?? '') < window.from)) break;
  }
  const commits: Record<string, ForgeCommit[]> = {};
  for (const pr of pulls) {
    const reply = await listPullRequestCommits(repository, pr.number);
    if (reply.ok && reply.body) commits[String(pr.number)] = reply.body as ForgeCommit[];
  }
  return { repository: repository.slug, canonicalBranch, runs, jobs, pulls, commits };
}

/**
 * The same sources from the forge's own JSON on disk, as `gh api` writes it:
 * `runs*.json` (pages of `actions/runs`, or one array), `pulls*.json` / `merged.json`
 * (arrays of pull requests), `jobs/<run id>.json` and `commits/<number>.json`.
 */
export function loadCycleSources(dir: string, repository: string, canonicalBranch: string): CycleSources {
  const read = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const files = readdirSync(dir);
  const byId = new Map<number, ForgeRun>();
  for (const file of files.filter((f) => /^runs.*\.json$/.test(f))) {
    const body = read(file) as { workflow_runs?: ForgeRun[] } | ForgeRun[];
    for (const run of Array.isArray(body) ? body : (body.workflow_runs ?? [])) byId.set(run.id, run);
  }
  const byNumber = new Map<number, ForgePull>();
  for (const file of files.filter((f) => /^(pulls.*|merged)\.json$/.test(f))) {
    for (const pr of read(file) as ForgePull[]) byNumber.set(pr.number, pr);
  }
  const keyed = <T>(sub: string, pick: (body: unknown) => T): Record<string, T> => {
    const out: Record<string, T> = {};
    if (!existsSync(join(dir, sub))) return out;
    for (const file of readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json'))) {
      out[file.replace(/\.json$/, '')] = pick(read(join(sub, file)));
    }
    return out;
  };
  return {
    repository,
    canonicalBranch,
    runs: [...byId.values()],
    pulls: [...byNumber.values()],
    jobs: keyed('jobs', (body) => (Array.isArray(body) ? body : ((body as { jobs?: ForgeJob[] }).jobs ?? [])) as ForgeJob[]),
    commits: keyed('commits', (body) => (Array.isArray(body) ? body : []) as ForgeCommit[]),
  };
}

/** Who a scheduled reading is recorded by: Brain's own schedule, not a person (engineering-cycle.yml). */
export const SCHEDULED_RECORDER = 'engineering:cycle-schedule';

/**
 * One CycleSources JSON on a stream — what engineering-cycle.yml collects with `gh api`
 * and sends to the machine. The repository and canonical branch are the caller's, not
 * the payload's; every list is held to its shape so a short payload measures nothing
 * rather than throwing half way.
 */
export async function readCycleSources(stream: AsyncIterable<Buffer | string>, repository: string, canonicalBranch: string): Promise<CycleSources> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<CycleSources>;
  const record = <T>(value: unknown): Record<string, T[]> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => Array.isArray(v))) as Record<string, T[]>
      : {};
  return {
    repository,
    canonicalBranch,
    runs: Array.isArray(body.runs) ? body.runs : [],
    pulls: Array.isArray(body.pulls) ? body.pulls : [],
    jobs: record<ForgeJob>(body.jobs),
    commits: record<ForgeCommit>(body.commits),
  };
}

/**
 * Measure a window, compare it with the newest stored reading, and — when `record` —
 * store it. The comparison is what the deficiency detector reads.
 */
export async function measureAndRecord(
  sources: CycleSources,
  window: { from: string; to: string },
  options: { record: boolean; recordedById?: string; recordedByType?: 'OPERATOR' | 'BRAIN' },
): Promise<{ reading: CycleReading; change: BottleneckChange; recorded: string | null }> {
  const reading = measureThroughput(sources, window, await verifiedImprovements());
  const previous = (await storedCycles({ repository: sources.repository, limit: 1 }))[0]?.reading ?? null;
  const change = bottleneckChange(previous, reading);
  let recorded: string | null = null;
  if (options.record) {
    recorded = await recordEvidence({
      repository: sources.repository,
      propertyKey: CYCLE_PROPERTY,
      status: 'PROVEN',
      source: 'CI',
      evidenceRef: `forge workflow runs ${window.from}..${window.to}: ${reading.verified} verified cycle(s), ${reading.releases.dispatched} Deploy run(s)`,
      recordedByType: options.recordedByType ?? 'OPERATOR',
      recordedById: options.recordedById ?? 'shell',
      metadata: { reading, change },
    });
  }
  return { reading, change, recorded };
}
