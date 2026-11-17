/**
 * F3e, production 2026-11-17: 515 monetization questions asked, 13 ANSWERED,
 * 490 UNRESOLVED ("published sources do not settle"). Research was being sent
 * questions no publication answers:
 *
 *   (a) a judgement Brain makes (`owner: 'BRAIN_PROPOSES'`) commissioned as
 *       published-source research;
 *   (b) questions about a hypothetical arrangement from the opening × method
 *       cross product, which no source said applies;
 *   (c) an answer already on the opening's card not carried to the question.
 *
 * Each is routed elsewhere here, and none is dropped silently: a declined
 * question says why and what would make it askable, and the evidence bar for
 * what research files is untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { listPaths, pathFact } from '../server/repos/monetization.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { getDb } from '../server/db/database.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { goalRoundsAwaitingLaunch } from '../server/services/goals/goalWork.ts';
import {
  cardAnswers,
  enumeratePossibilities,
  statedBySource,
  termDays,
} from '../server/services/cash/monetization/enumerate.ts';
import { composeLedger, rankableOf } from '../server/services/cash/monetization/ledger.ts';
import {
  allocateCommissions,
  NEVER_COMMISSIONED,
  UNSTATED_WHY,
  HYPOTHESIS_ATTRIBUTE,
  HYPOTHESIS_RULE_RANK,
  hypothesisCheckCap,
  hypothesisRoom,
} from '../server/services/cash/monetization/commission.ts';
import { runCommissions } from '../server/services/cash/monetization/commissionPass.ts';
import { ATTRIBUTE } from '../server/domain/monetization.ts';
import { registerResearchSurfaces } from './helpers/researchSurfaces.ts';
import {
  MONETIZATION_ATTRIBUTES,
  type CashCardFact,
  type CashOpportunity,
  type MonetizationCommission,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  const project = await freshProject();
  projectId = project.project.id;
  const user = await createUser({
    email: `routing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  userId = user.id;
  const started = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(started.ok).toBe(true);
  cashModeId = started.ok ? started.mode.id : '';
});

/** One harvested discovery with a named payer, as the commissioning suite makes one. */
async function discovery(title: string, columns: Record<string, unknown> = {}): Promise<CashOpportunity> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: 'PAID_TASK_OR_CONTRACT',
    source: 'A publisher',
  });
  const updated = await updateOpportunity(created.id, {
    buying_signal: title,
    signal_observed_at: '2026-09-15',
    payer: 'A named buyer',
    ...columns,
  });
  return updated ?? created;
}

async function tick(): Promise<Awaited<ReturnType<typeof runCommissions>>> {
  const ledger = await composeLedger({ projectId });
  return runCommissions({ projectId, ledger });
}

describe('(a) an attribute Brain proposes is not commissioned as research', () => {
  it('reads it off the declared owner, keeps the probability rule, and says why', async () => {
    for (const attribute of MONETIZATION_ATTRIBUTES) {
      expect(NEVER_COMMISSIONED.has(attribute)).toBe(
        ATTRIBUTE[attribute].owner === 'BRAIN_PROPOSES' || attribute === 'probabilityOfSuccess',
      );
    }
    expect(NEVER_COMMISSIONED.has('executionDifficulty')).toBe(true);
    expect(NEVER_COMMISSIONED.has('scalability')).toBe(true);
    // Research-owned in the declaration, and what a capability blocker names.
    expect(NEVER_COMMISSIONED.has('requiredCapability')).toBe(false);

    await discovery('A published request for transcription.');
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    const allocation = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: [],
      contradicted: new Set(),
      slots: 100,
      now: Date.now(),
    });
    expect(allocation.asks.length).toBeGreaterThan(0);
    expect(
      allocation.asks.some((one) => ATTRIBUTE[one.attribute].owner === 'BRAIN_PROPOSES'),
    ).toBe(false);
    expect(
      allocation.declined.some((one) => one.why.startsWith('this is a judgement Brain makes')),
    ).toBe(true);
  });
});

describe('(b) a hypothetical arrangement is not a research subject', () => {
  it('asks only about the path the opening stands for, and keeps the rest with the reason', async () => {
    const opening = await discovery('A published request for transcription.');
    await enumeratePossibilities(projectId);
    await registerResearchSurfaces(projectId, 3);
    const paths = await listPaths({ projectId });
    expect(paths.length).toBeGreaterThan(1);
    const stated = paths.filter((one) => statedBySource(one, opening, false));
    expect(stated.map((one) => one.method)).toEqual(['DIRECT_SALE']);

    const pass = await tick();
    // The stated path is asked its ordinary questions; a hypothesis is asked
    // only its bounded existence check, one opening's hypothesis at a time.
    const onStated = pass.opened.filter((one) => one.pathId === stated[0]!.id);
    const checks = pass.opened.filter((one) => one.pathId !== stated[0]!.id);
    expect(onStated.length).toBe(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.attribute).toBe(HYPOTHESIS_ATTRIBUTE);
    expect(checks[0]!.question).toContain('Does any published source state');
    // Every other hypothesis is declined with a reason, never silently.
    const others = pass.declined.filter(
      (one) => one.why.includes('same opening is being checked first') || one.why === UNSTATED_WHY,
    );
    expect(others.length).toBeGreaterThanOrEqual(paths.length - 2);
    // And kept: nothing is archived or deleted for being hypothetical.
    const ledger = await composeLedger({ projectId });
    expect(ledger.entries).toHaveLength(paths.length);
  });

  it('asks a capability blocker on the opening once, on the stated path — or on a hypothesis when none is stated', async () => {
    const opening = await discovery('A published request for transcription.');
    await raiseNeed({
      projectId,
      opportunityId: opening.id,
      actorRef: 'BRAIN',
      blockedAction: 'Contact the buyer',
      whyItMatters: 'w',
      recommendedPath: 'r',
      setupEffort: 's',
      nextStep: 'n',
      completionCondition: 'SEND_A_MESSAGE reads PRESENT.',
      requestKey: `capability:${opening.id}:SEND_A_MESSAGE`,
    });
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    expect(ledger.entries.every((one) => one.status === 'BLOCKED')).toBe(true);
    const stated = ledger.entries.find((one) => statedBySource(one.path, opening, false))!;
    const hypotheses = ledger.entries.filter((one) => one.path.id !== stated.path.id);
    const allocate = (unstated: Set<string>) =>
      allocateCommissions({
        entries: ledger.entries,
        rankable: ledger.entries.map(rankableOf),
        commissions: [],
        contradicted: new Set(),
        slots: 100,
        now: Date.now(),
        unstated,
      });

    // A stated path exists: the opening's blocker is asked there, and the
    // hypotheses wait with the opening rather than asking it again.
    const withStated = allocate(new Set(hypotheses.map((one) => one.path.id)));
    expect(withStated.asks.map((one) => [one.pathId, one.attribute])).toEqual([
      [stated.path.id, 'requiredCapability'],
    ]);
    expect(withStated.declined.some((one) => one.why.includes('The opening is blocked'))).toBe(true);

    // None is stated: the blocker is still asked, on a hypothesis, and only it.
    const noneStated = allocate(new Set(ledger.entries.map((one) => one.path.id)));
    expect(noneStated.asks.length).toBeGreaterThan(0);
    expect(noneStated.asks.every((one) => one.attribute === 'requiredCapability')).toBe(true);
    expect(noneStated.asks.every((one) => one.ruleRank !== HYPOTHESIS_RULE_RANK)).toBe(true);
  });

  it('becomes askable once a source names it or a person judges it', () => {
    const opening = { mechanism: 'EXPLICIT_PAID_REQUEST' as const };
    const hypothesis = {
      origin: 'ENUMERATED' as const,
      sourceClaimId: null,
      method: 'REFERRAL_FEE' as const,
      opportunityId: 'opp_1',
    };
    expect(statedBySource(hypothesis, opening, false)).toBe(false);
    expect(statedBySource(hypothesis, null, false)).toBe(false);
    expect(statedBySource({ ...hypothesis, method: 'DIRECT_SALE' }, opening, false)).toBe(true);
    expect(statedBySource({ ...hypothesis, sourceClaimId: 'clm_1' }, opening, false)).toBe(true);
    expect(statedBySource(hypothesis, opening, true)).toBe(true);
    expect(statedBySource({ ...hypothesis, origin: 'EVIDENCED' }, opening, false)).toBe(true);
    expect(statedBySource({ ...hypothesis, origin: 'SEED' }, opening, false)).toBe(true);
    expect(statedBySource({ ...hypothesis, opportunityId: null }, null, false)).toBe(true);
  });

  it('still re-asks a contradicted answer on a hypothetical path', async () => {
    await discovery('A published request for transcription.');
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    const target = ledger.entries.find((one) => one.path.method !== 'DIRECT_SALE')!;
    const allocation = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: [],
      contradicted: new Set([`${target.path.id}::expectedRevenue`]),
      slots: 100,
      now: Date.now(),
      unstated: new Set([target.path.id]),
    });
    expect(allocation.declined.some((one) => one.subject === target.path.title && one.why === UNSTATED_WHY)).toBe(
      false,
    );
  });
});

describe('(c) an answer already on the card settles the question without research', () => {
  it('carries the card onto the path it stands for, at the card\'s own authority', async () => {
    const opening = await discovery('A published request for transcription.', {
      payment_terms: 'Net 30',
    });
    await recordCardFact({
      projectId,
      opportunityId: opening.id,
      field: 'directCosts',
      kind: 'PERSON',
      value: 'USD 120.00 of tooling per job',
      decidedBy: userId,
    });
    await enumeratePossibilities(projectId);

    const paths = await listPaths({ projectId });
    const primary = paths.find((one) => one.method === 'DIRECT_SALE')!;
    const terms = await pathFact(primary.id, 'timeToCash');
    expect(terms?.kind).toBe('RECOMMENDATION');
    expect(terms?.value).toBe('Net 30');
    expect(terms?.days).toBe(30);
    expect(terms?.basis).toBeTruthy();
    const costs = await pathFact(primary.id, 'directCosts');
    expect(costs?.kind).toBe('PERSON');
    expect(costs?.amountCents).toBe(12_000);
    // The payer on the card answers who has to take the call.
    expect((await pathFact(primary.id, 'requiredRelationships'))?.value).toBe('A named buyer');
    // Only the path the card stands for: a hypothetical one is not given it.
    const other = paths.find((one) => one.id !== primary.id)!;
    expect(await pathFact(other.id, 'timeToCash')).toBeNull();

    // A second pass writes nothing new, and research is not asked for either.
    await enumeratePossibilities(projectId);
    expect((await pathFact(primary.id, 'timeToCash'))?.updatedAt).toBe(terms?.updatedAt);
    const ledger = await composeLedger({ projectId });
    const entry = ledger.entries.find((one) => one.path.id === primary.id)!;
    expect(entry.unknowns).not.toContain('timeToCash');
    expect(entry.unknowns).not.toContain('directCosts');
    await registerResearchSurfaces(projectId, 3);
    const pass = await tick();
    expect(
      pass.opened.some(
        (one) =>
          one.pathId === primary.id &&
          ['timeToCash', 'directCosts', 'requiredRelationships'].includes(one.attribute),
      ),
    ).toBe(false);
  });

  it('keeps a gated card answer as evidence on its claim, and a claimless one as a proposal', async () => {
    const opening = await discovery('A request.');
    const fact = (over: Partial<CashCardFact>): CashCardFact => ({
      id: 'ccf_1',
      projectId,
      opportunityId: opening.id,
      field: 'price',
      kind: 'EVIDENCE',
      value: 'USD 450.00 per job',
      claimId: 'clm_1',
      needId: null,
      basis: null,
      assumptions: null,
      uncertainty: null,
      decidedBy: 'BRAIN',
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
      ...over,
    });
    const revenue = (card: CashCardFact[]) =>
      cardAnswers(opening, card).filter((one) => one.attribute === 'expectedRevenue');
    expect(revenue([fact({})])).toMatchObject([{ kind: 'EVIDENCE', claimId: 'clm_1' }]);
    const claimless = revenue([fact({ claimId: null })]);
    expect(claimless).toMatchObject([{ kind: 'RECOMMENDATION', claimId: null }]);
    expect(claimless[0]!.basis).toBeTruthy();
    // The stronger of two fields asking one attribute wins.
    const both = revenue([
      fact({ kind: 'RECOMMENDATION', claimId: null, basis: 'a proposal' }),
      fact({ field: 'revenueRange', kind: 'PERSON', claimId: null, value: 'USD 400.00' }),
    ]);
    expect(both).toHaveLength(1);
    expect(both[0]!.kind).toBe('PERSON');
  });

  it('reads a payment term as days and invents none', () => {
    expect(termDays('Net 30')).toBe(30);
    expect(termDays('net-45 from invoice')).toBe(45);
    expect(termDays('paid within 14 days')).toBe(14);
    expect(termDays('paid on approval')).toBeNull();
    expect(termDays('Network fees apply')).toBeNull();
  });
});

/**
 * W3c. Every hypothesis has its own check per epoch, and 11.5k possibilities
 * would otherwise turn every leftover research slot into one once the ceiling
 * is raised. One open check per opening, a small share of the grant, and none
 * while a goal round is waiting for a slot.
 */
describe('hypothesis checks cannot flood research (W3c)', () => {
  it('holds the checks to a minority share of the grant, and to none while a goal round waits', () => {
    expect(hypothesisCheckCap(null)).toBe(0);
    expect(hypothesisCheckCap(0)).toBe(0);
    expect(hypothesisCheckCap(2)).toBe(1);
    expect(hypothesisCheckCap(13)).toBe(3);
    expect(hypothesisCheckCap(100)).toBe(25);
    for (const grant of [1, 2, 3, 4, 8, 13, 40, 100]) {
      expect(hypothesisCheckCap(grant)).toBeLessThanOrEqual(Math.max(1, grant / 4));
    }
    expect(hypothesisRoom({ grantMax: 13, openChecks: 1, goalRoundsWaiting: 0 })).toBe(2);
    expect(hypothesisRoom({ grantMax: 13, openChecks: 5, goalRoundsWaiting: 0 })).toBe(0);
    expect(hypothesisRoom({ grantMax: 13, openChecks: 0, goalRoundsWaiting: 1 })).toBe(0);
  });

  async function twoOpenings() {
    const a = await discovery('A published request for transcription.');
    const b = await discovery('A published request for translation.');
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    const unstated = new Set(
      ledger.entries
        .filter((one) => !statedBySource(one.path, one.path.opportunityId === a.id ? a : b, false))
        .map((one) => one.path.id),
    );
    return { a, b, ledger, unstated };
  }

  it('opens none without a share, at most the share, and one per opening across passes', async () => {
    const { a, ledger, unstated } = await twoOpenings();
    const allocate = (hypothesisRoom: number | undefined, commissions: MonetizationCommission[] = []) =>
      allocateCommissions({
        entries: ledger.entries,
        rankable: ledger.entries.map(rankableOf),
        commissions,
        contradicted: new Set(),
        slots: 100,
        now: Date.now(),
        unstated,
        ...(hypothesisRoom === undefined ? {} : { hypothesisRoom }),
      });
    const checks = (plan: ReturnType<typeof allocate>) =>
      plan.asks.filter((one) => one.ruleRank === HYPOTHESIS_RULE_RANK);

    // Deny by default: a caller that does not compose the share opens none.
    expect(checks(allocate(undefined))).toHaveLength(0);
    // The share bounds it, even with a hundred free slots and two openings.
    expect(checks(allocate(1))).toHaveLength(1);
    expect(checks(allocate(5))).toHaveLength(2);
    const declined = allocate(1).declined.filter((one) => one.why.includes('small share of the research grant'));
    expect(declined.length).toBeGreaterThan(0);

    // A check still open on opening A blocks a second one on A in a later pass.
    const onA = ledger.entries.find((one) => unstated.has(one.path.id) && one.path.opportunityId === a.id)!;
    const open: MonetizationCommission = {
      id: 'mco_open',
      projectId,
      cashModeId,
      pathId: onA.path.id,
      attribute: HYPOTHESIS_ATTRIBUTE,
      round: 1,
      candidateId: 'rcn_open',
      reason: 'check',
      ruleRank: HYPOTHESIS_RULE_RANK,
      state: 'OPEN',
      answered: 0,
      outcome: null,
      openedAt: new Date().toISOString(),
      settledAt: null,
    } as unknown as MonetizationCommission;
    const later = checks(allocate(5, [open]));
    expect(later).toHaveLength(1);
    const openingOf = new Map(ledger.entries.map((one) => [one.path.id, one.path.opportunityId]));
    expect(openingOf.get(later[0]!.pathId)).not.toBe(a.id);
  });

  it('opens no check while one of the goal\'s rounds is waiting for a slot', async () => {
    await twoOpenings();
    await registerResearchSurfaces(projectId, 3);
    const round = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'A goal round',
      statement: 'Find buyers for the goal.',
    });
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'OPEN', ?, 0, ?, ?)`,
      ['cdr_goal_waiting', projectId, cashModeId, 'goal-wst_x-lens-a', 'GOAL_MECHANISM', round.id, at, at, at],
    );
    expect(await goalRoundsAwaitingLaunch(projectId)).toBe(1);

    const waiting = await tick();
    expect(waiting.opened.some((one) => one.reason.includes('one bounded check'))).toBe(false);
    expect(waiting.opened.length).toBeGreaterThan(0);
    // The stated questions still run; only the checks stand aside.
    expect(waiting.declined.some((one) => one.why.includes('a goal round is waiting'))).toBe(true);
  });
});
