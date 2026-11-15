/**
 * Brain's own model invents ways of reasoning about a goal (§101).
 *
 * The cheap algorithms in `directions.ts` derive directions from the
 * problem's data; they can only reason in the ways somebody wrote down. Here
 * Brain's free-lane models (the OpenAI-compatible lane, `cheap/lane.ts`) are
 * shown the goal, the plan, what binds it, the openings, the operators and
 * the stances already tried, and asked to invent *other* ways of reasoning
 * about it — each expressed as a program the engine can test. Several calls
 * run at once, one per spare model slot, each told which stances the others
 * already hold, so the methods differ instead of repeating.
 *
 * The answer is a sorting signal like every lane answer: a method is kept
 * only if it validates (`parseInvented`), and it wins only if the one engine
 * says its plan is stronger once challenged. Nothing it says is evidence.
 * Off when the lane is not configured; `BRAIN_REASONING_MODEL=off` turns it
 * off on purpose.
 */
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../../cheap/lane.ts';
import { parseInvented, type Direction, type InventBrief } from './directions.ts';

export const INVENT_CALLS_MAX = 4;
export const INVENT_TIMEOUT_MS = 45_000;
/** The pause before a rate-refused call is asked once more, and the least budget worth asking with. */
export const INVENT_BACKOFF_MS = 4_000;
export const INVENT_RETRY_MIN_MS = 10_000;
const RATE_LIMITED = /\bHTTP 429\b|rate.?limit|too many requests/i;

const SYSTEM =
  'You are the strategist inside a planning engine. You invent DIFFERENT WAYS OF REASONING about a goal — ' +
  'not answers, not more of the same — and express each as a short program the engine can simulate. ' +
  'Be inventive about the angle (who else could pay, what could be sold instead, what to stop doing, what order, ' +
  'what to combine, what assumption is wrong), but every step must use only the program vocabulary given. ' +
  'Answer ONLY with a JSON object.';

export function inventPrompt(brief: InventBrief, slot: number, avoid: string[]): string {
  return [
    `Goal: raise ${brief.remaining} more within ${brief.daysLeft} days, with at least ${Math.round(brief.required * 100)}% confidence.`,
    `Plan as held reaches the target in ${Math.round(brief.baseline.reach * 100)}% of simulated worlds; the best one-change-at-a-time plan reaches ${Math.round(brief.greedy.reach * 100)}% by: ${brief.greedy.changes.join(' | ') || 'no change'}.`,
    `What binds (lift in reach when moved to its favourable end): ${brief.binding.map((b) => `${b.factor} +${Math.round(b.liftReach * 100)}%`).join(', ')}.${brief.structural ? ' Even every input at its best cannot reach the requirement: the structure must change.' : ''}`,
    'Openings held (id, title, price, close rate, reply rate, deals the market can take, days to cash, sold by outreach?):',
    ...brief.openings.map((o) => `- ${o.id} | ${o.title} | ${o.price ?? '?'} | ${o.close ?? '?'} | ${o.respond ?? '?'} | ${o.volume ?? '?'} | ${o.daysToCash ?? '?'} | ${o.outreach ? 'outreach' : o.agreed ? 'agreed' : 'other'}`),
    `Operators (costed changes): ${brief.operators.map((o) => o.key).join(', ')}.`,
    '',
    'Program vocabulary (each step one object):',
    '{"op":"OPERATOR","key":"<operator key or key prefix>","target":"<opening id, optional: point a channel operator at that opening>"}',
    '{"op":"PRICE","factor":<0.25-4>,"scope":"<scope>"}   (close rate moves the other way; it is an assumption)',
    '{"op":"FOCUS","count":<n>}   (concentrate on the n strongest openings, drop the rest)',
    '{"op":"DROP","scope":"<scope>"}',
    ...(brief.reserve?.length
      ? [
          '{"op":"INCLUDE","key":"<arrangement id>"}   (bring in a constructed arrangement outside the plan, judged on its own estimates)',
          `Arrangements outside the plan (id, title, price read low, repeatable?): ${brief.reserve.map((r) => `${r.id} | ${r.title} | ${r.price ?? '?'} | ${r.repeatable ? 'repeatable' : 'one-off'}`).join('; ')}`,
        ]
      : []),
    'scope: ALL, OUTREACH, SMALL_TICKET, LARGE_TICKET, FAST_CASH, SLOW_CASH, TOP, REST, or id:<opening id>.',
    ...(brief.designs
      ? [
          'A method may also bring in a NEW arrangement nobody holds: a different buyer, a different way of being paid. Add "design" to the method:',
          '{"structure":"<structure>","funding":"<funding>","aggregation":"<aggregation>","repeat":"<repeat>","population":"<who pays, in words>","need":"<what they pay to have dealt with, optional>"}',
          `structure: ${brief.designs.structures.map((s) => `${s.key} (${s.label})`).join('; ')}. funding: ${brief.designs.funding.join(', ')}. aggregation: ${brief.designs.aggregation.join(', ')}. repeat: ${brief.designs.repeat.join(', ')}.`,
          'Give no figures for a design: Brain composes it and treats every number of it as unknown until research establishes it. Its program may be empty or add steps.',
        ]
      : []),
    '"from": "BASELINE" rebuilds the strategy from scratch; "GREEDY" modifies the best plan above.',
    '',
    `Stances already covered — invent OTHER ways of reasoning: ${[...new Set([...brief.stancesTried, ...avoid])].join(', ')}.`,
    brief.bestKnown.length ? `Methods that worked before on other plans: ${brief.bestKnown.map((m) => `${m.stance}: ${m.thinking}`).join(' / ')}` : '',
    `You are strategist ${slot + 1}; others are answering too, so take an angle they are unlikely to take.`,
    'Give 5 to 8 methods. For each, name the assumption of the current plan it challenges, and if it needs a fact the openings do not show, put the question in "ask".',
    'An opening id is written bare in "target" and "key" (cop_123), and as id:cop_123 only in "scope". Every program step is one of the objects above, with its "op" spelled exactly.',
    brief.designs ? 'Leave "design" out of a method that brings in no new arrangement; never write it empty.' : '',
    `Reply exactly: {"methods":[{"name":"short name","stance":"ONE_OR_TWO_WORDS","thinking":"one or two sentences: how this way of reasoning sees the problem","challenges":"the assumption it attacks","from":"BASELINE or GREEDY","program":[{"op":"FOCUS","count":3}],${brief.designs ? '"design":{"structure":"<structure>","population":"<who pays>"},' : ''}"ask":"optional question"}]}${brief.designs ? ' — "design" only on a method that brings in a new arrangement.' : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface InventOptions {
  config?: LaneConfig | null;
  completer?: Completer;
  /** Concurrent calls: the spare model capacity the caller measured. */
  calls?: number;
  env?: NodeJS.ProcessEnv;
  /** The pause before a rate-refused call is retried; tests shorten it. */
  backoffMs?: number;
}

/** Whether the model would be asked at all: off on purpose, or no lane configured. */
export function inventEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['BRAIN_REASONING_MODEL'] ?? '').trim().toLowerCase() !== 'off' && !!laneConfig(env);
}

export async function inventDirections(brief: InventBrief, options: InventOptions = {}): Promise<{ directions: Direction[]; calls: number; proposed: number; refused: number; error: string | null; rejections: string[] }> {
  const env = options.env ?? process.env;
  if ((env['BRAIN_REASONING_MODEL'] ?? '').trim().toLowerCase() === 'off') return { directions: [], calls: 0, proposed: 0, refused: 0, error: 'off by BRAIN_REASONING_MODEL', rejections: [] };
  const config = options.config === undefined ? laneConfig(env) : options.config;
  if (!config) return { directions: [], calls: 0, proposed: 0, refused: 0, error: 'no model lane configured', rejections: [] };
  const complete = options.completer ?? httpCompleter;
  const calls = Math.max(1, Math.min(INVENT_CALLS_MAX, options.calls ?? config.models.length * 2));
  const model = (i: number) => config.models[i % config.models.length]!;
  const backoffMs = options.backoffMs ?? INVENT_BACKOFF_MS;
  let retried = 0;
  // One strategist's call, inside one INVENT_TIMEOUT_MS budget. A free provider refusing for rate (HTTP 429) is
  // capacity, not an answer: production 2026-11-14 lost 2 of 4 calls to it and the lane with them. The call
  // backs off and is asked once more — on the next model slot when there is one — with whatever budget is left.
  const ask = async (i: number): Promise<string> => {
    const deadline = Date.now() + INVENT_TIMEOUT_MS;
    const once = (slot: number, timeoutMs: number) =>
      Promise.race([
        complete({ ...config, timeoutMs }, model(slot), SYSTEM, inventPrompt(brief, i, []), { maxTokens: 3000 }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs + 2_000).unref()),
      ]);
    try {
      return await once(i, INVENT_TIMEOUT_MS);
    } catch (error) {
      if (!RATE_LIMITED.test(String((error as Error)?.message ?? error))) throw error;
      const wait = Math.min(backoffMs, Math.max(0, deadline - Date.now() - INVENT_RETRY_MIN_MS));
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const left = deadline - Date.now();
      if (left < INVENT_RETRY_MIN_MS) throw error;
      retried++;
      return await once(i + 1, left);
    }
  };
  // Concurrent: each strategist is asked at the same time, and told to take an angle the others will not.
  const answers = await Promise.allSettled(Array.from({ length: calls }, (_, i) => ask(i)));
  const directions: Direction[] = [];
  let proposed = 0;
  let refused = 0;
  const errors: string[] = [];
  const rejections: string[] = [];
  for (const a of answers) {
    if (a.status === 'rejected') {
      errors.push(String((a.reason as Error)?.message ?? a.reason).slice(0, 120));
      continue;
    }
    const parsed = parseInvented(a.value, brief);
    proposed += parsed.proposed;
    refused += parsed.refused;
    rejections.push(...parsed.rejections);
    directions.push(...parsed.directions);
  }
  return { directions, calls, proposed, refused, error: errors.length ? `${errors.length} of ${calls} call(s) failed${retried ? ` (${retried} retried after a rate refusal)` : ''}: ${errors[0]}` : null, rejections };
}
