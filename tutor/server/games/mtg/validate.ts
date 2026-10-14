import type { DeckIssue, DeckReport, ResolvedDeck, ResolvedLine } from '../types.ts';
import type { CardCatalog } from './catalog.ts';
import { cardText } from './catalog.ts';
import type { ForgeBridge, ForgeDeckSpec } from './forge.ts';
import { forgeScriptPath } from './forge.ts';

/**
 * Deck checks, in four separate kinds so each gets its own explanation and fix:
 *   recognition    — a line is not yet a known card (ask the person);
 *   format         — the deck breaks the selected format's deckbuilding rules;
 *   engine-support — a real, legal card the selected Forge build cannot play;
 *   engine-check   — Forge's own deck check disagreed.
 * Only Commander is implemented and verified; the rules applied are rule 903 of the
 * Comprehensive Rules and Scryfall's Commander legality.
 */
export const FORMATS = [
  { id: 'commander', label: 'Commander (multiplayer rules, 40 life, 21 commander damage)', verified: true,
    notes: 'Implements Comprehensive Rules 903: 100 cards including the commander, singleton, color identity, Commander banned list (via Scryfall). Practice matches use Forge\'s Commander game type — two-player practice keeps these rules; it is not Duel Commander.' },
];

const ANY_NUMBER = /a deck can have any number of cards named/i;
const UP_TO = /a deck can have up to (\w+) cards named/i;
const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export interface ValidateDeps { catalog: CardCatalog; forge: ForgeBridge; fetchImpl?: typeof fetch }

export async function validateCommander(deck: ResolvedDeck, deps: ValidateDeps): Promise<DeckReport> {
  const issues: DeckIssue[] = [];
  const inDeck = (l: ResolvedLine) => l.section === 'commander' || l.section === 'main';
  const counted = deck.lines.filter(inDeck);
  const total = counted.reduce((n, l) => n + l.quantity, 0);
  const sideboard = deck.lines.filter((l) => !inDeck(l)).reduce((n, l) => n + l.quantity, 0);
  const cmdLines = deck.lines.filter((l) => l.section === 'commander');

  // ---------------------------------------------------------------- recognition
  for (const p of deck.parseProblems) {
    issues.push({ kind: 'recognition', code: 'unreadable-line', message: `Line ${p.lineNo} could not be read: ${p.problem}`, correction: 'Edit the line, or remove it.', lineNos: [p.lineNo], cards: [], blocking: true });
  }
  for (const l of deck.lines) {
    if (l.status === 'resolved') continue;
    const code = l.status === 'ambiguous' ? 'ambiguous-name' : l.status === 'printing-mismatch' ? 'printing-mismatch' : 'unrecognized-name';
    issues.push({
      kind: 'recognition', code, message: `Line ${l.lineNo} ("${l.raw.trim()}"): ${l.message ?? 'not recognized.'}`,
      correction: l.candidates.length ? `Choose the card you own: ${l.candidates.join(' / ')}. Or correct the name.` : 'Correct the name, or remove the line.',
      lineNos: [l.lineNo], cards: [l.typedName], blocking: true,
    });
  }
  const resolved = counted.filter((l) => l.card);

  // ---------------------------------------------------------------- commander
  const commanders = deck.commanderIds.map((id) => resolved.find((l) => l.card!.id === id)?.card).filter((c): c is NonNullable<typeof c> => !!c);
  if (commanders.length === 0) {
    issues.push({
      kind: 'format', code: 'commander-unconfirmed',
      message: deck.commanderCandidates.length
        ? 'Which card is your commander? The list does not say, and it will not be guessed.'
        : 'No commander is set, and no card in the list can be a commander.',
      correction: deck.commanderCandidates.length ? `Confirm your commander: ${deck.commanderCandidates.map((c) => c.name).join(', ')}.` : 'Add your commander to the list and mark it as the commander.',
      lineNos: [], cards: deck.commanderCandidates.map((c) => c.name), blocking: true,
    });
  } else {
    for (const c of commanders) {
      if (!c.canBeCommander) {
        issues.push({ kind: 'format', code: 'commander-ineligible', message: `${c.name} cannot be a commander: a commander must be a legendary creature (or say it can be your commander).`, correction: 'Choose a legendary creature as your commander.', lineNos: lineNosOf(deck, c.id), cards: [c.name], blocking: true });
      }
    }
    const cmdQty = cmdLines.reduce((n, l) => n + l.quantity, 0);
    if (cmdQty > 2 || commanders.length > 2) {
      issues.push({ kind: 'format', code: 'too-many-commanders', message: `${cmdQty} cards are marked as commanders; Commander allows one, or two that partner.`, correction: 'Mark only your commander (or partner pair) in the commander section.', lineNos: cmdLines.map((l) => l.lineNo), cards: commanders.map((c) => c.name), blocking: true });
    } else if (commanders.length === 2 || cmdQty === 2) {
      const texts = commanders.map((c) => cardText(deps.catalog.byOracleId(c.id)!));
      const partners = texts.every((t) => /\bPartner\b|Friends forever|Doctor's companion/i.test(t)) || texts.some((t) => /Choose a Background/i.test(t));
      if (!partners) issues.push({ kind: 'format', code: 'commanders-not-partners', message: `${commanders.map((c) => c.name).join(' and ')} cannot both be commanders: two commanders must both have partner (or a pairing ability such as "Choose a Background").`, correction: 'Keep one as your commander and move the other into the deck.', lineNos: cmdLines.map((l) => l.lineNo), cards: commanders.map((c) => c.name), blocking: true });
    }
  }

  // ---------------------------------------------------------------- size and singleton
  if (total !== 100) {
    issues.push({ kind: 'format', code: 'deck-size', message: `A Commander deck has exactly 100 cards including the commander; this one has ${total}.`, correction: total > 100 ? `Remove ${total - 100} card(s), or move them to the sideboard section.` : `Add ${100 - total} card(s).`, lineNos: [], cards: [], blocking: true });
  }
  const byId = new Map<string, { lines: ResolvedLine[]; qty: number }>();
  for (const l of resolved) {
    const e = byId.get(l.card!.id) ?? { lines: [], qty: 0 };
    e.lines.push(l); e.qty += l.quantity;
    byId.set(l.card!.id, e);
  }
  for (const [id, e] of byId) {
    if (e.qty <= 1) continue;
    const card = deps.catalog.byOracleId(id);
    const text = card ? cardText(card) : '';
    const basic = /\bBasic\b/.test(e.lines[0]!.card!.typeLine);
    const upTo = text.match(UP_TO);
    const limit = basic || ANY_NUMBER.test(text) ? Infinity : upTo ? (WORDS[upTo[1]!.toLowerCase()] ?? Number(upTo[1])) : 1;
    if (e.qty > limit) {
      issues.push({ kind: 'format', code: 'singleton', message: `${e.lines[0]!.card!.name} appears ${e.qty} times; Commander allows only one copy of each card except basic lands${Number.isFinite(limit) && limit > 1 ? ` (this card allows ${limit})` : ''}.`, correction: `Keep ${Number.isFinite(limit) ? limit : 1} and remove the rest.`, lineNos: e.lines.map((l) => l.lineNo), cards: [e.lines[0]!.card!.name], blocking: true });
    }
  }

  // ---------------------------------------------------------------- color identity and legality
  if (commanders.length) {
    const identity = new Set(commanders.flatMap((c) => c.colorIdentity));
    const outside = resolved.filter((l) => l.section !== 'commander' && l.card!.colorIdentity.some((c) => !identity.has(c)));
    for (const l of outside) {
      issues.push({ kind: 'format', code: 'color-identity', message: `${l.card!.name} has color identity ${fmtColors(l.card!.colorIdentity)}, outside your commander's ${fmtColors([...identity])}.`, correction: 'Replace it with a card inside your commander\'s colors, or choose a commander whose identity includes it.', lineNos: [l.lineNo], cards: [l.card!.name], blocking: true });
    }
  }
  for (const [id, e] of byId) {
    const card = deps.catalog.byOracleId(id);
    const legality = card?.legalities?.commander;
    if (legality === 'banned') issues.push({ kind: 'format', code: 'banned', message: `${card!.name} is banned in Commander.`, correction: 'Replace it with a legal card.', lineNos: e.lines.map((l) => l.lineNo), cards: [card!.name], blocking: true });
    else if (legality === 'not_legal') issues.push({ kind: 'format', code: 'not-legal', message: `${card!.name} is not legal in Commander (for example a silver-bordered, acorn or ante card).`, correction: 'Replace it with a tournament-legal card.', lineNos: e.lines.map((l) => l.lineNo), cards: [card!.name], blocking: true });
  }
  if (sideboard > 0) {
    issues.push({ kind: 'format', code: 'sideboard-ignored', message: `${sideboard} card(s) in sideboard/maybeboard sections are kept with your deck but are not part of the 100 and are not used in Commander games.`, correction: 'Nothing to do, unless one of them belongs in the deck.', lineNos: deck.lines.filter((l) => !inDeck(l)).map((l) => l.lineNo), cards: [], blocking: false });
  }

  // ---------------------------------------------------------------- the engine
  const health = await deps.forge.health();
  let checked = 0;
  if (!health) {
    issues.push({ kind: 'engine-support', code: 'engine-unreachable', message: 'The Forge rules engine is not running, so card support could not be checked.', correction: 'Start it with `npm run bridge` (after `npm run forge:setup`) and check the deck again.', lineNos: [], cards: [], blocking: true });
  } else if (resolved.length) {
    const specs = resolved.map((l) => ({ name: l.card!.engineName, count: l.quantity, set: l.set, number: l.number }));
    const res = await deps.forge.checkCards(specs);
    checked = res.length;
    const unsupported = res.map((r, i) => ({ r, l: resolved[i]! })).filter((x) => !x.r.supported);
    for (const { l } of unsupported) {
      const newer = await newerForgeHasScript(l.card!.name, deps.fetchImpl ?? fetch);
      issues.push({
        kind: 'engine-support', code: 'unsupported-card',
        message: `${l.card!.name} is a real ${l.card!.typeLine} that this Forge build (${health.forgeRevision.slice(0, 10)}) has no script for, so a game with it could not be played accurately. It stays in your deck and in the study view.`,
        correction: newer === true
          ? 'Forge\'s current master branch does have a script for it: update the pinned Forge revision (tutor/forge/FORGE_REVISION) and re-run `npm run forge:setup`.'
          : newer === false
            ? 'Forge\'s current master branch does not support it either. Adding a card script for it in Forge (following its existing card scripts) is the fix; until then, practice with a deck that does not include it.'
            : 'Whether a newer Forge supports it could not be checked right now.',
        lineNos: [l.lineNo], cards: [l.card!.name], blocking: true,
      });
    }
    if (!unsupported.length && commanders.length && !issues.some((i) => i.blocking)) {
      const v = await deps.forge.validate(forgeDeckSpec(deck));
      if (!v.conforms) issues.push({ kind: 'engine-check', code: 'forge-deck-check', message: `Forge's own Commander deck check refused the deck: ${v.problem}`, correction: 'Review the cards it names; if the deck is legal, this is a Forge limitation to report.', lineNos: [], cards: [], blocking: true });
    }
  }

  return {
    format: 'commander',
    formatVerified: true,
    counts: { total, commander: cmdLines.reduce((n, l) => n + l.quantity, 0), main: total - cmdLines.reduce((n, l) => n + l.quantity, 0), sideboard },
    issues,
    playable: !!health && !issues.some((i) => i.blocking),
    engine: { name: 'Forge', revision: health?.forgeRevision ?? null, reachable: !!health, checkedCards: checked },
  };
}

export function forgeDeckSpec(deck: ResolvedDeck): ForgeDeckSpec {
  const spec: ForgeDeckSpec = { name: deck.name, commander: [], main: [] };
  for (const l of deck.lines) {
    if (!l.card) continue;
    const entry = { name: l.card.engineName, count: l.quantity, set: l.set, number: l.number };
    if (l.section === 'commander') spec.commander.push(entry);
    else if (l.section === 'main') spec.main.push(entry);
  }
  return spec;
}

async function newerForgeHasScript(name: string, fetchImpl: typeof fetch): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`https://raw.githubusercontent.com/Card-Forge/forge/master/${forgeScriptPath(name)}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

function lineNosOf(deck: ResolvedDeck, id: string): number[] {
  return deck.lines.filter((l) => l.card?.id === id).map((l) => l.lineNo);
}

function fmtColors(c: string[]): string {
  return c.length ? c.join('') : 'colorless';
}
