/**
 * Importing an existing research archive.
 *
 * The test that matters is the messy one: a folder of forty-odd real files in
 * nested subfolders, mixing native-text PDFs, scans, DOCX, text and Markdown,
 * with exact duplicates, revised versions, files Brain cannot read, and files it
 * refuses. Then cancelling it, restarting, resuming, and retrying the failures —
 * because that is what actually happens to an import that takes minutes.
 *
 * What is being proved is not that the happy path works. It is that no file is
 * ever silently skipped, that finished work survives everything, and that every
 * file ends in exactly one recorded state with a reason a person can act on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { DATA_ROOT } from '../server/env.ts';
import { buildPdf, imageOnlyPage, prosePage } from './fixtures/pdf.ts';
import { buildDocx, heading, paragraph } from './fixtures/docx.ts';
import { getDocument } from '../server/repos/documents.ts';
import {
  getImportJob,
  listImportFiles,
  listUnfinishedImportJobs,
  updateImportFile,
  updateImportJob,
} from '../server/repos/imports.ts';
import {
  cancelArchiveImport,
  discoverFiles,
  importReport,
  processArchiveImport,
  recoverInterruptedImports,
  resumeArchiveImport,
  retryFailedFiles,
  startArchiveImport,
} from '../server/services/archive/import.ts';
import { whenExtractionIdle } from '../server/services/documents/queue.ts';
import { setOcrEngine, type OcrEngine } from '../server/services/documents/ocr.ts';

let fixture: TestProject;
let archive: string;

/** Long enough prose that the extraction quality gate treats it as a real document. */
function body(subject: string, index: number): string {
  return [
    `${subject} — note ${index}`,
    '',
    'This document sets out what the project established about its subject, the definitions it',
    'used, and the evidence behind each statement. It distinguishes what was measured from what',
    'was inferred, and it names the source of every figure it quotes so a reader can check it.',
    '',
    'Custody, ownership and control are treated separately throughout, because conflating them is',
    'the error that makes downstream routing decisions wrong. Where the evidence is thin, this',
    'document says so rather than presenting an estimate as a measurement.',
  ].join('\n');
}

function write(relative: string, contents: Buffer | string): string {
  const absolute = path.join(archive, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  return absolute;
}

/**
 * A realistic archive: nested folders, five formats, duplicates, revisions, and
 * the files that go wrong.
 */
function buildArchive(): { total: number; supported: number } {
  const folders = ['world-model', 'monetization/2024', 'monetization/2025', 'taxonomy/drafts', 'scans'];
  let supported = 0;
  let total = 0;

  // 20 text and Markdown notes across nested folders.
  for (let index = 1; index <= 20; index += 1) {
    const folder = folders[index % folders.length]!;
    const extension = index % 2 === 0 ? 'md' : 'txt';
    write(`${folder}/note-${index}.${extension}`, body('Custody transfer', index));
    supported += 1;
    total += 1;
  }

  // 10 native-text PDFs.
  for (let index = 1; index <= 10; index += 1) {
    write(
      `world-model/report-${index}.pdf`,
      buildPdf([prosePage(`Recognition of control ${index}`, [body('Recognition of control', index).split('\n')])]),
    );
    supported += 1;
    total += 1;
  }

  // 5 DOCX documents.
  for (let index = 1; index <= 5; index += 1) {
    write(
      `taxonomy/drafts/draft-${index}.docx`,
      buildDocx([heading(1, `Taxonomy draft ${index}`), paragraph(body('Taxonomy', index))]),
    );
    supported += 1;
    total += 1;
  }

  // 3 scans, which need OCR.
  for (let index = 1; index <= 3; index += 1) {
    write(`scans/scan-${index}.pdf`, buildPdf([imageOnlyPage()]));
    supported += 1;
    total += 1;
  }

  // Exact duplicates of two existing files, in a different folder.
  write('duplicates/note-1-copy.txt', body('Custody transfer', 1));
  write(
    'duplicates/report-1-copy.pdf',
    buildPdf([prosePage('Recognition of control 1', [body('Recognition of control', 1).split('\n')])]),
  );
  supported += 2;
  total += 2;

  // A revised version of an earlier note: same subject, different content.
  write('world-model/note-1-revised.txt', `${body('Custody transfer', 1)}\n\nRevised: control now passes on the registry entry.`);
  supported += 1;
  total += 1;

  // Files Brain does not read. Recorded, never silently dropped.
  write('assets/diagram.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  write('assets/data.xlsx', Buffer.from('not really a spreadsheet'));
  write('assets/archive.zip', Buffer.from('PK not a docx'));
  total += 3;

  // A PDF that is not a PDF: the extension lies and the bytes are unreadable.
  write('world-model/corrupt.pdf', Buffer.from('%PDF-1.4 but then nothing that parses'));
  supported += 1;
  total += 1;

  // Noise that must never be treated as a document.
  write('.DS_Store', Buffer.from('junk'));
  write('scans/Thumbs.db', Buffer.from('junk'));

  return { total, supported };
}

beforeEach(() => {
  fixture = freshProject();
  archive = path.join(DATA_ROOT, 'test-archive');
  fs.rmSync(archive, { recursive: true, force: true });
  fs.mkdirSync(archive, { recursive: true });
});

afterEach(() => {
  fs.rmSync(archive, { recursive: true, force: true });
  setOcrEngine(null);
  teardown();
});

describe('discovery', () => {
  it('walks nested folders and reports what it cannot read', () => {
    const built = buildArchive();
    const found = discoverFiles(archive);

    expect(found.length).toBe(built.total);
    expect(found.filter((entry) => entry.supported).length).toBe(built.supported);
    // Nested paths are kept relative to the folder the user chose.
    expect(found.some((entry) => entry.relativePath === 'monetization/2024/note-5.md' ||
      entry.relativePath.startsWith('monetization/'))).toBe(true);
    // System noise is not a document.
    expect(found.some((entry) => entry.filename === '.DS_Store')).toBe(false);
    expect(found.some((entry) => entry.filename === 'Thumbs.db')).toBe(false);
    // Every entry keeps its provenance.
    for (const entry of found) {
      expect(entry.absolutePath.startsWith(archive)).toBe(true);
      expect(entry.fileSize).toBeGreaterThan(0);
      expect(entry.sourceModifiedAt).toBeTruthy();
    }
  });

  it('does not follow a symlink back into itself', () => {
    write('world-model/note.txt', body('Custody', 1));
    try {
      fs.symlinkSync(archive, path.join(archive, 'loop'));
    } catch {
      return; // Symlinks unavailable on this filesystem; nothing to prove here.
    }
    const found = discoverFiles(archive);
    expect(found).toHaveLength(1);
  });
});

describe('a folder of more than forty mixed documents', () => {
  it('imports every one of them, and says what happened to each', async () => {
    const built = buildArchive();
    expect(built.total).toBeGreaterThan(40);

    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    expect(job.discovered).toBe(built.total);

    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const report = importReport(job.id)!;
    expect(report.job.status).toBe('COMPLETE');

    // No file is left pending, and none is missing from the report.
    expect(report.files).toHaveLength(built.total);
    const pending = report.files.filter((file) =>
      ['DISCOVERED', 'QUEUED', 'EXTRACTING', 'OCR'].includes(file.status),
    );
    expect(pending).toHaveLength(0);
    for (const file of report.files) {
      expect(file.detail ?? '').not.toBe('');
      expect(file.completedAt).toBeTruthy();
    }

    // The counted report adds up to what was discovered.
    const counted =
      report.job.registered +
      report.job.duplicates +
      report.job.unsupported +
      report.job.unreadable +
      report.job.failed +
      report.job.needsReview;
    expect(counted).toBe(report.job.discovered);

    expect(report.job.registered).toBeGreaterThan(30);
    expect(report.job.unsupported).toBeGreaterThanOrEqual(3);
  }, 240_000);

  it('records identical bytes as a duplicate rather than as second evidence', async () => {
    write('a/note.txt', body('Custody transfer', 1));
    write('b/note-copy.txt', body('Custody transfer', 1));

    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const files = listImportFiles(job.id);
    const duplicate = files.find((file) => file.status === 'DUPLICATE');
    expect(duplicate).toBeTruthy();
    expect(duplicate!.detail).toMatch(/identical/i);
    // Both originals are still where the user had them.
    expect(fs.existsSync(path.join(archive, 'a/note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'b/note-copy.txt'))).toBe(true);
    // And only one of them became a document.
    const registered = files.filter((file) => file.status === 'REGISTERED');
    expect(registered).toHaveLength(1);
  }, 60_000);

  it('keeps a revised version as its own document', async () => {
    write('notes/plan.txt', body('Custody transfer', 1));
    write('notes/plan-revised.txt', `${body('Custody transfer', 1)}\n\nRevised: notice now controls.`);

    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const files = listImportFiles(job.id);
    expect(files.filter((file) => file.status === 'DUPLICATE')).toHaveLength(0);
    const documents = files
      .map((file) => file.documentId)
      .filter((id): id is string => id !== null);
    expect(new Set(documents).size).toBe(2);
  }, 60_000);

  it('keeps the source path and timestamp on every registered document', async () => {
    write('world-model/deep/note.txt', body('Custody transfer', 3));
    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const file = listImportFiles(job.id).find((entry) => entry.status === 'REGISTERED')!;
    const document = getDocument(file.documentId!)!;
    expect(document.importJobId).toBe(job.id);
    expect(document.sourcePath).toBe('world-model/deep/note.txt');
    expect(document.sourceModifiedAt).toBeTruthy();
    expect(file.fileHash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});

describe('an import that is interrupted', () => {
  it('stops when cancelled and keeps what it already imported', async () => {
    for (let index = 1; index <= 8; index += 1) {
      write(`notes/note-${index}.txt`, body('Custody transfer', index));
    }
    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });

    // Process a bounded batch, then cancel before the rest.
    await processArchiveImport(job.id, { limit: 3 });
    cancelArchiveImport(job.id, 'Changed my mind.');
    await whenExtractionIdle();

    const afterCancel = importReport(job.id)!;
    expect(afterCancel.job.status).toBe('CANCELLED');
    expect(afterCancel.job.registered).toBe(3);
    expect(afterCancel.files.filter((file) => file.status === 'DISCOVERED')).toHaveLength(5);

    // Resuming continues from the fourth file rather than starting again.
    const beforeIds = afterCancel.files
      .filter((file) => file.status === 'REGISTERED')
      .map((file) => file.documentId);
    await resumeArchiveImport(job.id);
    await whenExtractionIdle();

    const done = importReport(job.id)!;
    expect(done.job.status).toBe('COMPLETE');
    expect(done.job.registered).toBe(8);
    const stillThere = done.files
      .filter((file) => beforeIds.includes(file.documentId))
      .map((file) => file.documentId);
    expect(stillThere).toEqual(expect.arrayContaining(beforeIds));
  }, 120_000);

  it('is paused rather than left running when the server dies mid-file', async () => {
    for (let index = 1; index <= 4; index += 1) {
      write(`notes/note-${index}.txt`, body('Custody transfer', index));
    }
    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id, { limit: 2 });
    await whenExtractionIdle();

    // The shape a killed process leaves behind: a job that says RUNNING and a
    // file that says EXTRACTING, with nothing behind either.
    updateImportJob(job.id, { status: 'RUNNING' });
    const pending = listImportFiles(job.id).find((file) => file.status === 'DISCOVERED')!;
    updateImportFile(pending.id, { status: 'EXTRACTING' });

    expect(recoverInterruptedImports()).toBe(1);

    const recovered = getImportJob(job.id)!;
    expect(recovered.status).toBe('PAUSED');
    expect(recovered.message).toMatch(/interrupted/i);
    expect(recovered.registered).toBe(2);
    const requeued = listImportFiles(job.id).find((file) => file.id === pending.id)!;
    expect(requeued.status).toBe('QUEUED');
    expect(listUnfinishedImportJobs()).toHaveLength(0);

    // And resuming finishes the job without re-reading the first two.
    await resumeArchiveImport(job.id);
    await whenExtractionIdle();
    expect(getImportJob(job.id)!.registered).toBe(4);
  }, 120_000);

  it('retries only the files that failed', async () => {
    write('notes/good.txt', body('Custody transfer', 1));
    write('notes/broken.txt', body('Custody transfer', 2));

    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    // Force one into the state a real extraction failure leaves.
    const target = listImportFiles(job.id).find((file) => file.filename === 'broken.txt')!;
    const survivor = listImportFiles(job.id).find((file) => file.filename === 'good.txt')!;
    updateImportFile(target.id, { status: 'FAILED', detail: 'scripted failure' });

    await retryFailedFiles(job.id);
    await whenExtractionIdle();

    const files = listImportFiles(job.id);
    const retried = files.find((file) => file.id === target.id)!;
    const untouched = files.find((file) => file.id === survivor.id)!;
    // The failure was tried again...
    expect(retried.attempts).toBeGreaterThan(1);
    // ...and the file that had already succeeded was not.
    expect(untouched.attempts).toBe(1);
    expect(untouched.documentId).toBe(survivor.documentId);
  }, 120_000);
});

describe('files Brain cannot read', () => {
  it('records an unreadable scan without OCR as unreadable, not as empty', async () => {
    // No OCR engine installed: a scan has no text layer and cannot be read.
    setOcrEngine(null);
    write('scans/scan.pdf', buildPdf([imageOnlyPage()]));

    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const file = listImportFiles(job.id)[0]!;
    expect(file.status).toBe('UNREADABLE');
    expect(file.detail ?? '').not.toBe('');
    // It is registered as a document, and honestly marked unreadable.
    expect(file.documentId).toBeTruthy();
    expect(file.extractionStatus).toBe('BLOCKED');
  }, 60_000);

  it('marks a file whose bytes make no sense as failed or unreadable, with the reason', async () => {
    write('world-model/corrupt.pdf', Buffer.from('%PDF-1.4 followed by nothing parseable'));
    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const file = listImportFiles(job.id)[0]!;
    expect(['FAILED', 'UNREADABLE']).toContain(file.status);
    expect(file.detail ?? '').not.toBe('');
  }, 60_000);

  it('records an unsupported type instead of pretending it was imported', async () => {
    write('assets/diagram.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const job = startArchiveImport({ projectId: fixture.project.id, folder: archive });
    await processArchiveImport(job.id);

    const file = listImportFiles(job.id)[0]!;
    expect(file.status).toBe('UNSUPPORTED');
    expect(file.detail).toMatch(/cannot read/i);
    expect(file.documentId).toBeNull();
  }, 30_000);
});

describe('a project-wide source folder', () => {
  it('registers transcripts at project level and reads them', async () => {
    write('transcripts/session-one.txt', [
      'DEAL DISPATCH — WORKING TRANSCRIPT',
      '',
      '2025-03-04 09:12',
      '',
      'User: Before anything else I want the World Model settled. Custody, claim priority and who',
      'holds rights against what.',
      '',
      '---',
      '',
      'Assistant: Agreed. The World Model has to name the actors, the objects and the rights that',
      'attach to those objects, and how state moves between them.',
    ].join('\n'));

    const job = startArchiveImport({
      projectId: fixture.project.id,
      folder: archive,
      scope: 'PROJECT_MASTER_TRANSCRIPT',
    });
    await processArchiveImport(job.id);
    await whenExtractionIdle();

    const file = listImportFiles(job.id)[0]!;
    expect(file.status).toBe('REGISTERED');
    const document = getDocument(file.documentId!)!;
    // Not forced into a layer: it belongs to the project and links to several.
    expect(document.layerId).toBeNull();
    expect(document.scope).toBe('PROJECT_MASTER_TRANSCRIPT');
    expect(document.classificationSource).toBe('CONTENT');
  }, 60_000);
});

/** A recogniser stub, for the OCR-required path. */
export function fakeOcr(text: string): OcrEngine {
  return {
    name: 'test-ocr',
    version: '1.0',
    async recognize() {
      return {
        blocks: [{ blockType: 'PARAGRAPH', text, confidence: 0.9 }],
        confidence: 0.9,
        engine: 'test-ocr',
        engineVersion: '1.0',
      } as never;
    },
  } as unknown as OcrEngine;
}
