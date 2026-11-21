/**
 * Puts one planningReliability case through Brain's REAL planner, on a database of its own.
 *
 * The world is built the way research files it (the harness of tests/planTransfer.test.ts
 * and tests/goalPlan.test.ts): each opening is a `cash_opportunities` row with its card
 * facts, each fact EVIDENCE with a claim, or PERSON when somebody only said so; written
 * buyer acceptances are `cash_agreements` rows. The goal is created from the owner's
 * words by `createGoal`, an objective change goes through `changeObjective`, and the plan
 * is `readGoalPlan` — nothing here re-implements a judgement of the planner.
 *
 * Every case opens a copy of one migrated template (a project with Cash Mode on, the
 * owner, Brain's deliverables proved as the server proves them at boot), so cases cannot
 * see each other's rows and migrations run once per suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlanReading } from '../../server/services/goals/plan.ts';
import type { OpeningFixture, PlanningCase } from './case.ts';

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

async function fileOpening(f: OpeningFixture, t: Template, cashModeId: string, now: Date): Promise<string> {
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
  await fact('price', `$${evidencedPrice}${f.monthly ? ' a month' : ''}`, f.priceBasis === 'PERSON' ? 'PERSON' : 'EVIDENCE');
  if (f.daysToCash !== undefined && f.daysToCash !== null) await fact('timeToFirstCash', `${f.daysToCash} days`);
  if (f.cost !== undefined && f.cost !== null) await fact('directCosts', `$${f.cost}`);
  await fact('exposure', `$${f.capital ?? 0}`);
  if (f.volume) await fact('buyerVolume', f.volume, f.volumeBasis === 'ESTIMATE' ? 'RECOMMENDATION' : 'EVIDENCE');
  if (f.performer === 'BRAIN') await fact('delivery', 'A spreadsheet Brain produces.');
  if (f.performer === 'SUBCONTRACTOR') await fact('fulfillment', `${f.subcontractor ?? 'A named subcontractor'} quoted to do the work.`);
  if (f.performer === 'OWNER') await fact('fulfillment', 'The owner does the work personally.', 'PERSON');
  if (f.conversion) await fact('conversionRates', `${f.conversion.paid} paid pre-orders from ${f.conversion.visitors} unique visitors`);
  for (const [i, amount] of (f.agreements ?? []).entries()) {
    await insertAgreement({
      projectId: t.projectId, opportunityId: id, amountCents: Math.round(amount * 100), currency: 'USD', deliverable: f.offer ?? f.title,
      acceptanceCondition: 'delivered as agreed', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${f.key}-${i}`, recordedBy: 'PERSON', requestKey: `agree-${f.key}-${i}`,
    });
  }
  return id;
}

export interface WorldReading {
  reading: PlanReading;
  /** The reading before the objective changed, when it did. */
  before: PlanReading | null;
  keyOf: (opportunityId: string) => string;
}

export async function runWorld(c: PlanningCase, t: Template, dir: string, index: number): Promise<WorldReading> {
  const file = path.join(dir, `case-${index}.db`);
  fs.copyFileSync(t.file, file);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  await openDatabase(file);
  const { getCashMode } = await import('../../server/repos/cashMode.ts');
  const { createGoal, changeObjective } = await import('../../server/services/goals/decide.ts');
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
  for (const f of c.openings) keys.set(await fileOpening(f, t, cashModeId, now), f.key);
  const created = await createGoal({ projectId: t.projectId, objective: c.objective, actorRef: `person:${t.userId}`, userId: t.userId, now: new Date(now.getTime() - 60_000) });
  if (!created.ok) throw new Error(`the objective did not make a goal: ${created.reason}`);
  const goalId = created.goal.id;
  let before: PlanReading | null = null;
  if (c.changedObjective) {
    before = await readGoalPlan({ goalId, evaluations: EVALUATIONS, persist: true });
    const changed = await changeObjective(goalId, { intent: c.changedObjective }, `person:${t.userId}`);
    if (!changed.ok) throw new Error(`the objective did not change: ${changed.reason}`);
  }
  const reading = await readGoalPlan({ goalId, evaluations: EVALUATIONS, persist: !!c.changedObjective });
  if (!reading) throw new Error('the planner returned no reading');
  return { reading, before, keyOf: (id) => keys.get(id) ?? id };
}

/** Brain's deliverables, proved as the server proves them at boot (server/index.ts). */
export async function proveDeliverables(): Promise<void> {
  const { proveCapabilities } = await import('../../server/services/cash/deliverables/capabilities.ts');
  await proveCapabilities();
}
