/**
 * An owner's exclusion reaches the route proposer's own check without
 * crashing it, and a value that names no exclusion class is neither a crash
 * nor an exclusion that excludes nothing.
 *
 * Production, 2026-11-25: the proposer's context carries the owner's
 * exclusions as labels ("domain-name speculation and resale"), and
 * `excludedBy` indexed `EXCLUSION_CLASSES` with them — `Cannot read properties
 * of undefined (reading 'matches')`, seven times in the day's logs, every route
 * ask of the $10K goal whose owner said "no high-priced domain speculation".
 */
import { describe, expect, it } from 'vitest';
import { EXCLUSION_CLASSES, excludedBy, exclusionClassOf, exclusionLabel, exclusionSentence, unrecognisedExclusions } from '../server/services/cash/exclusions.ts';
import { parseRoutes, type RouteContext } from '../server/services/goals/routeProposal.ts';

const base = {
  mechanism: 'PRODUCTIZED_SERVICE', channel: 'Cold email to published contacts', capital: 0, daysToFirstCash: 14, buyerCount: 20000,
  volumeBasis: 'directory counts', assumptions: 'They pay once.', ownerFit: 'Uses what the owner has.',
  monthly: false, performer: 'OWNER', fulfiller: 'The owner', directCost: 0, ownerHoursPerDeal: 2, price: 500,
  searches: { price: ['x price'], demand: ['x demand'], volume: ['x count'] },
};
const ROUTES = [
  { ...base, title: 'Domain flipping on Afternic', payer: 'Startup founders', offer: 'Domain name resale of premium .com names', industry: 'Domains' },
  { ...base, title: 'Spreadsheet cleanup', payer: 'Accounting firms', offer: 'A cleaned client spreadsheet', industry: 'Accounting' },
  { ...base, title: 'Crypto mining rigs', payer: 'Hobbyists', offer: 'Resold crypto mining rigs', industry: 'Hardware' },
];
const ctx = (exclusions: string[]): RouteContext => ({ objective: 'x', currency: 'USD', remaining: 5000, daysLeft: 30, capitalLimit: 500, hoursLimit: null, resources: null, industry: null, recurring: false, exclusions, delivers: [], held: [], refuted: [] });

describe("an owner's exclusions in a route ask", () => {
  it('applies a class given as its label, as the proposer context carries it, without crashing', () => {
    const { routes, rejected } = parseRoutes({ routes: ROUTES }, ctx([EXCLUSION_CLASSES.DOMAIN_SPECULATION.label]));
    expect(rejected.filter((one) => one.rule === 'EXCLUDED').map((one) => one.title)).toEqual(['Domain flipping on Afternic']);
    expect(routes.map((one) => one.title)).toContain('Spreadsheet cleanup');
  });

  it('keeps the ask working on a value that names no class, and leaves out what matches its words', () => {
    const { routes, rejected } = parseRoutes({ routes: ROUTES }, ctx(['crypto mining', EXCLUSION_CLASSES.DOMAIN_SPECULATION.label]));
    expect(rejected.filter((one) => one.rule === 'EXCLUDED').map((one) => one.title).sort()).toEqual(['Crypto mining rigs', 'Domain flipping on Afternic']);
    expect(routes.map((one) => one.title)).toEqual(['Spreadsheet cleanup']);
  });
});

describe('every lookup of an exclusion class', () => {
  it('resolves a key or a label, and names an unknown value as unrecognised', () => {
    expect(exclusionClassOf('DOMAIN_SPECULATION')).toBe('DOMAIN_SPECULATION');
    expect(exclusionClassOf(EXCLUSION_CLASSES.WEBSITE_REPAIR.label)).toBe('WEBSITE_REPAIR');
    expect(exclusionClassOf('GOVERNMENT')).toBeNull();
    expect(exclusionClassOf('toString')).toBeNull();
    expect(exclusionLabel('GOVERNMENT')).toBe('unrecognised exclusion "GOVERNMENT"');
    expect(unrecognisedExclusions(['GOVERNMENT', 'WEBSITE_REPAIR'])).toEqual(['GOVERNMENT']);
    expect(exclusionSentence(['GOVERNMENT' as never])).toContain('unrecognised exclusion "GOVERNMENT"');
    expect(() => excludedBy('a federal contract', ['GOVERNMENT', 'toString'])).not.toThrow();
    expect(excludedBy('Selling premium domains on Afternic', ['DOMAIN_SPECULATION'])).toBe('DOMAIN_SPECULATION');
  });
});
