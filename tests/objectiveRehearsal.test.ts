/**
 * REHEARSAL — planning across different objectives (offline, 2026-11-18).
 *
 * This is an offline rehearsal, not production. Nothing here reads or writes
 * the production database, contacts a buyer or spends money: every case runs
 * on a throwaway test project. A PASS here is not a claim that Brain would
 * collect the money; it is a claim that the planner, given the objective in
 * words, read it correctly and produced a plan shaped by it.
 *
 * HOW TO RUN
 *
 *     npx vitest run tests/objectiveRehearsal.test.ts
 *     npx vitest run tests/objectiveRehearsal.test.ts 2>&1 | grep '^REHEARSAL '
 *
 * WHAT IT DOES
 *
 * The live goal is "Collect $10,000 of settled cash within 30 days using little
 * up-front capital". Brain must also plan objectives it has never been given.
 * Every case is the whole chain a person's words take on production:
 *
 *   words → `createGoal` (the one writer of a goal from words: `readObjective`,
 *   the target and its limits) → `readGoalPlan` (construction, the quant
 *   engine, reconstruction, acceptance, steps).
 *
 * Each case starts from the SAME world — the same five held openings, of
 * different shapes (no-capital service, monthly retainer, capital-heavy
 * resale, two commercial-cleaning lines) — so whatever differs between the
 * plans differs because the objective did. Five checks per objective, written
 * from the owner's requirements and never relaxed to match the code:
 *
 *   R  the objective's amount, deadline and capital are read correctly;
 *   M  the candidate plan differs as the objective demands (capital-heavy vs
 *      no-capital, recurring vs one-off, industry-constrained, deadline);
 *   B  the plan states its binding constraint;
 *   S  the plan has executable steps or explicit research steps;
 *   C  no plan claims confidence its inputs do not support.
 *
 * When `createGoal` refuses the words, or reads them into the wrong kind of
 * goal, R fails and the case continues on a FALLBACK goal stated explicitly
 * from what the words mean, so M–C still measure the planner itself. The
 * measured line says `fallback: true` when that happened.
 *
 * Every assertion runs and is recorded even after an earlier one fails, and a
 * case fails at the end if any did. The failure classes the report uses are:
 * WRONG_READING, SAME_PLAN, CONSTRAINT_IGNORED, MISSING_STEP, FALSE_CONFIDENCE.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { forgetGoalReadings, readGoalPlan, type PlanReading } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { interpretObjective } from '../server/services/goals/objectivePlan.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { CashMechanism } from '../server/domain/types.ts';

/* ------------------------------------------------------------------ */
/* Measurement harness (the Surge B evaluator's, unchanged in shape)   */
/* ------------------------------------------------------------------ */

type FailureClass = 'WRONG_READING' | 'SAME_PLAN' | 'CONSTRAINT_IGNORED' | 'MISSING_STEP' | 'FALSE_CONFIDENCE';

/**
 * Gaps measured on the planner and not yet repaired, each with why. A known gap
 * is recorded FAIL in the measured line and does not fail the suite; any other
 * failure does, and so does a known gap that starts passing (remove it here,
 * so the list never claims a gap that is gone). An assertion is never relaxed
 * to match the code: a gap is listed, never hidden.
 */
const KNOWN_GAPS: Record<string, Record<string, string>> = {
  // Closed 2026-11-18 (objective obeyed): SAME_PLAN for $10K→$100K, the recurring and the cleaning goals;
  // the recurring target and its weekly hours; the named industry; "little up-front capital" as an assumed ceiling.
};

function rehearsal(id: string) {
  const t0 = performance.now();
  const line = { case: id, rehearsal: true, assertions: {} as Record<string, 'PASS' | 'FAIL'>, classes: {} as Record<string, FailureClass>, ms: 0, values: {} as Record<string, unknown> };
  const failures: string[] = [];
  return {
    line,
    async check(name: string, cls: FailureClass, fn: () => unknown | Promise<unknown>): Promise<boolean> {
      try {
        await fn();
        line.assertions[name] = 'PASS';
        return true;
      } catch (error) {
        line.assertions[name] = 'FAIL';
        line.classes[name] = cls;
        failures.push(`${name} [${cls}]: ${(error as Error).message.split('\n').slice(0, 3).join(' ')}`);
        return false;
      }
    },
    measure(values: Record<string, unknown>): void {
      Object.assign(line.values, values);
    },
    done(): void {
      line.ms = Math.round(performance.now() - t0);
      console.log(`REHEARSAL ${JSON.stringify(line)}`);
      const known = KNOWN_GAPS[id] ?? {};
      const unexpected = failures.filter((f) => !Object.keys(known).some((name) => f.startsWith(`${name} [`)));
      const closed = Object.keys(known).filter((name) => line.assertions[name] === 'PASS');
      if (unexpected.length > 0) throw new Error(`${id}: ${unexpected.length} assertion(s) failed\n  - ${unexpected.join('\n  - ')}`);
      if (closed.length > 0) throw new Error(`${id}: known gap(s) now pass — remove them from KNOWN_GAPS: ${closed.join('; ')}`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* One world for every objective                                       */
/* ------------------------------------------------------------------ */

let projectId = '';
let userId = '';
let cashModeId = '';
const NOW = new Date();
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

interface Held {
  key: string;
  title: string;
  mechanism: CashMechanism;
  industry: string;
  payer: string;
  capture: string;
  priceCents: number;
  costCents: number;
  capitalCents: number;
  days: number;
  hours: number;
  volume: string;
  recurring: boolean;
}

/** The same five openings in every case: their shapes are what a plan must choose between. */
const WORLD: Held[] = [
  {
    key: 'report', title: 'Vendor-compliance spreadsheet for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: 'property management',
    payer: 'Property managers', capture: 'Sell the finished compliance spreadsheet to each manager.', priceCents: 60_000, costCents: 1_000, capitalCents: 0, days: 5, hours: 1,
    volume: '400 property managers are listed in the state directory; each needs one.', recurring: false,
  },
  {
    key: 'retainer', title: 'Monthly bookkeeping retainer for dental practices', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'dental practices',
    payer: 'Dental practice owners', capture: 'Bill each practice a monthly retainer; a subcontracted bookkeeper does the work.', priceCents: 90_000, costCents: 45_000, capitalCents: 0, days: 30, hours: 1,
    volume: '250 independent dental practices are listed in the state dental board directory; each pays monthly.', recurring: true,
  },
  {
    key: 'resale', title: 'Resale of liquidated restaurant kitchen equipment', mechanism: 'SUPPLY_DEMAND_MISMATCH', industry: 'restaurant equipment',
    payer: 'Restaurant operators', capture: 'Buy a liquidated lot at auction and resell it to an opening restaurant.', priceCents: 1_400_000, costCents: 800_000, capitalCents: 800_000, days: 21, hours: 4,
    volume: '30 liquidation auctions a month are listed by the regional auctioneer; 40 restaurants open each month.', recurring: false,
  },
  {
    key: 'cleaning_office', title: 'Commercial office cleaning subcontract for property managers', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning',
    payer: 'Office property managers', capture: 'Win the cleaning contract and subcontract the crews.', priceCents: 250_000, costCents: 150_000, capitalCents: 0, days: 14, hours: 2,
    volume: '120 office buildings are listed in the county commercial register; each contracts cleaning.', recurring: false,
  },
  {
    key: 'cleaning_post', title: 'Post-construction cleanup for general contractors', mechanism: 'SUBCONTRACTED_FULFILMENT', industry: 'commercial cleaning',
    payer: 'General contractors', capture: 'Sell the final cleanup and subcontract a crew.', priceCents: 120_000, costCents: 60_000, capitalCents: 0, days: 10, hours: 2,
    volume: '80 general contractors are listed in the state licensing board; each needs cleanup per project.', recurring: false,
  },
];

async function freshWorld(): Promise<Map<string, Held>> {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `rh-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
  const byId = new Map<string, Held>();
  for (const h of WORLD) {
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title: h.title, mechanism: h.mechanism, currency: 'USD', industry: h.industry,
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher',
      requiredCapabilities: ['PRODUCE_SPREADSHEET'],
    } as Parameters<typeof createOpportunity>[0]);
    const fact = (field: string, value: string) => recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
    await fact(CAPTURE_KEY, h.capture);
    await fact('payer', h.payer);
    await fact('delivery', 'Brain produces or subcontracts it.');
    await updateOpportunity(o.id, {
      payer: h.payer, price_cents: h.priceCents, offer_scope: h.title, reachable_channel: 'Published business email addresses',
      buying_signal: 'Posted asking for this work', signal_observed_at: inDays(-3), peak_funding_cents: h.capitalCents, human_hours: h.hours, industry: h.industry,
    } as never);
    await fact('price', `$${h.priceCents / 100}${h.recurring ? ' a month' : ''}`);
    await fact('timeToFirstCash', `${h.days} days`);
    await fact('directCosts', `$${h.costCents / 100}`);
    if (h.capitalCents > 0) await fact('exposure', `$${h.capitalCents / 100}`);
    await fact('buyerVolume', h.volume);
    byId.set(o.id, h);
  }
  return byId;
}

/* ------------------------------------------------------------------ */
/* The objectives                                                      */
/* ------------------------------------------------------------------ */

interface Expect {
  /** Dollars the plan must settle; any listed value is a correct reading. */
  amount: number[];
  days: number;
  /** Dollars the plan may tie up; null when the words state no figure. */
  capital: number | null;
  /** What makes this objective different from the live one, checked on the plan. */
  shape: 'LIVE' | 'CAPITAL_LIGHT' | 'CAPITAL_HEAVY' | 'RECURRING' | 'INDUSTRY' | 'SHORT_DEADLINE';
  /** The explicit goal the words mean, used only when `createGoal` refuses or misreads them. */
  fallback: { amountCents: number; capitalCeilingCents: number | null; hoursCeiling: number | null };
}

const OBJECTIVES: Array<{ id: string; words: string; expect: Expect }> = [
  {
    id: 'LIVE-10K-30d',
    words: 'Collect $10,000 of settled cash within 30 days using little up-front capital.',
    expect: { amount: [10_000], days: 30, capital: null, shape: 'LIVE', fallback: { amountCents: 1_000_000, capitalCeilingCents: null, hoursCeiling: null } },
  },
  {
    id: '1K-to-10K-30d',
    words: 'Turn $1,000 into $10,000 within 30 days.',
    // Ending with $10,000 from $1,000 is $9,000 of new cash; reading the $10,000 as the amount is also accepted.
    expect: { amount: [9_000, 10_000], days: 30, capital: 1_000, shape: 'CAPITAL_LIGHT', fallback: { amountCents: 1_000_000, capitalCeilingCents: 100_000, hoursCeiling: null } },
  },
  {
    id: '10K-to-100K-90d',
    words: 'Turn $10,000 into $100,000 within 90 days.',
    expect: { amount: [90_000, 100_000], days: 90, capital: 10_000, shape: 'CAPITAL_HEAVY', fallback: { amountCents: 10_000_000, capitalCeilingCents: 1_000_000, hoursCeiling: null } },
  },
  {
    id: '5K-MRR-60d',
    words: 'Earn $5,000 a month in recurring revenue within 60 days with no more than 10 hours a week of owner time.',
    expect: { amount: [5_000], days: 60, capital: null, shape: 'RECURRING', fallback: { amountCents: 500_000, capitalCeilingCents: null, hoursCeiling: 86 } },
  },
  {
    id: '20K-45d-cleaning',
    words: 'Generate $20,000 within 45 days in a single industry the owner names: commercial cleaning.',
    expect: { amount: [20_000], days: 45, capital: null, shape: 'INDUSTRY', fallback: { amountCents: 2_000_000, capitalCeilingCents: null, hoursCeiling: null } },
  },
  {
    id: 'LIVE-10K-7d',
    words: 'Collect $10,000 of settled cash within 7 days using little up-front capital.',
    expect: { amount: [10_000], days: 7, capital: null, shape: 'SHORT_DEADLINE', fallback: { amountCents: 1_000_000, capitalCeilingCents: null, hoursCeiling: null } },
  },
];

/**
 * The lines a plan would actually work: its candidate's members and every
 * opening its steps sell. A constructed arrangement is named by the held
 * opening its title is built from, so a plan is compared by what it does,
 * never by the random id an arrangement got on this read.
 */
function planLines(p: PlanReading, byId: Map<string, Held>): { candidate: Held[]; sold: Held[]; unnamed: string[] } {
  // Every line the plan read has a title: a found opening's, or a constructed arrangement's in the portfolio's demand.
  const titleOf = new Map([...(p.portfolio?.demand ?? []).map((d) => [d.opportunityId, d.title] as const), ...p.considered.map((c) => [c.opportunityId, c.title] as const)]);
  // An empty title names nothing (it once matched every held opening, so an unresolved arrangement read as the first one).
  const byTitle = (t: string): Held | undefined => (t ? WORLD.find((h) => t.startsWith(h.title.slice(0, 40)) || t.includes(h.title.slice(0, 40)) || h.title.startsWith(t.slice(0, 40))) : undefined);
  const unnamed: string[] = [];
  const candidate: Held[] = [];
  for (const id of p.acceptance.candidate?.opportunityIds ?? []) {
    const h = byId.get(id) ?? byTitle(titleOf.get(id) ?? '');
    if (h) candidate.push(h);
    else unnamed.push(titleOf.get(id) ?? id);
  }
  for (const m of p.reconstruction && p.adoption.source === 'RECONSTRUCTED' ? p.reconstruction.best.members : []) {
    const h = byTitle(m);
    if (h && !candidate.includes(h)) candidate.push(h);
  }
  const sold = p.steps.map((s) => /^Sell "(.*)"$/.exec(s.label)?.[1]).filter((t): t is string => !!t).map(byTitle).filter((h): h is Held => !!h);
  return { candidate: [...new Set(candidate)], sold, unnamed };
}

/** What a plan is, for telling two plans apart: the lines it works, in the order it works them. */
function signature(p: PlanReading, byId: Map<string, Held>): string {
  const l = planLines(p, byId);
  return `${l.candidate.map((h) => h.key).sort().join('+') || '∅'}|sell:${l.sold.map((h) => h.key).join(',')}|${p.acceptance.status}`;
}

const signatures = new Map<string, string>();

beforeEach(() => {
  // Each case builds its own world; nothing carries over but the signatures.
});

describe('REHEARSAL — Brain plans unfamiliar objectives from their words (offline, not production)', () => {
  for (const o of OBJECTIVES) {
    it(o.id, async () => {
      const e = rehearsal(o.id);
      const byId = await freshWorld();
      const t0 = performance.now();

      // 1. The words, through the one writer of a goal from words.
      const created = await createGoal({ projectId, objective: o.words, actorRef: `person:${userId}`, userId, now: new Date(NOW.getTime() - 60_000) });
      const readGoal = created.ok ? created.goal : null;
      const target = readGoal?.target ?? null;
      const interp = interpretObjective({ title: o.words, intent: o.words, outcome: null, dueAt: null });
      const budget = interp.constraints.find((c) => c.kind === 'BUDGET')?.value ?? null;
      e.measure({
        words: o.words,
        created: created.ok,
        refusal: created.ok ? null : created.reason.slice(0, 200),
        readAmount: created.reading.amount,
        readDeadlineDays: created.reading.deadlineHours === null ? null : Math.round(created.reading.deadlineHours / 24),
        readCapital: created.reading.capitalCeiling,
        readHours: created.reading.hoursCeiling,
        readKind: created.reading.kind,
        unread: created.reading.unread,
        plannerBudget: budget,
        plannerIndustry: interp.industry,
      });

      await e.check('R1 amount read correctly', 'WRONG_READING', () => {
        expect(created.ok).toBe(true);
        expect(o.expect.amount).toContain((target?.amountCents ?? -100) / 100);
      });
      await e.check('R2 deadline read correctly', 'WRONG_READING', () => expect(created.reading.deadlineHours).toBe(o.expect.days * 24));
      await e.check('R3 capital read correctly (goal target and the planner\'s budget)', 'WRONG_READING', () => {
        expect(created.ok).toBe(true);
        expect(target?.capitalCeilingCents === null || target?.capitalCeilingCents === undefined ? null : target.capitalCeilingCents / 100).toBe(o.expect.capital);
        // The objective planner (`planObjective`) reads its own budget from the words; it must agree.
        expect(budget).toBe(o.expect.capital);
      });
      if (o.expect.shape === 'RECURRING') {
        await e.check('R4 the recurring monthly figure and the 10 h/week limit are read', 'WRONG_READING', () => {
          expect(created.reading.kind).toBe('CASH');
          expect(created.reading.unread.join(' ')).not.toMatch(/a rate, not a total|an hours rate/);
        });
      }
      if (o.expect.shape === 'INDUSTRY') {
        await e.check('R4 the named industry is read', 'WRONG_READING', () => expect(interp.industry ?? '').toMatch(/commercial cleaning/i));
      }

      // 2. The goal the plan runs on: the one the words made, or the explicit fallback.
      let goalId = created.ok && target ? created.goal.id : null;
      let fallback = false;
      if (!goalId) {
        fallback = true;
        const explicit = await createGoal({
          projectId, objective: o.words, actorRef: `person:${userId}`, userId, now: new Date(NOW.getTime() - 60_000), dueAt: inDays(o.expect.days),
          target: { metric: 'SETTLED_CASH', amountCents: o.expect.fallback.amountCents, currency: 'USD', capitalCeilingCents: o.expect.fallback.capitalCeilingCents, hoursCeiling: o.expect.fallback.hoursCeiling },
        });
        expect(explicit.ok).toBe(true);
        goalId = explicit.ok ? explicit.goal.id : null;
      }
      const plan = (await readGoalPlan({ goalId: goalId!, evaluations: 1_000 }))!;
      const planMs = Math.round(performance.now() - t0);
      const lines = planLines(plan, byId);
      // What the plan works: its candidate's lines and every line its steps sell.
      const members = [...new Set([...lines.candidate, ...lines.sold])];
      const committed = plan.reconstruction?.best.committed ?? null;
      const binding = plan.reconstruction?.diagnosis[0]?.factor ?? null;
      const sig = signature(plan, byId);
      signatures.set(o.id, sig);
      e.measure({
        fallback,
        goalCapital: (await getWorkstream(goalId!))?.target?.capitalCeilingCents ?? null,
        status: plan.acceptance.status,
        verdict: plan.acceptance.verdict ?? null,
        probability: plan.acceptance.probability,
        reach: plan.acceptance.candidate?.reach ?? null,
        reachBasis: plan.acceptance.candidate?.reachBasis ?? null,
        constructionBasis: plan.acceptance.construction?.interval?.basis ?? null,
        candidate: lines.candidate.map((h) => h.key),
        unnamedCandidate: lines.unnamed.map((t) => t.slice(0, 90)),
        sold: lines.sold.map((h) => h.key),
        committed,
        binding,
        limitation: plan.reconstruction?.limitation?.slice(0, 200) ?? null,
        infeasible: plan.infeasible ? { reason: plan.infeasible.reason.slice(0, 160), relax: plan.infeasible.relax.map((r) => r.constraint) } : null,
        steps: plan.steps.map((s) => `${s.order}:${s.basis}:${s.owner}:${s.label.slice(0, 60)}`),
        research: plan.researchPriority.slice(0, 3).map((r) => `${r.variable}:${r.field ?? 'by selling'}`),
        degraded: plan.degraded,
        signature: sig,
        planMs,
      });

      e.measure({ scope: plan.target.scope ?? null, beforeProof: plan.target.capitalBeforeProofCents });
      // What the plan was told to obey: the scope the words set, read on the plan's own target.
      if (o.expect.shape === 'LIVE' || o.expect.shape === 'SHORT_DEADLINE') {
        await e.check('R5 "little up-front capital" is planned at an assumed low ceiling, flagged as an assumption', 'WRONG_READING', () => {
          expect(plan.target.scope?.capitalAssumed?.cents).toBe(100_000);
          expect(plan.target.capitalBeforeProofCents).toBe(100_000);
          expect(plan.target.capitalCeilingCents).toBeNull();
        });
      }
      if (o.expect.shape === 'RECURRING') {
        await e.check('R5 the plan counts a monthly recurring run-rate within 10 h/week', 'WRONG_READING', () => {
          expect(plan.target.scope?.recurring).toBe('MONTHLY');
          expect(plan.target.scope?.hoursPerWeek).toBe(10);
          expect(plan.target.hoursCeiling).toBe(86);
        });
      }
      if (o.expect.shape === 'INDUSTRY') {
        await e.check('R5 the named industry reaches the plan', 'CONSTRAINT_IGNORED', () => expect(plan.target.scope?.industry).toBe('commercial cleaning'));
      }

      // M — the candidate differs as the objective demands.
      switch (o.expect.shape) {
        case 'LIVE':
          await e.check('M1 a candidate is constructed', 'MISSING_STEP', () => expect(plan.acceptance.candidate).not.toBeNull());
          await e.check('M2 "little up-front capital": the $8,000 resale is not worked', 'CONSTRAINT_IGNORED', () => expect(members.map((h) => h.key)).not.toContain('resale'));
          break;
        case 'CAPITAL_LIGHT':
          await e.check('M1 the plan ties up no more than the $1,000 the owner has', 'CONSTRAINT_IGNORED', () => {
            expect(members.every((h) => h.capitalCents <= 100_000)).toBe(true);
            expect(committed ?? 0).toBeLessThanOrEqual(1_000 + 1e-6);
          });
          break;
        case 'CAPITAL_HEAVY':
          await e.check('M1 the plan uses the stated $10,000 (a capital-using line is among its members) and stays within it', 'SAME_PLAN', () => {
            expect(members.some((h) => h.capitalCents > 0)).toBe(true);
            expect(committed ?? 0).toBeLessThanOrEqual(10_000 + 1e-6);
          });
          break;
        case 'RECURRING':
          await e.check('M1 the plan is built on a recurring line', 'SAME_PLAN', () => expect(members.some((h) => h.recurring)).toBe(true));
          await e.check('M2 the plan is not a one-off plan (no one-off line is the plan)', 'CONSTRAINT_IGNORED', () => expect(members.every((h) => h.recurring)).toBe(true));
          break;
        case 'INDUSTRY':
          await e.check('M1 every member is in commercial cleaning', 'CONSTRAINT_IGNORED', () => {
            expect(members.length).toBeGreaterThan(0);
            expect(members.every((h) => h.industry === 'commercial cleaning')).toBe(true);
          });
          break;
        case 'SHORT_DEADLINE':
          await e.check('M1 no member settles after the 7-day deadline, or the goal is reported infeasible', 'CONSTRAINT_IGNORED', () => {
            if (plan.acceptance.status !== 'NOT_SUPPORTED') expect(members.every((h) => h.days <= 7)).toBe(true);
          });
          break;
      }
      if (o.expect.shape !== 'LIVE') {
        const live = signatures.get('LIVE-10K-30d');
        await e.check('M3 the plan differs from the live goal\'s plan', 'SAME_PLAN', () => {
          expect(live).toBeDefined();
          expect(sig).not.toBe(live);
        });
      }

      // B — the binding constraint is stated.
      await e.check('B1 the plan states its binding constraint', 'CONSTRAINT_IGNORED', () => {
        expect(binding !== null || (plan.infeasible?.relax.length ?? 0) > 0).toBe(true);
      });

      // S — executable or explicit research steps.
      await e.check('S1 the plan has executable steps or explicit research steps', 'MISSING_STEP', () => {
        expect(plan.steps.length + plan.researchPriority.length).toBeGreaterThan(0);
        for (const s of plan.steps) expect(s.kill.length).toBeGreaterThan(0);
      });

      // C — no confidence its inputs do not support.
      await e.check('C1 not certified (the held openings carry assumed conversion)', 'FALSE_CONFIDENCE', () => {
        expect(plan.acceptance.status).not.toBe('ACCEPTED');
        expect(plan.acceptance.probability).toBeNull();
      });
      await e.check('C2 any reach shown is labelled coverage unless every input is evidenced', 'FALSE_CONFIDENCE', () => {
        if (plan.acceptance.candidate?.reachBasis === 'PROBABILITY') expect(plan.acceptance.construction?.interval?.basis).toBe('EVIDENCE');
        if (plan.reconstruction?.best.changes.some((c) => c.basis === 'ASSUMPTION')) expect(plan.reconstruction.confidence.basis).toBe('COVERAGE');
      });

      e.done();
    }, 600_000);
  }
});
