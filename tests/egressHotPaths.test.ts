/**
 * The background passes ask the database for what they read, and no more.
 *
 * Measured in production from `pg_stat_statements` on 2026-10-03, over forty
 * days: the findings and gaps of every audit were read one audit at a time
 * (14.4 million queries each, ~108 GB), the dispatcher read every column of up
 * to 200 bins every ten seconds to use three of them, parked research bins were
 * re-evaluated in full every thirty seconds only to be refused again, and the
 * packet runner read each project's whole page of work items once per packet
 * to keep a handful.
 *
 * Each assertion here is either a **statement count** that must not grow with
 * the data, or a **column** that must not be fetched — and each is paired with
 * an equivalence check against the behaviour it replaced, because the point of
 * the change is that nothing it decides has moved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createAudit,
  getAudit,
  getAuditRef,
  listAuditRefsForRun,
  listAuditsByProject,
} from '../server/repos/audits.ts';
import { createBin, getBin, listBinHeads, listDispatchableBins } from '../server/repos/bins.ts';
import {
  createOrchestration,
  getOrchestration,
  getOrchestrationHead,
  listPassCompletionTimes,
  updateOrchestration,
} from '../server/repos/research.ts';
import { enqueueWork, listProjectPageItemsFor, listWorkItems } from '../server/repos/workQueue.ts';
import { evaluateContract, researchPacketCertainlyParks } from '../server/services/bins/contracts.ts';
import { ORCHESTRATION_STATUSES } from '../server/domain/types.ts';
import { createRun } from '../server/repos/runs.ts';
import type { BinManifest } from '../server/domain/types.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterEach(async () => {
  await teardown();
});

/** Every statement the adapter is asked to run while `work` runs, with its SQL. */
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


async function newRun(): Promise<string> {
  const run = await createRun({
    projectId: fixture.project.id,
    layerId: fixture.layers[0]!.id,
    runType: 'RESEARCH',
  } as never);
  return run.id;
}

/** A packet, with the run every packet belongs to. */
async function packet(assignment = 'Answer one question.'): Promise<string> {
  const made = await createOrchestration({
    projectId: fixture.project.id,
    layerId: fixture.layers[0]!.id,
    runId: await newRun(),
    title: 'a packet',
    assignment,
    provider: 'WORKER',
  });
  return made.id;
}

const RESULT = {
  verdict: 'PASS' as const,
  summary: 'An audit.',
  failures: ['a failure', 'another failure'],
  missingDocuments: [],
  requiredResearchRuns: [],
  requiredPatches: ['a patch'],
  synthesisRequired: false,
  freezeEligible: true,
  nextVersion: null,
  nextAction: 'Nothing.',
};

async function audit(runId: string | null): Promise<string> {
  const layer = fixture.layers[0]!;
  const made = await createAudit({
    projectId: fixture.project.id,
    layerId: layer.id,
    runId,
    result: RESULT,
    gaps: [
      { classification: 'PATCH', title: 'first gap' },
      { classification: 'OTHER_LAYER', title: 'second gap' },
    ],
  });
  return made.id;
}

describe('the audit listing', () => {
  it('reads findings and gaps in a fixed number of statements, however many audits there are', async () => {
    for (let i = 0; i < 2; i += 1) await audit(null);
    const few = await statementsDuring(() => listAuditsByProject(fixture.project.id));
    for (let i = 0; i < 10; i += 1) await audit(null);
    const many = await statementsDuring(() => listAuditsByProject(fixture.project.id));

    // One for the audits, one for every finding, one for every gap.
    expect(few).toHaveLength(3);
    expect(many).toHaveLength(3);
    expect(many.some((sql) => /audit_findings WHERE audit_id = \?/.test(sql))).toBe(false);
  });

  it('returns exactly what the per-audit reads returned', async () => {
    for (let i = 0; i < 4; i += 1) await audit(null);
    const listed = await listAuditsByProject(fixture.project.id);
    expect(listed).toHaveLength(4);
    for (const one of listed) {
      // `getAudit` still reads one audit's children one audit at a time, which
      // is the shape the listing used to have. They must agree field for field.
      expect(one).toEqual(await getAudit(one.id));
      expect(one.findings.length).toBeGreaterThan(0);
      expect(one.gaps.map((gap) => gap.title)).toEqual(['first gap', 'second gap']);
    }
  });

  it('answers the run-scoped question with ids and times only', async () => {
    const run = { id: await newRun() };
    const inRun = [await audit(run.id), await audit(run.id)];
    const noRun = await audit(null);

    const statements = await statementsDuring(() => listAuditRefsForRun(fixture.project.id, run.id));
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toMatch(/SELECT \*/);
    expect(statements[0]).not.toMatch(/raw|evidence_manifest/);

    // The same set the in-memory filter over the full listing selected.
    const all = await listAuditsByProject(fixture.project.id);
    const expected = all.filter((one) => one.runId === run.id).map((one) => one.id);
    expect((await listAuditRefsForRun(fixture.project.id, run.id)).map((one) => one.id)).toEqual(expected);
    expect([...expected].sort()).toEqual([...inRun].sort());
    // And a null run matches only the audits with no run, as `===` did.
    expect((await listAuditRefsForRun(fixture.project.id, null)).map((one) => one.id)).toEqual([noRun]);
    expect((await getAuditRef(noRun))?.id).toBe(noRun);
  });
});

const MANIFEST: BinManifest = {
  objective: 'Hold a research packet.',
  why: 'To exercise the contract.',
  lineage: { projectId: '', layerId: null, goal: null, orchestrationId: null },
  units: [{ key: 'unit-1', establishes: 'x', input: 'y', transform: 'sha256', dependsOn: [] }],
  acceptableSources: [],
  excludedSources: [],
  evidence: ['the packet'],
  outputs: ['the report'],
  authorizedActions: ['research'],
  prohibitedActions: ['anything with an external effect'],
  budgetUnits: 1,
  retry: { maxAttempts: 3, backoffSeconds: 30 },
  stoppingConditions: ['the packet files'],
} as unknown as BinManifest;

describe('the dispatcher reads three columns', () => {
  it('lists dispatchable bins without their manifests', async () => {
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'dispatchable',
      objective: 'Hold work.',
      manifest: MANIFEST,
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const statements = await statementsDuring(() => listDispatchableBins());
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT id, project_id, lease_generation FROM bins/);
    const listed = await listDispatchableBins();
    expect(listed).toEqual([{ id: bin.id, projectId: fixture.project.id, leaseGeneration: bin.leaseGeneration }]);
  });

  it('a bin head carries everything a bin does except its large text', async () => {
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'head',
      objective: 'Hold work.',
      manifest: MANIFEST,
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const statements = await statementsDuring(() => listBinHeads({ projectId: fixture.project.id }));
    expect(statements[0]).not.toMatch(/SELECT \*|manifest|checkpoint,|objective/);
    const [head] = await listBinHeads({ projectId: fixture.project.id });
    const whole = (await getBin(bin.id))!;
    const {
      objective: _o,
      rationale: _r,
      manifest: _m,
      checkpoint: _c,
      terminalReason: _t,
      lastRefusal: _l,
      ...rest
    } = whole;
    expect(head).toEqual(rest);
  });
});

describe('a parked research bin is not re-evaluated to be refused again', () => {
  it('decides HUMAN from the status exactly when the full evaluation does', async () => {
    const orchestration = { id: await packet() };
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'RESEARCH_PACKET',
      title: 'packet bin',
      objective: 'Hold a research packet.',
      manifest: MANIFEST,
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: orchestration.id,
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    } as never);

    for (const status of ORCHESTRATION_STATUSES) {
      await updateOrchestration(orchestration.id, { status } as never);
      const full = await evaluateContract((await getBin(bin.id))!);
      const certain = await researchPacketCertainlyParks((await getBin(bin.id))!);
      expect(certain, status).toBe(full.disposition === 'HUMAN');
    }
  });

  it('asks one narrow column to decide it', async () => {
    const orchestration = { id: await packet() };
    await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN' } as never);
    const statements = await statementsDuring(() =>
      researchPacketCertainlyParks({ completionContract: 'RESEARCH_PACKET_V1', orchestrationId: orchestration.id }),
    );
    expect(statements).toEqual(['SELECT status FROM research_orchestrations WHERE id = ?']);
    expect(
      await researchPacketCertainlyParks({ completionContract: 'DETERMINISTIC_UNITS_V1', orchestrationId: null }),
    ).toBe(false);
  });
});

describe('packet reads without the long texts', () => {
  it('an orchestration head is the orchestration without its assignment and report', async () => {
    const orchestration = { id: await packet('Answer one question. '.repeat(200)) };
    await updateOrchestration(orchestration.id, { reportText: 'A report. '.repeat(500) } as never);
    const statements = await statementsDuring(() => getOrchestrationHead(orchestration.id));
    expect(statements[0]).not.toMatch(/SELECT \*|report_text|assignment/);
    const whole = (await getOrchestration(orchestration.id))!;
    const { assignment: _a, reportText: _t, ...rest } = whole;
    expect(await getOrchestrationHead(orchestration.id)).toEqual(rest);
    expect(await listPassCompletionTimes(orchestration.id)).toEqual([]);
  });
});

describe("the packet runner's page of work", () => {
  it('returns what the page-then-filter returned, filtered by the database', async () => {
    const make = async () => await packet();
    const mine = await make();
    const other = await make();
    for (let i = 0; i < 3; i += 1) {
      await enqueueWork({
        projectId: fixture.project.id,
        orchestrationId: mine,
        workType: 'SYNTHETIC_ECHO',
        payload: { i },
        createdByType: 'SYSTEM',
        createdById: 'test',
      } as never);
      await enqueueWork({
        projectId: fixture.project.id,
        orchestrationId: other,
        workType: 'SYNTHETIC_ECHO',
        payload: { i },
        createdByType: 'SYSTEM',
        createdById: 'test',
      } as never);
    }
    const before = (await listWorkItems(fixture.project.id, { limit: 500 })).filter(
      (item) => item.orchestrationId === mine,
    );
    const after = await listProjectPageItemsFor(fixture.project.id, mine);
    expect(after).toEqual(before);
    expect(after).toHaveLength(3);
  });
});

// Keeps the document helper imported for fixtures that need a filed report.
void addDocument;
