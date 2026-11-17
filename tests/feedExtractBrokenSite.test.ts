/**
 * EXTRACTION_UNREADABLE:broken-site. The site checker files each lead as
 * `<name> in <City>: <problem phrase>` under source 'broken-site'; the
 * extractor knew no kind for that source and its place reader needs
 * "City, ST", which a lead line deliberately never names, so every such
 * record went to model assistance. These tests build items exactly as
 * sites.ts fileLead does, from the recorded failure lines verbatim.
 */
import { describe, expect, it } from 'vitest';
import { extractItem, extractItems, readable, recordKindOf, type ExtractableItem } from '../server/services/feeds/extract.ts';
import { PROBLEM_TITLE, SITE_SOURCE, type SiteProblem } from '../server/services/feeds/sites.ts';

const CONFIRMED = '2026-11-16T12:00:00.000Z';

function lead(id: string, name: string, city: string, problem: SiteProblem, website: string, detail = 'the address did not resolve', category: string | null = 'shop'): ExtractableItem {
  // The shape sites.ts fileLead stores.
  return {
    id,
    source: SITE_SOURCE,
    url: website,
    title: `${name} in ${city}: ${PROBLEM_TITLE[problem]}`,
    body: `Checked twice, at least an hour apart: ${detail}. Kind of business: ${category ?? 'not mapped'}. Found on OpenStreetMap.`,
    organization: name,
    publishedAt: CONFIRMED,
    fetchedAt: CONFIRMED,
  };
}

const RECORDED: ExtractableItem[] = [
  lead('fi_1', 'Chris Casseb Clothing', 'San Antonio', 'NO_DNS', 'http://www.chriscassebclothing.com/'),
  lead('fi_2', 'Roland Garcia Atty', 'San Antonio', 'NOT_FOUND', 'https://www.rolandgarcia.net/', 'the home page answered 404'),
  lead('fi_3', "Russo's Coal-Fired Italian Kitchen", 'San Antonio', 'NOT_FOUND', 'https://www.russoscoalfired.com/locations/the-rim-san-antonio/', 'the home page answered 404', 'restaurant'),
  lead('fi_4', 'Einstein Bros. Bagels', 'San Antonio', 'NOT_FOUND', 'https://locations.einsteinbros.com/us/tx/san-antonio/1-utsa-cir', 'the home page answered 404', 'cafe'),
  lead('fi_5', 'El y Ella Beauty Salon', 'Las Vegas', 'NO_DNS', 'http://elyellabeautysalon.com/', 'the address did not resolve', null),
];

const VERBATIM = [
  'Chris Casseb Clothing in San Antonio: website address does not load at all',
  'Roland Garcia Atty in San Antonio: website home page is gone',
  "Russo's Coal-Fired Italian Kitchen in San Antonio: website home page is gone",
  'Einstein Bros. Bagels in San Antonio: website home page is gone',
  'El y Ella Beauty Salon in Las Vegas: website address does not load at all',
];

/** What readable() decided before this change: the source had no kind, so every record was UNKNOWN. */
function readableBefore(item: ExtractableItem): boolean {
  return readable({ ...item, source: 'unregistered-source' }, extractItem({ ...item, source: 'unregistered-source' }));
}

describe('broken-site lead lines are read by code', () => {
  it('builds the recorded lines verbatim', () => {
    expect(RECORDED.map((i) => i.title)).toEqual(VERBATIM);
  });

  it('was unreadable before and is readable now, with nothing sent to model assistance', () => {
    for (const item of RECORDED) {
      expect(readableBefore(item)).toBe(false);
      expect(readable(item, extractItem(item))).toBe(true);
    }
    const run = extractItems(RECORDED, new Date(CONFIRMED));
    expect(run.needsModel.flat()).toHaveLength(0);
  });

  it('keeps every fact NOT_DEMAND, a public record, and linked to the exact raw text', () => {
    for (const item of RECORDED) {
      expect(recordKindOf(item)).toBe('PUBLIC_RECORD');
      const facts = extractItem(item);
      expect(facts.length).toBeGreaterThan(0);
      for (const f of facts) {
        expect(f.demand).toBe('NOT_DEMAND');
        expect(f.recordKind).toBe('PUBLIC_RECORD');
        expect(f.field).not.toBe('buyer');
        expect(f.evidence.itemId).toBe(item.id);
        expect(f.evidence.url).toBe(item.url);
        const raw = f.evidence.field === 'title' ? item.title : f.evidence.field === 'body' ? item.body : f.evidence.field === 'organization' ? item.organization : item.publishedAt;
        expect(raw).toContain(f.evidence.text);
      }
      expect(facts.find((f) => f.field === 'organization')?.evidence.text).toBe(item.organization);
    }
  });

  it('reads the city with its exact span, and one deliverable key per problem class', () => {
    const facts = RECORDED.map((i) => extractItem(i));
    const loc = facts.map((fs) => fs.filter((f) => f.field === 'location'));
    for (const [i, city, text] of [[0, 'san antonio', 'in San Antonio'], [1, 'san antonio', 'in San Antonio'], [2, 'san antonio', 'in San Antonio'], [3, 'san antonio', 'in San Antonio'], [4, 'las vegas', 'in Las Vegas']] as const) {
      expect(loc[i]).toHaveLength(1);
      expect(loc[i]![0]!.value).toBe(city);
      expect(loc[i]![0]!.evidence.text).toBe(text);
    }
    const deliverable = facts.map((fs) => fs.find((f) => f.field === 'deliverable')!);
    expect(deliverable[0]!.value).toBe('website-repair:NO_DNS');
    expect(deliverable[4]!.value).toBe(deliverable[0]!.value);
    expect(new Set([deliverable[1]!.value, deliverable[2]!.value, deliverable[3]!.value])).toEqual(new Set(['website-repair:NOT_FOUND']));
    expect(deliverable[0]!.evidence.text).toBe(PROBLEM_TITLE.NO_DNS);
    expect(deliverable[1]!.evidence.text).toBe(PROBLEM_TITLE.NOT_FOUND);
  });

  it('never states anything as established', () => {
    const run = extractItems(RECORDED, new Date(CONFIRMED));
    for (const r of run.reconciled) expect(['OBSERVED', 'CONTESTED', 'STALE']).toContain(r.status);
  });

  it('adds no deliverable or location from a phrase that is not a problem title, or a line about someone else', () => {
    const odd: ExtractableItem = { ...RECORDED[0]!, id: 'fi_x', title: 'Chris Casseb Clothing in San Antonio: website is slow sometimes' };
    const facts = extractItem(odd);
    expect(facts.some((f) => f.field === 'location')).toBe(false);
    expect(facts.find((f) => f.field === 'deliverable')?.value).not.toMatch(/^website-repair:/);
    expect(readable(odd, facts)).toBe(false);

    const other: ExtractableItem = { ...RECORDED[0]!, id: 'fi_y', organization: 'Somebody Else' };
    const otherFacts = extractItem(other);
    expect(otherFacts.some((f) => f.field === 'location')).toBe(false);
    expect(otherFacts.find((f) => f.field === 'deliverable')?.value).not.toMatch(/^website-repair:/);
  });
});
