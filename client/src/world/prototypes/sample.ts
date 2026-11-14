/**
 * Sample state for the world prototypes (UI-27-5, S-0428: "Use genuine or
 * clearly marked sample state"). These are not records. Every title starts
 * with "Sample", every id with "sample_", and a prototype fed this data shows
 * the sample banner.
 */
import type { WorldFact, WorldState } from '../../../../server/routes/world.ts';

export const SAMPLE_GENERATED_AT = '2026-01-01T12:00:00.000Z';
export const SAMPLE_PROJECT_ID = 'sample_project';

function fact(kind: WorldFact['kind'], n: number, state: WorldState, recordState: string, extra: Partial<WorldFact> = {}): WorldFact {
  const id = `sample_${kind.toLowerCase()}_${n}`;
  return {
    kind,
    recordId: id,
    href: null,
    title: `Sample ${kind.toLowerCase().replace('_', ' ')} ${n}`,
    owner: 'sample owner',
    state,
    recordState,
    startedAt: '2026-01-01T09:00:00.000Z',
    lastChangedAt: '2026-01-01T11:30:00.000Z',
    blocker: null,
    nextAction: null,
    source: { table: 'sample', id },
    freshness: 'FRESH',
    missing: [],
    district: null,
    ...extra,
  };
}

export const SAMPLE_FACTS: readonly WorldFact[] = [
  fact('GOAL', 1, 'WORKING', 'ACTIVE'),
  fact('RESEARCH_JOB', 1, 'WORKING', 'RUNNING'),
  fact('RESEARCH_JOB', 2, 'WAITING', 'QUEUED'),
  fact('CAMPAIGN', 1, 'BLOCKED', 'BLOCKED', { blocker: 'Sample blocker: a check failed' }),
  fact('CAMPAIGN', 2, 'SUCCEEDED', 'DONE'),
  fact('OPPORTUNITY', 1, 'NEEDS_APPROVAL', 'PROPOSED', { nextAction: 'Sample: approve the offer' }),
  fact('INVOICE', 1, 'WAITING', 'ISSUED'),
  fact('WORK_UNIT', 1, 'FAILED', 'FAILED'),
  fact('WORK_UNIT', 2, 'IDLE', 'HELD'),
  fact('WORKER', 1, 'UNKNOWN', 'LEASE_EXPIRED', { freshness: 'STALE' }),
  fact('INFRASTRUCTURE', 1, 'SUCCEEDED', 'MIGRATED', { lastChangedAt: null, freshness: 'MISSING', missing: ['lastChangedAt'] }),
];
