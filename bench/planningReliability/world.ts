/**
 * Puts one planningReliability case through Brain's REAL planner, on a database of its own.
 *
 * The world is built the way research files it (the harness of tests/planTransfer.test.ts
 * and tests/goalPlan.test.ts): each opening is a `cash_opportunities` row with its card
 * facts, each fact EVIDENCE with a claim, or PERSON when somebody only said so; written
 * buyer acceptances are `cash_agreements` rows. The goal is created from the owner's
 * words by `createGoal`, and the plan is `readGoalPlan` — nothing here re-implements a
 * judgement of the planner. A case's changes (an objective restated, a target, deadline or
 * limit moved, a buyer gone, a cost, payment time or contradicting figure newly evidenced)
 * are applied after the first reading, one at a time, each through the write path
 * production uses for it (`applyChange`), and the plan is read again after each.
 *
 * Every case opens a copy of one migrated template (a project with Cash Mode on, the
 * owner, Brain's deliverables proved as the server proves them at boot), so cases cannot
 * see each other's rows and migrations run once per suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlanReading } from '../../server/services/goals/plan.ts';
import { changeSteps, conversionSentence, type OpeningFixture, type PlanningCase, type WorldChange } from './case.ts';

export interface Template {
  file: string;
  projectId: string;
  userId: string;
}

/** The plan reading's evaluation budget: the same as the transfer matrix (tests/planTransfer.test.ts). */
export const EVALUATIONS = 400;

async function openDatabase(file: string): Promise<void> {
  const { closeDatabase, initDatabase } = await import('../../server/db/database.ts');
  await closeDatabase({ drainMs: 200 });
  const { resetStallLog } = await import('../../server/db/infra.ts');
  const { resetPressure } = await import('../../server/db/pressure.ts');
  resetStallLog();
  resetPressure();
  await initDatabase({ dbPath: file });
}

export async function closeWorldDatabase(): Promise<void> {
  const { closeDatabase } = await import('../../server/db/database.ts');
  await closeDatabase({ drainMs: 200 });
}

export async function buildTemplate(dir: string): Promise<Template> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'template.db');
  await openDatabase(file);
  const { seedDealDispatch } = await import('../../server/seed.ts');
  const { createUser } = await import('../../server/repos/identity.ts');
  const { activate } = await import('../../server/services/cash/lifecycle.ts');
  const { project } = await seedDealDispatch();
  const user = await createUser({ email: 'bench-owner@example.test', displayName: 'Owner', password: 'correct horse battery staple' });
  const activated = await activate({ projectId: project.id, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize usable cash over the next few weeks.' });
  if (!activated.ok) throw new Error(`cash mode did not activate: ${JSON.stringify(activated).slice(0, 200)}`);
  await closeWorldDatabase();
  return { file, projectId: project.id, userId: user.id };
}

/** The capability a Brain-performed deliverable needs (deliverables proved at boot). */
const BRAIN_CAPABILITY = 'PRODUCE_SPREADSHEET';

export async function fileOpening(f: OpeningFixture, t: Template, cashModeId: string, now: Date): Promise<string> {
  const { createOpportunity, updateOpportunity } = await import('../../server/repos/cashPortfolio.ts');
  const { recordCardFact } = await import('../../server/repos/cashCardFacts.ts');
  const { insertAgreement } = await import('../../server/repos/cashJourney.ts');
  const { CAPTURE_KEY } = await import('../../server/services/cash/tier.ts');
  const o = await createOpportunity({
    projectId: t.projectId, cashModeId, ownerUserId: t.userId, title: f.title, mechanism: f.mechanism, currency: 'USD', industry: f.industry,
    sourceClaimId: `clm_src_${f.key}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
    requiredCapabilities: f.performer === 'BRAIN' ? [BRAIN_CAPABILITY] : [],
  } as never);
  const id = (o as { id: string }).id;
  const fact = (field: string, value: string, kind: 'EVIDENCE' | 'PERSON' | 'RECOMMENDATION' = 'EVIDENCE') =>
    recordCardFact({ projectId: t.projectId, opportunityId: id, field, kind, value, claimId: kind === 'EVIDENCE' ? `clm_${field}_${id}` : null, decidedBy: kind === 'PERSON' ? 'PERSON' : 'BRAIN' });
  const payer = f.payer === undefined ? `${f.industry} buyers` : f.payer;
  const signal = f.signalDaysAgo === undefined ? 3 : f.signalDaysAgo;
  await fact(CAPTURE_KEY, `Sell ${f.offer ?? f.title} to each buyer${f.monthly ? ', billed monthly' : ''}.`);
  if (payer) await fact('payer', payer);
  await updateOpportunity(id, {
    payer,
    price_cents: Math.round(f.price * 100),
    offer_scope: f.offer ?? f.title,
    reachable_channel: f.channel === undefined ? 'Published business email addresses' : f.channel,
    buying_signal: signal === null ? null : 'Posted asking for this work',
    signal_observed_at: signal === null ? null : new Date(now.getTime() - signal * 86_400_000).toISOString(),
    peak_funding_cents: Math.round((f.capital ?? 0) * 100),
    human_hours: f.hours ?? null,
    industry: f.industry,
    fulfillment_owner: f.performer === 'SUBCONTRACTOR' ? (f.subcontractor ?? 'A named subcontractor (quoted)') : f.performer === 'OWNER' ? 'The owner, personally' : null,
  } as never);
  // The evidenced price: the card's own figure, or — contradicting it — the figure another source states.
  const evidencedPrice = f.priceContradiction ?? f.price;
  // A case may state what the source says the money is; a contradicting figure still wins, as research would file it.
  const priceText = f.priceContradiction === undefined && f.priceEvidence ? f.priceEvidence : `$${evidencedPrice}${f.monthly ? ' a month' : ''}`;
  await fact('price', priceText, f.priceBasis === 'PERSON' ? 'PERSON' : 'EVIDENCE');
  if (f.daysToCash !== undefined && f.daysToCash !== null) await fact('timeToFirstCash', `${f.daysToCash} days`);
  if (f.cost !== undefined && f.cost !== null) await fact('directCosts', `$${f.cost}`);
  await fact('exposure', `$${f.capital ?? 0}`);
  if (f.volume) await fact('buyerVolume', f.volume, f.volumeBasis === 'ESTIMATE' ? 'RECOMMENDATION' : 'EVIDENCE');
  if (f.performer === 'BRAIN') await fact('delivery', 'A spreadsheet Brain produces.');
  if (f.performer === 'SUBCONTRACTOR') await fact('fulfillment', `${f.subcontractor ?? 'A named subcontractor'} quoted to do the work.`);
  if (f.performer === 'OWNER') await fact('fulfillment', 'The owner does the work personally.', 'PERSON');
  // The evidence in its own unit: "6 wins from 40 quotes" is never restated as visitors.
  if (f.conversion) await fact('conversionRates', conversionSentence(f.conversion));
  for (const [i, amount] of (f.agreements ?? []).entries()) {
    await insertAgreement({
      projectId: t.projectId, opportunityId: id, amountCents: Math.round(amount * 100), currency: 'USD', deliverable: f.offer ?? f.title,
      acceptanceCondition: 'delivered as agreed', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${f.key}-${i}`, recordedBy: 'PERSON', requestKey: `agree-${f.key}-${i}`,
    });
  }
  return id;
}

export interface WorldReading {
  /** The final reading: after the last change, or the only one. */
  reading: PlanReading;
  /** The reading before the first change, when anything changed. */
  before: PlanReading | null;
  /** Every reading in order: [0] before any change, [k] after change k (`caseAtStep(c, k)` is its case). */
  readings: PlanReading[];
  keyOf: (opportunityId: string) => string;
}

/** What one change needs of the world it is applied to. */
export interface ChangeContext {
  goalId: string;
  projectId: string;
  userId: string;
  /** Fixture key → opportunity id. */
  idOf: (key: string) => string;
  /** The change's position (1-based), which names the new evidence's claim. */
  step: number;
  now: Date;
}

/**
 * Apply one change to a live world through the path production uses for it: the owner's
 * restated words through `changeObjective`; a target through `setTarget`, the one writer of
 * a target; a deadline through `setTerms`; capital and hours limits through
 * `setTargetLimits`, recorded as the terminal's `goals target` records them; a buyer gone
 * through `archiveOpportunity`; newly evidenced figures as the card's evidence facts, the
 * way research files them (and `fileOpening` seeded them). No SQL is written here.
 */
export async function applyChange(change: WorldChange, ctx: ChangeContext): Promise<void> {
  const actorRef = `person:${ctx.userId}`;
  const goal = async () => {
    const { getWorkstream } = await import('../../server/repos/register.ts');
    const g = await getWorkstream(ctx.goalId);
    if (!g?.target) throw new Error('the goal has no target to change');
    return { goal: g, target: g.target };
  };
  const limits = async (over: { capitalCeilingCents?: number | null; hoursCeiling?: number | null }, summary: string) => {
    const { setTargetLimits } = await import('../../server/services/goals/target.ts');
    const { recordWorkstreamEvent } = await import('../../server/repos/register.ts');
    const { goal: g, target } = await goal();
    const set = await setTargetLimits({ goal: g, ...over, now: ctx.now });
    if (!set.ok) throw new Error(`the limits did not change: ${set.reason}`);
    await recordWorkstreamEvent({ workstreamId: ctx.goalId, kind: 'GOAL_TARGET_LIMITS_SET', summary, detail: { before: target }, actorRef });
  };
  const evidence = async (key: string, field: string, value: string) => {
    const { recordCardFact } = await import('../../server/repos/cashCardFacts.ts');
    const id = ctx.idOf(key);
    await recordCardFact({ projectId: ctx.projectId, opportunityId: id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${id}_change${ctx.step}`, decidedBy: 'BRAIN' });
  };
  switch (change.kind) {
    case 'OBJECTIVE': {
      const { changeObjective } = await import('../../server/services/goals/decide.ts');
      const changed = await changeObjective(ctx.goalId, { intent: change.objective }, actorRef);
      if (!changed.ok) throw new Error(`the objective did not change: ${changed.reason}`);
      return;
    }
    case 'TARGET': {
      const { setTarget } = await import('../../server/services/goals/target.ts');
      const { goal: g, target } = await goal();
      const set = await setTarget({ ...target, goal: g, amountCents: Math.round(change.amount * 100), now: ctx.now, actorRef });
      if (!set.ok) throw new Error(`the target did not change: ${set.reason}`);
      return;
    }
    case 'DEADLINE': {
      const { setTerms } = await import('../../server/services/goals/decide.ts');
      const { goal: current } = await goal();
      // A goal stated as a span carries a commercial execution window (§119): moving its deadline moves the window,
      // and a date sent for it is refused. A goal with a fixed date moves its date.
      const moved = current.executionWindowDays !== null && !current.executionStartedAt
        ? await setTerms(ctx.goalId, { executionWindowDays: change.days }, actorRef)
        : await setTerms(ctx.goalId, { dueAt: new Date(ctx.now.getTime() + change.days * 86_400_000).toISOString(), executionWindowDays: null }, actorRef);
      if (!moved.ok) throw new Error(`the deadline did not change: ${moved.reason}`);
      return;
    }
    case 'CAPITAL':
      return limits({ capitalCeilingCents: Math.round(change.capital * 100) }, `Limits: the owner's starting capital is now ${change.capital} USD, the most this goal may tie up.`);
    case 'CONSTRAINT':
      return change.constraint === 'CAPITAL'
        ? limits({ capitalCeilingCents: change.limit === null ? null : Math.round(change.limit * 100) }, change.limit === null ? 'Limits: the capital limit is removed.' : `Limits: at most ${change.limit} USD tied up.`)
        : limits({ hoursCeiling: change.limit === null ? null : Math.round(change.limit) }, change.limit === null ? 'Limits: the owner-hours limit is removed.' : `Limits: at most ${Math.round(change.limit)} owner hours.`);
    case 'BUYER_UNAVAILABLE': {
      const { archiveOpportunity } = await import('../../server/services/cash/opportunities.ts');
      const archived = await archiveOpportunity({ opportunityId: ctx.idOf(change.opening), actorRef, reason: change.reason ?? 'The buyer is no longer available.' });
      if (!archived.ok) throw new Error(`the opening was not archived: ${archived.reason}`);
      return;
    }
    case 'SUPPLIER_COST':
      return evidence(change.opening, 'directCosts', `$${change.cost}`);
    case 'DAYS_TO_CASH':
      return evidence(change.opening, 'timeToFirstCash', `${change.days} days`);
    case 'CONTRADICTING_EVIDENCE': {
      // The price as `priceContradiction` files it: the card keeps its figure, the evidenced price fact states another.
      const { cardFact } = await import('../../server/repos/cashCardFacts.ts');
      const monthly = /a month/.test((await cardFact(ctx.idOf(change.opening), 'price'))?.value ?? '');
      return evidence(change.opening, 'price', `$${change.value}${monthly ? ' a month' : ''}`);
    }
  }
}

export async function runWorld(c: PlanningCase, t: Template, dir: string, index: number): Promise<WorldReading> {
  const file = path.join(dir, `case-${index}.db`);
  fs.copyFileSync(t.file, file);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  await openDatabase(file);
  const { getCashMode } = await import('../../server/repos/cashMode.ts');
  const { createGoal } = await import('../../server/services/goals/decide.ts');
  const { forgetGoalReadings, readGoalPlan } = await import('../../server/services/goals/plan.ts');
  const { forgetKnowledge } = await import('../../server/services/quant/knowledge.ts');
  const { clearConstructionMemo } = await import('../../server/services/cash/construct.ts');
  const { forgetHeldEvaluations } = await import('../../server/services/goals/portfolio.ts');
  // Nothing one case learned reaches the next: process memos are cleared with the database.
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  forgetHeldEvaluations();
  const now = new Date();
  const cashModeId = (await getCashMode(t.projectId))!.id;
  const keys = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const f of c.openings) {
    const id = await fileOpening(f, t, cashModeId, now);
    keys.set(id, f.key);
    ids.set(f.key, id);
  }
  const created = await createGoal({ projectId: t.projectId, objective: c.objective, actorRef: `person:${t.userId}`, userId: t.userId, now: new Date(now.getTime() - 60_000) });
  if (!created.ok) throw new Error(`the objective did not make a goal: ${created.reason}`);
  const goalId = created.goal.id;
  const steps = changeSteps(c);
  const read = async (persist: boolean) => {
    const reading = await readGoalPlan({ goalId, evaluations: EVALUATIONS, persist });
    if (!reading) throw new Error('the planner returned no reading');
    return reading;
  };
  // The world is never reset between steps: each change lands on the goal and openings the previous reading planned.
  const readings: PlanReading[] = [await read(steps.length > 0)];
  for (const [i, step] of steps.entries()) {
    await applyChange(step.change, { goalId, projectId: t.projectId, userId: t.userId, idOf: (key) => ids.get(key)!, step: i + 1, now: new Date() });
    readings.push(await read(true));
  }
  return { reading: readings[readings.length - 1]!, before: steps.length ? readings[0]! : null, readings, keyOf: (id) => keys.get(id) ?? id };
}

/** Brain's deliverables, proved as the server proves them at boot (server/index.ts). */
export async function proveDeliverables(): Promise<void> {
  const { proveCapabilities } = await import('../../server/services/cash/deliverables/capabilities.ts');
  await proveCapabilities();
}
