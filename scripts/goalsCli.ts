/**
 * The goals door on a terminal — reading every goal in a Brain, filing real
 * recorded work as a goal, and the decisions a person makes about one.
 *
 * Every write calls the same `services/goals/decide.ts` functions the HTTP
 * routes call, so there is one writer per decision (§46 records what a second
 * writer of one decision cost). `--admin` is attribution resolved against the
 * database, never trusted; reaching the shell is the authentication (§26).
 *
 * `file` composes nothing. A goal's intent is the words of the row it is filed
 * from — a change request's objective, a mission's objective, an idea's
 * statement, a packet's assignment — read verbatim, because composing an intent
 * would be Brain manufacturing the judgement the register exists to keep a
 * person's (§43).
 *
 *   npm run goals -- show [--project prj_…]
 *   npm run goals -- file --from <fcp_|fcr_|rms_|rcn_|orc_…> --purpose REVENUE_DIRECT --admin a@b
 *   npm run goals -- pause <wst_…> --reason "…" --admin a@b
 *   npm run goals -- resume <wst_…> --admin a@b
 *   npm run goals -- cancel <wst_…> --reason "…" --admin a@b
 *   npm run goals -- reinstate <wst_…> --admin a@b
 *   npm run goals -- depends <wst_…> <wst_…> --admin a@b
 *   npm run goals -- objective <wst_…> [--intent "…"] [--outcome "…"] --admin a@b
 *   npm run goals -- undepend <wst_…> <wst_other…> --reason "…" --admin a@b
 *   npm run goals -- terms <wst_…> [--outcome "…"] [--due 2026-10-01] [--commitment CUSTOMER] --admin a@b
 *   npm run goals -- create --objective "Generate $10,000 within 30 days using at most $3,000 in starting capital" --project prj_… --admin a@b
 *   npm run goals -- create --reason "Collect 10000 dollars in 30 days" --project prj_… --due 2026-11-27 SETTLED_CASH-1000000-USD-50000-120 --admin a@b
 *   npm run goals -- target <wst_…> SETTLED_CASH-1000000-USD-50000-120 --project prj_… --admin a@b
 *   npm run goals -- plan <wst_…>            (reads and prints; writes nothing)
 *   npm run goals -- check [wst_…]           (release check: each plan's integrity, reads only; GOALS: OK or GOALS: INTEGRITY FAILED)
 *   npm run goals -- industry [wst_…] [--reason "the operator's ambition"]   (§92: reads and prints; writes nothing)
 *
 * A target spec is METRIC-AMOUNT_CENTS-CURRENCY[-CAPITAL_CENTS[-HOURS]], dashes
 * only, so it passes the workflow's id check: the figure, how much, in which
 * currency, and optionally the money and hours a plan may use.
 *
 * This module is the heavy half: it imports the application and opens the
 * database. scripts/goals.ts is the entry point, and it loads this module only
 * in a process that does the work — never in the parent of `plan` and `check`,
 * which only spawns and bounds the children that read (production OOM,
 * 2026-11-21).
 */
import { planningReport, planningReportLines } from '../server/services/goals/planningReport.ts';
import { committeeLines } from '../server/services/goals/committee.ts';
import { bestLabel, candidateLine, outcomeLines, planHeaderLines, reconcileFigures } from '../server/services/goals/figures.ts';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { finishesWithin } from './boundedChild.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { lastPlanTrace } from '../server/services/cash/goalScenario.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent, supersedeLink } from '../server/repos/register.ts';
import { getCampaign, getChangeRequest } from '../server/repos/factory.ts';
import { getMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { getOrchestration } from '../server/repos/research.ts';
import { listProjects } from '../server/repos/projects.ts';
import { WORKSTREAM_PURPOSES, type LinkKind, type WorkstreamPurpose } from '../server/domain/register.ts';
import { GOAL_COMMITMENTS, type GoalCommitment } from '../server/domain/goals.ts';
import { assembleGoals, type GoalView } from '../server/services/goals/model.ts';
import { briefFrom } from '../server/services/goals/briefing.ts';
import { unfiledWork } from '../server/services/register/unfiled.ts';
import { cancel, changeObjective, createGoal, pause, reinstate, resume, setDependency, setTerms } from '../server/services/goals/decide.ts';
import { spendingRuleSentence } from '../server/services/goals/spending.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { harvest } from '../server/services/cash/discovery.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { latestMissionForCandidate } from '../server/repos/russellMissions.ts';
import { getCycle } from '../server/repos/russellCycle.ts';
import { getDb } from '../server/db/database.ts';
import { workforceView } from '../server/services/fleet/workforce.ts';
import { shortlistFunnel } from '../server/services/feeds/run.ts';
import { discoveryYield, type YieldRow } from '../server/services/cash/discoveryYield.ts';
import { sharedFleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { researchGoalPaths } from '../server/services/goals/pathResearch.ts';
import { setTarget, setTargetLimits } from '../server/services/goals/target.ts';
import { methodYield, recentExplorations } from '../server/services/goals/reasoning/learning.ts';
import { integrityLines } from '../server/services/goals/planIntegrityInput.ts';
import { executorLine, planExecution } from '../server/services/goals/stepExecutor.ts';
import { askConstructedArrangements, askPathwayConstructions, CHAIN_LABEL, goalArrangements, goalLimits, readGoalPlan, listReadings, type PlanReading } from '../server/services/goals/plan.ts';
import { constructArrangements } from '../server/services/cash/construct.ts';
import { renderPathways } from '../server/services/goals/pathways.ts';
import { renderReconstruction } from '../server/services/goals/reconstruction.ts';
import { goalExclusions } from '../server/services/cash/exclusions.ts';
import { targetProperties } from '../server/services/cash/properties.ts';
import { executionFrame, MAX_LIVE_GOAL_ROUNDS } from '../server/services/cash/discovery.ts';
import { assembleEvidence, evidenceFromMap, goalConstruction } from '../server/services/industry/construction/service.ts';
import { constructIndustry, renderConstruction } from '../server/services/industry/construction/construction.ts';
import { interpretIntent } from '../server/services/industry/construction/intent.ts';

class Halt extends Error {}

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function words(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i]!.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  console.log('GOALS: FAIL');
  process.exitCode = 1;
  throw new Halt();
}

async function administrator(): Promise<string> {
  const email = flag('admin');
  if (!email) fail('This changes something, so it needs --admin <email> to record it against.');
  const user = await getUserByEmail(email);
  if (!user || !user.isBrainAdmin || user.disabledAt) fail(`${email} is not an enabled administrator of this Brain.`);
  return user.id;
}

function hours(value: number | null): string {
  if (value === null) return 'age unknown';
  return value >= 48 ? `${Math.round(value / 24)}d` : `${value}h`;
}

function printGoal(goal: GoalView): void {
  console.log('');
  console.log(`GOAL ${goal.id}  ${goal.lifecycle}  ${goal.title}`);
  console.log(`  project     ${goal.projectName ?? 'Brain-wide'} (${goal.projectId ?? '—'})`);
  console.log(`  owner       ${goal.owner?.name ?? '—'}   purpose ${goal.purposeLabel}   ${goal.commitmentLabel}${goal.dueAt ? `   due ${goal.dueAt.slice(0, 10)}${goal.overdue ? ' OVERDUE' : ''}` : ''}`);
  console.log(`  intent      ${goal.intent.slice(0, 240)}`);
  console.log(`  outcome     ${goal.outcome ?? 'nobody has said what counts as finished'}`);
  if (goal.target) console.log(`  target      ${goal.target.targetCents / 100} ${goal.target.currency} ${goal.target.metricLabel}: ledger shows ${goal.target.achievedCents / 100}, ${goal.target.remainingCents / 100} to go${goal.target.daysLeft !== null ? `, ${goal.target.daysLeft} day(s) left` : ''}${goal.target.notCounted.length ? ` (not counted: ${goal.target.notCounted.map((one) => `${one.label} ${one.cents / 100}`).join('; ')})` : ''}`);
  console.log(`  authority   ${goal.authority.research}`);
  if (goal.authority.commercial) console.log(`              ${goal.authority.commercial}`);
  console.log(`  state       ${goal.state} — ${goal.stateEvidence}`);
  console.log(`  lifecycle   ${goal.lifecycleReason}`);
  for (const reading of goal.linked) console.log(`  linked      ${reading.kind} ${reading.ref}: ${reading.status}`);
  for (const dependency of goal.dependencies) {
    console.log(`  depends on  ${dependency.goalId} ${dependency.title ?? '(not readable here)'} — ${dependency.met === null ? 'unreadable' : dependency.met ? 'met' : `not met (${dependency.lifecycle})`}`);
  }
  for (const work of goal.work) {
    console.log(`  bin         ${work.binId} ${work.state} priority=${work.priority} attempts=${work.attempts}${work.heldReason ? ` HELD(${work.heldReason})` : ''}${work.workerOnIt ? ' worker-on-it' : ''}${work.dispatch ? ` dispatch=${work.dispatch.state}${work.dispatch.refusal ? `(${work.dispatch.refusal})` : ''}` : ''}`);
  }
  console.log(`  waiting     ${goal.waiting.kind}: ${goal.waiting.detail}${goal.waiting.since ? ` (since ${goal.waiting.since})` : ''}`);
  console.log(`  next        [${goal.next.by}] ${goal.next.action}`);
  if (goal.next.afterwards) console.log(`  afterwards  ${goal.next.afterwards}`);
  for (const blocker of goal.blockers) {
    console.log(`  blocker     ${blocker.text} (${hours(blocker.ageHours)})`);
    console.log(`    remedy    [${blocker.by}] ${blocker.remedy}`);
  }
  for (const decision of goal.decisions) {
    console.log(`  NEEDS YOU   ${decision.kind} ${decision.ref}: ${decision.question}`);
    console.log(`    proposed  ${decision.proposedAction}`);
    for (const choice of decision.choices) console.log(`    - ${choice.label}: ${choice.consequence}`);
    console.log(`    waiting   ${decision.waitingWork.join('; ')}`);
    console.log(`    after     ${decision.afterAnswer}`);
  }
  for (const item of goal.evidence) console.log(`  evidence    ${item.kind} ${item.ref}: ${item.what} [${item.evidence}]`);
  for (const obligation of goal.obligations) console.log(`  obligation  ${obligation}`);
  if (goal.priority) {
    console.log(`  priority    rank ${goal.priority.rank + 1} of owner ${goal.priority.ownerKey}${goal.priority.binPriority !== null ? ` → bin priority ${goal.priority.binPriority}` : ''}`);
    if (goal.priority.belowPrevious) console.log(`    below     ${goal.priority.belowPrevious.criterion}: ${goal.priority.belowPrevious.reason}`);
    if (goal.priority.aboveNext) console.log(`    above     ${goal.priority.aboveNext.criterion}: ${goal.priority.aboveNext.reason}`);
    if (goal.priority.lastMove) console.log(`    moved     ${goal.priority.lastMove.from ?? '—'} → ${goal.priority.lastMove.to} at ${goal.priority.lastMove.at}: ${goal.priority.lastMove.reason}`);
  }
}

async function show(): Promise<void> {
  const project = flag('project');
  const projectIds = project ? [project] : (await listProjects()).map((one) => one.id);
  const snapshot = await assembleGoals({ projectIds: project ? projectIds : null });
  const briefing = briefFrom(snapshot.goals, snapshot.generatedAt);
  console.log(`BRIEFING ${briefing.headline}`);
  for (const item of briefing.delivered) console.log(`  delivered  ${item.title}: ${item.evidence} (${item.ref})`);
  for (const item of briefing.agingBlockers.slice(0, 10)) console.log(`  aging      ${item.title}: ${item.blocker} (${hours(item.ageHours)}) → [${item.by}] ${item.remedy}`);
  for (const item of briefing.decisions) console.log(`  needs-you  ${item.goalTitle}: ${item.question}`);
  for (const goal of snapshot.goals) printGoal(goal);

  const unfiled = await unfiledWork(projectIds);
  console.log('');
  console.log(`UNFILED ${unfiled.length} piece(s) of recorded work no goal accounts for`);
  for (const item of unfiled.slice(0, 40)) {
    console.log(`  ${item.kind} ${item.ref} [${item.status}] ${item.projectId ?? '—'} — ${item.title.slice(0, 120)}`);
  }
  console.log(`GOALS: OK goals=${snapshot.goals.length} unfiled=${unfiled.length}`);
}

/** The row's own words, and the link that points the goal at it. */
async function readRow(ref: string): Promise<{ kind: LinkKind; projectId: string; title: string; intent: string }> {
  if (ref.startsWith('fcp_')) {
    const campaign = await getCampaign(ref);
    if (!campaign) fail(`No campaign ${ref}.`);
    const request = await getChangeRequest(campaign.changeRequestId);
    if (!request) fail(`Campaign ${ref} has no change request.`);
    return { kind: 'CAMPAIGN', projectId: campaign.projectId, title: request.objective.slice(0, 120), intent: request.objective };
  }
  if (ref.startsWith('fcr_')) {
    const request = await getChangeRequest(ref);
    if (!request) fail(`No change request ${ref}.`);
    return { kind: 'CHANGE_REQUEST', projectId: request.projectId, title: request.objective.slice(0, 120), intent: request.objective };
  }
  if (ref.startsWith('rms_')) {
    const mission = await getMission(ref);
    if (!mission) fail(`No mission ${ref}.`);
    return { kind: 'MISSION', projectId: mission.projectId, title: mission.objective.slice(0, 120), intent: mission.objective };
  }
  if (ref.startsWith('rcn_')) {
    const candidate = await getCandidate(ref);
    if (!candidate || !candidate.projectId) fail(`No idea ${ref} filed under a project.`);
    return { kind: 'CANDIDATE', projectId: candidate.projectId, title: candidate.title, intent: candidate.statement };
  }
  if (ref.startsWith('orc_')) {
    const packet = await getOrchestration(ref);
    if (!packet) fail(`No packet ${ref}.`);
    return { kind: 'PACKET', projectId: packet.projectId, title: packet.title, intent: packet.assignment };
  }
  fail(`${ref} is not a campaign, change request, mission, idea or packet id.`);
}

async function file(): Promise<void> {
  const adminId = await administrator();
  const from = flag('from');
  if (!from) fail('file needs --from <row id>.');
  const purpose = flag('purpose') as WorkstreamPurpose | undefined;
  if (!purpose || !(WORKSTREAM_PURPOSES as readonly string[]).includes(purpose)) {
    fail(`file needs --purpose, one of ${WORKSTREAM_PURPOSES.join(', ')}.`);
  }
  const row = await readRow(from);
  const goal = await createWorkstream({
    projectId: row.projectId,
    title: flag('title') ?? row.title,
    intent: row.intent,
    purpose,
    createdByUserId: adminId,
  });
  await linkWorkstream({
    workstreamId: goal.id,
    kind: row.kind,
    ref: from,
    relation: 'PURSUES',
    label: row.title,
    recordedBy: 'PERSON',
    recordedByUserId: adminId,
  });
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: 'WORKSTREAM_OPENED',
    summary: `Filed from ${row.kind} ${from} as ${purpose}; its intent is that row's own words.`,
    actorRef: `person:${adminId}`,
  });
  console.log(`filed ${goal.id} from ${row.kind} ${from}`);
  console.log('GOALS: OK');
}

async function decide(command: string): Promise<void> {
  const adminId = await administrator();
  const [, goalId, otherId] = words();
  if (!goalId || !(await getWorkstream(goalId))) fail(`No goal ${goalId ?? '(none named)'}.`);
  const actorRef = `person:${adminId}`;
  let result;
  switch (command) {
    case 'pause':
      result = await pause(goalId, flag('reason') ?? fail('pause needs --reason.'), actorRef);
      break;
    case 'resume':
      result = await resume(goalId, actorRef);
      break;
    case 'cancel':
      result = await cancel(goalId, flag('reason') ?? fail('cancel needs --reason.'), actorRef);
      break;
    case 'reinstate':
      result = await reinstate(goalId, actorRef);
      break;
    case 'terms': {
      const commitment = flag('commitment') as GoalCommitment | undefined;
      if (commitment && !(GOAL_COMMITMENTS as readonly string[]).includes(commitment)) fail(`--commitment is one of ${GOAL_COMMITMENTS.join(', ')}.`);
      const due = flag('due');
      if (due && !Number.isFinite(Date.parse(due))) fail('--due must be a date.');
      result = await setTerms(
        goalId,
        {
          outcome: flag('outcome'),
          dueAt: due ? new Date(due).toISOString() : undefined,
          commitment,
        },
        actorRef,
      );
      break;
    }
    case 'depends': {
      if (!otherId || !(await getWorkstream(otherId))) fail(`No goal ${otherId ?? '(none named)'} to depend on.`);
      result = await setDependency(goalId, otherId, { actorRef, userId: adminId });
      break;
    }
    case 'objective': {
      const intent = flag('intent');
      const outcome = flag('outcome');
      result = await changeObjective(goalId, { intent, outcome }, actorRef);
      break;
    }
    case 'undepend': {
      const reason = flag('reason') ?? fail('undepend needs --reason.');
      if (!otherId) fail('undepend needs the goal to stop depending on.');
      const live = (await listLinks(goalId)).find((one) => one.kind === 'WORKSTREAM' && one.relation === 'DEPENDS_ON' && one.ref === otherId);
      if (!live) fail(`${goalId} has no live dependency on ${otherId}.`);
      if (await supersedeLink(live.id, reason)) {
        await recordWorkstreamEvent({ workstreamId: goalId, kind: 'LINK_SUPERSEDED', summary: reason, detail: { linkId: live.id }, actorRef });
        result = { ok: true, reason: null, consequence: 'The link is superseded, with its row and reason kept; the goal tick releases its bins on the next pass if nothing else holds them.' };
      } else {
        result = { ok: false, reason: 'The link was already superseded.', consequence: 'Nothing changed.' };
      }
      break;
    }
    default:
      fail(`Unknown command ${command}.`);
  }
  console.log(`${command} ${goalId}: ${result.ok ? 'done' : `not done — ${result.reason}`}`);
  console.log(`  ${result.consequence}`);
  if (!result.ok) fail(`${command} did not happen.`);
  console.log('GOALS: OK');
}

/** A whole number of cents from a flag, or null when it was not given. */
function cents(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) fail(`Expected a whole number of cents, got ${value}.`);
  return Number(value);
}

function parseSpec(spec: string | undefined): { metric: string; amountCents: number; currency: string; capital: number | null; hours: number | null; beforeProof: number | null; perWeek: number | null } {
  if (!spec) fail('Name the target as METRIC-AMOUNT_CENTS-CURRENCY[-CAPITAL_CENTS[-HOURS[-BEFORE_PROOF_CENTS[-PER_WEEK_CENTS]]]], e.g. SETTLED_CASH-1000000-USD-300000-120-30000-75000. Use x to leave one unset.');
  const parts = spec.split('-');
  const metric = parts.slice(0, parts.findIndex((one) => /^\d+$/.test(one))).join('_') || parts[0]!;
  const rest = parts.slice(parts.findIndex((one) => /^\d+$/.test(one)));
  const [amount, currency, capital, hours, beforeProof, perWeek] = rest;
  const optional = (value: string | undefined) => (value === undefined || value === 'x' ? null : Number(value));
  if (!amount || !/^\d+$/.test(amount) || !currency) fail('The target spec needs an amount in cents and a currency.');
  return {
    metric: metric.replace(/-/g, '_'),
    amountCents: Number(amount),
    currency: currency.toUpperCase(),
    capital: optional(capital),
    hours: optional(hours),
    beforeProof: optional(beforeProof),
    perWeek: optional(perWeek),
  };
}

/**
 * `create` and `target`. Creating goes through `createGoal`, the one writer the
 * HTTP route and the operator also call: `--objective "<words>"` lets Brain read
 * the amount, deadline and limits itself; `--reason … --due … SPEC` states them
 * as figures. `target` on a goal whose figure, amount, currency and project are
 * unchanged changes only its limits (`setTargetLimits`), so the count since the
 * target was set is kept (G-5).
 */
async function targetCommand(command: 'create' | 'target'): Promise<void> {
  const adminId = await administrator();
  const actorRef = `person:${adminId}`;
  if (command === 'create') {
    const projectId = flag('project') ?? fail('create needs --project: the project the goal belongs to.');
    // The goals workflow passes the words as --reason; with no target spec beside them they are the
    // objective itself, read by the one objective reader (planning recovery G-2).
    const objective = flag('objective') ?? (words()[1] === undefined ? flag('reason') : undefined);
    let result;
    if (objective !== undefined) {
      const due = flag('due');
      if (due && !Number.isFinite(Date.parse(due))) fail('--due must be a date.');
      result = await createGoal({ projectId, objective, title: flag('title'), dueAt: due ? new Date(due).toISOString() : undefined, resources: flag('resources') ?? null, actorRef, userId: adminId });
    } else {
      const title = flag('reason') ?? fail('create needs --objective "<the goal in words>", or --reason with --due and a target spec.');
      const due = flag('due') ?? fail('create needs --due: a goal with no deadline has no window to count money in.');
      if (!Number.isFinite(Date.parse(due))) fail('--due must be a date.');
      const spec = parseSpec(words()[1]);
      result = await createGoal({
        projectId,
        objective: title,
        dueAt: new Date(due).toISOString(),
        target: { metric: spec.metric, amountCents: spec.amountCents, currency: spec.currency, capitalCeilingCents: spec.capital, hoursCeiling: spec.hours, capitalBeforeProofCents: cents(flag('before-proof')) ?? spec.beforeProof, capitalPerWeekCents: cents(flag('per-week')) ?? spec.perWeek },
        resources: flag('resources') ?? null,
        actorRef,
        userId: adminId,
      });
    }
    const r = result.reading;
    console.log(`  read        ${r.kind}${r.amount !== null ? ` ${r.amount} ${r.currency ?? '(no currency)'}` : ''}${r.deadline ? ` by ${r.deadline}` : ''}${r.capitalCeiling !== null ? ` · capital at most ${r.capitalCeiling}` : ''}${r.hoursCeiling !== null ? ` · hours at most ${r.hoursCeiling}` : ''}`);
    for (const c of r.constraints) console.log(`  constraint  ${c}`);
    for (const u of r.unread) console.log(`  unread      ${u}`);
    if (!result.ok) fail(`The goal was not created: ${result.reason}`);
    const t = result.target;
    console.log(`create ${result.goal.id}: ${t ? `target ${t.metric} ${t.amountCents / 100} ${t.currency} counted from ${t.setAt}` : 'no target — measured by its delivered work'}`);
    console.log(`  ${result.consequence}`);
    console.log('GOALS: OK');
    return;
  }
  const projectId = flag('project') ?? fail('A target needs --project: the project whose ledger counts.');
  const [, goalId, specWord] = words();
  const goal = goalId ? await getWorkstream(goalId) : null;
  if (!goal) fail(`No goal ${goalId ?? '(none named)'}.`);
  const spec = parseSpec(specWord);
  const limits = { capitalCeilingCents: spec.capital, hoursCeiling: spec.hours, resources: flag('resources') ?? null, capitalBeforeProofCents: cents(flag('before-proof')) ?? spec.beforeProof, capitalPerWeekCents: cents(flag('per-week')) ?? spec.perWeek };
  const was = goal.target;
  const onlyLimits = was !== null && was.metric === spec.metric && was.amountCents === spec.amountCents && was.currency === spec.currency && was.projectId === projectId;
  const result = onlyLimits
    ? await setTargetLimits({ goal, ...limits, resources: flag('resources') })
    : await setTarget({ goal, metric: spec.metric, amountCents: spec.amountCents, currency: spec.currency, projectId, ...limits });
  if (!result.ok) fail(`The target was not set: ${result.reason}`);
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: onlyLimits ? 'GOAL_TARGET_LIMITS_SET' : 'GOAL_TARGET_SET',
    summary: `${onlyLimits ? 'Limits' : 'Target'}: ${spec.metric} ${spec.amountCents / 100} ${spec.currency}${spec.capital !== null ? `, at most ${spec.capital / 100} tied up` : ''}${spec.hours !== null ? `, at most ${spec.hours} hours` : ''}. ${onlyLimits ? `Still counted from ${result.target.setAt}.` : 'Counted from now.'}`,
    detail: onlyLimits ? { before: was } : undefined,
    actorRef,
  });
  console.log(`target ${goal.id}: ${onlyLimits ? 'limits changed; ' : ''}target ${spec.metric} ${spec.amountCents / 100} ${spec.currency} counted from ${result.target.setAt}`);
  console.log('GOALS: OK');
}

/** What the goal is doing about its own gap: its search rounds and its path research. */
async function printSearching(reading: PlanReading): Promise<void> {
  const prefix = `goal-${reading.goalId}`;
  const rounds = (await listRounds(reading.target.projectId)).filter((one) => one.bucketId === prefix || one.bucketId.startsWith(`${prefix}-`));
  const cycle = await getCycle();
  console.log(`  tick        ${cycle ? `${cycle.state}, last ran ${cycle.lastRanAt ?? 'never'}${cycle.lastError ? `; last problem: ${cycle.lastError.slice(0, 400)}` : ''}` : 'no tick has run'}`);
  // The repair-to-goal loop (§88): what the capability check last found blocking this goal,
  // what a repair cleared, and when the goal was resumed because of it. Rows, not a heartbeat.
  const checks = await getDb().all<{ created_at: string; payload: string }>(
    `SELECT created_at, payload FROM project_events WHERE entity_type = 'WORKSTREAM' AND entity_id = ? AND event_type = 'CAPABILITY_ASSESSED'
      ORDER BY created_at DESC LIMIT 3`,
    [reading.goalId],
  );
  for (const one of checks) {
    let p: { ready?: boolean; blocking?: string[]; cleared?: string[] } = {};
    try {
      p = JSON.parse(one.payload) as typeof p;
    } catch {
      p = {};
    }
    console.log(`  check       ${one.created_at} ready=${p.ready ?? '?'} blocking=${(p.blocking ?? []).join(',') || 'none'} cleared=${(p.cleared ?? []).join(',') || 'none'}`);
  }
  const resumes = await getDb().all<{ created_at: string; summary: string }>(
    `SELECT created_at, summary FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_RESUMED_AFTER_REPAIR' ORDER BY created_at DESC LIMIT 3`,
    [reading.goalId],
  );
  for (const one of resumes) console.log(`  resumed     ${one.created_at} ${one.summary.slice(0, 200)}`);
  // Who can do this research: a search or a path question needs a worker that can open the web.
  const snapshot = await sharedFleetSnapshot();
  const research = snapshot.candidates.filter(
    (c) => c.servesProjects.includes(reading.target.projectId) && (!Array.isArray(c.servesFamilies) || c.servesFamilies.includes('RESEARCH')),
  );
  const line = (c: (typeof research)[number]) => `${c.routine.name ?? c.routine.id} ${c.routine.state}${c.webBlocked ? ' NO-WEB' : ''}`;
  console.log(`  workers     ${research.filter((c) => c.routine.state === 'ENABLED' && !c.webBlocked).length} can do web research now, of ${research.length}: ${research.map(line).join('; ')}`);
  // Which ways of looking have paid off: openings filed, how many have a known payer, research spent.
  const found = await discoveryYield(reading.target.projectId);
  const show = (r: YieldRow) => `${r.key} ${r.useful}/${r.openings} useful${r.qualified ? ` ${r.qualified} qualified` : ''}${r.rounds ? `, ${r.rounds} search(es) ${r.failedRounds} failed, ${r.fragments} research jobs` : ''}`;
  console.log(`  methods     ${found.byMethod.slice(0, 12).map(show).join(' · ')}`);
  console.log(`  sources     ${found.bySource.slice(0, 12).map(show).join(' · ')}`);
  // How the workforce, the free AI and the code feeds ran in the last day.
  const wf = await workforceView({ mayRead: () => true });
  console.log(`  workforce   24h: ${wf.totals.completed24h} jobs finished, ${wf.totals.researchPasses24h} research passes, ${wf.totals.connected} accounts connected, ${wf.totals.working} working now, ${wf.totals.idleWithWork} idle with work waiting; queue ${wf.queue.ready} ready ${wf.queue.leased} in progress`);
  for (const a of wf.accounts) {
    const d = a.last24h;
    console.log(`    account   ${a.name}: ${a.status} · routines ${a.routines.usable}/${a.routines.total} usable · 24h started ${d.started} arrived ${d.arrived} took ${d.assigned} finished ${d.completed} handed back ${d.handedBack} failed ${d.failed} passes ${d.researchPasses}${a.heldReasons.length ? ` · held: ${a.heldReasons.join('; ').slice(0, 200)}` : ''}`);
  }
  const cheap = await getDb().all<{ kind: string; model: string; total: number | string; failed: number | string }>(
    `SELECT kind, model, COUNT(*) AS total, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS failed
       FROM cheap_results WHERE created_at >= ? GROUP BY kind, model ORDER BY kind, model`,
    [new Date(Date.now() - 24 * 60 * 60_000).toISOString()],
  );
  console.log(`  free AI     24h: ${cheap.reduce((n, r) => n + Number(r.total), 0)} answers, ${cheap.reduce((n, r) => n + Number(r.failed ?? 0), 0)} failed`);
  for (const r of cheap) console.log(`    free AI   ${r.kind} ${r.model}: ${r.total} answers, ${r.failed ?? 0} failed`);
  const feeds = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM feed_items WHERE fetched_at >= ?`, [new Date(Date.now() - 24 * 60 * 60_000).toISOString()]).catch(() => null);
  const funnel = await shortlistFunnel(reading.target.projectId).catch(() => null);
  console.log(`  code feeds  24h: ${feeds ? Number(feeds.n) : '?'} new items pulled; ${funnel ? `pool ${funnel.pool}, screened by free AI ${funnel.screened}, kept ${funnel.kept}, passed rules ${funnel.passedRules}, sent to Claude ${funnel.chosen.length}` : 'funnel unreadable'}`);
  const t = reading.target;
  const frame = await executionFrame(t.projectId, t.currency);
  void frame;
  // The plan's own construction, held for ten minutes: composing 404 arrangements again over one connection took 7.5 min.
  const built = await goalArrangements((await getWorkstream(reading.goalId))!, t, new Date(), goalLimits(reading).bestReachCents);
  console.log(`  targets     ${targetProperties(goalLimits(reading)).map((one) => `${one.property} (${one.because})`).join('; ') || 'none: the limits of this goal ask for no particular property'}`);
  console.log(`  excluded    ${(await goalExclusions((await getWorkstream(reading.goalId))!)).join(', ') || 'nothing the owner said to leave out'}`);
  const byOrigin = new Map<string, number>();
  const byExposure = new Map<string, number>();
  for (const one of built) {
    byOrigin.set(one.origin, (byOrigin.get(one.origin) ?? 0) + 1);
    byExposure.set(one.stress.exposure, (byExposure.get(one.stress.exposure) ?? 0) + 1);
  }
  console.log(`  designs     ${[...byOrigin].map(([k, v]) => `${k} ${v}`).join(', ')} · worst case ${[...byExposure].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const byStructure = new Map<string, number>();
  for (const one of built) byStructure.set(one.structure, (byStructure.get(one.structure) ?? 0) + 1);
  console.log(`  constructed ${built.length} arrangement(s) composed from the industry map, evidenced payers and proved deliverables${byStructure.size ? ` (${[...byStructure].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  for (const one of built.slice(0, 16)) {
    const asked = rounds.filter((r) => r.bucketId.endsWith(`-mx-${one.key}`));
    console.log(`    ${one.key} ${one.origin.padEnd(8)} ${one.structure.padEnd(11)} ${one.design.funding}/${one.design.aggregation}/${one.design.repeat} · worst case ${one.stress.exposure}${one.stress.worstCaseCents ? ` ${one.stress.worstCaseCents / 100}` : ''} · meets ${one.targetsMet.join(',') || '—'}${one.emergent.length ? ` · also ${one.emergent.join(',')}` : ''}${one.precedent ? ` · from "${one.precedent.title.slice(0, 40)}"` : ''}`);
    console.log(`      claims ${one.evidenced} · value ${one.value.tier}${one.value.observations ? ` p10 ${round(one.value.p10)} p50 ${round(one.value.p50)} p90 ${round(one.value.p90)} (${one.value.observations} obs)` : ''} · to establish: ${one.unknownParts.join(', ')} · ${asked.length ? `asked ${asked.length}x (${asked.map((r) => r.state).join(',')})` : 'not asked yet'} · ${one.label.slice(0, 90)}`);
  }
  console.log(`  searching   ${rounds.length} round(s) of this goal's own search`);
  for (const round of rounds) {
    const mission = await latestMissionForCandidate(round.candidateId);
    // With no mission, the idea's own state says why: queued for a slot, parked, or refused.
    const idea = mission ? null : await getCandidate(round.candidateId);
    const waiting = idea ? `not launched yet (idea ${idea.state}${idea.reason ? `: ${idea.reason.replace(/\s+/g, ' ').slice(0, 200)}` : ''})` : 'not launched yet';
    console.log(`    ${round.bucketId.slice(prefix.length + 1) || 'open'} round ${round.round} ${round.state} found ${round.found ?? '—'} · idea ${round.candidateId} · mission ${mission ? `${mission.id} ${mission.state}${mission.orchestrationId ? ` · packet ${mission.orchestrationId}` : ''}${(mission.terminalReason ?? mission.waitingOn) ? ` (${(mission.terminalReason ?? mission.waitingOn)!.replace(/\s+/g, ' ').slice(0, 300)})` : ''}` : waiting}`);
  }
  const ids = new Set(reading.considered.map((one) => one.opportunityId));
  // Every research question on these openings, whichever pass raised it: the
  // engine-gap pass and the goal's path research share one question key.
  const needs = (await listNeeds({ projectId: reading.target.projectId })).filter(
    (one) => one.opportunityId && ids.has(one.opportunityId) && one.requestKey?.startsWith('question:'),
  );
  console.log(`  digging     ${needs.length} research question(s) on openings it holds`);
  const trace: string[] = [];
  await researchGoalPaths({ reading, projectId: reading.target.projectId, dryRun: true, trace });
  for (const line of trace) console.log(`    next: ${line}`);
  // Grouped by what became of each: whether its research is running, done, or
  // ended without an answer — and the reason it gave — so a stall is readable.
  const groups = new Map<string, number>();
  for (const need of needs) {
    const candidate = need.candidateId ? await getCandidate(need.candidateId) : null;
    const mission = candidate ? await latestMissionForCandidate(candidate.id) : null;
    const why = mission?.terminalReason ?? mission?.waitingOn ?? candidate?.reason ?? '';
    const key = `${need.state} ${need.requestKey?.split(':').pop()} · idea ${candidate?.state ?? 'none'} · mission ${mission?.state ?? 'none'}${why ? ` · ${why.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`    ${String(count).padStart(3)}x ${key}`);
}

async function printPlan(reading: PlanReading): Promise<void> {
  const t = reading.target;
  console.log(`PLAN ${reading.goalId}  ${reading.verdict}`);
  // The owner's permanent planning report first (2026-11-23): never a coverage figure in place of a real-world probability.
  const due = t.daysLeft === null ? null : new Date(Date.now() + t.daysLeft * 86_400_000).toISOString();
  for (const line of planningReportLines(planningReport(reading, due))) console.log(line);
  console.log(`  target      ${t.targetCents / 100} ${t.currency} ${t.metricLabel}; ledger shows ${t.achievedCents / 100} since ${t.since.slice(0, 10)}; ${t.remainingCents / 100} to go; ${t.daysLeft ?? '—'} day(s) left`);
  for (const one of t.notCounted) console.log(`  not counted ${one.label}: ${one.cents / 100} ${t.currency}`);
  console.log(`  limits      capital ${t.capitalCeilingCents === null ? 'not stated (the owner has not said how much may be committed)' : t.capitalCeilingCents / 100} · hours ${t.hoursCeiling ?? 'not stated'}`);
  console.log(`  resources   ${t.resources ?? 'not stated'}`);
  console.log(`  spending    ${spendingRuleSentence(t) ?? 'no pace set'}`);
  console.log(`  verdict     ${reading.summary}`);
  const acc = reading.acceptance;
  console.log(`  acceptance  ${acc.status} (requires a defensible ${Math.round(acc.required * 100)}% chance of collecting the target before the deadline) · ${acc.sentence}`);
  if (acc.probability) console.log(`    basis     ${acc.probability.basis} ${Math.round(acc.probability.value * 1000) / 10}% (lower bound ${Math.round(acc.probability.lowerBound * 1000) / 10}%, n=${acc.probability.sample}) · ${acc.probability.note}`);
  // Which printed figures are the held plan's and which another combination's (§77): one reconciliation, read by every line below.
  const figures = reconcileFigures(reading);
  const candidate = candidateLine(reading, figures);
  if (candidate) console.log(candidate);
  for (const why of acc.shortfalls) console.log(`    short     ${why}`);
  if (acc.blocker) console.log(`    blocker   ${acc.blocker}`);
  for (const leg of acc.legs ?? []) if (!leg.supported) console.log(`    leg       ${leg.opportunityId} not executable · lacks ${leg.lacks.join(', ')}${leg.permissions.length ? ` · waits on ${leg.permissions.join(', ')}` : ''}`);
  // The plan's outcome from the one source (the simulated worlds), split by what supports it.
  for (const line of outcomeLines(reading, figures)) console.log(line);
  for (const v of reading.integrity ?? []) console.log(`  integrity   ${v.rule}: ${v.detail}`);
  // The investment committee (§117): each role's verdict and the defects it cites.
  if (reading.committee) for (const line of committeeLines(reading.committee)) console.log(line);
  // One plan (C-6): which plan this is, and whether the reconstruction below is only hypothetical.
  for (const line of planHeaderLines(reading, figures)) console.log(line);
  if (reading.infeasible) {
    console.log(`  infeasible  ${reading.infeasible.reason}`);
    for (const r of reading.infeasible.relax) console.log(`    relax     ${r.constraint}: ${r.suggestion}`);
  }
  // The adopted plan as an execution sequence (C-8).
  for (const s of reading.steps ?? []) {
    // Who performs it, never who waits: a payment or a signature is an approval, and is said as one.
    const by = s.executor ? (s.executor.performedBy === 'CAPABILITY_MISSING' ? 'MISSING' : s.executor.performedBy === 'NOT_ESTABLISHED' ? 'UNSPECIFIED' : s.executor.performedBy) : s.owner;
    console.log(`  step ${String(s.order).padStart(2)}     [${by}] ${s.label}${s.startDay ? ` · day ${s.startDay.low}${s.startDay.high !== s.startDay.low ? `–${s.startDay.high}` : ''}` : ''} · cost ${s.cost === null ? 'not established' : Math.round(s.cost)} · ${s.basis}${s.dependsOn ? ` · after step ${s.dependsOn}` : ''}`);
    console.log(`    what      ${s.detail.slice(0, 240)}`);
    if (s.when) console.log(`    when      ${s.when}`);
    if (s.executor) console.log(`    by        ${executorLine(s.executor)}`);
    else if (s.ownerReason) console.log(`    owner     ${s.ownerReason}`);
    console.log(`    kill      ${s.kill}`);
    if (s.execution.length) console.log(`    execution ${s.execution.join('; ')} (needed to execute, never to plan)`);
  }
  // The plan's execution in the owner's six parts (2026-11-20), read from the steps' executor records.
  if ((reading.steps ?? []).some((s) => s.executor)) {
    const x = planExecution(reading.steps);
    const part = (name: string, list: string[], none: string) => {
      if (list.length === 0) console.log(`  ${name.padEnd(11)} ${none}`);
      for (const [at, one] of list.entries()) console.log(`  ${(at === 0 ? name : '').padEnd(11)} ${one}`);
    };
    part('brain does', x.brain, 'nothing');
    part('providers', x.providers, 'none');
    part('acquire', x.acquire, 'nothing');
    part('permission', x.permissions, 'none missing');
    part('costs', x.costs, 'no step commits money the model prices');
    part('depends on', x.dependencies, 'nothing outside Brain');
    part('approvals', x.approvals, 'none');
    part('owner work', x.ownerWork, 'none');
    part('unspecified', x.unestablished, 'nothing');
  }
  for (const d of reading.degraded ?? []) console.log(`  DEGRADED    ${d}`);
  console.log(`  pool        ${reading.pool.conclusion}: ${reading.pool.sentence}`);
  if (reading.pathways) {
    for (const line of renderPathways(reading.pathways, 12, figures.leading ? figures.leading.simulated : undefined)) console.log(line);
    // What the next pass would do with the pathways' constructed moves, and why (§93). Opens nothing.
    const goal = await getWorkstream(reading.goalId);
    if (goal) {
      const why: string[] = [];
      await askPathwayConstructions(goal, reading, new Date(), MAX_LIVE_GOAL_ROUNDS, why, true);
      for (const line of why) console.log(`    construct ${line}`);
    }
  }
  console.log(`  considered  ${reading.considered.length} opening(s), ${reading.considered.filter((one) => one.modelled).length} in the simulation; ${reading.needsMoreOpenings ? (reading.acceptance.status === 'ACCEPTED' ? 'an accepted plan exists; Brain keeps searching for stronger openings' : 'no accepted plan, so Brain keeps constructing and searching') : reading.acceptance.status === 'NOT_SUPPORTED' ? 'the goal as stated is infeasible; the search stops until its terms or inputs change' : reading.acceptance.status === 'ACCEPTED' ? 'an accepted plan exists' : 'the deadline has passed or the outcome is recorded; the search has stopped'}`);
  for (const one of reading.considered.slice(0, 8)) {
    console.log(`    ${one.modelled ? 'model' : '     '} ${one.stage.slice(0, 1)} supported ${Math.round(one.supportedReach)} · missing ${one.missing.length ? one.missing.join(',') : 'nothing'} · ${one.title.slice(0, 70)}`);
  }
  printPortfolio(reading.portfolio, bestLabel(figures));
  // Why the plan falls short, what was changed, and the strongest reconstruction (§99).
  if (reading.reconstruction) for (const line of renderReconstruction(reading.reconstruction)) console.log(line);
  // Which ways of reasoning have worked, across every goal, and this goal's recent explorations (§101).
  const yieldRows = await methodYield().catch(() => []);
  if (yieldRows.length) {
    console.log(`  methods     ${yieldRows.reduce((n, x) => n + x.methods, 0)} way(s) of reasoning on record`);
    for (const y of yieldRows.slice(0, 12)) console.log(`    learned   ${y.stance.padEnd(24)} ${y.origin.toLowerCase().padEnd(10)} ${y.methods} method(s), ${y.tries} tri(es), ${y.improvements} improved, ${y.wins} won, mean lift ${(y.meanLift * 100).toFixed(1)}%`);
  }
  for (const x of await recentExplorations(reading.goalId).catch(() => [])) console.log(`    explored  ${x.created_at} ${Number(x.variations).toLocaleString('en-US')} variation(s) of ${x.variables} variable(s), ${x.directions} direction(s), ${x.model_directions} from the model; best ${(x.best_reach * 100).toFixed(1)}% vs greedy ${(x.greedy_reach * 100).toFixed(1)}%${x.replaced ? ' (strategy replaced)' : ''}: ${x.best_method ?? 'greedy kept'}`);
  console.log(`  ladder      ${Object.entries(reading.ladder).map(([stage, n]) => `${stage} ${n}`).join(' · ')}`);
  console.log(`  policy      ${reading.executionPolicy}${reading.executionPolicy === 'SQUEEZE' ? ': a cash target with a deadline; no market-testing phase, sellable openings are sold now, several at once' : ''}`);
  for (const one of reading.sales) {
    console.log(`  sale        ${one.opportunityId} up to ${one.potentialReach === null ? '?' : Math.round(one.potentialReach)} · [${one.test.by}] ${one.title.slice(0, 70)}`);
    if (one.test.blocker) console.log(`    blocker   ${one.test.blocker}`);
    // Research runs beside the sale, never ahead of it: the questions on this opening and where each stands.
    const questions = (await listNeeds({ projectId: reading.target.projectId })).filter((n) => n.opportunityId === one.opportunityId && n.requestKey?.startsWith('question:'));
    for (const q of questions) console.log(`    research  ${q.requestKey!.split(':').pop()} ${q.state}`);
  }
  for (const one of reading.marketTests) {
    console.log(`  market test ${one.opportunityId} up to ${one.potentialReach === null ? '?' : Math.round(one.potentialReach)} · [${one.test.by}] ${one.title.slice(0, 70)}`);
    if (one.test.blocker) console.log(`    blocker   ${one.test.blocker}`);
  }
  if (reading.scenarioRunId) console.log(`  scenario    model ${reading.scenarioModelId} run ${reading.scenarioRunId}`);
  if (reading.basisNote) console.log(`  basis       ${reading.basisNote}`);
  console.log(`  chance      ${reading.measuredChance ? `${Math.round(reading.measuredChance.estimate * 100)}% (${Math.round(reading.measuredChance.lowerBound * 100)}–${Math.round(reading.measuredChance.upperBound * 100)}%, n=${reading.measuredChance.sampleSize}, ${reading.measuredChance.cohort})` : 'not stated: this Brain has too few finished recommended plans to measure one'}`);
  for (const s of reading.strategies) {
    console.log(`  strategy    ${s.key} ${s.verdict}  ${s.label}`);
    const sw = s.sweep;
    if (sw.goalMetShare !== null) console.log(`    sweep     reaches target in ${Math.round(sw.goalMetShare * 100)}% of tested conditions${sw.probabilistic ? ' (probability)' : ' (coverage, not a probability)'}; settled p50 ${Math.round(sw.settledP50 ?? 0)} p90 ${Math.round(sw.settledP90 ?? 0)}; infeasible ${Math.round((sw.infeasibleShare ?? 0) * 100)}%`);
    console.log(`    cautious  ${s.conservativeSettled === null ? 'cannot be computed: an input it needs is unknown' : `${Math.round(s.conservativeSettled)} ${t.currency} settled in time`}`);
    for (const link of s.links) console.log(`    ${link.ok ? 'OK ' : 'MISSING'} ${CHAIN_LABEL[link.link]}: ${link.basis.slice(0, 200)}`);
    for (const failed of s.constraintsFailed) console.log(`    FAILS     ${failed}`);
  }
  if (reading.nextTest) {
    console.log(`  ${reading.executionPolicy === 'SQUEEZE' ? 'next step  ' : 'next test  '} [${reading.nextTest.by}] ${reading.nextTest.test}`);
    if (reading.nextTest.blocker) console.log(`  blocker     ${reading.nextTest.blocker}`);
  }
  for (const one of reading.excluded.slice(0, 15)) console.log(`  left out    ${one.opportunityId} ${one.title.slice(0, 70)}: ${one.reason}`);
  if (reading.excluded.length > 15) console.log(`  left out    … and ${reading.excluded.length - 15} more`);
  // Every reason counted, and every physical-work exclusion listed in full: the owner's
  // rule (§91) refuses only work the owner would do himself, and this is where to check it.
  const byReason = new Map<string, number>();
  for (const one of reading.excluded) {
    const key = one.reason.replace(/:.*$/, '').slice(0, 80);
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  left out ×${String(n).padStart(3)} ${reason}`);
  for (const one of reading.excluded.filter((x) => /physical work/i.test(x.reason))) {
    console.log(`  physical    ${one.opportunityId} ${one.title.slice(0, 80)} — ${one.reason.replace(/^[^:]*: /, '').slice(0, 160)}`);
  }
  // Evidence-only openings become usable only through their validation dive (payer, route, buying
  // evidence). Whether that research is running is the next question when the plan does not move.
  const evidenceOnly = reading.excluded.filter((x) => /^evidence only/.test(x.reason)).map((x) => x.opportunityId);
  if (evidenceOnly.length > 0) {
    const marks = evidenceOnly.map(() => '?').join(',');
    const rows = await getDb().all<{ state: string | null; payer: number | string; price: number | string; channel: number | string; n: number | string }>(
      `SELECT validation_state AS state, (payer IS NOT NULL AND payer <> '') AS payer, (price_cents IS NOT NULL) AS price,
              (reachable_channel IS NOT NULL AND reachable_channel <> '') AS channel, COUNT(*) AS n
         FROM cash_opportunities WHERE id IN (${marks}) GROUP BY 1, 2, 3, 4 ORDER BY COUNT(*) DESC`,
      evidenceOnly,
    );
    for (const r of rows) {
      console.log(`  evidence    ×${String(r.n).padStart(3)} dive ${r.state ?? 'never started'} · payer ${Number(r.payer) ? 'yes' : 'no'} · price ${Number(r.price) ? 'yes' : 'no'} · route ${Number(r.channel) ? 'yes' : 'no'}`);
    }
    // Why the blocked dives stopped: their fragments' own recorded reasons, most common first.
    const why = await getDb().all<{ reason: string; n: number | string }>(
      `SELECT SUBSTR(f.blocked_reason, 1, 140) AS reason, COUNT(*) AS n
         FROM cash_opportunities o JOIN research_fragments f ON f.orchestration_id = o.validation_orchestration_id
        WHERE o.id IN (${marks}) AND o.validation_state = 'BLOCKED' AND f.blocked_reason IS NOT NULL
        GROUP BY SUBSTR(f.blocked_reason, 1, 140) ORDER BY COUNT(*) DESC LIMIT 6`,
      evidenceOnly,
    );
    for (const w of why) console.log(`  dive block  ×${String(w.n).padStart(3)} ${w.reason}`);
  }
  // §79: what was reconstructed instead of swept, and which questions could change the choice.
  const tiers = new Map<string, number>();
  for (const one of reading.inferred) tiers.set(one.tier, (tiers.get(one.tier) ?? 0) + 1);
  console.log(`  inferred    ${reading.inferred.length} unknown(s) reconstructed from evidence instead of swept blind${tiers.size ? ` (${[...tiers].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  for (const one of reading.inferred.slice(0, 12)) {
    console.log(`    ${one.tier.padEnd(10)} ${one.field.padEnd(15)} p10 ${round(one.p10)} · p50 ${round(one.p50)} · p90 ${round(one.p90)} from ${one.observations} obs ${one.justified ? '(distribution)' : '(bounds only)'} · ${one.title.slice(0, 50)}`);
  }
  console.log(`  questions   ${reading.researchPriority.length === 0 ? 'no input moves the goal-met share, so none is ranked' : `${reading.researchPriority.filter((one) => one.changesDecision).length} of ${reading.researchPriority.length} unknown(s) could change the choice`}`);
  for (const one of reading.researchPriority.slice(0, 10)) {
    console.log(`    ${one.decision.padEnd(22)} ${one.variable.padEnd(10)} value ${one.value.toFixed(4)}${one.field ? ` ${one.field}` : ''} — ${one.reason}`);
  }
}

function round(x: number): string {
  return Math.abs(x) < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : String(Math.round(x));
}

/**
 * A line every 30 seconds while a plan read runs: where its trace last was, and
 * whether the event loop is turning (a tick far later than 30s means a
 * synchronous loop held it; on time with no new stage means it waits on I/O).
 * Goal C's read on 2026-11-19 printed nothing for 30 minutes, so nobody could
 * say which.
 */
function heartbeat(label: string): () => void {
  const started = Date.now();
  let last = started;
  const timer = setInterval(() => {
    const now = Date.now();
    const t = lastPlanTrace();
    console.error(`  alive ${label} +${Math.round((now - started) / 1000)}s · tick ${Math.round((now - last) / 1000)}s after the last · last stage ${t ? `${t.scope}: ${t.label.slice(0, 80)} ${Math.round((now - t.at) / 1000)}s ago` : 'none'}`);
    last = now;
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * `goals plan`'s read, in the child process scripts/goals.ts bounds from
 * outside it (#1180; run 44935606985, 2026-11-21: goal C printed its plan and
 * `GOALS: OK`, then background work held the process to the step's 30-minute
 * timeout). The child's verdict ends it; this process only reads and prints.
 */
async function plan(): Promise<void> {
  const [, goalId] = words();
  if (!goalId) fail('plan needs a goal id.');
  const started = Date.now();
  process.env['BRAIN_PLAN_TRACE'] ??= '1';
  const stopBeat = heartbeat(goalId);
  const reading = await readGoalPlan({ goalId, persist: false }).finally(stopBeat);
  if (!reading) fail(`No targeted goal ${goalId}.`);
  await printPlan(reading);
  console.log(`  timing      plan read in ${Date.now() - started} ms; ${reading.inferred.length} inferred input(s), ${reading.researchPriority.length} ranked question(s)`);
  // The plan is read and printed. What follows only describes it, so it may not
  // hold back the verdict: run 44960240885 (2026-11-21) sat in this listing
  // after round 26 of 38 until the step's 30-minute timeout, with no verdict.
  const searching = Date.now();
  let listing = true;
  /*
   * A listing error is a line, not the verdict (release check 45300351663, 2026-11-24): the
   * plan was read in 136 s, then the listing waited 120 s for the one pooled connection that
   * background work the read started still held, and its pool timeout became "GOALS: FAILED".
   */
  const read = reading;
  const readGoal = goalId;
  const listed = await finishesWithin(PLAN_LISTING_MS, () => listSearching(read, readGoal).catch((error: unknown) => {
    console.log(`  timing      the search listing stopped: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}; the plan above is the read`);
  }));
  async function listSearching(reading: PlanReading, goalId: string): Promise<void> {
    await printSearching(reading);
    if (!listing) return;
    console.log(`  timing      search and digging listed in ${Date.now() - searching} ms`);
    const history = await listReadings(goalId);
    if (!listing) return;
    for (const row of history.slice(-10)) console.log(`  history     ${row.created_at} ${row.verdict} chosen=${row.chosen_strategy ?? '—'}${row.scenario_run_id ? ` run=${row.scenario_run_id}` : ''}`);
  }
  listing = false;
  if (!listed) console.log(`  timing      the search listing did not finish within ${PLAN_LISTING_MS / 1000}s and was left; the plan above is the read`);
  console.log('GOALS: OK');
  // The verdict is printed; end the process rather than wait on background work
  // the read started (as check does, #1158). Closing the pool waits for a client
  // that background work may hold, so that wait is bounded too.
  await finishesWithin(2_000, () => closeDatabase().catch(() => undefined));
  process.exit(0);
}

/** `plan`'s search listing after the plan: it describes the read, so it gives up rather than hold back the verdict. */
const PLAN_LISTING_MS = 3 * 60_000;

/**
 * The release check's read of one goal, in the child process scripts/goals.ts
 * spawns per goal (`BRAIN_CHECK_CHILD=1`): the plan read without persisting,
 * and its integrity (`planIntegrity`) printed, one line per goal or per
 * violation. A plan read that throws is an ERROR line and fails the check,
 * exactly as a violation does. With `BRAIN_CHECK_CHILD=list` it prints the ids
 * of every active goal with a cash target instead, so the parent that spawns
 * the reads never opens the database itself.
 */
/** One goal's plan read inside the release check, and the whole check, kept inside goals.yml's 30-minute step. */
const CHECK_PER_GOAL_MS = 6 * 60_000;
const CHECK_TOTAL_MS = 26 * 60_000;

async function check(): Promise<void> {
  const [, ...ids] = words();
  if (process.env['BRAIN_CHECK_CHILD'] === 'list') {
    const rows = await getDb().all<{ id: string }>(
      `SELECT id FROM workstreams WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL ORDER BY id ASC`,
      [],
    );
    for (const row of rows) console.log(`GOAL ${row.id}`);
    console.log('GOALS: OK');
    await closeDatabase().catch(() => undefined);
    process.exit(0);
  }
  const goalIds = ids;
  let failed = 0;
  /*
   * Bounded, so one goal whose plan cannot be read in time is reported as that
   * goal's ERROR rather than taking the whole release check past the
   * workflow's own timeout with nothing printed (goal C on 2026-11-19 ran a
   * plan read past 30 minutes). A read that cannot finish is a failure of the
   * planner for that goal, never a pass. The parent's kill (scripts/goals.ts)
   * is the bound for a read that holds the event loop, which this timer cannot.
   */
  const perGoalMs = CHECK_PER_GOAL_MS;
  const deadline = Date.now() + CHECK_TOTAL_MS;
  for (const goalId of goalIds) {
    if (Date.now() + perGoalMs > deadline) {
      failed += 1;
      console.log(`INTEGRITY ${goalId} ERROR not reached: the check's ${Math.round(CHECK_TOTAL_MS / 60000)}-minute budget was spent on the goals before it`);
      continue;
    }
    try {
      process.env['BRAIN_PLAN_TRACE'] ??= '1';
      const stopBeat = heartbeat(goalId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reading = await Promise.race([
        readGoalPlan({ goalId, persist: false }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the plan read did not finish within ${Math.round(perGoalMs / 1000)}s`)), perGoalMs);
        }),
      ]).finally(() => {
        clearTimeout(timer);
        stopBeat();
      });
      if (!reading) {
        failed += 1;
        console.log(`INTEGRITY ${goalId} ERROR no targeted goal with this id`);
        continue;
      }
      const report = integrityLines(goalId, reading);
      if (!report.ok) failed += 1;
      for (const line of report.lines) console.log(line);
    } catch (error) {
      failed += 1;
      console.log(`INTEGRITY ${goalId} ERROR ${String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  // A read abandoned at its timeout is still running; the verdict is printed, so end the process rather than wait for it.
  if (failed > 0) {
    console.log('GOALS: INTEGRITY FAILED');
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  }
  console.log('GOALS: OK');
  /*
   * The verdict is printed; end the process. Work a plan read started in the
   * background (a model call, a timer) otherwise keeps the event loop alive,
   * and the release check that printed GOALS: OK on 2026-11-19 at 22:22 ran on
   * to the workflow's 30-minute timeout and was reported as failed.
   */
  await closeDatabase().catch(() => undefined);
  process.exit(0);
}

/** Open this pass's constructed rounds now, exactly as the tick would (§81). */
async function construct(): Promise<void> {
  const [, goalId] = words();
  if (!goalId) fail('construct needs a goal id.');
  const goal = await getWorkstream(goalId);
  const reading = await readGoalPlan({ goalId, persist: false });
  if (!goal || !reading) fail(`No targeted goal ${goalId}.`);
  /*
   * The same harvest the sprint tick runs, so this command shows what research
   * already returned becoming openings rather than waiting for the next tick.
   * Idempotent: a claim already filed is never filed twice.
   */
  const filed = await harvest({ projectId: reading.target.projectId, limit: Number(flag('harvest') ?? 20) });
  console.log(`harvest filed ${filed.length} opening(s)`);
  for (const one of filed) console.log(`  filed ${JSON.stringify(one).slice(0, 220)}`);
  await explainConstructedRounds(goal.id, reading.target.projectId);
  await explainIdeaBacklog();
  if (flag('explain') !== undefined) {
    console.log('GOALS: OK');
    return;
  }
  const opened = await askConstructedArrangements(goal, reading, new Date(), Number(flag('max') ?? 2), MAX_LIVE_GOAL_ROUNDS + Number(flag('spare') ?? 0));
  for (const id of opened) await linkWorkstream({ workstreamId: goal.id, kind: 'CANDIDATE', ref: id, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
  console.log(`construct ${goalId}: opened ${opened.length} round(s)${opened.length ? `: ${opened.join(', ')}` : ' (cool-off, live cap or a closed gate)'}`);
  console.log('GOALS: OK');
}

/**
 * Where each of the goal's constructed rounds got to: its research packet, its
 * fragments, the claims the gate accepted, and how many of those said what
 * kind of opening they are — which is what the harvest files from.
 */
async function explainConstructedRounds(goalId: string, projectId: string): Promise<void> {
  const rounds = (await listRounds(projectId)).filter((r) => r.bucketId.startsWith(`goal-${goalId}-mx-`)).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  console.log(`constructed rounds ${rounds.length}: ${['OPEN', 'HARVESTED', 'ABANDONED'].map((s) => `${s}=${rounds.filter((r) => r.state === s).length}`).join(' ')} · openings filed ${rounds.reduce((n, r) => n + r.found, 0)}`);
  for (const round of rounds.slice(0, Number(flag('rounds') ?? 12))) {
    const mission = await latestMissionForCandidate(round.candidateId);
    const orc = mission?.orchestrationId ? await getOrchestration(mission.orchestrationId) : null;
    console.log(`  ${round.openedAt.slice(0, 16)} ${round.state} found=${round.found} ${round.bucketId.slice(round.bucketId.indexOf('-mx-') + 4, round.bucketId.indexOf('-mx-') + 60)}`);
    console.log(`    mission ${mission ? `${mission.state}${mission.waitingOn ? ` waiting on ${mission.waitingOn}` : ''}` : 'none'} · packet ${orc ? `${orc.id} ${orc.status}${orc.failureReason ? `: ${orc.failureReason.slice(0, 220)}` : ''}` : 'none'}`);
    if (!orc) continue;
    const frags = await getDb().all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM research_fragments WHERE orchestration_id = ? GROUP BY status', [orc.id]);
    const claims = await getDb().get<{ total: number; accepted: number; signalled: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN accepted = 1 AND opportunity_signal IS NOT NULL THEN 1 ELSE 0 END) AS signalled
         FROM research_claims WHERE orchestration_id = ?`,
      [orc.id],
    );
    const reasons = await getDb().all<{ reason: string; n: number }>(
      `SELECT COALESCE(rejection_reason, validation_state) AS reason, COUNT(*) AS n FROM research_claims
        WHERE orchestration_id = ? AND accepted = 0 GROUP BY COALESCE(rejection_reason, validation_state) ORDER BY COUNT(*) DESC LIMIT 3`,
      [orc.id],
    );
    const lanes = await getDb().all<{ lane: string; n: number }>(
      `SELECT COALESCE(evidence_lane, '-') AS lane, COUNT(*) AS n FROM research_claims WHERE orchestration_id = ? AND accepted = 1 GROUP BY COALESCE(evidence_lane, '-')`,
      [orc.id],
    );
    console.log(`    fragments ${frags.map((f) => `${f.status}=${f.n}`).join(' ') || 'none'} · claims ${claims?.total ?? 0}, accepted ${claims?.accepted ?? 0}, with an opening kind ${claims?.signalled ?? 0} · lanes ${lanes.map((l) => `${l.lane}=${l.n}`).join(' ') || 'none'}`);
    for (const r of reasons) console.log(`    rejected ${r.n}x ${String(r.reason).slice(0, 160)}`);
    const openings = await getDb().all<{ id: string; state: string; title: string; opportunity_signal: string | null }>(
      'SELECT id, state, title, opportunity_signal FROM cash_opportunities WHERE orchestration_id = ? ORDER BY created_at',
      [orc.id],
    );
    for (const o of openings) console.log(`    opening ${o.id} ${o.state} ${o.opportunity_signal ?? '-'} · ${o.title.slice(0, 110)}`);
  }
}

/**
 * Where an approved goal's own ideas stand in Russell's queues: ideas waiting
 * to be judged, judged ideas waiting for a launch, and the goal's place in each.
 */
async function explainIdeaBacklog(): Promise<void> {
  const { goalIdeaSql } = await import('../server/services/goals/goalWork.ts');
  const cycle = await getCycle();
  const counts = await getDb().all<{ bucket: string; goal: number; n: number; oldest: string | null }>(
    `SELECT t.bucket, t.goal, COUNT(*) AS n, MIN(t.created_at) AS oldest FROM (
       SELECT CASE WHEN c.priority IS NULL THEN 'unjudged' WHEN c.state = 'QUEUED' THEN 'queued' ELSE c.state END AS bucket,
              CASE WHEN ${goalIdeaSql('c')} THEN 1 ELSE 0 END AS goal, c.created_at
         FROM russell_candidates c
        WHERE c.project_id IS NOT NULL AND c.state <> 'MERGED'
          AND (c.priority IS NULL OR c.state = 'QUEUED' OR c.state = 'CAPTURED')) t
      GROUP BY t.bucket, t.goal ORDER BY t.bucket, t.goal`,
  );
  console.log(`ideas      cycle ${cycle ? `launches/cycle ${cycle.maxLaunchesPerCycle}` : 'unreadable'}`);
  for (const one of counts) console.log(`  ${one.bucket.padEnd(9)} ${one.goal ? 'goal ' : 'other'} ${one.n}  oldest ${one.oldest ?? '-'}`);
}

/**
 * Industry construction (§92), read-only: a goal's own intent, or the words
 * given with --reason, through the industry map, the goal's recorded facts and
 * any reference evidence, to a decision and its first transaction.
 */
async function industry(): Promise<void> {
  const goalId = words()[1];
  const text = flag('reason');
  if (goalId) {
    const read = await goalConstruction(goalId, { intent: text ?? null });
    if (!read) fail(`No goal ${goalId}.`);
    console.log(`industry construction for ${read.goal.id} (${read.goal.title})`);
    console.log(`  evidence: ${read.evidenceLayers.join('; ') || 'none'}`);
    console.log(renderConstruction(read.construction));
  } else {
    if (!text) fail('industry needs a goal id or --reason "the operator\'s ambition".');
    const intent = interpretIntent(text);
    const evidence = assembleEvidence({ text, industry: intent.industry, geography: intent.geography, map: evidenceFromMap([], []), recorded: [], operatorNamed: true });
    console.log(`industry construction for: ${text}`);
    console.log(`  evidence: ${evidence.provenance.join('; ') || 'none'}`);
    console.log(renderConstruction(constructIndustry({ intentText: text, evidence })));
  }
  console.log('GOALS: OK');
}

async function main(): Promise<void> {
  await initDatabase();
  // Registered exactly as the server registers them at boot (server/index.ts),
  // so a plan read here judges Instantly and Stripe as the running Brain does:
  // without it every outreach step read "Instantly is not connected" and asked
  // the owner for a credential the deployment already holds (2026-11-20).
  registerCommercialProviders();
  const [command] = words();
  switch (command) {
    case 'show':
    case undefined:
      return await show();
    case 'file':
      return await file();
    case 'pause':
    case 'resume':
    case 'cancel':
    case 'reinstate':
    case 'terms':
    case 'depends':
    case 'objective':
    case 'undepend':
      return await decide(command);
    case 'create':
    case 'target':
      return await targetCommand(command);
    case 'plan':
      return await plan();
    case 'check':
      return await check();
    case 'construct':
      return await construct();
    case 'industry':
      return await industry();
    default:
      console.error('commands: show, file, pause, resume, cancel, reinstate, terms, depends, objective, undepend, create, target, plan, check, construct, industry');
      process.exitCode = 1;
      console.log('GOALS: FAIL');
  }
}

/** Run one command in this process. Called by scripts/goals.ts, which is the entry point. */
export function run(): Promise<void> {
  return main()
    .catch((error) => {
      if (error instanceof Halt) return;
      const pooler = describePoolerRefusal(error);
      console.error('GOALS: FAILED', pooler ?? error);
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}

/** The quant engine's combined plan and each opening's estimated demand (§79). */
function printPortfolio(portfolio: import('../server/services/goals/portfolio.ts').GoalPortfolio | null, bestIs = ''): void {
  if (!portfolio) return;
  const r = (x: number) => (Math.abs(x) < 10 ? x.toFixed(x < 1 ? 3 : 1) : String(Math.round(x)));
  const l = portfolio.limits;
  console.log(`  quant       ${portfolio.basis === 'PROBABILITY' ? 'probability' : 'coverage of tested conditions, not a probability'}; ${portfolio.searched} combination(s) searched; target ${Math.round(l.target)} in ${l.deadlineDays} day(s)`);
  console.log(`    limits    start capital ${l.startingCapital ?? 'none'} · per arrangement ${l.perArrangement ?? 'none'} · spend ceiling ${l.spendCeiling ?? 'none'} · outreach ${l.contactsPerDay.value ?? `${l.contactsPerDay.low}–${l.contactsPerDay.high}`}/day (${l.contactsPerDay.source}) · shared-outreach correlation ${l.correlation}`);
  const m0 = portfolio.measuredRates;
  if (m0) {
    const pc = (x: number) => `${(x * 100).toFixed(2)}%`;
    console.log(`    measured   reply ${pc(m0.low)}–${pc(m0.high)} on ${m0.sent} sends (${m0.replies} replies, ${m0.opportunities} opportunities, ${((m0.bounced / m0.sent) * 100).toFixed(1)}% bounced) from the Instantly workspace`);
    console.log(`    authority  ${m0.assessment.authority} → ${m0.applied}: ${m0.assessment.sentence}`);
    if (m0.asIs) console.log(`    as-is      if the new campaign does no better: reach ${(m0.asIs.reach * 100).toFixed(1)}% · settled p10 ${Math.round(m0.asIs.settledP10)} p50 ${Math.round(m0.asIs.settledP50)} p90 ${Math.round(m0.asIs.settledP90)}`);
  }
  const b = portfolio.best;
  if (b) {
    console.log(`    best      ${bestIs}reaches the target in ${(b.reach * 100).toFixed(1)}% of worlds · settled p10 ${Math.round(b.settledP10)} p50 ${Math.round(b.settledP50)} p90 ${Math.round(b.settledP90)} · capital short ${(b.capitalShort * 100).toFixed(0)}% · over spend ${(b.overSpend * 100).toFixed(0)}%`);
    for (const m of b.members) console.log(`      member  ${m.opportunityId} ${m.share === null ? 'one-off' : `${m.share * 100}% of outreach`} · ${m.title.slice(0, 70)}`);
  } else {
    console.log('    best      none: no combination can run inside the limits');
  }
  for (const a of portfolio.alternatives) console.log(`    alt       ${(a.reach * 100).toFixed(1)}% · p50 ${Math.round(a.settledP50)} · ${a.members.map((m) => m.title.slice(0, 28)).join(' + ')}`);
  const est = portfolio.demand.filter((d) => d.opportunityId.startsWith('arr_'));
  const found = portfolio.demand.length - est.length;
  console.log(`    compared  ${found} found opening(s) + ${est.length} constructed estimate(s); refused ${portfolio.demand.filter((d) => d.refused).length}; estimates in the best combination ${b ? b.members.filter((m) => m.opportunityId.startsWith('arr_')).length : 0}`);
  const shown = [...portfolio.demand].sort((x, y) => y.revenue.p50 - x.revenue.p50 || y.revenue.p90 - x.revenue.p90).slice(0, 16);
  for (const d of shown) {
    console.log(
      `    demand    ${d.opportunityId} ${d.repeatable ? 'repeatable' : 'one-off'} · contacted p50 ${r(d.contacted.p50)} · interested ${r(d.interested.p10)}/${r(d.interested.p50)}/${r(d.interested.p90)} · deals ${r(d.deals.p10)}/${r(d.deals.p50)}/${r(d.deals.p90)} · revenue ${r(d.revenue.p10)}/${r(d.revenue.p50)}/${r(d.revenue.p90)} · reply ${r(d.respond.p50)} close ${r(d.close.p50)} price ${r(d.price.p50)}${d.unestablished.includes('price') ? ' (assumed: drawn within the range its pathway prints, never above it)' : ''} days ${r(d.days.p50)} · ${d.noContactBecause ? `${d.noContactBecause} · ` : ''}${d.refused ? `REFUSED ${d.refused}` : d.justified ? 'evidenced' : `not established: ${d.unestablished.join(', ')}`} · ${d.title.slice(0, 50)}`,
    );
  }
  for (const m of portfolio.missing.slice(0, 8)) console.log(`    missing   ${m}`);
}
