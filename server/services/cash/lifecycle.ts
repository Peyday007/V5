/**
 * Turning the section on, winding it down, and what each of those actually
 * stops.
 *
 * ---------------------------------------------------------------------------
 * The one thing winding down must never do
 * ---------------------------------------------------------------------------
 *
 * `russell_cycle` is a **singleton**. Pausing it stops the entire Russell tick:
 * writeback, request resumption, mission launches, the frontier, every other
 * project, every other person. Connecting a sprint's off switch to it would
 * stop the Brain in order to end one person's sprint, and it would look like it
 * had worked.
 *
 * So nothing in Cash Mode calls `pauseCycle`, and that is asserted by a test
 * that reads this directory rather than trusted to this comment. What winding
 * down stops is **new discovery** — the one producer that creates opportunities
 * and the one admission that launches their ideas. Delivery, collection,
 * settlement, needs, money and every opportunity already in the portfolio keep
 * their ordinary execution in every state, because a sprint ending is not a
 * customer's obligation ending.
 *
 * ---------------------------------------------------------------------------
 * Which envelope, and why it is a row rather than a constant
 * ---------------------------------------------------------------------------
 *
 * The *set* of envelopes a cash project may compile under is
 * `SELECTABLE_CASH_ENVELOPES`, in code, reviewed. Which one a given project
 * uses is a person's recorded decision, because the four private operations run
 * in projects an operator creates and this repository cannot know their slugs.
 * §16's property is preserved exactly: nobody supplies the limits their own
 * plan is judged against — a mode may only *choose* from limits somebody else
 * wrote.
 */
import { getProject } from '../../repos/projects.ts';
import { createLayer, listLayers } from '../../repos/layers.ts';
import {
  activateCashMode,
  getCashMode,
  recordCashEvent,
  transitionCashMode,
} from '../../repos/cashMode.ts';
import { getApprovalEnvelope } from '../research/approvalEnvelope.ts';
import { ensureDiscoveryAuthority, withdrawDiscoveryAuthority } from './discoveryAuthority.ts';
import { opportunitiesForCandidate } from '../../repos/cashPortfolio.ts';
import { roundForCandidate } from '../../repos/cashDiscovery.ts';
import { industryRoundForCandidate } from '../../repos/industry.ts';
import type {
  CashMode,
  CashModeState,
  CashOpportunityState,
} from '../../domain/types.ts';

/**
 * The envelopes a cash project's compiled discovery may run under.
 *
 * One entry, deliberately. A second is a code change somebody reviews, which is
 * where "does this authorize an effect?" gets asked — the same argument
 * `probeEnvelope.ts` and `approvalEnvelope.ts` already make about widening.
 */
export const SELECTABLE_CASH_ENVELOPES = ['RUSSELL_CASH_DISCOVERY_V1'] as const;
export type SelectableCashEnvelope = (typeof SELECTABLE_CASH_ENVELOPES)[number];

export const DEFAULT_CASH_ENVELOPE: SelectableCashEnvelope = 'RUSSELL_CASH_DISCOVERY_V1';

/**
 * Where a sprint's work is filed when the project has nowhere yet.
 *
 * One layer, named for what it holds. A sprint is a temporary section and its
 * research is about openings, so the name says that rather than naming the
 * sprint — the layer outlives the wind-down, along with the income, the
 * customers and the records.
 */
export const CASH_LAYER_NAME = 'Opportunity Research';

/** The default rolling outlook. A planning view, never an eligibility gate. */
export const DEFAULT_HORIZON_DAYS = 7;

/**
 * The currencies a sprint may be denominated in.
 *
 * A sprint is pinned to exactly one, and every entry, commitment and derived
 * figure is in it. That is deliberately the small answer: deriving a separate
 * position per currency is the general one and is not what one person's bounded
 * run needs, and adding two currencies into a total that carries a single label
 * is the defect this replaces. A second currency is a second sprint.
 */
export const SPRINT_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD'] as const;
export type SprintCurrency = (typeof SPRINT_CURRENCIES)[number];

export function isSprintCurrency(value: unknown): value is SprintCurrency {
  return typeof value === 'string' && (SPRINT_CURRENCIES as readonly string[]).includes(value);
}

export function isSelectableCashEnvelope(value: unknown): value is SelectableCashEnvelope {
  return (
    typeof value === 'string' && (SELECTABLE_CASH_ENVELOPES as readonly string[]).includes(value)
  );
}

export type LifecycleOutcome =
  | { ok: true; mode: CashMode; changed: boolean; message: string }
  | { ok: false; reason: string };

/**
 * Activate the section for one project.
 *
 * Idempotent by the project: activating twice is one mode, and the caller is
 * told which happened because "already running since Tuesday" and "started" are
 * different sentences to show a person.
 */
export async function activate(input: {
  projectId: string;
  ownerUserId: string;
  actorUserId: string;
  objective: string;
  horizonDays?: number;
  envelopeId?: string;
  currency?: string;
}): Promise<LifecycleOutcome> {
  const objective = input.objective.trim();
  if (objective.length < 12) {
    return {
      ok: false,
      reason:
        'A cash sprint needs an objective somebody wrote. "Make money" is not one: say what this ' +
        'account is trying to produce and over what horizon.',
    };
  }
  const envelopeId = input.envelopeId ?? DEFAULT_CASH_ENVELOPE;
  if (!isSelectableCashEnvelope(envelopeId)) {
    return {
      ok: false,
      reason:
        `"${envelopeId}" is not an envelope a cash project may run discovery under. The set is ` +
        'fixed in code and adding to it is a change somebody reviews.',
    };
  }
  if (!getApprovalEnvelope(envelopeId)) {
    return {
      ok: false,
      reason: `The envelope "${envelopeId}" is not defined in this build, so nothing could compile under it.`,
    };
  }
  const currency = input.currency ?? 'USD';
  if (!isSprintCurrency(currency)) {
    return {
      ok: false,
      reason:
        `"${currency}" is not a currency a sprint can be kept in. A sprint holds exactly one, ` +
        `and the set is: ${SPRINT_CURRENCIES.join(', ')}.`,
    };
  }
  const project = await getProject(input.projectId);
  if (!project) return { ok: false, reason: 'No project with that id.' };

  /*
   * A private operation needs somewhere to file what it finds, and a project
   * created for one has nowhere.
   *
   * `standingAuthority` refuses every launch on a project with no layer —
   * "this project having a layer to file the work under" — and nothing in any
   * route or command creates one: `server/seed.ts` gives the seeded project
   * its layers and a project an operator creates gets none. So the documented
   * setup for a sprint (§30: four people means four projects) produced a
   * project that could open discovery, capture ideas, and launch nothing, for
   * ever. Every row read as healthy and the portfolio stayed empty, which is
   * the *waiting nobody can resolve* shape at a new altitude — worse than
   * usual, because the remedy did not exist.
   *
   * Activation is the right place: it is the moment the project becomes an
   * operation, it is a person's decision, and it already refuses everything it
   * cannot honour. It creates the layer only when there is none, so a sprint
   * activated on a project that already does research files into what that
   * project already has and nothing here reorganizes it.
   *
   * Found by the deployment smoke test, which is the first thing to set a
   * sprint up the way a person actually would.
   */
  if ((await listLayers(project.id)).length === 0) {
    await createLayer({ projectId: project.id, name: CASH_LAYER_NAME, orderIndex: 0 });
    await recordCashEvent({
      projectId: project.id,
      kind: 'CASH_LAYER_CREATED',
      actorRef: input.actorUserId,
      summary: `Created "${CASH_LAYER_NAME}" so this operation has somewhere to file its work.`,
    });
  }

  const horizon = Math.max(1, Math.trunc(input.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const { mode, created } = await activateCashMode({
    projectId: input.projectId,
    ownerUserId: input.ownerUserId,
    createdByUserId: input.actorUserId,
    objective,
    horizonDays: horizon,
    envelopeId,
    currency,
  });

  /*
   * And the authorization that press actually is.
   *
   * Idempotent by a unique index, so activating twice authorizes once, and run
   * outside the `created` branch on purpose: a sprint activated before this
   * existed is reconciled the next time anything touches it rather than
   * needing a person to press Start again. `ensureDiscoveryAuthority` says in
   * full what it does and does not permit; the short version is that it
   * permits reading published sources and nothing that touches the world.
   */
  await ensureDiscoveryAuthority(input.projectId);

  if (created) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'CASH_MODE_ACTIVATED',
      actorRef: input.actorUserId,
      summary: 'Cash Mode was activated for this project.',
      detail: {
        objective,
        horizonDays: horizon,
        envelopeId,
        currency,
        ownerUserId: input.ownerUserId,
      },
    });
    return {
      ok: true,
      mode,
      changed: true,
      message: 'Cash Mode is active. Discovery can start and nothing has been spent.',
    };
  }
  return {
    ok: true,
    mode,
    changed: false,
    message: `Cash Mode has been ${mode.state.toLowerCase().replace('_', ' ')} here since ${mode.activatedAt}.`,
  };
}

/**
 * Move the lifecycle, with the answering transition every state needs.
 *
 * Every edge is reversible and none of them destroys anything: `ARCHIVED` back
 * to `ACTIVE` exists because archiving deletes no project, customer, permission
 * or learning, so resuming is a decision rather than a recovery. §24's rule that
 * an escalation with no answering transition is stuck rather than waiting,
 * applied to a lifecycle instead of to a park.
 */
export async function setLifecycle(input: {
  projectId: string;
  to: CashModeState;
  actorUserId: string;
  reason: string;
}): Promise<LifecycleOutcome> {
  const mode = await getCashMode(input.projectId);
  if (!mode) {
    return { ok: false, reason: 'Cash Mode has never been activated for this project.' };
  }
  const reason = input.reason.trim();
  if (!reason) {
    return {
      ok: false,
      reason: 'Say why. A lifecycle change with no reason is one nobody can explain afterwards.',
    };
  }
  if (mode.state === input.to) {
    return {
      ok: true,
      mode,
      changed: false,
      message: `Cash Mode is already ${LABELS[input.to]}.`,
    };
  }

  const moved = await transitionCashMode({
    projectId: input.projectId,
    from: mode.state,
    to: input.to,
    reason,
  });
  if (!moved) {
    // Lost the race to somebody pressing the same control. Read back and say
    // what is true now rather than reporting a failure.
    const now = await getCashMode(input.projectId);
    return now
      ? { ok: true, mode: now, changed: false, message: `Cash Mode is ${LABELS[now.state]}.` }
      : { ok: false, reason: 'Cash Mode has never been activated for this project.' };
  }

  await recordCashEvent({
    projectId: input.projectId,
    kind: `CASH_MODE_${input.to}`,
    actorRef: input.actorUserId,
    summary: `Cash Mode moved from ${mode.state} to ${input.to}.`,
    detail: { from: mode.state, to: input.to, reason },
  });

  /*
   * The two edges that change what Brain may read.
   *
   * Archiving withdraws the internal discovery authorization, because a live
   * research grant on a project nobody is working is a widening nobody asked
   * for. Coming back re-authorizes, which is what makes `ARCHIVED → ACTIVE` a
   * decision rather than a recovery. Winding down is deliberately neither:
   * §30 keeps delivery, collection and the research supporting an existing
   * obligation working in every state, and only `openDiscovery` stops.
   *
   * Nothing is destroyed either way. The withdrawn grant keeps its id, its
   * terms and its reason, and every reservation written against it stands.
   */
  if (input.to === 'ARCHIVED') {
    await withdrawDiscoveryAuthority({
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      reason: `The sprint was archived: ${reason}`,
    });
  } else if (input.to === 'ACTIVE') {
    await ensureDiscoveryAuthority(input.projectId);
  }

  const after = await getCashMode(input.projectId);
  if (!after) return { ok: false, reason: 'Cash Mode has never been activated for this project.' };
  return { ok: true, mode: after, changed: true, message: CONSEQUENCE[input.to] };
}

const LABELS: Record<CashModeState, string> = {
  ACTIVE: 'active',
  WINDING_DOWN: 'winding down',
  ARCHIVED: 'archived',
};

/**
 * What each move actually does, in the words a person is owed.
 *
 * Composed by the server rather than by the client, for the same reason
 * `describeAuthority` is: a screen that paraphrased the consequence would
 * eventually paraphrase it wrongly.
 */
const CONSEQUENCE: Record<CashModeState, string> = {
  ACTIVE: 'Cash Mode is active again. New discovery can start.',
  WINDING_DOWN:
    'No new discovery will start. Everything already in the portfolio keeps running — delivery, ' +
    'collection, settlement and the money record are untouched, and so is every other part of ' +
    'this Brain.',
  ARCHIVED:
    'The sprint is archived. Nothing was deleted: customers, delivery obligations, money history, ' +
    'needs and the methods that worked are all still here and still yours, and live work carries ' +
    'on. Only new short-cash discovery has stopped.',
};

/**
 * The states in which somebody is owed something.
 *
 * An opportunity here has a customer, a delivery in progress or money still to
 * collect. Everything before `EXECUTING` is a piece Brain is still deciding
 * about: `READY` means ready to *test*, which is the last moment at which
 * nobody has been promised anything.
 *
 * Declined and archived are deliberately absent. They are pieces the sprint
 * stopped pursuing, and research for one of those is neither support nor an
 * obligation.
 */
const OBLIGATION_STATES: readonly CashOpportunityState[] = Object.freeze([
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
]);

/**
 * May this queued idea be launched, given its project's sprint?
 *
 * The same question `discoveryAllowed` answers, asked about one candidate that
 * is already in the queue rather than about a new one. It lives here rather
 * than inside the loop for the reason `auditRound.ts` is one module: a rule
 * applied by one of two readers is worse than none, because the two eventually
 * disagree about the same idea.
 *
 * Four properties, and each of them is deliberate.
 *
 * **Only a cash idea is affected.** An ordinary research candidate in a project
 * that happens to run a sprint is launchable whatever the sprint's state, which
 * is §30's rule that Cash Mode is a section rather than the definition of what
 * Brain may pursue.
 *
 * **Winding down ends new discovery and never an obligation.** The first
 * version of this read every linked candidate as discovery, so a wind-down
 * stopped Brain researching a question it needed in order to *deliver* what a
 * customer had already been promised — which is the off switch reaching past
 * the thing it owns, one altitude below the `russell_cycle` mistake this module
 * was written to refuse. An idea about an opportunity in
 * `OBLIGATION_STATES` is support work, and support work is not discovery.
 *
 * **What the link means is read from the column, not inferred.**
 * `candidate_id` is the idea an opportunity *is*; `discovered_by_candidate_id`
 * is the bucket whose mission found it. A bucket is research about none of the
 * openings it found, so a bucket stays discovery however far any one of those
 * openings has progressed.
 *
 * **It is a skip, not a refusal.** The caller is expected to pass over the
 * candidate: no state moves, no attempt is charged, and nothing is written on
 * the row. The idea keeps its place and launches by itself the moment the
 * sprint is active again, which is what makes reactivating a decision rather
 * than a recovery.
 *
 * **The mode is passed in.** The loop already reads one per project per tick,
 * and re-reading it per candidate would make a backlog a crawl. `null` means
 * the project runs no sprint, which is the ordinary case and is launchable.
 */
export async function launchableUnderCashMode(input: {
  candidateId: string;
  mode: CashMode | null;
}): Promise<boolean> {
  if (!input.mode || input.mode.state === 'ACTIVE') return true;

  /*
   * Discovery work is classified by a row that says so.
   *
   * This asked whether the candidate had an opportunity on `candidate_id` and
   * read "no link" as "not a cash idea" — and a discovery bucket has no such
   * link, because its relationship lives on `discovered_by_candidate_id` and a
   * bucket that has not found anything yet has no link at all. So the queued
   * buckets, which are precisely the thing winding down exists to stop, sailed
   * through the guard and kept launching.
   *
   * **Inferring a classification from the absence of a different table's row is
   * what made that possible.** `cash_discovery_rounds` is the statement.
   */
  if (await roundForCandidate(input.candidateId)) return false;

  /*
   * And a kernel question is discovery work for the same reason.
   *
   * Mapping a subject and searching one for openings are both *new* discovery:
   * they start work that spends the allowance to learn something the sprint
   * does not yet know. Classified by a row that says so — `industry_rounds` —
   * rather than inferred from the absence of another table's, which is exactly
   * how the buckets sailed through this guard before `cash_discovery_rounds`
   * existed.
   *
   * A CAPITAL round is here too, and that is the one worth arguing about: it
   * is about an opening the sprint already holds, so it looks like support
   * work. It is not. It starts a fresh research packet to learn something new,
   * and a person who has wound a sprint down has said to stop doing that.
   * Every obligation already entered into — delivering, collecting, settling —
   * runs on, because none of those is a research launch.
   */
  if (await industryRoundForCandidate(input.candidateId)) return false;

  const linked = await opportunitiesForCandidate(input.candidateId);
  if (linked.length === 0) return true;
  return linked.some((one) => OBLIGATION_STATES.includes(one.state));
}

export interface DiscoveryDecision {
  allowed: boolean;
  mode: CashMode | null;
  /** Safe to show a person, and it always names what would change the answer. */
  reason: string;
}

/**
 * May this project create *new* cash discovery right now?
 *
 * The one question the lifecycle actually gates, asked by the producer that
 * creates opportunities and by the admission that launches their ideas. It is
 * asked at both because a guard on one entrance is not a guard.
 */
export async function discoveryAllowed(projectId: string): Promise<DiscoveryDecision> {
  const mode = await getCashMode(projectId);
  if (!mode) {
    return {
      allowed: false,
      mode: null,
      reason:
        'Cash Mode has not been activated for this project, so there is no sprint for a new ' +
        'opportunity to belong to.',
    };
  }
  if (mode.state !== 'ACTIVE') {
    return {
      allowed: false,
      mode,
      reason:
        `Cash Mode is ${LABELS[mode.state]} here, so no new discovery starts. Everything already ` +
        'in the portfolio keeps running; activating it again is what resumes discovery.',
    };
  }
  return { allowed: true, mode, reason: 'Cash Mode is active.' };
}
