/**
 * Deck validation for Commander and Standard: one engine, separate rule sets.
 *
 * Pure: a deck and the catalog facts about its cards go in, a list of issues
 * comes out. A card the catalog could not resolve is an issue, never a card
 * assumed legal. Changing the commander is just validating again with different
 * commander entries, so the whole deck is always re-checked.
 */
import {
  ANY_NUMBER_CARDS,
  ANY_NUMBER_TEXT,
  COLOR_ORDER,
  COMMANDER_DECK_SIZE,
  LIMITED_NUMBER_TEXT,
  STANDARD_COPY_LIMIT,
  STANDARD_MAX_SIDEBOARD,
  STANDARD_MIN_MAIN,
  numberWord,
} from '../../../domain/magicRules.ts';
import type { MagicColor, MagicFormat, MagicZone } from '../../../domain/magicTypes.ts';

/** The catalog facts the rules need about one card. */
export interface RuleCard {
  oracleId: string;
  name: string;
  typeLine: string;
  oracleText?: string;
  keywords?: string[];
  colorIdentity: MagicColor[];
  /** Scryfall-style: 'legal' | 'not_legal' | 'banned' | 'restricted' per format. */
  legalities: Record<string, string>;
}

export interface DeckEntry {
  zone: MagicZone;
  /** The name the list used; kept so an unknown card can still be reported. */
  name: string;
  quantity: number;
  /** null = the catalog could not resolve this name. */
  card: RuleCard | null;
}

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  cardName?: string;
  zone?: MagicZone;
}

export interface ValidationInput {
  format: MagicFormat;
  entries: DeckEntry[];
  /** ISO date the legality is judged as of. */
  analysisDate: string;
  /** When the catalog's legalities were fetched; reported so a stale snapshot is visible. */
  legalitySnapshotAt?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  format: MagicFormat;
  analysisDate: string;
  legalitySnapshotAt: string | null;
  counts: { commander: number; main: number; sideboard: number; total: number };
  commanders: string[];
  colorIdentity: MagicColor[];
  issues: ValidationIssue[];
}

export function isBasicLand(card: RuleCard): boolean {
  return /\bBasic\b.*\bLand\b/i.test(card.typeLine);
}

/** null = unlimited; a number = printed cap; undefined = no exception. */
export function copyException(card: RuleCard): number | null | undefined {
  if (isBasicLand(card)) return null;
  const text = card.oracleText ?? '';
  if (ANY_NUMBER_TEXT.test(text)) return null;
  const limited = LIMITED_NUMBER_TEXT.exec(text);
  if (limited) {
    const n = numberWord(limited[1] ?? '');
    if (n !== null) return n;
  }
  if (Object.prototype.hasOwnProperty.call(ANY_NUMBER_CARDS, card.name)) {
    return ANY_NUMBER_CARDS[card.name] ?? null;
  }
  return undefined;
}

const has = (card: RuleCard, keyword: string): boolean =>
  (card.keywords ?? []).some((k) => k.toLowerCase() === keyword.toLowerCase()) ||
  new RegExp(`(^|\\n)${keyword}\\b`, 'i').test(card.oracleText ?? '');

function partnerWithName(card: RuleCard): string | null {
  const match = /Partner with ([^\n(]+?)(?:\s*\(|\n|$)/i.exec(card.oracleText ?? '');
  return match ? (match[1] ?? '').trim() : null;
}

function plainPartner(card: RuleCard): boolean {
  if (partnerWithName(card)) return false;
  return has(card, 'Partner') && !/Friends forever/i.test(card.oracleText ?? '');
}

export function canBeCommander(card: RuleCard): boolean {
  const type = card.typeLine;
  if (/Legendary/i.test(type) && /Creature/i.test(type)) return true;
  if (/can be your commander/i.test(card.oracleText ?? '')) return true;
  if (/Legendary/i.test(type) && /Vehicle|Spacecraft/i.test(type)) return false;
  return false;
}

/** Whether two commanders may be paired. Returns a reason when they may not. */
export function pairProblem(a: RuleCard, b: RuleCard): string | null {
  if (plainPartner(a) && plainPartner(b)) return null;
  const pa = partnerWithName(a);
  const pb = partnerWithName(b);
  if (pa && pb && pa.toLowerCase() === b.name.toLowerCase() && pb.toLowerCase() === a.name.toLowerCase()) return null;
  const friends = (c: RuleCard) => /Friends forever/i.test(c.oracleText ?? '');
  if (friends(a) && friends(b)) return null;
  const chooses = (c: RuleCard) => /Choose a Background/i.test(c.oracleText ?? '');
  const background = (c: RuleCard) => /\bBackground\b/.test(c.typeLine);
  if ((chooses(a) && background(b)) || (chooses(b) && background(a))) return null;
  const companion = (c: RuleCard) => /Doctor's companion/i.test(c.oracleText ?? '');
  const doctor = (c: RuleCard) => /Time Lord Doctor/i.test(c.typeLine);
  if ((companion(a) && doctor(b)) || (companion(b) && doctor(a))) return null;
  return `${a.name} and ${b.name} do not form a legal partner, background or companion pair.`;
}

function union(cards: RuleCard[]): MagicColor[] {
  const set = new Set<MagicColor>();
  for (const c of cards) for (const color of c.colorIdentity) set.add(color);
  return COLOR_ORDER.filter((c) => set.has(c));
}

export function validateDeck(input: ValidationInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, extra: Partial<ValidationIssue> = {}) =>
    issues.push({ code, severity: 'ERROR', message, ...extra });
  const warn = (code: string, message: string, extra: Partial<ValidationIssue> = {}) =>
    issues.push({ code, severity: 'WARNING', message, ...extra });

  const sum = (zone: MagicZone) =>
    input.entries.filter((e) => e.zone === zone).reduce((n, e) => n + e.quantity, 0);
  const counts = { commander: sum('commander'), main: sum('main'), sideboard: sum('sideboard'), total: 0 };
  counts.total = counts.commander + counts.main + counts.sideboard;

  for (const e of input.entries) {
    if (!Number.isInteger(e.quantity) || e.quantity < 1) {
      err('BAD_QUANTITY', `${e.name}: quantity must be a positive whole number.`, { cardName: e.name, zone: e.zone });
    }
    if (!e.card) {
      err('UNKNOWN_CARD', `${e.name} is not in the catalog, so its legality cannot be checked.`, {
        cardName: e.name,
        zone: e.zone,
      });
    }
  }

  const known = input.entries.filter((e): e is DeckEntry & { card: RuleCard } => e.card !== null);
  const commanderCards = known.filter((e) => e.zone === 'commander').map((e) => e.card);
  const identity = input.format === 'COMMANDER' ? union(commanderCards) : [];

  if (input.format === 'COMMANDER') {
    validateCommander(input, known, commanderCards, identity, counts, err, warn);
  } else {
    validateStandard(input, known, counts, err, warn);
  }

  return {
    ok: !issues.some((i) => i.severity === 'ERROR'),
    format: input.format,
    analysisDate: input.analysisDate,
    legalitySnapshotAt: input.legalitySnapshotAt ?? null,
    counts,
    commanders: input.entries.filter((e) => e.zone === 'commander').map((e) => e.name),
    colorIdentity: identity,
    issues,
  };
}

type Report = (code: string, message: string, extra?: Partial<ValidationIssue>) => void;

function legalityIssue(card: RuleCard, format: string, zone: MagicZone, err: Report, warn: Report): void {
  const status = card.legalities[format];
  if (status === 'legal') return;
  if (status === 'banned') err('BANNED', `${card.name} is banned in ${format}.`, { cardName: card.name, zone });
  else if (status === 'restricted') err('RESTRICTED', `${card.name} is restricted in ${format}.`, { cardName: card.name, zone });
  else if (status === 'not_legal') err('NOT_LEGAL', `${card.name} is not legal in ${format}.`, { cardName: card.name, zone });
  else warn('LEGALITY_UNKNOWN', `The catalog has no ${format} legality for ${card.name}.`, { cardName: card.name, zone });
}

function validateCommander(
  input: ValidationInput,
  known: (DeckEntry & { card: RuleCard })[],
  commanderCards: RuleCard[],
  identity: MagicColor[],
  counts: { commander: number; main: number; sideboard: number; total: number },
  err: Report,
  warn: Report,
): void {
  if (counts.commander === 0) err('NO_COMMANDER', 'A Commander deck needs a commander.');
  if (counts.commander > 2) err('TOO_MANY_COMMANDERS', 'A deck may have at most two commanders.');
  for (const e of known.filter((x) => x.zone === 'commander')) {
    if (e.quantity > 1) err('COMMANDER_QUANTITY', `${e.name} cannot be a commander more than once.`, { cardName: e.name, zone: 'commander' });
    const backgroundPaired =
      /\bBackground\b/.test(e.card.typeLine) &&
      commanderCards.some((o) => o !== e.card && /Choose a Background/i.test(o.oracleText ?? ''));
    if (!canBeCommander(e.card) && !backgroundPaired) err('NOT_A_COMMANDER', `${e.name} cannot be a commander.`, { cardName: e.name, zone: 'commander' });
  }
  if (commanderCards.length === 2 && counts.commander === 2) {
    const problem = pairProblem(commanderCards[0]!, commanderCards[1]!);
    if (problem) err('INVALID_PAIR', problem);
  }

  const size = counts.commander + counts.main;
  if (size !== COMMANDER_DECK_SIZE) {
    err('DECK_SIZE', `A Commander deck has exactly ${COMMANDER_DECK_SIZE} cards including its commander(s); this one has ${size}.`);
  }
  if (counts.sideboard > 0) warn('SIDEBOARD_IGNORED', 'Commander has no sideboard; those cards are not counted toward the 100.');

  const byName = new Map<string, { card: RuleCard; quantity: number }>();
  for (const e of known.filter((x) => x.zone !== 'sideboard')) {
    const slot = byName.get(e.card.name) ?? { card: e.card, quantity: 0 };
    slot.quantity += e.quantity;
    byName.set(e.card.name, slot);
  }
  for (const { card, quantity } of byName.values()) {
    const exception = copyException(card);
    const limit = exception === undefined ? 1 : exception;
    if (limit !== null && quantity > limit) {
      err('SINGLETON', `${card.name}: ${quantity} copies but the limit is ${limit}.`, { cardName: card.name });
    }
  }

  for (const e of known.filter((x) => x.zone !== 'sideboard')) {
    legalityIssue(e.card, 'commander', e.zone, err, warn);
    if (counts.commander > 0) {
      const off = e.card.colorIdentity.filter((c) => !identity.includes(c));
      if (off.length > 0) {
        err('COLOR_IDENTITY', `${e.card.name} has color identity outside the commander's (${off.join('')}).`, {
          cardName: e.card.name,
          zone: e.zone,
        });
      }
    }
  }
  void input;
}

function validateStandard(
  input: ValidationInput,
  known: (DeckEntry & { card: RuleCard })[],
  counts: { commander: number; main: number; sideboard: number; total: number },
  err: Report,
  warn: Report,
): void {
  if (counts.commander > 0) err('COMMANDER_IN_STANDARD', 'Standard decks have no commander zone.');
  if (counts.main < STANDARD_MIN_MAIN) {
    err('DECK_SIZE', `A Standard main deck has at least ${STANDARD_MIN_MAIN} cards; this one has ${counts.main}.`);
  }
  if (counts.sideboard > STANDARD_MAX_SIDEBOARD) {
    err('SIDEBOARD_SIZE', `A sideboard has at most ${STANDARD_MAX_SIDEBOARD} cards; this one has ${counts.sideboard}.`);
  }
  const byName = new Map<string, { card: RuleCard; quantity: number }>();
  for (const e of known) {
    const slot = byName.get(e.card.name) ?? { card: e.card, quantity: 0 };
    slot.quantity += e.quantity;
    byName.set(e.card.name, slot);
  }
  for (const { card, quantity } of byName.values()) {
    const exception = copyException(card);
    const limit = exception === undefined ? STANDARD_COPY_LIMIT : exception;
    if (limit !== null && quantity > limit) {
      err('COPY_LIMIT', `${card.name}: ${quantity} copies across main and sideboard but the limit is ${limit}.`, { cardName: card.name });
    }
  }
  for (const e of known) legalityIssue(e.card, 'standard', e.zone, err, warn);
  if (input.legalitySnapshotAt && input.legalitySnapshotAt.slice(0, 10) !== input.analysisDate.slice(0, 10)) {
    warn(
      'LEGALITY_SNAPSHOT',
      `Legality comes from the catalog read on ${input.legalitySnapshotAt.slice(0, 10)}, not ${input.analysisDate.slice(0, 10)}; a rotation between the two is not reflected.`,
    );
  }
}

/** Revalidate the same 99 under different commander entries. */
export function validateWithCommanders(input: ValidationInput, commanders: DeckEntry[]): ValidationResult {
  const rest = input.entries.filter((e) => e.zone !== 'commander');
  return validateDeck({ ...input, entries: [...commanders.map((c) => ({ ...c, zone: 'commander' as const })), ...rest] });
}
