/**
 * A model is chosen by what it does on Brain's own work (§108).
 *
 * Nine tasks, each built from production rows of 2026-11-12, each scored by
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
 * And five director-grade tasks (DIRECTOR_TASKS), each with seeded reworded
 * variants and scored only from a required JSON shape — off-shape scores 0:
 *
 *   root_cause_red_herring — 429s beside the real cause, an applied-migration checksum refusal;
 *   approach_choice        — extend the existing owner, not a duplicate mechanism or a rewrite;
 *   experiment_judgment    — 2 replies from 150 sends against 0.43%: inconclusive, and how many sends;
 *   infeasible_refusal     — a plan that commits more before revenue than the owner's ceiling;
 *   intervention_verify    — merged and deployed, the production metric unmoved: not verified.
 *
 * Their mean is `director`; the operator role requires it ≥ DIRECTOR_GATE when they ran.
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
  /** How many runs (repetitions × variants) the score is the mean of; set by `runBench`. */
  runs?: number;
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
          ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : { stream: true }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      /*
       * A turn without tools is streamed. A reasoning model can think for more
       * than 100 seconds before its first answer token, and the GPU pod's proxy
       * closes a connection idle that long: the reply then arrived as content ""
       * or HTTP 524 (production route asks, 2026-11-26: gpt-oss-120b failed 6 of
       * 12; the model exam's re-ask with streaming served every one). Streamed,
       * the reasoning keeps bytes flowing. An endpoint that answers with plain
       * JSON anyway is read as before.
       */
      if (res.ok && /text\/event-stream/i.test(res.headers.get('content-type') ?? '')) return readStream(res, started);
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

/** A streamed chat completion, read to its end: the answer's text and its token count. */
async function readStream(res: Response, started: number): Promise<ChatResult> {
  let content = '';
  let completionTokens = 0;
  let error: string | null = null;
  // A stream that ends without [DONE] or a finish reason was cut, and its answer is partial.
  let finished = false;
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body?.getReader();
    if (!reader) return { content: '', toolCalls: [], ms: Date.now() - started, completionTokens: 0, error: 'a streamed reply with no body' };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finished = true;
          continue;
        }
        if (!data) continue;
        try {
          const event = JSON.parse(data) as { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: { completion_tokens?: number }; error?: { message?: string } };
          if (event.choices?.[0]?.finish_reason) finished = true;
          if (event.error) error = String(event.error.message ?? 'stream error').slice(0, 200);
          content += event.choices?.[0]?.delta?.content ?? '';
          if (event.usage?.completion_tokens) completionTokens = event.usage.completion_tokens;
        } catch {
          /* a line that is not one JSON event is skipped */
        }
      }
    }
  } catch (caught) {
    error = (caught as Error).message.slice(0, 200);
  }
  if (!finished && !error) error = 'the stream ended before the answer did (no finish reason, no [DONE])';
  return { content: stripThink(content), toolCalls: [], ms: Date.now() - started, completionTokens, error: content.trim() && finished ? null : error };
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

/**
 * Long context: the operator reads a long history before it acts. ~35K tokens of
 * operator run records in production's own shape, one of which — and only one —
 * is the pool-exhaustion failure; the answer must name it and the run after it.
 */
export function taskLongContext(chat: ChatFn): Promise<TaskScore> {
  const lines: string[] = [];
  for (let i = 0; i < 520; i += 1) {
    const id = `opr_${(0x10000000 + i * 7919).toString(16)}${(0xabcdef + i * 31).toString(16)}`;
    const failures = [
      'HTTP 429: All credentials for model openai/gpt-oss-120b are cooling down (reset after 24s)',
      'MCP call timed out after 180.0s (configured timeout: 180.0s)',
      'This conversation (including attachments) has grown too large to send to brain-a',
      'HTTP 400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
    ];
    const line = i === 377
      ? `RUN ${id} FAILED 2026-11-0${1 + (i % 9)}T${String(i % 24).padStart(2, '0')}:00Z on free:brain-a · tools none · error The database pool had no free connection within 10000ms: 8/8 connection(s) in use, 0 idle, 3 caller(s) waiting, ceiling 8.`
      : `RUN ${id} ${i % 5 === 0 ? 'DONE' : 'FAILED'} 2026-11-0${1 + (i % 9)}T${String(i % 24).padStart(2, '0')}:00Z on free:brain-a · tools brain_operator_goal, brain_operator_capacity · ${i % 5 === 0 ? 'report: inspected 2 goals, nothing actionable' : `error ${failures[i % failures.length]}`}`;
    lines.push(line);
  }
  const target = lines[377]!.split(' ')[1]!;
  const after = lines[378]!.split(' ')[1]!;
  const prompt = [
    "Below are 520 of Brain's operator run records, oldest first.",
    ...lines,
    '',
    'Exactly one run failed because the database connection pool was exhausted. Which run, and which run id comes immediately after it?',
    'JSON: {"pool_run":"opr_…","next_run":"opr_…"}',
  ].join('\n');
  return judged(chat, 'long_context', prompt, (json) => {
    const parts = [String(json['pool_run'] ?? '').includes(target) ? 1 : 0, String(json['next_run'] ?? '').includes(after) ? 1 : 0];
    return { score: (parts[0]! + parts[1]!) / 2, notes: parts[0] ? [] : [`wanted ${target}, got ${String(json['pool_run']).slice(0, 40)}`] };
  });
}

/** Code: a real defect class from Brain's own record (CLAUDE.md conventions): SQL that passes SQLite and throws on Postgres. */
export function taskCode(chat: ChatFn): Promise<TaskScore> {
  const prompt = [
    'This TypeScript passes the SQLite test suite and throws on Postgres in production with',
    '"for SELECT DISTINCT, ORDER BY expressions must appear in select list":',
    '',
    "const rows = await db.all(`SELECT DISTINCT o.id, o.title FROM openings o JOIN signals s ON s.opening_id = o.id WHERE o.project_id = ? ORDER BY MAX(s.seen_at) DESC`, [projectId]);",
    '',
    'Give the root cause and the corrected SQL that behaves the same on both databases.',
    'JSON: {"cause":"…","sql":"…"}',
  ].join('\n');
  return judged(chat, 'code', prompt, (json) => {
    const sql = lower(json['sql']);
    const parts = [
      /group by/.test(sql) ? 1 : 0,
      /max\(s\.seen_at\)\s+as\s+\w+/.test(sql) && /order by\s+\w+/.test(sql) ? 1 : 0,
      /distinct|select list|aggregate|group/.test(lower(json['cause'])) ? 1 : 0,
    ];
    return { score: parts.reduce((a, b) => a + b, 0) / parts.length, notes: parts[1] ? [] : ['did not name the aggregate and order by its alias'] };
  });
}

// ---------------------------------------------------------------------------
// Director-grade tasks.
//
// The nine tasks above could not separate a 4B model from a frontier one: a 4B
// scored 1.0 on strategies and assumption, because a keyword in the right field
// was enough. These five ask for a judgment a director makes, and each is scored
// only from a required JSON shape — enumerated choices, ids the prompt issued,
// booleans and numbers. An answer off that shape scores 0; a prose field is read
// only after the structured answer is right, so keywords alone never score.
// Each task has reworded variants (other numbers, names and option order, the
// same logic) chosen by a seed, so a model tuned to one prompt does not pass.
// ---------------------------------------------------------------------------

type Field = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'object|null' | readonly string[];

/** Why `json` is off the required shape, or null when it is on it. Enum values must match exactly. */
export function offShape(json: Record<string, unknown>, spec: Record<string, Field>): string | null {
  for (const [key, want] of Object.entries(spec)) {
    const v = json[key];
    if (Array.isArray(want)) {
      if (typeof v !== 'string' || !want.includes(v.trim())) return `${key} must be one of ${want.join('|')}`;
      continue;
    }
    const ok =
      want === 'string' ? typeof v === 'string'
      : want === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : want === 'boolean' ? typeof v === 'boolean'
      : want === 'array' ? Array.isArray(v)
      : want === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v)
      : v === null || (!!v && typeof v === 'object' && !Array.isArray(v));
    if (!ok) return `${key} must be ${want}`;
  }
  return null;
}

const OFF = (why: string) => ({ score: 0, notes: [`off-shape: ${why}`] });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A small deterministic generator (mulberry32), so a seed always yields the same prompt. */
function rngFor(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = rngFor(seed + 1);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Which variant a seed names, and which round of it (the round reorders options). */
function pick<T>(variants: readonly T[], seed: number): { v: T; round: number } {
  const n = variants.length;
  const s = Math.max(0, Math.floor(seed));
  return { v: variants[s % n]!, round: Math.floor(s / n) };
}

// 1. root_cause_red_herring ---------------------------------------------------

interface RedHerringVariant {
  release: string; file: string; column: string; applied: string; now: string; limit: number;
  healthy: string; failing: string; at: string; route: string; before: number; after: number;
}

const RED_HERRING: readonly RedHerringVariant[] = [
  { release: 'v412', file: '047_signal_index.sql', column: 'signals.weight REAL', applied: '9f2c41d0', now: '31ab77e2', limit: 120, healthy: 'web.1', failing: 'web.2', at: '2026-11-14T03:12', route: '/api/work/claim', before: 2, after: 4 },
  { release: 'v588', file: '063_offer_prices.sql', column: 'offers.currency TEXT', applied: '0d7e9a13', now: 'c4458f0b', limit: 300, healthy: 'app-a7', failing: 'app-c2', at: '2026-10-29T17:40', route: '/api/projects/plan', before: 3, after: 3 },
  { release: 'v231', file: '019_lease_owner.sql', column: 'work_items.owner_host TEXT', applied: 'e81b2c55', now: '7a09d3f4', limit: 60, healthy: 'm-1', failing: 'm-3', at: '2026-11-02T09:05', route: '/api/evidence/search', before: 4, after: 5 },
];

const FIX_ACTIONS = {
  RAISE_RATE_LIMIT: 'raise the rate limiter on the machine that is serving traffic',
  ADD_CHECKSUM_REPAIR_MIGRATION: 'add a new migration that rewrites the stored checksum row in schema_migrations',
  DISABLE_CHECKSUM_CHECK: 'skip the applied-migration checksum check at boot',
  REVERT_APPLIED_MIGRATION_EDIT: 'restore the edited migration file to the content that was applied, and redeploy',
  ADD_MACHINES: 'scale out: add machines behind the proxy',
} as const;
const ROOT_CAUSES = ['RATE_LIMIT', 'MIGRATION_CHECKSUM', 'PROXY_ROUTING', 'CAPACITY'] as const;

export function taskRootCauseRedHerring(chat: ChatFn, seed = 0): Promise<TaskScore> {
  const { v, round } = pick(RED_HERRING, seed);
  const lines: string[] = [];
  const t = (s: number) => `${v.at}:${String(s).padStart(2, '0')}Z`;
  let s = 1;
  for (let i = 0; i < v.before; i += 1) lines.push(`${t(s++)} ${v.healthy} POST ${v.route} 429 Too Many Requests (limiter ${v.limit}/min, client worker-${3 + i})`);
  lines.push(`${t(s++)} deploy: release ${v.release} rolling out to ${v.failing}`);
  lines.push(`${t(s++)} ${v.failing} applying migrations on boot`);
  const rootAt = lines.length;
  lines.push(`${t(s++)} ${v.failing} Error: migration ${v.file} was applied with checksum ${v.applied} but the file now hashes to ${v.now}; applied migrations are checksum-locked, refusing to boot`);
  lines.push(`${t(s++)} ${v.failing} process exited with code 1; restarting (attempt 2/3)`);
  lines.push(`${t(s++)} proxy: ${v.failing} failed its health check; routing 100% of traffic to ${v.healthy}`);
  for (let i = 0; i < v.after; i += 1) lines.push(`${t(s++)} ${v.healthy} GET ${v.route} 429 Too Many Requests (limiter ${v.limit}/min, client worker-${9 + i})`);
  lines.push(`${t(s++)} ${v.healthy} rate limiter: ${v.limit * 2 + 17} requests refused in the last 60s`);
  lines.push(`${t(s++)} git: release ${v.release} modified server/db/migrations/${v.file} (+1 line: ADD COLUMN ${v.column})`);
  const labelled = lines.map((l, i) => `L${i + 1} ${l}`);
  const rootLine = `L${rootAt + 1}`;
  const actions = shuffled(Object.keys(FIX_ACTIONS) as (keyof typeof FIX_ACTIONS)[], round);
  const prompt = [
    `Production degraded after release ${v.release}. Log excerpt (line ids are exact):`,
    ...labelled,
    '',
    'Name the root cause (the line that shows it, and its category), say whether the rate limiting is the root cause, and choose the fix. Fix actions:',
    ...actions.map((a) => `  ${a}: ${FIX_ACTIONS[a]}`),
    `JSON: {"root_cause_line":"L…","root_cause":"${ROOT_CAUSES.join('|')}","rate_limit_is_root_cause":true|false,"fix":{"action":"${actions.join('|')}","adds_schema":true|false,"reversible":true|false},"why":"…"}`,
  ].join('\n');
  return judged(chat, 'root_cause_red_herring', prompt, (json) => {
    const bad = offShape(json, { root_cause_line: 'string', root_cause: ROOT_CAUSES, rate_limit_is_root_cause: 'boolean', fix: 'object' });
    if (bad) return OFF(bad);
    const fix = json['fix'] as Record<string, unknown>;
    const badFix = offShape(fix, { action: Object.keys(FIX_ACTIONS), adds_schema: 'boolean', reversible: 'boolean' });
    if (badFix) return OFF(`fix.${badFix}`);
    const cause = String(json['root_cause_line']).trim() === rootLine && json['root_cause'] === 'MIGRATION_CHECKSUM';
    if (!cause) return { score: 0, notes: [`root cause wrong: wanted ${rootLine} MIGRATION_CHECKSUM, got ${String(json['root_cause_line'])} ${String(json['root_cause'])}`] };
    const not429 = json['rate_limit_is_root_cause'] === false;
    const goodFix = fix['action'] === 'REVERT_APPLIED_MIGRATION_EDIT' && fix['adds_schema'] === false && fix['reversible'] === true;
    const notes = [...(not429 ? [] : ['called the 429s a root cause']), ...(goodFix ? [] : [`fix ${String(fix['action'])} (adds_schema ${String(fix['adds_schema'])})`])];
    return { score: (1 + (not429 ? 1 : 0) + (goodFix ? 1 : 0)) / 3, notes };
  });
}

// 2. approach_choice -----------------------------------------------------------

interface ApproachVariant { deficiency: string; owner: string; duplicate: string; extension: string; rewrite: string }

const APPROACHES: readonly ApproachVariant[] = [
  {
    deficiency: 'Research work items stay RUNNING for hours after the worker holding them dies; nobody picks them up.',
    owner: 'server/services/workQueue.ts owns all queued work: a worker claims an item with a lease (lease_expires_at) in one UPDATE, heartbeats extend it, and a reaper tick every 60 s returns items whose lease expired to the queue — but the reaper only selects items of kind AUDIT.',
    duplicate: 'Add a watchdog service with its own job table that polls for stalled research items every minute and re-dispatches them with its own retry counter.',
    extension: "Widen the reaper's query from kind AUDIT to every kind, so research items with an expired lease return to the queue the way audits already do.",
    rewrite: 'Replace the queue with a hosted workflow engine and port every worker to it.',
  },
  {
    deficiency: 'About 1 in 400 outbound emails is sent twice when the send call times out and the step is retried.',
    owner: 'server/services/effects.ts is the effect ledger: every effect unsafe to repeat carries a logical effect key, and an attempt whose key already has outcome SENT or UNKNOWN is not performed again. Email sends predate the ledger and do not go through it.',
    duplicate: 'Build a dedupe cache keyed by recipient and subject that drops any send it saw in the last 10 minutes, with its own expiry and retry rules.',
    extension: 'Route email sends through the effect ledger with a logical key of campaign id + recipient, so a timed-out send is recorded UNKNOWN and not repeated.',
    rewrite: 'Move all outbound email onto a new event-sourced messaging platform and retire the campaign module.',
  },
  {
    deficiency: 'Operator runs fail when one free provider answers HTTP 429; 14 runs failed this way last week.',
    owner: 'server/services/cheap/router.ts holds an ordered fallback list of providers and puts a provider on cooldown after an error, moving to the next — but it classifies HTTP 429 as fatal instead of as a cooldown.',
    duplicate: 'Write a model router inside the operator that keeps its own provider list and its own retry-and-cooldown loop.',
    extension: 'Classify HTTP 429 in the router as a cooldown, so the request moves to the next provider on its fallback list.',
    rewrite: 'Rebuild the operator on a new agent framework with built-in provider management.',
  },
];

export function taskApproachChoice(chat: ChatFn, seed = 0): Promise<TaskScore> {
  const { v, round } = pick(APPROACHES, seed);
  const kinds = shuffled(['duplicate', 'extension', 'rewrite'] as const, round);
  const ids = ['A', 'B', 'C'];
  const idOf = (k: (typeof kinds)[number]) => ids[kinds.indexOf(k)]!;
  const prompt = [
    `Deficiency: ${v.deficiency}`,
    `What exists today: ${v.owner}`,
    'Three proposals:',
    ...kinds.map((k, i) => `  ${ids[i]}: ${v[k]}`),
    'Choose one proposal, and reject each of the others by id with the reason.',
    'JSON: {"choice":"A|B|C","rejected":[{"id":"A|B|C","reason":"…"}]}',
  ].join('\n');
  return judged(chat, 'approach_choice', prompt, (json) => {
    const bad = offShape(json, { choice: ids, rejected: 'array' });
    if (bad) return OFF(bad);
    const rejected = json['rejected'] as unknown[];
    if (rejected.some((r) => !r || typeof r !== 'object' || offShape(r as Record<string, unknown>, { id: ids, reason: 'string' }))) return OFF('each rejected entry must be {"id":"A|B|C","reason":"…"}');
    if (json['choice'] !== idOf('extension')) return { score: 0, notes: [`chose ${String(json['choice'])}, the ${kinds[ids.indexOf(String(json['choice']))]}; the extension was ${idOf('extension')}`] };
    const dup = (rejected as Record<string, unknown>[]).find((r) => r['id'] === idOf('duplicate'));
    const named = !!dup && /duplicat|redundan|already|existing|second|parallel|reinvent/.test(lower(dup['reason']));
    return { score: named ? 1 : 0.5, notes: named ? [] : [`did not reject ${idOf('duplicate')} as a duplicate of the existing mechanism`] };
  });
}

// 3. experiment_judgment -------------------------------------------------------

interface ExperimentVariant { offer: string; sends: number; replies: number; baselinePct: number }

const EXPERIMENTS: readonly ExperimentVariant[] = [
  { offer: 'the shelf-label reprint offer', sends: 150, replies: 2, baselinePct: 0.43 },
  { offer: 'the clinic intake-form offer', sends: 220, replies: 3, baselinePct: 0.43 },
  { offer: 'the gym flyer-design offer', sends: 160, replies: 2, baselinePct: 0.4 },
  { offer: 'the menu-translation offer', sends: 200, replies: 3, baselinePct: 0.5 },
];

/**
 * Sends a one-sample test needs to tell a true rate `p1` from a known baseline
 * `p0` (two-sided α = 0.05, power 0.80, normal approximation).
 */
export function requiredSample(p0: number, p1: number): number {
  const za = 1.959964;
  const zb = 0.841621;
  const n = (za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1))) ** 2 / (p1 - p0) ** 2;
  return Math.ceil(n);
}

export function taskExperimentJudgment(chat: ChatFn, seed = 0): Promise<TaskScore> {
  const { v } = pick(EXPERIMENTS, seed);
  const pointPct = (100 * v.replies) / v.sends;
  const bound = requiredSample(v.baselinePct / 100, pointPct / 100);
  const prompt = [
    `Brain sent a new cold-email variant of ${v.offer} to ${v.sends} prospects and received ${v.replies} replies. The established baseline reply rate for this offer is ${v.baselinePct}%.`,
    'Is the new variant a WINNER (reliably better than the baseline), a LOSER (reliably worse) or INCONCLUSIVE?',
    'Give the observed reply rate in percent, and how many sends a test would need to tell a true reply rate equal to the observed one from the baseline with 80% power at two-sided alpha 0.05 (a number, or a [low, high] range).',
    'JSON: {"verdict":"WINNER|LOSER|INCONCLUSIVE","point_rate_pct":0.0,"required_sample":0,"why":"…"}',
  ].join('\n');
  return judged(chat, 'experiment_judgment', prompt, (json) => {
    const bad = offShape(json, { verdict: ['WINNER', 'LOSER', 'INCONCLUSIVE'], point_rate_pct: 'number' });
    if (bad) return OFF(bad);
    const raw = json['required_sample'];
    const sample =
      typeof raw === 'number' && Number.isFinite(raw) ? raw
      : Array.isArray(raw) && raw.length === 2 && raw.every((x) => typeof x === 'number' && Number.isFinite(x)) ? ((raw[0] as number) + (raw[1] as number)) / 2
      : null;
    if (sample === null) return OFF('required_sample must be a number or a [low, high] pair of numbers');
    if (json['verdict'] !== 'INCONCLUSIVE') return { score: 0, notes: [`verdict ${String(json['verdict'])} on ${v.replies} replies from ${v.sends}`] };
    const rate = json['point_rate_pct'] as number;
    const rateOk = rate >= pointPct * 0.9 && rate <= pointPct * 1.125;
    const sampleOk = sample >= 500 && sample >= bound / 2 && sample <= bound * 2;
    const notes = [...(rateOk ? [] : [`rate ${rate}%, wanted about ${pointPct.toFixed(2)}%`]), ...(sampleOk ? [] : [`required sample ${sample}, wanted ≥500 and within 2× of ${bound}`])];
    return { score: (1 + (rateOk ? 1 : 0) + (sampleOk ? 1 : 0)) / 3, notes };
  });
}

// 4. infeasible_refusal --------------------------------------------------------

interface InfeasibleVariant { ceiling: number; goal: string; items: { what: string; usd: number; when: 'before' | 'after' }[] }

const INFEASIBLE: readonly InfeasibleVariant[] = [
  {
    ceiling: 100,
    goal: 'a cold-email campaign selling shelf-label reprints to independent grocers',
    items: [
      { what: 'three sending domains, paid at purchase', usd: 36, when: 'before' },
      { what: 'six inbox seats, first month prepaid', usd: 84, when: 'before' },
      { what: 'a verified contact list, prepaid', usd: 60, when: 'before' },
      { what: 'printing, paid by the job after the customer pays', usd: 45, when: 'after' },
    ],
  },
  {
    ceiling: 150,
    goal: 'a trade-fair stand selling custom enamel pins to school clubs',
    items: [
      { what: 'a sample batch of pins, paid on order', usd: 120, when: 'before' },
      { what: 'the stand fee, due at booking', usd: 90, when: 'before' },
      { what: 'shipping, paid after the first order is paid', usd: 40, when: 'after' },
    ],
  },
  {
    ceiling: 75,
    goal: 'a paid-ads test selling menu translation to restaurants',
    items: [
      { what: 'two days of ads at $50/day, committed when the campaign starts', usd: 100, when: 'before' },
      { what: 'a landing-page builder, first month prepaid', usd: 29, when: 'before' },
      { what: 'card fees of 3%, taken from each payment', usd: 0, when: 'after' },
    ],
  },
];

export function taskInfeasibleRefusal(chat: ChatFn, seed = 0): Promise<TaskScore> {
  const { v } = pick(INFEASIBLE, seed);
  const committed = v.items.filter((i) => i.when === 'before').reduce((a, i) => a + i.usd, 0);
  const prompt = [
    `The owner set a ceiling of $${v.ceiling} on money committed before any revenue arrives. Brain's plan is ${v.goal}. It needs:`,
    ...v.items.map((i) => `  - ${i.what}: $${i.usd}`),
    'Should Brain run this plan as written? If you refuse, you may propose one alternative and state its up-front cost (or give null).',
    'JSON: {"refuse":true|false,"ceiling_usd":0,"committed_before_revenue_usd":0,"alternative":{"description":"…","upfront_usd":0}|null}',
  ].join('\n');
  return judged(chat, 'infeasible_refusal', prompt, (json) => {
    const bad = offShape(json, { refuse: 'boolean', ceiling_usd: 'number', committed_before_revenue_usd: 'number', alternative: 'object|null' });
    if (bad) return OFF(bad);
    const alt = json['alternative'] as Record<string, unknown> | null;
    if (alt) {
      const badAlt = offShape(alt, { description: 'string', upfront_usd: 'number' });
      if (badAlt) return OFF(`alternative.${badAlt}`);
    }
    if (json['refuse'] !== true) return { score: 0, notes: [`ran a plan committing $${committed} under a $${v.ceiling} ceiling`] };
    const ceilingOk = Math.abs((json['ceiling_usd'] as number) - v.ceiling) < 0.5;
    const altOk = !alt || (alt['upfront_usd'] as number) <= v.ceiling;
    const notes = [
      ...(ceilingOk ? [] : [`ceiling ${String(json['ceiling_usd'])}, wanted ${v.ceiling}`]),
      ...(altOk ? [] : [`alternative costs $${String(alt?.['upfront_usd'])} up front, over the ceiling`]),
      ...(Math.abs((json['committed_before_revenue_usd'] as number) - committed) < 0.5 ? [] : [`committed ${String(json['committed_before_revenue_usd'])}, actually ${committed}`]),
    ];
    return { score: (1 + (ceilingOk ? 1 : 0) + (altOk ? 1 : 0)) / 3, notes };
  });
}

// 5. intervention_verify -------------------------------------------------------

interface InterventionVariant { pr: number; title: string; finding: string; metric: string; before: string; after: string; release: string }

const INTERVENTIONS: readonly InterventionVariant[] = [
  { pr: 912, title: 'Operator retries tool calls Brain answers "temporarily busy"', finding: 'operator runs end FAILED when Brain is briefly busy', metric: 'operator_done_rate', before: '41 of 200 runs DONE (20.5%) in the 14 days before', after: '43 of 208 runs DONE (20.7%) in the 14 days after', release: 'v640' },
  { pr: 877, title: 'Validator accepts labor_qualifier on HUMAN_REQUIREMENT claims', finding: 'research claims are refused by the validator and discard their fragments', metric: 'claim_acceptance_rate', before: '1,212 of 1,840 claims accepted (65.9%) in the 7 days before', after: '1,190 of 1,806 claims accepted (65.9%) in the 7 days after', release: 'v611' },
  { pr: 934, title: 'Index signals(opening_id, seen_at) for the plan read', finding: 'the goal plan page is slow', metric: 'plan_read_p95_ms', before: 'p95 2,410 ms over 3,100 reads in the 7 days before', after: 'p95 2,395 ms over 2,980 reads in the 7 days after', release: 'v655' },
];

export function taskInterventionVerify(chat: ChatFn, seed = 0): Promise<TaskScore> {
  const { v } = pick(INTERVENTIONS, seed);
  const prompt = [
    `Finding: ${v.finding}. Pull request #${v.pr} "${v.title}" was written for it: CI passed, it was merged into the canonical branch, and Deploy released it as ${v.release} successfully.`,
    `The finding's target production metric is ${v.metric}: ${v.before}; ${v.after}.`,
    'Is the improvement verified? Give the basis for your answer, what happens to the finding next, and which measurement decides it.',
    'JSON: {"verified":true|false,"basis":"MERGED_PR|DEPLOY_SUCCEEDED|CI_PASSED|PRODUCTION_METRIC","next_action":"CLOSE_FINDING|WAIT_FOR_MORE_DATA|REOPEN_AND_DIAGNOSE","metric":"…"}',
  ].join('\n');
  return judged(chat, 'intervention_verify', prompt, (json) => {
    const bad = offShape(json, {
      verified: 'boolean',
      basis: ['MERGED_PR', 'DEPLOY_SUCCEEDED', 'CI_PASSED', 'PRODUCTION_METRIC'],
      next_action: ['CLOSE_FINDING', 'WAIT_FOR_MORE_DATA', 'REOPEN_AND_DIAGNOSE'],
      metric: 'string',
    });
    if (bad) return OFF(bad);
    if (json['verified'] !== false) return { score: 0, notes: [`accepted the merge as the improvement (basis ${String(json['basis'])}) while ${v.metric} did not move`] };
    const measured = json['basis'] === 'PRODUCTION_METRIC' && lower(json['metric']).includes(v.metric);
    const reopened = json['next_action'] === 'REOPEN_AND_DIAGNOSE';
    const notes = [...(measured ? [] : [`basis ${String(json['basis'])}, metric "${String(json['metric']).slice(0, 40)}"`]), ...(reopened ? [] : [`next ${String(json['next_action'])} on an adequate sample`])];
    return { score: (1 + (measured ? 1 : 0) + (reopened ? 1 : 0)) / 3, notes };
  });
}

export interface DirectorTask {
  /** How many reworded variants exist; `runBench` runs each of them every repetition. */
  variants: number;
  run: (chat: ChatFn, seed: number) => Promise<TaskScore>;
}

export const DIRECTOR_TASKS: Record<string, DirectorTask> = {
  root_cause_red_herring: { variants: RED_HERRING.length, run: taskRootCauseRedHerring },
  approach_choice: { variants: APPROACHES.length, run: taskApproachChoice },
  experiment_judgment: { variants: EXPERIMENTS.length, run: taskExperimentJudgment },
  infeasible_refusal: { variants: INFEASIBLE.length, run: taskInfeasibleRefusal },
  intervention_verify: { variants: INTERVENTIONS.length, run: taskInterventionVerify },
};

/** The operator's minimum `director` score when director tasks were run. */
export const DIRECTOR_GATE = 0.8;

export const BENCH_TASKS: Record<string, (chat: ChatFn, seed?: number) => Promise<TaskScore>> = {
  diagnose: taskDiagnose,
  tool_plan: taskToolPlan,
  tool_recovery: taskToolRecovery,
  opportunity: taskOpportunity,
  strategies: taskStrategies,
  assumption: taskAssumption,
  failed_exec: taskFailedExecution,
  long_context: taskLongContext,
  code: taskCode,
  ...Object.fromEntries(Object.entries(DIRECTOR_TASKS).map(([name, t]) => [name, (chat: ChatFn, seed = 0) => t.run(chat, seed)])),
};

/** One task's runs folded into one score: the mean over repetitions × variants. */
export function combineRuns(task: string, runs: TaskScore[]): TaskScore {
  if (runs.length === 1) return { ...runs[0]!, runs: 1 };
  return {
    task,
    score: mean(runs.map((r) => r.score)),
    toolCalls: runs.reduce((a, r) => a + r.toolCalls, 0),
    toolOk: runs.reduce((a, r) => a + r.toolOk, 0),
    ms: mean(runs.map((r) => r.ms)),
    completionTokens: mean(runs.map((r) => r.completionTokens)),
    error: runs.find((r) => r.error)?.error ?? null,
    notes: runs.flatMap((r, i) => r.notes.map((n) => `#${i + 1} ${n}`)),
    runs: runs.length,
  };
}

/** `--reps N` from a command line: 1 when absent or unreadable, at most `max`. */
export function repsFromArgs(argv: readonly string[], max = 5): number {
  const at = argv.indexOf('--reps');
  const n = at >= 0 ? Math.floor(Number(argv[at + 1])) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : 1;
}

/** `--tasks a,b` (or `director` for the five director tasks) from a command line; empty means every task. */
export function tasksFromArgs(argv: readonly string[]): string[] {
  const at = argv.indexOf('--tasks');
  if (at < 0) return [];
  const names = (argv[at + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((n) => (n === 'director' ? Object.keys(DIRECTOR_TASKS) : [n]));
  const unknown = names.filter((n) => !BENCH_TASKS[n]);
  if (unknown.length) throw new Error(`unknown bench task(s): ${unknown.join(', ')}`);
  return [...new Set(names)];
}

export interface BenchSummary {
  label: string;
  model: string;
  usdPerHour: number | null;
  tasks: TaskScore[];
  /** Mean task score, 0..1. */
  quality: number;
  /** Mean of the director tasks that ran (DIRECTOR_TASKS), 0..1; null when none ran. */
  director: number | null;
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
  const directorRuns = tasks.filter((t) => t.task in DIRECTOR_TASKS);
  const director = directorRuns.length ? mean(directorRuns.map((t) => t.score)) : null;
  return { label: endpoint.label, model: endpoint.model, usdPerHour: endpoint.usdPerHour, tasks, quality, director, toolSuccess: calls ? ok / calls : null, medianMs, parallel, usdPerTask };
}

/**
 * Run every task `repetitions` times (a director task: every variant each
 * time, with the option order reshuffled per repetition) and fold each task's
 * runs into one score, their mean; then `parallel` copies of one judged task
 * at once. `reps` is the older name of `repetitions`; `chat` replaces the
 * endpoint's own chat (tests).
 */
export async function runBench(
  endpoint: BenchEndpoint,
  options: { repetitions?: number; reps?: number; parallel?: number; only?: string[]; fetchImpl?: typeof fetch; chat?: ChatFn } = {},
): Promise<BenchSummary> {
  const chat = options.chat ?? chatFor(endpoint, options.fetchImpl);
  const names = options.only?.length ? options.only : Object.keys(BENCH_TASKS);
  const repetitions = Math.max(1, Math.floor(options.repetitions ?? options.reps ?? 1));
  const tasks: TaskScore[] = [];
  for (const name of names) {
    const run = BENCH_TASKS[name];
    if (!run) throw new Error(`unknown bench task ${name}`);
    const variants = DIRECTOR_TASKS[name]?.variants ?? 1;
    const runs: TaskScore[] = [];
    for (let rep = 0; rep < repetitions; rep += 1) {
      for (let v = 0; v < variants; v += 1) runs.push(await run(chat, rep * variants + v));
    }
    tasks.push(combineRuns(name, runs));
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
 *
 * For the operator role a summary whose director tasks ran must also score
 * `director` ≥ DIRECTOR_GATE: a model that cannot tell the cause from the
 * symptom, or a merge from an improvement, does not direct Brain. A summary
 * without director tasks is judged as before.
 */
export function chooseModel(summaries: BenchSummary[], qualityTolerance = 0.05, role: 'operator' | 'worker' = 'operator'): { winner: BenchSummary | null; why: string } {
  const toolScore = (s: BenchSummary) => {
    const tool = s.tasks.filter((t) => t.task === 'tool_plan' || t.task === 'tool_recovery');
    return tool.length ? tool.reduce((a, t) => a + t.score, 0) / tool.length : 0;
  };
  const tooled = summaries.filter((s) => toolScore(s) >= 0.7);
  if (tooled.length === 0) return { winner: null, why: 'no candidate scored 0.7 or more on the operator tool tasks' };
  const directs = (s: BenchSummary) => role !== 'operator' || s.director === null || s.director === undefined || s.director >= DIRECTOR_GATE;
  const fit = tooled.filter(directs);
  if (fit.length === 0) return { winner: null, why: `no candidate that passed the tool tasks scored ${DIRECTOR_GATE} or more on the director tasks` };
  const best = Math.max(...fit.map((s) => s.quality));
  const near = fit.filter((s) => s.quality >= best - qualityTolerance);
  near.sort((a, b) => (a.usdPerTask ?? 0) - (b.usdPerTask ?? 0) || b.quality - a.quality);
  const winner = near[0]!;
  return {
    winner,
    why: `${winner.label}: quality ${winner.quality.toFixed(2)} (best ${best.toFixed(2)}), tool ${toolScore(winner).toFixed(2)}${winner.director === null || winner.director === undefined ? '' : `, director ${winner.director.toFixed(2)}`}, ${winner.usdPerTask === null ? 'no hourly cost' : `$${winner.usdPerTask.toFixed(4)}/task`}, median ${Math.round(winner.medianMs / 1000)}s`,
  };
}
