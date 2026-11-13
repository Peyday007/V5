/**
 * Did an operator run do what a run is for (§108)? One judgement, read from its rows,
 * used twice: `npm run operator -- prove` prints it, and the next run's brief opens
 * with what the previous one skipped — so a step the model left out is asked for again
 * by Brain rather than discovered by a person reading a transcript.
 */
import { getDb } from '../../db/database.ts';
import { listOperatorLearnings, readOperatorMemory, type OperatorRun } from '../../repos/operator.ts';

/** Judging a past decision (verify) is not an action on the world; Factory work is. */
export const OPERATOR_ACTS = [
  'brain_operator_withdraw_moot_request',
  'brain_operator_continue_idle',
  'brain_operator_submit_fix',
  'brain_operator_set_goal_focus',
  'brain_operator_commission',
  'brain_operator_prioritize_engineering',
];
export const OPERATOR_READS = [
  'brain_operator_goal',
  'brain_operator_goal_plan',
  'brain_operator_capacity',
  'brain_operator_goals',
  'brain_operator_allocation',
  'brain_operator_engineering',
];

export interface RunCheck {
  step: 'run' | 'inspect' | 'plan' | 'decide' | 'act' | 'observe' | 'learn';
  pass: boolean;
  detail: string;
}

export async function judgeOperatorRun(run: OperatorRun): Promise<{ checks: RunCheck[]; decisions: { entity_id: string; payload: string }[] }> {
  const names = run.toolCalls.map((c) => ({ tool: c.tool.replace(/^mcp__brain__/, ''), ok: c.ok }));
  const ok = (tool: string) => names.some((n) => n.tool === tool && n.ok);
  const firstAct = names.findIndex((n) => OPERATOR_ACTS.includes(n.tool) && n.ok);
  const decisions = await getDb().all<{ entity_id: string; payload: string }>(
    "SELECT entity_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION' AND payload LIKE ? ORDER BY created_at",
    [`%"runId":"${run.id}"%`],
  );
  const learned = (await listOperatorLearnings({ limit: 50 })).filter((l) => l.runId === run.id);
  const memory = await readOperatorMemory();
  const checks: RunCheck[] = [
    { step: 'run', pass: run.state === 'DONE', detail: `${run.state} on ${run.model}` },
    { step: 'inspect', pass: ok('brain_operator_goal') || ok('brain_operator_goals'), detail: 'read a real goal' },
    { step: 'plan', pass: ok('brain_operator_goal_plan'), detail: "read the goal's quantitative plan (brain_operator_goal_plan)" },
    { step: 'decide', pass: decisions.length > 0, detail: `${decisions.length} decision(s) committed with a prediction on the ledger` },
    { step: 'act', pass: firstAct >= 0, detail: firstAct >= 0 ? `acted through ${names[firstAct]!.tool}` : 'no action succeeded' },
    {
      step: 'observe',
      pass: firstAct >= 0 && names.slice(firstAct + 1).some((n) => OPERATOR_READS.includes(n.tool) && n.ok),
      detail: 'read Brain again after acting (brain_operator_goal / brain_operator_capacity)',
    },
    { step: 'learn', pass: learned.length > 0 || Object.keys(memory).length > 0, detail: `${learned.length} lesson(s) this run, ${Object.keys(memory).length} memory file(s)` },
  ];
  return { checks, decisions };
}

/** The brief's opening line about the previous run, or '' when it did everything. */
export async function previousRunGaps(run: OperatorRun | null): Promise<string> {
  if (!run || run.state === 'RUNNING') return '';
  const { checks } = await judgeOperatorRun(run);
  const missed = checks.filter((c) => !c.pass && c.step !== 'run');
  if (missed.length === 0) return '';
  return [
    `Your previous run (${run.id}) skipped required steps: ${missed.map((c) => `${c.step} — ${c.detail}`).join('; ')}.`,
    'Do every one of them this run: a run that skips a step is judged incomplete and its effects cannot be verified.',
  ].join('\n');
}
