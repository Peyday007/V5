/**
 * The investment committee's independent specialist reviewers (§117,
 * committeeSpecialists.ts): each role read by its own model call through the
 * operator's existing models and chat path, combined with the role's
 * deterministic layer without a vote — a model can add a FAIL, can hold a PASS
 * as UNKNOWN, can never turn a FAIL (least of all a critical one) or an UNKNOWN
 * into a PASS, and a model that fails or times out is UNKNOWN. With no model
 * configured the committee is its deterministic layer alone. No network: the
 * models are fake endpoints.
 */
import { describe, expect, it } from 'vitest';
import { COMMITTEE_ROLES, committeeFingerprint, reviewPlan, withSpecialist, type CommitteeInput, type CommitteeLeg, type CommitteeRole, type RoleVerdict, type SpecialistFinding, type SpecialistReview } from '../server/services/goals/committee.ts';
import type { PathFact } from '../server/services/goals/pathways.ts';
import { committeeContextOf, parseSpecialist, reviewFromDetail, reviewWithSpecialists, specialistPrompt, specialistReviewDue, specialistsConfigured, startSpecialistReview, SPECIALIST_EVENT, SPECIALIST_RETRY_MS } from '../server/services/goals/committeeSpecialists.ts';
import type { OperatorModel } from '../server/domain/operator.ts';

const fact = (value: number | string | null, status: PathFact['status'] = 'PROVEN', basis = 'evidence on the card', low: number | null = typeof value === 'number' ? value : null, high: number | null = low): PathFact => ({ value, low, high, status, basis });

const leg = (path: Record<string, unknown> = {}): CommitteeLeg => ({
  opportunityId: 'cop_meal',
  scope: 'COUNTED',
  pathway: {
    title: 'Allergen meal-plan spreadsheet for marketplace shoppers',
    origin: 'FOUND',
    buyer: fact('Marketplace shoppers planning allergen-free meals'),
    channel: fact('The marketplace listing'),
    offer: fact('Allergen meal-plan spreadsheet', 'ESTIMATED'),
    fulfiller: fact('Brain produces it: spreadsheet', 'ESTIMATED'),
    revenuePerDeal: fact(29, 'PROVEN', 'Comparable allergen meal-plan spreadsheets sell for $29 on the marketplace'),
    fulfilmentCost: fact(3),
    acquisitionCost: fact(null, 'UNKNOWN'),
    volume: fact(40, 'PROVEN', '40 reachable buyers'),
    daysToCash: fact(3),
    capital: fact(0),
    gaps: [],
    contribution: { p10: 400, p50: 900, p90: 1040 },
    permissionsMissing: [],
    ...path,
  } as CommitteeLeg['pathway'],
  demand: { deals: { p10: 16, p50: 36, p90: 40 }, price: { p10: 29, p50: 29, p90: 29 }, unestablished: [], capitalAtStart: 0, repeatable: true } as CommitteeLeg['demand'],
});

const input = (legs: CommitteeLeg[] = [leg()], tier: CommitteeInput['tier'] = 'FULL'): CommitteeInput => ({
  evidence: { goalId: 'wst_x', objective: 'settled cash of $1,000 more within 30 days', remaining: 1000, daysLeft: 30, capitalCeiling: null, currency: 'USD', legs },
  claims: { reach: 0.47, reachBasis: 'COVERAGE', probability: null, portfolioBasis: 'COVERAGE', settledP50: 1073, presentedHigh: 1000, adverse: 468, pathwayP10: 447, keptP50: 900, modelChallenge: null },
  tier,
});

const verdict = (over: Partial<RoleVerdict> = {}): RoleVerdict => ({ role: 'SKEPTIC', verdict: 'PASS', critical: false, defects: [], citations: [], open: [], settled: [], specialist: null, ...over });
const finding = (role: CommitteeRole, v: SpecialistFinding['verdict'], over: Partial<SpecialistFinding> = {}): SpecialistFinding => ({ role, verdict: v, defects: [], citations: [], model: 'free:m1', reason: null, ...over });
const modelDefect = { claim: 'the plan sells to shoppers', evidenceRef: 'cop_meal#buyer', why: 'the shoppers named are browsers, not buyers', critical: false, opportunityId: 'cop_meal', fact: 'buyer' as const, source: 'MODEL' as const };
const ruleCritical = { claim: 'counted at 10000 a deal', evidenceRef: 'cop_x#price', why: 'its money is a prize', critical: true, opportunityId: 'cop_x', fact: 'price' as const };

describe('combining a specialist with the role, without a vote', () => {
  it('never turns a deterministic critical FAIL into a PASS', () => {
    const out = withSpecialist(verdict({ verdict: 'FAIL', critical: true, defects: [ruleCritical] }), finding('SKEPTIC', 'PASS'));
    expect(out).toMatchObject({ verdict: 'FAIL', critical: true });
    expect(out.defects).toEqual([ruleCritical]);
  });

  it('adds a model FAIL with cited defects (never critical); an UNKNOWN never becomes a PASS', () => {
    const failed = withSpecialist(verdict(), finding('SKEPTIC', 'FAIL', { defects: [{ ...modelDefect, critical: true }] }));
    expect(failed.verdict).toBe('FAIL');
    expect(failed.critical).toBe(false);
    expect(failed.defects[0]).toMatchObject({ source: 'MODEL', critical: false });
    const open = verdict({ verdict: 'UNKNOWN', open: [{ role: 'SKEPTIC', opportunityId: 'cop_meal', fact: 'price', subject: 'SKEPTIC: x', question: 'q', research: 'committee SKEPTIC: x' }] });
    expect(withSpecialist(open, finding('SKEPTIC', 'PASS')).verdict).toBe('UNKNOWN');
  });

  it('a specialist that did not answer, timed out or failed without a defect holds a PASS as UNKNOWN', () => {
    expect(withSpecialist(verdict(), null)).toMatchObject({ verdict: 'UNKNOWN', specialist: { verdict: 'UNKNOWN', model: null } });
    const silent = withSpecialist(verdict(), finding('SKEPTIC', 'UNKNOWN', { model: null, reason: 'no specialist model answered within the bound' }));
    expect(silent.verdict).toBe('UNKNOWN');
    expect(silent.open[0]).toMatchObject({ opportunityId: null, subject: 'SKEPTIC: the independent specialist review' });
    expect(withSpecialist(verdict(), finding('SKEPTIC', 'PASS')).verdict).toBe('PASS');
  });
});

describe('the committee with and without its specialists', () => {
  it('no model configured: the deterministic committee alone, recorded NOT_RUN, the same verdict as before', () => {
    const plain = reviewPlan(input());
    const off = reviewPlan(input(), { specialistsAvailable: false });
    expect(off.verdict).toBe(plain.verdict);
    expect(off.blocks).toBe(plain.blocks);
    expect(off.specialists).toEqual({ state: 'NOT_RUN', reviewedAt: null, models: [] });
    // A routine review is never sent to a model.
    expect(reviewPlan(input([leg()], 'ROUTINE'), { specialistsAvailable: true }).specialists.state).toBe('NOT_RUN');
  });

  it('a FULL review with a model configured is PENDING until a review of this very plan is recorded, and blocks meanwhile', () => {
    const base = reviewPlan(input(), { specialistsAvailable: false });
    expect(base.verdict).toBe('PASS');
    const pending = reviewPlan(input(), { specialistsAvailable: true });
    expect(pending.specialists.state).toBe('PENDING');
    expect(pending.verdict).toBe('UNKNOWN');
    expect(pending.blocks).toBe(true);
    const fp = committeeFingerprint(input());
    const allPass: SpecialistReview = { fingerprint: fp, reviewedAt: '2026-11-24T00:00:00.000Z', findings: COMMITTEE_ROLES.map((r) => finding(r, 'PASS')) };
    const bound = reviewPlan(input(), { specialistsAvailable: true, specialistReviews: [allPass] });
    expect(bound).toMatchObject({ verdict: 'PASS', blocks: false, specialists: { state: 'BOUND', models: ['free:m1'] } });
    // A review of another plan never binds this one.
    expect(reviewPlan(input(), { specialistsAvailable: true, specialistReviews: [{ ...allPass, fingerprint: 'other' }] }).specialists.state).toBe('PENDING');
    // One specialist's cited FAIL fails the committee, though every rule passed.
    const oneFail = { ...allPass, findings: allPass.findings.map((f) => (f.role === 'MARKET_EXPERT' ? finding('MARKET_EXPERT', 'FAIL', { defects: [modelDefect] }) : f)) };
    const failed = reviewPlan(input(), { specialistsAvailable: true, specialistReviews: [oneFail] });
    expect(failed).toMatchObject({ verdict: 'FAIL', blocks: true, criticalDefects: 0 });
    expect(failed.blocker).toMatch(/^MARKET_EXPERT: the plan sells to shoppers/);
  });

  it('the fingerprint is the plan, not the answers read beside it', () => {
    expect(committeeFingerprint({ ...input(), answers: [{ ideaTitle: 't', claimId: 'c', text: 'x', sourceUrl: 'u' }] })).toBe(committeeFingerprint(input()));
    expect(committeeFingerprint(input([leg({ revenuePerDeal: fact(31) })]))).not.toBe(committeeFingerprint(input()));
  });
});

describe('the specialist call', () => {
  it('each prompt carries the evidence and never the acceptance; only QUANT, SKEPTIC and INVESTOR read the planner figures', () => {
    const operator = specialistPrompt('OPERATOR', input());
    expect(operator).toMatch(/You are the OPERATOR/);
    expect(operator).toMatch(/Comparable allergen meal-plan spreadsheets sell for \$29/);
    expect(operator).not.toMatch(/PLANNER'S FIGURES/);
    expect(specialistPrompt('QUANT', input())).toMatch(/PLANNER'S FIGURES/);
    for (const role of COMMITTEE_ROLES) expect(specialistPrompt(role, input())).not.toMatch(/ACCEPTED|acceptance|RECOMMENDABLE/);
  });

  it('parses a structured answer; an uncited FAIL is UNKNOWN; an answer that is not one is null', () => {
    expect(parseSpecialist({ verdict: 'fail', defects: [] }, 'QUANT', ['cop_meal'], 'm')).toMatchObject({ verdict: 'UNKNOWN', reason: /without citing a defect/ });
    const ok = parseSpecialist({ verdict: 'FAIL', defects: [{ claim: 'c', why: 'w', evidenceRef: 'cop_meal#price', opportunityId: 'cop_zzz', fact: 'nonsense' }] }, 'QUANT', ['cop_meal'], 'm');
    expect(ok!.defects[0]).toMatchObject({ opportunityId: null, fact: 'mechanism', critical: false, source: 'MODEL' });
    expect(parseSpecialist({ verdict: 'MAYBE' }, 'QUANT', [], 'm')).toBeNull();
    expect(parseSpecialist(null, 'QUANT', [], 'm')).toBeNull();
  });

  const models: OperatorModel[] = [
    { baseUrl: 'http://first.invalid/v1', model: 'm1', apiKey: null, label: 'free:m1' },
    { baseUrl: 'http://second.invalid/v1', model: 'm2', apiKey: null, label: 'free:m2' },
  ];
  const roleOf = (init?: RequestInit) => /You are the ([A-Z_]+) on/.exec(String(JSON.parse(String(init?.body)).messages[1].content))![1] as CommitteeRole;
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('asks every role independently, falls through to the next model, and a role no model answers is UNKNOWN', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const role = roleOf(init);
      calls.push(`${String(url).includes('first') ? 'm1' : 'm2'}:${role}`);
      if (role === 'OWNER_PROXY') throw new Error('connect ECONNREFUSED');
      if (role === 'INVESTOR' && String(url).includes('first')) return new Response('overloaded', { status: 503 });
      if (role === 'QUANT') return reply(JSON.stringify({ verdict: 'FAIL', defects: [{ claim: 'up to $1,000', evidenceRef: 'cop_meal#volume', why: 'the 40 buyers are listings, not purchases', opportunityId: 'cop_meal', fact: 'volume' }] }));
      return reply(`Here you go: {"verdict":"PASS","defects":[],"citations":["cop_meal#price"]}`);
    }) as typeof fetch;
    const review = await reviewWithSpecialists(input(), models, { fetchImpl });
    const by = new Map(review.findings.map((f) => [f.role, f]));
    expect(review.fingerprint).toBe(committeeFingerprint(input()));
    expect(by.get('SKEPTIC')).toMatchObject({ verdict: 'PASS', model: 'free:m1' });
    expect(by.get('INVESTOR')).toMatchObject({ verdict: 'PASS', model: 'free:m2' });
    expect(by.get('QUANT')!.defects[0]).toMatchObject({ fact: 'volume', critical: false, source: 'MODEL' });
    expect(by.get('OWNER_PROXY')).toMatchObject({ verdict: 'UNKNOWN', model: null });
    expect(by.get('OWNER_PROXY')!.reason).toMatch(/no specialist model answered/);
    expect(calls.filter((c) => c.endsWith(':OWNER_PROXY'))).toHaveLength(2);
    // Combined: QUANT's cited FAIL fails the plan; OWNER_PROXY's silence would hold it otherwise.
    const combined = reviewPlan(input(), { specialistsAvailable: true, specialistReviews: [review] });
    expect(combined.verdict).toBe('FAIL');
    expect(combined.roles.find((r) => r.role === 'OWNER_PROXY')!.verdict).toBe('UNKNOWN');
  });

  it('records each review structurally on the goal, reads it back, and records nothing when no model is configured', async () => {
    const recorded: { workstreamId: string; kind: string; detail?: Record<string, unknown> }[] = [];
    const record = (async (e: { workstreamId: string; kind: string; detail?: Record<string, unknown> }) => {
      recorded.push(e);
      return {} as never;
    }) as never;
    expect(await startSpecialistReview('wst_none', input(), { models: async () => [], record })).toBeNull();
    expect(recorded).toHaveLength(0);
    const fetchImpl = (async () => reply('{"verdict":"PASS","defects":[]}')) as unknown as typeof fetch;
    const review = await startSpecialistReview('wst_x', input(), { models: async () => models, record, bounds: { fetchImpl } });
    expect(review!.findings.every((f) => f.verdict === 'PASS')).toBe(true);
    expect(recorded[0]).toMatchObject({ workstreamId: 'wst_x', kind: SPECIALIST_EVENT });
    const back = reviewFromDetail(recorded[0]!.detail!);
    expect(back).toEqual(review);
    const context = await committeeContextOf('wst_x', 'prj_1', new Date(), {
      answers: async () => [],
      readEvents: async () => [{ id: 'wse_1', workstreamId: 'wst_x', kind: SPECIALIST_EVENT, summary: '', detail: recorded[0]!.detail!, actorRef: 'BRAIN', createdAt: '' }],
      models: async () => models,
    });
    expect(context.specialistsAvailable).toBe(true);
    expect(reviewPlan(input(), context).specialists.state).toBe('BOUND');
  });

  it('degrades: an unreadable record is said and read as nothing; the switch turns the pass off', async () => {
    const context = await committeeContextOf('wst_x', 'prj_1', new Date(), {
      answers: async () => {
        throw new Error('db down');
      },
      readEvents: async () => {
        throw new Error('db down');
      },
      models: async () => models,
      env: { BRAIN_COMMITTEE_SPECIALISTS: 'off' },
    });
    expect(context).toMatchObject({ answers: [], specialistReviews: [], specialistsAvailable: false });
    expect(context.degraded).toHaveLength(2);
    // No switchboard and no pod configured: no model, without loading the operator.
    expect(await specialistsConfigured({ env: {} })).toBe(false);
  });

  it('is due when pending, and again after the retry interval only when a role went unanswered', () => {
    const now = new Date('2026-11-24T12:00:00.000Z');
    const fp = 'fp1';
    const answered: SpecialistReview = { fingerprint: fp, reviewedAt: '2026-11-24T00:00:00.000Z', findings: COMMITTEE_ROLES.map((r) => finding(r, 'PASS')) };
    const silent: SpecialistReview = { ...answered, findings: [...answered.findings.slice(1), finding('SKEPTIC', 'UNKNOWN', { model: null })] };
    expect(specialistReviewDue({ fingerprint: fp, specialists: { state: 'NOT_RUN', reviewedAt: null, models: [] } }, [], now)).toBe(false);
    expect(specialistReviewDue({ fingerprint: fp, specialists: { state: 'PENDING', reviewedAt: null, models: [] } }, [], now)).toBe(true);
    const boundState = { fingerprint: fp, specialists: { state: 'BOUND' as const, reviewedAt: answered.reviewedAt, models: [] } };
    expect(specialistReviewDue(boundState, [answered], now)).toBe(false);
    expect(specialistReviewDue(boundState, [silent], now)).toBe(true);
    expect(specialistReviewDue(boundState, [{ ...silent, reviewedAt: new Date(now.getTime() - SPECIALIST_RETRY_MS / 2).toISOString() }], now)).toBe(false);
  });
});
