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
import { METROS, PROBLEM_TITLE, SITE_SOURCE, type SiteProblem } from '../server/services/feeds/sites.ts';

const box = (id: string): string => METROS.find((m) => m.id === id)!.bbox.join(',');

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
    for (const [i, city, text] of [[0, `san antonio @ bbox:${box('san-antonio')}`, 'in San Antonio'], [1, `san antonio @ bbox:${box('san-antonio')}`, 'in San Antonio'], [2, `san antonio @ bbox:${box('san-antonio')}`, 'in San Antonio'], [3, `san antonio @ bbox:${box('san-antonio')}`, 'in San Antonio'], [4, `las vegas @ bbox:${box('las-vegas')}`, 'in Las Vegas']] as const) {
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
  it('reads a city whose name has diacritics or digits, with its exact span', () => {
    for (const [city, value] of [['San José', 'san josé'], ['Cañon City', 'cañon city'], ['29 Palms', '29 palms'], ['Coeur d\u2019Alene', 'coeur d\u2019alene']] as const) {
      const item = lead(`fi_${city}`, 'Corner Shop', city, 'PARKED', 'http://corner.example/');
      const facts = extractItem(item);
      const loc = facts.filter((f) => f.field === 'location');
      expect(loc).toHaveLength(1);
      expect(loc[0]!.value).toBe(`${value} @ item:${item.id}`);
      expect(loc[0]!.evidence.text).toBe(`in ${city}`);
      expect(item.title).toContain(loc[0]!.evidence.text);
      expect(readable(item, facts)).toBe(true);
      expect(facts.every((f) => f.demand === 'NOT_DEMAND')).toBe(true);
    }
  });

  it('still refuses a city that is not a place name', () => {
    for (const city of ['san antonio', 'Austin; DROP', 'Town <b>', 'A'.repeat(60)]) {
      const item = lead(`fi_bad`, 'Corner Shop', city, 'PARKED', 'http://corner.example/');
      expect(extractItem(item).some((f) => f.field === 'location')).toBe(false);
    }
  });

  it('never gives same-named cities in different states one location value', () => {
    // Finding F2: the bare lowercased city ("las vegas") made Las Vegas NV and Las Vegas NM one place.
    // A city outside the checker's metros is scoped to its own record; a metro city to the metro's box.
    const nm = lead('fi_nm', 'Plaza Hotel', 'Las Vegas', 'NO_DNS', 'http://plaza.example/');
    const nv = RECORDED[4]!;
    const [nmLoc] = extractItem(nm).filter((f) => f.field === 'location');
    const [nvLoc] = extractItem(nv).filter((f) => f.field === 'location');
    expect(nvLoc!.value).not.toBe('las vegas');
    // Two leads in the checker's one Las Vegas box are one place, and agree.
    expect(nmLoc!.value).toBe(nvLoc!.value);

    const springA = lead('fi_sa', 'Corner Shop', 'Springfield', 'PARKED', 'http://a.example/');
    const springB = lead('fi_sb', 'Other Shop', 'Springfield', 'PARKED', 'http://b.example/');
    const a = extractItem(springA).find((f) => f.field === 'location')!;
    const b = extractItem(springB).find((f) => f.field === 'location')!;
    expect(a.value).not.toBe(b.value);
    expect(a.value).not.toBe('springfield');
    expect(b.value).not.toBe('springfield');
    for (const [item, f] of [[springA, a], [springB, b]] as const) {
      expect(f.evidence.text).toBe('in Springfield');
      expect(item.title).toContain(f.evidence.text);
      expect(f.demand).toBe('NOT_DEMAND');
    }
    const run = extractItems([springA, springB], new Date(CONFIRMED));
    for (const r of run.reconciled.filter((x) => x.key.startsWith('location:'))) expect(r.status).not.toBe('CONTESTED');
  });

  it('never reads two branches of one chain as a contradiction', () => {
    // Finding F3: one organization, one problem class, two cities shared a location key and reconciled CONTESTED.
    const sa = RECORDED[3]!;
    const austin = lead('fi_aus', 'Einstein Bros. Bagels', 'Austin', 'NOT_FOUND', 'https://locations.einsteinbros.com/us/tx/austin/2-guadalupe', 'the home page answered 404', 'cafe');
    const sa2 = lead('fi_sa2', 'Einstein Bros. Bagels', 'San Antonio', 'NOT_FOUND', 'https://locations.einsteinbros.com/us/tx/san-antonio/3-loop-410', 'the home page answered 404', 'cafe');
    const run = extractItems([sa, austin, sa2], new Date(CONFIRMED));
    const locations = run.reconciled.filter((r) => r.key.startsWith('location:'));
    expect(locations).toHaveLength(3);
    for (const r of locations) {
      expect(r.status).toBe('OBSERVED');
      expect(r.observations).toHaveLength(1);
    }
    expect(run.reconciled.some((r) => r.status === 'CONTESTED')).toBe(false);
    const byItem = new Map(locations.map((r) => [r.observations[0]!.evidence.itemId, r.value]));
    expect(byItem.get(sa.id)).toBe(`san antonio @ bbox:${box('san-antonio')}`);
    expect(byItem.get(austin.id)).toBe(`austin @ bbox:${box('austin')}`);
    expect(byItem.get(sa2.id)).toBe(`san antonio @ bbox:${box('san-antonio')}`);
  });
});
