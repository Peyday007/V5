import { describe, expect, it } from 'vitest';
import { FEED_SOURCES, parseFederalRegister } from '../server/services/feeds/sources.ts';

// A Federal Register correction carries no effective date of its own: C1-2026-21030 (NRC, AP1000
// Design Certification Renewal) has type Rule but effective_on, dates and action all null, and its
// correction_of names 2026-21030. Without that link a detector reading the body sees no date at all.
const correction = {
  document_number: 'C1-2026-21030',
  title: 'AP1000 Design Certification Renewal',
  html_url: 'https://www.federalregister.gov/documents/2026/11/12/C1-2026-21030/ap1000-design-certification-renewal',
  publication_date: '2026-11-12',
  abstract: null,
  effective_on: null,
  agencies: [{ name: 'Nuclear Regulatory Commission' }],
};

describe('parseFederalRegister: correction_of', () => {
  it('names the corrected document when correction_of is a document number', () => {
    const [item] = parseFederalRegister({ results: [{ ...correction, correction_of: '2026-21030' }] });
    expect(item?.body).toContain('Corrects 2026-21030.');
  });

  it('reads the document number from a documents URL or an object', () => {
    const [fromUrl] = parseFederalRegister({
      results: [{ ...correction, correction_of: 'https://www.federalregister.gov/api/v1/documents/2026-21030' }],
    });
    expect(fromUrl?.body).toBe('Corrects 2026-21030.');
    const [fromObject] = parseFederalRegister({
      results: [{ ...correction, correction_of: { document_number: '2026-21030', html_url: 'https://x.test/a' } }],
    });
    expect(fromObject?.body).toBe('Corrects 2026-21030.');
  });

  it('places the sentence after any Effective sentence', () => {
    const [item] = parseFederalRegister({
      results: [{ ...correction, abstract: 'Fixes a typo.', effective_on: '2026-12-28', correction_of: '2026-21030' }],
    });
    expect(item?.body).toBe('Fixes a typo. Effective 2026-12-28. Corrects 2026-21030.');
  });

  it('parses a row with no correction_of exactly as before', () => {
    const [item] = parseFederalRegister({
      results: [{ ...correction, document_number: '2026-23041', abstract: 'Amends the table.', effective_on: '2026-11-12' }],
    });
    expect(item?.body).toBe('Amends the table. Effective 2026-11-12.');
    expect(item?.organization).toBe('Nuclear Regulatory Commission');
  });

  it('requests the correction_of field from the API', () => {
    const source = FEED_SOURCES.find((s) => s.id === 'federal-register-rules');
    expect(source?.url).toContain('fields%5B%5D=correction_of');
  });
});
