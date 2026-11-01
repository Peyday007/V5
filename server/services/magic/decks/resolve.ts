/**
 * Turning names into catalog cards, and saying plainly when that fails.
 *
 * A name that matches no card is UNKNOWN_CARD; a name that matches several is
 * AMBIGUOUS_NAME with the candidates listed. A printing hint (set and number)
 * that matches no printing of the card is UNKNOWN_PRINTING. Nothing is guessed.
 */
import { findCardsByName, listPrintings, type CatalogCard } from '../../../repos/magicCatalog.ts';
import type { DeckCardInput } from '../../../repos/magicDecks.ts';
import type { DeckEntry, RuleCard } from '../rules/index.ts';
import type { ParsedLine } from './parse.ts';

export interface ResolutionIssue {
  code: 'UNKNOWN_CARD' | 'AMBIGUOUS_NAME' | 'UNKNOWN_PRINTING';
  line?: number;
  name: string;
  message: string;
  candidates?: { oracleId: string; name: string }[];
}

export function toRuleCard(card: CatalogCard): RuleCard {
  return {
    oracleId: card.oracleId,
    name: card.name,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    keywords: card.keywords,
    colorIdentity: card.colorIdentity,
    legalities: card.legalities,
  };
}

export interface ResolvedLine {
  zone: ParsedLine['zone'];
  quantity: number;
  name: string;
  card: CatalogCard | null;
  printingId: string | null;
}

export async function resolveLines(lines: ParsedLine[]): Promise<{ resolved: ResolvedLine[]; issues: ResolutionIssue[] }> {
  const resolved: ResolvedLine[] = [];
  const issues: ResolutionIssue[] = [];
  const cache = new Map<string, CatalogCard[]>();
  for (const line of lines) {
    const key = line.name.toLowerCase();
    let matches = cache.get(key);
    if (!matches) {
      matches = await findCardsByName(line.name);
      cache.set(key, matches);
    }
    if (matches.length === 0) {
      issues.push({ code: 'UNKNOWN_CARD', line: line.line, name: line.name, message: `"${line.name}" is not in the catalog.` });
      resolved.push({ zone: line.zone, quantity: line.quantity, name: line.name, card: null, printingId: null });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        code: 'AMBIGUOUS_NAME', line: line.line, name: line.name,
        message: `"${line.name}" matches ${matches.length} cards; pick one.`,
        candidates: matches.map((c) => ({ oracleId: c.oracleId, name: c.name })),
      });
      resolved.push({ zone: line.zone, quantity: line.quantity, name: line.name, card: null, printingId: null });
      continue;
    }
    const card = matches[0]!;
    let printingId: string | null = null;
    if (line.setCode) {
      const printings = await listPrintings(card.oracleId);
      const hit = printings.find(
        (p) => p.setCode.toLowerCase() === line.setCode && (!line.collectorNumber || p.collectorNumber.toLowerCase() === line.collectorNumber.toLowerCase()),
      );
      if (hit) printingId = hit.id;
      else {
        issues.push({
          code: 'UNKNOWN_PRINTING', line: line.line, name: card.name,
          message: `${card.name} has no printing ${line.setCode.toUpperCase()}${line.collectorNumber ? ` ${line.collectorNumber}` : ''} in the catalog.`,
        });
      }
    }
    resolved.push({ zone: line.zone, quantity: line.quantity, name: card.name, card, printingId });
  }
  return { resolved, issues };
}

export function toDeckEntries(lines: ResolvedLine[]): DeckEntry[] {
  return lines.map((l) => ({ zone: l.zone, name: l.name, quantity: l.quantity, card: l.card ? toRuleCard(l.card) : null }));
}

export function toDeckCards(lines: ResolvedLine[]): DeckCardInput[] {
  return lines.map((l) => ({ zone: l.zone, cardName: l.name, quantity: l.quantity, oracleId: l.card?.oracleId ?? null, printingId: l.printingId }));
}
