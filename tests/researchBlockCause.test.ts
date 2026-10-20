/**
 * Every BLOCKED write stores why, in the statement that blocks; a row from
 * before the column existed still classifies exactly as it did.
 *
 * The guarantee is structural — the column is written inside `updateFragment`,
 * the one function that can move a fragment's status — so this file holds that
 * structure (no other writer of `research_fragments.status` exists) and then
 * drives the write with each shape of reason the runner and the gate produce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  gateFailureDistribution,
  getFragment,
  updateFragment,
} from '../server/repos/research.ts';
import { blockCauseOf, blockHostFor, classifyBlock } from '../server/services/research/gate.ts';
import type { GateResult } from '../server/services/research/gate.ts';

let projectId = '';
let layerId = '';

async function fragmentId(): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 't',
    assignment: 'a',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'k',
      question: 'q',
      requiredEvidence: [{ id: 'lane', description: 'd', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official'],
      excludedSourceTypes: [],
      completionCriteria: ['c'],
      dependsOn: [],
      minIndependentSources: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  return (await currentFragments(orchestration.id))[0]!.id;
}

function unreadable(urls: string[]): GateResult {
  return {
    integrity: 'FAIL',
    sufficiency: 'INSUFFICIENT',
    unresolvedRetrieval: urls.map((url, index) => ({
      claimId: `c${index}`,
      claim: 'x',
      sourceUrl: url,
      state: 'UNREACHABLE',
    })),
    claims: [],
    acceptedClaims: 0,
    rejectedClaims: 0,
    independentSources: 0,
    coverage: [],
    duplicateSourceGroups: [],
    failedConditions: [],
    reasons: ['every source was unreadable'],
    unresolvedGaps: [],
  };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

describe('a BLOCKED write stores its cause in the same statement', () => {
  const cases: { name: string; reason: string; verdict?: unknown; cause: string; host?: string | null }[] = [
    {
      name: 'a faulted work item',
      reason: 'A verification work item for this fragment finished without recording anything. Its research is kept.',
      cause: 'WORK_FAULTED',
    },
    {
      name: 'a stranded dependent',
      reason: 'Not researched: it depends on licence-trigger (BLOCKED), and that never arrives.',
      cause: 'DEPENDENCY',
    },
    {
      name: "a worker's own blocker naming the network",
      reason: 'getaddrinfo ENOTFOUND legislature.mi.gov while fetching https://legislature.mi.gov/x',
      cause: 'SOURCE_ACCESS',
      host: 'legislature.mi.gov',
    },
    {
      name: "a worker's own blocker naming nothing",
      reason: 'The question cannot be answered as phrased.',
      cause: 'NO_GATE_VERDICT',
    },
    {
      name: 'a gate verdict with only unreadable sources, one host dominant',
      reason: 'every source was unreadable',
      verdict: unreadable(['https://a.gov/1', 'https://a.gov/2', 'https://b.gov/1']),
      cause: 'SOURCES_UNREADABLE',
      host: 'a.gov',
    },
    {
      name: 'a gate verdict with only unreadable sources, no host dominant',
      reason: 'every source was unreadable',
      verdict: unreadable(['https://a.gov/1', 'https://b.gov/1']),
      cause: 'SOURCES_UNREADABLE',
      host: null,
    },
  ];

  for (const entry of cases) {
    it(`stores ${entry.cause} for ${entry.name}`, async () => {
      const id = await fragmentId();
      await updateFragment(id, {
        status: 'BLOCKED',
        blockedReason: entry.reason,
        ...(entry.verdict ? { verdictDetail: entry.verdict } : {}),
        completedAt: new Date().toISOString(),
      });
      const stored = (await getFragment(id))!;
      expect(stored.blockCause).toBe(entry.cause);
      // The column is classifyBlock's answer — one classifier, not two.
      expect(stored.blockCause).toBe(classifyBlock({ blockedReason: entry.reason, verdictDetail: entry.verdict ?? null }));
      if (entry.host !== undefined) expect(stored.blockHost).toBe(entry.host);
    });
  }

  it('reads the reason already on the row when the BLOCKED write carries none', async () => {
    const id = await fragmentId();
    await updateFragment(id, { blockedReason: 'Not researched: it depends on x, and that never arrives.' });
    expect((await getFragment(id))!.blockCause).toBeNull();
    await updateFragment(id, { status: 'BLOCKED' });
    expect((await getFragment(id))!.blockCause).toBe('DEPENDENCY');
  });

  it('clears the cause when the fragment leaves BLOCKED', async () => {
    const id = await fragmentId();
    await updateFragment(id, { status: 'BLOCKED', blockedReason: 'ENOTFOUND a.gov' });
    expect((await getFragment(id))!.blockCause).toBe('SOURCE_ACCESS');
    await updateFragment(id, { status: 'QUEUED', blockedReason: null });
    const after = (await getFragment(id))!;
    expect(after.blockCause).toBeNull();
    expect(after.blockHost).toBeNull();
  });
});

describe('a legacy row still classifies, and a report reads the column first', () => {
  it('classifies a NULL block_cause from its reason, and prefers a stored one', async () => {
    const legacy = await fragmentId();
    const stored = await fragmentId();
    const at = new Date().toISOString();
    await updateFragment(legacy, { status: 'BLOCKED', blockedReason: 'ENOTFOUND a.gov', completedAt: at });
    await updateFragment(stored, { status: 'BLOCKED', blockedReason: 'ENOTFOUND a.gov', completedAt: at });
    // A row from before the column: the cause was never written.
    await getDb().run('UPDATE research_fragments SET block_cause = NULL, block_host = NULL WHERE id = ?', [legacy]);
    // A stored answer that differs from what the words alone would say wins.
    await getDb().run("UPDATE research_fragments SET block_cause = 'NO_CLAIMS' WHERE id = ?", [stored]);

    // The window is pinned past `at`. Left to default, `until` is the moment the
    // read runs, and on a fast runner that is the same millisecond as `at`, so
    // `completed_at < until` excluded both rows: Deploy 39463649319 failed here.
    const d = await gateFailureDistribution({
      projectId,
      since: new Date(Date.now() - 86_400_000).toISOString(),
      until: new Date(Date.parse(at) + 60_000).toISOString(),
    });
    expect(d.blockedByCause.SOURCE_ACCESS).toBe(1);
    expect(d.blockedByCause.NO_CLAIMS).toBe(1);
    expect(d.causeSource).toEqual({ stored: 1, legacy: 1 });
    expect(blockCauseOf({ blockCause: null, blockedReason: 'ENOTFOUND a.gov', verdictDetail: null })).toBe('SOURCE_ACCESS');
  });

  it('names no host for a cause that is not about reaching a source', () => {
    expect(blockHostFor({ cause: 'NOTHING_SURVIVED', blockedReason: 'https://a.gov', verdictDetail: null })).toBeNull();
  });
});

describe('no other writer of a fragment status exists', () => {
  it('moves research_fragments.status only through updateFragment', () => {
    const root = path.resolve(__dirname, '..', 'server');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          if (/UPDATE\s+research_fragments\s+SET[^`]*\bstatus\s*=/i.test(text)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    // research.ts holds updateFragment, whose SET clause is built from a patch.
    expect(offenders.filter((file) => file !== path.join('repos', 'research.ts'))).toEqual([]);
  });
});
