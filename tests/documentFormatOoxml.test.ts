import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { detectFormat } from '../server/services/documents/formats.ts';
import { buildDocx, buildZip } from './fixtures/docx.ts';

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

describe('OOXML packages are told apart by their part folders', () => {
  it('a workbook is UNSUPPORTED and names xlsx', () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', contents: CONTENT_TYPES },
      { name: 'xl/workbook.xml', contents: '<workbook/>' },
    ]);
    const found = detectFormat('book.xlsx', zip);
    expect(found.format).toBe('UNSUPPORTED');
    expect(found.reason).toMatch(/xlsx/);
  });

  it('a presentation is UNSUPPORTED and names pptx', () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', contents: CONTENT_TYPES },
      { name: 'ppt/presentation.xml', contents: '<p/>' },
    ]);
    const found = detectFormat('deck.pptx', zip);
    expect(found.format).toBe('UNSUPPORTED');
    expect(found.reason).toMatch(/pptx/);
  });

  it('finds the part when its name is only in the central directory', () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', contents: CONTENT_TYPES + ' '.repeat(12_000) },
      { name: 'xl/workbook.xml', contents: '<workbook/>' },
    ]);
    expect(zip.subarray(0, 4_096).toString('latin1')).not.toContain('xl/');
    expect(detectFormat('book.xlsx', zip).format).toBe('UNSUPPORTED');
  });

  it('a real DOCX is still DOCX', () => {
    const found = detectFormat('note.docx', buildDocx(['<w:p/>']));
    expect(found.format).toBe('DOCX');
    expect(found.extensionMismatch).toBe(false);
  });

  it('a zip built by jszip with a workbook is UNSUPPORTED, and a plain zip is too', async () => {
    const workbook = new JSZip();
    workbook.file('[Content_Types].xml', CONTENT_TYPES);
    workbook.file('xl/workbook.xml', '<workbook/>');
    const book = await workbook.generateAsync({ type: 'nodebuffer' });
    expect(detectFormat('b.xlsx', book).reason).toMatch(/xlsx/);

    const plain = new JSZip();
    plain.file('readme.txt', 'hello');
    const other = await plain.generateAsync({ type: 'nodebuffer' });
    const found = detectFormat('a.zip', other);
    expect(found.format).toBe('UNSUPPORTED');
    expect(found.reason).toMatch(/not a Word document/);
  });

  it('is not fooled by payload bytes that spell a part folder', () => {
    // The stored contents of the DOCX contain "xl/" and "ppt/"; no entry is named that.
    const zip = buildZip([
      { name: '[Content_Types].xml', contents: CONTENT_TYPES },
      { name: 'word/document.xml', contents: '<w:p>see xl/workbook.xml and ppt/presentation.xml</w:p>' },
    ]);
    expect(zip.toString('latin1')).toContain('xl/workbook.xml');
    expect(detectFormat('note.docx', zip).format).toBe('DOCX');
  });

  it('asks for word/ before the other families, whatever the entry order', () => {
    const zip = buildZip([
      { name: 'xl/stray.xml', contents: '<x/>' },
      { name: '[Content_Types].xml', contents: CONTENT_TYPES },
      { name: 'word/document.xml', contents: '<w/>' },
    ]);
    expect(detectFormat('note.docx', zip).format).toBe('DOCX');
  });

  it('refuses a zip whose central directory cannot be read rather than guessing', () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', contents: CONTENT_TYPES },
      { name: 'xl/workbook.xml', contents: '<workbook/>' },
    ]);
    const damaged = zip.subarray(0, zip.byteLength - 30);
    const found = detectFormat('book.xlsx', damaged);
    expect(found.format).toBe('UNSUPPORTED');
    expect(found.reason).toMatch(/not a Word document/);
  });
});
