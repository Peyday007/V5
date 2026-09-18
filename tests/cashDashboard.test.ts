/**
 * The Cash dashboard reads. It does not touch the work it describes.
 *
 * Two projections were added to the Cash view — the research roadmap and the
 * money forecast — and both exist because the screen was showing internal event
 * codes where a person needed progress, and a spending form where they needed a
 * financial picture. Neither is allowed to change anything to make itself look
 * populated, and that is the property this file pins rather than asserts in a
 * comment: every row in every table the sprint's work lives in is hashed before
 * the dashboard is read and again afterwards, and the two must be byte-equal.
 *
 * The second property is the denominator. A round's planned count is however
 * many fragments its mission's orchestration actually holds. There is no
 * constant anywhere in the projection, so a plan of five reports five — and a
 * plan of one reports one, which is the case a hard-coded target would hide.
 *
 * The third is the forecast's discipline. An estimate is shown only where the
 * evidence carries it; everything else is withheld **naming what is blank**,
 * because a blank read as zero is the error that makes an uncosted piece look
 * like the cheap one (§30).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { closeRound, listRounds } from '../server/repos/cashDiscovery.ts';
import { createOpportunity, updateOpportunity, transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { openDiscovery } from '../server/services/cash/discovery.ts';
import { cashRoadmap } from '../server/services/cash/roadmap.ts';
import { cashForecast } from '../server/services/cash/forecast.ts';
import { cashView } from '../server/services/cash/view.ts';
import type { FragmentStatus, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `dashboard-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/**
 * Every table the sprint's work lives in.
 *
 * Deliberately wider than what the projections read. A dashboard that nudged
 * the *queue* while reading the *portfolio* would still be the defect, so the
 * queue, the bins, the missions and the claims are all in the snapshot.
 */
const WATCHED = [
  'cash_modes',
  'cash_events',
  'cash_opportunities',
  'cash_needs',
  'cash_discovery_rounds',
  'cash_authorities',
  'cash_commitments',
  'cash_money_entries',
  'cash_actions',
  'cash_card_facts',
  'research_orchestrations',
  'research_fragments',
  'research_claims',
  'research_passes',
  'russell_missions',
  'russell_candidates',
  'work_items',
  'work_leases',
  'bins',
  'bin_events',
];

/**
 * A content hash of every watched table, order-independent.
 *
 * Each row is serialized with its keys sorted and the row strings are sorted,
 * so a difference in the order two backends return rows in is not a difference
 * in the rows. Any changed column anywhere shows up as an inequality naming its
 * table.
 */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of WATCHED) {
    const rows = await getDb().all(`SELECT * FROM ${table}`, []);
    out[table] = rows
      .map((row) =>
        JSON.stringify(
          Object.keys(row)
            .sort()
            .map((key) => [key, (row as Record<string, unknown>)[key]]),
        ),
      )
      .sort()
      .join('\n');
  }
  return out;
}

async function activated(): Promise<string> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
  const mode = await getCashMode(projectId);
  expect(mode).not.toBeNull();
  return mode!.id;
}

/**
 * A real plan behind one round: an orchestration whose fragments carry the
 * statuses given, and a mission linking the round's candidate to it.
 *
 * Built from the repositories the roadmap actually walks, because a fixture
 * that handed it counts directly would pass against a projection that read a
 * constant.
 */
async function planFor(candidateId: string, statuses: FragmentStatus[]): Promise<void> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a discovery bucket',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a discovery bucket',
    assignment: 'where to look',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments(
    statuses.map((_status, index) => ({
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [
        { id: 'demand_signal', description: 'a published request', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a marketplace or job board listing'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published request'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: index,
      fragmentKey: `cash-dashboard-${index}`,
      question: `Question number ${index}?`,
      dependsOn: [],
      attempt: 1,
    })) as unknown as Parameters<typeof createFragments>[0],
  );

  const fragments = await currentFragments(orchestration.id);
  for (const [index, fragment] of fragments.entries()) {
    const status = statuses[index]!;
    if (status === 'PLANNED') continue;
    await updateFragment(fragment.id, { status });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a discovery bucket',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
}

describe('the Cash dashboard', () => {
  it('reads the roadmap and the forecast without changing a single row', async () => {
    const modeId = await activated();
    const opened = await openDiscovery({ projectId, limit: 2 });
    expect(opened.length).toBeGreaterThan(0);

    const rounds = await listRounds(projectId);
    await planFor(rounds[0]!.candidateId, ['RUNNING', 'QUEUED', 'ACCEPTED', 'REJECTED', 'BLOCKED']);

    const opportunity = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: userId,
      title: 'Somebody publicly asking to pay for work',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    await transitionOpportunity({
      id: opportunity.id,
      from: ['DISCOVERED'],
      to: 'EVIDENCE_CARD',
    });

    const before = await snapshot();

    // Read everything, twice: a projection that wrote on first read would show
    // up here, and one that wrote on *every* read would show up twice.
    await cashRoadmap(projectId);
    await cashForecast({ projectId, currency: 'USD' });
    await cashView({ projectId });
    await cashRoadmap(projectId);
    await cashForecast({ projectId, currency: 'USD' });
    await cashView({ projectId });

    const after = await snapshot();
    for (const table of WATCHED) {
      expect(`${table}: ${after[table]}`).toEqual(`${table}: ${before[table]}`);
    }
  });

  it('takes the denominator from the plan, never from a constant', async () => {
    await activated();
    await openDiscovery({ projectId, limit: 2 });
    const rounds = await listRounds(projectId);

    // Five on one round and one on another: a hard-coded target could match
    // neither, and a projection that summed a constant per round would report
    // the same number for both.
    await planFor(rounds[0]!.candidateId, ['RUNNING', 'QUEUED', 'QUEUED', 'ACCEPTED', 'BLOCKED']);
    await planFor(rounds[1]!.candidateId, ['PLANNED']);

    const map = await cashRoadmap(projectId);
    expect(map.research.planned).toBe(6);
    expect(map.research.byStatus.RUNNING).toBe(1);
    expect(map.research.byStatus.QUEUED).toBe(2);
    expect(map.research.byStatus.ACCEPTED).toBe(1);
    expect(map.research.byStatus.BLOCKED).toBe(1);
    expect(map.research.byStatus.PLANNED).toBe(1);

    const withFive = map.active.find((one) => one.roundId === rounds[0]!.id);
    const withOne = map.active.find((one) => one.roundId === rounds[1]!.id);
    expect(withFive?.plan?.planned).toBe(5);
    expect(withOne?.plan?.planned).toBe(1);

    // The question is the fragment's own words, so a reader can see what is
    // being researched rather than a paraphrase of it.
    expect(withFive?.plan?.inFlight).toEqual(['Question number 0?']);
  });

  it('says a live round has not been counted rather than that it found nothing', async () => {
    /*
     * `cash_discovery_rounds.found` is NOT NULL DEFAULT 0 and is written by one
     * statement — `closeRound`, guarded on OPEN. So on a live round the column
     * is the default, meaning *not counted yet*, and this projection returns
     * only live rounds. It used to publish that default as a count, and the
     * Cash page rendered "0 openings found" against rounds that had between
     * them produced every signal in the portfolio.
     */
    await activated();
    await openDiscovery({ projectId, limit: 1 });

    const map = await cashRoadmap(projectId);
    expect(map.active).toHaveLength(1);
    expect(map.active[0]!.state).toBe('OPEN');
    // Null, not zero: a blank must not read as a measurement.
    expect(map.active[0]!.found).toBeNull();

    // And once it is settled, the count is a count again — the correction may
    // not cost the reading it exists to protect.
    const rounds = await listRounds(projectId);
    await closeRound({ id: rounds[0]!.id, to: 'HARVESTED', found: 0 });
    const settled = await listRounds(projectId);
    expect(settled[0]!.state).toBe('HARVESTED');
    expect(settled[0]!.found).toBe(0);
  });

  it('reports a round with no mission as having no plan, rather than as no work', async () => {
    await activated();
    await openDiscovery({ projectId, limit: 1 });

    const map = await cashRoadmap(projectId);
    expect(map.active).toHaveLength(1);
    expect(map.active[0]!.plan).toBeNull();
    expect(map.research.planned).toBe(0);
    expect(map.whatHappensNext).toContain('has not been planned');
  });

  it('is honest about an empty sprint instead of encouraging', async () => {
    await activated();
    const map = await cashRoadmap(projectId);
    expect(map.active).toEqual([]);
    expect(map.whatHappensNext).toBe(
      'Nothing is running. No discovery round is open and no research is queued.',
    );
    for (const stage of map.pipeline) expect(stage.count).toBe(0);
    // Zero is a fact about today. A stage that vanished when nothing had
    // reached it would read as a pipeline that does not exist.
    expect(map.pipeline.length).toBeGreaterThan(0);
  });

  it('withholds every estimate the evidence does not carry, and names the blanks', async () => {
    const modeId = await activated();
    const opportunity = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: userId,
      title: 'Somebody publicly asking to pay for work',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    await transitionOpportunity({ id: opportunity.id, from: ['DISCOVERED'], to: 'EVIDENCE_CARD' });

    const forecast = await cashForecast({ projectId, currency: 'USD' });
    expect(forecast.qualified).toBe(1);

    for (const estimate of [forecast.revenue, forecast.upfrontCash, forecast.contribution]) {
      expect(estimate.valueCents).toBeNull();
      expect(estimate.blocking.length).toBeGreaterThan(0);
      expect(estimate.unknown.length).toBeGreaterThan(0);
    }
    expect(forecast.revenue.unknown).toContain('Price');
    expect(forecast.upfrontCash.unknown).toContain('Exposure');
    expect(forecast.timeToFirstDollar.days).toBeNull();
    expect(forecast.breakEven.days).toBeNull();
    expect(forecast.humanHours.total).toBeNull();
  });

  it('never counts a blank as zero, and needs both halves before it names a margin', async () => {
    const modeId = await activated();
    const priced = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: userId,
      title: 'A priced opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    const blank = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: userId,
      title: 'An opening nobody has costed',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    for (const one of [priced, blank]) {
      await transitionOpportunity({ id: one.id, from: ['DISCOVERED'], to: 'EVIDENCE_CARD' });
    }
    await updateOpportunity(priced.id, { price_cents: 90_000 });

    // A price and no exposure is not a margin. The blank row must not be read
    // as costing nothing, which would make it the attractive one.
    const half = await cashForecast({ projectId, currency: 'USD' });
    expect(half.revenue.valueCents).toBe(90_000);
    expect(half.revenue.fromRows).toBe(1);
    expect(half.revenue.unknown).toContain('Price');
    expect(half.upfrontCash.valueCents).toBeNull();
    expect(half.contribution.valueCents).toBeNull();

    await updateOpportunity(priced.id, { peak_funding_cents: 20_000 });
    const whole = await cashForecast({ projectId, currency: 'USD' });
    expect(whole.contribution.valueCents).toBe(70_000);
    expect(whole.contribution.fromRows).toBe(1);
    expect(whole.contribution.confidence).toBe('SINGLE_ROW');
    // One of two rows answered both, and saying so is the other half of the
    // total: an incomplete total is still incomplete.
    expect(whole.contribution.unknown.length).toBeGreaterThan(0);
    expect(whole.upfrontCash.valueCents).toBe(20_000);
  });

  it('sends the authorization figures as figures, separate from any forecast', async () => {
    await activated();
    const view = await cashView({ projectId });

    // No grant: every authorization figure is a known zero rather than a blank,
    // and the forecast beside it is withheld. The screen has to be able to tell
    // "nothing authorized" from "not worked out yet", and that is the payload
    // difference it reads to do it.
    expect(view.authority.exists).toBe(false);
    expect(view.authority.maxCommittedCents).toBe(0);
    expect(view.authority.maxPerActionCents).toBe(0);
    expect(view.authority.committedCents).toBe(0);
    expect(view.authority.spentCents).toBe(0);
    expect(view.forecast.revenue.valueCents).toBeNull();
    expect(view.roadmap.whatHappensNext.length).toBeGreaterThan(0);
  });
});
