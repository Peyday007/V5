import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchFragment } from '../server/domain/types.ts';
import type { GateResult } from '../server/services/research/gate.ts';

const created: Record<string, any>[][] = [];
vi.mock('../server/repos/research.ts', () => ({
  createFragments: async (inputs: Record<string, any>[]) => {
    created.push(inputs);
    return inputs;
  },
}));

const { shouldSplit, splitFragment, MAX_SPLIT_PARTS } = await import(
  '../server/services/research/splitting.ts'
);

const lane = (id: string) => ({ id, description: id, necessity: 'REQUIRED' as const });

function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    id: 'frg_parent',
    orchestrationId: 'orc_test',
    projectId: 'prj_test',
    layerId: 'lyr_test',
    fragmentKey: 'parent',
    question: 'What do transcription vendors charge?',
    requiredEvidence: [lane('fees'), lane('vendors'), lane('dates')],
    acceptableSourceTypes: [],
    excludedSourceTypes: [],
    completionCriteria: [],
    dependsOn: [],
    evidenceLane: 'fees',
    requirementIds: [],
    ...overrides,
  } as unknown as ResearchFragment;
}

const cov = (id: string, ok: boolean) => ({ lane: id, meetsThreshold: ok });
const gate = (...lanes: [string, boolean][]) =>
  ({ coverage: lanes.map(([id, ok]) => cov(id, ok)) }) as unknown as GateResult;

beforeEach(() => {
  created.length = 0;
});

describe('a split by evidence lane', () => {
  it('gives each child exactly the empty lane it exists to fill', async () => {
    const parent = fragment();
    const signal = shouldSplit(parent, gate(['fees', true], ['vendors', false], ['dates', false]))!;
    expect(signal.laneIds).toEqual(['vendors', 'dates']);
    await splitFragment({ fragment: parent, signal, startIndex: 1 });
    const kids = created[0]!;
    expect(kids.map((k) => k.requiredEvidence.map((l: { id: string }) => l.id))).toEqual([
      ['vendors'],
      ['dates'],
    ]);
    expect(kids.map((k) => k.evidenceLane)).toEqual(['vendors', 'dates']);
  });
});

describe('a split that is not by lane', () => {
  it('keeps every lane on each child of a two-question split', async () => {
    const parent = fragment({ requiredEvidence: [lane('fees'), lane('vendors')], question: 'Who sells? And what do they charge?' });
    const signal = shouldSplit(parent, null)!;
    expect(signal.laneIds).toBeUndefined();
    await splitFragment({ fragment: parent, signal, startIndex: 1 });
    for (const kid of created[0]!) expect(kid.requiredEvidence).toEqual(parent.requiredEvidence);
  });

  it('does not silently truncate five questions', async () => {
    const parent = fragment();
    const question = 'a? b? c? d? e?';
    expect(shouldSplit(fragment({ question }), null)).toBeNull();
    const signal = { reason: 'x', questions: ['a?', 'b?', 'c?', 'd?', 'e?'] };
    await expect(splitFragment({ fragment: parent, signal, startIndex: 1 })).rejects.toThrow(/at most/);
    expect(created).toHaveLength(0);
    expect(MAX_SPLIT_PARTS).toBe(4);
  });
});
