/**
 * An effect's transaction holds its connection for the effect, not for a recompute.
 *
 * Production, 2026-11-14 (connection reports 17:39Z and 19:11Z): the top pooled
 * connection holder in every stalled process was `runIdempotent`'s transaction
 * (`effects/engine.ts:257`, up to 2,020 s on one connection, 113 s after the
 * 4 GB release), because the judge submission, the filing and the completion
 * each end in `recomputeProject`, which asked the document store about every
 * document over HTTPS and re-derived every layer while the effect's connection
 * and row locks waited.
 *
 * The fake bucket records, for every request, whether the caller was inside a
 * database transaction at that moment. The effect must make none from inside
 * one; the recompute must still have run — once, keyed by project — by the
 * time `runIdempotent` returns; and a rolled-back effect must run none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { inTransaction } from '../server/db/database.ts';
import { initStorage, resetStorage } from '../server/services/storage/index.ts';
import { createDocument, getDocument } from '../server/repos/documents.ts';
import { listLayers } from '../server/repos/layers.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';
import { runIdempotent, type OperationNamespace } from '../server/services/effects/engine.ts';

const NS: OperationNamespace = {
  name: 'test.effect.recompute',
  version: 1,
  principalScope: 'PRINCIPAL',
  retention: 'STANDARD',
};

interface StoreCalls {
  total: number;
  insideTransaction: number;
}

let projectId = '';
let documentId = '';
let calls: StoreCalls;
let keySeq = 0;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = (await listLayers(projectId))[0]!;
  calls = { total: 0, insideTransaction: 0 };
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.total += 1;
    if (inTransaction()) calls.insideTransaction += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Every listing comes back empty: the document's bytes are gone.
    if (/\/storage\/v1\/object\/list\//.test(String(url))) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unhandled', { status: 500 });
  }) as unknown as typeof fetch;
  resetStorage();
  await initStorage({
    config: { provider: 'supabase', supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'k', bucket: 'brain' },
    fetchImpl,
    verify: false,
  });
  const key = `projects/${projectId}/documents/doc_gone/original/gone.md`;
  const document = await createDocument({
    projectId,
    layerId: layer.id,
    canonicalName: 'Gone report',
    version: 'v1',
    versionSort: '000001',
    documentType: 'FOUNDATION',
    status: 'COMPLETE',
    filename: 'gone.md',
    filesystemPath: key,
    storageKey: key,
  });
  documentId = document.id;
  calls.total = 0;
  calls.insideTransaction = 0;
});

afterEach(async () => {
  resetStorage();
  await teardown();
});

function effect(execute: () => Promise<void>) {
  return runIdempotent(
    {
      namespace: NS,
      projectId,
      key: `effect-recompute-${String(++keySeq).padStart(8, '0')}`,
      payload: { n: keySeq },
      principalType: 'HUMAN',
      principalId: 'usr_one',
    },
    async () => {
      await execute();
      return { resultRef: 'r', resultStatus: 200, value: null };
    },
  );
}

describe('an effect that asks for a recompute', () => {
  it('asks the store nothing while its transaction is open, and has recomputed once by the time it returns', async () => {
    let returnedInside: unknown = 'unset';
    const outcome = await effect(async () => {
      expect(inTransaction()).toBe(true);
      returnedInside = await recomputeProject(projectId);
      await recomputeProject(projectId);
    });

    expect(outcome.status).toBe('EXECUTED');
    expect(calls.insideTransaction).toBe(0);
    // Deferred: the caller inside the transaction got no snapshots back.
    expect(returnedInside).toEqual([]);
    // ...and the recompute did run, after the commit and before the reply:
    // the document whose bytes are gone is now flagged.
    expect(calls.total).toBeGreaterThan(0);
    expect((await getDocument(documentId))?.fileMissing).toBe(true);
  });

  it('runs one recompute per project however many times the effect asked', async () => {
    await effect(async () => {
      await recomputeProject(projectId);
      await recomputeProject(projectId);
      await recomputeProject(projectId);
    });
    const once = calls.total;
    calls.total = 0;
    await recomputeProject(projectId);
    // Three requests inside the effect cost what one recompute costs.
    expect(once).toBe(calls.total);
  });

  it('runs none of it when the effect rolls back', async () => {
    await expect(
      effect(async () => {
        await recomputeProject(projectId);
        throw new Error('a transient problem');
      }),
    ).rejects.toThrow('a transient problem');
    expect(calls.total).toBe(0);
    expect((await getDocument(documentId))?.fileMissing).toBe(false);
  });

  it('still recomputes in place outside any effect', async () => {
    const snapshots = await recomputeProject(projectId);
    expect(snapshots.length).toBeGreaterThan(0);
    expect((await getDocument(documentId))?.fileMissing).toBe(true);
  });
});
