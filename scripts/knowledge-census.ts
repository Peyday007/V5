/**
 * GPU research-lane audit probe (2026-11-20). Strictly read-only: SELECTs and
 * pure readers only, no service call with a side effect. Every section prints
 * `KEY <json>`; a section that fails prints `KEY {"error": ...}` instead.
 *
 *   node --import tsx scripts/knowledge-census.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const H = 3_600_000;
const S48 = iso(NOW - 48 * H);
const S24 = iso(NOW - 24 * H);
const S6 = iso(NOW - 6 * H);
const S7D = iso(NOW - 7 * 24 * H);
const RESEARCH_TYPES = "('RESEARCH_PLAN','RESEARCH_FRAGMENT','RESEARCH_VERIFY','RESEARCH_SYNTHESIZE','RESEARCH_AUDIT')";

function out(key: string, value: unknown): void {
  console.log(`${key} ${JSON.stringify(value)}`);
}
function msg(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
}
async function section(key: string, run: () => Promise<unknown>): Promise<void> {
  try {
    out(key, await run());
  } catch (error) {
    out(key, { error: msg(error) });
  }
}
async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await getDb().all(sql, params as never[])) as Record<string, unknown>[];
}
const num = (v: unknown): number => Number(v ?? 0) || 0;
function parse(m: unknown): Record<string, unknown> {
  if (m && typeof m === 'object') return m as Record<string, unknown>;
  try {
    const p: unknown = typeof m === 'string' ? JSON.parse(m) : {};
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function stats(values: number[]): { n: number; mean: number; p50: number; p90: number; max: number } {
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number): number => (v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : 0);
  return { n: v.length, mean: v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : 0, p50: at(0.5), p90: at(0.9), max: v.length ? v[v.length - 1]! : 0 };
}
const modelOf = (reason: unknown): string => {
  const m = /^model ([^:]+)/.exec(String(reason ?? ''));
  return m ? m[1]!.trim() : 'unknown';
};
const ENV_KEYS = [
  'BRAIN_RUNPOD_MODE', 'BRAIN_RUNPOD_MODEL', 'BRAIN_RUNPOD_MAX_SLOTS', 'BRAIN_RUNPOD_BUDGET_USD', 'BRAIN_RUNPOD_BUDGET_WINDOW_HOURS',
  'BRAIN_RUNPOD_BUDGET_FROM', 'BRAIN_RUNPOD_AUTOSTOP', 'BRAIN_RUNPOD_IDLE_STOP_MINUTES', 'BRAIN_RUNPOD_MAX_USD_PER_HOUR', 'BRAIN_RUNPOD_CONTEXT',
  'BRAIN_RUNPOD_TOOLS', 'BRAIN_CHEAP_LLM_MODELS', 'BRAIN_CHEAP_LLM_DAILY_BUDGET', 'BRAIN_CHEAP_LLM_WINDOW_TOKENS',
  'BRAIN_DATABASE_POOL_SIZE', 'BRAIN_DATABASE_CONTROL_POOL_SIZE', 'BRAIN_REVISION', 'BRAIN_RUNPOD_POD_ID',
];
const PRESENCE_KEYS = ['BRAIN_RUNPOD_URL', 'BRAIN_RUNPOD_KEY', 'BRAIN_RUNPOD_API_KEY', 'BRAIN_CHEAP_LLM_URL', 'BRAIN_CHEAP_LLM_KEY'];
function pick(env: Record<string, string | undefined>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of ENV_KEYS) if (env[k] !== undefined) o[k] = env[k];
  for (const k of PRESENCE_KEYS) o[`${k}_set`] = Boolean(env[k]);
  return o;
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    console.log(`GPUAUDIT at ${iso(NOW)} revision ${process.env.BRAIN_REVISION ?? '<unstamped>'}`);

    /* ---------------- configuration (allowlisted names only) ---------------- */
    await section('ENV_PROBE', async () => pick(process.env));
    await section('ENV_SERVER', async () => {
      const found: Record<string, unknown>[] = [];
      for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
        if (Number(pid) === process.pid) continue;
        let cmd = '';
        try {
          cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        } catch {
          continue;
        }
        if (!/node/.test(cmd) || /knowledge-census/.test(cmd)) continue;
        try {
          const env: Record<string, string> = {};
          for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
            const i = kv.indexOf('=');
            if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
          }
          found.push({ pid, cmd: cmd.slice(0, 120), ...pick(env) });
        } catch (error) {
          found.push({ pid, cmd: cmd.slice(0, 120), error: msg(error) });
        }
      }
      return found;
    });
    await section('CODE_CONSTANTS', async () => {
      const cap = await import('../server/services/freeLane/capacity.ts');
      const rp = await import('../server/services/cheap/runpodRestore.ts');
      const recipes = Object.values(rp.RECIPES).filter((r) => r.served === 'openai/gpt-oss-120b').map((r) => ({ key: r.key, gpus: r.gpus, args: r.args.join(' ') }));
      return {
        servedSequencesGptOss: cap.servedSequences('runpod/openai/gpt-oss-120b'),
        gpuCeiling: cap.gpuCeiling(process.env, cap.servedSequences('runpod/openai/gpt-oss-120b')),
        slotShareAt8: cap.slotShare(2, 8),
        SLOTS_PER_DB_CONNECTION: cap.SLOTS_PER_DB_CONNECTION,
        ACTIVE_RECIPE: rp.ACTIVE_RECIPE,
        gptOssRecipes: recipes,
      };
    });

    /* ---------------- free-lane controller ---------------- */
    await section('CAP_ROWS', () => rows('SELECT model, target, stable_high, updated_at, reason FROM free_lane_capacity ORDER BY model'));
    await section('CAP_EVENTS_SUMMARY_24H', async () => {
      const r = await rows(`SELECT workload_class AS m, outcome AS o, reason AS r FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND at >= ?`, [S24]);
      const c = new Map<string, number>();
      for (const one of r) {
        const head = String(one['r'] ?? '').replace(/^\d+ -> \d+: /, '').replace(/\d+/g, '#').slice(0, 90);
        const k = `${one['m']} | ${one['o']} | ${head}`;
        c.set(k, (c.get(k) ?? 0) + 1);
      }
      return { total: r.length, byKind: [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40) };
    });
    await section('CAP_EVENTS_RECENT', async () => {
      const r = await rows(`SELECT at, workload_class, outcome, reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND at >= ? ORDER BY at DESC LIMIT 80`, [S24]);
      return r.map((x) => {
        const m = parse(x['measures']);
        return { at: x['at'], m: x['workload_class'], o: x['outcome'], r: String(x['reason']).slice(0, 260), w: m['waiting'], busy: m['busy'], peak: m['peakBusy'], ok: m['ok'], content: m['content'], tr: m['transient'], db: m['db'], dbC: m['dbContended'], lag: m['lagMs'], cpu: m['cpu'], loop: m['loop'], mach: m['machine'] };
      });
    });
    await section('CAP_EVENTS_1700_1830', async () => {
      const day = iso(NOW).slice(0, 10);
      const r = await rows(`SELECT at, workload_class, outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND at >= ? AND at <= ? ORDER BY at`, [`${day}T17:00:00`, `${day}T18:30:00`]);
      return r.map((x) => ({ at: x['at'], m: x['workload_class'], o: x['outcome'], r: String(x['reason']).slice(0, 200) }));
    });
    await section('IDLE_EVENTS_24H', async () => (await rows(`SELECT at, reason FROM bin_events WHERE event_type = 'FREE_LANE_IDLE' AND at >= ? ORDER BY at DESC LIMIT 20`, [S24])));
    await section('SEARCH_REFUSALS_24H', () => rows(`SELECT provider, COUNT(*) AS n FROM bin_events WHERE event_type = 'SOURCE_SEARCH' AND at >= ? GROUP BY provider`, [S24]));

    /* ---------------- stage-capacity readings ---------------- */
    await section('STAGE_LATEST', async () => {
      const { readStageCapacity } = await import('../server/services/freeLane/stageCapacity.ts');
      const rec = await readStageCapacity();
      if (!rec) return null;
      const rep = rec.report;
      const val = (m: unknown): unknown => (m && typeof m === 'object' && (m as { measured?: boolean }).measured ? (m as { value: unknown }).value : 'NM');
      return {
        at: rec.at, outcome: rec.outcome, ageMinutes: rec.ageMinutes, reason: rec.reason.slice(0, 300), queuedNow: rec.queuedNow, queueAdvance: rec.queueAdvance,
        windowHours: rep?.windowHours,
        constrained: rep ? { stage: rep.constrained.stage, basis: rep.constrained.basis, expectedGain: rep.constrained.expectedGain } : null,
        stages: rep?.stages.map((s) => ({ stage: s.stage, queue: val(s.queueSize), oldestMin: val(s.oldestUsefulItemMinutes), itemsPerH: val(s.itemsProcessedPerHour), accepted: s.accepted, acceptedPerH: s.acceptedPerHour, facts: val(s.uniqueUsableFacts), dropped: val(s.droppedOrDuplicate), provFail: val(s.providerFailures), elapsedMs: val(s.elapsedMs) })),
        gpuSpend: rep?.gpuSpend,
        primary: rep?.diagnosis.primary,
        routes: rep?.diagnosis.routes.map((r) => ({ route: r.route, submitted: r.submitted, providerFailures: r.providerFailures, cause: r.cause, restored: r.restored })),
        gpu: rep?.diagnosis.gpu,
        attribution: rep?.attribution,
      };
    });
    await section('STAGE_HISTORY_24H', async () => {
      const r = await rows(`SELECT at, outcome, measures FROM bin_events WHERE event_type = 'FREE_LANE_STAGE_CAPACITY' AND at >= ? ORDER BY at`, [S24]);
      return r.map((x) => {
        const m = parse(x['measures']);
        const c = (m['constrained'] ?? {}) as Record<string, unknown>;
        const stages = Array.isArray(m['stages']) ? (m['stages'] as Record<string, unknown>[]) : [];
        const st = (id: string) => {
          const s = stages.find((one) => one['stage'] === id);
          if (!s) return null;
          const f = s['uniqueUsableFacts'] as { measured?: boolean; value?: number } | undefined;
          const q = s['queueSize'] as { measured?: boolean; value?: number } | undefined;
          return { q: q?.value, acc: s['accepted'], facts: f?.measured ? f.value : 'NM' };
        };
        return { at: x['at'], o: x['outcome'], stage: c['stage'], gain: c['expectedGain'], basis: String(c['basis'] ?? '').slice(0, 160), mi: st('model-interpretation'), ev: st('evidence-verification') };
      });
    });

    /* ---------------- free-lane items ---------------- */
    await section('ITEMS', async () => {
      const r = await rows(`SELECT at, workload_class, outcome, reason, duration_ms, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? ORDER BY at`, [S48]);
      const hourly = new Map<string, Record<string, number>>();
      const byType = new Map<string, { d: number[]; calls: number[]; o: Record<string, number>; out: number; inn: number; dbMs: number }>();
      const fails = new Map<string, number>();
      for (const x of r) {
        const at = String(x['at']);
        const m = modelOf(x['reason']);
        const o = String(x['outcome']);
        const u = (parse(x['measures'])['usage'] ?? {}) as Record<string, number>;
        const hk = `${at.slice(0, 13)}|${m}`;
        const h = hourly.get(hk) ?? { n: 0, sub: 0, fail: 0, rel: 0, ms: 0, calls: 0, out: 0, inn: 0 };
        h.n! += 1;
        if (o === 'SUBMITTED') h.sub! += 1;
        else if (o === 'FAILED_RETRYABLE') h.fail! += 1;
        else h.rel! += 1;
        h.ms! += num(x['duration_ms']);
        h.calls! += num(u['modelCalls']);
        h.out! += num(u['networkBytesOut']);
        h.inn! += num(u['networkBytesIn']);
        hourly.set(hk, h);
        if (at >= S24) {
          const tk = `${m}|${x['workload_class']}`;
          const t = byType.get(tk) ?? { d: [], calls: [], o: {}, out: 0, inn: 0, dbMs: 0 };
          t.d.push(num(x['duration_ms']));
          t.calls.push(num(u['modelCalls']));
          t.o[o] = (t.o[o] ?? 0) + 1;
          t.out += num(u['networkBytesOut']);
          t.inn += num(u['networkBytesIn']);
          t.dbMs += num(u['dbMs']);
          byType.set(tk, t);
          if (o !== 'SUBMITTED') {
            const why = String(x['reason']).replace(/^model [^:]+: /, '').replace(/https?:\/\/\S+/g, 'URL').replace(/\d+/g, '#').slice(0, 90);
            const fk = `${m}|${o}|${why}`;
            fails.set(fk, (fails.get(fk) ?? 0) + 1);
          }
        }
      }
      return {
        rows48h: r.length,
        hourly: [...hourly.entries()].map(([k, v]) => ({ k, ...v })),
        byType24h: [...byType.entries()].map(([k, v]) => ({ k, outcomes: v.o, dur: stats(v.d), calls: stats(v.calls), bytesOut: v.out, bytesIn: v.inn, dbMs: v.dbMs })),
        failures24h: [...fails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
      };
    });

    /* ---------------- leases: true concurrency of the lane's workers ---------------- */
    await section('LEASES', async () => {
      const r = await rows(
        `SELECT l.claimed_at, l.ended_at, l.expires_at, l.outcome, k.name AS worker, w.work_type, w.created_at AS item_created, l.attempt_number
           FROM work_leases l JOIN workers k ON k.id = l.worker_id JOIN work_items w ON w.id = l.work_item_id
          WHERE k.name IN ('free-lane-a','free-lane-b') AND (l.claimed_at >= ? OR l.ended_at IS NULL)`,
        [S48],
      );
      const perHour = new Map<string, { busyMs: number; leases: number }>();
      const evts: { t: number; d: number; w: string }[] = [];
      const durs = new Map<string, number[]>();
      const waits = new Map<string, number[]>();
      const outcomes: Record<string, number> = {};
      for (const x of r) {
        const a = Date.parse(String(x['claimed_at']));
        const e = x['ended_at'] ? Date.parse(String(x['ended_at'])) : Math.min(NOW, Date.parse(String(x['expires_at'])));
        const w = String(x['worker']);
        const ok = `${w}|${x['outcome'] ?? 'OPEN'}`;
        outcomes[ok] = (outcomes[ok] ?? 0) + 1;
        if (!(e > a)) continue;
        evts.push({ t: a, d: 1, w }, { t: e, d: -1, w });
        if (a >= NOW - 24 * H) {
          const dk = `${w}|${x['work_type']}`;
          durs.set(dk, [...(durs.get(dk) ?? []), e - a]);
          if (num(x['attempt_number']) === 1 && x['item_created']) waits.set(dk, [...(waits.get(dk) ?? []), a - Date.parse(String(x['item_created']))]);
        }
        for (let h = Math.floor(a / H) * H; h < e; h += H) {
          const ov = Math.min(e, h + H) - Math.max(a, h);
          const k = `${iso(h).slice(0, 13)}|${w}`;
          const p = perHour.get(k) ?? { busyMs: 0, leases: 0 };
          p.busyMs += ov;
          if (a >= h && a < h + H) p.leases += 1;
          perHour.set(k, p);
        }
      }
      evts.sort((x, y) => x.t - y.t || x.d - y.d);
      const cur: Record<string, number> = {};
      const peak = new Map<string, number>();
      for (const ev of evts) {
        cur[ev.w] = (cur[ev.w] ?? 0) + ev.d;
        const all = Object.values(cur).reduce((s, v) => s + v, 0);
        const k = iso(Math.floor(ev.t / H) * H).slice(0, 13);
        peak.set(`${k}|${ev.w}`, Math.max(peak.get(`${k}|${ev.w}`) ?? 0, cur[ev.w]!));
        peak.set(`${k}|ALL`, Math.max(peak.get(`${k}|ALL`) ?? 0, all));
      }
      return {
        leases: r.length,
        outcomes,
        hourly: [...perHour.entries()].sort().map(([k, v]) => ({ k, meanConc: Math.round((v.busyMs / H) * 100) / 100, started: v.leases, peak: peak.get(k) ?? 0, peakAll: peak.get(`${k.split('|')[0]}|ALL`) ?? 0 })),
        leaseMs24h: [...durs.entries()].map(([k, v]) => ({ k, ...stats(v) })),
        firstClaimWaitMs24h: [...waits.entries()].map(([k, v]) => ({ k, ...stats(v) })),
      };
    });

    /* ---------------- accepted claims attributed to lane items ---------------- */
    await section('LANE_CLAIMS_HOURLY', async () => {
      const r = await rows(
        `SELECT substr(e.at, 1, 13) AS h, e.reason AS r, e.workload_class AS wt,
                COUNT(DISTINCT c.id) AS claims, COUNT(DISTINCT CASE WHEN c.accepted = 1 THEN c.id END) AS accepted
           FROM bin_events e
           JOIN idempotency_operations o ON o.work_item_id = e.work_item_id AND o.state = 'SUCCEEDED' AND o.namespace LIKE 'research.%' AND o.result_ref IS NOT NULL
           JOIN research_claims c ON c.pass_id = o.result_ref
          WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ?
          GROUP BY substr(e.at, 1, 13), e.reason, e.workload_class`,
        [S48],
      );
      return r.map((x) => ({ h: x['h'], m: modelOf(x['r']), wt: x['wt'], claims: num(x['claims']), accepted: num(x['accepted']) }));
    });
    await section('ALL_CLAIMS_HOURLY', () =>
      rows(`SELECT substr(created_at, 1, 13) AS h, COUNT(*) AS n, SUM(accepted) AS accepted, SUM(sourced) AS sourced FROM research_claims WHERE created_at >= ? GROUP BY substr(created_at, 1, 13) ORDER BY h`, [S48]));
    await section('CLAIM_REJECTIONS_24H', () =>
      rows(`SELECT substr(COALESCE(rejection_reason, validation_state), 1, 60) AS why, COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND accepted = 0 GROUP BY substr(COALESCE(rejection_reason, validation_state), 1, 60) ORDER BY n DESC LIMIT 15`, [S24]));

    /* ---------------- queue ---------------- */
    await section('QUEUE_NOW', async () => {
      const { waitingNow } = await import('../server/services/freeLane/capacity.ts');
      const byState = await rows(`SELECT work_type, state, COUNT(*) AS n FROM work_items WHERE work_type IN ${RESEARCH_TYPES} AND state IN ('QUEUED','LEASED') GROUP BY work_type, state`);
      const claimable = await rows(`SELECT work_type, COUNT(*) AS n FROM work_items WHERE work_type IN ${RESEARCH_TYPES} AND state = 'QUEUED' AND available_at <= ? AND attempt_count < max_attempts GROUP BY work_type`, [iso(NOW)]);
      const exhausted = await rows(`SELECT COUNT(*) AS n FROM work_items WHERE work_type IN ${RESEARCH_TYPES} AND state = 'QUEUED' AND attempt_count >= max_attempts`);
      const leasedBy = await rows(`SELECT k.name, COUNT(*) AS n FROM work_items w JOIN workers k ON k.id = w.worker_id WHERE w.state = 'LEASED' AND w.work_type IN ${RESEARCH_TYPES} GROUP BY k.name`);
      return { waitingNow: await waitingNow(), commercialOnly: await waitingNow({ includeImprovement: false }), byState, claimable, exhausted, leasedBy };
    });
    await section('WORK_24H', async () => {
      const r = await rows(
        `SELECT w.work_type, w.state, w.attempt_count, w.failure_category, w.created_at, w.completed_at, b.purpose
           FROM work_items w LEFT JOIN bins b ON b.id = w.bin_id
          WHERE w.work_type IN ${RESEARCH_TYPES} AND w.created_at >= ?`,
        [S24],
      );
      const agg = new Map<string, { n: number; st: Record<string, number>; att: number[]; svc: number[] }>();
      for (const x of r) {
        const k = `${x['work_type']}|${x['purpose'] ?? 'NO_BIN'}`;
        const a = agg.get(k) ?? { n: 0, st: {}, att: [], svc: [] };
        a.n += 1;
        const s = `${x['state']}${x['failure_category'] ? `:${x['failure_category']}` : ''}`;
        a.st[s] = (a.st[s] ?? 0) + 1;
        a.att.push(num(x['attempt_count']));
        if (x['completed_at']) a.svc.push(Date.parse(String(x['completed_at'])) - Date.parse(String(x['created_at'])));
        agg.set(k, a);
      }
      return [...agg.entries()].map(([k, v]) => ({ k, n: v.n, states: v.st, attempts: stats(v.att), createdToDoneMs: stats(v.svc) }));
    });
    await section('ARRIVALS_HOURLY', () =>
      rows(`SELECT substr(created_at, 1, 13) AS h, work_type, COUNT(*) AS n FROM work_items WHERE work_type IN ${RESEARCH_TYPES} AND created_at >= ? GROUP BY substr(created_at, 1, 13), work_type ORDER BY h`, [S48]));
    await section('RESEARCH_LEASES_BY_WORKER_24H', () =>
      rows(`SELECT k.name, w.work_type, COUNT(*) AS n FROM work_leases l JOIN workers k ON k.id = l.worker_id JOIN work_items w ON w.id = l.work_item_id WHERE l.claimed_at >= ? AND w.work_type IN ${RESEARCH_TYPES} GROUP BY k.name, w.work_type ORDER BY n DESC LIMIT 30`, [S24]));

    /* ---------------- GPU pod: hardware, price, spend ---------------- */
    await section('RUNPOD_OUTCOMES_7D', () => rows(`SELECT outcome, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM bin_events WHERE event_type = 'RUNPOD_POD' AND at >= ? GROUP BY outcome ORDER BY n DESC`, [S7D]));
    await section('RUNPOD_ACTIONS_7D', async () => {
      const r = await rows(`SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome NOT LIKE 'SAMPLE_%' AND at >= ? ORDER BY at DESC LIMIT 40`, [S7D]);
      return r.map((x) => {
        const m = parse(x['measures']);
        delete m['url'];
        return { at: x['at'], o: x['outcome'], r: String(x['reason']).slice(0, 240), m };
      });
    });
    await section('RUNPOD_SAMPLES_LATEST', async () => {
      const r = await rows(`SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' ORDER BY at DESC LIMIT 6`);
      return r.map((x) => ({ at: x['at'], o: x['outcome'], r: String(x['reason']).slice(0, 160), m: parse(x['measures']) }));
    });
    await section('RUNPOD_SAMPLES_HOURLY', async () => {
      const r = await rows(`SELECT at, outcome, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' AND at >= ? ORDER BY at`, [S48]);
      const hr = new Map<string, { n: number; running: number; ready: number; cost: number[]; waiting: number; inFlight: number; pods: Set<string> }>();
      for (const x of r) {
        const m = parse(x['measures']);
        const k = String(x['at']).slice(0, 13);
        const h = hr.get(k) ?? { n: 0, running: 0, ready: 0, cost: [], waiting: 0, inFlight: 0, pods: new Set<string>() };
        h.n += 1;
        if (x['outcome'] === 'SAMPLE_RUNNING') h.running += 1;
        if (m['ready'] === true) h.ready += 1;
        if (m['costPerHr'] !== undefined && m['costPerHr'] !== null) h.cost.push(Number(m['costPerHr']));
        h.waiting += num(m['waiting']);
        h.inFlight += num(m['inFlight']);
        if (m['podId']) h.pods.add(String(m['podId']));
        hr.set(k, h);
      }
      return [...hr.entries()].map(([k, v]) => ({ h: k, n: v.n, running: v.running, ready: v.ready, cost: [...new Set(v.cost)], meanWaiting: Math.round((v.waiting / v.n) * 10) / 10, meanInFlight: Math.round((v.inFlight / v.n) * 10) / 10, pods: [...v.pods] }));
    });
    await section('RUNPOD_SPEND', async () => {
      const pod = await import('../server/services/cheap/runpodPod.ts');
      const res: Record<string, unknown> = {};
      for (const [label, since] of [['h6', S6], ['h24', S24], ['h48', S48], ['d7', S7D]] as const) {
        const prior = iso(Date.parse(since) - 24 * H);
        const rowsFor = await pod.readPodRows(prior);
        res[label] = { window: pod.windowSpendFromRows(rowsFor, { since: Date.parse(since), now: NOW, live: null }), sampled: await pod.readPodSpend(since) };
      }
      return res;
    });

    /* ---------------- research grants and missions ---------------- */
    await section('GRANTS', async () => {
      const goals = await rows(`SELECT id, project_id, name, max_concurrent, max_missions, max_fragments, allowed_work, expires_at, state FROM russell_goals WHERE state = 'ACTIVE'`);
      const held = await rows(`SELECT goal_id, kind, COUNT(*) AS n, SUM(amount) AS amt FROM russell_budget_reservations WHERE state = 'HELD' AND expires_at > ? GROUP BY goal_id, kind`, [iso(NOW)]);
      return goals.map((g) => ({
        id: g['id'], project: g['project_id'], name: String(g['name']).slice(0, 60), maxConcurrent: g['max_concurrent'], maxMissions: g['max_missions'], maxFragments: g['max_fragments'],
        research: String(g['allowed_work']).includes('RESEARCH'), expires: g['expires_at'],
        held: held.filter((h) => h['goal_id'] === g['id']).map((h) => `${h['kind']}:${h['n']}/${h['amt']}`),
      }));
    });
    await section('LAUNCHABLE_BY_PROJECT', async () => {
      const { launchableByProject } = await import('../server/services/russell/loop.ts');
      return launchableByProject();
    });
    await section('MISSIONS_BY_STATE', () => rows(`SELECT state, COUNT(*) AS n FROM russell_missions GROUP BY state`));
    await section('MISSIONS_HOURLY', async () => {
      const made = await rows(`SELECT substr(created_at, 1, 13) AS h, COUNT(*) AS n FROM russell_missions WHERE created_at >= ? GROUP BY substr(created_at, 1, 13) ORDER BY h`, [S48]);
      const done = await rows(`SELECT substr(completed_at, 1, 13) AS h, state, COUNT(*) AS n FROM russell_missions WHERE completed_at >= ? GROUP BY substr(completed_at, 1, 13), state ORDER BY h`, [S48]);
      return { made, done };
    });
    await section('MISSION_DURATIONS_48H', async () => {
      const r = await rows(`SELECT state, created_at, completed_at FROM russell_missions WHERE completed_at >= ?`, [S48]);
      const by = new Map<string, number[]>();
      for (const x of r) by.set(String(x['state']), [...(by.get(String(x['state'])) ?? []), Date.parse(String(x['completed_at'])) - Date.parse(String(x['created_at']))]);
      const live = await rows(`SELECT state, created_at FROM russell_missions WHERE state IN ('PLANNED','LAUNCHING','RUNNING','WAITING','NEEDS_HUMAN')`);
      const ages = new Map<string, number[]>();
      for (const x of live) ages.set(String(x['state']), [...(ages.get(String(x['state'])) ?? []), NOW - Date.parse(String(x['created_at']))]);
      return { completed: [...by.entries()].map(([k, v]) => ({ k, ...stats(v) })), liveAges: [...ages.entries()].map(([k, v]) => ({ k, ...stats(v) })) };
    });
    await section('CANDIDATES_BY_STATE', () => rows(`SELECT state, COUNT(*) AS n FROM russell_candidates GROUP BY state`));
    await section('ORCH_48H', async () => {
      const st = await rows(`SELECT status, COUNT(*) AS n FROM research_orchestrations WHERE created_at >= ? GROUP BY status`, [S48]);
      const done = await rows(`SELECT substr(completed_at, 1, 13) AS h, COUNT(*) AS n FROM research_orchestrations WHERE completed_at >= ? GROUP BY substr(completed_at, 1, 13) ORDER BY h`, [S48]);
      return { st, done };
    });
    await section('FRAGMENTS_48H', async () => {
      const st = await rows(`SELECT status, COUNT(*) AS n FROM research_fragments WHERE queued_at >= ? GROUP BY status`, [S48]);
      const done = await rows(`SELECT substr(completed_at, 1, 13) AS h, status, COUNT(*) AS n FROM research_fragments WHERE completed_at >= ? GROUP BY substr(completed_at, 1, 13), status ORDER BY h`, [S48]);
      const r = await rows(`SELECT queued_at, started_at, completed_at FROM research_fragments WHERE completed_at >= ?`, [S24]);
      const wait = r.filter((x) => x['started_at']).map((x) => Date.parse(String(x['started_at'])) - Date.parse(String(x['queued_at'])));
      const svc = r.filter((x) => x['started_at']).map((x) => Date.parse(String(x['completed_at'])) - Date.parse(String(x['started_at'])));
      return { st, done, wait24h: stats(wait), service24h: stats(svc) };
    });
    await section('PLAN_READINGS_HOURLY', () => rows(`SELECT substr(created_at, 1, 13) AS h, verdict, COUNT(*) AS n FROM goal_plan_readings WHERE created_at >= ? GROUP BY substr(created_at, 1, 13), verdict ORDER BY h`, [S48]));
    await section('PATH_EVIDENCE_HOURLY', () => rows(`SELECT substr(created_at, 1, 13) AS h, kind, COUNT(*) AS n FROM monetization_path_facts WHERE created_at >= ? GROUP BY substr(created_at, 1, 13), kind ORDER BY h`, [S48]));
    await section('ALLOCATION_DECISION', async () => {
      const { latestResearchDecision } = await import('../server/services/goals/tick.ts');
      const d = await latestResearchDecision();
      return d ? { at: d.at, capacity: d.detail['capacity'], fingerprint: d.detail['fingerprint'] } : null;
    });
    await section('PRESSURE_PROBE_PROCESS', async () => {
      const { databasePressure } = await import('../server/db/pressure.ts');
      return databasePressure();
    });

    console.log('CENSUS: OK');
    console.log('GOALS: OK');
  } finally {
    await closeDatabase();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
