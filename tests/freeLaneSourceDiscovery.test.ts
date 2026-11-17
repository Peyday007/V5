/**
 * A commercial fragment's candidate pages are pages about its subject.
 *
 * Production, 2026-11-17 15:20–16:15Z: gpt-oss-120b worked ~25 RESEARCH_FRAGMENT
 * jobs and 2 produced accepted claims. Its reasons for empty claim lists named
 * the candidates Brain had handed it: arXiv papers (photometric redshift,
 * weighted MaxSAT, gender machine translation, chemical reaction networks,
 * internet-augmented dialogue), a BLS occupational wage table for a question
 * about a sales channel, the SEC EDGAR search interface, NAICS code
 * descriptions, a mine-supply company's contact page. #1052 re-ranked the
 * candidates but the set was wrong: the relevance gate accepted a page sharing
 * one or two words every page carries ("member", "business", "account",
 * "rate"), navigation and search pages were only moved to the end of the list,
 * and a model search phrase naming none of the subject was searched first.
 */
import { describe, expect, it } from 'vitest';
import {
  candidateOrder,
  isAcademicPage,
  isNavigationPage,
  pageBearsOn,
  searchQueries,
  subjectTerms,
  wantsAcademicSources,
} from '../server/services/freeLane/worker.ts';

const constructed = (buyers: string): string =>
  'Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ' +
  `buyers described as "${buyers}" pay for what they need most, fulfilled by Brain producing it (spreadsheet, business document), ` +
  'and the operation is designed as: cold email outreach, one-off sale. Establish whether such buyers actually pay for this.';

const PUBLIC = constructed('anonymous members of the public');
const UNKNOWN_BUSINESS = constructed('individual account of unknown business');
const DENTAL = 'What reply rate do cold email campaigns sent to independent dental practices in the United States achieve?';

const page = (text: string): string => `${text} `.repeat(4);
const ARXIV_DIALOGUE = page(
  'We study internet-augmented dialogue models in which members of a crowdworker pool search the web; the model ' +
    'conditions on retrieved documents and we report the rate of hallucinated knowledge across business and casual topics.',
);
const ARXIV_REDSHIFT = page(
  'Photometric redshift estimation for galaxies in the survey uses a model trained on spectroscopic data; we report the ' +
    'outlier rate and the average error for each member of the cluster sample.',
);
const ARXIV_MAXSAT = page('Weighted MaxSAT solvers assign each clause a cost; our method reduces the average time per instance on the benchmark data.');
const BLS_WAGES = page(
  'May 2024 National Occupational Employment and Wage Estimates. Sales Representatives of Services, Except Advertising: ' +
    'mean hourly wage $36.12, annual mean wage $75,130. Dental Hygienists: mean hourly wage $45.04. Employment per 1,000 jobs.',
);
const NAICS = page('NAICS Code 541611 Administrative Management and General Management Consulting Services: this industry comprises establishments primarily engaged in providing operating advice to businesses.');
const MINE_CONTACT = page('Contact Vesta Mine Supply. Call our business office or send us a message; an account manager will reply within one business day.');
const DENTAL_OUTREACH = page(
  'Our 2024 benchmark of cold email campaigns to independent dental practices in the United States: 41,000 emails, ' +
    'a 3.1% reply rate and a 0.6% meeting rate, highest for practices with one or two dentists.',
);
const PUBLIC_BUYERS = page(
  'Anonymous members of the public who buy a one-off spreadsheet template on Etsy paid a median of $9; 62% of these ' +
    'buyers were anonymous guests who never created an account.',
);

describe('free-lane fragment source discovery', () => {
  it('reads no subject from words every page carries, but keeps them when they are all the subject has', () => {
    const unknown = subjectTerms(UNKNOWN_BUSINESS);
    for (const generic of ['busines', 'account']) expect(unknown.has(generic)).toBe(false);
    // A dental question's subject is the practices and the channel, not "rate".
    const dental = subjectTerms(DENTAL);
    expect(dental.has('rate')).toBe(false);
    for (const want of ['dental', 'cold', 'email', 'reply']) expect(dental.has(want)).toBe(true);
    // A quoted subject that is all generic words is read with the rest of the question: its product and channel.
    const pub = subjectTerms(PUBLIC);
    for (const generic of ['member', 'anonymou']) expect(pub.has(generic)).toBe(false);
    for (const want of ['spreadsheet', 'cold', 'email', 'outreach']) expect(pub.has(want)).toBe(true);
  });

  it('drops the arXiv, BLS, NAICS and contact pages gpt-oss-120b was handed and keeps the page about the subject', () => {
    for (const question of [PUBLIC, UNKNOWN_BUSINESS, DENTAL]) {
      const terms = subjectTerms(question);
      for (const off of [ARXIV_DIALOGUE, ARXIV_REDSHIFT, ARXIV_MAXSAT, NAICS, MINE_CONTACT]) expect(pageBearsOn(off, terms)).toBe(false);
    }
    expect(pageBearsOn(BLS_WAGES, subjectTerms(DENTAL))).toBe(false);
    expect(pageBearsOn(DENTAL_OUTREACH, subjectTerms(DENTAL))).toBe(true);
    expect(pageBearsOn(PUBLIC_BUYERS, subjectTerms(PUBLIC))).toBe(true);
  });

  it('never offers a search interface, a code lookup or a contact page as a source', () => {
    for (const url of [
      'https://www.sec.gov/edgar/search/',
      'https://efts.sec.gov/LATEST/search-index?q=%22mine%20supply%22',
      'https://www.sec.gov/cgi-bin/browse-edgar',
      'https://www.census.gov/naics/?input=541611&year=2022',
      'https://www.vestaminesupply.com/contact-us/',
    ]) {
      expect(isNavigationPage(url)).toBe(true);
    }
    expect(isNavigationPage('https://www.bls.gov/oes/current/oes_nat.htm')).toBe(false);
    expect(isNavigationPage('https://www.example.com/pricing?plan=pro')).toBe(false);
    expect(
      candidateOrder(['https://www.sec.gov/edgar/search/', 'https://acme.example/pricing', 'https://www.vestaminesupply.com/contact-us/']),
    ).toEqual(['https://acme.example/pricing']);
  });

  it('leaves out academic preprints unless the fragment asks for academic sources', () => {
    const urls = ['https://arxiv.org/abs/2107.07566', 'https://www.biorxiv.org/content/10.1101/1', 'https://acme.example/pricing'];
    expect(isAcademicPage(urls[0]!)).toBe(true);
    expect(candidateOrder(urls)).toEqual(['https://acme.example/pricing']);
    expect(wantsAcademicSources(['company pricing pages', 'trade bodies'])).toBe(false);
    expect(wantsAcademicSources(['peer-reviewed studies'])).toBe(true);
    expect(candidateOrder(urls, { academic: wantsAcademicSources(['academic papers']) })).toEqual(urls);
  });

  it('does not search a model phrase that names none of the subject', () => {
    const q = searchQueries(DENTAL, ['weighted MaxSAT benchmark', 'occupational wage estimates', 'dental practice cold email reply rate']);
    expect(q).toEqual(['dental practice cold email reply rate', DENTAL]);
    expect(q.some((one) => /maxsat|occupational/i.test(one))).toBe(false);
  });
});
