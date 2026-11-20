/**
 * Production 2026-11-19 (release e1daa132): after #1136 held comparable price
 * pools to one order of magnitude, ~304 of 307 constructed designs per cash
 * goal were cut as "no comparable price", and the cut was the only record of
 * it. No question about what those buyers pay was raised from it, the goals'
 * plan readings carried no research row about price, and the context-free
 * "the price per deal" ideas the portfolio did raise sat unjudged behind
 * 14,737 ordinary ideas, because a need with no opening row was never the
 * goal's work.
 *
 * Now each refused design's buyers are carried on the portfolio with the
 * construction's own price question, the goal tick sends one research need
 * per population, and its idea is the goal's, so it is judged and launched in
 * the goal's tier.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { selectEstimatedArrangements, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { GOAL_PRICE_KEY_PREFIX, goalIdeaSql } from '../server/services/goals/goalWork.ts';
import type { GoalPortfolio, UnpricedPopulation } from '../server/services/goals/portfolio.ts';
import { PRICE_ASKS_PER_READ, sendPortfolioNeeds } from '../server/services/goals/portfolioNeeds.ts';

function arrangement(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: 'svc',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'Professional Services',
    demand: { name: 'regional accounting firms', claimId: null, from: 'INDUSTRY_MAP', ref: 'pop_acct' },
    need: { name: 'client onboarding packets', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_onboarding' },
    supply: null,
    label: 'Accounting firms: client onboarding packets',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'UNKNOWN', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: ['buyers', 'value', 'conversion'],
    relatedOpenings: [],
    question: 'What do accounting firms pay for onboarding packets?',
    ...over,
  } as ConstructedArrangement;
}

/** The production sector's shape: published prices spanning $20–$300,000, no comparable price for anyone in it. */
const WIDE: ComparablePrice[] = [20, 42, 100, 300, 900, 2_569, 8_000, 25_000, 60_000, 156_737, 300_000].map((value) => ({ value, industry: 'professional services' }));
const input = { projectId: 'prj_prod', currency: 'USD', beforeProofCents: 300_000, remaining: 100_000, exclusions: [], daysLeft: 60, otherPrices: WIDE };

describe('a design refused for want of a price names its buyers and the question that would price them', () => {
  it('records one entry per buyer population, most designs first, with the construction’s declared price question', () => {
    const dental = { name: 'independent dental practices', claimId: null, from: 'INDUSTRY_MAP' as const, ref: 'pop_dental' };
    const selected = selectEstimatedArrangements(
      [
        arrangement({ key: 'd1', demand: dental, label: 'Dental practices: recall letters' }),
        arrangement({ key: 'a1' }),
        arrangement({ key: 'a2', design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' } }),
      ],
      input,
    );
    expect(selected.openings).toHaveLength(0);
    expect(selected.selection.cut.every((one) => /no comparable price/.test(one.reason))).toBe(true);
    const unpriced = selected.selection.unpriced;
    expect(unpriced.map((one) => [one.population, one.designs])).toEqual([
      ['pop_acct', 2],
      ['pop_dental', 1],
    ]);
    const acct = unpriced[0]!;
    expect(acct).toMatchObject({ buyer: 'regional accounting firms', arrangementKey: 'a1' });
    // The question names the buyers and the deliverable, and declares the fact its answer files.
    expect(acct.question).toContain('"regional accounting firms" pay, in USD');
    expect(acct.question).toContain('client onboarding packets');
    expect(acct.question).toContain('structural_subject price_per_unit, structural_qualifier "regional accounting firms"');
  });

  it('records nothing for a design a price was found for, or one refused for another reason', () => {
    const tight: ComparablePrice[] = [800, 1_000, 1_500, 2_000].map((value) => ({ value, industry: 'professional services' }));
    expect(selectEstimatedArrangements([arrangement()], { ...input, otherPrices: tight }).selection.unpriced).toEqual([]);
    const exceeds = arrangement({ stress: { exposure: 'EXCEEDS', worstCaseCents: 1, failures: [] } as ConstructedArrangement['stress'] });
    expect(selectEstimatedArrangements([exceeds], input).selection.unpriced).toEqual([]);
  });
});

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

afterAll(async () => {
  await teardown();
});

function population(n: number): UnpricedPopulation {
  return {
    population: `pop_${n}`,
    buyer: `buyers number ${n}`,
    designs: 10 - n,
    arrangementKey: `k${n}`,
    label: `Design ${n}`,
    // As long as production's (~1,800 characters with its filing instructions), so a cut statement would show.
    question:
      `What does one buyer described as "buyers number ${n}" pay, in USD, for one purchase? ` +
      'Look for published price lists, rate cards and quoted prices of sellers who already sell this to these buyers. '.repeat(14) +
      'Declare each figure on its claim: structural_finding UNIT_ECONOMIC, structural_subject price_per_unit.',
  };
}

async function isGoalIdea(candidateId: string): Promise<boolean> {
  const rows = await getDb().all<{ id: string }>(`SELECT c.id FROM russell_candidates c WHERE c.id = ? AND ${goalIdeaSql('c')}`, [candidateId]);
  return rows.length === 1;
}

describe('the goal tick sends the populations nothing prices to research, as the goal’s own ideas', () => {
  it('raises one research need per population, a few a read, and the goal’s judge and launch order reach its idea', async () => {
    const unpriced = [1, 2, 3, 4].map(population);
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced } as unknown as GoalPortfolio;

    const first = await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    expect(first.refused).toEqual([]);
    expect(first.created).toBe(PRICE_ASKS_PER_READ);
    let needs = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`));
    expect(needs).toHaveLength(PRICE_ASKS_PER_READ);
    for (const need of needs) {
      expect(need.blockerKey).toBe(`EVIDENCE:${need.requestKey}`);
      const idea = await getCandidate(need.candidateId!);
      expect(idea?.state).toBe('CAPTURED');
      expect(idea?.statement).toMatch(/buyers number [123]" pay, in USD/);
      expect(idea?.statement).toContain('structural_subject price_per_unit');
      expect(idea?.statement).toContain('by what payment mechanism');
      // The goal's idea: judged in the goal's tier (`unjudgedGoalIdeas`) and launched ahead of the ordinary backlog.
      expect(await isGoalIdea(idea!.id)).toBe(true);
    }

    // The next read asks the next population rather than re-asking the open ones.
    const second = await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    expect(second.created).toBe(1);
    needs = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`));
    expect(needs).toHaveLength(4);

    // Keyed by the project's buyers, not the goal: another goal asking the same population adds nothing.
    const other = await sendPortfolioNeeds({ goalId: 'wst_other_goal', projectId, portfolio });
    expect(other.created).toBe(0);
    expect((await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`))).toHaveLength(4);
  });

  it('launches an open price question ahead of the goal’s own search rounds, and a closed one behind them', async () => {
    // Production 2026-11-20: 91 price questions QUEUED for eleven hours while every
    // freed slot went to the goal's rounds, which only add more unpriced openings.
    const { goalFirstSql } = await import('../server/services/goals/goalWork.ts');
    const { createCandidate } = await import('../server/repos/russellCandidates.ts');
    const { openRound } = await import('../server/repos/cashDiscovery.ts');
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced: [population(1)] } as unknown as GoalPortfolio;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    const [need] = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`));
    const round = await createCandidate({ title: 'Round', statement: 'Which shops share postcard costs?', projectId });
    await openRound({ projectId, cashModeId: 'cm_test', bucketId: 'goal-wst_price_goal-c1', mechanism: 'CONSTRUCTED', round: 1, candidateId: round.id });
    const older = await createCandidate({ title: 'Older', statement: 'An unrelated question.', projectId });
    const order = async () =>
      (await getDb().all<{ id: string }>(
        `SELECT c.id FROM russell_candidates c WHERE c.id IN (?, ?, ?) ORDER BY ${goalFirstSql('c')}, c.created_at, c.rowid`,
        [older.id, round.id, need!.candidateId!],
      )).map((one) => one.id);
    expect(await order()).toEqual([need!.candidateId, round.id, older.id]);
    // Once the price question is answered or withdrawn it is nobody's goal work.
    await getDb().run("UPDATE cash_needs SET state = 'RESOLVED' WHERE id = ?", [need!.id]);
    expect(await order()).toEqual([round.id, need!.candidateId, older.id]);
  });

  it('asks an open price question again when its idea was parked without an answer, up to the bound', async () => {
    // Production 2026-11-20: refused at planning before #1162, parked, and the need pointed at the dead idea for good.
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced: [population(1)] } as unknown as GoalPortfolio;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    const needOf = async () => (await listNeeds({ projectId })).find((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`))!;
    const first = (await needOf()).candidateId!;
    const ids = [first];
    for (let ask = 2; ask <= 4; ask += 1) {
      await getDb().run("UPDATE russell_candidates SET state = 'PARKED' WHERE id = ?", [ids[ids.length - 1]]);
      await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
      ids.push((await needOf()).candidateId!);
    }
    // Asked a second and third time through fresh ideas; the fourth read leaves the need on its third, parked idea.
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(ids[3]).toBe(ids[2]);
    // The earlier ideas keep their rows: what was asked first is still readable.
    expect((await getCandidate(first))?.state).toBe('PARKED');
    expect((await needOf()).state).toBe('OPEN');
  });

  it('does not re-ask a need whose idea is still live', async () => {
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced: [population(1)] } as unknown as GoalPortfolio;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    const before = (await listNeeds({ projectId })).find((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`))!.candidateId;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    expect((await listNeeds({ projectId })).find((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`))!.candidateId).toBe(before);
  });

  it('compiles a price question to require a price, not an open request (§14)', async () => {
    // Production 2026-11-20: compiled as plain market discovery, every price fragment was BLOCKED
    // for "1 required evidence lane(s) have no accepted claim: demand_signal".
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced: [population(1)] } as unknown as GoalPortfolio;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    const need = (await listNeeds({ projectId })).find((n) => n.requestKey?.startsWith(`${GOAL_PRICE_KEY_PREFIX}-`))!;
    // A sprint gives the project its discovery envelope; off the in-code slug map, so that is the one it compiles under.
    const { createUser } = await import('../server/repos/identity.ts');
    const { activate } = await import('../server/services/cash/lifecycle.ts');
    const userId = (await createUser({ email: `price-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`goalprice-${projectId.slice(-6)}`, projectId]);
    const { compileMission } = await import('../server/services/russell/compiler.ts');
    const { getProject } = await import('../server/repos/projects.ts');
    const compiled = await compileMission({
      candidate: (await getCandidate(need.candidateId!))!,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.reason).toBe(true);
    if (!compiled.ok) return;
    const lanes = compiled.mission.fragments[0]!.requiredEvidence;
    expect(lanes.find((lane) => lane.id === 'economics')!.necessity).toBe('REQUIRED');
    expect(lanes.find((lane) => lane.id === 'demand_signal')!.necessity).toBe('CONDITIONAL');
  });

  it('a context-free causal unknown is still not the goal’s idea', async () => {
    const portfolio = {
      best: null,
      marketHistory: [],
      causal: { decisionUnknowns: [{ opportunityId: 'arr_abc', unknown: 'the price per deal', sendTo: 'research' }] },
    } as unknown as GoalPortfolio;
    await sendPortfolioNeeds({ goalId: 'wst_price_goal', projectId, portfolio });
    const [need] = await listNeeds({ projectId });
    expect(need?.requestKey?.startsWith('causal-')).toBe(true);
    expect(await isGoalIdea(need!.candidateId!)).toBe(false);
  });
});
