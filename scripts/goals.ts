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
 *   npm run goals -- terms <wst_…> [--outcome "…"] [--due 2026-10-01] [--commitment CUSTOMER] --admin a@b
 *   npm run goals -- create --reason "Collect 10000 dollars in 30 days" --project prj_… --due 2026-11-27 SETTLED_CASH-1000000-USD-50000-120 --admin a@b
 *   npm run goals -- target <wst_…> SETTLED_CASH-1000000-USD-50000-120 --project prj_… --admin a@b
 *   npm run goals -- plan <wst_…>            (reads and prints; writes nothing)
 *
 * A target spec is METRIC-AMOUNT_CENTS-CURRENCY[-CAPITAL_CENTS[-HOURS]], dashes
 * only, so it passes the workflow's id check: the figure, how much, in which
 * currency, and optionally the money and hours a plan may use.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent } from '../server/repos/register.ts';
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
import { cancel, pause, reinstate, resume, setTerms } from '../server/services/goals/decide.ts';
import { spendingRuleSentence } from '../server/services/goals/spending.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { latestMissionForCandidate } from '../server/repos/russellMissions.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { CHAIN_LABEL, readGoalPlan, listReadings, type PlanReading } from '../server/services/goals/plan.ts';

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
      if (otherId === goalId) fail('A goal cannot depend on itself.');
      for (const link of await listLinks(otherId)) {
        if (link.kind === 'WORKSTREAM' && link.relation === 'DEPENDS_ON' && link.ref === goalId) {
          fail('That would make the two goals wait on each other for ever.');
        }
      }
      await linkWorkstream({ workstreamId: goalId, kind: 'WORKSTREAM', ref: otherId, relation: 'DEPENDS_ON', recordedBy: 'PERSON', recordedByUserId: adminId });
      await recordWorkstreamEvent({ workstreamId: goalId, kind: 'GOAL_DEPENDENCY_SET', summary: `Waits on ${otherId} until it completes.`, actorRef });
      result = { ok: true, reason: null, consequence: 'Its live bins are held until that goal completes, then released on the next tick.' };
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

async function targetCommand(command: 'create' | 'target'): Promise<void> {
  const adminId = await administrator();
  const projectId = flag('project') ?? fail('A target needs --project: the project whose ledger counts.');
  let goal;
  let specWord: string | undefined;
  if (command === 'create') {
    const title = flag('reason') ?? fail('create needs --reason: the goal in plain words.');
    const due = flag('due') ?? fail('create needs --due: a goal with no deadline has no window to count money in.');
    if (!Number.isFinite(Date.parse(due))) fail('--due must be a date.');
    [, specWord] = words();
    const spec = parseSpec(specWord);
    goal = await createWorkstream({ projectId, title: title.slice(0, 160), intent: title, purpose: 'REVENUE_DIRECT', createdByUserId: adminId });
    await setTerms(goal.id, { outcome: `${spec.metric} of at least ${spec.amountCents / 100} ${spec.currency}, verified on the ledger`, dueAt: new Date(due).toISOString(), ownerUserId: adminId }, `person:${adminId}`);
    await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'WORKSTREAM_OPENED', summary: `Created as a targeted goal: ${title.slice(0, 200)}`, actorRef: `person:${adminId}` });
  } else {
    const [, goalId, word] = words();
    specWord = word;
    goal = goalId ? await getWorkstream(goalId) : null;
    if (!goal) fail(`No goal ${goalId ?? '(none named)'}.`);
  }
  const spec = parseSpec(specWord);
  const fresh = (await getWorkstream(goal.id))!;
  const result = await setTarget({ goal: fresh, metric: spec.metric, amountCents: spec.amountCents, currency: spec.currency, projectId, capitalCeilingCents: spec.capital, hoursCeiling: spec.hours, resources: flag('resources') ?? null, capitalBeforeProofCents: cents(flag('before-proof')) ?? spec.beforeProof, capitalPerWeekCents: cents(flag('per-week')) ?? spec.perWeek });
  if (!result.ok) fail(`The target was not set: ${result.reason}`);
  await recordWorkstreamEvent({ workstreamId: goal.id, kind: 'GOAL_TARGET_SET', summary: `Target: ${spec.metric} ${spec.amountCents / 100} ${spec.currency}${spec.capital !== null ? `, at most ${spec.capital / 100} tied up` : ''}${spec.hours !== null ? `, at most ${spec.hours} hours` : ''}. Counted from now.`, actorRef: `person:${adminId}` });
  console.log(`${command} ${goal.id}: target ${spec.metric} ${spec.amountCents / 100} ${spec.currency} counted from ${result.target.setAt}`);
  console.log('GOALS: OK');
}

/** What the goal is doing about its own gap: its search rounds and its path research. */
async function printSearching(reading: PlanReading): Promise<void> {
  const prefix = `goal-${reading.goalId}`;
  const rounds = (await listRounds(reading.target.projectId)).filter((one) => one.bucketId === prefix || one.bucketId.startsWith(`${prefix}-`));
  console.log(`  searching   ${rounds.length} round(s) of this goal's own search`);
  for (const round of rounds) {
    const mission = await latestMissionForCandidate(round.candidateId);
    console.log(`    ${round.bucketId.slice(prefix.length + 1) || 'open'} round ${round.round} ${round.state} found ${round.found ?? '—'} · idea ${round.candidateId} · mission ${mission ? `${mission.id} ${mission.state}` : 'not launched yet'}`);
  }
  const ids = new Set(reading.considered.map((one) => one.opportunityId));
  const needs = (await listNeeds({ projectId: reading.target.projectId })).filter((one) => one.opportunityId && ids.has(one.opportunityId) && one.blockedAction.startsWith('The path to money'));
  console.log(`  digging     ${needs.length} path-to-money question(s) on openings it holds`);
  for (const need of needs.slice(0, 12)) {
    const candidate = need.candidateId ? await getCandidate(need.candidateId) : null;
    console.log(`    ${need.state} ${need.requestKey?.split(':').pop()} · ${need.blockedAction.slice(0, 90)} · ${candidate ? `idea ${candidate.id} ${candidate.state}` : 'not asked yet'}`);
  }
}

function printPlan(reading: PlanReading): void {
  const t = reading.target;
  console.log(`PLAN ${reading.goalId}  ${reading.verdict}`);
  console.log(`  target      ${t.targetCents / 100} ${t.currency} ${t.metricLabel}; ledger shows ${t.achievedCents / 100} since ${t.since.slice(0, 10)}; ${t.remainingCents / 100} to go; ${t.daysLeft ?? '—'} day(s) left`);
  for (const one of t.notCounted) console.log(`  not counted ${one.label}: ${one.cents / 100} ${t.currency}`);
  console.log(`  limits      capital ${t.capitalCeilingCents === null ? 'not stated (the owner has not said how much may be committed)' : t.capitalCeilingCents / 100} · hours ${t.hoursCeiling ?? 'not stated'}`);
  console.log(`  resources   ${t.resources ?? 'not stated'}`);
  console.log(`  spending    ${spendingRuleSentence(t) ?? 'no pace set'}`);
  console.log(`  verdict     ${reading.summary}`);
  console.log(`  considered  ${reading.considered.length} opening(s), ${reading.considered.filter((one) => one.modelled).length} in the simulation; ${reading.needsMoreOpenings ? 'not enough yet, so Brain keeps searching' : 'a realistic plan exists'}`);
  for (const one of reading.considered.slice(0, 8)) {
    console.log(`    ${one.modelled ? 'model' : '     '} supported ${Math.round(one.supportedReach)} · missing ${one.missing.length ? one.missing.join(',') : 'nothing'} · ${one.title.slice(0, 70)}`);
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
    console.log(`  next test   [${reading.nextTest.by}] ${reading.nextTest.test}`);
    if (reading.nextTest.blocker) console.log(`  blocker     ${reading.nextTest.blocker}`);
  }
  for (const one of reading.excluded.slice(0, 15)) console.log(`  left out    ${one.opportunityId} ${one.title.slice(0, 70)}: ${one.reason}`);
  if (reading.excluded.length > 15) console.log(`  left out    … and ${reading.excluded.length - 15} more`);
}

async function plan(): Promise<void> {
  const [, goalId] = words();
  if (!goalId) fail('plan needs a goal id.');
  const reading = await readGoalPlan({ goalId, persist: false });
  if (!reading) fail(`No targeted goal ${goalId}.`);
  printPlan(reading);
  await printSearching(reading);
  const history = await listReadings(goalId);
  for (const row of history.slice(-10)) console.log(`  history     ${row.created_at} ${row.verdict} chosen=${row.chosen_strategy ?? '—'}${row.scenario_run_id ? ` run=${row.scenario_run_id}` : ''}`);
  console.log('GOALS: OK');
}

async function main(): Promise<void> {
  await initDatabase();
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
      return await decide(command);
    case 'create':
    case 'target':
      return await targetCommand(command);
    case 'plan':
      return await plan();
    default:
      console.error('commands: show, file, pause, resume, cancel, reinstate, terms, depends, create, target, plan');
      process.exitCode = 1;
      console.log('GOALS: FAIL');
  }
}

main()
  .catch((error) => {
    if (error instanceof Halt) return;
    const pooler = describePoolerRefusal(error);
    console.error('GOALS: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
