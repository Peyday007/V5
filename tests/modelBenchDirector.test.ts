import { describe, expect, it } from 'vitest';
import {
  BENCH_TASKS,
  DIRECTOR_GATE,
  DIRECTOR_TASKS,
  chooseModel,
  repsFromArgs,
  requiredSample,
  runBench,
  summarize,
  tasksFromArgs,
  type ChatFn,
  type ChatResult,
  type Message,
  type TaskScore,
} from '../server/services/cheap/modelBench.ts';

const reply = (content: string): ChatResult => ({ content, toolCalls: [], ms: 10, completionTokens: 5, error: null });
const promptOf = (messages: Message[]) => String(messages[messages.length - 1]!['content']);
const endpoint = { label: 'stub', url: 'http://stub/v1', key: null, model: 'stub', usdPerHour: null };

/** An independent power calculation: one-sample, two-sided α 0.05, power 0.8. */
function powerBound(p0: number, p1: number): number {
  const za = 1.96;
  const zb = 0.8416;
  return ((za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2;
}

/** Read the facts each variant states, the way a competent director would, and answer on shape. */
const correct: Record<string, (prompt: string) => string> = {
  root_cause_red_herring: (p) => {
    const line = /^(L\d+) .*checksum-locked/m.exec(p)![1]!;
    return JSON.stringify({ root_cause_line: line, root_cause: 'MIGRATION_CHECKSUM', rate_limit_is_root_cause: false, fix: { action: 'REVERT_APPLIED_MIGRATION_EDIT', adds_schema: false, reversible: true }, why: 'the second machine refuses to boot; the 429s are the survivor taking all traffic' });
  },
  approach_choice: (p) => {
    const id = (re: RegExp) => new RegExp(`^  ([ABC]): ${re.source}`, 'm').exec(p)![1]!;
    const ext = id(/(Widen|Route email sends through|Classify HTTP 429)/);
    const dup = id(/(Add a watchdog|Build a dedupe|Write a model router)/);
    const rest = ['A', 'B', 'C'].find((x) => x !== ext && x !== dup)!;
    return JSON.stringify({ choice: ext, rejected: [{ id: dup, reason: 'duplicates the existing mechanism' }, { id: rest, reason: 'a rewrite is out of proportion' }] });
  },
  experiment_judgment: (p) => {
    const [, sends, replies, base] = /to (\d+) prospects and received (\d+) replies\. The established baseline reply rate for this offer is ([\d.]+)%/.exec(p)!;
    const rate = Number(replies) / Number(sends);
    return JSON.stringify({ verdict: 'INCONCLUSIVE', point_rate_pct: Number((rate * 100).toFixed(2)), required_sample: Math.round(powerBound(Number(base) / 100, rate)), why: 'too few sends' });
  },
  infeasible_refusal: (p) => {
    const ceiling = Number(/ceiling of \$(\d+)/.exec(p)![1]);
    return JSON.stringify({ refuse: true, ceiling_usd: ceiling, committed_before_revenue_usd: 0, alternative: { description: 'a smaller first step', upfront_usd: Math.floor(ceiling / 2) } });
  },
  intervention_verify: (p) => {
    const metric = /target production metric is (\w+)/.exec(p)![1]!;
    return JSON.stringify({ verified: false, basis: 'PRODUCTION_METRIC', next_action: 'REOPEN_AND_DIAGNOSE', metric });
  },
};

/** Every right keyword in the prose fields, the wrong judgment in the structured ones. */
const stuffed: Record<string, (prompt: string) => string> = {
  root_cause_red_herring: () => JSON.stringify({ root_cause_line: 'L1', root_cause: 'RATE_LIMIT', rate_limit_is_root_cause: true, fix: { action: 'RAISE_RATE_LIMIT', adds_schema: false, reversible: true }, why: 'migration checksum refusal at boot, revert the applied migration edit, reversible, no schema, not the 429' }),
  approach_choice: (p) => {
    const dup = /^ {2}([ABC]): (Add a watchdog|Build a dedupe|Write a model router)/m.exec(p)![1]!;
    return JSON.stringify({ choice: dup, rejected: [{ id: dup, reason: 'duplicate of the existing mechanism; extend the existing owner instead' }] });
  },
  experiment_judgment: () => JSON.stringify({ verdict: 'WINNER', point_rate_pct: 1.33, required_sample: 600, why: 'inconclusive? no — power, sample size, baseline, significance all fine' }),
  infeasible_refusal: (p) => JSON.stringify({ refuse: false, ceiling_usd: Number(/ceiling of \$(\d+)/.exec(p)![1]), committed_before_revenue_usd: 180, alternative: null, note: 'refuse ceiling exceeded infeasible' }),
  intervention_verify: (p) => JSON.stringify({ verified: true, basis: 'MERGED_PR', next_action: 'CLOSE_FINDING', metric: `${/target production metric is (\w+)/.exec(p)![1]} production measurement unchanged` }),
};

/** Right idea, wrong shape: prose, a missing key, a quoted number or an unlisted enum. */
const offShape: Record<string, string> = {
  root_cause_red_herring: '{"root_cause":"the migration checksum","fix":"revert the edited migration"}',
  approach_choice: '{"choice":"the extension","rejected":["the duplicate"]}',
  experiment_judgment: '{"verdict":"INCONCLUSIVE","point_rate_pct":"1.33%","required_sample":">500"}',
  infeasible_refusal: 'I would refuse: it commits $180 against a $100 ceiling.',
  intervention_verify: '{"verified":"no","basis":"production metric","next_action":"reopen","metric":"operator_done_rate"}',
};

const answering = (by: (prompt: string) => string, prompts: string[] = []): ChatFn => async (messages) => {
  const p = promptOf(messages);
  prompts.push(p);
  return reply(by(p));
};

const names = Object.keys(DIRECTOR_TASKS);

describe('director-grade bench tasks (§108)', () => {
  it('has the five tasks, each with at least two variants, alongside the existing nine', () => {
    expect(names).toEqual(['root_cause_red_herring', 'approach_choice', 'experiment_judgment', 'infeasible_refusal', 'intervention_verify']);
    for (const n of names) expect(DIRECTOR_TASKS[n]!.variants).toBeGreaterThanOrEqual(2);
    for (const n of ['diagnose', 'tool_plan', 'tool_recovery', 'opportunity', 'strategies', 'assumption', 'failed_exec', 'long_context', 'code', ...names]) expect(BENCH_TASKS[n]).toBeTypeOf('function');
  });

  for (const name of names) {
    describe(name, () => {
      const task = DIRECTOR_TASKS[name]!;
      const seeds = Array.from({ length: task.variants * 2 }, (_, i) => i);

      it('scores a correct answer 1.0 on every variant and option order', async () => {
        for (const seed of seeds) {
          const r = await task.run(answering(correct[name]!), seed);
          expect(r.score, `seed ${seed}: ${r.notes.join('; ')}`).toBe(1);
        }
      });

      it('scores a keyword-stuffed wrong answer at most 0.2', async () => {
        for (const seed of seeds) expect((await task.run(answering(stuffed[name]!), seed)).score).toBeLessThanOrEqual(0.2);
      });

      it('scores an off-shape answer 0', async () => {
        const r = await task.run(answering(() => offShape[name]!), 0);
        expect(r.score).toBe(0);
        expect(r.notes.join(' ')).toMatch(/off-shape|no JSON/);
      });

      it('rewords its variants', async () => {
        const prompts: string[] = [];
        for (let seed = 0; seed < task.variants; seed += 1) await task.run(answering(correct[name]!, prompts), seed);
        expect(new Set(prompts).size).toBe(task.variants);
      });
    });
  }

  it('reorders options between repetitions, so a remembered letter does not pass', async () => {
    const n = DIRECTOR_TASKS['approach_choice']!.variants;
    const seen: string[] = [];
    for (let round = 0; round < 6; round += 1) await DIRECTOR_TASKS['approach_choice']!.run(answering(correct['approach_choice']!, seen), round * n);
    expect(new Set(seen.map((p) => /^ {2}([ABC]): Add a watchdog/m.exec(p)![1])).size).toBeGreaterThan(1);
  });

  it('the experiment bound is a real power calculation, at least 500 sends', () => {
    const n = requiredSample(0.0043, 2 / 150);
    expect(n).toBeGreaterThanOrEqual(500);
    expect(Math.abs(n - powerBound(0.0043, 2 / 150))).toBeLessThan(2);
  });

  it('accepts a required-sample range, and refuses one outside a factor of two', async () => {
    const run = (sample: unknown) => DIRECTOR_TASKS['experiment_judgment']!.run(async () => reply(JSON.stringify({ verdict: 'INCONCLUSIVE', point_rate_pct: 1.33, required_sample: sample })), 0);
    expect((await run([550, 700])).score).toBe(1);
    expect((await run(5000)).score).toBeCloseTo(2 / 3);
    expect((await run(300)).score).toBeCloseTo(2 / 3);
  });
});

describe('repetitions, the director aggregate and the operator gate', () => {
  it('scores a task as the mean over repetitions × variants', async () => {
    let calls = 0;
    // Right on every other call, off-shape otherwise.
    const alternating: ChatFn = async (messages) => {
      calls += 1;
      return reply(calls % 2 ? correct['intervention_verify']!(promptOf(messages)) : 'merged, so done');
    };
    const one = await runBench(endpoint, { chat: alternating, only: ['intervention_verify'], repetitions: 1 });
    const variants = DIRECTOR_TASKS['intervention_verify']!.variants;
    expect(calls).toBe(variants);
    calls = 0;
    const two = await runBench(endpoint, { chat: alternating, only: ['intervention_verify'], repetitions: 2 });
    expect(calls).toBe(2 * variants);
    expect(two.tasks).toHaveLength(1);
    expect(two.tasks[0]!.runs).toBe(2 * variants);
    expect(two.tasks[0]!.score).toBeCloseTo(0.5);
    expect(one.tasks[0]!.runs).toBe(variants);
  });

  it('reads --reps N and --tasks director from the command line', () => {
    expect(repsFromArgs(['node', 'x'])).toBe(1);
    expect(repsFromArgs(['node', 'x', '--reps', '3'])).toBe(3);
    expect(repsFromArgs(['node', 'x', '--reps', 'zero'])).toBe(1);
    expect(repsFromArgs(['node', 'x', '--reps', '40'])).toBe(5);
    expect(tasksFromArgs(['--tasks', 'director'])).toEqual(names);
    expect(tasksFromArgs([])).toEqual([]);
    expect(() => tasksFromArgs(['--tasks', 'nope'])).toThrow(/unknown/);
  });

  it('adds a director aggregate, and the operator role requires it when director tasks ran', async () => {
    const director = await runBench(endpoint, { chat: answering((p) => correct[names.find((n) => p.includes(fingerprint[n]!))!]!(p)), only: names });
    expect(director.director).toBe(1);

    const t = (task: string, score: number): TaskScore => ({ task, score, toolCalls: 2, toolOk: 2, ms: 1000, completionTokens: 1, error: null, notes: [] });
    const tools = [t('tool_plan', 1), t('tool_recovery', 1)];
    const cheapWeak = summarize({ ...endpoint, label: 'cheap', usdPerHour: 0.1 }, [...tools, ...names.map((n) => t(n, 0.6))], null);
    const dearStrong = summarize({ ...endpoint, label: 'dear', usdPerHour: 0.3 }, [...tools, ...names.map((n) => t(n, 0.9))], null);
    expect(cheapWeak.director).toBeCloseTo(0.6);
    expect(chooseModel([cheapWeak, dearStrong], 0.5).winner?.label).toBe('dear');
    expect(chooseModel([cheapWeak]).winner).toBeNull();
    expect(chooseModel([cheapWeak]).why).toMatch(String(DIRECTOR_GATE));
    expect(chooseModel([cheapWeak], 0.05, 'worker').winner?.label).toBe('cheap');
    // Without director tasks the choice is what it was.
    const plain = summarize({ ...endpoint, label: 'plain', usdPerHour: 0.1 }, [...tools, t('diagnose', 0.9)], null);
    expect(plain.director).toBeNull();
    expect(chooseModel([plain]).winner?.label).toBe('plain');
  });
});

/** A phrase only that task's prompts carry, to route a stub answer. */
const fingerprint: Record<string, string> = {
  root_cause_red_herring: 'Log excerpt',
  approach_choice: 'Three proposals',
  experiment_judgment: 'baseline reply rate',
  infeasible_refusal: 'committed before any revenue',
  intervention_verify: 'target production metric',
};
