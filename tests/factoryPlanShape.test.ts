/**
 * The shape of a plan decides how long DEVELOPMENT takes, and the planner says so.
 *
 * Reproduces the recorded failure class OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595:
 * DEVELOPMENT held 44% of the measured engineering critical path, because plans
 * chained units that never read each other's code (every edge is a whole
 * implement-and-integrate round) and handed one session several modules where
 * several sessions could have run at once. `validatePlan` now measures every
 * plan's width and depth and names the chain or the unit the plan gives no
 * reason for. It refuses nothing new: the gate is exactly what it was.
 */
import { describe, expect, it } from 'vitest';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';
import { measurePlanShape, validatePlan, type UnitSpec } from '../server/services/factory/planner.ts';

const changeRequest = {
  repository: 'example/subject',
  objective: 'Make the subject faster without changing what it does.',
  mutationScope: ['src/**', 'lib/**', 'tests/**'],
  verificationCommands: ['npm run typecheck', 'npm test'],
  acceptanceConditions: [{ id: 'A01', text: 'It is faster.', mandatory: true, checkedBy: 'npm test' }],
} as unknown as FactoryChangeRequest;

function unit(overrides: Partial<UnitSpec> & { key: string }): Record<string, unknown> {
  return {
    kind: 'IMPLEMENTATION',
    title: overrides.key,
    objective: `Implement the ${overrides.key} change inside the files this unit owns.`,
    acceptance: ['the change is implemented and tested'],
    ownedPaths: [`src/${overrides.key}.ts`],
    requiredContext: [],
    verification: ['npm test'],
    expectedArtifact: 'a diff',
    risk: 'MEDIUM',
    criticalPath: false,
    dependsOn: [],
    serves: ['A01'],
    ...overrides,
  };
}

/** The recorded shape: disjoint files, chained anyway, one of them owning three modules. */
const SERIAL_OVERSIZED = {
  units: [
    unit({ key: 'alpha', ownedPaths: ['src/alpha.ts', 'lib/a/one.ts', 'lib/b/two.ts'] }),
    unit({ key: 'beta', dependsOn: ['alpha'] }),
    unit({ key: 'gamma', dependsOn: ['beta'] }),
  ],
};

describe('plan shape (OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595)', () => {
  it('measures a serial, oversized decomposition and names what to change, without refusing it', () => {
    const validation = validatePlan(SERIAL_OVERSIZED, changeRequest);

    // The gate is unchanged: the plan was installable before and still is.
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.uncoveredConditions).toEqual([]);

    expect(validation.shape).toMatchObject({
      unitCount: 3,
      maxDepth: 3,
      maxWidth: 1,
      largestUnitPaths: 3,
      largestUnitModules: 3,
      longestChain: ['alpha', 'beta', 'gamma'],
    });

    const chain = validation.warnings.find((w) => /dependency edge\(s\) the plan gives no reason for/.test(w));
    expect(chain).toBeDefined();
    expect(chain).toMatch(/beta -> alpha/);
    expect(chain).toMatch(/gamma -> beta/);
    expect(chain).toMatch(/alpha -> beta -> gamma \(depth 3\)/);
    expect(chain).toMatch(/drop it/);

    const oversized = validation.warnings.find((w) => /`alpha` owns 3 source files across 3 directories/.test(w));
    expect(oversized).toMatch(/split it by file ownership/);
  });

  it('reports the wide, shallow version of the same work with no shape warning', () => {
    const validation = validatePlan(
      {
        units: [
          unit({ key: 'alpha' }),
          unit({ key: 'alpha-lib-one', ownedPaths: ['lib/a/one.ts'] }),
          unit({ key: 'alpha-lib-two', ownedPaths: ['lib/b/two.ts'] }),
          unit({ key: 'beta' }),
          unit({ key: 'gamma' }),
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(true);
    expect(validation.shape).toMatchObject({ unitCount: 5, maxDepth: 1, maxWidth: 5, largestUnitPaths: 1 });
    expect(validation.warnings.filter((w) => w.startsWith('Shape:'))).toEqual([]);
  });

  it('accepts an edge the plan explains: the dependent reads what the dependency owns', () => {
    const viaContext = validatePlan(
      {
        units: [
          unit({ key: 'iface', kind: 'INTERFACE', ownedPaths: ['src/iface.ts'] }),
          unit({ key: 'impl', ownedPaths: ['src/impl.ts'], requiredContext: ['src/iface.ts'], dependsOn: ['iface'] }),
        ],
      },
      changeRequest,
    );
    expect(viaContext.shape.maxDepth).toBe(2);
    expect(viaContext.warnings.filter((w) => w.startsWith('Shape:'))).toEqual([]);

    const viaObjective = measurePlanShape(
      [
        { ...(unit({ key: 'iface' }) as unknown as UnitSpec), modelClass: 'FAST' },
        {
          ...(unit({
            key: 'impl',
            objective: 'Call the new export from src/iface.ts inside src/impl.ts.',
            dependsOn: ['iface'],
          }) as unknown as UnitSpec),
          modelClass: 'FAST',
        },
      ],
    );
    expect(viaObjective.warnings).toEqual([]);
  });

  it('does not call a one-file objective, or one module and its tests, oversized', () => {
    const one = validatePlan({ units: [unit({ key: 'only' })] }, changeRequest);
    expect(one.shape).toMatchObject({ unitCount: 1, maxDepth: 1, maxWidth: 1, largestUnitPaths: 1, largestUnitModules: 1 });
    expect(one.warnings.filter((w) => w.startsWith('Shape:'))).toEqual([]);

    const moduleAndTests = validatePlan(
      {
        units: [
          unit({
            key: 'module',
            ownedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'tests/a.test.ts', 'tests/b.test.ts'],
          }),
        ],
      },
      changeRequest,
    );
    expect(moduleAndTests.shape.largestUnitModules).toBe(1);
    expect(moduleAndTests.warnings.filter((w) => w.startsWith('Shape:'))).toEqual([]);
  });

  it('carries the shape on a refused plan, and a zero shape on one that does not parse', () => {
    const refused = validatePlan(
      { units: [unit({ key: 'bad', verification: ['rm -rf /'] }), unit({ key: 'next', dependsOn: ['bad'] })] },
      changeRequest,
    );
    expect(refused.ok).toBe(false);
    expect(refused.shape).toMatchObject({ unitCount: 2, maxDepth: 2 });

    expect(validatePlan('not a plan', changeRequest).shape).toMatchObject({ unitCount: 0, maxDepth: 0 });
    expect(validatePlan({ units: [] }, changeRequest).shape.unitCount).toBe(0);
  });

  it('stops on a cycle instead of looping; the cycle itself is still refused', () => {
    const cyclic = validatePlan(
      { units: [unit({ key: 'one', dependsOn: ['two'] }), unit({ key: 'two', dependsOn: ['one'] })] },
      changeRequest,
    );
    expect(cyclic.ok).toBe(false);
    expect(cyclic.shape.unitCount).toBe(2);
    expect(cyclic.shape.maxDepth).toBeLessThanOrEqual(2);
  });
});
