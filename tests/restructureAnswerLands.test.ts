/**
 * Owner, 2026-11-20: "If a verified restructuring reduces required exposure
 * to $1,000, Brain can reconsider the opportunity. … This is not permission
 * to invent favorable assumptions."
 *
 * Before this change an opening held out on a limit sent one research
 * question per restructuring mechanism (`sendRestructureNeeds`), and the
 * accepted, sourced answer had nowhere to land: only a share stated on the
 * opening's own terms was ever read (`statedPrepayment`). A sourced answer
 * that suppliers in this trade invoice net 30, or that buyers pay a 50%
 * deposit, never reached the plan, so the opening stayed held out forever.
 *
 * The answer is traced to the question Brain asked (claim → orchestration →
 * mission → idea, whose scope names the goal and the opening and whose
 * wording names the mechanism), filed against that opening and mechanism
 * (`restructureEvidenceOf`), and the next portfolio read re-reads the held-out
 * opening on it (`evidencedRestructuring`): readmitted only when the
 * evidenced structure brings its exposure inside the goal's limit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { sendNeeds } from '../server/services/quant/needs.ts';
import { evaluateGoalPortfolio, type PlannedOpening } from '../server/services/goals/portfolio.ts';
import { goalGraphScope, restructureAnswerOf, restructureEvidenceOf, restructureNeedsOf, restructureQuestionOf } from '../server/services/goals/portfolioNeeds.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { Layer } from '../server/domain/types.ts';

const fixed = (v: number): ModelInput => ({ value: v, low: v, high: v, provenance: 'EVIDENCE', source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const estimatedCapital: ModelInput = {
  value: null,
  low: 4_000,
  high: 4_200,
  provenance: 'UNKNOWN',
  source: null,
  note: 'inferred from comparable openings',
  inferred: { tier: 'COMPARABLE', justified: false, p10: 4_000, p50: 4_100, p90: 4_200, observations: 3 },
};

const ID = 'cop_install';
const TITLE = 'Commercial kitchen equipment install';
const GOAL = 'wst_restructure';
function opening(over: Partial<PlannedOpening> = {}): PlannedOpening {
  return {
    opportunity: { id: ID, title: TITLE, paymentTerms: null } as unknown as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(4_000),
    capital: estimatedCapital,
    hours: fixed(4),
    daysToCash: fixed(7),
    close: swept(0.3, 0.6),
    respond: swept(0.05, 0.15),
    directCost: fixed(2_500),
    volume: fixed(1),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  } as PlannedOpening;
}

const LIMITS = { remaining: 10_000, daysLeft: 30, capitalCeiling: 3_000, beforeProof: null, perWeek: null, resources: '40 emails a day', worlds: 400, seed: 7 };
const read = (one: PlannedOpening) => {
  const p = evaluateGoalPortfolio({ ...LIMITS, openings: [one] });
  return { p, d: p.demand.find((x) => x.opportunityId === ID)! };
};
const members = (p: ReturnType<typeof read>['p']): string[] => [...(p.best?.members ?? []), ...p.alternatives.flatMap((a) => a.members)].map((m) => m.opportunityId);

let projectId = '';
let layer: Layer;
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `restructure-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  ownerId = owner.id;
});

/** Send the held-out opening's restructuring questions exactly as `sendRestructureNeeds` does; the idea opened for each mechanism. */
async function askRestructuring(): Promise<Map<string, string>> {
  const { d } = read(opening());
  expect(d.heldOut).toMatch(/^held out of every combination/);
  const ideas = new Map<string, string>();
  for (const need of restructureNeedsOf(d)) {
    const [delivered] = await sendNeeds({ projectId, actorRef: ownerId, graphScope: goalGraphScope(GOAL, ID), needs: [need] });
    if (!delivered?.sent || delivered.to !== 'RESEARCH_CANDIDATE') throw new Error('restructuring question not sent');
    ideas.set(need.subject.replace(/^.*: /, ''), delivered.ref);
  }
  return ideas;
}

/** Research run on one idea, and one claim it produced. */
async function answer(candidateId: string, text: string, gate: { sourceUrl?: string | null; accepted?: boolean } = {}): Promise<string> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'restructure' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Restructure', assignment: 'restructure', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'restructure',
      question: 'How can it be restructured?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['published terms'], excludedSourceTypes: [], completionCriteria: ['Terms.'],
      dependsOn: [], minIndependentSources: 1, status: 'ACCEPTED',
    },
  ]);
  const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'restructure', whyNow: 'test', idempotencyKey: `restructure:${candidateId}:${Math.random()}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  const [row] = await insertClaims([
    {
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: gate.sourceUrl === undefined ? 'https://example.org/terms' : gate.sourceUrl, sourceTitle: 'Terms',
      sourcePublisher: 'A distributor', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'terms', evidenceLane: 'economics',
      retrievedAt: '2026-11-20T10:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: gate.accepted ?? true, rejectionReason: null, contentHash: `restructure:${Math.random()}:${text}`,
      structuralFinding: null, structuralSubject: null, structuralQualifier: null, structuralAmountCents: null,
    },
  ]);
  return row!.id;
}

/** The next portfolio read, with this goal's answers attached as `composeGoalModel` attaches them. */
async function nextRead() {
  const answers = await restructureEvidenceOf(projectId, GOAL);
  const evidence = answers.get(ID);
  return read(evidence?.length ? opening({ restructureEvidence: evidence }) : opening());
}

describe('an accepted, sourced answer to a restructuring question lands on the opening and mechanism it asked about', () => {
  it('supplier terms: "net 30" defers the supplier bill past the buyer\'s money, and the opening is readmitted at 1500–1700', async () => {
    const ideas = await askRestructuring();
    expect([...ideas.keys()]).toEqual(['prepayment', 'supplier terms', 'staged delivery', 'broker role', 'cheaper fulfilment']);
    expect(members((await nextRead()).p)).not.toContain(ID);

    const claimId = await answer(ideas.get('supplier terms')!, 'Restaurant equipment distributors invoice new commercial accounts on net 30 terms.');
    const answers = await restructureEvidenceOf(projectId, GOAL);
    expect(answers.get(ID)).toEqual([expect.objectContaining({ mechanism: 'SUPPLIER_TERMS', termDays: 30, claimId, sourceUrl: 'https://example.org/terms' })]);

    const { p, d } = await nextRead();
    expect(d.heldOut).toBeNull();
    expect(d.refused).toBeNull();
    expect(d.restructure).toBeNull();
    // 4000–4200 less the lowest held supplier cost (2500), paid 30 days after its bill, after the buyer's money (7 days).
    expect(d.capitalAtStart).toBe(1_700);
    expect(d.cashStructure).toMatch(/^EVIDENCE: the accepted answer "Restaurant equipment distributors invoice new commercial accounts on net 30 terms\." \(https:\/\/example\.org\/terms\): the supplier is paid 30 days after its bill.*so it ties up 1500–1700 at its start$/);
    expect(d.unestablished).toContain('money tied up');
    expect(members(p)).toContain(ID);
  });

  it('prepayment: "buyers pay a 50% deposit" brings 4000–4200 down to 2000–2200 inside the 3000 limit', async () => {
    const ideas = await askRestructuring();
    await answer(ideas.get('prepayment')!, 'Buyers of commercial kitchen installs pay a 50% deposit at order, the balance on completion.');
    const { p, d } = await nextRead();
    expect(d.heldOut).toBeNull();
    expect(d.capitalAtStart).toBe(2_200);
    expect(d.cashStructure).toMatch(/50% of the price \(at least 2000\) arrives before delivery.*so it ties up 2000–2200 at its start$/);
    expect(members(p)).toContain(ID);
  });

  it('an unsourced, unaccepted or off-question answer changes nothing', async () => {
    const ideas = await askRestructuring();
    await answer(ideas.get('supplier terms')!, 'Distributors invoice on net 30 terms.', { sourceUrl: null });
    await answer(ideas.get('prepayment')!, 'Buyers pay a 50% deposit at order.', { accepted: false });
    // Answers the mechanism establishes nothing from: a deposit with no share, terms only for established accounts, and terms shorter than the buyer takes to pay.
    await answer(ideas.get('prepayment')!, 'A deposit is taken at order.');
    await answer(ideas.get('supplier terms')!, 'Net 30 terms are offered only to established accounts.');
    // A broker answer is not yet read as a figure: it stays a question.
    await answer(ideas.get('broker role')!, 'Installers pay a 10% referral commission.');
    expect((await restructureEvidenceOf(projectId, GOAL)).get(ID)).toBeUndefined();
    const { p, d } = await nextRead();
    expect(d.heldOut).toMatch(/^held out of every combination/);
    expect(d.cashStructure ?? null).toBeNull();
    expect(members(p)).not.toContain(ID);
  });

  it('an answer whose structure still leaves exposure over the limit, or whose terms fall due before the buyer pays, does not readmit it', async () => {
    const ideas = await askRestructuring();
    await answer(ideas.get('supplier terms')!, 'Distributors invoice on net 5 terms.');
    await answer(ideas.get('prepayment')!, 'Buyers pay a 10% deposit at order.');
    expect((await restructureEvidenceOf(projectId, GOAL)).get(ID)?.map((e) => e.mechanism).sort()).toEqual(['PREPAYMENT', 'SUPPLIER_TERMS']);
    const { p, d } = await nextRead();
    // 10% of 4000 = 400 off 4000–4200 is 3600–3800, still over 3000; net 5 falls due before the buyer's 7 days.
    expect(d.heldOut).toMatch(/^held out of every combination/);
    expect(members(p)).not.toContain(ID);
    // Both mechanisms are answered, so neither is asked again; the rest still are.
    expect(d.restructure!.mechanisms.map((m) => m.mechanism)).toEqual(['STAGED_DELIVERY', 'BROKER_ROLE', 'CHEAPER_FULFILMENT']);
  });
});

describe('the question and the answer are read from Brain\'s own wording', () => {
  it('reads the opening and mechanism from the idea, even where a long title cut the mechanism off', () => {
    const scope = goalGraphScope(GOAL, ID);
    const statement = `For causal graph ${scope}, establish from sourced evidence: Do suppliers of what "${TITLE}" delivers extend payment terms to a new account …`;
    expect(restructureQuestionOf(GOAL, { title: `Causal unknown: whether "${TITLE}" can be restructured within the goal's limit: supplier terms`, statement })).toEqual({ opportunityId: ID, mechanism: 'SUPPLIER_TERMS' });
    expect(restructureQuestionOf(GOAL, { title: `Causal unknown: whether "${'x'.repeat(120)}" can be restructured within the goal's li`, statement })).toEqual({ opportunityId: ID, mechanism: 'SUPPLIER_TERMS' });
    // Another goal's question, or a question that is not a restructuring one, is not this goal's answer.
    expect(restructureQuestionOf('wst_other', { title: 'Causal unknown: whether "x" can be restructured within the goal\'s limit: prepayment', statement })).toBeNull();
    expect(restructureQuestionOf(GOAL, { title: 'Causal unknown: the price', statement: `For causal graph ${scope}, establish from sourced evidence: What is the price?` })).toBeNull();
  });

  it('keeps every gate on the claim', () => {
    const claim = { id: 'c1', claim: 'Suppliers invoice net 60.', accepted: true, sourceUrl: 'https://example.org' };
    expect(restructureAnswerOf(claim, 'SUPPLIER_TERMS')).toMatchObject({ termDays: 60 });
    expect(restructureAnswerOf({ ...claim, accepted: false }, 'SUPPLIER_TERMS')).toEqual({ refused: 'claim is not gated (accepted)' });
    expect(restructureAnswerOf({ ...claim, sourceUrl: null }, 'SUPPLIER_TERMS')).toEqual({ refused: 'claim has no source URL' });
    expect(restructureAnswerOf({ ...claim, claim: 'Buyers are invoiced net 30 after delivery.' }, 'PREPAYMENT')).toMatchObject({ refused: expect.stringMatching(/ARREARS/) });
    expect(restructureAnswerOf({ ...claim, claim: 'Suppliers do not extend terms to new accounts.' }, 'SUPPLIER_TERMS')).toMatchObject({ refused: expect.any(String) });
  });
});
