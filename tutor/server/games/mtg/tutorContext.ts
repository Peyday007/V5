import type { CardCatalog } from './catalog.ts';
import { cardText } from './catalog.ts';
import type { RulesBook } from './rules.ts';

/**
 * What the tutor may know about a Magic position, and the explanations it can give without a
 * language model. Everything starts from the engine's player-visible snapshot; this file narrows
 * it further (whitelisting fields) so that nothing an opponent holds secret — hand contents,
 * library order, face-down identities — can reach an explanation or a model prompt.
 */
export type Snap = Record<string, any>;
export interface LegalAction { id: string; label: string; category: string; cardId?: number; playerId?: number; affordable?: boolean; hasTargets?: boolean; cost?: string; text?: string }

export function viewerSafe(s: Snap): Snap {
  const human = s.humanPlayerId;
  const safeCard = (c: Snap) => (c?.hidden ? { id: c.id, hidden: true, name: 'Face-down card', tapped: c.tapped, controllerId: c.controllerId } : c);
  const players = (s.players ?? []).map((p: Snap) => {
    const base: Snap = {
      id: p.id, name: p.name, isHuman: p.isHuman, life: p.life, lost: p.lost, poison: p.poison, counters: p.counters,
      handCount: p.handCount, libraryCount: p.libraryCount, landsPlayedThisTurn: p.landsPlayedThisTurn, maxLandPlays: p.maxLandPlays,
      manaPool: p.manaPool,
      battlefield: (p.battlefield ?? []).map(safeCard), graveyard: (p.graveyard ?? []).map(safeCard),
      exile: (p.exile ?? []).map(safeCard), command: (p.command ?? []).map(safeCard),
      commanders: p.commanders, commanderDamageTaken: p.commanderDamageTaken,
    };
    if (p.id === human) base.hand = (p.hand ?? []).map(safeCard);
    else base.revealedHand = (p.revealedHand ?? []).filter((c: Snap) => !c.hidden);
    return base;
  });
  return {
    revision: s.revision, decisionSince: s.decisionSince ?? s.revision, status: s.status, turn: s.turn, phase: s.phase, phaseLabel: s.phaseLabel,
    activePlayerId: s.activePlayerId, priorityPlayerId: s.priorityPlayerId, humanPlayerId: human, gameType: s.gameType,
    players, stack: (s.stack ?? []).map((x: Snap) => ({ ...x, source: x.source ? safeCard(x.source) : null })),
    combat: s.combat ?? [], log: (s.log ?? []).slice(-40), decision: s.decision ?? null, outcome: s.outcome ?? null,
  };
}

export function legalActions(s: Snap): LegalAction[] {
  return (s.decision?.actions ?? []) as LegalAction[];
}

function nameOf(s: Snap, playerId: number): string {
  return (s.players ?? []).find((p: Snap) => p.id === playerId)?.name ?? `player ${playerId}`;
}

function cardLine(c: Snap): string {
  if (c.hidden) return 'face-down card';
  const pt = c.isCreature ? ` ${c.power}/${c.toughness}${c.damage ? ` (${c.damage} damage)` : ''}` : '';
  const flags = [c.tapped ? 'tapped' : '', c.sick ? 'summoning sick' : '', c.attacking ? 'attacking' : '', c.token ? 'token' : ''].filter(Boolean).join(', ');
  const counters = c.counters && Object.keys(c.counters).length ? ` [${Object.entries(c.counters).map(([k, v]) => `${v} ${k}`).join(', ')}]` : '';
  return `${c.name}${pt}${counters}${flags ? ` (${flags})` : ''}`;
}

/** A plain-text description of the viewer-safe position, used for model prompts and for tests. */
export function describePosition(safe: Snap, catalog: CardCatalog | null): string {
  const out: string[] = [];
  out.push(`Commander game (${safe.gameType}). Turn ${safe.turn}, ${safe.phaseLabel || safe.phase}. Active player: ${nameOf(safe, safe.activePlayerId)}. Priority: ${nameOf(safe, safe.priorityPlayerId)}.`);
  for (const p of safe.players) {
    out.push(`\n${p.isHuman ? 'YOU' : 'OPPONENT'} ${p.name}: life ${p.life}${p.poison ? `, poison ${p.poison}` : ''}; hand ${p.handCount} cards; library ${p.libraryCount}.`);
    if (p.commanders?.length) out.push(`  Commander(s): ${p.commanders.map((c: Snap) => `${c.name} (in ${c.zone.toLowerCase()}, cast ${c.timesCast} time(s), tax {${c.tax}})`).join('; ')}`);
    if (p.commanderDamageTaken?.length) out.push(`  Commander damage taken: ${p.commanderDamageTaken.map((d: Snap) => `${d.damage} from ${d.commander}`).join('; ')}`);
    out.push(`  Battlefield: ${p.battlefield.length ? p.battlefield.map(cardLine).join('; ') : 'nothing'}`);
    if (p.graveyard.length) out.push(`  Graveyard: ${p.graveyard.map((c: Snap) => c.name).join(', ')}`);
    if (p.exile.length) out.push(`  Exile: ${p.exile.map((c: Snap) => c.name).join(', ')}`);
    if (p.manaPool && Object.keys(p.manaPool).length) out.push(`  Floating mana: ${JSON.stringify(p.manaPool)}`);
    if (p.isHuman) {
      out.push(`  Your hand:`);
      for (const c of p.hand ?? []) {
        const sc = catalog ? catalog.exact(c.oracleName ?? c.name)[0]?.card : null;
        out.push(`   - ${c.name} ${c.manaCost ?? ''} — ${c.typeLine ?? ''}${sc ? `: ${cardText(sc).replace(/\n/g, ' ')}` : ''}`);
      }
      out.push(`  Lands played this turn: ${p.landsPlayedThisTurn}/${p.maxLandPlays}`);
    } else if (p.revealedHand?.length) {
      out.push(`  Cards in their hand you have seen revealed: ${p.revealedHand.map((c: Snap) => c.name).join(', ')}`);
    }
  }
  out.push(`\nStack (top first): ${safe.stack.length ? safe.stack.map((x: Snap) => `${x.description} [controller ${nameOf(safe, x.controllerId)}]`).join(' | ') : 'empty'}`);
  if (safe.combat?.length) out.push(`Combat: ${safe.combat.map((c: Snap) => `attacker #${c.attackerId} → ${c.defender}${c.blockerIds.length ? ` blocked by #${c.blockerIds.join(', #')}` : ' (unblocked)'}`).join('; ')}`);
  const d = safe.decision;
  if (d) {
    out.push(`\nForge is waiting for you: [${d.type}] ${d.prompt}`);
    out.push('Legal actions (id — label):');
    for (const a of d.actions ?? []) {
      out.push(` - ${a.id} — ${a.label}${a.affordable === false ? ' (cannot afford right now)' : ''}${a.hasTargets === false ? ' (no legal targets)' : ''}${a.cost ? ` cost ${a.cost}` : ''}`);
    }
  }
  out.push(`\nRecent game log:\n${safe.log.slice(-15).map((l: Snap) => ` ${l.message}`).join('\n')}`);
  return out.join('\n');
}

// ------------------------------------------------------------------ deterministic explanations

const PHASE_RULES: Record<string, string> = {
  UPKEEP: '503.1', DRAW: '504.1', MAIN1: '505.1', MAIN2: '505.1', COMBAT_BEGIN: '507.1', COMBAT_DECLARE_ATTACKERS: '508.1',
  COMBAT_DECLARE_BLOCKERS: '509.1', COMBAT_DAMAGE: '510.1', COMBAT_END: '511.1', END_OF_TURN: '513.1', CLEANUP: '514.1',
};

export interface Explanation {
  headline: string;
  points: string[];
  rules: Array<{ number: string; text: string }>;
  source: 'engine' | 'rules' | 'card-text' | 'rule-of-thumb' | 'model';
}

function rulesRefs(rules: RulesBook, numbers: string[]): Array<{ number: string; text: string }> {
  return numbers.map((n) => rules.rule(n)).filter((r): r is { number: string; text: string } => !!r);
}

/** "What can I do?" — the legal actions Forge offers, grouped and explained. */
export function explainOptions(s: Snap, rules: RulesBook): Explanation {
  const d = s.decision;
  if (!d) return { headline: 'Forge is not waiting for you right now — an opponent or the engine is acting.', points: [], rules: [], source: 'engine' };
  const acts = legalActions(s);
  const points: string[] = [];
  const refs: string[] = [];
  if (d.type === 'PassPriority') {
    const plays = acts.filter((a) => a.id.startsWith('play:'));
    const ready = plays.filter((a) => a.affordable !== false && a.hasTargets !== false);
    const blocked = plays.filter((a) => !(a.affordable !== false && a.hasTargets !== false));
    points.push(`You have priority${s.stack?.length ? ' with something on the stack — anything you cast now resolves before it (last in, first out).' : '.'}`);
    if (ready.length) points.push(`You can: ${ready.map((a) => a.label).join('; ')}.`);
    if (blocked.length) points.push(`Offered but not currently payable or targetable: ${blocked.map((a) => a.label).join('; ')}.`);
    points.push(s.stack?.length ? 'Passing lets the top object on the stack resolve once every player passes in a row.' : `Passing moves the game on from ${s.phaseLabel || s.phase} when every player passes with an empty stack.`);
    refs.push('117.3a', '117.4');
    if (s.stack?.length) refs.push('405.5');
    const pr = PHASE_RULES[s.phase];
    if (pr) refs.push(pr);
  } else if (d.type === 'Attack') {
    points.push('Declare attackers: choose each creature that attacks, and whom it attacks. Tapped or summoning-sick creatures cannot attack (unless they have haste).');
    points.push('Press the confirm button when your attackers are set; choosing none skips combat.');
    refs.push('508.1', '508.1a', '302.6');
  } else if (d.type === 'Block') {
    points.push('Declare blockers: first choose an attacking creature, then the creature of yours that blocks it. Each untapped creature can block one attacker.');
    refs.push('509.1', '509.1a');
  } else if (d.type.includes('PayMana')) {
    points.push('Pay the cost: tap lands or other mana sources one by one, or use Auto to let Forge pick the sources. Cancel backs out of casting it.');
    refs.push('601.2g', '601.2h', '106.4');
  } else if (d.type === 'ConfirmMulligan' || d.type === 'LondonMulligan') {
    points.push('Keep this hand, or mulligan: shuffle it away, draw seven new cards, then put one card on the bottom for each mulligan taken.');
    refs.push('103.5', '103.5c');
  } else if (d.type === 'SelectTargets') {
    points.push('Choose the target(s) for this spell or ability from the highlighted options; only legal targets are offered.');
    refs.push('115.1', '601.2c');
  } else {
    points.push(d.prompt);
    points.push(`Options: ${acts.map((a) => a.label).join('; ')}.`);
  }
  return { headline: d.prompt.split('\n')[0] ?? 'Your decision', points, rules: rulesRefs(rules, refs), source: 'engine' };
}

/** "Why can't I play this?" — Forge's own checks for one card. */
export function explainUnavailable(s: Snap, cardId: number, rules: RulesBook): Explanation {
  const me = (s.players ?? []).find((p: Snap) => p.isHuman);
  const all = [...(me?.hand ?? []), ...(me?.battlefield ?? []), ...(me?.command ?? []), ...(me?.graveyard ?? []), ...(me?.exile ?? [])];
  const card = all.find((c: Snap) => c.id === cardId);
  const name = card?.name ?? `card #${cardId}`;
  const d = s.decision;
  if (!d) return { headline: `Forge is not asking you for anything right now, so you cannot play ${name} at this moment.`, points: ['You can act again when Forge gives you priority or a decision.'], rules: rulesRefs(rules, ['117.1']), source: 'engine' };
  if (d.type !== 'PassPriority') {
    return {
      headline: `Right now Forge is asking you something else (${d.type}), so spells and abilities can't be started until that is answered.`,
      points: [`Current question: ${d.prompt.split('\n')[0]}`, 'Answer it first; you will get priority again afterwards when the rules give it to you.'],
      rules: rulesRefs(rules, ['117.1', '117.3']), source: 'engine',
    };
  }
  const offered = legalActions(s).filter((a) => a.cardId === cardId);
  const diag = (d.diagnoses ?? []).find((x: Snap) => x.cardId === cardId);
  const points: string[] = [];
  const refs = new Set<string>();
  for (const a of offered) {
    if (a.affordable !== false && a.hasTargets !== false) points.push(`Forge allows this now: ${a.label}.`);
    else if (a.affordable === false) { points.push(`${a.label}: Forge can't find a way to pay ${a.cost || 'its cost'} with your untapped sources and floating mana.`); refs.add('601.2g'); }
    else if (a.hasTargets === false) { points.push(`${a.label}: there is no legal target for it right now.`); refs.add('601.2c'); }
  }
  for (const r of diag?.reasons ?? []) {
    points.push(`${r.ability}: ${r.text}`);
    if (r.engineCheck === 'mana') refs.add('601.2g');
    if (r.engineCheck === 'targets') refs.add('601.2c');
    if (/sorcery speed|main phase/.test(r.text)) { refs.add('307.1'); refs.add('117.1a'); }
    if (/land/i.test(r.ability)) refs.add('305.2');
    if (/summoning sickness/.test(r.text)) refs.add('302.6');
  }
  if (!points.length) {
    if (!card) points.push(`${name} is not in a zone you can play it from right now.`);
    else if (card.zone === 'GRAVEYARD' || card.zone === 'EXILE') points.push(`${name} is in your ${card.zone.toLowerCase()}, and nothing currently lets you cast it from there.`);
    else if (card.zone === 'BATTLEFIELD') points.push(`${name} is already on the battlefield and has no ability you can activate right now (other than mana abilities, which you use while paying costs).`);
    else points.push(`Forge does not offer any play for ${name} in this position.`);
  }
  const playable = offered.some((a) => a.affordable !== false && a.hasTargets !== false);
  return {
    headline: playable ? `You can play ${name} right now.` : `Why you can't play ${name} right now`,
    points, rules: rulesRefs(rules, [...refs]), source: 'engine',
  };
}

/** "What just happened?" — the game log since a log sequence number, with rule pointers. */
export function explainRecent(s: Snap, sinceSeq: number, rules: RulesBook): Explanation {
  const lines = (s.log ?? []).filter((l: Snap) => l.seq > sinceSeq && !/'s (Untap|Upkeep|Draw|Cleanup) step$|Step$|phase, (pre|post)combat$/.test(l.message));
  const picked = lines.slice(-12);
  const refs = new Set<string>();
  const points = picked.map((l: Snap) => {
    const m: string = l.message;
    if (/ cast /.test(m)) refs.add('601.2');
    if (/triggered/.test(m)) refs.add('603.2');
    if (/combat damage/.test(m)) refs.add('510.1');
    if (/lost because|has won/.test(m)) refs.add('104.3a');
    if (/ played /.test(m)) refs.add('305.1');
    return m;
  });
  if (!points.length) points.push('Nothing notable happened since your last decision beyond moving through steps.');
  return { headline: 'What happened since your last decision', points, rules: rulesRefs(rules, [...refs]), source: 'engine' };
}

/**
 * A rule-of-thumb suggestion used when no language model is configured. It is labelled as such,
 * names only an action id from the current legal set, and never looks at anything hidden.
 */
export function ruleOfThumb(s: Snap): { actionId: string | null; reason: string; consequence: string } {
  const d = s.decision;
  if (!d) return { actionId: null, reason: 'Nothing to decide right now.', consequence: '' };
  const acts = legalActions(s);
  const me = (s.players ?? []).find((p: Snap) => p.isHuman);
  const myTurn = s.activePlayerId === s.humanPlayerId;
  if (d.type === 'ConfirmMulligan') {
    const lands = (me?.hand ?? []).filter((c: Snap) => c.isLand).length;
    if (lands >= 2 && lands <= 5) return { actionId: 'ok', reason: `Your hand has ${lands} lands — enough to cast spells without flooding.`, consequence: 'You keep these seven cards.' };
    return { actionId: 'cancel', reason: `Your hand has ${lands} lands; hands with 0–1 or 6+ lands usually do nothing.`, consequence: 'You shuffle and draw a new seven, then bottom one card per mulligan.' };
  }
  if (d.type === 'PassPriority') {
    const ready = acts.filter((a) => a.id.startsWith('play:') && a.affordable !== false && a.hasTargets !== false);
    const land = ready.find((a) => a.category === 'land');
    const main = myTurn && (s.phase === 'MAIN1' || s.phase === 'MAIN2') && !(s.stack?.length);
    if (main && land) return { actionId: land.id, reason: 'Playing a land every turn is the most reliable way to cast bigger spells later, and it costs nothing.', consequence: 'You use your land drop for this turn.' };
    const spells = ready.filter((a) => a.category === 'spell');
    const commander = spells.find((a) => (me?.commanders ?? []).some((c: Snap) => c.cardId === a.cardId));
    if (main && commander) return { actionId: commander.id, reason: 'Casting your commander puts your deck\'s engine on the battlefield.', consequence: 'Its next cast from the command zone will cost {2} more.' };
    if (main && spells.length) {
      const best = [...spells].sort((a, b) => costSize(b.cost) - costSize(a.cost))[0]!;
      return { actionId: best.id, reason: 'Using your mana each turn develops your board; the most expensive spell you can afford usually has the biggest effect.', consequence: 'It goes on the stack; opponents may respond before it resolves.' };
    }
    return { actionId: 'ok', reason: s.stack?.length ? 'You have nothing worth responding with, so let it resolve.' : 'Nothing useful to do at this point, so pass.', consequence: 'The game moves on once every player passes.' };
  }
  if (d.type === 'Attack') return { actionId: null, reason: 'Attack with creatures that would survive a block or that your opponent cannot block profitably; keep back blockers if their board is bigger than yours.', consequence: 'Choose attackers yourself, then confirm.' };
  if (d.type === 'Block') return { actionId: null, reason: 'Block when the trade is good for you or when the damage would hurt you badly; avoid chump blocks while your life is high.', consequence: 'Choose blocks yourself, then confirm.' };
  if (d.type.includes('PayMana') && acts.some((a) => a.id === 'ok')) return { actionId: 'ok', reason: 'Auto-pay picks mana sources for you; tap manually only when you need to save a specific color for later.', consequence: 'The cost is paid and the spell or ability goes ahead.' };
  return { actionId: null, reason: 'This choice depends on the card\'s text; read the options and pick the one that best fits your plan.', consequence: '' };
}

function costSize(cost?: string): number {
  if (!cost) return 0;
  let n = 0;
  for (const m of cost.matchAll(/\{([^}]+)\}|(\d+)/g)) {
    const t = m[1] ?? m[2] ?? '';
    n += /^\d+$/.test(t) ? Number(t) : 1;
  }
  return n;
}
