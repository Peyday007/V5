/**
 * The hot paths read what they use, and stop re-reading what has not changed.
 *
 * Production's Supabase egress was dominated by four readers (measured, not
 * inferred): every parked research bin re-evaluated its whole contract on every
 * reconcile tick — work items, document bytes and the project's entire audit
 * trail, with findings and gaps read one audit at a time; the dispatch and
 * reconcile loops read full bin rows (mostly manifest) to look at the state
 * column; and the Cash tick composed the same monetization ledger twice.
 *
 * Every assertion here is about which statements run, and each is paired with
 * one about the answer, because a cheaper reader that answers differently is a
 * behaviour change rather than a load reduction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  assignNextBin,
  createBin,
  ensureDispatchIntent,
  getBin,
  listDispatchableBinHeads,
  listDispatchableBins,
} from '../server/repos/bins.ts';
import { createAudit, getAudit, listAuditsByProject, listAuditsByRun } from '../server/repos/audits.ts';
import { reconcileBins, requestCompletion } from '../server/services/bins/service.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let workerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  workerId = (
    await createWorker({
      name: `w-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
});

/** Every statement the adapter runs while `work` runs, as text. */
async function statementsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const db = getDb() as unknown as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
  const originals = { all: db.all, get: db.get, run: db.run };
  const seen: string[] = [];
  for (const method of ['all', 'get', 'run'] as const) {
    const original = originals[method];
    db[method] = (...args: unknown[]) => {
      seen.push(String(args[0]));
      return original.apply(db, args);
    };
  }
  try {
    await work();
  } finally {
    Object.assign(db, originals);
  }
  return seen;
}

function manifest(): BinManifest {
  return {
    objective: 'drain it',
    why: 'A bin has to be about something.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: ['arithmetic'],
    excludedSources: ['a guess'],
    evidence: ['each value'],
    outputs: ['the values'],
    authorizedActions: ['compute'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['done'],
  };
}

async function packet(status: string): Promise<{ orchestrationId: string; runId: string }> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded question',
    assignment: 'what answers it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, {
    status: status as Parameters<typeof updateOrchestration>[1]['status'],
  });
  return { orchestrationId: orchestration.id, runId: run.id };
}

/** A research bin parked the way production parks one, with attempts left. */
async function parkedResearchBin(): Promise<{ binId: string; orchestrationId: string }> {
  const { orchestrationId } = await packet('NEEDS_HUMAN');
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'one research packet',
    objective: 'drain it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 4,
  });
  const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
  const outcome = await requestCompletion({
    workerId,
    proof: { binId: bin.id, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
  });
  expect(outcome.state).toBe('NEEDS_HUMAN');
  const parked = (await getBin(bin.id))!;
  expect(parked.attemptCount).toBeLessThan(parked.maxAttempts);
  return { binId: bin.id, orchestrationId };
}

describe('a parked research bin whose packet has not moved', () => {
  it('stays parked without reading its audits, work items or document', async () => {
    const { binId } = await parkedResearchBin();
    const statements = await statementsDuring(() => reconcileBins(projectId));
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');
    const expensive = statements.filter((sql) => /FROM (audits|audit_findings|audit_gaps|work_items|documents)\b/.test(sql));
    expect(expensive).toEqual([]);
  });

  it('is re-evaluated, and reopened, once the packet moves', async () => {
    const { binId, orchestrationId } = await parkedResearchBin();
    await reconcileBins(projectId);
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');

    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });
    await reconcileBins(projectId);
    expect((await getBin(binId))!.state).toBe('READY');
  });

  it('reads no full bin row to judge the page', async () => {
    await parkedResearchBin();
    const statements = await statementsDuring(() => reconcileBins(projectId));
    expect(statements.filter((sql) => /SELECT \* FROM bins/.test(sql))).toEqual([]);
  });
});

describe('a project\'s audits are read in a fixed number of statements', () => {
  it('answers exactly what reading them one at a time answered', async () => {
    const { runId } = await packet('AUDITING');
    for (let index = 0; index < 12; index += 1) {
      await createAudit({
        projectId,
        layerId,
        runId: index % 2 === 0 ? runId : null,
        result: {
          verdict: 'PATCH',
          summary: `audit ${index}`,
          failures: [`failure ${index}a`, `failure ${index}b`],
          requiredPatches: [`patch ${index}`],
          nextAction: `next ${index}`,
        } as Parameters<typeof createAudit>[0]['result'],
        gaps: [
          { classification: 'PATCH', title: `gap ${index} one` },
          { classification: 'PATCH', title: `gap ${index} two` },
        ] as Parameters<typeof createAudit>[0]['gaps'],
      });
    }

    let listed: Awaited<ReturnType<typeof listAuditsByProject>> = [];
    const statements = await statementsDuring(async () => {
      listed = await listAuditsByProject(projectId);
    });
    expect(listed).toHaveLength(12);
    // One for the audits, one each for findings and gaps — not 1 + 2 per audit.
    expect(statements.length).toBeLessThanOrEqual(3);

    for (const audit of listed) {
      expect(audit).toEqual(await getAudit(audit.id));
    }

    const byRun = await listAuditsByRun(projectId, runId);
    expect(byRun.map((one) => one.id).sort()).toEqual(
      listed.filter((one) => one.runId === runId).map((one) => one.id).sort(),
    );
  });
});

describe('the dispatch tick reads heads, not rows', () => {
  async function readyBin(title: string): Promise<string> {
    return (
      await createBin({
        projectId,
        kind: 'DETERMINISTIC_CHECK',
        title,
        objective: 'a check',
        manifest: manifest(),
        completionContract: 'DETERMINISTIC_UNITS_V1',
        createdByType: 'SYSTEM',
        createdById: 'test',
        ready: true,
      })
    ).id;
  }

  it('selects no manifest, and returns the same bins in the same order', async () => {
    await readyBin('one');
    await readyBin('two');
    let heads: Awaited<ReturnType<typeof listDispatchableBinHeads>> = [];
    const statements = await statementsDuring(async () => {
      heads = await listDispatchableBinHeads(200);
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toMatch(/\*/);
    expect(statements[0]).not.toMatch(/manifest|objective|rationale|checkpoint/);
    expect(heads.map((one) => one.id)).toEqual((await listDispatchableBins(200)).map((one) => one.id));
  });

  it('skips a bin that already has its intent, which an insert would not have changed', async () => {
    const first = await readyBin('one');
    const second = await readyBin('two');
    await ensureDispatchIntent((await getBin(first))!);
    const pending = await listDispatchableBinHeads(200, { onlyWithoutIntent: true });
    expect(pending.map((one) => one.id)).toContain(second);
    expect(pending.map((one) => one.id)).not.toContain(first);
  });
});

describe('the Cash tick composes the ledger once when nothing it reads changed', () => {
  it('passes the composed ledger to the movement pass unless an answer was filed', () => {
    const source = readFileSync(join(process.cwd(), 'server/services/cash/operate.ts'), 'utf8');
    expect(source).toMatch(/ledger: commissions\.recorded\.length === 0 \? ledger : undefined/);
  });
});
