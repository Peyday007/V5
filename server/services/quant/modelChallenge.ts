/**
 * The plan's challenge and Brain's existing model challenger are one path
 * (CHAL-33 repair F3).
 *
 * Brain already has an independent-model challenger: `operator/decisions.ts`
 * `challengeDecision`, which asks a second model to attack a decision cold and
 * name its hidden assumptions and a stronger alternative; `domain/planReady.ts`
 * reads its answer on an adoption as `hermes.challenge`. This module adds no
 * second challenger. It:
 *
 *   * routes the plan's own consequence tier to decide when that heavier
 *     challenge is required (`ChallengeSummary.modelChallenge`, deep only — a
 *     small reversible action is never sent to a second model);
 *   * when it is required, asks the existing challenger, through
 *     `challengeDecision` itself, with the plan stated as an `ADOPT_PLAN`
 *     decision; and
 *   * feeds the answer back into `challengePlan` as an `INDEPENDENT_MODEL`
 *     check, so a deep step is validated by a different model over different
 *     data, and a REVISE holds it with the assumption and the alternative the
 *     challenger named.
 *
 * The running Brain reaches it from the optimizer itself (CHAL-33 F3,
 * unreachable): every plan read goes through `optimizePortfolio`, whose
 * `bindChallenge` asks `modelChallengeFor` when — and only when — the plan's
 * challenge says the model challenge is due and the caller supplied no answer.
 * The optimizer is synchronous and a second model is not, so the first read of
 * a plan starts the ask (once per plan, bounded in flight, never retried
 * sooner than `MODEL_CHALLENGE_RETRY_MS` after a silence) and stays held as
 * `due`; the next read of the same plan — the plan pass runs on its own
 * cadence — finds the answer and binds it. A plan whose figures changed is a
 * different plan and is asked again: an answer about one plan never validates
 * another.
 *
 * One challenger per process (CHAL-33 F1/F2): a goal plan is read on the
 * evaluation pool's threads (`goals/reasoning/evaluatorPool.ts`), and each
 * thread has its own copy of this module. A thread does not ask a model of its
 * own — it would hold an unanswered ask no later read on another thread could
 * find. It forwards the ask over `PLAN_CHALLENGE_CHANNEL` to the main thread,
 * whose asker (the operator's models) is the process's one challenger; the main
 * thread asks once per plan, with the same in-flight, retry and memo bounds,
 * and broadcasts the answer, which every thread binds on its next read of the
 * same plan. An answer about one plan still never validates another.
 *
 * The answer outlives the thread that asked (CHAL-33 repair F1, pool): the
 * pool terminates an idle thread after `SHARED_IDLE_MS` (60 s) and a plan pass
 * reads less often than that, so the next read of a plan almost always lands
 * on a fresh thread whose memo is empty — a broadcast it was not alive to hear
 * cannot reach it, and the plan stayed `due` for ever. The main thread is the
 * one owner of the answers: every answer it records is also written, whole and
 * atomically, to `PLAN_CHALLENGE_ANSWERS_FILE`, a per-process runtime file a
 * thread reads synchronously when its own memo does not know the plan. A
 * thread spawned after the answer arrived therefore binds it on its very first
 * read. A thread reads from the file only answers recorded before it was
 * loaded — the ones it was not alive to hear; an answer that arrives while it
 * lives reaches it by the broadcast, as before, and binds on its next read.
 * The file is a cache of this process's memo, never authoritative: it is
 * named by the process id, written only by the main thread, and a missing or
 * unreadable file is no answer — never a pass.
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BroadcastChannel, isMainThread } from 'node:worker_threads';
import { reviewDecision, type DecisionInput } from '../../domain/decision.ts';
import type { OperatorModel } from '../../domain/operator.ts';
import { challengeDecision } from '../operator/decisions.ts';
import { challengePlan, type ChallengeSummary, type ModelChallenge, type PlanChallengeOptions } from './challenge.ts';
import { applyChallengeToAssurance, assess, type PortfolioProblem, type PortfolioResult } from './portfolio.ts';

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * The plan as the decision the existing challenger reads: execute the plan as
 * it stands (option 0, the adoption brief's convention), commit only the steps
 * the review has cleared, or commit nothing. Values are the plan's own
 * figures; nothing favourable is assumed for a figure it does not carry.
 */
export function planDecision(problem: PortfolioProblem, result: PortfolioResult, summary: ChallengeSummary, goalId: string | null = null): DecisionInput {
  const best = result.best;
  const reach = best?.reach ?? 0;
  const low = summary.kinds.CALIBRATED_PROBABILITY?.range?.low ?? null;
  const held = summary.steps.filter((s) => !s.mayProceed).map((s) => s.key);
  const evidence = [
    `scenario coverage ${pct(reach)} of ${summary.kinds.CALCULATED_SCENARIO.worlds ?? 'unstated'} worlds (a calculation, not a probability)`,
    low === null ? 'no calibrated probability' : `calibrated lower bound ${pct(low)}`,
    `review tier ${summary.scrutiny.tier}: ${summary.scrutiny.because.join('; ')}`,
    ...summary.exposures.map((e) => `shared ${e.kind.toLowerCase()} "${e.id}" across ${e.members.join(', ')}: reach ${pct(e.reachAsPlanned)} → ${pct(e.reachIfItFails)} if it fails`),
  ];
  return {
    kind: 'ADOPT_PLAN',
    goalId,
    question: `Commit the plan ${best?.keys.join(' + ') ?? '(none)'} towards ${problem.target} within ${problem.deadlineDays} days?`,
    options: [
      { action: `execute the plan as it stands: ${best?.keys.join(' + ') ?? 'none'}`, probability: low ?? 0, valueUsd: problem.target, costUsd: summary.action.potentialLoss, evidence: evidence.slice(0, 10) },
      { action: `commit only the steps already cleared (${summary.proceedNow.join(', ') || 'none'}) and hold ${held.join(', ') || 'nothing'}`, probability: low ?? 0, valueUsd: null, costUsd: null, evidence: summary.improvements.slice(0, 10) },
      { action: 'commit nothing yet', probability: 1, valueUsd: 0, costUsd: 0, evidence: [] },
    ],
    chosen: 0,
    assumptions: summary.findings.filter((f) => f.severity !== 'MINOR').map((f) => `${f.subject}: ${f.assumption}`).slice(0, 10).concat(summary.findings.length ? [] : ['the plan\'s samples represent the worlds it will meet']),
    whyNotHighestEv: 'the challenge is asked before commitment; the choice is the plan under review',
    prediction: { outcome: `${problem.target} collected`, probability: low ?? 0, horizonDays: Math.min(365, Math.max(1, Math.ceil(problem.deadlineDays))) },
    irreversible: summary.action.irreversible,
  };
}

/** Ask Brain's existing challenger about a plan stated as a decision. Shared by both entrances, so there is one path. */
export async function askPlanChallenger(
  input: DecisionInput,
  models: OperatorModel[],
  fetchImpl: typeof fetch = fetch,
  bounds: Parameters<typeof challengeDecision>[4] = {},
  challenger: typeof challengeDecision = challengeDecision,
): Promise<ModelChallenge | null> {
  return challenger(input, reviewDecision(input), models, fetchImpl, bounds);
}

export interface ModelChallengedPlan {
  summary: ChallengeSummary;
  /** Whether the existing challenger was asked: only when the tier required it. */
  asked: boolean;
  challenge: ModelChallenge | null;
}

/**
 * Challenge a plan, and when — and only when — its consequence requires the
 * heavier independent-model challenge, ask Brain's existing challenger and
 * re-read the plan with its verdict as an independent check. A challenger
 * that does not answer leaves the routing `due`; it is never read as a pass.
 */
export async function challengePlanWithModel(
  problem: PortfolioProblem,
  result: PortfolioResult,
  models: OperatorModel[],
  options: PlanChallengeOptions & { goalId?: string | null; fetchImpl?: typeof fetch; bounds?: Parameters<typeof challengeDecision>[4] } = {},
  challenger: typeof challengeDecision = challengeDecision,
): Promise<ModelChallengedPlan> {
  const { goalId, fetchImpl, bounds, ...planOptions } = options;
  const first = challengePlan(problem, result, planOptions);
  if (!first.modelChallenge.due) return { summary: first, asked: false, challenge: null };
  const input = planDecision(problem, result, first, goalId ?? null);
  const answer = await askPlanChallenger(input, models, fetchImpl ?? fetch, bounds ?? {}, challenger);
  remember(planChallengeKey(input), answer);
  if (!answer) return { summary: first, asked: true, challenge: null };
  const summary = challengePlan(problem, result, { ...planOptions, modelChallenge: answer });
  /*
   * The answer binds what a reader acts on (CHAL-33 F3): the assurance the
   * optimizer held while the challenge was due is re-derived from the plan's
   * own evidence and re-held by this summary, so a PROCEED lifts only the hold
   * the missing challenge caused and a REVISE keeps it, as a disagreeing
   * independent check. Nothing is raised above what `assess` itself allows,
   * and an assurance the caller kept unchallenged (`challenge: false`) is left so.
   */
  if (result.assurance?.challenge && result.best) {
    result.assurance = assess(problem, result.best);
    applyChallengeToAssurance(result.assurance, summary, result.adoption);
  }
  return { summary, asked: true, challenge: answer };
}

/* ---------------------------------------------------------------------------
 * The optimizer's entrance (CHAL-33 F3, unreachable).
 * ------------------------------------------------------------------------- */

/** How long a challenger that did not answer is left before the same plan is asked again. */
export const MODEL_CHALLENGE_RETRY_MS = 30 * 60_000;
/** Answers kept, newest last; the oldest is forgotten first. */
export const MODEL_CHALLENGE_MEMO_LIMIT = 256;
/** Plans being asked at once, across the process. */
export const MODEL_CHALLENGE_MAX_IN_FLIGHT = 2;

/** What asks the challenger about one plan. Production: the operator's own models, through `askPlanChallenger`. */
export type PlanChallengeAsker = (input: DecisionInput) => Promise<ModelChallenge | null>;

async function operatorAsker(input: DecisionInput): Promise<ModelChallenge | null> {
  const { modelsFor } = await import('../operator/run.ts');
  const models = await modelsFor();
  // No model configured is no answer — never a pass.
  if (models.length === 0) return null;
  return askPlanChallenger(input, models);
}

let asker: PlanChallengeAsker = operatorAsker;
const answers = new Map<string, { answer: ModelChallenge | null; at: number }>();
const inFlight = new Map<string, Promise<void>>();

function remember(key: string, answer: ModelChallenge | null, at = Date.now()): void {
  answers.delete(key);
  answers.set(key, { answer, at });
  while (answers.size > MODEL_CHALLENGE_MEMO_LIMIT) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
  if (isMainThread) persistAnswers();
}

/*
 * The process's answers, readable by a thread that was not alive when they
 * arrived (CHAL-33 repair F1). Threads share `process.pid`, so the name is the
 * process's own; a later process starts with nothing, exactly as its memo does.
 */

/** The runtime file the main thread keeps this process's challenger answers in, for pool threads to read synchronously. */
export const PLAN_CHALLENGE_ANSWERS_FILE = join(tmpdir(), `brain-plan-challenge-${process.pid}.json`);

type StoredAnswers = Array<[string, { answer: ModelChallenge | null; at: number }]>;

/** When this thread's copy of the module was loaded: the file supplies only what was recorded before it. */
const LOADED_AT = Date.now();

/** Main thread: write the whole memo, atomically, so a reader never sees half of it. A failed write leaves threads asking again. */
function persistAnswers(): void {
  const temporary = `${PLAN_CHALLENGE_ANSWERS_FILE}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify([...answers.entries()] satisfies StoredAnswers));
    renameSync(temporary, PLAN_CHALLENGE_ANSWERS_FILE);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing to clean up.
    }
  }
}

/**
 * Pool thread: what the main thread recorded about one plan before this
 * thread was loaded, read from the process's answers file into this thread's
 * memo; undefined when the file does not know it (or cannot be read).
 * Synchronous, for the optimizer.
 */
function storedAnswer(key: string): { answer: ModelChallenge | null; at: number } | undefined {
  let stored: StoredAnswers;
  try {
    stored = JSON.parse(readFileSync(PLAN_CHALLENGE_ANSWERS_FILE, 'utf8')) as StoredAnswers;
  } catch {
    return undefined;
  }
  if (!Array.isArray(stored)) return undefined;
  const found = stored.find((entry) => Array.isArray(entry) && entry[0] === key)?.[1];
  if (!found || typeof found.at !== 'number' || !Number.isFinite(found.at)) return undefined;
  // Recorded while this thread lives: the broadcast delivers it (or the next forward is re-announced).
  if (found.at > LOADED_AT) return undefined;
  const answer = found.answer && typeof found.answer === 'object' && typeof found.answer.verdict === 'string' ? found.answer : null;
  remember(key, answer, found.at);
  return { answer, at: found.at };
}

/**
 * The identity of a plan as the challenger is asked about it: the question, the
 * options with their figures, and the assumptions. Pure. A plan whose figures
 * moved is a different plan.
 */
export function planChallengeKey(input: DecisionInput): string {
  const stated = {
    question: input.question,
    options: input.options.map((o) => [o.action, o.probability, o.valueUsd, o.costUsd, o.evidence]),
    chosen: input.chosen,
    assumptions: input.assumptions,
    irreversible: input.irreversible ?? null,
  };
  return createHash('sha256').update(JSON.stringify(stated)).digest('hex');
}

/**
 * The existing challenger's answer on exactly this plan, when it has given one;
 * otherwise undefined, after starting the ask when the challenge is due and the
 * plan is not already being asked or recently unanswered. Synchronous, so the
 * optimizer can call it; never throws, and an ask that fails is remembered as
 * no answer.
 */
export function modelChallengeFor(problem: PortfolioProblem, result: PortfolioResult, summary: ChallengeSummary, now = Date.now()): ModelChallenge | undefined {
  if (!summary.modelChallenge.due || !result.best) return undefined;
  let input: DecisionInput;
  try {
    input = planDecision(problem, result, summary, null);
  } catch {
    return undefined;
  }
  const key = planChallengeKey(input);
  // A thread's memo dies with the thread; the main thread's answers do not (CHAL-33 repair F1).
  const known = answers.get(key)?.answer ? answers.get(key) : isMainThread ? answers.get(key) : (storedAnswer(key) ?? answers.get(key));
  if (known?.answer) return known.answer;
  if (known && now - known.at < MODEL_CHALLENGE_RETRY_MS) return undefined;
  if (!isMainThread) {
    forward(key, input, now);
    return undefined;
  }
  startAsk(key, input);
  return undefined;
}

/** Main thread: ask the process's challenger about one plan, unless it is already being asked or the process is at its bound. */
function startAsk(key: string, input: DecisionInput): void {
  if (inFlight.has(key) || inFlight.size >= MODEL_CHALLENGE_MAX_IN_FLIGHT) return;
  const ask = (async () => {
    let answer: ModelChallenge | null = null;
    try {
      answer = await asker(input);
    } catch {
      answer = null;
    }
    remember(key, answer);
    announce(key);
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, ask);
}

/* ---------------------------------------------------------------------------
 * Across the evaluation pool's threads (CHAL-33 F1/F2).
 * ------------------------------------------------------------------------- */

/** The process-wide channel a pool thread forwards its asks on, and the main thread answers on. */
export const PLAN_CHALLENGE_CHANNEL = 'brain:plan-challenge';
/** A thread that forwarded an ask and heard nothing forwards it again after this long; the main thread de-duplicates. */
export const MODEL_CHALLENGE_FORWARD_MS = 60_000;

type ChannelMessage =
  | { type: 'ask'; key: string; input: DecisionInput }
  | { type: 'answer'; key: string; answer: ModelChallenge | null; at: number };

const forwarded = new Map<string, number>();
let channel: BroadcastChannel | null = null;

function openChannel(): BroadcastChannel | null {
  if (channel) return channel;
  try {
    channel = new BroadcastChannel(PLAN_CHALLENGE_CHANNEL);
    channel.unref();
    channel.onmessage = (event: unknown) => {
      const message = (event as { data?: ChannelMessage }).data;
      if (!message || typeof message.key !== 'string') return;
      if (isMainThread && message.type === 'ask') {
        const known = answers.get(message.key);
        // Already answered, or unanswered within the retry interval: tell the threads, do not ask again.
        if (known && (known.answer || Date.now() - known.at < MODEL_CHALLENGE_RETRY_MS)) announce(message.key);
        else startAsk(message.key, message.input);
      } else if (!isMainThread && message.type === 'answer') {
        forwarded.delete(message.key);
        remember(message.key, message.answer, message.at);
      }
    };
  } catch {
    channel = null;
  }
  return channel;
}

/** Main thread: tell every pool thread what the challenger said about one plan. */
function announce(key: string): void {
  const known = answers.get(key);
  if (!known) return;
  try {
    openChannel()?.postMessage({ type: 'answer', key, answer: known.answer, at: known.at } satisfies ChannelMessage);
  } catch {
    // A thread that misses an answer forwards its ask again; the main thread re-announces it.
  }
}

/** Pool thread: hand the ask to the main thread's challenger, at most once per forward interval. */
function forward(key: string, input: DecisionInput, now: number): void {
  const last = forwarded.get(key);
  if (last !== undefined && now - last < MODEL_CHALLENGE_FORWARD_MS) return;
  const open = openChannel();
  if (!open) return;
  try {
    open.postMessage({ type: 'ask', key, input } satisfies ChannelMessage);
    forwarded.set(key, now);
  } catch {
    // Not forwarded is not asked: the plan stays due, and the next read forwards it again.
  }
}

// Listen from load, so an ask a pool thread forwards before this thread's first plan read is not lost.
openChannel();

/** Tests: replace the production asker; null restores it. */
export function setPlanChallengeAsker(next: PlanChallengeAsker | null): void {
  asker = next ?? operatorAsker;
}

/** Tests: wait for every ask in flight to settle. */
export async function settlePlanChallenges(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}

/** Tests: forget every answer and every ask in flight. */
export function forgetPlanChallenges(): void {
  answers.clear();
  inFlight.clear();
  forwarded.clear();
  if (isMainThread) {
    try {
      rmSync(PLAN_CHALLENGE_ANSWERS_FILE, { force: true });
    } catch {
      // Already gone.
    }
  }
}
