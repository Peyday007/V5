import type { PriceStatus } from '../../../domain/magicTypes.ts';
import { WEEKLY_ALLOWANCE_CENTS, formatCents } from './money.ts';

export const SCRYFALL_SOURCE = 'scryfall';

export interface PrintingPrice {
  printingId: string;
  oracleId: string;
  setCode: string;
  collectorNumber: string;
  /** Scryfall's non-foil price in cents, null when it publishes none. */
  scryfallCents: number | null;
  scryfallFetchedAt: string | null;
}

export interface VerifiedPrice {
  printingId: string;
  priceCents: number;
  source: string;
  observedOn: string;
  locked: boolean;
}

export interface PriceReading {
  printingId: string;
  priceCents: number | null;
  status: PriceStatus | null;
  source: string | null;
  timestamp: string | null;
  locked: boolean;
  note: string;
}

/**
 * One printing's price. A person-entered shop/league price (newest, locked
 * first) is CONFIRMED; Scryfall's is always an ESTIMATE; neither is `null`.
 */
export function priceFor(p: PrintingPrice, verified: VerifiedPrice[]): PriceReading {
  const mine = verified
    .filter((v) => v.printingId === p.printingId)
    .sort((a, b) => Number(b.locked) - Number(a.locked) || b.observedOn.localeCompare(a.observedOn));
  const v = mine[0];
  if (v) {
    return { printingId: p.printingId, priceCents: v.priceCents, status: 'CONFIRMED', source: v.source,
      timestamp: v.observedOn, locked: v.locked, note: 'Entered and dated by a person.' };
  }
  if (p.scryfallCents !== null) {
    return { printingId: p.printingId, priceCents: p.scryfallCents, status: 'ESTIMATE', source: SCRYFALL_SOURCE,
      timestamp: p.scryfallFetchedAt, locked: false,
      note: 'Scryfall price: an estimate, not a verified TCGplayer market price.' };
  }
  return { printingId: p.printingId, priceCents: null, status: null, source: null, timestamp: null, locked: false,
    note: 'No price is known for this printing.' };
}

export interface SnapshotInput {
  printingId: string;
  priceCents: number;
  source: string;
  observedOn: string;
}

/** A person's verified price; a lock needs a source and a date, and an integer. */
export function validateVerifiedEntry(i: SnapshotInput): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(i.priceCents) || i.priceCents < 0) problems.push('price must be whole cents, zero or more');
  if (!i.source.trim()) problems.push('a verified price must name its source');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.observedOn) || Number.isNaN(Date.parse(i.observedOn))) {
    problems.push('a verified price must carry its date (YYYY-MM-DD)');
  }
  if (i.source.trim().toLowerCase() === SCRYFALL_SOURCE) problems.push('Scryfall is an estimate and cannot be entered as verified');
  return problems;
}

export interface AlternatePrinting {
  printingId: string;
  label: string;
  reading: PriceReading;
  /** Cents more (+) or less (-) than the reference; null when either is unpriced. */
  deltaCents: number | null;
}

/** Other printings of one card with the price difference from the reference. */
export function alternatePrintings(
  reference: PrintingPrice, others: PrintingPrice[], verified: VerifiedPrice[],
): AlternatePrinting[] {
  const ref = priceFor(reference, verified);
  return others
    .filter((o) => o.oracleId === reference.oracleId && o.printingId !== reference.printingId)
    .map((o) => {
      const reading = priceFor(o, verified);
      return {
        printingId: o.printingId, label: `${o.setCode.toUpperCase()} ${o.collectorNumber}`, reading,
        deltaCents: reading.priceCents !== null && ref.priceCents !== null ? reading.priceCents - ref.priceCents : null,
      };
    })
    .sort((a, b) => (a.reading.priceCents ?? Infinity) - (b.reading.priceCents ?? Infinity) || a.printingId.localeCompare(b.printingId));
}

export interface NamedPrintings {
  name: string;
  printings: PrintingPrice[];
}

export interface Resolution {
  name: string;
  printing: PrintingPrice | null;
  ambiguous: PrintingPrice[];
  reason: string;
}

/** A name with several printings is surfaced as ambiguous unless a printing was chosen. */
export function resolvePrinting(c: NamedPrintings, chosenPrintingId?: string): Resolution {
  if (chosenPrintingId) {
    const hit = c.printings.find((p) => p.printingId === chosenPrintingId);
    return hit
      ? { name: c.name, printing: hit, ambiguous: [], reason: 'printing chosen' }
      : { name: c.name, printing: null, ambiguous: c.printings, reason: 'chosen printing is not a printing of this card' };
  }
  if (c.printings.length === 1) return { name: c.name, printing: c.printings[0]!, ambiguous: [], reason: 'only one printing' };
  if (c.printings.length === 0) return { name: c.name, printing: null, ambiguous: [], reason: 'no printing known' };
  return { name: c.name, printing: null, ambiguous: c.printings, reason: 'several printings; none chosen' };
}

export interface Eligibility {
  eligible: boolean;
  totalCents: number;
  reasons: string[];
}

/**
 * League approval of one week's singles. Total at or under the allowance
 * passes (9.99 and 10.00); 10.01 is refused. An ESTIMATE, a missing price or an
 * ambiguous printing is never approved, and a proxy still counts its price.
 */
export function approveSingles(
  readings: PriceReading[], allowanceCents: number = WEEKLY_ALLOWANCE_CENTS,
): Eligibility {
  const reasons: string[] = [];
  let total = 0;
  for (const r of readings) {
    if (r.priceCents === null || r.status === null) {
      reasons.push(`${r.printingId}: no price known`);
      continue;
    }
    if (r.status !== 'CONFIRMED') reasons.push(`${r.printingId}: ESTIMATE price cannot be league-approved`);
    total += r.priceCents;
  }
  if (total > allowanceCents) reasons.push(`total ${formatCents(total)} is over the ${formatCents(allowanceCents)} allowance`);
  return { eligible: reasons.length === 0, totalCents: total, reasons };
}

/** Marking one price approved: only a CONFIRMED price may be. */
export function canMarkApproved(r: PriceReading): { ok: boolean; reason: string } {
  if (r.status === 'CONFIRMED' && r.priceCents !== null) return { ok: true, reason: '' };
  return { ok: false, reason: r.status === 'ESTIMATE' ? 'An ESTIMATE cannot be marked approved.' : 'No price to approve.' };
}
