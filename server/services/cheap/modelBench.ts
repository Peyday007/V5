/**
 * A model is chosen by what it does on Brain's own work (§108).
 *
 * Seven tasks, each built from production rows of 2026-11-12, each scored by
 * code rather than by another model's opinion:
 *
 *   diagnose        — the operator's real failed runs: name each cause and its fix;
 *   tool_plan       — the operator's real tools and real goal readings: read the goal,
 *                     read its plan, withdraw the moot request, report — no invented ids;
 *   tool_recovery   — the same loop when Brain answers "temporarily busy" and a call
 *                     is refused for a missing argument: retry, repair, never give up;
 *   opportunity     — a real opening card (no payer, no price) beside one with both;
 *   strategies      — the $10K plan's real competing reconstructions: which, and the test;
 *   assumption      — "p50 $131,700, so $10K is likely" against reach 1.5% (coverage);
 *   failed_exec     — the same claim refusal seven times: repair the method, do not retry.
 *
 * The goal, plan, run ids and refusal texts are production's; the request ids
 * and the opportunity task's second card are fixtures, named as such.
 *
 * Every endpoint is OpenAI-compatible (vLLM on RunPod, the free switchboard).
 * Nothing here touches the database: `recordBenchmark` in the repository does.
 */

export interface BenchEndpoint {
  label: string;
  /** OpenAI-compatible base ending in /v1. */
  url: string;
  key: string | null;
  model: string;
  /** What the endpoint costs per hour while it runs; null for the free switchboard. */
  usdPerHour: number | null;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  /** The raw argument text, kept when it is not JSON. */
  raw: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  ms: number;
  completionTokens: number;
  error: string | null;
}

export type Message = Record<string, unknown>;
export type ChatFn = (messages: Message[], tools?: unknown[], maxTokens?: number) => Promise<ChatResult>;

export interface TaskScore {
  task: string;
  /** 0..1, decided by code. */
  score: number;
  /** Tool calls made and how many of them were well-formed and correct. */
  toolCalls: number;
  toolOk: number;
  ms: number;
  completionTokens: number;
  error: string | null;
  notes: string[];
}

/** One chat call; never throws. */
export function chatFor(endpoint: BenchEndpoint, fetchImpl: typeof fetch = fetch, timeoutMs = 240_000): ChatFn {
  return async (messages, tools, maxTokens = 4096) => {
    const started = Date.now();
    try {
      const res = await fetchImpl(`${endpoint.url.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(endpoint.key ? { authorization: `Bearer ${endpoint.key}` } : {}) },
        body: JSON.stringify({
          model: endpoint.model,
          messages,
          temperature: 0.3,
          max_tokens: maxTokens,
          ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const ms = Date.now() - started;
      if (!res.ok) return { content: '', toolCalls: [], ms, completionTokens: 0, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
      const body = JSON.parse(text) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: { completion_tokens?: number };
      };
      const message = body.choices?.[0]?.message ?? {};
      const toolCalls = (message.tool_calls ?? []).map((call, i) => {
        const raw = call.function?.arguments ?? '';
        let args: Record<string, unknown> | null = null;
        try {
          const parsed = raw.trim() ? JSON.parse(raw) : {};
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        } catch {
          args = null;
        }
        return { id: call.id ?? `call_${i}`, name: call.function?.name ?? '', args, raw };
      });
      return { content: stripThink(message.content ?? ''), toolCalls, ms, completionTokens: body.usage?.completion_tokens ?? 0, error: null };
    } catch (error) {
      return { content: '', toolCalls: [], ms: Date.now() - started, completionTokens: 0, error: (error as Error).message.slice(0, 200) };
    }
  };
}

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

/** The first JSON object in a model's answer, tolerating fences and prose around it. */
export function firstJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const lower = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).toLowerCase();

// ---------------------------------------------------------------------------
// Fixtures: production readings of 2026-11-12, verbatim where it matters.
// ---------------------------------------------------------------------------

export const GOAL_ID = 'wst_7b4fcbb5f2384f31b6c3';
const SECOND_GOAL = 'wst_fb7ccabc29f9478a8bcc';
const MOOT_REQUEST = 'rhr_3c1f0b7a2e9d4c51a8f2';
const LIVE_REQUEST = 'rhr_9a04d2be71c34f6e90b1';

export const FIXTURE_GOALS = {
  readAt: '2026-11-12T18:35:21.439Z',
  total: 2,
  goals: [
    {
      id: GOAL_ID,
      title: 'Collect 10000 dollars of settled cash within 30 days using little up-front capital',
      state: 'BLOCKED',
      stateEvidence: 'CANDIDATE: russell_candidates.state = PARKED',
      target: 'settled cash: 0 USD of 10000 USD, 10000 USD to go, 27 day(s) left',
      waiting: 'PERSON: Deciding whether this project accepts a report with unresolved questions in it, rather than an answer.',
      next: '[PERSON] Brain recommends: the mission moved out of Needs You before the answer could be applied.',
      openDecisions: 3,
      blockers: 66,
    },
    {
      id: SECOND_GOAL,
      title: 'Establish, from published sources, what would somebody need to know before acting on this specific opening: "Depositphot',
      state: 'BLOCKED',
      stateEvidence: 'MISSION: russell_missions.state = FAILED',
      target: null,
      next: '[NOBODY] Something here is blocked and nothing recorded why.',
      openDecisions: 0,
      blockers: 0,
    },
  ],
};

const FIXTURE_GOAL_DETAIL = {
  id: GOAL_ID,
  state: 'BLOCKED',
  requests: [
    { id: MOOT_REQUEST, question: 'Accept a report with unresolved questions in it?', missionState: 'RUNNING', packetStatus: 'PARKED', moot: true, why: 'its mission is RUNNING, not NEEDS_HUMAN, so no answer can apply' },
    { id: LIVE_REQUEST, question: 'Approve spending up to $40 on a sample print run?', missionState: null, moot: false, why: 'the card is not about a research mission' },
  ],
  blockers: [{ code: 'NO_BUYER', remedy: 'research a reachable buyer and a dated sign of demand' }],
  next: 'withdraw moot requests; research buyer and price for the leading constructed arrangements',
};

const FIXTURE_PLAN = {
  goalId: GOAL_ID,
  verdict: 'NOT_VIABLE',
  remainingCents: 1000000,
  daysLeft: 27,
  reach: 0.0145,
  reachBasis: 'COVERAGE',
  settledP50: 131700,
  bestReachUsd: 3250,
  nextTest: 'Discover, construct and research openings that can reach the 10000 USD still needed — the openings held reach at most 3249 USD — and establish each one\'s buyer, price, fulfilment, costs and settlement.',
  causes: ['NO_BUYER', 'NO_SUPPORTED_PRICE', 'SETTLEMENT_UNKNOWN', 'NO_FULFILLER'],
};

export const OPERATOR_BENCH_TOOLS = [
  tool('brain_operator_goals', 'Every live goal: id, state, target progress, what it waits on, next action. Start here.', {}),
  tool('brain_operator_goal', 'Inspect one goal: blockers with remedies, open person-requests (each says whether it is moot), next action.', { goal_id: { type: 'string', description: 'The goal id (wst_...).' } }, ['goal_id']),
  tool('brain_operator_goal_plan', "A goal's quantitative plan: verdict, strategies, reach, the next test.", { goal_id: { type: 'string' } }, ['goal_id']),
  tool('brain_operator_capacity', "Brain's capacity pools and whether any is idle beside waiting work.", {}),
  tool('brain_operator_withdraw_moot_request', 'Withdraw a request marked moot=true (nobody can act on it any more). Refused for any other.', { request_id: { type: 'string', description: 'The request id (rhr_...).' } }, ['request_id']),
  tool('brain_operator_record_learning', 'Record one lesson with its evidence.', { goal_id: { type: 'string' }, lesson: { type: 'string' }, evidence: { type: 'string' } }, ['lesson', 'evidence']),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): unknown {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const VALID_GOALS = new Set([GOAL_ID, SECOND_GOAL]);
const VALID_REQUESTS = new Set([MOOT_REQUEST, LIVE_REQUEST]);

interface Sim {
  busyFirstGoalCall: boolean;
  goalCalls: number;
  log: string[];
  withdrewMoot: boolean;
  withdrewLive: boolean;
  readPlan: boolean;
  invented: string[];
  malformed: number;
  retriedAfterBusy: boolean;
  sawBusy: boolean;
}

/** Brain's answer to one tool call, as production gave it. */
function answer(sim: Sim, call: ToolCall): { ok: boolean; body: unknown } {
  if (call.args === null) {
    sim.malformed += 1;
    return { ok: false, body: { error: 'arguments were not a JSON object' } };
  }
  const goalId = typeof call.args['goal_id'] === 'string' ? call.args['goal_id'] : null;
  switch (call.name) {
    case 'brain_operator_goals':
      return { ok: true, body: FIXTURE_GOALS };
    case 'brain_operator_goal':
      if (!goalId) return { ok: false, body: { error: 'goal_id is required and must be a non-empty string.' } };
      if (!VALID_GOALS.has(goalId)) {
        sim.invented.push(goalId);
        return { ok: false, body: { error: 'No such resource, or it is not available to you.' } };
      }
      sim.goalCalls += 1;
      if (sim.busyFirstGoalCall && sim.goalCalls === 1) {
        sim.sawBusy = true;
        return { ok: false, body: { error: 'Brain is temporarily busy (its database did not answer in time). This is not an authorization problem and nothing was refused: send the same call again shortly. Reference req_J2OFCfXSmy9S.' } };
      }
      if (sim.sawBusy) sim.retriedAfterBusy = true;
      return { ok: true, body: goalId === GOAL_ID ? FIXTURE_GOAL_DETAIL : { id: goalId, state: 'BLOCKED', requests: [], blockers: [] } };
    case 'brain_operator_goal_plan':
      if (!goalId) return { ok: false, body: { error: 'goal_id is required and must be a non-empty string.' } };
      if (!VALID_GOALS.has(goalId)) {
        sim.invented.push(goalId);
        return { ok: false, body: { error: 'No such resource, or it is not available to you.' } };
      }
      if (goalId === GOAL_ID) sim.readPlan = true;
      return { ok: true, body: goalId === GOAL_ID ? FIXTURE_PLAN : { goalId, verdict: 'NONE' } };
    case 'brain_operator_capacity':
      return { ok: true, body: { pools: [{ pool: 'free lane', waiting: 14, running: 2, capacity: 12, idleBesideWork: false }] } };
    case 'brain_operator_withdraw_moot_request': {
      const id = String(call.args['request_id'] ?? '');
      if (!VALID_REQUESTS.has(id)) {
        sim.invented.push(id);
        return { ok: false, body: { error: 'No such resource, or it is not available to you.' } };
      }
      if (id === LIVE_REQUEST) {
        sim.withdrewLive = true;
        return { ok: false, body: { error: 'Refused: this request is not moot (the card is not about a research mission).' } };
      }
      sim.withdrewMoot = true;
      return { ok: true, body: { withdrawn: id } };
    }
    case 'brain_operator_record_learning':
      return { ok: true, body: { recorded: true } };
    default:
      sim.malformed += 1;
      return { ok: false, body: { error: `unknown tool ${call.name}` } };
  }
}

const OPERATOR_SYSTEM =
  "You are Brain's operator. Brain pursues goals; the first is collecting $10,000 of settled cash. You direct its work " +
  'only through the brain_operator_* tools — do not describe actions, take them. Use only ids that a tool returned or ' +
  'that are listed here; never invent one. A request marked moot=true holds a goal on a decision nobody can make: ' +
  'withdraw it. A tool that says Brain is temporarily busy should be called again. End with a short report.';

async function operatorLoop(chat: ChatFn, busy: boolean, maxTurns = 10): Promise<{ sim: Sim; result: TaskScore }> {
  const sim: Sim = { busyFirstGoalCall: busy, goalCalls: 0, log: [], withdrewMoot: false, withdrewLive: false, readPlan: false, invented: [], malformed: 0, retriedAfterBusy: false, sawBusy: false };
  const messages: Message[] = [
    { role: 'system', content: OPERATOR_SYSTEM },
    { role: 'user', content: `Live goals (ids exact): ${GOAL_ID} "Collect 10000 dollars of settled cash within 30 days" (BLOCKED, 3 open decisions); ${SECOND_GOAL} (BLOCKED). Direct this run.` },
  ];
  let ms = 0;
  let tokens = 0;
  let calls = 0;
  let ok = 0;
  let final = '';
  let error: string | null = null;
  let structured = true;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const r = await chat(messages, OPERATOR_BENCH_TOOLS, 4096);
    ms += r.ms;
    tokens += r.completionTokens;
    if (r.error) {
      error = r.error;
      break;
    }
    if (r.toolCalls.length === 0) {
      // A tool call written as text instead of a structured call is the 4B pod's failure.
      if (/brain_operator_\w+\s*[({]/.test(r.content) && turn === 0) structured = false;
      final = r.content;
      break;
    }
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })) });
    for (const call of r.toolCalls) {
      calls += 1;
      const a = answer(sim, call);
      const knownTool = OPERATOR_BENCH_TOOLS.some((t) => (t as { function: { name: string } }).function.name === call.name);
      if (call.args !== null && knownTool) ok += 1;
      sim.log.push(`${call.name}(${call.raw.slice(0, 80)}) → ${a.ok ? 'ok' : 'refused'}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(a.body) });
    }
  }
  return { sim, result: { task: busy ? 'tool_recovery' : 'tool_plan', score: 0, toolCalls: calls, toolOk: ok, ms, completionTokens: tokens, error, notes: [...sim.log, ...(structured ? [] : ['tool call written as text, not structured']), ...(final ? [`final: ${final.slice(0, 160)}`] : ['no final report'])] } };
}

export async function taskToolPlan(chat: ChatFn): Promise<TaskScore> {
  const { sim, result } = await operatorLoop(chat, false);
  const reported = result.notes.some((n) => n.startsWith('final:'));
  const parts = [
    result.toolCalls > 0 ? 1 : 0,
    result.toolCalls > 0 && result.toolOk === result.toolCalls && sim.malformed === 0 ? 1 : 0,
    sim.invented.length === 0 && result.toolCalls > 0 ? 1 : 0,
    sim.readPlan ? 1 : 0,
    sim.withdrewMoot ? 1 : 0,
    sim.withdrewMoot && !sim.withdrewLive ? 1 : 0,
    reported ? 1 : 0,
  ];
  if (sim.invented.length) result.notes.push(`invented ids: ${sim.invented.join(', ')}`);
  result.score = parts.reduce((a, b) => a + b, 0) / parts.length;
  return result;
}

export async function taskToolRecovery(chat: ChatFn): Promise<TaskScore> {
  const { sim, result } = await operatorLoop(chat, true);
  const reported = result.notes.some((n) => n.startsWith('final:'));
  const parts = [
    sim.sawBusy ? 1 : 0,
    sim.retriedAfterBusy ? 1 : 0,
    sim.invented.length === 0 && result.toolCalls > 0 ? 1 : 0,
    sim.withdrewMoot ? 1 : 0,
    reported ? 1 : 0,
  ];
  result.score = parts.reduce((a, b) => a + b, 0) / parts.length;
  return result;
}

/** A single-answer task: one prompt, one JSON object back, scored by `grade`. */
async function judged(chat: ChatFn, task: string, prompt: string, grade: (json: Record<string, unknown>) => { score: number; notes: string[] }): Promise<TaskScore> {
  const r = await chat(
    [
      { role: 'system', content: 'You are the analyst inside Brain, an autonomous business operator. Answer with exactly one JSON object and nothing else.' },
      { role: 'user', content: prompt },
    ],
    undefined,
    4096,
  );
  const json = r.error ? null : firstJson(r.content);
  const graded = json ? grade(json) : { score: 0, notes: [r.error ?? `no JSON object in: ${r.content.slice(0, 160)}`] };
  return { task, score: graded.score, toolCalls: 0, toolOk: 0, ms: r.ms, completionTokens: r.completionTokens, error: r.error, notes: graded.notes };
}

export function taskDiagnose(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    "Brain's operator agent (Hermes, an OpenAI-compatible tool-calling agent) failed these production runs on 2026-11-12.",
    'For each run give the root cause and the smallest fix.',
    '',
    'RUN opr_540994ddb2584c47acfe on gpu:Qwen/Qwen3-4B (vLLM, started with --max-model-len 32768 --enable-prefix-caching --max-num-seqs 16):',
    '  error  HTTP 400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
    'RUN opr_1184fee76339416d8db9 on free:brain-a:',
    "  error  This conversation (including attachments) has grown too large to send to brain-a, and Hermes couldn't shrink it enough automatically.",
    'RUN opr_8f2520b226c54077979d:',
    '  error  The database pool had no free connection within 10000ms: 8/8 connection(s) in use, 0 idle, 3 caller(s) waiting, ceiling 8.',
    'RUN opr_7af304c3d04d412cb9a4 on free:brain-a:',
    '  error  HTTP 429: All credentials for model openai/gpt-oss-120b are cooling down (reset after 24s)',
    '',
    'JSON: {"runs":[{"run":"opr_…","cause":"…","fix":"…"}]}',
  ].join('\n');
  return judged(chat, 'diagnose', prompt, (json) => {
    const runs = Array.isArray(json['runs']) ? (json['runs'] as Record<string, unknown>[]) : [];
    const about = (id: string) => runs.find((r) => lower(r['run']).includes(id)) ?? null;
    const notes: string[] = [];
    const check = (id: string, words: RegExp, what: string) => {
      const r = about(id);
      const hit = !!r && words.test(lower(r['cause']) + ' ' + lower(r['fix']));
      if (!hit) notes.push(`${id}: missed ${what}`);
      return hit ? 1 : 0;
    };
    const s =
      check('opr_540994', /tool.?call.?parser|enable.?auto.?tool.?choice/, 'the missing tool-call parser') +
      check('opr_1184', /context|window|token|max.?model.?len|compress|prompt size|too large/, 'the context window') +
      check('opr_8f25', /pool|connection/, 'the connection pool') +
      check('opr_7af3', /rate.?limit|429|cool|fallback|another (provider|model)|backup/, 'rate limit and a fallback');
    return { score: s / 4, notes };
  });
}

export function taskOpportunity(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    'Brain must collect $10,000 of settled cash in 27 days with little capital. Two opening cards from its research:',
    'A (cop_81fc41f4d287415a8600): "Electricity has the largest 2026 spend pool at roughly $90.8 billion." payer: none named · price: none shown · fulfilment: none named · settlement: unknown.',
    'B (a control case written for this test): a printed local-services card mailed to households; local businesses buy a slot at a published $250; 3 slots were paid last run; print and postage are paid only after slots sell; card payments settle in 7 days.',
    'For each decide PURSUE (act now), RESEARCH (one named fact is missing) or REJECT, name what is missing, and the next test.',
    'JSON: {"A":{"decision":"…","missing":["…"],"next_test":"…"},"B":{"decision":"…","missing":["…"],"next_test":"…"}}',
  ].join('\n');
  return judged(chat, 'opportunity', prompt, (json) => {
    const a = (json['A'] ?? {}) as Record<string, unknown>;
    const b = (json['B'] ?? {}) as Record<string, unknown>;
    const notes: string[] = [];
    const aDecision = lower(a['decision']);
    const aMissing = lower(a['missing']);
    const parts = [
      !aDecision.includes('pursue') ? 1 : 0,
      /payer|buyer|who (would )?pay|customer/.test(aMissing) ? 1 : 0,
      /price/.test(aMissing) ? 1 : 0,
      /pursue/.test(lower(b['decision'])) ? 1 : 0,
      lower(b['next_test']).length > 10 ? 1 : 0,
    ];
    if (aDecision.includes('pursue')) notes.push('pursued an opening with no payer and no price');
    if (!/pursue/.test(lower(b['decision']))) notes.push('did not pursue the evidenced opening');
    return { score: parts.reduce((x, y) => x + y, 0) / parts.length, notes };
  });
}

export function taskStrategies(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    "Brain's quant engine compared strategies for collecting $10,000 settled in 27 days (reach = share of simulated worlds that meet the target; basis COVERAGE = assumed inputs, not a calibrated probability):",
    'S1 "capacity: cold email pre-warmed at 375/day + acquisition + never wait for a buyer\'s money": reach 100.0%, and 1.5% when conversion rates are halved.',
    "S2 the previous plan: reach 48.0%, and 1.0% when conversion rates are halved.",
    'The required reply rate for S1 is 0.43%. No campaign of this offer has sent a single email yet; reply and close rates are not established.',
    'Which should Brain commit to now, what single variable dominates the outcome, how confident are you (0-1) that your choice actually meets the target, and what is the cheapest test that would most reduce the uncertainty before committing more?',
    'JSON: {"choice":"S1|S2|neither","dominant_variable":"…","confidence":0.0,"test":"…","why":"…"}',
  ].join('\n');
  return judged(chat, 'strategies', prompt, (json) => {
    const notes: string[] = [];
    const confidence = Number(json['confidence']);
    const parts = [
      /conver|reply|close|response/.test(lower(json['dominant_variable'])) ? 1 : 0,
      Number.isFinite(confidence) && confidence <= 0.6 ? 1 : 0,
      /send|campaign|email|test|pilot|batch|sample/.test(lower(json['test'])) ? 1 : 0,
      lower(json['choice']).length > 0 ? 1 : 0,
    ];
    if (!(Number.isFinite(confidence) && confidence <= 0.6)) notes.push(`overconfident: ${json['confidence']}`);
    return { score: parts.reduce((x, y) => x + y, 0) / parts.length, notes };
  });
}

export function taskAssumption(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    'A status note says: "The combined plan\'s p50 settled cash is $131,700, so the $10,000 goal is very likely to be met this month."',
    'The plan reading it cites: verdict NOT_VIABLE; best combination reaches the target in 1.5% of worlds, basis COVERAGE (coverage of assumed inputs, not a probability); price, days to usable cash, reply rate, close rate and direct cost are "not established" for every opening in it; Brain has fewer than 10 finished accepted plans to calibrate against; settled cash today: $0.',
    'Is the note sound? Name the flawed assumption precisely.',
    'JSON: {"flawed":true|false,"assumption":"…","correct_reading":"…"}',
  ].join('\n');
  return judged(chat, 'assumption', prompt, (json) => {
    const text = lower(json['assumption']) + ' ' + lower(json['correct_reading']);
    const parts = [
      json['flawed'] === true || lower(json['flawed']) === 'true' ? 1 : 0,
      /1\.5|reach|coverage|probab|calibrat|not established|assum/.test(text) ? 1 : 0,
      /median|p50|condition|inputs|not a probability|unknown|unestablished|not established/.test(text) ? 1 : 0,
    ];
    return { score: parts.reduce((x, y) => x + y, 0) / parts.length, notes: parts[0] ? [] : ['accepted the flawed note'] };
  });
}

export function taskFailedExecution(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    "In the last 6 hours Brain's research workers had these submissions refused (counts, verbatim):",
    '  7 × brain_submit_claims refused: claims[N]: labor_subject for a HUMAN_REQUIREMENT finding must be one of HUMAN_INTERVENTION, HUMAN_REVIEW…',
    '  4 × brain_submit_claims refused: claims[N]: a HUMAN_REQUIREMENT finding carries no figure, so labor_qualifier must be set',
    '  14 × model call failed [provider availability]: cheap lane HTTP 429',
    'Each refusal discards the fragment\'s other claims. For each failure family choose one response: RETRY_SAME, CHANGE_INPUT (the worker must send something different), SUBMIT_FIX (an engineering change to the prompt/validator/schema), REALLOCATE (move the work to other capacity) or ABANDON — and say why.',
    'JSON: {"families":[{"failure":"…","response":"…","why":"…"}]}',
  ].join('\n');
  return judged(chat, 'failed_exec', prompt, (json) => {
    const families = Array.isArray(json['families']) ? (json['families'] as Record<string, unknown>[]) : [];
    const pick = (re: RegExp) => families.find((f) => re.test(lower(f['failure'])));
    const labor = pick(/labor_subject|human_requirement|labor/);
    const rate = pick(/429|provider|availability|rate/);
    const notes: string[] = [];
    const laborResp = lower(labor?.['response']);
    const rateResp = lower(rate?.['response']);
    const parts = [
      laborResp.includes('submit_fix') ? 1 : laborResp.includes('change_input') ? 0.5 : 0,
      !laborResp.includes('retry_same') && labor ? 1 : 0,
      rateResp.includes('realloc') ? 1 : rateResp.includes('retry') ? 0.5 : 0,
    ];
    if (!labor) notes.push('did not address the repeated validator refusal');
    return { score: parts.reduce((x, y) => x + y, 0) / parts.length, notes };
  });
}

export const BENCH_TASKS: Record<string, (chat: ChatFn) => Promise<TaskScore>> = {
  diagnose: taskDiagnose,
  tool_plan: taskToolPlan,
  tool_recovery: taskToolRecovery,
  opportunity: taskOpportunity,
  strategies: taskStrategies,
  assumption: taskAssumption,
  failed_exec: taskFailedExecution,
};

export interface BenchSummary {
  label: string;
  model: string;
  usdPerHour: number | null;
  tasks: TaskScore[];
  /** Mean task score, 0..1. */
  quality: number;
  /** Share of tool calls that were well-formed and correct. */
  toolSuccess: number | null;
  medianMs: number;
  /** Answers per minute when `parallel` requests run at once. */
  parallel: { requests: number; ok: number; wallMs: number } | null;
  /** Dollars per completed task at the measured parallel throughput (null when free). */
  usdPerTask: number | null;
}

export function summarize(endpoint: BenchEndpoint, tasks: TaskScore[], parallel: BenchSummary['parallel']): BenchSummary {
  const quality = tasks.length ? tasks.reduce((a, t) => a + t.score, 0) / tasks.length : 0;
  const calls = tasks.reduce((a, t) => a + t.toolCalls, 0);
  const ok = tasks.reduce((a, t) => a + t.toolOk, 0);
  const sorted = tasks.map((t) => t.ms).sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  let usdPerTask: number | null = null;
  if (endpoint.usdPerHour !== null) {
    // At the measured parallel rate when there is one, else one stream's.
    const perHour = parallel && parallel.ok > 0 ? (parallel.ok / parallel.wallMs) * 3_600_000 : medianMs > 0 ? 3_600_000 / medianMs : 0;
    usdPerTask = perHour > 0 ? endpoint.usdPerHour / perHour : null;
  }
  return { label: endpoint.label, model: endpoint.model, usdPerHour: endpoint.usdPerHour, tasks, quality, toolSuccess: calls ? ok / calls : null, medianMs, parallel, usdPerTask };
}

/** Run every task `reps` times, then `parallel` copies of one judged task at once. */
export async function runBench(endpoint: BenchEndpoint, options: { reps?: number; parallel?: number; only?: string[]; fetchImpl?: typeof fetch } = {}): Promise<BenchSummary> {
  const chat = chatFor(endpoint, options.fetchImpl);
  const names = options.only?.length ? options.only : Object.keys(BENCH_TASKS);
  const tasks: TaskScore[] = [];
  for (let rep = 0; rep < (options.reps ?? 1); rep += 1) {
    for (const name of names) tasks.push(await BENCH_TASKS[name]!(chat));
  }
  let parallel: BenchSummary['parallel'] = null;
  if ((options.parallel ?? 0) > 1) {
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: options.parallel! }, () => taskOpportunity(chat)));
    parallel = { requests: options.parallel!, ok: results.filter((r) => !r.error).length, wallMs: Date.now() - started };
  }
  return summarize(endpoint, tasks, parallel);
}

/**
 * Which model wins, by measurement: tool tasks are a gate (an operator that
 * cannot call tools directs nothing), then quality per dollar among those
 * within `qualityTolerance` of the best. Free capacity counts as cost 0 but
 * loses ties to capacity Brain controls only when it is no worse.
 */
export function chooseModel(summaries: BenchSummary[], qualityTolerance = 0.05): { winner: BenchSummary | null; why: string } {
  const toolScore = (s: BenchSummary) => {
    const tool = s.tasks.filter((t) => t.task === 'tool_plan' || t.task === 'tool_recovery');
    return tool.length ? tool.reduce((a, t) => a + t.score, 0) / tool.length : 0;
  };
  const fit = summaries.filter((s) => toolScore(s) >= 0.7);
  if (fit.length === 0) return { winner: null, why: 'no candidate scored 0.7 or more on the operator tool tasks' };
  const best = Math.max(...fit.map((s) => s.quality));
  const near = fit.filter((s) => s.quality >= best - qualityTolerance);
  near.sort((a, b) => (a.usdPerTask ?? 0) - (b.usdPerTask ?? 0) || b.quality - a.quality);
  const winner = near[0]!;
  return {
    winner,
    why: `${winner.label}: quality ${winner.quality.toFixed(2)} (best ${best.toFixed(2)}), tool ${toolScore(winner).toFixed(2)}, ${winner.usdPerTask === null ? 'no hourly cost' : `$${winner.usdPerTask.toFixed(4)}/task`}, median ${Math.round(winner.medianMs / 1000)}s`,
  };
}
