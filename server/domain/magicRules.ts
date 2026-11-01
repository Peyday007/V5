/**
 * Magic rule data that is verified and committed rather than matched loosely by
 * name: the cards whose printed text lifts the deck-building limits, the
 * partner-style pairings, and the format constants.
 *
 * Nothing here is learned from a model. A card gets a limit exception because
 * its printed text says so (checked from oracle text where the catalog has it)
 * or because it is on `ANY_NUMBER_CARDS` below, which lists cards by exact
 * oracle name with the printed limit. The ban list is deliberately not
 * duplicated here: legality comes from the catalog's `legalities`, which is the
 * source that carries a date.
 */
import type { MagicColor } from './magicTypes.ts';

export const COMMANDER_DECK_SIZE = 100;
export const STANDARD_MIN_MAIN = 60;
export const STANDARD_MAX_SIDEBOARD = 15;
export const STANDARD_COPY_LIMIT = 4;

/** Exact oracle names whose printed text allows more than the format's copy limit. null = any number. */
export const ANY_NUMBER_CARDS: Readonly<Record<string, number | null>> = {
  'Relentless Rats': null,
  'Persistent Petitioners': null,
  'Rat Colony': null,
  'Shadowborn Apostle': null,
  "Dragon's Approach": null,
  'Hare Apparent': null,
  'Slime Against Humanity': null,
  'Tempest Hawk': null,
  'Cid, Timeless Artificer': null,
  'Seven Dwarves': 7,
  'Nazgûl': 9,
};

export const ANY_NUMBER_TEXT = /a deck can have any number of cards named/i;
export const LIMITED_NUMBER_TEXT = /a deck can have up to (\w+) cards named/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

export function numberWord(word: string): number | null {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return NUMBER_WORDS[lower] ?? null;
}

export const COLOR_ORDER: readonly MagicColor[] = ['W', 'U', 'B', 'R', 'G'];
