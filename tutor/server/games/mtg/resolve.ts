import type { ParsedDeck } from '../../decks/parse.ts';
import type { CardSummary, ResolutionChoices, ResolvedDeck, ResolvedLine } from '../types.ts';
import { CardCatalog, imageFor, normName, typeLine } from './catalog.ts';
import type { ScryfallCard } from './scryfall.ts';

/**
 * Card recognition for Magic. Exact names resolve; a front-face name resolves for cards people
 * name that way (double-faced, adventure, flip); anything else is a question for the person —
 * never a silent substitution.
 */
export async function resolveDeck(catalog: CardCatalog, parsed: ParsedDeck, choices: ResolutionChoices = {}, opts: { checkPrintings?: boolean } = {}): Promise<ResolvedDeck> {
  const removed = new Set(choices.removed ?? []);
  const lines: ResolvedLine[] = [];
  if (opts.checkPrintings !== false) {
    try {
      await catalog.prefetchPrintings(parsed.lines.filter((p) => p.set && p.number).map((p) => ({ set: p.set!, number: p.number! })));
    } catch { /* checked one by one below, and reported per line if still unreachable */ }
  }
  for (const p of parsed.lines) {
    if (removed.has(p.lineNo)) continue;
    const chosen = choices.names?.[String(p.lineNo)];
    const typed = chosen ?? p.name;
    const line: ResolvedLine = {
      lineNo: p.lineNo, raw: p.raw, quantity: p.quantity, typedName: p.name, section: p.section,
      status: 'unrecognized', card: null, candidates: [], message: null, set: p.set, number: p.number, printingFound: null,
    };
    const matches = catalog.exact(typed);
    const full = matches.filter((m) => m.kind === 'FULL');
    const faces = matches.filter((m) => m.kind === 'FACE');
    if (full.length === 1) {
      line.status = 'resolved';
      line.card = summarize(full[0]!.card);
    } else if (full.length > 1) {
      line.status = 'ambiguous';
      line.candidates = full.map((m) => m.card.name);
      line.message = `More than one card is named "${typed}". Choose which one you own.`;
    } else if (faces.length === 1) {
      const card = faces[0]!.card;
      const isFront = normName(card.card_faces?.[0]?.name ?? '') === normName(typed);
      if (CardCatalog.usesFrontFaceName(card) && isFront) {
        line.status = 'resolved';
        line.card = summarize(card);
        line.message = `"${typed}" is the front face of ${card.name}.`;
      } else {
        line.status = 'ambiguous';
        line.candidates = [card.name];
        line.message = `"${typed}" is one half of ${card.name}. Confirm that is the card you own.`;
      }
    } else if (faces.length > 1) {
      line.status = 'ambiguous';
      line.candidates = faces.map((m) => m.card.name);
      line.message = `"${typed}" is a face of more than one card. Choose which one you own.`;
    } else {
      line.status = 'unrecognized';
      line.candidates = catalog.suggest(typed);
      line.message = line.candidates.length
        ? `No card is named "${typed}". Did you mean one of these?`
        : `No card is named "${typed}", and nothing close was found. Check the spelling, or remove the line.`;
    }

    if (line.status === 'resolved' && p.set && p.number && opts.checkPrintings !== false) {
      try {
        const printing = await catalog.printing(p.set, p.number);
        if (!printing) {
          line.printingFound = false;
          line.message = joinMsg(line.message, `Scryfall has no printing ${p.set} #${p.number}; the card is kept, with its default image.`);
        } else if (printing.oracle_id && line.card && printing.oracle_id !== line.card.id) {
          line.status = 'printing-mismatch';
          line.candidates = [line.card.name, printing.name];
          line.message = `${p.set} #${p.number} is ${printing.name}, not ${line.card.name}. Choose which card you own.`;
        } else {
          line.printingFound = true;
          const img = imageFor(printing, 0);
          if (line.card && img) {
            line.card = { ...line.card, image: img, backImage: imageFor(printing, 1) };
          }
        }
      } catch {
        line.printingFound = null;
        line.message = joinMsg(line.message, `The printing ${p.set} #${p.number} could not be checked right now.`);
      }
    }
    lines.push(line);
  }

  // The commander: what the file stated, unless the person confirmed something else.
  let commanderIds: string[] = [];
  let source: ResolvedDeck['commanderSource'] = 'none';
  if (choices.commander && choices.commander.length) {
    commanderIds = choices.commander.filter((id) => lines.some((l) => l.card?.id === id));
    source = 'confirmed';
    for (const l of lines) {
      if (!l.card) continue;
      if (commanderIds.includes(l.card.id)) l.section = 'commander';
      else if (l.section === 'commander') l.section = 'main';
    }
  } else if (parsed.commanderStated) {
    commanderIds = lines.filter((l) => l.section === 'commander' && l.card).map((l) => l.card!.id);
    source = commanderIds.length ? 'stated' : 'none';
  }
  const seen = new Set<string>();
  const commanderCandidates = lines
    .filter((l) => l.card && l.card.canBeCommander && (l.section === 'main' || l.section === 'commander'))
    .map((l) => ({ id: l.card!.id, name: l.card!.name }))
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  return {
    game: 'mtg',
    name: parsed.name ?? 'Imported deck',
    lines,
    commanderIds,
    commanderSource: source,
    commanderCandidates,
    parseProblems: parsed.problems,
  };
}

export function summarize(c: ScryfallCard): CardSummary {
  const tl = typeLine(c);
  const frontType = c.card_faces?.[0]?.type_line ?? tl;
  const legendaryCreature = /Legendary/.test(frontType) && /Creature/.test(frontType);
  const text = (c.oracle_text ?? c.card_faces?.map((f) => f.oracle_text).join('\n') ?? '');
  return {
    id: c.oracle_id ?? c.id,
    name: c.name,
    engineName: CardCatalog.forgeName(c),
    typeLine: tl,
    manaCost: c.mana_cost ?? c.card_faces?.map((f) => f.mana_cost ?? '').filter(Boolean).join(' // ') ?? '',
    cmc: c.cmc ?? 0,
    colorIdentity: c.color_identity ?? [],
    image: imageFor(c, 0),
    backImage: c.card_faces && !c.image_uris ? imageFor(c, 1) : null,
    faces: c.card_faces?.length ?? 1,
    layout: c.layout,
    isLegendaryCreature: legendaryCreature,
    canBeCommander: legendaryCreature || /can be your commander/i.test(text) || /Legendary/.test(frontType) && /Background/.test(frontType),
  };
}

function joinMsg(a: string | null, b: string): string {
  return a ? `${a} ${b}` : b;
}
