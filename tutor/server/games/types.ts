import type { ParsedDeck } from '../decks/parse.ts';

/**
 * The boundary between the shared shell (deck storage, interface, tutor plumbing) and one card
 * game. Everything game-specific — what a card is, what a legal deck is, how a match is run, what
 * a turn looks like — lives behind it. Magic is the only implementation; a Pokémon adapter would
 * supply its own card database, rules engine, zones and actions through the same shape.
 */
export interface GameAdapter {
  readonly game: string;
  readonly label: string;
  /** Formats this adapter has actually implemented and verified. Nothing else is offered. */
  formats(): FormatInfo[];
  /** Turns parsed lines into resolved cards, asking rather than guessing. */
  resolve(parsed: ParsedDeck, choices: ResolutionChoices): Promise<ResolvedDeck>;
  /** Format and engine checks over a resolved deck. */
  validate(deck: ResolvedDeck, format: string): Promise<DeckReport>;
  /** A teaching overview of a deck. */
  guide(deck: ResolvedDeck): Promise<unknown>;
  /** One card, explained for this deck. */
  explainCard(deck: ResolvedDeck | null, cardRef: string): Promise<unknown>;
  /** Starts a match; refuses unless the report says the deck can be played accurately. */
  createMatch(deck: ResolvedDeck, opts: MatchOptions): Promise<{ engineMatchId: string; mode: string; players: number }>;
  /** Viewer-safe state and pending decision, after the given revision. */
  matchState(engineMatchId: string, after: number, waitMs: number): Promise<MatchSnapshot>;
  /** Submits one engine action id against the revision it was offered for. */
  act(engineMatchId: string, revision: number, action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  setAutomation(engineMatchId: string, settings: Record<string, unknown>): Promise<unknown>;
  concede(engineMatchId: string): Promise<void>;
  history(engineMatchId: string): Promise<unknown[]>;
}

export interface FormatInfo { id: string; label: string; verified: boolean; notes: string }

/** A person's answers to questions resolution asked earlier (line number → choice). */
export interface ResolutionChoices {
  names?: Record<string, string>;   // lineNo → chosen card name
  commander?: string[];             // chosen commander card ids
  removed?: number[];               // lineNos the person chose to drop (never done automatically)
}

export type LineStatus = 'resolved' | 'ambiguous' | 'unrecognized' | 'printing-mismatch';

export interface ResolvedLine {
  lineNo: number;
  raw: string;
  quantity: number;
  typedName: string;
  section: string;
  status: LineStatus;
  card: CardSummary | null;
  /** For ambiguous / unrecognized lines: names to choose from. */
  candidates: string[];
  message: string | null;
  set: string | null;
  number: string | null;
  printingFound: boolean | null;
}

export interface CardSummary {
  id: string;            // oracle id
  name: string;
  engineName: string;    // what the rules engine calls it
  typeLine: string;
  manaCost: string;
  cmc: number;
  colorIdentity: string[];
  image: string | null;
  backImage: string | null;
  faces: number;
  layout: string;
  isLegendaryCreature: boolean;
  canBeCommander: boolean;
}

export interface ResolvedDeck {
  game: string;
  name: string;
  lines: ResolvedLine[];
  commanderIds: string[];
  commanderSource: 'stated' | 'confirmed' | 'none';
  commanderCandidates: Array<{ id: string; name: string }>;
  parseProblems: Array<{ lineNo: number; raw: string; problem: string }>;
}

export type IssueKind = 'recognition' | 'format' | 'engine-support' | 'engine-check';

export interface DeckIssue {
  kind: IssueKind;
  code: string;
  message: string;
  correction: string;
  lineNos: number[];
  cards: string[];
  blocking: boolean;
}

export interface DeckReport {
  format: string;
  formatVerified: boolean;
  counts: { total: number; commander: number; main: number; sideboard: number };
  issues: DeckIssue[];
  playable: boolean;
  engine: { name: string; revision: string | null; reachable: boolean; checkedCards: number };
}

export interface MatchOptions {
  opponents: number;
  opponentDecks: string[];
  /** Test scenarios only (engine's own state-setup format); refused unless TUTOR_BRIDGE_SCENARIOS=1. */
  scenario?: string[];
}

export interface MatchSnapshot { [key: string]: unknown }
