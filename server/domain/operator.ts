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
  'brain_operator_create_goal',
  // §109: the engineering director.
  'brain_operator_deficiencies',
  'brain_operator_commission',
  'brain_operator_engineering',
  'brain_operator_prioritize_engineering',
  // Surge B: the findings register and the next attempt of a failed or stalled commission.
  'brain_operator_inventory',
  'brain_operator_reattempt',
  // §111: experiments that compare alternative fixes, and the evaluator's hidden cases.
  'brain_operator_experiments',
  'brain_operator_add_hidden_case',
] as const;

/** Hermes' own toolsets the operator keeps: its memory, its skills and a task list. No shell, files, browser or web. */
export const OPERATOR_HERMES_TOOLSETS = ['memory', 'skills', 'todo'] as const;

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * The brief. A standing mission (Surge B: a register row read every run while it is open)
 * comes first, with the inventory it directs; then the goals, then the engineering. The $10K
 * cash goal is one goal among the goals listed, not the operator's only objective.
 */
export function operatorBrief(input: { nowIso: string; runId: string; goals?: string; engineering?: string; mission?: string; inventory?: string }): string {
  const mission = input.mission?.trim();
  return [
    ...(mission
      ? [
          `STANDING MISSION (read every run until it is closed; it ranks with the goals below, and its work is done through the same tools):`,
          mission,
          '',
          'Keep the mission\'s findings in brain_operator_inventory: list them, upsert what you find, and set_status as each moves.',
          'Commission a finding\'s repair with brain_operator_commission; a stalled or failed commission gets brain_operator_reattempt.',
          'A finding is VERIFIED_FIXED only with a verification reference (a workflow run id, a deploy, or a measured outcome).',
          '',
        ]
      : []),
    ...(input.inventory ? [input.inventory, ''] : []),
    ...(input.goals ? [input.goals, ''] : []),
    ...(input.engineering ? [input.engineering, ''] : []),
    `You are Brain's operator (run ${input.runId}, ${input.nowIso}). Brain is a research-operations platform that`,
    'pursues the goals listed above (a cash goal — such as collecting $10,000 of settled cash — is one goal among them)',
    `${mission ? 'and the standing mission above' : 'and any standing mission it is given'}. You direct its work through the brain_operator_*`,
    'tools. They are your only hands: do not describe actions, take them.',
    '',
    'Revenue is settled cash only: leads, forecasts, invoices and unpaid sales are not revenue. Never claim a',
    'probability of success the ledger has not shown.',
    '',
    `ACT EARLY. A run has ${Math.round(OPERATOR_RUN_BUDGET_SECONDS / 60)} minutes, and reading alone has used all of them (production,`,
    '2026-11-24: run opr_e3f647309a354c49b3e0 made 13 read calls in 28 minutes and ended "exceeded its budget" with no',
    'decision). So: within your first five tool calls, take the top bottleneck the brief names (or the first entry of',
    'brain_operator_deficiencies), commit a decision on it with brain_operator_decide and act on it (commission, continue',
    'idle work, reattempt). Only then read further. brain_operator_goal_plan is the slowest read: call it at most once a',
    'run, and only after you have acted. If a call shows the run is past half its time, stop reading and act on what you have.',
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
    '   prediction you can check later. If the challenger says REVISE, reconsider before standing by it. A REVISE that',
    '   lists problems (a miscalibrated kind of decision) is never the end of the decision: add exactly the assumptions',
    '   its `next` names, each beginning with the prefix it gives (mechanism:, capacity:, condition:, execution:,',
    '   timing:, estimate:) and citing the row ids it asks for, and call brain_operator_decide again in this run until',
    '   it commits or refuses. Never end a run with an actionable problem you identified, an acting tool that covers it',
    '   and no committed decision: that run took no action. Every acting',
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
    '     An open inventory finding nobody owns is listed there as dfx_inv_<finding id>; commissioning it links the repair.',
    '     For ENGINEERING, propose at least two materially different approaches with a registered suite —',
    '     brain_operator_commission {deficiency_id, suite, approaches:[{label, approach_type, approach, owner_paths}]} — each',
    '     is built to its own pull request and an evaluator you cannot see releases only the winner.',
    '     brain_operator_experiments shows every verdict and which approach types have worked; brain_operator_add_hidden_case',
    '     adds a case only the evaluator reads, when production shows a failure the public cases miss.',
    '   - research you need answered: brain_operator_commission {research_question, goal_id?} (intervention EVIDENCE).',
    "     With goal_id it asks that goal's own search — a paused goal too, research only, never outreach or spend;",
    '     without, it opens method research about Brain. A paused goal refuses CAPACITY.',
    "   - a goal plan whose forecast.acceptance.status is ACCEPTED, or whose forecast.acceptance.verdict is",
    '     QUANTITATIVELY_CONSTRUCTED and Brain is executing it (brain_operator_goal_plan): evaluate and challenge it',
    '     before anything else — brain_operator_decide kind ADOPT_PLAN for that goal, options[0] = execute the accepted',
    '     plan as it stands, the others the strongest alternatives (another combination, keep constructing); attack its',
    '     assumptions, evidence, economics and timeline. Choose 0 only if it survives the challenge. Adopting an ACCEPTED',
    '     plan tells the owner it is ready; a constructed one is challenged because Brain executes it, and is never',
    '     reported as verified; execution and improvement continue afterwards.',
    '   - brain_operator_engineering: what Factory did with what you commissioned — code changed, tests, merge, deploy,',
    '     the measured effect and the goal read again. A merged pull request is not the improvement; act on `next`',
    '     (NEW_ATTEMPT, CHANGE_STRATEGY, UNBLOCK). brain_operator_prioritize_engineering when what matters changed;',
    '     brain_operator_reattempt {candidate_id, reason} when a commission failed or stalled (at most three attempts).',
    '   - brain_operator_inventory: the findings register — list, upsert a finding, set_status as it moves. A fix made',
    '     outside your commissions is verified there too, with its reference.',
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

// ---------------------------------------------------------------------------
// A standing mission and the inventory it directs (Surge B, H2-1/H2-2/H2-7)
// ---------------------------------------------------------------------------

/** The mission a run carries while it is open; its row is keyed by this in §87's register. */
export const DEFAULT_MISSION_KEY = 'SURGE:B';
export const MISSION_MAX_CHARS = 8000;
/** Inventory findings are keyed `SURGE-B:<issue id>` in the same register. */
export const INVENTORY_KEY_PREFIX = 'SURGE-B:';

export const INVENTORY_STATUSES = [
  'DISCOVERED',
  'UNDER_INVESTIGATION',
  'ROOT_CAUSE_CONFIRMED',
  'READY_FOR_REPAIR',
  'REPAIRING',
  'AWAITING_VERIFICATION',
  'VERIFIED_FIXED',
  'KNOWN_LIMITATION',
  'EXTERNAL_CONSTRAINT',
  'NOT_A_DEFECT',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

/** Statuses that close a finding: the brief stops listing it. */
export const INVENTORY_CLOSED: readonly InventoryStatus[] = ['VERIFIED_FIXED', 'KNOWN_LIMITATION', 'EXTERNAL_CONSTRAINT', 'NOT_A_DEFECT'];

export const INVENTORY_SEVERITIES = ['BLOCKING', 'MAJOR', 'MINOR'] as const;
export type InventorySeverity = (typeof INVENTORY_SEVERITIES)[number];

export const VERIFICATION_KINDS = ['WORKFLOW_RUN', 'DEPLOY', 'MEASUREMENT'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export interface InventoryVerification {
  kind: VerificationKind;
  /** A GitHub workflow run id, a deploy's run id or merge sha, or the measured metric's name. */
  ref: string;
  /** What was observed there, in production terms. */
  detail: string;
}

export interface InventoryItem {
  id: string;
  status: InventoryStatus;
  capability: string;
  symptom: string;
  evidence: string;
  rootCause: string | null;
  severity: InventorySeverity;
  owner: string | null;
  verificationCriteria: string | null;
  result: string | null;
  verification: InventoryVerification | null;
  /** Register rows (imp_…) the operator commissioned for this finding, if any. */
  linkedCandidates: string[];
  note: string | null;
}

export function inventoryKey(id: string): string | null {
  const trimmed = id.trim().replace(/^SURGE-B:/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(trimmed) ? `${INVENTORY_KEY_PREFIX}${trimmed}` : null;
}

/**
 * A verification is a reference somebody else can open, never a sentence: a workflow run id,
 * a deploy (run id or merge sha), or a measured outcome that states its number. Pure; null when valid.
 */
export function verificationRefusal(v: Partial<InventoryVerification> | null | undefined): string | null {
  if (!v || typeof v !== 'object') return 'VERIFIED_FIXED needs verification {kind, ref, detail}: a workflow run id, a deploy, or a measured outcome';
  if (!v.kind || !(VERIFICATION_KINDS as readonly string[]).includes(v.kind)) return `verification.kind must be one of ${VERIFICATION_KINDS.join(', ')}`;
  const ref = (v.ref ?? '').trim();
  const detail = (v.detail ?? '').trim();
  if (detail.length < 20) return 'verification.detail must say what was observed (20+ characters)';
  if (v.kind === 'WORKFLOW_RUN' && !/^\d{6,}$/.test(ref)) return 'verification.ref for WORKFLOW_RUN is the numeric GitHub Actions run id';
  if (v.kind === 'DEPLOY' && !/^(\d{6,}|[0-9a-f]{7,40})$/i.test(ref)) return 'verification.ref for DEPLOY is the Deploy run id or the released merge sha';
  if (v.kind === 'MEASUREMENT') {
    if (ref.length < 3) return 'verification.ref for MEASUREMENT names the metric or row it was read from';
    if (!/\d/.test(detail)) return 'a MEASUREMENT states the measured number';
  }
  return null;
}

/**
 * May a finding move to `status`? Pure: the refusal, or null. A fix is verified only with a
 * reference (H2-7); a confirmed root cause names one; a finding closed without a fix says why.
 */
export function inventoryTransitionRefusal(
  item: Pick<InventoryItem, 'rootCause' | 'verificationCriteria'>,
  status: string,
  input: { verification?: Partial<InventoryVerification> | null; note?: string | null },
): string | null {
  if (!(INVENTORY_STATUSES as readonly string[]).includes(status)) return `status must be one of ${INVENTORY_STATUSES.join(', ')}`;
  const s = status as InventoryStatus;
  if ((s === 'ROOT_CAUSE_CONFIRMED' || s === 'READY_FOR_REPAIR') && !(item.rootCause ?? '').trim()) return `${s} needs root_cause: what is confirmed to cause it`;
  if (s === 'VERIFIED_FIXED') {
    if (!(item.verificationCriteria ?? '').trim()) return "VERIFIED_FIXED needs the finding's verification_criteria first: what the verification must show";
    return verificationRefusal(input.verification);
  }
  if ((s === 'KNOWN_LIMITATION' || s === 'EXTERNAL_CONSTRAINT' || s === 'NOT_A_DEFECT') && (input.note ?? '').trim().length < 15) return `${s} needs a note saying why (15+ characters)`;
  return null;
}

/** The register's severity column for an inventory severity. */
export function registerSeverity(severity: InventorySeverity): 'HIGH' | 'MEDIUM' | 'LOW' {
  return severity === 'BLOCKING' ? 'HIGH' : severity === 'MAJOR' ? 'MEDIUM' : 'LOW';
}

/** The inventory as the brief states it: open findings, most severe first, bounded. */
export function inventoryForBrief(items: InventoryItem[], max = 25): string {
  if (items.length === 0) return '';
  const order: Record<InventorySeverity, number> = { BLOCKING: 0, MAJOR: 1, MINOR: 2 };
  const open = items.filter((i) => !INVENTORY_CLOSED.includes(i.status)).sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  const counts = INVENTORY_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length] as const).filter(([, n]) => n > 0);
  return [
    `INVENTORY (${items.length} finding(s): ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}). Open, most severe first:`,
    ...open.slice(0, max).map((i) => `- ${i.id} [${i.status}, ${i.severity}] ${i.capability}: ${i.symptom.slice(0, 160)}${i.owner ? ` (owner ${i.owner})` : ''}`),
    ...(open.length > max ? [`… and ${open.length - max} more (brain_operator_inventory {action: "list"}).`] : []),
  ].join('\n');
}
