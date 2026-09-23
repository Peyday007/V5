/**
 * A judge submission costs a fixed number of statements, however large its
 * layer has grown.
 *
 * The defect this pins, measured rather than inferred: the deploy's own hosted
 * verification failed after the restart on `brain_submit_audit`, the JUDGE
 * role, with `canceling statement due to statement timeout` — the submission's
 * transaction had been open for nine minutes. Replaying that verification
 * locally over a copy of the same shape (one layer, 433 documents) and logging
 * every statement found 3,240 of them inside that one transaction, and 1,946
 * inside the synthesis filing before it:
 *
 * - `deriveLayer` asked, per present document, for that document's latest audit
 *   and its findings — only to compare the answer with null — and a judge
 *   submission derives the layer several times;
 * - `buildAuditContext` read every sibling document's extraction run and every
 *   block of it, for text the prompt never printed: a sibling is listed by
 *   name and availability only.
 *
 * Both grew by one round trip per document per pass, and the verification
 * project gains a document or two on every deploy, so the step got slower on
 * every release until the database gave up on it. Locally, after the change,
 * the same submission is 191 statements and the filing 197.
 *
 * The assertions are about the statements rather than the clock, so they hold
 * on any machine: adding documents to the layer must not add statements to the
 * two reads a judge submission makes, and what those reads *answer* — which
 * documents are unaudited, which siblings cannot be read and why — is exactly
 * what it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { extractDocument } from '../server/services/documents/extraction.ts';
import { buildAuditContext } from '../server/services/audit/context.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';
import { createAudit, documentIdsWithAudits } from '../server/repos/audits.ts';
import { getDb } from '../server/db/database.ts';
import type { Document } from '../server/domain/types.ts';

let fixture: TestProject;
let layerName = '';
let made = 0;

beforeEach(async () => {
  fixture = await freshProject();
  layerName = fixture.layers[0]!.name;
  made = 0;
});

afterEach(async () => {
  await teardown();
});

async function addReadable(): Promise<Document> {
  made += 1;
  const document = await addDocument(fixture, layerName, `v${made}`, {
    contents: [
      `${layerName} v${made}`,
      '',
      'This document sets out the architecture for its layer. It distinguishes the actors from',
      'the roles they occupy, the rights they hold from the objects those rights attach to, and',
      'the commitments they make from the obligations those commitments create.',
      '',
      'It describes how state changes over time: how a commitment becomes an obligation, how an',
      'obligation is discharged by performance, and how consideration settles between the',
      'parties. It represents uncertainty explicitly rather than converting it into fact.',
    ].join('\n'),
  });
  await extractDocument(document.id);
  return document;
}

/** Every statement the adapter is asked to run while `work` runs. */
async function statementsDuring(work: () => Promise<unknown>): Promise<number> {
  const db = getDb() as unknown as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
  const originals = { all: db.all, get: db.get, run: db.run };
  let count = 0;
  for (const method of ['all', 'get', 'run'] as const) {
    const original = originals[method];
    db[method] = (...args: unknown[]) => {
      count += 1;
      return original.apply(db, args);
    };
  }
  try {
    await work();
  } finally {
    Object.assign(db, originals);
  }
  return count;
}

async function judgeReads(subject: Document): Promise<{ context: number; recompute: number }> {
  const layer = await fixture.layerByName(layerName);
  const context = await statementsDuring(() =>
    buildAuditContext({ mode: 'SINGLE_DOCUMENT', layerId: layer.id, documentId: subject.id }),
  );
  const recompute = await statementsDuring(() => recomputeProject(fixture.project.id));
  return { context, recompute };
}

describe('a judge submission and the size of its layer', () => {
  it('adds no statements for another document in the layer', async () => {
    const subject = await addReadable();
    for (let i = 0; i < 4; i += 1) await addReadable();
    const small = await judgeReads(subject);

    for (let i = 0; i < 16; i += 1) await addReadable();
    const large = await judgeReads(subject);

    // Sixteen more documents. Per-document reads would add at least sixteen
    // statements to each; the fixed cost adds none.
    expect(large.context, `context: ${small.context} -> ${large.context}`).toBeLessThan(small.context + 8);
    expect(large.recompute, `recompute: ${small.recompute} -> ${large.recompute}`).toBeLessThan(
      small.recompute + 8,
    );
  });

  it('still says which siblings cannot be read, and why', async () => {
    const subject = await addReadable();
    const readable = await addReadable();
    made += 1;
    const noFile = await addDocument(fixture, layerName, `v${made}`, { withFile: false });
    made += 1;
    const unread = await addDocument(fixture, layerName, `v${made}`, { contents: 'never extracted' });

    const layer = await fixture.layerByName(layerName);
    const context = await buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: layer.id,
      documentId: subject.id,
    });
    const reason = (document: Document) =>
      context.siblings.find((sibling) => sibling.documentId === document.id)?.unavailableReason;

    expect(context.siblings).toHaveLength(3);
    expect(reason(readable)).toBeNull();
    expect(reason(noFile)).toMatch(/No file has been registered/);
    expect(reason(unread)).toMatch(/not been read yet/);
    // The artifact under audit is still read in full.
    expect(context.artifacts[0]!.text).toMatch(/sets out the architecture/);
  });

  it('answers which documents have been audited exactly as the per-document read did', async () => {
    const audited = await addReadable();
    const notAudited = await addReadable();
    const layer = await fixture.layerByName(layerName);
    await createAudit({
      projectId: fixture.project.id,
      layerId: layer.id,
      auditedDocumentId: audited.id,
      result: { verdict: 'PASS', summary: 'fine', synthesisRequired: false, freezeEligible: false } as never,
    } as never);

    const found = await documentIdsWithAudits([audited.id, notAudited.id, audited.id]);
    expect([...found]).toEqual([audited.id]);
    expect(await documentIdsWithAudits([])).toEqual(new Set());
  });
});
