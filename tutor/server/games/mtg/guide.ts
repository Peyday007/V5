import type { ResolvedDeck, ResolvedLine } from '../types.ts';
import type { CardCatalog } from './catalog.ts';
import { cardText, imageFor, typeLine } from './catalog.ts';
import type { RulesBook } from './rules.ts';
import type { ScryfallCard } from './scryfall.ts';

/**
 * Teaching material computed from the deck's own cards: what each card does for the deck, which
 * keywords it uses (with their rules), its curve and mana, and interactions between cards that
 * are actually in it. Everything here is derived from Oracle text; nothing is invented, and the
 * card text is always shown beside the summary.
 */
export type Role =
  | 'commander' | 'land' | 'ramp' | 'draw' | 'removal' | 'wipe' | 'tokens' | 'anthem'
  | 'sac-outlet' | 'death-payoff' | 'drain' | 'recursion' | 'protection' | 'equipment' | 'tutor' | 'combat';

export const ROLE_LABELS: Record<Role, string> = {
  commander: 'Commander', land: 'Land', ramp: 'Mana / ramp', draw: 'Card advantage', removal: 'Removal',
  wipe: 'Board wipe', tokens: 'Makes tokens', anthem: 'Pumps your team', 'sac-outlet': 'Sacrifice outlet',
  'death-payoff': 'Rewards creatures dying', drain: 'Drains life', recursion: 'Brings cards back',
  protection: 'Protection', equipment: 'Equipment / Aura', tutor: 'Searches library', combat: 'Combat boost',
};

const ROLE_RULES: Array<[Role, RegExp]> = [
  ['ramp', /\badd \{|search your library for (?:up to (?:one|two) )?(?:a )?(?:basic )?land|treasure token|you may play an additional land/i],
  ['draw', /\bdraw (?:a|two|three|x|that many) cards?|draws? (?:a|two) cards?|investigate|exile the top .* you may play/i],
  ['removal', /(destroy|exile) (?:up to one )?target (?:creature|permanent|nonland|artifact|enchantment|planeswalker)|deals? \w+ damage to (?:any|target creature)|target (?:creature|player) sacrifices|fights? target/i],
  ['wipe', /(destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents)|each (?:player|opponent) sacrifices (?:all|a creature)|all creatures get -/i],
  ['tokens', /create[sd]? (?:a|an|one|two|three|four|x|that many|\w+) .*tokens?/i],
  ['anthem', /creatures you control get \+|other (?:\w+ )?creatures you control get \+|creature tokens you control get \+/i],
  ['sac-outlet', /sacrifice (?:a|another|an?other) (?:creature|artifact|permanent|token)(?:[^.]*)?:/i],
  ['death-payoff', /whenever (?:a|another|one or more) (?:nontoken )?creatures? (?:you control )?(?:dies|die)|whenever you sacrifice/i],
  ['drain', /each opponent loses \d+ life|target opponent loses \w+ life|each opponent loses/i],
  ['recursion', /return (?:target |up to )?.*from your graveyard to (?:the battlefield|your hand)/i],
  ['protection', /\b(hexproof|indestructible|protection from)\b.*(?:until end of turn|creatures you control)|phase out/i],
  ['equipment', /\bequip \{|enchant creature/i],
  ['tutor', /search your library for (?:a|an|up to one) (?!basic land|land)/i],
  ['combat', /attacking creatures you control|whenever you attack|double strike|additional combat/i],
];

export interface GuideCard {
  id: string;
  name: string;
  quantity: number;
  typeLine: string;
  manaCost: string;
  cmc: number;
  roles: Role[];
  image: string | null;
}

export interface Interaction { cards: string[]; how: string }

export interface DeckGuide {
  commander: { name: string; text: string; typeLine: string; manaCost: string; image: string | null; explanation: string[]; colorIdentity: string[] } | null;
  plan: string[];
  winConditions: string[];
  roles: Array<{ role: Role; label: string; count: number; cards: string[] }>;
  keyCards: GuideCard[];
  keywords: Array<{ keyword: string; count: number; cards: string[]; rule: { number: string; text: string } | null }>;
  curve: Array<{ cmc: string; count: number }>;
  mana: { lands: number; manaRocksAndRamp: number; sourcesByColor: Record<string, number>; averageLandsInOpeningHand: number };
  mulligan: string[];
  interactions: Interaction[];
  cards: GuideCard[];
  sources: string[];
}

export function rolesOf(card: ScryfallCard, isCommander = false): Role[] {
  const out: Role[] = [];
  if (isCommander) out.push('commander');
  const tl = typeLine(card);
  if (/\bLand\b/.test(tl) && !/\/\//.test(tl)) { out.push('land'); return out; }
  const text = cardText(card);
  for (const [role, re] of ROLE_RULES) if (re.test(text) && !out.includes(role)) out.push(role);
  if (/\bEquipment\b|\bAura\b/.test(tl) && !out.includes('equipment')) out.push('equipment');
  return out;
}

export function buildGuide(deck: ResolvedDeck, catalog: CardCatalog, rules: RulesBook): DeckGuide {
  const lines = deck.lines.filter((l) => l.card && (l.section === 'main' || l.section === 'commander'));
  const cards: Array<{ line: ResolvedLine; sc: ScryfallCard; gc: GuideCard }> = [];
  for (const l of lines) {
    const sc = catalog.byOracleId(l.card!.id);
    if (!sc) continue;
    const isCmd = deck.commanderIds.includes(l.card!.id);
    cards.push({ line: l, sc, gc: { id: l.card!.id, name: l.card!.name, quantity: l.quantity, typeLine: l.card!.typeLine, manaCost: l.card!.manaCost, cmc: l.card!.cmc, roles: rolesOf(sc, isCmd), image: l.card!.image } });
  }
  const commanders = cards.filter((c) => deck.commanderIds.includes(c.gc.id));
  const cmd = commanders[0];

  // Roles
  const roleMap = new Map<Role, string[]>();
  for (const c of cards) for (const r of c.gc.roles) {
    const list = roleMap.get(r) ?? [];
    for (let i = 0; i < (r === 'land' ? c.gc.quantity : 1); i++) list.push(c.gc.name);
    roleMap.set(r, list);
  }
  const roles = [...roleMap.entries()]
    .filter(([r]) => r !== 'commander')
    .map(([role, names]) => ({ role, label: ROLE_LABELS[role], count: names.length, cards: [...new Set(names)] }))
    .sort((a, b) => b.count - a.count);
  const count = (r: Role) => roleMap.get(r)?.length ?? 0;

  // Keywords, with the rule that defines each
  const kw = new Map<string, Set<string>>();
  for (const c of cards) for (const k of c.sc.keywords ?? []) {
    const s = kw.get(k) ?? new Set<string>();
    s.add(c.gc.name);
    kw.set(k, s);
  }
  const keywords = [...kw.entries()]
    .map(([keyword, set]) => {
      const head = rules.keywordRule(keyword);
      const first = head ? rules.rule(`${head.number}a`) : null;
      const gloss = head ? null : rules.glossary(keyword) ?? rules.glossary(`${keyword} Token`);
      const rule = head ? { number: first?.number ?? head.number, text: first?.text ?? head.text } : gloss ? { number: 'Glossary', text: gloss.split('\n').slice(1).join(' ') } : null;
      return { keyword, count: set.size, cards: [...set], rule };
    })
    .sort((a, b) => b.count - a.count);

  // Curve and mana
  const curveMap = new Map<string, number>();
  for (const c of cards) {
    if (c.gc.roles.includes('land')) continue;
    const k = c.gc.cmc >= 7 ? '7+' : String(Math.floor(c.gc.cmc));
    curveMap.set(k, (curveMap.get(k) ?? 0) + c.gc.quantity);
  }
  const curve = ['0', '1', '2', '3', '4', '5', '6', '7+'].map((k) => ({ cmc: k, count: curveMap.get(k) ?? 0 }));
  const lands = count('land');
  const identity = cmd ? cmd.line.card!.colorIdentity : [];
  const sourcesByColor: Record<string, number> = {};
  for (const col of identity) sourcesByColor[col] = 0;
  for (const c of cards) {
    const text = cardText(c.sc);
    if (!c.gc.roles.includes('land') && !c.gc.roles.includes('ramp')) continue;
    for (const col of identity) {
      const basicType = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' }[col]!;
      if (new RegExp(`\\{${col}\\}`).test(text) || new RegExp(basicType).test(typeLine(c.sc)) || /any color|commander's color identity/i.test(text)) {
        sourcesByColor[col] = (sourcesByColor[col] ?? 0) + c.gc.quantity;
      }
    }
  }
  const total = cards.reduce((n, c) => n + c.gc.quantity, 0) - commanders.length;
  const avgLands = total > 0 ? Math.round((lands / total) * 7 * 10) / 10 : 0;

  // Interactions between cards actually in the deck
  const names = (r: Role) => cards.filter((c) => c.gc.roles.includes(r)).map((c) => c.gc.name);
  const interactions: Interaction[] = [];
  const tok = names('tokens'), ant = names('anthem'), sac = names('sac-outlet'), dp = names('death-payoff'), drain = names('drain');
  if (tok.length && ant.length) interactions.push({ cards: [...ant.slice(0, 3), ...tok.slice(0, 3)], how: `Your token makers (${tok.length} cards) fill the board with small creatures; ${ant.slice(0, 2).join(' and ')} make every one of them bigger at once.` });
  if (tok.length && sac.length) interactions.push({ cards: [...sac.slice(0, 3), ...tok.slice(0, 3)], how: `Tokens are free fodder for your sacrifice outlets (${sac.slice(0, 3).join(', ')}): sacrifice them for value, especially in response to removal or a board wipe.` });
  if (sac.length && dp.length) interactions.push({ cards: [...sac.slice(0, 2), ...dp.slice(0, 3)], how: `Each creature you sacrifice also triggers ${dp.slice(0, 3).join(', ')} — one action, two payoffs.` });
  if (dp.length && drain.length) interactions.push({ cards: [...dp.slice(0, 2), ...drain.slice(0, 2)], how: `Life drain (${drain.slice(0, 3).join(', ')}) turns a stream of dying creatures into damage to every opponent — this is how the deck finishes games that stall on the ground.` });
  const wipes = names('wipe');
  if (wipes.length && tok.length) interactions.push({ cards: [...wipes.slice(0, 2)], how: `${wipes.slice(0, 2).join(' / ')} can reset the board when you are behind; your token makers rebuild faster than most opponents afterwards.` });
  if (cmd) {
    const t = cardText(cmd.sc);
    const partners = cards.filter((c) => c !== cmd && c.gc.roles.some((r) => (/token/i.test(t) && (r === 'anthem' || r === 'sac-outlet' || r === 'death-payoff')) || (/attack/i.test(t) && r === 'combat'))).map((c) => c.gc.name);
    if (partners.length) interactions.push({ cards: [cmd.gc.name, ...partners.slice(0, 4)], how: `${cmd.gc.name}'s ability feeds ${partners.slice(0, 4).join(', ')}.` });
  }

  // Plan and win conditions, from the counts
  const plan: string[] = [];
  if (cmd) plan.push(`Your deck is led by ${cmd.gc.name} (${identity.join('') || 'colorless'}). You can cast it from the command zone every game; each later cast costs {2} more.`);
  if (count('tokens') >= 8) plan.push(`Go wide: ${count('tokens')} cards make creature tokens, so you will usually have more bodies than your opponents.`);
  if (count('anthem') >= 2) plan.push(`Then make the team bigger: ${count('anthem')} cards pump all your creatures, turning a field of tokens into a real attack.`);
  if (count('sac-outlet') + count('death-payoff') >= 5) plan.push(`Sacrifice for value: ${count('sac-outlet')} sacrifice outlets and ${count('death-payoff')} cards that reward creatures dying make trading creatures good for you.`);
  if (count('ramp') >= 8) plan.push(`Early turns: play lands and mana rocks (${count('ramp')} ramp cards) so you can cast your commander on turn 3 or 4.`);
  if (count('removal') + count('wipe') >= 6) plan.push(`Answer threats with ${count('removal')} targeted removal spells and ${count('wipe')} board wipes; save wipes for when you are behind on board.`);
  if (count('draw') >= 6) plan.push(`Keep your hand full with ${count('draw')} card-advantage cards.`);
  const winConditions: string[] = [];
  if (count('anthem') + count('tokens') >= 8) winConditions.push('A wide token attack, made lethal by anthems or combat boosts.');
  if (count('drain') >= 3) winConditions.push(`Drain: ${names('drain').slice(0, 4).join(', ')} make opponents lose life as your creatures die or enter.`);
  if (cmd && /commander damage|attacks?/i.test(cardText(cmd.sc))) winConditions.push(`Attacking with ${cmd.gc.name}: 21 combat damage from a commander to one player wins (rule 903.10a / 704.6c).`);
  const finishers = cards.filter((c) => /you win the game|extra combat|additional combat|each opponent loses (?:x|half)/i.test(cardText(c.sc))).map((c) => c.gc.name);
  if (finishers.length) winConditions.push(`Finishers: ${finishers.join(', ')}.`);

  // Mulligan advice
  const mulligan: string[] = [
    `Your deck has ${lands} lands in ${total} cards, so an average opening hand has about ${avgLands} lands.`,
    'Keep a seven-card hand with 3–4 lands, or 2 lands plus a mana rock you can cast on turn 2.',
  ];
  if (cmd) {
    const cost = cmd.line.card!.manaCost;
    mulligan.push(`Check colors: ${cmd.gc.name} costs ${cost}. A hand that can make every color of that cost by turn 3–4 lets you cast your commander on time.`);
    for (const [col, n] of Object.entries(sourcesByColor)) mulligan.push(`${n} of your lands and mana cards can make {${col}}.`);
  }
  mulligan.push('Mulligan hands with 0–1 lands or 6–7 lands. Mulligans use the London rule: draw seven again, then put one card on the bottom per mulligan (rule 103.5).');
  mulligan.push('With three or more players your first mulligan is free (rule 103.5c). In two-player practice it is not — Forge applies the rule the same way.');

  const keyCards = cards
    .filter((c) => !c.gc.roles.includes('land'))
    .map((c) => ({ c, score: c.gc.roles.length + (c.gc.roles.includes('commander') ? 10 : 0) + (c.gc.roles.includes('wipe') || c.gc.roles.includes('anthem') || c.gc.roles.includes('death-payoff') ? 2 : 0) + (finishers.includes(c.gc.name) ? 3 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => x.c.gc);

  return {
    commander: cmd ? {
      name: cmd.gc.name, text: cardText(cmd.sc), typeLine: typeLine(cmd.sc), manaCost: cmd.line.card!.manaCost,
      image: imageFor(cmd.sc, 0), colorIdentity: identity, explanation: explainCommander(cmd.sc, identity),
    } : null,
    plan, winConditions, roles, keyCards, keywords, curve,
    mana: { lands, manaRocksAndRamp: count('ramp'), sourcesByColor, averageLandsInOpeningHand: avgLands },
    mulligan, interactions, cards: cards.map((c) => c.gc),
    sources: ['Card text and legality: Scryfall Oracle data', 'Rules: Magic Comprehensive Rules (see rule numbers)', 'Roles and interactions: computed from this deck\'s Oracle text by the tutor'],
  };
}

function explainCommander(c: ScryfallCard, identity: string[]): string[] {
  const text = cardText(c);
  const out: string[] = [];
  out.push(`Color identity ${identity.join('') || 'colorless'}: every card in your deck must use only these colors (rule 903.4).`);
  const sentences = text.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (/^Whenever you attack/i.test(s)) out.push(`Attack trigger: ${s} It triggers once per combat when you attack with any creatures, so attacking with even one token turns it on.`);
    else if (/^Whenever/i.test(s)) out.push(`Trigger: ${s}`);
    else if (/^\{.*\}:/.test(s)) out.push(`Activated ability: ${s} You can use it any time you have priority unless it says otherwise.`);
    else if (/^(Flying|Trample|Haste|Vigilance|Lifelink|Deathtouch|First strike|Menace)/i.test(s)) out.push(`Keyword: ${s}.`);
    else out.push(s);
  }
  return out;
}

/** A single card explained for a person learning it, in the context of their deck when given. */
export function explainCard(card: ScryfallCard, deck: ResolvedDeck | null, catalog: CardCatalog, rules: RulesBook) {
  const isCmd = !!deck?.commanderIds.includes(card.oracle_id ?? '');
  const roles = rolesOf(card, isCmd);
  const keywordRules = (card.keywords ?? []).map((k) => {
    const head = rules.keywordRule(k);
    return { keyword: k, rule: head ? rules.section(head.number, 4) : [] };
  });
  const plain: string[] = [];
  const tl = typeLine(card);
  plain.push(`${card.name} is a ${tl}${card.mana_cost ? ` that costs ${card.mana_cost}` : ''}.`);
  if (/Creature/.test(tl) && card.power) plain.push(`It is a ${card.power}/${card.toughness} creature: it deals ${card.power} damage in combat and is destroyed by ${card.toughness} damage in one turn.`);
  if (/Instant/.test(tl)) plain.push('As an instant you can cast it at almost any time you have priority, including during an opponent\'s turn or in response to a spell.');
  if (/Sorcery/.test(tl)) plain.push('As a sorcery you can cast it only in your own main phase while the stack is empty.');
  if (/Land/.test(tl)) plain.push('You can play one land per turn, during your main phase, when the stack is empty. Playing a land does not use the stack.');
  for (const r of roles) if (r !== 'land' && r !== 'commander') plain.push(`Role in a deck: ${ROLE_LABELS[r]}.`);
  if ((card.card_faces?.length ?? 0) > 1) plain.push(`It has ${card.card_faces!.length} faces (${card.card_faces!.map((f) => f.name).join(' / ')}); both are shown.`);

  const inDeck: string[] = [];
  if (deck) {
    const others = deck.lines.filter((l) => l.card && l.card.id !== card.oracle_id && (l.section === 'main' || l.section === 'commander'));
    const otherRoles = others.map((l) => ({ name: l.card!.name, roles: rolesOf(catalog.byOracleId(l.card!.id) ?? ({} as ScryfallCard)) }));
    const withRole = (r: Role) => otherRoles.filter((o) => o.roles.includes(r)).map((o) => o.name);
    if (roles.includes('tokens')) { const p = [...withRole('anthem'), ...withRole('sac-outlet')]; if (p.length) inDeck.push(`Its tokens pair with ${p.slice(0, 4).join(', ')} in your deck.`); }
    if (roles.includes('anthem')) { const p = withRole('tokens'); if (p.length) inDeck.push(`It makes the creatures from ${p.slice(0, 4).join(', ')} bigger.`); }
    if (roles.includes('sac-outlet')) { const p = withRole('death-payoff'); if (p.length) inDeck.push(`Sacrificing with it also triggers ${p.slice(0, 4).join(', ')}.`); }
    if (roles.includes('death-payoff')) { const p = withRole('sac-outlet'); if (p.length) inDeck.push(`It is fueled by your sacrifice outlets: ${p.slice(0, 4).join(', ')}.`); }
    if (roles.includes('ramp')) inDeck.push('It helps you reach your commander and bigger spells sooner.');
    if (roles.includes('wipe')) inDeck.push('Hold it until a board wipe helps you more than your opponents — usually when you are behind on creatures.');
    if (isCmd) inDeck.push('This is your commander: it starts in the command zone and can be cast from there; each cast from the command zone costs {2} more than the last (rule 903.8).');
  }
  return {
    id: card.oracle_id ?? card.id, name: card.name, typeLine: tl, manaCost: card.mana_cost ?? null, text: cardText(card),
    faces: (card.card_faces ?? []).map((f, i) => ({ name: f.name, typeLine: f.type_line ?? '', manaCost: f.mana_cost ?? '', text: f.oracle_text ?? '', image: imageFor(card, i) })),
    image: imageFor(card, 0, 'large'), roles: roles.map((r) => ROLE_LABELS[r]), plain, inDeck, keywordRules,
    rulings: catalog.rulings(card.oracle_id ?? '').slice(0, 8),
    legalities: { commander: card.legalities?.commander ?? 'unknown' },
    source: card.scryfall_uri ?? null,
  };
}
