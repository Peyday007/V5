/**
 * The cheap lane: grunt work done by free models, so Claude only touches what
 * survives.
 *
 * Brain talks to one OpenAI-compatible address — OmniRoute, or anything like
 * it — which stacks free providers and switches when one runs out. What this
 * module adds on top of that switchboard is the part a switchboard cannot do:
 *
 *  1. Only closed, small tasks with a fixed answer shape are sent (`TASKS`).
 *  2. Every answer is validated; anything off-shape is a failed answer, never
 *     a guess at what the model meant.
 *  3. With two models configured, both answer and must agree; a disagreement
 *     is UNSURE, which goes to Claude like a KEEP.
 *  4. Every answer is a row, so the same input is never asked twice and each
 *     model's agreement rate is countable (`laneReading`).
 *  5. A daily budget per task, so one task cannot spend the whole free day.
 *  6. Its output is a sorting signal and never evidence: no gate, card, tier
 *     or ledger reads `cheap_results`.
 *
 * Off unless `BRAIN_CHEAP_LLM_URL` is set. With it unset nothing is sent and
 * every reader behaves exactly as before.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { newId, nowIso } from '../../repos/util.ts';

export interface LaneConfig {
  url: string;
  key: string | null;
  /** One or two model names; two means every answer is cross-checked. */
  models: string[];
  dailyBudget: number;
  timeoutMs: number;
}

/** Read per call, so setting or removing the secret needs no restart. */
export function laneConfig(env: NodeJS.ProcessEnv = process.env): LaneConfig | null {
  const url = env['BRAIN_CHEAP_LLM_URL']?.trim();
  if (!url) return null;
  const models = (env['BRAIN_CHEAP_LLM_MODELS'] ?? 'auto')
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean)
    .slice(0, 2);
  const budget = Number(env['BRAIN_CHEAP_LLM_DAILY_BUDGET'] ?? 3000);
  return {
    url: url.replace(/\/+$/, ''),
    key: env['BRAIN_CHEAP_LLM_KEY']?.trim() || null,
    models: models.length > 0 ? models : ['auto'],
    dailyBudget: Number.isFinite(budget) && budget > 0 ? Math.trunc(budget) : 3000,
    timeoutMs: 30_000,
  };
}

export const SCREEN_VERDICTS = ['KEEP', 'DROP', 'UNSURE'] as const;
export type ScreenVerdict = (typeof SCREEN_VERDICTS)[number];
export const CASH_WINDOWS = ['SHORT', 'ONGOING', 'UNKNOWN'] as const;
export type CashWindow = (typeof CASH_WINDOWS)[number];

export interface ScreenOutput {
  verdict: ScreenVerdict;
  /** Whether the money is a short window (weeks) or ongoing. */
  window: CashWindow;
  tags: string[];
  reason: string;
}

export interface ScreenInput {
  title: string;
  mechanism: string | null;
  source: string | null;
  payer: string | null;
  buyingSignal: string | null;
  deadline: string | null;
  price: string | null;
}

/** The closed set of tasks the lane runs. One today; each new one is reviewed code. */
export const TASKS = {
  SCREEN_OPENING: {
    system:
      'You sort business openings for a very small operation that wants cash fast. It sells ' +
      'digital work by email (documents, spreadsheets, data work, simple websites, research) ' +
      'and has little money to spend up front. Answer ONLY with a JSON object.',
    prompt(input: ScreenInput): string {
      return [
        'Is this opening worth a closer look by a stronger analyst?',
        'KEEP: somebody plausibly pays, soon, for something this operation could deliver.',
        'DROP: obviously not — nobody pays, needs a licence, big capital, physical work, or it is closed.',
        'UNSURE: you cannot tell.',
        'window: SHORT if the money is a window of weeks (a deadline, an event, a new rule); ONGOING if it repeats; UNKNOWN otherwise.',
        '',
        `Title: ${input.title}`,
        `Kind: ${input.mechanism ?? 'unknown'}`,
        `Who pays: ${input.payer ?? 'unknown'}`,
        `Evidence of buying: ${input.buyingSignal ?? 'unknown'}`,
        `Price: ${input.price ?? 'unknown'}`,
        `Deadline: ${input.deadline ?? 'unknown'}`,
        `Source: ${input.source ?? 'unknown'}`,
        '',
        'Reply exactly: {"verdict":"KEEP|DROP|UNSURE","window":"SHORT|ONGOING|UNKNOWN","tags":["up to 5 short tags"],"reason":"one sentence"}',
      ].join('\n');
    },
  },
} as const;
export type TaskKind = keyof typeof TASKS;

/** Validate one answer. Anything off-shape is refused, never repaired. */
export function parseScreen(text: string): ScreenOutput | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  let value: unknown;
  try {
    value = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['verdict', 'window', 'tags', 'reason']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const verdict = record['verdict'];
  const window = record['window'] ?? 'UNKNOWN';
  if (typeof verdict !== 'string' || !(SCREEN_VERDICTS as readonly string[]).includes(verdict)) return null;
  if (typeof window !== 'string' || !(CASH_WINDOWS as readonly string[]).includes(window)) return null;
  const tags = Array.isArray(record['tags'])
    ? record['tags'].filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.slice(0, 40)).slice(0, 5)
    : [];
  const reason = typeof record['reason'] === 'string' ? record['reason'].slice(0, 300) : '';
  return { verdict: verdict as ScreenVerdict, window: window as CashWindow, tags, reason };
}

/** Two answers into one: agreement keeps the verdict, disagreement is UNSURE. */
export function combine(answers: (ScreenOutput | null)[]): ScreenOutput | null {
  const good = answers.filter((one): one is ScreenOutput => one !== null);
  if (good.length === 0) return null;
  if (good.length === 1) return good[0]!;
  const [a, b] = good as [ScreenOutput, ScreenOutput];
  if (a.verdict === b.verdict) {
    return {
      verdict: a.verdict,
      window: a.window === b.window ? a.window : 'UNKNOWN',
      tags: [...new Set([...a.tags, ...b.tags])].slice(0, 5),
      reason: a.reason,
    };
  }
  return { verdict: 'UNSURE', window: 'UNKNOWN', tags: a.tags, reason: 'The two models disagreed.' };
}

export function inputHash(kind: TaskKind, input: unknown): string {
  return createHash('sha256').update(`${kind}\n${JSON.stringify(input)}`).digest('hex');
}

/** The HTTP call. Injected in tests; nothing else in the lane touches the network. */
export type Completer = (config: LaneConfig, model: string, system: string, prompt: string) => Promise<string>;

export const httpCompleter: Completer = async (config, model, system, prompt) => {
  const response = await fetch(`${config.url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.key ? { authorization: `Bearer ${config.key}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`cheap lane HTTP ${response.status}`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
};

interface ResultRow {
  model: string;
  ok: number;
  output: string | null;
}

async function usedToday(kind: TaskKind, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const row = await getDb().get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM cheap_results WHERE kind = ? AND created_at >= ?',
    [kind, `${day}T00:00:00.000Z`],
  );
  return Number(row?.n ?? 0);
}

/**
 * Screen one opening. Null when the lane is off, the budget is spent, or no
 * model gave a valid answer — and null means "no signal", never DROP.
 */
export async function screenOpening(
  subjectId: string,
  input: ScreenInput,
  options: { config?: LaneConfig | null; completer?: Completer; now?: Date } = {},
): Promise<ScreenOutput | null> {
  const config = options.config === undefined ? laneConfig() : options.config;
  if (!config) return null;
  const kind: TaskKind = 'SCREEN_OPENING';
  const hash = inputHash(kind, input);
  const db = getDb();
  const cached = await db.all<ResultRow>(
    'SELECT model, ok, output FROM cheap_results WHERE kind = ? AND input_hash = ?',
    [kind, hash],
  );
  const answers: (ScreenOutput | null)[] = [];
  const now = options.now ?? new Date();
  for (const model of config.models) {
    const hit = cached.find((row) => row.model === model);
    if (hit) {
      answers.push(hit.ok && hit.output ? parseScreen(hit.output) : null);
      continue;
    }
    if ((await usedToday(kind, now)) >= config.dailyBudget) return combine(answers);
    const task = TASKS[kind];
    let text = '';
    let error: string | null = null;
    try {
      text = await (options.completer ?? httpCompleter)(config, model, task.system, task.prompt(input));
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : 'failed';
    }
    const parsed = error ? null : parseScreen(text);
    await db.run(
      `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, input_hash, model) DO NOTHING`,
      [
        newId('chp'),
        kind,
        hash,
        subjectId,
        model,
        parsed ? 1 : 0,
        parsed ? JSON.stringify(parsed) : null,
        error ?? (parsed ? null : `off-shape answer: ${text.slice(0, 200)}`),
        nowIso(),
      ],
    );
    answers.push(parsed);
  }
  return combine(answers);
}

/** The latest screen of each subject, for a reader ordering work. */
export async function latestScreens(subjectIds: string[]): Promise<Map<string, ScreenOutput>> {
  const out = new Map<string, ScreenOutput>();
  if (subjectIds.length === 0) return out;
  const rows = await getDb().all<{ subject_id: string; model: string; ok: number; output: string | null }>(
    `SELECT subject_id, model, ok, output FROM cheap_results
      WHERE kind = 'SCREEN_OPENING' AND subject_id IN (${subjectIds.map(() => '?').join(',')})
      ORDER BY created_at DESC`,
    subjectIds,
  );
  const bySubject = new Map<string, (ScreenOutput | null)[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.subject_id}\n${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bySubject.set(row.subject_id, [
      ...(bySubject.get(row.subject_id) ?? []),
      row.ok && row.output ? parseScreen(row.output) : null,
    ]);
  }
  for (const [subject, answers] of bySubject) {
    const combined = combine(answers);
    if (combined) out.set(subject, combined);
  }
  return out;
}

/** What the lane did today, and how often its models agreed: the scoreboard's input. */
export async function laneReading(now: Date = new Date()): Promise<{
  enabled: boolean;
  today: number;
  budget: number | null;
  verdicts: Record<ScreenVerdict, number>;
  failed: number;
}> {
  const config = laneConfig();
  const day = now.toISOString().slice(0, 10);
  const rows = await getDb().all<{ ok: number; output: string | null }>(
    "SELECT ok, output FROM cheap_results WHERE kind = 'SCREEN_OPENING' AND created_at >= ?",
    [`${day}T00:00:00.000Z`],
  );
  const verdicts: Record<ScreenVerdict, number> = { KEEP: 0, DROP: 0, UNSURE: 0 };
  let failed = 0;
  for (const row of rows) {
    const parsed = row.ok && row.output ? parseScreen(row.output) : null;
    if (parsed) verdicts[parsed.verdict] += 1;
    else failed += 1;
  }
  return { enabled: config !== null, today: rows.length, budget: config?.dailyBudget ?? null, verdicts, failed };
}
