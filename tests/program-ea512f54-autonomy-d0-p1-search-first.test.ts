/**
 * AUTO-20-2 step 3, enforced rather than journalled: what exists is searched
 * and recorded before any work is handed to an owner, and what the search found
 * is carried into the research assignment and the engineering objective.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { readGapLoop, recordGapStep, GapStepRefused, type ExistingMatch } from '../server/services/selfmodel/gapLoop.ts';
import { gapStepsDue, searchBeforeAcquire, searchQueryFor } from '../server/services/selfmodel/gapLoopSync.ts';
import { composeObjective, existingSentence } from '../server/services/improvement/loop.ts';
import type { ImprovementCandidate } from '../server/repos/improvement.ts';

const candidate = (over: Partial<ImprovementCandidate> = {}): ImprovementCandidate => ({
  id: 'imp_1', weaknessKey: 'FREE_LANE_FAILURE:EMPTY_SOURCE', kind: 'FREE_LANE_FAILURE', title: 'Free-lane jobs settle with no readable source',
  problem: 'Jobs end with no readable source.', metric: 'FREE_LANE_PASS_RATE' as ImprovementCandidate['metric'], downstreamMetric: null,
  ownerComponent: 'server/services/sources/access.ts', frequency: 12, denominator: 40, scope: 'SYSTEM' as ImprovementCandidate['scope'],
  severity: 'HIGH' as ImprovementCandidate['severity'], evidence: { samples: ['no readable source'] }, proposal: null, dependencyCheck: null,
  researchGoalId: null, changeRequestId: null, campaignId: null, deliveredAt: null, deliveredRef: null, baseline: null, result: null,
  decision: null, decisionReason: null, combinedIntoId: null, heldOn: null, attempt: 1, parentId: null,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', ...over,
});
const match: ExistingMatch = { kind: 'COMPONENT', name: 'Source access layer', detail: 'SERVICE sources.access' };

describe('the search runs and is recorded before anything is acquired', () => {
  it('records NOTICE, HYPOTHESIS and SEARCH_EXISTING (and nothing past them), then answers from the record', async () => {
    await freshProject();
    const c = candidate({ weaknessKey: `SEARCH_FIRST:${Date.now()}` });
    // Before the search, acquisition is refused.
    await expect(recordGapStep({ gapKey: c.weaknessKey, step: 'ACQUIRE', summary: 'x', detail: { owner: 'Factory', ref: 'FACTORY:1' } })).rejects.toBeInstanceOf(GapStepRefused);
    let searches = 0;
    const search = async (q: { terms: readonly string[]; paths?: readonly string[] }) => {
      searches += 1;
      expect(q).toMatchObject(searchQueryFor(c));
      return [match];
    };
    const found = await searchBeforeAcquire(c, { archiveClaims: 3, search });
    expect(found).toEqual({ archiveClaims: 3, existing: [match], recorded: true });
    const state = await readGapLoop(c.weaknessKey);
    expect(Object.keys(state.latest).sort()).toEqual(['HYPOTHESIS', 'NOTICE', 'SEARCH_EXISTING']);
    expect(state.latest.SEARCH_EXISTING!.detail).toMatchObject({ archiveClaims: 3, beforeAcquire: true, existing: [match] });
    // The search came first, so acquisition is now accepted.
    await recordGapStep({ gapKey: c.weaknessKey, step: 'ACQUIRE', summary: 'handed to Factory', detail: { owner: 'Factory', ref: 'FACTORY:1' } });
    // A second call is answered by the recorded search, without searching again.
    const again = await searchBeforeAcquire(c, { archiveClaims: 9, search });
    expect(again).toEqual({ archiveClaims: 3, existing: [match], recorded: false });
    expect(searches).toBe(1);
  });

  it('a candidate handed off before any search is recorded as searched afterwards, never as if it came first', () => {
    const empty = { gapKey: 'g', latest: {}, next: 'NOTICE', outstanding: [], integrated: false, concluded: false } as never;
    const due = gapStepsDue(candidate({ changeRequestId: 'fcr_1' }), empty, { archiveClaims: 0, existing: [] });
    const search = due.find((d) => d.step === 'SEARCH_EXISTING')!;
    expect(search.detail['beforeAcquire']).toBe(false);
    expect(search.summary).toMatch(/recorded after the work was handed off/);
    const fresh = gapStepsDue(candidate(), empty, { archiveClaims: 0, existing: [] }).find((d) => d.step === 'SEARCH_EXISTING')!;
    expect(fresh.detail['beforeAcquire']).toBe(true);
  });
});

describe('what the search found feeds the work', () => {
  const baseline = { value: 0.3, numerator: 12, denominator: 40 } as never;
  const link = { research: null, factory: null, archive: [] };

  it('the engineering objective names what already exists and tells Factory to extend it', () => {
    const spec = composeObjective(candidate(), link, [], baseline, [match]);
    expect(spec.objective).toContain('Already in Brain, found by searching before building');
    expect(spec.objective).toContain('Source access layer (SERVICE sources.access)');
    const none = composeObjective(candidate(), link, [], baseline, []);
    expect(none.objective).toContain('found nothing that already does this');
  });

  it('says plainly when nothing was found', () => {
    expect(existingSentence([])).toMatch(/found nothing/);
    expect(existingSentence([match])).toMatch(/extend them rather than adding a second mechanism/);
  });
});
