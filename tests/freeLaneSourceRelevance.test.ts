/**
 * A fetched page reaches the model only when it bears on the question.
 *
 * Production, 2026-11-17 11:03–12:03Z: gpt-oss-120b worked 108 fragments and
 * returned 0 accepted claims, each an honest empty list whose reason named the
 * pages Brain had handed it: "quantum entanglement and chlamydia infection",
 * "high-speed train positioning and NHS staff wellbeing", "GitHub about and
 * security pages", "SEC EDGAR search interface", "unreadable binary data".
 * The lane opened search results and remembered URLs in order and showed the
 * first six readable pages, whatever they were about.
 */
import { describe, expect, it } from 'vitest';
import { candidateOrder, isNavigationPage, pageBearsOn, subjectTerms } from '../server/services/freeLane/worker.ts';

const CONSTRUCTED =
  'Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ' +
  'buyers described as "Small and mid-size firms sending year-end client and employee gifts" pay for what they need most, ' +
  'fulfilled by Brain producing it (spreadsheet, business document). Establish whether such buyers actually pay for this.';

const QUANTUM =
  'Quantum entanglement is a phenomenon in which the quantum state of each particle cannot be described independently. ' +
  'Chlamydia infection is a common sexually transmitted infection caused by the bacterium Chlamydia trachomatis. '.repeat(3);
const TRAINS_NHS =
  'High-speed train positioning relies on balises and GNSS receivers along the line. ' +
  'NHS staff wellbeing surveys report burnout among nurses and junior doctors in 2024. '.repeat(3);
const BINARY = '\u0000\u0001PK\u0003\u0004 �� x\u0007\u0010 �'.repeat(80);
const GIFTS =
  'Corporate gifting for small firms: our year-end client gift boxes start at $45 per recipient, with employee gifts ' +
  'from $30. Minimum order 10 boxes; branded cards included. '.repeat(3);

describe('free-lane source relevance', () => {
  it('reads the subject from the quoted phrase and leaves out the template words', () => {
    const terms = subjectTerms(CONSTRUCTED);
    for (const want of ['gift', 'client', 'employee', 'firm']) expect(terms.has(want)).toBe(true);
    for (const boiler of ['establish', 'whether', 'arrangement', 'published', 'composed', 'buyer']) expect(terms.has(boiler)).toBe(false);
  });

  it('drops the pages gpt-oss-120b was handed and keeps the page that states the asked fact', () => {
    const terms = subjectTerms(CONSTRUCTED);
    expect(pageBearsOn(QUANTUM, terms)).toBe(false);
    expect(pageBearsOn(TRAINS_NHS, terms)).toBe(false);
    expect(pageBearsOn(BINARY, terms)).toBe(false);
    expect(pageBearsOn(GIFTS, terms)).toBe(true);
  });

  it('judges a template question by its subject, not its boilerplate', () => {
    const q =
      'For mining equipment distributors in Nevada, nobody has established this yet: the price EastRock Solutions charges ' +
      'for mine supply consulting. Find what a source says about it, quoting the source, or report it unanswered.';
    const terms = subjectTerms(q);
    expect(terms.has('unanswered')).toBe(false);
    // A statistics portal page that shares only the template's words does not pass.
    expect(pageBearsOn('Statista employee satisfaction data: find published statistics and report downloads. '.repeat(4), terms)).toBe(false);
    expect(pageBearsOn('EastRock Solutions mine supply consulting is billed at $180 per hour for Nevada distributors. '.repeat(3), terms)).toBe(true);
  });

  it('a question with no subject words lets every page through rather than none', () => {
    expect(pageBearsOn(QUANTUM, subjectTerms('What is it?'))).toBe(true);
  });

  it('opens navigation pages (contact, security, search forms) only after every other candidate', () => {
    expect(isNavigationPage('https://github.com/security')).toBe(true);
    expect(isNavigationPage('https://www.vestaminesupply.com/contact-us/')).toBe(true);
    expect(isNavigationPage('https://www.sec.gov/cgi-bin/browse-edgar')).toBe(true);
    expect(isNavigationPage('https://www.federalregister.gov/search')).toBe(true);
    expect(isNavigationPage('https://www.example.com/pricing')).toBe(false);
    expect(isNavigationPage('https://www.example.com/research/security-market-report')).toBe(false);
    expect(
      candidateOrder(['https://github.com/security', 'https://acme.example/pricing', 'https://acme.example/contact', 'https://acme.example/terms']),
    ).toEqual(['https://acme.example/pricing', 'https://acme.example/terms', 'https://github.com/security', 'https://acme.example/contact']);
  });
});
