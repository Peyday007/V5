/**
 * Production, 2026-11-18 (revision 32dcf58): two cash goals created in fresh
 * projects — "Turn 10,000 dollars of starting capital into 100,000 dollars
 * within 90 days" and "Earn 5,000 dollars a month in recurring revenue within
 * 60 days, …" — read identical plans: 0 of 208 constructed arrangements
 * estimated ("the project holds no published price"), and the steps led with
 * "Reach viktorrria … about "germany"".
 *
 *   D1  "viktorrria" is a Hacker News handle (the freelance thread's
 *       `organization` is the comment's author) and "germany" the thread
 *       heading's place segment, read as the work. A handle names no buyer, a
 *       place alone is no population and no offer, and a lead nothing
 *       estimated says so (tests/arrangementSteps.test.ts).
 *   D2  A project with no published price of its own sweeps an unpriced
 *       arrangement across the Brain's validated findings (§31), labelled so.
 *   D3  A monthly recurring target's label says it is a monthly run-rate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createProject } from '../server/repos/projects.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { promoteEligibleClaims } from '../server/repos/sharedFindings.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { createUser } from '../server/repos/identity.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { namesOnlyAPlace } from '../server/domain/jurisdiction.ts';
import { parseHnFreelance } from '../server/services/feeds/sources.ts';
import { factsFromItem } from '../server/services/industry/eventGraph.ts';
import { addGraphParts, brainComparablePrices, type Primitive } from '../server/services/cash/construct.ts';
import { comparablePricesFor, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { readTarget } from '../server/services/goals/target.ts';

const WORDS_100K = 'Turn 10,000 dollars of starting capital into 100,000 dollars within 90 days';
const WORDS_MRR =
  'Earn 5,000 dollars a month in recurring revenue within 60 days, with no more than 10 hours a week of owner time and at most 1,500 dollars of starting capital';

describe('D1: a handle and a place are not an arrangement', () => {
  it('a place alone is only where; a place beside work is not', () => {
    for (const where of ['Germany', 'germany', 'EU only', 'Remote / USA', 'Location: Germany', 'United Kingdom', 'Texas', 'Bosnia & Herzegovina']) expect(namesOnlyAPlace(where), where).toBe(true);
    for (const what of ['German manufacturers', 'Texas dental practices', 'React developer', 'spreadsheet, business document', 'viktorrria', '']) expect(namesOnlyAPlace(what), what).toBe(false);
  });

  it('the freelance thread: a place heading is not the work, and the author handle names no actor', () => {
    const body = {
      hits: [
        { objectID: '1', author: 'viktorrria', comment_text: 'SEEKING FREELANCER | Germany | Remote<p>Need help with a project.', created_at: '2026-11-10T00:00:00Z' },
        { objectID: '2', author: 'viktorrria', comment_text: 'SEEKING FREELANCER | Germany | React developer<p>Budget $3,000.', created_at: '2026-11-10T00:00:00Z' },
      ],
    };
    const items = parseHnFreelance('SEEKING FREELANCER')(body);
    expect(items.map((one) => one.title)).toEqual(['React developer']);
    // Stored rows from before the parser knew are read the same way by the graph: no actor name, whatever the title.
    const stored = { id: 'feed_1', source: 'hn-seeking-freelancer', url: 'https://news.ycombinator.com/item?id=1', title: 'Germany', body: 'SEEKING FREELANCER | Germany', organization: 'viktorrria', publishedAt: '2026-11-10T00:00:00.000Z', fetchedAt: '2026-11-10T00:00:00.000Z' };
    const facts = factsFromItem(stored);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.actor.name === null)).toBe(true);
    // Another source's organization is still its actor's name.
    const named = factsFromItem({ ...stored, source: 'some-request-board', title: 'Request for quotes: bookkeeping', organization: 'Acme Dental' });
    expect(named.some((f) => f.actor.name === 'Acme Dental')).toBe(true);
  });

  it('construction takes no part from a place-only neighborhood, and no actor without a name', () => {
    const sectors = new Map<string, { demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }>();
    const sector = (name: string | null) => {
      const key = name ?? '-';
      if (!sectors.has(key)) sectors.set(key, { demand: [], needs: [], supply: [] });
      return sectors.get(key)!;
    };
    addGraphParts(
      [
        { neighborhood: 'germany', hypothesisKey: 'h1', actors: [{ key: 'viktorrria', name: 'viktorrria', role: 'BUYER' }] },
        { neighborhood: 'react developer', hypothesisKey: 'h2', actors: [{ key: 'viktorrria', name: null, role: 'BUYER' }] },
      ],
      () => true,
      sector,
    );
    const all = [...sectors.values()];
    expect(all.flatMap((s) => [...s.demand, ...s.needs, ...s.supply]).map((p) => p.name)).toEqual(['react developer']);
  });
});

describe('D2: a fresh project reads the Brain’s validated prices, labelled so', () => {
  it('only when the project holds none of its own', () => {
    const brain: ComparablePrice[] = [180, 220, 260].map((value) => ({ value, industry: 'Dentistry', payer: 'Dental practices', brain: true }));
    const fresh = comparablePricesFor({ sector: null, demand: { name: 'Property managers', claimId: null, from: 'INDUSTRY_MAP', ref: 'n' } }, brain);
    expect(fresh).toEqual({ prices: [180, 220, 260], scope: "in the Brain's validated findings (other projects' sourced claims)" });
    const sameSector = comparablePricesFor({ sector: 'Dentistry' }, brain);
    expect(sameSector).toEqual({ prices: [180, 220, 260], scope: "in the same sector (Dentistry) among the Brain's validated findings" });
    // The project's own prices win: the Brain's are not mixed in.
    const own = comparablePricesFor({ sector: null }, [...brain, { value: 900, industry: null }, { value: 1_100, industry: null }]);
    expect(own).toEqual({ prices: [900, 1_100], scope: 'in this project' });
    expect(comparablePricesFor({ sector: null }, [])).toEqual({ prices: [], scope: 'in this project' });
  });

  describe('from rows', () => {
    let projectId = '';
    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
    });

    async function validatedClaim(originProjectId: string, suffix: string, promote: boolean): Promise<string> {
      const layerId = (await listLayers(originProjectId))[0]!.id;
      const run = await createRun({ projectId: originProjectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'price' });
      const orchestration = await createOrchestration({ projectId: originProjectId, layerId, runId: run.id, title: 'price', assignment: 'price', provider: 'WORKER', autoApprove: false });
      await createFragments([
        {
          orchestrationId: orchestration.id, projectId: originProjectId, layerId, fragmentIndex: 0, fragmentKey: `price-${suffix}`, question: 'What dental practices pay',
          requiredEvidence: [{ id: 'figure', description: 'a published price', necessity: 'REQUIRED' }], acceptableSourceTypes: ['price list'], excludedSourceTypes: [],
          completionCriteria: ['a price'], dependsOn: [], minIndependentSources: 1,
        },
      ] as unknown as Parameters<typeof createFragments>[0]);
      const [fragment] = await currentFragments(orchestration.id);
      const [claim] = await insertClaims([
        {
          orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
          claim: `A dental practice pays $200 per compliance report ${suffix}`, sourceUrl: `https://example.org/price/${suffix}`, sourceTitle: 'Price list', sourcePublisher: 'example.org',
          sourceDate: '2026-10-01', evidenceExcerpt: '$200 per report', evidenceLocator: 'table 1', evidenceLane: 'figure', retrievedAt: '2026-11-01', confidence: 0.9,
          validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const, contentHash: `h-${suffix}`,
        },
      ]);
      await decideClaim(claim!.id, { accepted: true });
      if (promote) {
        await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
        await promoteEligibleClaims();
      }
      return claim!.id;
    }

    it("another project's price fact is read only when its claim is a validated finding", async () => {
      // The origin is the seeded project (it has layers to file research under); the asking project is new and empty.
      const origin = projectId;
      const fresh = (await createProject({ name: 'Cash Mode 3', slug: `cash-mode-3-${Math.random().toString(36).slice(2, 8)}` })).id;
      const owner = (await createUser({ email: `fg-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password' })).id;
      const root = await seedSubject({ projectId: origin, name: 'Dentistry', actorRef: owner });
      const practices = await seedSubject({ projectId: origin, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: owner });
      const fact = async (claimId: string, low: number, high: number) =>
        recordClaimFact({
          projectId: origin, nodeId: practices.node.id, claimId, key: 'price_per_unit', segment: `map_${practices.node.id}`, low, high, status: 'OBSERVED',
          measures: 'a dental practice pays per compliance report', sourceTitle: 'Price list', sourceUrl: `https://example.org/${claimId}`, sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
        });
      const validated = await validatedClaim(origin, 'a', true);
      const unvalidated = await validatedClaim(origin, 'b', false);
      await fact(validated, 100, 400);
      await fact(unvalidated, 5_000, 5_000);
      const got = await brainComparablePrices({ projectId: fresh, currency: 'USD' });
      expect(got).toEqual([{ value: 200, industry: 'Dentistry', payer: 'Dental practices', brain: true }]);
      // Never for the project that filed it (its own facts reach it as its own), and never in another currency.
      expect(await brainComparablePrices({ projectId: origin, currency: 'USD' })).toEqual([]);
      expect(await brainComparablePrices({ projectId: fresh, currency: 'EUR' })).toEqual([]);
    });
  });
});

describe('D3: a monthly recurring target is read and labelled as a run-rate', () => {
  it('the production words: the rate is the amount, the hours a weekly limit, the capital the stake', async () => {
    const projectId = (await freshProject()).project.id;
    const now = new Date('2026-11-18T23:40:00.000Z');
    const mrr = await createGoal({ projectId, objective: WORDS_MRR, actorRef: 'person:test', userId: null, now });
    expect(mrr.ok).toBe(true);
    expect(mrr.reading.recurring).toBe('MONTHLY');
    expect(mrr.reading.unread.join(' ')).not.toMatch(/a rate, not a total|an hours rate/);
    expect(mrr.reading).toMatchObject({ amount: 5_000, capitalCeiling: 1_500, hoursPerWeek: 10 });
    const target = await readTarget(mrr.ok ? mrr.goal : (null as never), now);
    expect(target!.scope?.recurring).toBe('MONTHLY');
    expect(target!.metricLabel).toMatch(/^settled cash a month \(a recurring run-rate, counted over the trailing 30 days, to be reached by the deadline\)$/);

    const other = (await createProject({ name: 'Cash Mode 3', slug: `cash-mode-3-${Math.random().toString(36).slice(2, 8)}` })).id;
    const grow = await createGoal({ projectId: other, objective: WORDS_100K, actorRef: 'person:test', userId: null, now });
    expect(grow.ok).toBe(true);
    expect(grow.reading).toMatchObject({ amount: 100_000, capitalCeiling: 10_000, recurring: null });
    expect((await readTarget(grow.ok ? grow.goal : (null as never), now))!.metricLabel).toBe('settled cash');
  });
});
