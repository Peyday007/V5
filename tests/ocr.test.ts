/**
 * OCR (final completion pass, spec section 8).
 *
 * These read real scanned PDFs — pictures of pages, with no text layer at all —
 * through the real local engine. A mocked adapter can prove the plumbing; only
 * a real scan can prove that Brain can read one, and that when it cannot, it
 * says so instead of reporting an empty document.
 *
 * The scans are committed under tests/fixtures/scanned/ and regenerated with
 * `npx tsx tests/fixtures/make-scans.ts`. Their content is invented.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { writeFakeExecutable } from './fixtures/fake-exec.ts';
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatResponse,
  ProviderStatus,
  ResearchResponse,
} from '../server/providers/types.ts';
import type { Document } from '../server/domain/types.ts';
import { importFile } from '../server/services/importer.ts';
import { getDocument, updateDocument } from '../server/repos/documents.ts';
import {
  createExtractionRun,
  getCurrentExtractionRun,
  listBlocks,
  listExtractionRuns,
} from '../server/repos/extraction.ts';
import { findExecutable, probeOcrRuntime } from '../server/services/documents/ocrRuntime.ts';
import { getOcrEngine, ocrStatus, setOcrEngine, LOW_CONFIDENCE } from '../server/services/documents/ocr.ts';
import { recoverInterruptedExtractions } from '../server/services/documents/extraction.ts';
import { enqueueExtraction, whenExtractionIdle } from '../server/services/documents/queue.ts';
import { THRESHOLDS } from '../server/services/documents/quality.ts';
import { resolveCitation, retrieveEvidence } from '../server/services/documents/retrieval.ts';
import { buildAuditContext } from '../server/services/audit/context.ts';
import { AuditFailure, runDynamicAudit } from '../server/services/audit/pipeline.ts';
import { computeLayerState } from '../server/services/stateEngine.ts';
import { listEventsByLayer } from '../server/repos/events.ts';

const SCANS = new URL('./fixtures/scanned/', import.meta.url);

function scan(name: string): Buffer {
  return fs.readFileSync(new URL(`${name}.pdf`, SCANS));
}

/**
 * Whether this machine can actually run OCR.
 *
 * Probed once, before any test touches the environment. Where it is absent the
 * positive cases are skipped with a printed reason rather than quietly passing —
 * a green suite that never ran the OCR is exactly the false confidence the rest
 * of this engine exists to prevent.
 */
const RUNTIME = probeOcrRuntime();
const withOcr = describe.skipIf(!RUNTIME.available);
if (!RUNTIME.available) {
  console.warn(
    `\n  [ocr.test] Skipping the live OCR cases: ${RUNTIME.reason}\n` +
      RUNTIME.install.map((step) => `  ${step}`).join('\n') +
      '\n',
  );
}

let fixture: TestProject;
let workDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  // The runtime is probed once and cached; clearing the engine re-probes it.
  setOcrEngine(null);
}

beforeEach(async () => {
  fixture = await freshProject();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ocrtest-'));
  setOcrEngine(null);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  setOcrEngine(null);
  fs.rmSync(workDir, { recursive: true, force: true });
  await teardown();
});

/** Import a scanned fixture and read it to completion. */
async function importScan(name: string, filename: string): Promise<Document> {
  const result = await importFile({
    projectId: fixture.project.id,
    originalFilename: filename,
    contents: scan(name),
  });
  expect(result.documentId).toBeTruthy();
  await whenExtractionIdle();
  return (await getDocument(result.documentId!))!;
}

// ---------------------------------------------------------------------------
// Capability detection and version reporting
// ---------------------------------------------------------------------------

describe('the local OCR runtime', () => {
  it('reports what it found, where, and at what version', () => {
    const status = ocrStatus();
    expect(status.available).toBe(RUNTIME.available);
    expect(status.dpi).toBeGreaterThanOrEqual(72);
    expect(status.language.length).toBeGreaterThan(0);
    expect(status.timeoutMs).toBeGreaterThan(0);

    if (RUNTIME.available) {
      // Version reporting is the capability check: a binary that cannot say what
      // it is has not been proved to work.
      expect(status.engineVersion).toMatch(/tesseract/i);
      expect(status.rendererVersion).toMatch(/pdfto(ppm|cairo)/i);
      expect(status.recognizerPath).toBeTruthy();
      expect(['env', 'path', 'install-location']).toContain(status.recognizerSource);
      expect(status.install).toEqual([]);
    } else {
      expect(status.install.length).toBeGreaterThan(0);
      expect(status.reason.length).toBeGreaterThan(0);
    }
  });

  it('can be switched off explicitly, and says so rather than looking broken', () => {
    setEnv('BRAIN_OCR', 'none');
    const status = ocrStatus();
    expect(status.available).toBe(false);
    expect(status.disabled).toBe(true);
    expect(status.reason).toMatch(/switched off/i);
    expect(getOcrEngine().name).toBe('none');
  });

  it('prefers an explicitly configured path over anything on the PATH', () => {
    const fake = writeFakeExecutable({
      directory: workDir,
      name: 'fake-tesseract',
      tool: 'tesseract',
      behaviour: 'ok',
      version: 'tesseract 4.2.1-fake',
    });
    setEnv('BRAIN_TESSERACT_PATH', fake.command);

    const runtime = probeOcrRuntime();
    expect(runtime.recognizer.source).toBe('env');
    expect(runtime.recognizer.command).toBe(fake.command);
    expect(runtime.recognizer.version).toBe('tesseract 4.2.1-fake');
  });

  it('says where it looked when a tool is nowhere to be found', () => {
    const probe = findExecutable({
      tool: 'nonexistent',
      names: ['brain-no-such-binary-anywhere'],
      envVar: 'BRAIN_NO_SUCH_VARIABLE',
    });

    expect(probe.command).toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.source).toBeNull();
    // It has to be able to say where it looked, or "not installed" is unarguable.
    expect(probe.searched.length).toBeGreaterThan(1);
    expect(probe.searched.some((entry) => entry.startsWith('PATH:'))).toBe(true);
  });

  it('treats an explicit path that does not work as an error, not a hint', () => {
    // Falling back to some other binary would mean the user configured one
    // engine and Brain silently used another.
    setEnv('BRAIN_TESSERACT_PATH', path.join(workDir, 'does-not-exist'));

    const runtime = probeOcrRuntime();
    expect(runtime.available).toBe(false);
    expect(runtime.recognizer.command).toBeNull();
    expect(runtime.recognizer.searched.join(' ')).toMatch(/not falling back/i);
    expect(runtime.reason).toMatch(/Tesseract/i);
    expect(runtime.install.join(' ')).toMatch(/install/i);
    expect(runtime.install.join(' ')).toMatch(/BRAIN_TESSERACT_PATH/);
  });
});

// ---------------------------------------------------------------------------
// Reading real scans
// ---------------------------------------------------------------------------

withOcr('a real scanned PDF', () => {
  it('is read page by page, with the engine and image recorded', async () => {
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('READY_WITH_WARNINGS');
    expect(run.pagesExpected).toBe(3);
    expect(run.pagesReadable).toBe(3);
    expect(run.pagesOcr).toBe(3);
    expect(run.coverageRatio).toBe(1);
    expect(run.characterCount).toBeGreaterThan(THRESHOLDS.minDocumentCharacters);

    // Which engine read it, and from which picture, is part of the evidence.
    expect(run.ocrEngine).toBe('tesseract-cli');
    expect(run.ocrEngineVersion).toMatch(/tesseract/i);
    expect(run.ocrRendererVersion).toMatch(/pdfto(ppm|cairo)/i);
    expect(run.ocrPages).toHaveLength(3);

    for (const record of run.ocrPages) {
      expect(record.ok).toBe(true);
      expect(record.imageHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.dpi).toBeGreaterThanOrEqual(72);
      expect(record.width).toBeGreaterThan(0);
      expect(record.height).toBeGreaterThan(0);
      expect(record.confidence).toBeGreaterThan(LOW_CONFIDENCE);
      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.characters).toBeGreaterThan(0);
    }
    // Each page is a different picture, so each has a different identity.
    expect(new Set(run.ocrPages.map((record) => record.imageHash)).size).toBe(3);

    const text = (await listBlocks(run.id))
      .map((block) => block.normalizedText)
      .join(' ');
    expect(text).toMatch(/custody/i);
    expect(text).toMatch(/assignment/i);
  }, 60_000);

  it('gives every recognised block a page, a box, a confidence and a warning', async () => {
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const blocks = await listBlocks((await getCurrentExtractionRun(document.id))!.id);

    expect(blocks.length).toBeGreaterThan(0);
    expect(new Set(blocks.map((block) => block.pageNumber))).toEqual(new Set([1, 2, 3]));
    for (const block of blocks) {
      expect(block.extractionMethod).toBe('OCR');
      expect(block.bbox).not.toBeNull();
      expect(block.bbox).toHaveLength(4);
      expect(block.confidence).toBeGreaterThan(0);
      expect(block.confidence).toBeLessThanOrEqual(1);
      // Recognition is never presented as transcription.
      expect(block.warnings.join(' ')).toMatch(/OCR/);
      expect(block.rawText.length).toBeGreaterThan(0);
    }
    // A scan of a report has a title on it, and the reader should see that.
    expect(blocks.some((block) => block.blockType === 'HEADING')).toBe(true);
  }, 60_000);

  it('reads a page the scanner fed in sideways', async () => {
    const document = await importScan('rotated', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.pagesOcr).toBe(1);
    expect(run.pagesReadable).toBe(1);
    const text = (await listBlocks(run.id)).map((block) => block.normalizedText).join(' ');
    expect(text).toMatch(/custody/i);
    expect(text).toMatch(/priority/i);
    // The rendered page is landscape, and the record says so.
    const record = run.ocrPages[0]!;
    expect(record.width).toBeGreaterThan(record.height!);
  }, 60_000);

  it('keeps the structure of a scanned page: heading, paragraphs and a list', async () => {
    const document = await importScan('structured-scan', 'Qualification Logic v1.pdf');
    const blocks = await listBlocks((await getCurrentExtractionRun(document.id))!.id);
    const types = blocks.map((block) => block.blockType);

    expect(types).toContain('HEADING');
    expect(types).toContain('LIST_ITEM');
    expect(blocks.find((block) => block.blockType === 'HEADING')!.normalizedText).toMatch(
      /qualification/i,
    );
  }, 60_000);
});

withOcr('a PDF that mixes native text and scans', () => {
  it('OCRs only the scanned page and labels each page by method', async () => {
    const document = await importScan('mixed-native-scanned', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.pagesExpected).toBe(3);
    expect(run.pagesReadable).toBe(3);
    // The cost is one page, not three: a readable page is never re-read merely
    // because a different page in the same document is a scan.
    expect(run.pagesOcr).toBe(1);
    expect(run.ocrPages.map((record) => record.page)).toEqual([2]);

    const byPage = new Map<number, Set<string>>();
    for (const block of await listBlocks(run.id)) {
      byPage.set(
        block.pageNumber,
        (byPage.get(block.pageNumber) ?? new Set()).add(block.extractionMethod),
      );
    }
    expect([...(byPage.get(1) ?? [])]).toEqual(['NATIVE']);
    expect([...(byPage.get(2) ?? [])]).toEqual(['OCR']);
    expect([...(byPage.get(3) ?? [])]).toEqual(['NATIVE']);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scans Brain must refuse
// ---------------------------------------------------------------------------

withOcr('a scan too poor to trust', () => {
  it('is BLOCKED, with the confidence that caused it stated', async () => {
    const document = await importScan('low-resolution', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    // It produced characters — that is exactly why the check matters. A document
    // must not become READY merely because OCR returned something.
    expect(run.characterCount).toBeGreaterThan(0);
    expect(run.status).toBe('BLOCKED');
    expect(run.pagesReadable).toBe(0);
    expect(run.ocrPages[0]!.confidence).toBeLessThan(THRESHOLDS.ocrConfidenceFloor);
    expect(run.blockedReason).toMatch(/confidence below/i);
    expect(run.blockedReason).toMatch(/rescan/i);
    expect(run.warnings.some((warning) => /low confidence/i.test(warning))).toBe(true);
    expect((await getDocument(document.id))!.extractionStatus).toBe('BLOCKED');
  }, 60_000);

  it('is BLOCKED when there is nothing on the page to read', async () => {
    setEnv('BRAIN_OCR_DPI', '150');
    const document = await importScan('unreadable-scan', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.pagesOcr).toBe(0);
    expect(run.pagesFailed).toEqual([1, 2]);
    expect(run.characterCount).toBe(0);
    // The attempt is still recorded: "we tried and found nothing" is different
    // from "we never looked".
    expect(run.ocrPages).toHaveLength(2);
    expect(run.ocrPages.every((record) => record.ok === false)).toBe(true);
    expect(run.ocrPages.every((record) => record.imageHash !== null)).toBe(true);
    expect(run.ocrPages[0]!.warnings.join(' ')).toMatch(/no text/i);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// When the runtime itself misbehaves
// ---------------------------------------------------------------------------

describe('when the OCR runtime cannot do its job', () => {
  /** Point Brain at fakes so the real adapter runs against a real failure. */
  function useFakes(input: {
    recognizer?: 'ok' | 'fail' | 'hang';
    renderer?: 'render' | 'fail' | 'empty';
  }): void {
    const recognizer = writeFakeExecutable({
      directory: workDir,
      name: 'fake-tesseract',
      tool: 'tesseract',
      behaviour: input.recognizer ?? 'ok',
      version: 'tesseract 5.0.0-fake',
    });
    const renderer = writeFakeExecutable({
      directory: workDir,
      name: 'fake-pdftoppm',
      tool: 'pdftoppm',
      // 'render' writes a real (tiny) PNG where poppler would, so the recogniser
      // failures downstream are reached the same way they would be in life.
      behaviour: input.renderer ?? 'render',
      version: 'pdftoppm version 24.0.0-fake',
    });
    setEnv('BRAIN_TESSERACT_PATH', recognizer.command);
    setEnv('BRAIN_PDF_RENDERER_PATH', renderer.command);
    setEnv('BRAIN_OCR_TIMEOUT_MS', '5000');
  }

  it('blocks the document when no OCR engine is installed at all', async () => {
    setEnv('BRAIN_TESSERACT_PATH', path.join(workDir, 'missing'));

    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.pagesOcr).toBe(0);
    // Recorded as attempted-and-unavailable, so the run names the pages nobody read.
    expect(run.ocrPages.map((record) => record.page)).toEqual([1, 2, 3]);
    expect(run.ocrPages.every((record) => record.ok === false)).toBe(true);
    expect(run.warnings.join(' ')).toMatch(/not installed/i);
    expect(await listBlocks(run.id)).toHaveLength(0);
  }, 60_000);

  it('blocks the document when the page renderer fails', async () => {
    useFakes({ renderer: 'fail' });
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.pagesOcr).toBe(0);
    expect(run.warnings.join(' ')).toMatch(/could not be rendered/i);
    expect(run.ocrPages.every((record) => record.ok === false)).toBe(true);
  }, 60_000);

  it('blocks the document when the renderer produces no image', async () => {
    useFakes({ renderer: 'empty' });
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.warnings.join(' ')).toMatch(/produced no image/i);
  }, 60_000);

  it('blocks the document when the recogniser exits non-zero', async () => {
    useFakes({ recognizer: 'fail' });
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.pagesOcr).toBe(0);
    expect(run.warnings.join(' ')).toMatch(/OCR failed/i);
    // The rendered page is still identified, so the failure is diagnosable.
    expect(run.ocrPages[0]!.imageHash).toBeTruthy();
  }, 60_000);

  it('gives up on a recogniser that never returns, and leaves a recoverable run', async () => {
    useFakes({ recognizer: 'hang' });
    setEnv('BRAIN_OCR_TIMEOUT_MS', '5000');

    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    const run = (await getCurrentExtractionRun(document.id))!;

    expect(run.status).toBe('BLOCKED');
    expect(run.warnings.join(' ')).toMatch(/timed out/i);
    // BLOCKED, not FAILED: the run finished with a verdict and can be reprocessed.
    expect(run.completedAt).toBeTruthy();
    expect(run.error).toBeNull();
  }, 90_000);

  it('never advances, audits or freezes a layer on a failed reading', async () => {
    useFakes({ renderer: 'fail' });
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');
    expect((await getCurrentExtractionRun(document.id))!.status).toBe('BLOCKED');

    // Registering the document is supposed to move state; the failed reading is
    // not, so what must be untouched is everything a verdict would have changed.
    const state = await computeLayerState(document.layerId!);
    expect(state.frozen).toBe(false);
    expect(state.latestAuditVerdict).toBeNull();
    expect(state.status).not.toBe('FROZEN');
    expect(state.status).not.toBe('SYNTHESIS_READY');
    expect(
      (await listEventsByLayer(document.layerId!)).some((event) => event.eventType.startsWith('LAYER_FROZEN')),
    ).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Lineage, recovery and audits
// ---------------------------------------------------------------------------

withOcr('an OCR reading', () => {
  it('is superseded, not overwritten, when the document is reprocessed', async () => {
    const document = await importScan('structured-scan', 'Qualification Logic v1.pdf');
    const first = (await getCurrentExtractionRun(document.id))!;
    expect(first.pagesOcr).toBe(1);

    const again = await enqueueExtraction(document.id, { force: true });
    expect(again.run.id).not.toBe(first.id);

    const history = await listExtractionRuns(document.id);
    expect(history).toHaveLength(2);
    expect(history.find((run) => run.id === first.id)!.supersededByRunId).toBe(again.run.id);
    // The old reading keeps its blocks and its provenance, so an audit recorded
    // against it still resolves to the text it actually read.
    expect((await listBlocks(first.id)).length).toBeGreaterThan(0);
    expect((await getCurrentExtractionRun(document.id))!.ocrPages).toHaveLength(1);
  }, 90_000);

  it('resolves a citation back to the page it was recognised from', async () => {
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');

    const retrieved = await retrieveEvidence({
      documentIds: [document.id],
      query: 'custody assignment claim priority',
    });
    expect(retrieved.unreadable).toHaveLength(0);
    expect(retrieved.passages.length).toBeGreaterThan(0);

    const passage = retrieved.passages[0]!;
    expect(passage.fromOcr).toBe(true);

    const resolved = (await resolveCitation(passage.chunkId))!;
    expect(resolved.document.id).toBe(document.id);
    expect(resolved.blocks.length).toBeGreaterThan(0);
    const pages = resolved.blocks.map((block) => block.pageNumber);
    expect(Math.min(...pages)).toBe(passage.pageStart);
    expect(Math.max(...pages)).toBe(passage.pageEnd);
    expect(resolved.blocks.map((block) => block.text).join(' ')).toMatch(/custody/i);
  }, 60_000);

  it('is marked INTERRUPTED, never ready, when the process dies mid-recognition', async () => {
    const document = await importScan('structured-scan', 'Qualification Logic v1.pdf');
    const run = await createExtractionRun({
      documentId: document.id,
      projectId: document.projectId,
      pipelineVersion: 'doc-understanding-1',
      status: 'OCR',
    });
    await updateDocument(document.id, { extractionStatus: 'OCR', extractionRunId: run.id });

    expect(await recoverInterruptedExtractions()).toBe(1);
    const recovered = (await getCurrentExtractionRun(document.id))!;
    expect(recovered.status).toBe('INTERRUPTED');
    expect(recovered.error).toMatch(/interrupted/i);
    expect((await getDocument(document.id))!.extractionStatus).toBe('INTERRUPTED');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// What an audit may and may not do with a scan
// ---------------------------------------------------------------------------

class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  async audit(request: AuditRequest): Promise<AuditResponse> {
    const pass = /^BRAIN AUDIT PASS: (\w+)/m.exec(request.prompt)?.[1] ?? 'JUDGE';
    const payload =
      pass === 'PRIMARY' || pass === 'EXTRACTION'
        ? {
            assignment_satisfied: 'YES',
            requirement_findings: [],
            structural_findings: [],
            boundary_findings: [],
            consistency_findings: [],
            candidate_gaps: [],
            notes: '',
          }
        : pass === 'ADVERSARIAL'
          ? { attacks: [], strongest_reason_not_to_advance: '' }
          : {
              verdict: 'PASS',
              summary: 'The scanned artifact says what it needed to say.',
              gap_classifications: [],
              required_patches: [],
              other_layer_handoffs: [],
              blocking_dependencies: [],
              synthesis_ready: false,
              freeze_ready: false,
              confidence: 0.8,
              foundational_gap_count: 0,
              targeted_research_runs_required: 0,
              next_action: 'Run World Model v1B.',
            };
    return { text: ['```json', JSON.stringify(payload), '```'].join('\n'), externalResponseId: null };
  }
  async chat(): Promise<ChatResponse> {
    throw new Error('not used');
  }
  async runResearch(): Promise<ResearchResponse> {
    throw new Error('not used');
  }
  getStatus(): ProviderStatus {
    return {
      name: this.name,
      available: true,
      reason: 'scripted for tests',
      model: null,
      capabilities: { chat: false, research: false, audit: true },
    };
  }
}

withOcr('an audit of a scanned document', () => {
  it('reads the recognised text, and the manifest says it was recognised', async () => {
    const document = await importScan('scanned-multipage', 'World Model v1.pdf');

    const context = await buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: document.layerId!,
      documentId: document.id,
    });
    const artifact = context.artifacts[0]!;
    expect(artifact.unavailableReason).toBeNull();
    expect(artifact.pagesOcr).toBe(3);
    expect(artifact.text).toMatch(/custody/i);
    expect(context.manifest.documents[0]!.pagesOcr).toBe(3);

    const outcome = await runDynamicAudit({
      mode: 'SINGLE_DOCUMENT',
      layerId: document.layerId!,
      documentId: document.id,
      provider: new ScriptedProvider(),
    });
    expect(outcome.audit.verdict).toBe('PASS');
    // The recorded manifest carries the recognition forward, so a verdict read
    // back next year still says the evidence was OCR rather than transcription.
    const manifest = outcome.audit.evidenceManifest as { documents: { pagesOcr: number }[] } | null;
    expect(manifest?.documents[0]?.pagesOcr).toBe(3);
  }, 90_000);

  it('is refused outright when the scan could not be read', async () => {
    setEnv('BRAIN_OCR_DPI', '150');
    const document = await importScan('unreadable-scan', 'World Model v1.pdf');
    expect((await getCurrentExtractionRun(document.id))!.status).toBe('BLOCKED');

    await expect(
      runDynamicAudit({
        mode: 'SINGLE_DOCUMENT',
        layerId: document.layerId!,
        documentId: document.id,
        provider: new ScriptedProvider(),
      }),
    ).rejects.toBeInstanceOf(AuditFailure);

    // Nothing was recorded, and the layer did not move.
    const state = await computeLayerState(document.layerId!);
    expect(state.latestAuditVerdict).toBeNull();
  }, 90_000);
});
