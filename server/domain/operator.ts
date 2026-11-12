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
export const OPERATOR_RUN_TIMEOUT_MINUTES = 30;
/** Bounds on one run, passed to Hermes. */
export const OPERATOR_MAX_TURNS = 40;
export const OPERATOR_RUN_BUDGET_SECONDS = 20 * 60;

export function operatorIntervalMinutes(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['BRAIN_OPERATOR_INTERVAL_MINUTES']);
  return Number.isFinite(raw) && raw >= 10 ? Math.trunc(raw) : OPERATOR_INTERVAL_MINUTES;
}

export function operatorDue(input: { lastStartedAt: string | null; running: boolean; nowMs: number; intervalMinutes: number }): boolean {
  if (input.running) return false;
  if (!input.lastStartedAt) return true;
  return input.nowMs - Date.parse(input.lastStartedAt) >= input.intervalMinutes * 60_000;
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
  'brain_operator_capacity',
  'brain_operator_history',
  'brain_operator_withdraw_moot_request',
  'brain_operator_continue_idle',
  'brain_operator_submit_fix',
  'brain_operator_record_learning',
] as const;

/** Hermes' own toolsets the operator keeps: its memory, its skills and a task list. No shell, files, browser or web. */
export const OPERATOR_HERMES_TOOLSETS = ['memory', 'skills', 'todo'] as const;

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export function operatorBrief(input: { nowIso: string; runId: string }): string {
  return [
    `You are Brain's operator (run ${input.runId}, ${input.nowIso}). Brain is a research-operations platform that`,
    'pursues goals — the first is collecting $10,000 of settled cash. You direct its work through the brain_operator_*',
    'tools. They are your only hands: do not describe actions, take them.',
    '',
    'Each run, for every goal:',
    '1. brain_operator_goals — understand the desired result and its state. Start with the most urgent.',
    '2. brain_operator_goal {goal_id} — inspect what Brain already has: its blockers, open person-requests (each says',
    '   whether it is moot), linked work and the next action Brain itself recommends.',
    '3. brain_operator_history — what you did before and what you learned. Do not repeat a strategy that already failed.',
    '4. Act on what can be fixed now:',
    '   - a request marked moot=true holds the goal on a decision nobody can make: brain_operator_withdraw_moot_request.',
    '   - idle capacity beside waiting work: brain_operator_continue_idle.',
    '   - a software defect that keeps recurring (the same failure in the rows, every run): brain_operator_submit_fix,',
    '     with the evidence (row ids, verbatim reasons) and the files that own the behaviour.',
    '5. brain_operator_capacity and the goal again — monitor the actual result. If nothing moved since your last run,',
    '   find the cause and change strategy.',
    '6. brain_operator_record_learning — one lesson per thing you found, with its evidence, so it is not rediscovered.',
    '   Save durable facts with your memory tool too.',
    '',
    'Limits you keep: you never spend money, contact anyone, approve a plan, or claim something was answered that was',
    'not. A tool that refuses tells you why — read it and choose differently. A decision only the owner can make',
    '(spending over a ceiling, legal risk, a login) is reported in your summary, not worked around.',
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
}

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
  pod: { url: string; key: string | null; model: string } | null;
  override?: string | null;
}): OperatorModel[] {
  const out: OperatorModel[] = [];
  // The switchboard's own names, `auto` included: OmniRoute routes `auto` to whichever free
  // provider is healthy, exactly as the free lane sends it.
  const laneModels = input.override?.trim() ? [input.override.trim()] : (input.lane?.models ?? []);
  if (input.lane) {
    for (const model of laneModels.filter(Boolean).slice(0, 2)) {
      out.push({ baseUrl: withV1(input.lane.url), model, apiKey: input.lane.key, label: `free:${model}` });
    }
  }
  if (input.pod) {
    out.push({ baseUrl: withV1(input.pod.url), model: input.pod.model, apiKey: input.pod.key, label: `gpu:${input.pod.model}` });
  }
  return out;
}

function withV1(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
