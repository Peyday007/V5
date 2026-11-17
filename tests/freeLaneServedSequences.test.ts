/**
 * §86: the GPU slot's growth gate counts the pod's served sequences (vLLM
 * `--max-num-seqs`) as proven capacity. A fresh pod starts its highest-stable at
 * 1, and a stage reading naming a non-lane constraint held it at two slots while
 * it batched eight (production 2026-11-16 08:24Z).
 */
import { describe, expect, it } from 'vitest';
import { servedSequences } from '../server/services/freeLane/capacity.ts';
import { gateGrowth, type RecordedStageCapacity, type StageCapacityReport } from '../server/services/freeLane/stageCapacity.ts';
import { RECIPES, type PodRecipe } from '../server/services/cheap/runpodRestore.ts';

const recipe = (served: string, seqs: string | null): PodRecipe =>
  ({ key: served, model: served, served, gpus: [], image: 'i', cuda: [], maxModelLen: 1, args: seqs ? ['--gpu-memory-utilization', '0.9', '--max-num-seqs', seqs] : ['--gpu-memory-utilization', '0.9'], containerDiskInGb: 1, minGpuGb: 1, clouds: ['SECURE'], note: '' }) as PodRecipe;

describe('servedSequences', () => {
  const recipes = { a: recipe('Org/A', '8'), b: recipe('Org/B', '48'), c: recipe('Org/C', null) };

  it("reads the serving recipe's --max-num-seqs for a GPU slot", () => {
    expect(servedSequences('runpod/Org/A', recipes, null)).toBe(8);
    expect(servedSequences('runpod/Org/B', recipes, null)).toBe(48);
  });

  it('prefers the active recipe when it serves the model', () => {
    expect(servedSequences('runpod/Org/A', recipes, recipe('Org/A', '12'))).toBe(12);
    expect(servedSequences('runpod/Org/B', recipes, recipe('Org/A', '12'))).toBe(48);
  });

  it('is null for a non-GPU slot, an unknown model, or a recipe that names no batch size', () => {
    expect(servedSequences('brain-a', recipes, null)).toBeNull();
    expect(servedSequences('runpod/Org/Unknown', recipes, null)).toBeNull();
    expect(servedSequences('runpod/Org/C', recipes, null)).toBeNull();
  });

  it('knows every shipped recipe it is asked about', () => {
    for (const r of Object.values(RECIPES)) {
      const n = servedSequences(`runpod/${r.served}`);
      expect(n === null || n >= 1).toBe(true);
    }
    const awq32 = Object.values(RECIPES).find((r) => r.served === 'Qwen/Qwen3-32B-AWQ');
    if (awq32) expect(servedSequences('runpod/Qwen/Qwen3-32B-AWQ', RECIPES, null)).toBe(8);
  });
});

describe('the GPU growth gate with served sequences as proven', () => {
  // A reading whose constraint is a stage more model slots do not serve: every growth past proven is held.
  const elsewhere = {
    at: '2026-11-16T08:00:00Z', outcome: 'MEASURED', reason: 'r', ageMinutes: 5, stale: false, queuedNow: 0, queueAdvance: null,
    report: { windowHours: 6, since: '2026-11-16T02:00:00Z', stages: [], diagnosis: { routes: [], gpu: { samples: {}, startFailures: 0, lastStartFailure: null, notRunning: false }, primary: null, restored: [] }, constrained: { stage: 'commercial-execution' } } as unknown as StageCapacityReport,
  } as RecordedStageCapacity;
  const model = 'runpod/Org/A';
  const recipes = { a: recipe('Org/A', '8') };

  it('was held at 2 on a fresh pod', () => {
    const v = gateGrowth({ model, gpu: true, current: 2, stableHigh: 1, proposed: 4, recorded: elsewhere });
    expect(v).toMatchObject({ held: true, target: 2 });
  });

  it('fills up to the served sequences, and still holds growth beyond them', () => {
    const proven = Math.max(1, servedSequences(model, recipes, null) ?? 0);
    expect(gateGrowth({ model, gpu: true, current: 2, stableHigh: proven, proposed: 4, recorded: elsewhere })).toMatchObject({ held: false, target: 4 });
    expect(gateGrowth({ model, gpu: true, current: 4, stableHigh: proven, proposed: 8, recorded: elsewhere })).toMatchObject({ held: false, target: 8 });
    expect(gateGrowth({ model, gpu: true, current: 8, stableHigh: proven, proposed: 16, recorded: elsewhere })).toMatchObject({ held: true, target: 8 });
  });
});

describe('a data-parallel pod (owner acceleration 2026-11-16: more replicas behind the one GPU address)', () => {
  it('serves --max-num-seqs on every replica, and the runaway guard stays above it', async () => {
    const { gpuCeiling } = await import('../server/services/freeLane/capacity.ts');
    const two = RECIPES['gpt-oss-120b-2x80']!;
    const four = RECIPES['gpt-oss-120b-4x80']!;
    expect(two.gpuCount).toBe(2);
    expect(four.gpuCount).toBe(4);
    expect(servedSequences('runpod/openai/gpt-oss-120b', RECIPES, four)).toBe(192);
    expect(servedSequences('runpod/openai/gpt-oss-120b', RECIPES, two)).toBe(96);
    expect(gpuCeiling({}, 192)).toBe(192);
    expect(gpuCeiling({}, 48)).toBe(48);
    expect(gpuCeiling({}, null)).toBe(32);
    expect(gpuCeiling({ BRAIN_RUNPOD_MAX_SLOTS: '64' }, 192)).toBe(64);
  });

  it('asks RunPod for that many cards', async () => {
    const { podSpec } = await import('../server/services/cheap/runpodRestore.ts');
    expect(podSpec('k', undefined, 'SECURE', RECIPES['gpt-oss-120b-4x80']!)['gpuCount']).toBe(4);
    expect(podSpec('k', undefined, 'SECURE', RECIPES['gpt-oss-120b-80']!)['gpuCount']).toBe(1);
  });
});
