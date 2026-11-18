/**
 * Deadline intelligence on the engineering connector (§113): two tools every
 * deadline-bound worker shares — Hermes, Factory, a Claude Code session, a
 * research goal — so each asks the same arithmetic instead of guessing.
 *
 *   brain_deadline_plan    read-only: from measured history, is this deadline
 *                          feasible, with how many workers, along which
 *                          critical path; and once work is under way, where it
 *                          stands, what slipped and what to do about it.
 *   brain_deadline_record  after a deadline: estimate vs actual per task, and
 *                          the review whose recurring causes the next plan is
 *                          warned about.
 *
 * Neither discloses anything about a project: both read and write only the
 * deadline tables and Factory's own duration rows, which carry no project data.
 */
import type { DurationSample, PlanTask, TaskStatus } from '../domain/deadlinePlan.ts';
import { planErrors } from '../domain/deadlinePlan.ts';
import { planDeadline, recordDeadline } from '../services/engineering/deadline.ts';
import type { DeadlineReview } from '../repos/deadlines.ts';
import { invalidInput } from './errors.ts';
import { MUTATING, READ_ONLY, optionalInteger, optionalString, requiredString, type McpTool } from './toolkit.ts';

const STATUSES: readonly TaskStatus[] = ['TODO', 'RUNNING', 'DONE', 'BLOCKED'];

const TASK_SCHEMA = {
  type: 'array',
  description:
    'The work: one entry per task. kind names its history (CODE, REVIEW, INTEGRATE, CI, DEPLOY, RELEASE, DB_CHECK, ' +
    'LOCAL_CHECK, DIAGNOSE, MODEL_LOAD, GPU_VERIFY, REPORT, …); deps are task ids it waits on; resource is an exclusive ' +
    'resource only one task holds at a time (DEPLOY_PIPELINE, GPU, a file scope).',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
      deps: { type: 'array', items: { type: 'string' } },
      resource: { type: 'string' },
      estimate_min: { type: 'number', description: 'Used only when the kind has no measured history.' },
      essential: { type: 'boolean', description: 'false: may be descoped to protect the deadline.' },
      acceptance: { type: 'boolean', description: 'An acceptance criterion: never descoped.' },
      status: { type: 'string', enum: STATUSES },
      started_at: { type: 'string' },
      finished_at: { type: 'string' },
      owner: { type: 'string' },
    },
    required: ['id', 'kind'],
    additionalProperties: false,
  },
} as const;

const SAMPLES_SCHEMA = {
  type: 'array',
  description: 'Measured durations you hold that Brain does not (e.g. GitHub workflow run times): kind, minutes, failed, source.',
  items: {
    type: 'object',
    properties: { kind: { type: 'string' }, minutes: { type: 'number' }, failed: { type: 'boolean' }, source: { type: 'string' } },
    required: ['kind', 'minutes', 'source'],
    additionalProperties: false,
  },
} as const;

function iso(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalidInput(`"${field}" must be an ISO-8601 time.`);
  return new Date(Date.parse(value)).toISOString();
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw invalidInput(`"${field}" must be an array of strings.`);
  return value as string[];
}

export function parseTasks(args: Record<string, unknown>): PlanTask[] {
  const raw = args.tasks;
  if (!Array.isArray(raw) || raw.length === 0) throw invalidInput('"tasks" must be a non-empty array.');
  if (raw.length > 500) throw invalidInput('"tasks" may hold at most 500 tasks.');
  const tasks = raw.map((item, i): PlanTask => {
    if (!item || typeof item !== 'object') throw invalidInput(`tasks[${i}] must be an object.`);
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || typeof t.kind !== 'string' || !t.kind) throw invalidInput(`tasks[${i}] needs an id and a kind.`);
    const status = t.status === undefined ? 'TODO' : t.status;
    if (!STATUSES.includes(status as TaskStatus)) throw invalidInput(`tasks[${i}].status must be one of ${STATUSES.join(', ')}.`);
    const estimate = t.estimate_min;
    if (estimate !== undefined && !(typeof estimate === 'number' && estimate > 0)) throw invalidInput(`tasks[${i}].estimate_min must be a positive number.`);
    return {
      id: t.id,
      kind: t.kind.toUpperCase(),
      deps: strings(t.deps, `tasks[${i}].deps`),
      resource: typeof t.resource === 'string' ? t.resource : null,
      estimateMin: typeof estimate === 'number' ? estimate : null,
      essential: t.essential === false ? false : true,
      acceptance: t.acceptance === true,
      status: status as TaskStatus,
      startedAt: iso(t.started_at, `tasks[${i}].started_at`),
      finishedAt: iso(t.finished_at, `tasks[${i}].finished_at`),
      owner: typeof t.owner === 'string' ? t.owner : null,
    };
  });
  const errors = planErrors(tasks);
  if (errors.length) throw invalidInput(`the plan is invalid: ${errors.join('; ')}`);
  return tasks;
}

function parseSamples(args: Record<string, unknown>): DurationSample[] {
  const raw = args.samples;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidInput('"samples" must be an array.');
  return raw.map((s, i) => {
    const v = s as Record<string, unknown>;
    if (typeof v.kind !== 'string' || typeof v.minutes !== 'number' || v.minutes < 0 || typeof v.source !== 'string') {
      throw invalidInput(`samples[${i}] needs kind, a non-negative minutes and source.`);
    }
    return { kind: v.kind.toUpperCase(), minutes: v.minutes, failed: v.failed === true, source: v.source };
  });
}

const planTool: McpTool = {
  name: 'brain_deadline_plan',
  title: 'Plan a deadline from measured history',
  description:
    'When an outcome has a deadline, before accepting it and whenever something material happens: estimates each task ' +
    'from measured durations (p80 of successful runs × the attempts its failure rate implies), schedules the dependency ' +
    'graph on W workers with exclusive resources (one deploy pipeline, one GPU), and answers FEASIBLE / NEEDS_RESOURCES ' +
    '(how many workers) / INFEASIBLE (the limiting chain, the earliest completion, the alternatives). Distinguishes total ' +
    'work from elapsed time, names the critical path, flags the known failure patterns (a paid test before a cheap check, ' +
    'overlapping deploys, serialized diagnosis, unmeasured kinds, recurring causes) and, once tasks are running, ' +
    'reforecasts from where the work actually is and says what to do: add workers, reassign a stalled task, descope, escalate.',
  inputSchema: {
    type: 'object',
    properties: {
      deadline: { type: 'string', description: 'ISO-8601 deadline.' },
      now: { type: 'string', description: 'ISO-8601 "now" (defaults to the server clock; set it to replay a past deadline).' },
      available_workers: { type: 'integer', description: 'Workers committed now (default 1).' },
      max_workers: { type: 'integer', description: 'Most workers the spending authority allows (default: available).' },
      tasks: TASK_SCHEMA,
      samples: SAMPLES_SCHEMA,
    },
    required: ['deadline', 'tasks'],
    additionalProperties: false,
  },
  annotations: { title: 'Deadline plan', ...READ_ONLY },
  run: async (args) => {
    const deadline = iso(requiredString(args, 'deadline'), 'deadline')!;
    const now = iso(optionalString(args, 'now'), 'now') ?? undefined;
    const availableWorkers = optionalInteger(args, 'available_workers') ?? 1;
    const maxWorkers = optionalInteger(args, 'max_workers') ?? availableWorkers;
    if (availableWorkers < 1 || maxWorkers < 1 || maxWorkers > 50) throw invalidInput('workers must be between 1 and 50.');
    const answer = await planDeadline({ tasks: parseTasks(args), deadline, now, availableWorkers, maxWorkers, samples: parseSamples(args) });
    return { projectId: null, value: answer as unknown as Record<string, unknown> };
  },
};

function review(args: Record<string, unknown>, deadlineRef: string): DeadlineReview | null {
  const r = args.review as Record<string, unknown> | undefined;
  if (!r) return null;
  if (typeof r !== 'object') throw invalidInput('"review" must be an object.');
  const deadlineAt = iso(r.deadline_at, 'review.deadline_at');
  if (!deadlineAt || typeof r.met !== 'boolean') throw invalidInput('"review" needs deadline_at and met.');
  return {
    deadlineRef,
    deadlineAt,
    forecastAt: iso(r.forecast_at, 'review.forecast_at'),
    completedAt: iso(r.completed_at, 'review.completed_at'),
    met: r.met,
    verdictAtAccept: typeof r.verdict_at_accept === 'string' ? r.verdict_at_accept : null,
    blockers: strings(r.blockers, 'review.blockers'),
    avoidableWaitMin: typeof r.avoidable_wait_min === 'number' ? Math.max(0, r.avoidable_wait_min) : 0,
    allocationMistakes: strings(r.allocation_mistakes, 'review.allocation_mistakes'),
    delays: strings(r.delays, 'review.delays'),
    improvements: strings(r.improvements, 'review.improvements'),
    causes: strings(r.causes, 'review.causes'),
  };
}

const recordTool: McpTool = {
  name: 'brain_deadline_record',
  title: 'Record how a deadline went',
  description:
    'After a deadline is met or missed: records each finished task (kind, started_at, finished_at) as estimate vs actual — ' +
    'the samples the next brain_deadline_plan estimates from — and one review: original forecast, actual completion, ' +
    'blockers, avoidable waiting, allocation mistakes, verification and deployment delays, improvements, and short causes ' +
    '(e.g. SEQUENTIAL_DIAGNOSIS, OVERLAPPING_DEPLOYS). A cause in two reviews becomes a hazard on every later plan. ' +
    'Idempotent: the same deadline and task recorded again is the same row.',
  inputSchema: {
    type: 'object',
    properties: {
      deadline_ref: { type: 'string', description: 'A stable name for this deadline (a session id, campaign id, or label).' },
      tasks: TASK_SCHEMA,
      failed_task_ids: { type: 'array', items: { type: 'string' }, description: 'Finished tasks that had to be repeated.' },
      samples: SAMPLES_SCHEMA,
      review: {
        type: 'object',
        properties: {
          deadline_at: { type: 'string' }, forecast_at: { type: 'string' }, completed_at: { type: 'string' }, met: { type: 'boolean' },
          verdict_at_accept: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } },
          avoidable_wait_min: { type: 'number' }, allocation_mistakes: { type: 'array', items: { type: 'string' } },
          delays: { type: 'array', items: { type: 'string' } }, improvements: { type: 'array', items: { type: 'string' } },
          causes: { type: 'array', items: { type: 'string' } },
        },
        required: ['deadline_at', 'met'],
        additionalProperties: false,
      },
    },
    required: ['deadline_ref', 'tasks'],
    additionalProperties: false,
  },
  annotations: { title: 'Deadline record', ...MUTATING },
  run: async (args, { principal }) => {
    const deadlineRef = requiredString(args, 'deadline_ref').slice(0, 200);
    const answer = await recordDeadline({
      deadlineRef,
      tasks: parseTasks(args),
      failedTaskIds: strings(args.failed_task_ids, 'failed_task_ids'),
      review: review(args, deadlineRef),
      samples: parseSamples(args),
      recordedBy: `${principal.type}:${principal.id}`,
    });
    return { projectId: null, value: answer as unknown as Record<string, unknown> };
  },
};

export const DEADLINE_TOOLS: readonly McpTool[] = [planTool, recordTool];
