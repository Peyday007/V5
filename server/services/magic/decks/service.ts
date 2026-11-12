/**
 * The deck service: import, save, validate, export, undo, change commander.
 * Everything is owner-scoped through the repository; a deck that is not the
 * caller's is `null`, exactly as an absent one is.
 */
import {
  appendVersion, createDeck, currentVersion, diffVersions, getDeck, getVersion, listCollection, listDecks, listVersions,
  setCollectionQuantity, setCurrentVersion, type DeckCardInput, type DeckVersionView, type DeckView, type VersionDiff,
} from '../../../repos/magicDecks.ts';
import { getCard, findCardsByName } from '../../../repos/magicCatalog.ts';
import type { MagicFormat } from '../../../domain/magicTypes.ts';
import { validateDeck, type DeckEntry, type ValidationResult } from '../rules/index.ts';
import { exportDeckList, parseDeckList, type ParseProblem } from './parse.ts';
import { resolveLines, toDeckCards, toDeckEntries, toRuleCard, type ResolutionIssue } from './resolve.ts';

export interface ImportReport {
  deck: DeckView;
  version: DeckVersionView;
  parseProblems: ParseProblem[];
  resolutionIssues: ResolutionIssue[];
  validation: ValidationResult;
  /** True only when every line parsed and resolved. A deck with problems is still saved, visibly. */
  clean: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

async function entriesFor(cards: DeckCardInput[]): Promise<{ entries: DeckEntry[]; snapshot: string | null }> {
  const entries: DeckEntry[] = [];
  let snapshot: string | null = null;
  for (const c of cards) {
    let card = c.oracleId ? await getCard(c.oracleId) : null;
    if (!card) {
      const found = await findCardsByName(c.cardName);
      card = found.length === 1 ? found[0]! : null;
    }
    if (card && (!snapshot || card.fetchedAt < snapshot)) snapshot = card.fetchedAt;
    entries.push({ zone: c.zone, name: c.cardName, quantity: c.quantity, card: card ? toRuleCard(card) : null });
  }
  return { entries, snapshot };
}

export async function validateCards(format: MagicFormat, cards: DeckCardInput[], analysisDate = today()): Promise<ValidationResult> {
  const { entries, snapshot } = await entriesFor(cards);
  return validateDeck({ format, entries, analysisDate, legalitySnapshotAt: snapshot });
}

export async function importDeck(
  ownerUserId: string,
  input: { name: string; format: MagicFormat; text: string; analysisDate?: string; source?: string },
): Promise<ImportReport | { error: 'EMPTY_LIST'; parseProblems: ParseProblem[] }> {
  const parsed = parseDeckList(input.text, { blankLineSideboard: input.format === 'STANDARD' });
  if (parsed.lines.length === 0) return { error: 'EMPTY_LIST', parseProblems: parsed.problems };
  const { resolved, issues } = await resolveLines(parsed.lines);
  const validation = validateDeck({
    format: input.format,
    entries: toDeckEntries(resolved),
    analysisDate: input.analysisDate ?? today(),
  });
  const hasUnresolved = issues.some((i) => i.code !== 'UNKNOWN_PRINTING') || parsed.problems.length > 0;
  const deck = await createDeck({ ownerUserId, name: input.name, format: input.format, cardListStatus: hasUnresolved ? 'UNVERIFIED' : 'VERIFIED' });
  const version = (await appendVersion(ownerUserId, deck.id, {
    cards: toDeckCards(resolved),
    reason: 'Imported from a plaintext list',
    source: input.source ?? 'IMPORT',
    validation: { ...validation, resolutionIssues: issues, parseProblems: parsed.problems },
  }))!;
  return {
    deck: (await getDeck(ownerUserId, deck.id))!,
    version,
    parseProblems: parsed.problems,
    resolutionIssues: issues,
    validation,
    clean: !hasUnresolved && issues.length === 0,
  };
}

export async function saveVersion(
  ownerUserId: string, deckId: string, input: { cards: DeckCardInput[]; reason?: string; source?: string; analysisDate?: string },
): Promise<{ version: DeckVersionView; validation: ValidationResult } | null> {
  const deck = await getDeck(ownerUserId, deckId);
  if (!deck) return null;
  const validation = await validateCards(deck.format, input.cards, input.analysisDate);
  const version = await appendVersion(ownerUserId, deckId, { cards: input.cards, reason: input.reason, source: input.source, validation });
  return version ? { version, validation } : null;
}

export async function validateSaved(ownerUserId: string, deckId: string, analysisDate?: string, versionId?: string): Promise<ValidationResult | null> {
  const deck = await getDeck(ownerUserId, deckId);
  if (!deck) return null;
  const version = versionId ? await getVersion(ownerUserId, versionId) : await currentVersion(ownerUserId, deckId);
  if (!version || version.deckId !== deckId) return null;
  return validateCards(deck.format, version.cards, analysisDate);
}

export async function exportDeck(ownerUserId: string, deckId: string, versionId?: string): Promise<string | null> {
  const deck = await getDeck(ownerUserId, deckId);
  if (!deck) return null;
  const version = versionId ? await getVersion(ownerUserId, versionId) : await currentVersion(ownerUserId, deckId);
  if (!version || version.deckId !== deckId) return null;
  return exportDeckList(version.cards);
}

/** Point the deck at the version before the current one. Nothing is deleted. */
export async function undo(ownerUserId: string, deckId: string): Promise<DeckVersionView | null> {
  const current = await currentVersion(ownerUserId, deckId);
  if (!current?.parentVersionId) return null;
  if (!(await setCurrentVersion(ownerUserId, deckId, current.parentVersionId))) return null;
  return getVersion(ownerUserId, current.parentVersionId);
}

export async function restoreVersion(ownerUserId: string, deckId: string, versionId: string): Promise<DeckVersionView | null> {
  if (!(await setCurrentVersion(ownerUserId, deckId, versionId))) return null;
  return getVersion(ownerUserId, versionId);
}

export async function diff(ownerUserId: string, fromVersionId: string, toVersionId: string): Promise<VersionDiff | null> {
  return diffVersions(ownerUserId, fromVersionId, toVersionId);
}

/** Replace the commander zone and revalidate the whole deck against the new identity. */
export async function changeCommander(
  ownerUserId: string, deckId: string, commanderNames: string[], options: { reason?: string; analysisDate?: string } = {},
): Promise<{ version: DeckVersionView; validation: ValidationResult; issues: ResolutionIssue[] } | null> {
  const deck = await getDeck(ownerUserId, deckId);
  const current = deck ? await currentVersion(ownerUserId, deckId) : null;
  if (!deck || !current) return null;
  const { resolved, issues } = await resolveLines(commanderNames.map((name, i) => ({ zone: 'commander' as const, quantity: 1, name, setCode: null, collectorNumber: null, line: i + 1 })));
  const kept = current.cards.filter((c) => c.zone !== 'commander');
  const cards = [...toDeckCards(resolved), ...kept];
  const validation = await validateCards(deck.format, cards, options.analysisDate);
  const version = (await appendVersion(ownerUserId, deckId, {
    cards,
    reason: options.reason ?? `Commander changed to ${commanderNames.join(' & ')}`,
    source: 'COMMANDER_CHANGE',
    validation: { ...validation, resolutionIssues: issues },
  }))!;
  return { version, validation, issues };
}

export { listDecks, listVersions, listCollection, setCollectionQuantity };
