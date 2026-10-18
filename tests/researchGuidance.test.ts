/**
 * What a research worker is told beside its fragment: how to search, which
 * questions are its siblings' and not its own, that a documented absence is an
 * answer, which hosts its surface recently could not read, and what earlier
 * campaigns taught. All of it is prompt text. None of it is read by anything
 * that judges evidence, sets depth, plans a repair or allocates work — which
 * the last block of this file holds, by behaviour and by import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  hostReachability,
  insertClaims,
  resetHostReachabilityCache,
} from '../server/repos/research.ts';
import { recordLesson } from '../server/repos/researchIntelligence.ts';
import {
  MAX_GUIDANCE_LESSONS,
  NEGATIVE_EXISTENCE_NOTE,
  SEARCH_STRATEGY_NOTE,
  buildFragmentResearchPrompt,
  buildGoalPlanPrompt,
  composeGuidance,
} from '../server/services/research/prompts.ts';
import { guidanceFor } from '../server/services/research/guidance.ts';
import { READABLE_ROUTES, routesFor } from '../server/services/research/readableRoutes.ts';
import { applyGate, fragmentPasses } from '../server/services/research/gate.ts';
import { buildRepairPlan } from '../server/services/research/repair.ts';
import { allocateDepth } from '../server/services/research/intelligence/depth.ts';
import { coverBeforeWork } from '../server/services/russell/coverage.ts';
import type { Layer, Project, ResearchClaim } from '../server/domain/types.ts';

let project: Project;
let layer: Layer;

async function packet(): Promise<{ orchestrationId: string }> {
  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title: 't',
    assignment: 'a',
    provider: 'WORKER',
    autoApprove: false,
  });
  const base = {
    orchestrationId: orchestration.id,
    projectId: project.id,
    layerId: layer.id,
    requiredEvidence: [{ id: 'registry', description: 'a published registry entry', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['official registry'],
    excludedSourceTypes: [],
    completionCriteria: ['an entry, or a documented absence'],
    dependsOn: [],
    minIndependentSources: 1,
  };
  await createFragments([
    { ...base, fragmentIndex: 0, fragmentKey: 'licence', question: 'Is a licence required to operate?' },
    { ...base, fragmentIndex: 1, fragmentKey: 'fees', question: 'What does the licence cost?' },
    { ...base, fragmentIndex: 2, fragmentKey: 'term', question: 'How long does a licence last?' },
  ] as unknown as Parameters<typeof createFragments>[0]);
  return { orchestrationId: orchestration.id };
}

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = (await listLayers(project.id))[0]!;
  resetHostReachabilityCache();
});

describe('the guidance block', () => {
  it('states the search strategy, the siblings that are not this fragment, and the absence rule', async () => {
    const { orchestrationId } = await packet();
    const fragments = await currentFragments(orchestrationId);
    const mine = fragments[0]!;
    const guidance = composeGuidance({
      fragment: mine,
      siblings: fragments,
      reachability: [],
      lessons: [],
    });
    expect(guidance.text).toContain(SEARCH_STRATEGY_NOTE);
    expect(SEARCH_STRATEGY_NOTE).toMatch(/short, broad queries/);
    expect(SEARCH_STRATEGY_NOTE).toMatch(/full primary sources/);
    expect(guidance.notYours.map((entry) => entry.key)).toEqual(['fees', 'term']);
    expect(guidance.text).toContain('NOT YOURS');
    expect(guidance.text).toContain('[fees] What does the licence cost?');
    expect(guidance.text).not.toContain('[licence]');
    expect(guidance.text).toContain(NEGATIVE_EXISTENCE_NOTE);
    expect(NEGATIVE_EXISTENCE_NOTE).toMatch(/complete\s+answer for that lane/);

    const prompt = buildFragmentResearchPrompt({
      project,
      layer,
      fragment: mine,
      dependencyClaims: [],
      guidance,
    });
    expect(prompt).toContain(guidance.text);
  });

  it('names hosts this surface could not read and the lessons, GENERAL first, bounded', () => {
    const lessons = Array.from({ length: 8 }, (_, index) => ({
      abstraction: index % 2 === 0 ? 'DOMAIN' : 'GENERAL',
      lesson: `lesson ${index}`,
    }));
    const guidance = composeGuidance({
      fragment: null,
      siblings: [],
      reachability: [
        { host: 'a.gov', outcome: 'UNREACHABLE', at: '2026-10-10T00:00:00Z' },
        { host: 'b.gov', outcome: 'RETRIEVED', at: '2026-10-11T00:00:00Z' },
      ],
      lessons,
    });
    // A planning pass: no fragment-scoped lines.
    expect(guidance.text).not.toContain('NOT YOURS');
    expect(guidance.text).not.toContain(SEARCH_STRATEGY_NOTE);
    expect(guidance.unreachableHosts.map((entry) => entry.host)).toEqual(['a.gov']);
    expect(guidance.text).toContain('a.gov (UNREACHABLE, 2026-10-10)');
    expect(guidance.text).not.toContain('b.gov');
    expect(guidance.lessons).toHaveLength(MAX_GUIDANCE_LESSONS);
    expect(guidance.lessons.slice(0, 4).every((entry) => entry.abstraction === 'GENERAL')).toBe(true);

    const prompt = buildGoalPlanPrompt({
      project,
      layer,
      title: 't',
      assignment: 'a',
      passages: [],
      existingDocuments: [],
      guidance,
    });
    expect(prompt).toContain('LESSONS FROM EARLIER CAMPAIGNS');
    expect(prompt).toContain('context only');
  });

  it('reads reachability and lessons from rows', async () => {
    const { orchestrationId } = await packet();
    const fragments = await currentFragments(orchestrationId);
    await insertClaims([
      {
        orchestrationId,
        fragmentId: fragments[0]!.id,
        passId: null,
        passKey: 'BROAD_SCAN',
        claim: 'The registry lists the licence.',
        sourceUrl: 'https://www.registry.example.gov/licences',
        sourceTitle: null,
        sourcePublisher: null,
        sourceDate: null,
        evidenceExcerpt: null,
        evidenceLocator: null,
        evidenceLane: 'registry',
        retrievalState: 'UNREACHABLE',
        retrievedAt: null,
        confidence: 0.5,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        claimType: 'SOURCED_FACT',
        contentHash: 'h1',
      },
    ] as unknown as Parameters<typeof insertClaims>[0]);
    await recordLesson({
      orchestrationId,
      projectId: project.id,
      lessonKey: 'k1',
      scope: 'CAMPAIGN_CLOSED',
      abstraction: 'GENERAL',
      lesson: 'Official registries answered licensing questions faster than secondary guides.',
    });
    await recordLesson({
      orchestrationId,
      projectId: project.id,
      lessonKey: 'k2',
      scope: 'CAMPAIGN_CLOSED',
      abstraction: 'CAMPAIGN',
      lesson: 'This campaign only: never reusable.',
    });

    const reading = await hostReachability(null, new Date(Date.now() - 86_400_000).toISOString());
    expect(reading.find((entry) => entry.host === 'registry.example.gov')?.outcome).toBe('UNREACHABLE');

    const guidance = await guidanceFor({
      projectId: project.id,
      fragment: fragments[0]!,
      siblings: fragments,
      surface: null,
    });
    expect(guidance.unreachableHosts.map((entry) => entry.host)).toContain('registry.example.gov');
    expect(guidance.lessons.map((entry) => entry.lesson)).toEqual([
      'Official registries answered licensing questions faster than secondary guides.',
    ]);
  });
});

describe('a documented absence answers its lane without loosening the gate', () => {
  it('passes a required lane carrying one valid NEGATIVE_EXISTENCE claim, so no repair is minted', async () => {
    const { orchestrationId } = await packet();
    const fragment = (await currentFragments(orchestrationId))[0]!;
    const [absence] = await insertClaims([
      {
        orchestrationId,
        fragmentId: fragment.id,
        passId: null,
        passKey: 'BROAD_SCAN',
        claim: 'The state licensing registry lists no licence category for this activity.',
        sourceUrl: 'https://www.licensing.example.gov/categories',
        sourceTitle: 'Licence categories',
        sourcePublisher: 'State licensing board',
        sourceDate: '2026-01-01',
        evidenceExcerpt: 'Categories: A, B, C',
        evidenceLocator: 'category index',
        evidenceLane: 'registry',
        retrievedAt: '2026-10-01',
        confidence: 0.8,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        claimType: 'NEGATIVE_EXISTENCE',
        contentHash: 'abs',
      },
    ] as unknown as Parameters<typeof insertClaims>[0]);
    const gate = applyGate({
      fragment: (await getFragment(fragment.id))!,
      claims: [absence as ResearchClaim],
      verification: {
        verdicts: new Map([
          [
            absence!.id,
            {
              supportsClaim: true,
              scopeMatch: { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' },
              note: 'the index is the complete list',
            },
          ],
        ]),
        sufficiency: 'SUFFICIENT',
        missingLanes: [],
        unresolvedGaps: [],
      } as unknown as Parameters<typeof applyGate>[0]['verification'],
    });
    // The existing gate already accepts it: the lane meets its threshold and
    // the fragment passes, so the runner never plans a repair for it.
    expect(gate.claims[0]!.accepted).toBe(true);
    expect(gate.coverage.find((lane) => lane.lane === 'registry')!.meetsThreshold).toBe(true);
    expect(fragmentPasses(gate)).toBe(true);
  });
});

describe('a lesson is context, never an input to a decision', () => {
  it('changes no coverage verdict, repair plan or depth when one is recorded', async () => {
    const { orchestrationId } = await packet();
    const fragment = (await currentFragments(orchestrationId))[0]!;
    const requirement = { key: 'r', statement: 'Is a licence required to operate?' };
    const gate = {
      integrity: 'FAIL', sufficiency: 'INSUFFICIENT', unresolvedRetrieval: [], claims: [],
      acceptedClaims: 0, rejectedClaims: 0, independentSources: 0, coverage: [],
      duplicateSourceGroups: [], failedConditions: ['COVERAGE'], reasons: ['empty'], unresolvedGaps: [],
    } as unknown as Parameters<typeof buildRepairPlan>[0]['gate'];
    const decide = async () => ({
      coverage: (await coverBeforeWork({ projectId: project.id, layerId: layer.id, requirements: [requirement] }))
        .verdicts.map((verdict) => [verdict.status, verdict.needsResearch, verdict.claimIds]),
      repair: buildRepairPlan({
        fragment, gate, history: [fragment], claims: [], splitRequired: false, remainingBudget: 2,
        blockCause: 'NO_CLAIMS',
      }).strategies,
      depth: allocateDepth({
        consequence: 'HIGH',
        reversibility: 'IRREVERSIBLE',
        invalidating: true,
        conflictingClaims: 0,
        expectedClaimTypes: ['SOURCED_FACT'],
      } as unknown as Parameters<typeof allocateDepth>[0]).depth,
    });
    const before = await decide();
    await recordLesson({
      orchestrationId,
      projectId: project.id,
      lessonKey: 'lesson-a',
      scope: 'CAMPAIGN_CLOSED',
      abstraction: 'GENERAL',
      lesson: 'Licensing questions are always settled by one primary source; search less.',
    });
    expect(await decide()).toEqual(before);
  });

  it('is imported by nothing that judges, plans a repair, sets depth or allocates', () => {
    const root = path.resolve(__dirname, '..', 'server', 'services');
    const deciders = [
      'research/gate.ts',
      'research/standards.ts',
      'research/repair.ts',
      'research/approvalEnvelope.ts',
      'research/intelligence/depth.ts',
      'research/submission.ts',
      'reconcile/coverage.ts',
      'russell/coverage.ts',
    ];
    for (const file of deciders) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(text, file).not.toMatch(/from ['"][^'"]*guidance(\.ts)?['"]/);
      expect(text, file).not.toMatch(/reusableLessons/);
      expect(text, file).not.toMatch(/readableRoutes/);
    }
  });
});

describe('a readable route is named where the first route failed', () => {
  it('names the route for a channel the fragment asks about, and none for one it does not', () => {
    const guidance = composeGuidance({
      fragment: {
        fragmentKey: 'opening-screen',
        question: "Is Freelancer.com project 40774287 'Precise entry from PDFs' still open?",
      },
      siblings: [],
      reachability: [],
      lessons: [],
    });
    expect(guidance.readableRoutes.map((route) => route.host)).toEqual(['freelancer.com']);
    expect(guidance.text).toContain('READABLE ROUTES');
    expect(guidance.text).toContain('/api/projects/0.1/projects/<project id>/');
    expect(guidance.text).toContain('time_submitted');
    expect(guidance.text).toContain('data-color="success"');
    expect(guidance.text).not.toContain('sam.gov/api');
  });

  it('names the route for a host this surface could not read, even when the question does not', () => {
    const guidance = composeGuidance({
      fragment: { fragmentKey: 'rfqs', question: 'Which small federal solicitations close this month?' },
      siblings: [],
      reachability: [{ host: 'sam.gov', outcome: 'NOT_REACHABLE', at: '2026-10-17T00:00:00Z' }],
      lessons: [],
    });
    expect(guidance.readableRoutes.map((route) => route.host)).toEqual(['sam.gov']);
    expect(guidance.text).toContain('sam.gov/api/prod/sgs/v1/search/');
    expect(guidance.text).toContain('responseDate');
  });

  it('matches a channel by its own name and never by an ordinary word', () => {
    expect(routesFor({ question: 'Find a freelancer for the same job', unreachableHosts: [] })).toEqual([]);
    expect(routesFor({ question: 'see usam.gov', unreachableHosts: [] })).toEqual([]);
    expect(
      routesFor({ question: null, unreachableHosts: ['www.publicsurplus.com'] }).map((route) => route.host),
    ).toEqual(['publicsurplus.com']);
    expect(routesFor({ question: 'Read the SAM.gov notice', unreachableHosts: [] }).map((r) => r.host)).toEqual([
      'sam.gov',
    ]);
  });

  it('every route is a public https address that needs no key and no account', () => {
    for (const route of READABLE_ROUTES) {
      for (const line of route.lines) {
        for (const url of line.match(/https?:\/\/\S+/g) ?? []) {
          expect(url, route.host).toMatch(/^https:\/\//);
          expect(url, route.host).not.toMatch(/api_key|apikey|token=|access_token/i);
          expect(new URL(url.replace(/<[^>]+>/g, 'x')).hostname.endsWith(route.host), url).toBe(true);
        }
      }
    }
  });
});
