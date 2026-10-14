import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Ctx } from '../../context.ts';
import { parseDecklistText } from '../../decks/parse.ts';
import type { GameAdapter, MatchOptions, ResolutionChoices, ResolvedDeck } from '../types.ts';
import type { TutorKit } from '../../tutor/tutor.ts';
import { buildGuide, explainCard } from './guide.ts';
import { resolveDeck } from './resolve.ts';
import { FORMATS, forgeDeckSpec, validateCommander } from './validate.ts';
import { describePosition, explainOptions, explainRecent, explainUnavailable, legalActions, ruleOfThumb, viewerSafe } from './tutorContext.ts';
import { imageFor, type CardCatalog } from './catalog.ts';
import type { ParsedDeck } from '../../decks/parse.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/decks');

/** Opponent decks for practice: the other three Fallout Commander precons, verified lists. */
export const OPPONENT_DECKS = [
  { id: 'scrappy-survivors', name: 'Scrappy Survivors (Dogmeat, Ever Loyal)' },
  { id: 'mutant-menace', name: 'Mutant Menace (The Wise Mothman)' },
  { id: 'science', name: 'Science! (Dr. Madison Li)' },
];

export function fixtureText(id: string): string {
  if (!/^[a-z-]+$/.test(id)) throw new Error('unknown deck');
  return readFileSync(join(FIXTURES, `${id}.txt`), 'utf8');
}

export class MtgAdapter implements GameAdapter {
  readonly game = 'mtg';
  readonly label = 'Magic: The Gathering';

  constructor(private ctx: Ctx) {}

  formats() { return FORMATS; }

  resolve(parsed: ParsedDeck, choices: ResolutionChoices): Promise<ResolvedDeck> {
    return resolveDeck(this.ctx.catalog, parsed, choices);
  }

  validate(deck: ResolvedDeck, format: string) {
    if (format !== 'commander') throw new Error(`Format "${format}" is not implemented; only Commander is verified.`);
    return validateCommander(deck, { catalog: this.ctx.catalog, forge: this.ctx.forge, fetchImpl: this.ctx.fetchImpl });
  }

  async guide(deck: ResolvedDeck) {
    return buildGuide(deck, this.ctx.catalog, this.ctx.rules);
  }

  async explainCard(deck: ResolvedDeck | null, cardRef: string) {
    const card = this.ctx.catalog.byOracleId(cardRef) ?? this.ctx.catalog.exact(cardRef)[0]?.card ?? null;
    if (!card) return { error: `No card "${cardRef}" in the card catalog.` };
    return explainCard(card, deck, this.ctx.catalog, this.ctx.rules);
  }

  async createMatch(deck: ResolvedDeck, opts: MatchOptions) {
    const report = await this.validate(deck, 'commander');
    if (!report.playable) {
      const why = report.issues.filter((i) => i.blocking).map((i) => i.message).join(' ');
      throw new Error(`This deck cannot start an accurate practice match yet: ${why}`);
    }
    const ids = opts.opponentDecks.length ? opts.opponentDecks : OPPONENT_DECKS.slice(0, opts.opponents).map((d) => d.id);
    const opponents = [];
    for (const id of ids.slice(0, opts.opponents)) {
      const od = await resolveDeck(this.ctx.catalog, parseDecklistText(fixtureText(id)), {}, { checkPrintings: false });
      opponents.push({ name: `${OPPONENT_DECKS.find((d) => d.id === id)?.name.split(' (')[0] ?? id} (AI)`, deck: forgeDeckSpec(od) });
    }
    const m = await this.ctx.forge.createMatch(forgeDeckSpec(deck), opponents, opts.scenario);
    return { engineMatchId: m.matchId, mode: opts.opponents === 1 ? 'commander-2p' : `commander-${opts.opponents + 1}p`, players: m.players };
  }

  async matchState(id: string, after: number, waitMs: number) {
    const s = await this.ctx.forge.state(id, after, waitMs);
    return enrich(s, this.ctx.catalog);
  }

  act(id: string, revision: number, action: Record<string, unknown>) { return this.ctx.forge.act(id, revision, action); }
  setAutomation(id: string, settings: Record<string, unknown>) { return this.ctx.forge.automation(id, settings); }
  concede(id: string) { return this.ctx.forge.concede(id); }
  history(id: string) { return this.ctx.forge.history(id); }

  tutorKit(deck: ResolvedDeck | null): TutorKit {
    const { catalog, rules } = this.ctx;
    return {
      gameName: 'Magic: The Gathering (Commander)',
      viewerSafe: (s) => viewerSafe(s as Record<string, any>),
      describe: (safe) => describePosition(safe as Record<string, any>, catalog),
      legalActionIds: (safe) => new Map(legalActions(safe as Record<string, any>).map((a) => [a.id, a.label])),
      options: (safe) => explainOptions(safe as Record<string, any>, rules),
      unavailable: (safe, cardId) => explainUnavailable(safe as Record<string, any>, cardId, rules),
      recent: (safe, since) => explainRecent(safe as Record<string, any>, since, rules),
      ruleOfThumb: (safe) => ruleOfThumb(safe as Record<string, any>),
      explainCard: (ref) => this.explainCard(deck, ref),
    };
  }
}

/** Adds card images and catalog ids to visible cards; never adds information about hidden ones. */
function enrich(s: Record<string, any>, catalog: CardCatalog): Record<string, any> {
  const cache = new Map<string, { id: string; image: string | null; back: string | null } | null>();
  const look = (c: Record<string, any>) => {
    if (!c || c.hidden || !c.name) return;
    const key = `${c.oracleName ?? c.name}|${c.set ?? ''}|${c.collectorNumber ?? ''}`;
    if (!cache.has(key)) {
      const hit = catalog.exact(c.oracleName ?? c.name)[0]?.card ?? null;
      cache.set(key, hit ? { id: hit.oracle_id ?? hit.id, image: imageFor(hit, 0), back: hit.card_faces && !hit.image_uris ? imageFor(hit, 1) : null } : null);
    }
    const v = cache.get(key);
    if (v) { c.oracleId = v.id; c.image = v.image; c.backImage = v.back; }
  };
  for (const p of s.players ?? []) {
    for (const z of ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'revealedHand']) for (const c of p[z] ?? []) look(c);
  }
  for (const x of s.stack ?? []) look(x.source);
  for (const c of s.decision?.offeredCards ?? []) look(c);
  return s;
}
