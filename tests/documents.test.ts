/**
 * The document understanding engine (spec section 20).
 *
 * The premise of the whole pipeline is that an audit must be able to prove what
 * it read, so these tests are mostly about the difference between "the document
 * does not say this" and "I never read that part". Every fixture is generated
 * from known geometry (see tests/fixtures), which is what lets the assertions be
 * exact rather than approximate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { buildPdf, imageOnlyPage, prosePage, twoColumnPage } from './fixtures/pdf.ts';
import { buildDocx, bullet, heading, numbered, paragraph, table } from './fixtures/docx.ts';
import type { Document, DocumentFindingType } from '../server/domain/types.ts';
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatResponse,
  ProviderStatus,
  ResearchResponse,
} from '../server/providers/types.ts';
import { DATA_ROOT } from '../server/env.ts';
import { importFile } from '../server/services/importer.ts';
import { storeFile } from '../server/services/storage.ts';
import { createDocument, getDocument, updateDocument } from '../server/repos/documents.ts';
import { listEvents, listEventsByEntity } from '../server/repos/events.ts';
import {
  createExtractionRun,
  getCurrentExtractionRun,
  listBlocks,
  listChunks,
  listDocumentFindings,
  listExtractionRuns,
} from '../server/repos/extraction.ts';
import { buildNames } from '../server/domain/naming.ts';
import { versionSortKey, waveForVersion } from '../server/domain/version.ts';
import { detectFormat } from '../server/services/documents/formats.ts';
import { extractPdf, PdfUnreadableError } from '../server/services/documents/pdf.ts';
import {
  extractDocument,
  recoverInterruptedExtractions,
} from '../server/services/documents/extraction.ts';
import {
  enqueueExtraction,
  queueUnreadDocuments,
  whenExtractionIdle,
} from '../server/services/documents/queue.ts';
import { setOcrEngine, type OcrEngine, type OcrPageResult } from '../server/services/documents/ocr.ts';
import { normalizeBlockText } from '../server/services/documents/normalize.ts';
import { planChunks } from '../server/services/documents/chunker.ts';
import { THRESHOLDS } from '../server/services/documents/quality.ts';
import { readableText, resolveCitation, retrieveEvidence } from '../server/services/documents/retrieval.ts';
import {
  extractDocumentFindings,
  FindingsExtractionError,
} from '../server/services/documents/findings.ts';
import { buildAuditContext } from '../server/services/audit/context.ts';
import { recordAuditEvidence } from '../server/services/audit/evidence.ts';
import { listAuditEvidence } from '../server/repos/extraction.ts';
import { recordAudit } from '../server/services/auditEngine.ts';
import { computeLayerState } from '../server/services/stateEngine.ts';

let fixture: TestProject;

beforeEach(() => {
  fixture = freshProject();
  // Deterministic by default: OCR availability is a property of the machine, and
  // a test that passes only where tesseract happens to be installed is not a test.
  setOcrEngine(null);
  process.env['BRAIN_OCR'] = 'none';
});
afterEach(() => {
  setOcrEngine(null);
  delete process.env['BRAIN_OCR'];
  teardown();
});

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const BODY = [
  'Custody of a distressed asset transfers at the point of assignment rather than at the',
  'point of notice, and claim priority is fixed by the earlier of those two events. The',
  'distinction matters because every downstream consumer reads priority off the artefact',
  'instead of recomputing it, so a routing change must never be able to alter it.',
  'This layer names the participants and the artefacts they exchange, and stops there.',
];

const SECOND = [
  'An originator, a servicer, a custodian and a claimant are the four participants. Each',
  'holds rights against a specific object rather than against another participant, which is',
  'what allows an obligation to be discharged without renegotiating the whole chain.',
  'Nothing in this layer prescribes a decision rule; that belongs to Decision Routing Rules.',
];

const HEADER = 'DEAL DISPATCH / WORLD MODEL';

function multiPagePdf(pages = 4): Buffer {
  const headings = ['Overview', 'Participants', 'Artefacts', 'Boundaries', 'Open questions', 'Sources'];
  return buildPdf(
    Array.from({ length: pages }, (_value, index) =>
      prosePage(headings[index % headings.length] ?? `Section ${index + 1}`, [BODY, SECOND], {
        header: HEADER,
        footer: `World Model v1 - page ${index + 1}`,
      }),
    ),
  );
}

/** Import a real file the way the UI does, then read it to completion. */
async function importAndRead(
  originalFilename: string,
  contents: Buffer,
): Promise<{ document: Document; runId: string }> {
  const result = importFile({ projectId: fixture.project.id, originalFilename, contents });
  expect(result.documentId, `import of ${originalFilename} should register a document`).toBeTruthy();
  await whenExtractionIdle();
  const document = getDocument(result.documentId!)!;
  const run = getCurrentExtractionRun(document.id);
  expect(run, `${originalFilename} should have an extraction run`).not.toBeNull();
  return { document: getDocument(document.id)!, runId: run!.id };
}

function textOf(documentId: string): string {
  return readableText(documentId)
    .pages.flatMap((page) => page.blocks.map((block) => block.text))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 1. Normal text PDF with multiple pages
// ---------------------------------------------------------------------------

describe('a normal multi-page text PDF', () => {
  it('is read completely, page by page, with no warnings', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(4));

    expect(document.extractionStatus).toBe('READY');
    expect(document.detectedFormat).toBe('PDF');
    expect(document.pageCount).toBe(4);

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.pagesExpected).toBe(4);
    expect(run.pagesReadable).toBe(4);
    expect(run.pagesFailed).toEqual([]);
    expect(run.pagesOcr).toBe(0);
    expect(run.coverageRatio).toBe(1);
    expect(run.warnings).toEqual([]);
    expect(run.characterCount).toBeGreaterThan(THRESHOLDS.minDocumentCharacters);
    expect(run.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // Every page contributed blocks, and the headings survived as headings.
    const blocks = listBlocks(runId);
    expect(new Set(blocks.map((block) => block.pageNumber))).toEqual(new Set([1, 2, 3, 4]));
    expect(
      blocks.filter((block) => block.blockType === 'HEADING').map((block) => block.normalizedText),
    ).toEqual(['Overview', 'Participants', 'Artefacts', 'Boundaries']);
    expect(textOf(document.id)).toContain('claim priority is fixed by the earlier');
  });
});

// ---------------------------------------------------------------------------
// 2. Two-column PDF and repeated headers
// ---------------------------------------------------------------------------

describe('a two-column PDF with a repeated header', () => {
  const LEFT = [
    'Custody transfers at the point of',
    'assignment, not at the point of',
    'notice. The distinction matters',
    'because claim priority is fixed',
    'by the earlier of the two events.',
    'Nothing here decides routing.',
  ];
  const RIGHT = [
    'Claim priority is therefore a',
    'property of custody, and it is',
    'recorded on the artefact rather',
    'than inferred by a downstream',
    'consumer of that artefact.',
    'Routing reads it, it does not set it.',
  ];
  const columned = (): Buffer =>
    buildPdf([
      twoColumnPage(HEADER, LEFT, RIGHT),
      twoColumnPage(HEADER, LEFT, RIGHT),
      twoColumnPage(HEADER, LEFT, RIGHT),
    ]);

  it('reads each column in order instead of interleaving them', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', columned());
    const blocks = listBlocks(runId).filter((block) => block.pageNumber === 1);

    const body = blocks.filter((block) => block.blockType === 'PARAGRAPH');
    expect(body).toHaveLength(2);
    // The left column is one continuous passage, not every other line of two.
    expect(body[0]!.normalizedText).toBe(LEFT.join(' '));
    expect(body[1]!.normalizedText).toBe(RIGHT.join(' '));

    // The reading order is what a person would follow down the page.
    const flat = textOf(document.id);
    expect(flat.indexOf('Nothing here decides routing')).toBeLessThan(
      flat.indexOf('Claim priority is therefore'),
    );
  });

  it('marks the repeated header as furniture without deleting it', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', columned());

    const headers = listBlocks(runId).filter((block) => block.blockType === 'PAGE_HEADER');
    expect(headers).toHaveLength(3);
    expect(headers.every((block) => block.normalizedText === HEADER)).toBe(true);

    // Furniture is kept and labelled, but excluded from retrieval chunks.
    const chunkText = listChunks(runId)
      .map((chunk) => chunk.text)
      .join('\n');
    expect(chunkText).not.toContain(HEADER);
    expect(textOf(document.id)).toContain(HEADER);

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.warnings.some((warning) => /multi-column/i.test(warning))).toBe(true);
    expect(run.status).toBe('READY_WITH_WARNINGS');
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Scanned pages, and a PDF that mixes native text with OCR
// ---------------------------------------------------------------------------

/** An OCR engine that returns text the test chose, for pages the test expects. */
class FakeOcrEngine implements OcrEngine {
  readonly name = 'fake-ocr';
  readonly available = true;
  readonly reason = 'scripted for tests';
  readonly version = 'fake 1.0';
  readonly rendererVersion = 'fake renderer 1.0';
  readonly install: string[] = [];
  readonly requested: number[] = [];

  constructor(private readonly text: string) {}

  async recognizePages(_pdf: Buffer, pageNumbers: number[]): Promise<OcrPageResult[]> {
    this.requested.push(...pageNumbers);
    return pageNumbers.map((pageNumber) => ({
      pageNumber,
      text: `${this.text} (page ${pageNumber})`,
      confidence: null,
      warnings: [],
    }));
  }
}

const OCR_TEXT = [
  'Recovered from the scan: custody of a distressed asset transfers at the point of assignment',
  'rather than at the point of notice, and claim priority is fixed by the earlier of the two.',
  'The participants are an originator, a servicer, a custodian and a claimant.',
].join(' ');

describe('a scanned PDF', () => {
  it('is BLOCKED, not silently empty, when no OCR engine is available', async () => {
    const { document } = await importAndRead(
      'World Model v1.pdf',
      buildPdf([imageOnlyPage(), imageOnlyPage(), imageOnlyPage()]),
    );

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('BLOCKED');
    expect(run.pagesReadable).toBe(0);
    expect(run.pagesFailed).toEqual([1, 2, 3]);
    expect(run.blockedReason).toMatch(/not enough to audit/i);
    // The warning has to name the pages nobody read and say why, or a blocked
    // document is just an unexplained refusal.
    const scanned = run.warnings.find((warning) => /need OCR/i.test(warning));
    expect(scanned).toBeTruthy();
    expect(scanned).toMatch(/pages 1, 2, 3/);
    expect(scanned).toMatch(/reported unreadable/i);
    expect(document.extractionStatus).toBe('BLOCKED');
  });

  it('is read by OCR when an engine is available, and says so', async () => {
    const engine = new FakeOcrEngine(OCR_TEXT);
    setOcrEngine(engine);

    const { document, runId } = await importAndRead(
      'World Model v1.pdf',
      buildPdf([imageOnlyPage(), imageOnlyPage(), imageOnlyPage()]),
    );

    expect(engine.requested).toEqual([1, 2, 3]);
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('READY_WITH_WARNINGS');
    expect(run.pagesOcr).toBe(3);
    expect(run.pagesReadable).toBe(3);
    expect(run.coverageRatio).toBe(1);
    expect(run.warnings.some((warning) => /read by OCR/i.test(warning))).toBe(true);

    const blocks = listBlocks(runId);
    expect(blocks.every((block) => block.extractionMethod === 'OCR')).toBe(true);
    expect(blocks[0]!.warnings.join(' ')).toMatch(/recognition errors/i);
    expect(textOf(document.id)).toContain('Recovered from the scan');
  });
});

describe('a PDF mixing native text and scanned pages', () => {
  it('OCRs only the pages that need it and labels each page by method', async () => {
    const engine = new FakeOcrEngine(OCR_TEXT);
    setOcrEngine(engine);

    const pdf = buildPdf([
      prosePage('Overview', [BODY, SECOND], { header: HEADER }),
      imageOnlyPage(),
      prosePage('Boundaries', [BODY, SECOND], { header: HEADER }),
    ]);
    const { document, runId } = await importAndRead('World Model v1.pdf', pdf);

    // The cost of OCR is one page, not three.
    expect(engine.requested).toEqual([2]);

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.pagesExpected).toBe(3);
    expect(run.pagesReadable).toBe(3);
    expect(run.pagesOcr).toBe(1);
    expect(run.status).toBe('READY_WITH_WARNINGS');

    const byPage = new Map<number, Set<string>>();
    for (const block of listBlocks(runId)) {
      byPage.set(
        block.pageNumber,
        (byPage.get(block.pageNumber) ?? new Set()).add(block.extractionMethod),
      );
    }
    expect([...(byPage.get(1) ?? [])]).toEqual(['NATIVE']);
    expect([...(byPage.get(2) ?? [])]).toEqual(['OCR']);
    expect([...(byPage.get(3) ?? [])]).toEqual(['NATIVE']);
  });
});

// ---------------------------------------------------------------------------
// 5. Blank, corrupt, encrypted and unsupported files
// ---------------------------------------------------------------------------

describe('files Brain cannot read', () => {
  it('blocks a blank PDF and keeps the original', async () => {
    const { document } = await importAndRead('World Model v1.pdf', buildPdf([imageOnlyPage()]));
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('BLOCKED');
    expect(run.characterCount).toBe(0);
    expect(fs.existsSync(path.resolve(DATA_ROOT, document.filesystemPath!))).toBe(true);
  });

  it('blocks a corrupt PDF and says how to recover', async () => {
    const corrupt = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('this file was truncated by whatever produced it\n'.repeat(20)),
    ]);
    const { document } = await importAndRead('World Model v1.pdf', corrupt);
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedReason).toMatch(/could not be parsed/i);
    expect(run.blockedReason).toMatch(/re-export it/i);
    expect(listBlocks(run.id)).toHaveLength(0);
  });

  it('blocks an encrypted PDF and names the reason', async () => {
    const encrypted = buildPdf([prosePage('Overview', [BODY, SECOND])], { encrypted: true });
    await expect(extractPdf(encrypted)).rejects.toBeInstanceOf(PdfUnreadableError);

    const { document } = await importAndRead('World Model v1.pdf', encrypted);
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedReason).toMatch(/password-protected or encrypted/i);
    expect(run.blockedReason).toMatch(/unprotected copy/i);
  });

  it('blocks an unsupported format without pretending to have read it', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512),
    ]);
    expect(detectFormat('World Model v1.png', png).format).toBe('UNSUPPORTED');

    const { document } = await importAndRead('World Model v1.png', png);
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('BLOCKED');
    expect(run.detectedFormat).toBe('UNSUPPORTED');
    expect(run.blockedReason).toMatch(/cannot read this file format/i);
    expect(fs.existsSync(path.resolve(DATA_ROOT, document.filesystemPath!))).toBe(true);
  });

  it('reports a file whose contents contradict its extension', async () => {
    // A PDF saved with a .txt name: the bytes decide, and the mismatch is said aloud.
    const { document } = await importAndRead('World Model v1.txt', multiPagePdf(2));
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.detectedFormat).toBe('PDF');
    expect(run.warnings.some((warning) => /extension does not match/i.test(warning))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. DOCX headings, lists and tables
// ---------------------------------------------------------------------------

const DOCX_BODY = [
  heading(1, 'Monetization Logic'),
  paragraph(
    'This layer owns the pricing surfaces and the conditions under which each one applies. ' +
      'It does not own the decision to route a deal, and it does not own qualification.',
  ),
  heading(2, 'Surfaces'),
  bullet('Subscription tier, billed monthly against seat count.'),
  bullet('Per-deal success fee, billed on close and capped by the custody agreement.'),
  numbered('Establish the surface before pricing it.'),
  numbered('Price the surface only where the qualification layer admits the deal.'),
  table([
    ['Surface', 'Owner', 'Depends on'],
    ['Subscription', 'Monetization Logic', 'World Model'],
    ['Success fee', 'Monetization Logic', 'Decision Routing Rules'],
  ]),
  paragraph('Figure 1 shows the pricing surface and the inputs it reads.'),
];

describe('a DOCX', () => {
  it('keeps headings, lists, tables and captions as distinct blocks', async () => {
    const { document, runId } = await importAndRead(
      'Monetization Logic v1.docx',
      buildDocx(DOCX_BODY),
    );

    expect(document.detectedFormat).toBe('DOCX');
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('READY');
    expect(run.warnings).toEqual([]);

    const blocks = listBlocks(runId);
    const types = blocks.map((block) => block.blockType);
    expect(types).toContain('HEADING');
    expect(types).toContain('LIST_ITEM');
    expect(types).toContain('TABLE');
    expect(types).toContain('CAPTION');
    expect(
      blocks.filter((block) => block.blockType === 'HEADING').map((block) => block.normalizedText),
    ).toEqual(['Monetization Logic', 'Surfaces']);

    // Table rows survive as rows, with the cell boundaries still legible.
    const rows = blocks.filter((block) => block.blockType === 'TABLE');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.normalizedText).toBe('Subscription | Monetization Logic | World Model');
    expect(blocks.every((block) => block.pageNumber === 1)).toBe(true);
  });

  it('surfaces what the DOCX reader could not convert instead of discarding it', async () => {
    const { document } = await importAndRead(
      'Monetization Logic v1.docx',
      buildDocx(DOCX_BODY, { omitStyles: true }),
    );
    const run = getCurrentExtractionRun(document.id)!;
    expect(run.status).toBe('READY_WITH_WARNINGS');
    expect(run.warnings.some((warning) => warning.startsWith('DOCX:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. TXT, Markdown and pasted text
// ---------------------------------------------------------------------------

const MARKDOWN = [
  '# Qualification Logic',
  '',
  'A deal qualifies when custody is established and priority is recorded on the artefact.',
  'Neither condition is sufficient on its own, and the order in which they are met does not',
  'matter for qualification, only for routing.',
  '',
  '## Conditions',
  '',
  '- Custody is established by assignment.',
  '- Priority is recorded, not inferred.',
  '',
  '```',
  'qualifies(deal) := custody(deal) AND recorded(priority(deal))',
  '```',
  '',
  'Anything the rule does not admit is an open question for the routing layer.',
].join('\n');

describe('text formats', () => {
  it('reads plain text as one page of paragraphs', async () => {
    const plain = [BODY.join(' '), '', SECOND.join(' ')].join('\n');
    const { document, runId } = await importAndRead('Qualification Logic v1.txt', Buffer.from(plain));

    expect(document.detectedFormat).toBe('TEXT');
    expect(getCurrentExtractionRun(document.id)!.status).toBe('READY');
    const blocks = listBlocks(runId);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.blockType === 'PARAGRAPH')).toBe(true);
    expect(blocks.every((block) => block.extractionMethod === 'TEXT')).toBe(true);
  });

  it('keeps Markdown structure: headings, list items and code verbatim', async () => {
    const { document, runId } = await importAndRead(
      'Qualification Logic v1.md',
      Buffer.from(MARKDOWN),
    );

    expect(document.detectedFormat).toBe('MARKDOWN');
    const blocks = listBlocks(runId);
    expect(
      blocks.filter((block) => block.blockType === 'HEADING').map((block) => block.normalizedText),
    ).toEqual(['Qualification Logic', 'Conditions']);
    expect(blocks.filter((block) => block.blockType === 'LIST_ITEM')).toHaveLength(2);

    const code = blocks.find((block) => block.blockType === 'CODE');
    expect(code?.rawText).toBe('qualifies(deal) := custody(deal) AND recorded(priority(deal))');

    // The heading path travels with the chunk, so a citation knows its section.
    const chunk = listChunks(runId)[0];
    expect(chunk?.headingPath).toEqual(['Qualification Logic']);
  });

  it('treats pasted text exactly like an uploaded file', async () => {
    const layer = fixture.layerByName('Qualification Logic');
    const names = buildNames(layer.name, 'v1');
    const stored = storeFile({
      projectSlug: fixture.project.slug,
      layerSlug: layer.slug,
      filename: names.filename,
      contents: Buffer.from([BODY.join(' '), '', SECOND.join(' ')].join('\n')),
    });
    const document = createDocument({
      projectId: fixture.project.id,
      layerId: layer.id,
      canonicalName: names.canonicalName,
      version: 'v1',
      versionSort: versionSortKey('v1'),
      wave: waveForVersion('v1', fixture.project.versionPolicy),
      documentType: 'FOUNDATION',
      status: 'COMPLETE',
      filename: names.filename,
      filesystemPath: stored.relativePath,
      fileSize: stored.size,
      fileHash: stored.hash,
      conversationTitle: names.conversationTitle,
      origin: 'PASTED',
      importedAt: new Date().toISOString(),
    });

    const result = await extractDocument(document.id);
    expect(result.quality.status).toBe('READY');
    // Same identity, same blocks, same quality record as any other import.
    expect(result.run.sourceHash).toBe(stored.hash);
    expect(listBlocks(result.run.id).length).toBeGreaterThan(0);
    expect(listChunks(result.run.id).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Duplicate import and changed-version import
// ---------------------------------------------------------------------------

describe('re-importing', () => {
  it('recognises identical bytes and does not create a second document', async () => {
    const pdf = multiPagePdf(3);
    const first = await importAndRead('World Model v1.pdf', pdf);

    const again = importFile({
      projectId: fixture.project.id,
      originalFilename: 'World Model v1 (1).pdf',
      contents: pdf,
    });
    await whenExtractionIdle();

    expect(again.duplicateOfDocumentId).toBe(first.document.id);
    expect(again.registered).toBe(false);
    expect(again.documentId).toBe(first.document.id);
    // One reading of one file: the extraction is not repeated either.
    expect(listExtractionRuns(first.document.id)).toHaveLength(1);
  });

  it('reads a new version as its own document, leaving the old reading intact', async () => {
    const first = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    const second = await importAndRead('World Model v1B.pdf', multiPagePdf(5));

    expect(second.document.id).not.toBe(first.document.id);
    expect(getCurrentExtractionRun(first.document.id)!.pagesExpected).toBe(3);
    expect(getCurrentExtractionRun(second.document.id)!.pagesExpected).toBe(5);
    expect(getCurrentExtractionRun(first.document.id)!.id).toBe(first.runId);
  });

  it('supersedes the previous reading on reprocess without destroying it', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    const reprocessed = await enqueueExtraction(document.id, { force: true });

    expect(reprocessed.run.id).not.toBe(runId);
    const history = listExtractionRuns(document.id);
    expect(history).toHaveLength(2);
    const previous = history.find((run) => run.id === runId)!;
    expect(previous.supersededByRunId).toBe(reprocessed.run.id);
    // The superseded run keeps its blocks, so an old audit still resolves.
    expect(listBlocks(runId).length).toBeGreaterThan(0);
    expect(getCurrentExtractionRun(document.id)!.id).toBe(reprocessed.run.id);
  });
});

// ---------------------------------------------------------------------------
// 9. Page boundaries and source anchors
// ---------------------------------------------------------------------------

describe('provenance', () => {
  it('keeps page boundaries and character offsets on every block', async () => {
    const { runId } = await importAndRead('World Model v1.pdf', multiPagePdf(4));
    const blocks = listBlocks(runId);

    // Block indexes are dense and ordered, and pages never go backwards.
    expect(blocks.map((block) => block.blockIndex)).toEqual(blocks.map((_block, index) => index));
    for (const [index, block] of blocks.entries()) {
      expect(block.charEnd - block.charStart).toBe(block.normalizedText.length);
      if (index > 0) {
        const previous = blocks[index - 1]!;
        expect(block.charStart).toBeGreaterThanOrEqual(previous.charEnd);
        expect(block.pageNumber).toBeGreaterThanOrEqual(previous.pageNumber);
      }
      expect(block.contentHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('gives every chunk a page range and block range that match its blocks', async () => {
    const { runId } = await importAndRead('World Model v1.pdf', multiPagePdf(4));
    const blocks = listBlocks(runId);

    for (const chunk of listChunks(runId)) {
      const members = blocks.filter(
        (block) => block.blockIndex >= chunk.blockStart && block.blockIndex <= chunk.blockEnd,
      );
      expect(members.length).toBeGreaterThan(0);
      expect(chunk.pageStart).toBe(Math.min(...members.map((block) => block.pageNumber)));
      expect(chunk.pageEnd).toBe(Math.max(...members.map((block) => block.pageNumber)));
      // Everything in the chunk beyond the carried overlap really is in the source.
      expect(chunk.text.slice(chunk.overlapPrev)).toContain(members.at(-1)!.normalizedText);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Normalization keeps the raw text
// ---------------------------------------------------------------------------

describe('normalization', () => {
  it('cleans extraction artifacts and reports what it changed', () => {
    const raw = 'The interme­di- ation ﻿layer deﬁnes  custody rules.';
    const result = normalizeBlockText(raw);

    expect(result.text).toBe('The intermediation layer defines custody rules.');
    expect(result.notes).toEqual(
      expect.arrayContaining([
        'removed zero-width characters',
        'rejoined hyphenated line breaks',
        'removed soft hyphens',
        'expanded ligatures',
        'collapsed whitespace',
      ]),
    );
  });

  it('never rewrites a claim, only whitespace and glyphs', () => {
    const claim = 'Priority may be recorded; it is not always inferred, and never assumed.';
    expect(normalizeBlockText(claim).text).toBe(claim);
    expect(normalizeBlockText(claim).notes).toEqual([]);
  });

  it('stores the raw text beside the normalized text on every block', async () => {
    const source = [
      'Deﬁnitions',
      '',
      'The custody rule is deﬁned by assignment, not by notice. ' +
        'Priority follows custody, and every consumer reads it off the artefact. '.repeat(4),
    ].join('\n');
    const { runId } = await importAndRead('World Model v1.txt', Buffer.from(source));

    const blocks = listBlocks(runId);
    const touched = blocks.filter((block) => block.rawText !== block.normalizedText);
    expect(touched.length, 'the fixture should contain something worth normalizing').toBe(2);

    const body = touched.find((block) => block.normalizedText.includes('assignment'))!;
    // The raw text is the evidence and survives untouched; the normalized text is
    // what the auditor reads, and the difference between them is itemised.
    expect(body.rawText).toContain('ﬁ');
    expect(body.normalizedText).not.toContain('ﬁ');
    expect(body.normalizedText).toContain('defined by assignment');
    expect(body.warnings.join(' ')).toMatch(/normalized: .*expanded ligatures/);
  });
});

// ---------------------------------------------------------------------------
// 11. Low coverage blocks the document
// ---------------------------------------------------------------------------

describe('the extraction quality gate', () => {
  it('blocks a document whose pages mostly could not be read', async () => {
    // Three readable pages and seven blank ones: 30% coverage against an 80% bar.
    const pages = [
      prosePage('Overview', [BODY, SECOND]),
      prosePage('Participants', [BODY, SECOND]),
      prosePage('Artefacts', [BODY, SECOND]),
      ...Array.from({ length: 7 }, () => imageOnlyPage()),
    ];
    const { document } = await importAndRead('World Model v1.pdf', buildPdf(pages));

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.pagesReadable).toBe(3);
    expect(run.pagesExpected).toBe(10);
    expect(run.characterCount).toBeGreaterThan(THRESHOLDS.minDocumentCharacters);
    expect(run.coverageRatio).toBeCloseTo(0.3, 5);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedReason).toMatch(/Only 3 of 10 pages could be read/);
    expect(run.pagesFailed).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('refuses to let a blocked document be used as audit evidence', async () => {
    const { document } = await importAndRead('World Model v1.pdf', buildPdf([imageOnlyPage()]));
    const context = buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: document.layerId!,
      documentId: document.id,
    });

    const artifact = context.artifacts[0]!;
    expect(artifact.text).toBe('');
    expect(artifact.unavailableReason).toBeTruthy();
    expect(context.manifest.complete).toBe(false);

    // And retrieval says "not read", not "not present".
    const retrieved = retrieveEvidence({ documentIds: [document.id], query: 'custody priority' });
    expect(retrieved.passages).toHaveLength(0);
    expect(retrieved.searched).toHaveLength(0);
    expect(retrieved.unreadable[0]?.documentId).toBe(document.id);
  });
});

// ---------------------------------------------------------------------------
// 12. Large documents are staged rather than truncated in silence
// ---------------------------------------------------------------------------

describe('a large document', () => {
  it('is chunked with overlap, and the audit context reports the staging', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(40));

    const run = getCurrentExtractionRun(document.id)!;
    expect(run.pagesExpected).toBe(40);
    expect(run.pagesReadable).toBe(40);

    const chunks = listChunks(runId);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_chunk, index) => index));
    expect(chunks[0]!.overlapPrev).toBe(0);
    expect(chunks[1]!.overlapPrev).toBeGreaterThan(0);

    // Chunks tile the content blocks: nothing falls between two of them.
    const content = listBlocks(runId).filter(
      (block) => block.blockType !== 'PAGE_HEADER' && block.blockType !== 'PAGE_FOOTER',
    );
    expect(chunks[0]!.blockStart).toBe(content[0]!.blockIndex);
    expect(chunks.at(-1)!.blockEnd).toBe(content.at(-1)!.blockIndex);
    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;
      const previousEnd = chunks[index - 1]!.blockEnd;
      const next = content.find((block) => block.blockIndex > previousEnd);
      expect(chunk.blockStart).toBe(next!.blockIndex);
    }

    const context = buildAuditContext({
      mode: 'SINGLE_DOCUMENT',
      layerId: document.layerId!,
      documentId: document.id,
      contentBudget: 8_000,
    });
    expect(context.requiresStagedExtraction).toBe(true);
    expect(context.artifacts[0]!.truncated).toBe(true);
    expect(context.artifacts[0]!.fullLength).toBeGreaterThan(context.artifacts[0]!.text.length);
    // Truncation is stated on the manifest, never hidden.
    expect(context.manifest.documents[0]!.truncated).toBe(true);
  });

  it('never splits a block, even one larger than the chunk target', async () => {
    const long = 'Custody transfers at the point of assignment rather than notice. '.repeat(200);
    const { runId } = await importAndRead('World Model v1.txt', Buffer.from(long));

    const blocks = listBlocks(runId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.normalizedText.length).toBeGreaterThan(6_000);
    const chunks = listChunks(runId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain(blocks[0]!.normalizedText);
  });

  it('starts a chunk at a heading once the current one has substance', () => {
    const blocks = Array.from({ length: 8 }, (_value, index) => ({
      id: `blk-${index}`,
      extractionRunId: 'run',
      documentId: 'doc',
      pageNumber: index + 1,
      blockIndex: index,
      blockType: index % 4 === 0 ? ('HEADING' as const) : ('PARAGRAPH' as const),
      rawText: '',
      normalizedText: index % 4 === 0 ? `Section ${index}` : 'x'.repeat(1_200),
      charStart: 0,
      charEnd: 0,
      extractionMethod: 'NATIVE' as const,
      confidence: null,
      warnings: [],
      contentHash: '',
      bbox: null,
      createdAt: '',
    }));

    const chunks = planChunks(blocks, { maxChars: 3_000, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.headingPath).toEqual(['Section 0']);
    expect(chunks.at(-1)!.headingPath).toEqual(['Section 4']);
  });
});

// ---------------------------------------------------------------------------
// 13. Structured findings, including provider failure
// ---------------------------------------------------------------------------

class FindingsProvider implements AIProvider {
  readonly name = 'scripted-findings';
  calls = 0;

  constructor(
    private readonly replies: (string | Error)[],
    private readonly ready = true,
  ) {}

  async audit(_request: AuditRequest): Promise<AuditResponse> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    if (reply instanceof Error) throw reply;
    return { text: reply ?? '', externalResponseId: null };
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
      available: this.ready,
      reason: this.ready ? 'scripted for tests' : 'no credential is configured',
      model: null,
      capabilities: { chat: false, research: false, audit: true },
    };
  }
}

function findingsReply(
  entries: { type: DocumentFindingType; content: string; quote: string }[],
): string {
  return ['```json', JSON.stringify({ findings: entries }), '```'].join('\n');
}

describe('structured findings', () => {
  it('records findings anchored to the page the quote actually came from', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(2));
    const provider = new FindingsProvider([
      findingsReply([
        {
          type: 'CLAIM',
          content: 'Custody transfers on assignment, not on notice.',
          quote: 'Custody of a distressed asset transfers at the point of assignment',
        },
        {
          type: 'EXCLUSION',
          content: 'Decision rules are out of scope for this layer.',
          quote: 'Nothing in this layer prescribes a decision rule',
        },
      ]),
    ]);

    const result = await extractDocumentFindings({ documentId: document.id, provider });

    expect(result.rejected).toHaveLength(0);
    expect(result.findings.map((finding) => finding.findingType).sort()).toEqual([
      'CLAIM',
      'EXCLUSION',
    ]);
    for (const finding of result.findings) {
      expect(finding.evidencePage).not.toBeNull();
      expect(finding.chunkId).toBeTruthy();
      expect(finding.source).toBe('scripted-findings');
      // The anchor is a fact about the extraction, checkable against the blocks.
      const block = listBlocks(runId).find(
        (entry) =>
          entry.pageNumber === finding.evidencePage &&
          entry.normalizedText.includes(finding.evidenceQuote),
      );
      expect(block, `${finding.evidenceQuote} should be on page ${finding.evidencePage}`).toBeTruthy();
    }
  });

  it('discards a finding whose quote is not in the document', async () => {
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(1));
    const provider = new FindingsProvider([
      findingsReply([
        {
          type: 'CLAIM',
          content: 'The layer defines a settlement window of thirty days.',
          quote: 'settlement must complete within thirty days of assignment',
        },
        {
          type: 'ACTOR',
          content: 'An originator is one of the four participants.',
          quote: 'An originator, a servicer, a custodian and a claimant',
        },
      ]),
    ]);

    const result = await extractDocumentFindings({ documentId: document.id, provider });

    expect(result.findings.map((finding) => finding.findingType)).toEqual(['ACTOR']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toMatch(/no evidence/i);
  });

  it('records nothing when the provider fails partway through', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(40));
    expect(listChunks(runId).length).toBeGreaterThan(1);

    const provider = new FindingsProvider([
      findingsReply([
        {
          type: 'CLAIM',
          content: 'Custody transfers on assignment.',
          quote: 'Custody of a distressed asset transfers at the point of assignment',
        },
      ]),
      new Error('provider connection reset'),
    ]);

    const before = getCurrentExtractionRun(document.id)!;
    await expect(extractDocumentFindings({ documentId: document.id, provider })).rejects.toThrow(
      /provider connection reset/,
    );

    // Nothing recorded, nothing moved.
    expect(listDocumentFindings(runId)).toHaveLength(0);
    const after = getCurrentExtractionRun(document.id)!;
    expect(after.id).toBe(before.id);
    expect(after.status).toBe(before.status);
    expect(getDocument(document.id)!.extractionStatus).toBe('READY');
    expect(
      listEventsByEntity('DOCUMENT', document.id).some(
        (event) => event.eventType === 'DOCUMENT_INDEXED',
      ),
    ).toBe(false);
  });

  it('records nothing when the model returns something that is not a finding list', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(1));
    const provider = new FindingsProvider(['I read the document and it looks fine to me.']);

    await expect(
      extractDocumentFindings({ documentId: document.id, provider }),
    ).rejects.toBeInstanceOf(FindingsExtractionError);
    expect(listDocumentFindings(runId)).toHaveLength(0);
  });

  it('rejects an invented finding type rather than guessing the closest one', async () => {
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(1));
    const provider = new FindingsProvider([
      JSON.stringify({
        findings: [
          {
            type: 'IMPORTANT_CLAIM',
            content: 'Custody transfers on assignment.',
            quote: 'Custody of a distressed',
          },
        ],
      }),
    ]);

    await expect(extractDocumentFindings({ documentId: document.id, provider })).rejects.toThrow(
      /not one of/i,
    );
  });

  it('will not index a document from the mock provider', async () => {
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(1));
    await expect(
      extractDocumentFindings({ documentId: document.id, providerName: 'mock' }),
    ).rejects.toThrow(/invented rather than/i);
  });

  it('will not index a document it could not read', async () => {
    const { document } = await importAndRead('World Model v1.pdf', buildPdf([imageOnlyPage()]));
    const provider = new FindingsProvider([findingsReply([])]);
    await expect(extractDocumentFindings({ documentId: document.id, provider })).rejects.toThrow(
      /not readable/i,
    );
    expect(provider.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Restart and recovery
// ---------------------------------------------------------------------------

describe('a restart during extraction', () => {
  it('marks the interrupted run INTERRUPTED rather than leaving it apparently ready', async () => {
    const document = addDocument(fixture, 'World Model', 'v1', { contents: BODY.join(' ') });
    const run = createExtractionRun({
      documentId: document.id,
      projectId: document.projectId,
      pipelineVersion: 'doc-understanding-1',
      status: 'EXTRACTING',
    });
    updateDocument(document.id, { extractionStatus: 'EXTRACTING', extractionRunId: run.id });

    expect(recoverInterruptedExtractions()).toBe(1);

    const recovered = getCurrentExtractionRun(document.id)!;
    expect(recovered.status).toBe('INTERRUPTED');
    expect(recovered.error).toMatch(/interrupted/i);
    expect(recovered.completedAt).toBeTruthy();
    expect(getDocument(document.id)!.extractionStatus).toBe('INTERRUPTED');

    // And it is not treated as evidence.
    const retrieved = retrieveEvidence({ documentIds: [document.id], query: 'custody' });
    expect(retrieved.unreadable).toHaveLength(1);
  });

  it('re-reads interrupted and never-read documents at boot', async () => {
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    updateDocument(document.id, { extractionStatus: 'INTERRUPTED' });

    expect(queueUnreadDocuments()).toBe(1);
    await whenExtractionIdle();

    expect(getDocument(document.id)!.extractionStatus).toBe('READY');
    expect(getCurrentExtractionRun(document.id)!.pagesReadable).toBe(3);
  });

  it('does not re-read a document whose bytes and pipeline version are unchanged', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    const again = await extractDocument(document.id);
    expect(again.run.id).toBe(runId);
    expect(listExtractionRuns(document.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 15-17. Packets: blocked siblings, contradictions, superseded versions
// ---------------------------------------------------------------------------

describe('a layer packet', () => {
  it('refuses to be audited when one member could not be read', async () => {
    const readable = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    const blocked = await importAndRead('World Model v1B.pdf', buildPdf([imageOnlyPage()]));

    const context = buildAuditContext({ mode: 'LAYER_PACKET', layerId: readable.document.layerId! });
    expect(context.artifacts).toHaveLength(2);
    expect(context.manifest.documents).toHaveLength(2);
    expect(context.manifest.complete).toBe(false);
    expect(context.manifest.unreadable.map((entry) => entry.documentId)).toEqual([
      blocked.document.id,
    ]);
    expect(context.manifest.unreadable[0]!.unavailableReason).toMatch(/not enough to audit/i);

    // The readable sibling is still fully accounted for.
    const good = context.manifest.documents.find(
      (entry) => entry.documentId === readable.document.id,
    )!;
    expect(good.pages).toBe(3);
    expect(good.characters).toBeGreaterThan(0);
  });

  it('shows contradictory siblings side by side rather than picking one', async () => {
    const claim = (statement: string): Buffer =>
      Buffer.from(['Custody and priority', '', statement, '', SECOND.join(' ')].join('\n'));

    const first = await importAndRead(
      'World Model v1.txt',
      claim('Claim priority is fixed at the point of assignment, before any notice is given.'),
    );
    const second = await importAndRead(
      'World Model v1B.txt',
      claim('Claim priority is fixed at the point of notice, and assignment alone does not fix it.'),
    );

    const retrieved = retrieveEvidence({
      documentIds: [first.document.id, second.document.id],
      query: 'when is claim priority fixed',
    });
    expect(retrieved.searched).toHaveLength(2);
    expect(new Set(retrieved.passages.map((passage) => passage.documentId))).toEqual(
      new Set([first.document.id, second.document.id]),
    );
    expect(retrieved.passages.some((passage) => passage.quote.includes('before any notice'))).toBe(
      true,
    );
    expect(
      retrieved.passages.some((passage) => passage.quote.includes('assignment alone does not fix it')),
    ).toBe(true);

    // Both are in the packet, so the auditor sees the conflict instead of one side.
    const context = buildAuditContext({ mode: 'LAYER_PACKET', layerId: first.document.layerId! });
    expect(context.artifacts).toHaveLength(2);
    expect(context.artifacts.map((artifact) => artifact.text).join('\n')).toContain(
      'does not fix it',
    );
  });

  it('excludes a superseded version from the packet but names it as provenance', async () => {
    const original = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    // Re-importing the same version with different bytes supersedes the first.
    const replacement = importFile({
      projectId: fixture.project.id,
      originalFilename: 'World Model v1.pdf',
      contents: multiPagePdf(5),
    });
    await whenExtractionIdle();

    expect(getDocument(original.document.id)!.status).toBe('SUPERSEDED');
    const context = buildAuditContext({ mode: 'LAYER_PACKET', layerId: original.document.layerId! });

    expect(context.artifacts.map((artifact) => artifact.documentId)).toEqual([
      replacement.documentId,
    ]);
    expect(context.manifest.documents).toHaveLength(1);
    expect(context.manifest.excluded).toHaveLength(1);
    expect(context.manifest.excluded[0]!.reason).toMatch(/superseded/i);
    expect(context.manifest.complete).toBe(true);

    // The superseded document keeps its file and its reading.
    const superseded = getDocument(original.document.id)!;
    expect(fs.existsSync(path.resolve(DATA_ROOT, superseded.filesystemPath!))).toBe(true);
    expect(getCurrentExtractionRun(superseded.id)!.status).toBe('READY');
  });
});

// ---------------------------------------------------------------------------
// 18. A citation resolves to the passage it rests on
// ---------------------------------------------------------------------------

describe('evidence citations', () => {
  it('round-trips from a retrieved passage to the raw source blocks', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(4));

    const retrieved = retrieveEvidence({
      documentIds: [document.id],
      query: 'custody assignment claim priority',
    });
    expect(retrieved.passages.length).toBeGreaterThan(0);

    const passage = retrieved.passages[0]!;
    expect(passage.extractionRunId).toBe(runId);
    expect(passage.documentLabel).toBe(document.canonicalName);
    expect(passage.quote).toMatch(/custody/i);

    const resolved = resolveCitation(passage.chunkId)!;
    expect(resolved.document.id).toBe(document.id);
    expect(resolved.run!.id).toBe(runId);
    expect(resolved.blocks.length).toBeGreaterThan(0);
    // The citation resolves to real source text, on the pages the passage named.
    const pages = resolved.blocks.map((block) => block.pageNumber);
    expect(Math.min(...pages)).toBe(passage.pageStart);
    expect(Math.max(...pages)).toBe(passage.pageEnd);
    expect(resolved.blocks.map((block) => block.text).join(' ')).toContain(
      'Custody of a distressed asset transfers at the point of assignment',
    );
  });

  it('records a citation trail from an audit verdict back to real passages', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(4));

    const outcome = recordAudit({
      projectId: fixture.project.id,
      layerId: document.layerId!,
      auditedDocumentId: document.id,
      auditedDocumentIds: [document.id],
      source: 'TEST',
      mode: 'SINGLE_DOCUMENT',
      result: {
        verdict: 'PATCH',
        summary: 'Custody and claim priority are stated but the boundary is thin.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: ['State the boundary against Decision Routing Rules explicitly.'],
        synthesisRequired: false,
        freezeEligible: false,
        nextVersion: null,
        nextAction: 'Patch the boundary statement.',
        confidence: 0.6,
      },
      gaps: [
        {
          classification: 'PATCH',
          title: 'Custody and claim priority boundary',
          detail: 'The layer describes custody transfer but not who may change it.',
          justification: 'It belongs to this layer, so it is not a handoff.',
          researchQuestion: 'When exactly is claim priority fixed relative to assignment?',
          expectedContribution: null,
          sourcePass: 'JUDGE',
        },
      ],
    });

    const written = recordAuditEvidence({
      audit: outcome.audit,
      documentIds: [document.id],
      verdictQuery: 'custody claim priority boundary',
    });
    expect(written).toBeGreaterThan(0);

    const evidence = listAuditEvidence(outcome.audit.id);
    const gapId = outcome.audit.gaps[0]!.id;
    const forGap = evidence.filter((entry) => entry.gapId === gapId);
    expect(forGap.length).toBeGreaterThan(0);

    for (const entry of forGap) {
      expect(entry.extractionRunId).toBe(runId);
      expect(entry.documentLabel).toBe(document.canonicalName);
      expect(entry.pageNumber).not.toBeNull();
      // Every citation resolves to real source text, which is the whole point.
      const resolved = resolveCitation(entry.chunkId!)!;
      expect(resolved.document.id).toBe(document.id);
      expect(resolved.blocks.length).toBeGreaterThan(0);
      const source = resolved.blocks.map((block) => block.text).join(' ');
      const words = entry.quote.replace(/^…|…$/g, '').trim().split(/\s+/).slice(1, 6).join(' ');
      expect(source).toContain(words);
    }
  });

  it('cites nothing rather than something invented when no passage matches', async () => {
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(2));
    const outcome = recordAudit({
      projectId: fixture.project.id,
      layerId: document.layerId!,
      auditedDocumentId: document.id,
      auditedDocumentIds: [document.id],
      source: 'TEST',
      mode: 'SINGLE_DOCUMENT',
      result: {
        verdict: 'PASS',
        summary: 'Nothing to say.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: false,
        nextVersion: null,
        nextAction: 'Continue.',
        confidence: 0.9,
      },
      gaps: [],
    });

    const written = recordAuditEvidence({
      audit: outcome.audit,
      documentIds: [document.id],
      verdictQuery: 'securitisation waterfall tranche subordination',
    });
    expect(written).toBe(0);
    expect(listAuditEvidence(outcome.audit.id)).toHaveLength(0);
  });

  it('distinguishes "the document does not say this" from "I never read it"', async () => {
    const read = await importAndRead('World Model v1.pdf', multiPagePdf(2));
    const unread = addDocument(fixture, 'World Model', 'v1B', { contents: BODY.join(' ') });

    const retrieved = retrieveEvidence({
      documentIds: [read.document.id, unread.id],
      query: 'securitisation waterfall tranche',
    });

    expect(retrieved.passages).toHaveLength(0);
    expect(retrieved.searched.map((entry) => entry.documentId)).toEqual([read.document.id]);
    expect(retrieved.searched[0]!.chunkCount).toBeGreaterThan(0);
    expect(retrieved.unreadable.map((entry) => entry.documentId)).toEqual([unread.id]);
    expect(retrieved.unreadable[0]!.reason).toMatch(/never been extracted/i);
  });
});

// ---------------------------------------------------------------------------
// 19. A failed extraction never moves project state
// ---------------------------------------------------------------------------

describe('a failed extraction', () => {
  it('changes the document reading and nothing else', async () => {
    // Import first, so what the assertions isolate is the failed reading rather
    // than the arrival of a document — importing one is supposed to move state.
    const { document } = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    const layer = fixture.layerByName('World Model');
    const before = computeLayerState(layer.id);
    const eventsBefore = listEvents(fixture.project.id, 500).length;

    fs.writeFileSync(
      path.resolve(DATA_ROOT, document.filesystemPath!),
      Buffer.from('%PDF-1.4\nnot actually a pdf\n'.repeat(10)),
    );
    await enqueueExtraction(document.id, { force: true });

    const after = computeLayerState(layer.id);
    expect(getCurrentExtractionRun(document.id)!.status).toBe('BLOCKED');

    // The layer did not advance, freeze, or acquire a canonical document.
    expect(after.status).toBe(before.status);
    expect(after.canonicalName).toBe(before.canonicalName);
    expect(after.currentVersion).toBe(before.currentVersion);
    expect(after.frozen).toBe(before.frozen);
    expect(after.missingVersions).toEqual(before.missingVersions);

    // The only new events are about the document, never about the layer.
    const now = listEvents(fixture.project.id, 500);
    const added = now.slice(0, now.length - eventsBefore);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((event: { eventType: string }) => !event.eventType.startsWith('LAYER_'))).toBe(
      true,
    );
    expect(added.some((event: { eventType: string }) => event.eventType === 'DOCUMENT_EXTRACTED')).toBe(
      true,
    );
  });

  it('leaves the previous reading in place when a reprocess cannot read the file', async () => {
    const { document, runId } = await importAndRead('World Model v1.pdf', multiPagePdf(3));
    expect(getCurrentExtractionRun(document.id)!.status).toBe('READY');

    // The file is replaced on disk by something unreadable, then reprocessed.
    fs.writeFileSync(
      path.resolve(DATA_ROOT, document.filesystemPath!),
      Buffer.from('%PDF-1.4\ncorrupted in place\n'.repeat(10)),
    );
    const result = await enqueueExtraction(document.id, { force: true });

    expect(result.quality.status).toBe('BLOCKED');
    // The old run and its blocks survive, so an audit recorded against it still resolves.
    const previous = listExtractionRuns(document.id).find((run) => run.id === runId)!;
    expect(previous.status).toBe('READY');
    expect(listBlocks(runId).length).toBeGreaterThan(0);
    expect(previous.supersededByRunId).toBe(result.run.id);
  });
});
