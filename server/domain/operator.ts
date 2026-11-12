/**
 * The operator's pure rules (§106): when a person-request is moot, what the
 * operator is told each run, which model it thinks with, and when it runs.
 *
 * The operator is Hermes Agent (Nous Research, MIT) — chosen over OpenClaw,
 * Goose, OpenHands and Letta for the reasons §106 records — running on a
 * private app with no credential of its own. Brain starts each run, mints the
 * run's credential, sends its memory, and stores what comes back. Nothing in
 * this file performs an effect.
 */

/** Cards that are not about a research mission; the moot rule never touches them. */
const NOT_ABOUT_A_MISSION = ['capability-authority:', 'cash-reconsider:'];

export interface MootReading {
  missionId: string | null;
  missionState: string | null;
  packetStatus: string | null;
  /** True when nobody can act on this card any more, because its mission is no longer waiting on it. */
  moot: boolean;
  why: string;
}

/**
 * Is an open person-request moot?
 *
 * A research park's card asks how to resume a mission that stopped at
 * NEEDS_HUMAN. Every answer to it begins by moving that mission from
 * NEEDS_HUMAN back to RUNNING (`needsHuman.ts`), so once the mission is in any
 * other state no answer can ever apply: answering it only reopens it.
 */
export function moot(input: {
  resumeKey: string;
  missionId: string | null;
  missionState: string | null;
  packetStatus: string | null;
}): MootReading {
  const base = { missionId: input.missionId, missionState: input.missionState, packetStatus: input.packetStatus };
  if (NOT_ABOUT_A_MISSION.some((prefix) => input.resumeKey.startsWith(prefix))) {
    return { ...base, moot: false, why: 'the card is not about a research mission' };
  }
  if (!input.missionId) return { ...base, moot: false, why: 'the card names no mission' };
  if (input.missionState === null) return { ...base, moot: false, why: 'the mission could not be read' };
  if (input.missionState === 'NEEDS_HUMAN') {
    return { ...base, moot: false, why: 'the mission is still waiting on this card' };
  }
  return {
    ...base,
    moot: true,
    why:
      `its mission is ${input.missionState}, not NEEDS_HUMAN, so no answer can apply — every answer starts by ` +
      `moving the mission out of NEEDS_HUMAN, and answering it only reopens it` +
      (input.packetStatus ? ` (packet ${input.packetStatus})` : ''),
  };
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/** Default minutes between runs. One run directs every goal. */
export const OPERATOR_INTERVAL_MINUTES = 60;
/** A run that has not reported back after this long is finished as FAILED so the next can start. */
export const OPERATOR_RUN_TIMEOUT_MINUTES = 45;
/** Bounds on one run, passed to Hermes. */
export const OPERATOR_MAX_TURNS = 40;
export const OPERATOR_RUN_BUDGET_SECONDS = 20 * 60;

export function operatorIntervalMinutes(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['BRAIN_OPERATOR_INTERVAL_MINUTES']);
  return Number.isFinite(raw) && raw >= 10 ? Math.trunc(raw) : OPERATOR_INTERVAL_MINUTES;
}

/**
 * No run in the first minutes after this process started. Production,
 * 2026-11-12 (Deploy 43170557687): the first run began a minute after a
 * deploy's restart, every Brain tool call it made timed out while the machine
 * was being verified, and the post-restart verification was itself too slow.
 */
export const OPERATOR_BOOT_GRACE_MINUTES = 12;

/** The least time after a run starts before an engineering outcome it has not seen starts the next one. */
export const OPERATOR_OUTCOME_WAKE_MINUTES = 10;

/** A run that ended before it could act (a busy model, an unreachable door) is retried sooner. */
export const OPERATOR_RETRY_MINUTES = 15;

export function operatorDue(input: {
  lastStartedAt: string | null;
  running: boolean;
  nowMs: number;
  intervalMinutes: number;
  processStartedMs?: number;
  /** The last run failed without one successful Brain tool call. */
  lastActedNothing?: boolean;
  /** Factory delivered, failed or blocked engineering the operator commissioned since its last run (§109). */
  outcomeWaiting?: boolean;
}): boolean {
  if (input.running) return false;
  if (input.processStartedMs !== undefined && input.nowMs - input.processStartedMs < OPERATOR_BOOT_GRACE_MINUTES * 60_000) return false;
  if (!input.lastStartedAt) return true;
  // A result the operator has not seen continues it within minutes, not at the next hour (§109).
  if (input.outcomeWaiting && input.nowMs - Date.parse(input.lastStartedAt) >= OPERATOR_OUTCOME_WAKE_MINUTES * 60_000) return true;
  const interval = input.lastActedNothing ? Math.min(OPERATOR_RETRY_MINUTES, input.intervalMinutes) : input.intervalMinutes;
  return input.nowMs - Date.parse(input.lastStartedAt) >= interval * 60_000;
}

// ---------------------------------------------------------------------------
// The tools the operator is given
// ---------------------------------------------------------------------------

/**
 * Exactly these of Brain's MCP tools are offered to the agent (Hermes'
 * `mcp_servers.brain.tools.include`). The rest of the surface stays visible to
 * Brain's workers and closed to the operator's prompt — a small model chooses
 * better among few tools, and none of the queue-claiming tools is its job.
 */
export const OPERATOR_TOOL_NAMES = [
  'brain_operator_goals',
  'brain_operator_goal',
  'brain_operator_goal_plan',
  'brain_operator_capacity',
  'brain_operator_integrations',
  'brain_operator_history',
  'brain_operator_withdraw_moot_request',
  'brain_operator_continue_idle',
  'brain_operator_submit_fix',
  'brain_operator_record_learning',
  'brain_operator_allocation',
  'brain_operator_decide',
  'brain_operator_verify',
  'brain_operator_set_goal_focus',
  // §109: the engineering director.
  'brain_operator_deficiencies',
  'brain_operator_commission',
  'brain_operator_engineering',
  'brain_operator_prioritize_engineering',
] as const;

/** Hermes' own toolsets the operator keeps: its memory, its skills and a task list. No shell, files, browser or web. */
export const OPERATOR_HERMES_TOOLSETS = ['memory', 'skills', 'todo'] as const;

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export function operatorBrief(input: { nowIso: string; runId: string; goals?: string; engineering?: string }): string {
  return [
    ...(input.goals ? [input.goals, ''] : []),
    ...(input.engineering ? [input.engineering, ''] : []),
    `You are Brain's operator (run ${input.runId}, ${input.nowIso}). Brain is a research-operations platform that`,
    'pursues goals — the first is collecting $10,000 of settled cash. You direct its work through the brain_operator_*',
    'tools. They are your only hands: do not describe actions, take them.',
    '',
    'Revenue is settled cash only: leads, forecasts, invoices and unpaid sales are not revenue. Never claim a',
    'probability of success the ledger has not shown.',
    '',
    'Each run, for every goal:',
    '1. The goals are listed above with their ids (brain_operator_goals returns the same list). Start with the first.',
    '2. brain_operator_goal {goal_id} — inspect what Brain already has: its blockers, open person-requests (each says',
    '   whether it is moot), linked work and the next action Brain itself recommends.',
    '   brain_operator_goal_plan {goal_id} — the quantitative plan: which strategy reaches the target, what fails, the next test.',
    '   brain_operator_integrations — which services Brain can use right now.',
    '3. brain_operator_history — what you did before and what you learned. Do not repeat a strategy that already failed.',
    '4. brain_operator_allocation — which goal the next unit of capacity is worth most to, and which is consuming',
    '   capacity for nothing. brain_operator_verify (no arguments) — your past decisions still owed a verdict: judge',
    '   each that is due with the evidence you just read, before deciding anything new.',
    '5. Decide, then act. Before any action that matters, brain_operator_decide: at least two genuinely different',
    '   options (change any variable — price, buyer segment, channel, deal structure, financing, timing, which goal gets',
    '   capacity — or do nothing), each with probability, value and cost (null when unknown), the assumptions, and a',
    '   prediction you can check later. If the challenger says REVISE, reconsider before standing by it. Every acting',
    '   tool below refuses without the decision_id it returns (one decision may cover a batch of the same action). Then act:',
    '   - a request marked moot=true holds the goal on a decision nobody can make: brain_operator_withdraw_moot_request.',
    '   - idle capacity beside waiting work: brain_operator_continue_idle.',
    '   - a goal consuming capacity with nothing to show (stance PAUSE) or a paused one worth restarting (RESTART):',
    '     brain_operator_set_goal_focus with the decision id.',
    '   - a software defect or a missing capability that keeps costing the goal (the same failure in the rows, every',
    '     run): brain_operator_submit_fix, with the evidence (row ids, verbatim reasons) and the files that own it.',
    '   - a deficiency in Brain itself (its reasoning, planning, strategy, allocation, a missing capability, a broken',
    '     integration, a slow algorithm, a recurring failure): brain_operator_deficiencies lists what the rows already',
    '     show, each with an id and the intervention Brain gives it. brain_operator_commission {deficiency_id} acts on',
    '     one — engineering goes to Factory at once with a priority and a worker class; the rest is a model, strategy,',
    '     evidence, capacity or person remedy, not code. You may also describe your own diagnosis to the same tool.',
    '   - brain_operator_engineering: what Factory did with what you commissioned — code changed, tests, merge, deploy,',
    '     the measured effect and the goal read again. A merged pull request is not the improvement; act on `next`',
    '     (NEW_ATTEMPT, CHANGE_STRATEGY, UNBLOCK). brain_operator_prioritize_engineering when what matters changed.',
    '6. After acting, ALWAYS brain_operator_goal again (and brain_operator_capacity) — observe the actual result. A run',
    '   that acts and does not look again has not finished. If nothing moved since your last run,',
    '   find the cause and change strategy rather than repeating it.',
    '7. Before your report, brain_operator_record_learning at least once — one lesson per thing you found, with its',
    '   evidence, so it is not rediscovered.',
    '   Save durable facts with your memory tool too.',
    '',
    'Limits you keep: you never spend money, contact anyone, approve a plan, or claim something was answered that was',
    'not. A tool that refuses tells you why — read it and choose differently. A decision only the owner can make',
    '(spending over a ceiling, legal risk, a login) is reported in your summary, not worked around.',
    '',
    'Never ask the owner to do what Brain or the next run can: if a tool keeps failing, say which and why in your report;',
    'Brain records it and starts you again on its own.',
    '',
    'End with a short report: per goal, what you found, what you did, what changed, and what you will do next run.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface OperatorModel {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  label: string;
  /** The window the endpoint actually serves; Hermes sizes its compression from it. */
  contextLength?: number | null;
}

/**
 * Order the operator's models by what they did (§108), not by a fixed list.
 *
 * Production, 2026-11-12: the switchboard was first and every run on it failed —
 * a free provider's per-minute token limit (HTTP 429), a window too small for
 * the operator's tools ("grown too large"). A model's score is its operator
 * runs that finished DONE, smoothed (Laplace) so one run is not a verdict, plus
 * the benchmark's tool score when there is one. Ties keep the given order.
 */
export function rankOperatorModels(
  models: OperatorModel[],
  record: Map<string, { runs: number; ok: number }>,
  benchmark: Map<string, number> = new Map(),
): OperatorModel[] {
  const score = (m: OperatorModel): number => {
    const r = record.get(m.label) ?? { runs: 0, ok: 0 };
    const runs = (r.ok + 1) / (r.runs + 2);
    const bench = benchmark.get(m.label);
    return bench === undefined ? runs : (runs + bench) / 2;
  };
  return models
    .map((m, i) => ({ m, i, s: score(m) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

/**
 * The switchboard route the benchmark measured best for the operator's tool loop
 * (§108, run 43285247214, 2026-11-12): `auto/best-coding` made 12 of 12 operator
 * tool calls correctly, recovered from "temporarily busy", and withdrew the moot
 * request; production's `brain-a` combo is one provider's gpt-oss-120b, whose
 * per-minute token limit failed whole runs (HTTP 429, opr_7af304c3).
 */
export const OPERATOR_FREE_ROUTE = 'auto/best-coding';

/**
 * Which model the operator thinks with: capacity Brain already has, never a
 * paid frontier API. The free-provider switchboard first (its free models are
 * larger than the GPU's, and Hermes needs a 64K window the GPU's 32K does not
 * give), the RunPod GPU last, each the next one's fallback.
 * `override` (BRAIN_OPERATOR_MODEL) names a different model on the switchboard.
 * The inputs are `laneConfig`'s free half and `runpodConfig`, read by the caller.
 */
export function operatorModels(input: {
  lane: { url: string; key: string | null; models: string[] } | null;
  pod: { url: string; key: string | null; model: string; contextLength?: number | null } | null;
  override?: string | null;
}): OperatorModel[] {
  const out: OperatorModel[] = [];
  // The switchboard's own names, `auto` included: OmniRoute routes `auto` to whichever free
  // provider is healthy, exactly as the free lane sends it.
  const named = (input.override ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const laneModels = named.length ? [...named, ...(input.lane?.models ?? [])] : (input.lane?.models ?? []);
  if (input.lane) {
    for (const model of [...new Set(laneModels.filter(Boolean))].slice(0, 2)) {
      // The switchboard's free providers cap a request near 64K; Hermes compresses to fit.
      out.push({ baseUrl: withV1(input.lane.url), model, apiKey: input.lane.key, label: `free:${model}`, contextLength: 65536 });
    }
  }
  if (input.pod) {
    out.push({ baseUrl: withV1(input.pod.url), model: input.pod.model, apiKey: input.pod.key, label: `gpu:${input.pod.model}`, contextLength: input.pod.contextLength ?? null });
  }
  return out;
}

function withV1(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
