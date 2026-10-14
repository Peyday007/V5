import type { Db } from './store/db.ts';
import { nowIso } from './store/db.ts';

/**
 * The learning profile and match records. Events are appended as the game happens; the profile
 * counts what was practised and what was misunderstood; a review is computed from the events
 * afterwards. Nothing here promises undo, branching or resume — it is a record of what happened.
 */
export const CONCEPTS: Record<string, string> = {
  mulligan: 'Mulligans and opening hands',
  'main-phase': 'Using your main phase (lands and spells)',
  'stack-response': 'Responding while something is on the stack',
  'mana-payment': 'Paying mana costs',
  targeting: 'Choosing targets',
  attacking: 'Declaring attackers',
  blocking: 'Declaring blockers',
  choices: 'Card choices and modes',
  'commander-tax': 'Commander tax and recasting',
  timing: 'When you may cast what (timing)',
};

export function conceptFor(decisionType: string, ctx: { stackSize: number; myTurn: boolean; phase: string }): string {
  if (/Mulligan/.test(decisionType)) return 'mulligan';
  if (/PayMana/.test(decisionType)) return 'mana-payment';
  if (decisionType === 'SelectTargets') return 'targeting';
  if (decisionType === 'Attack') return 'attacking';
  if (decisionType === 'Block') return 'blocking';
  if (decisionType === 'PassPriority') return ctx.stackSize > 0 ? 'stack-response' : 'main-phase';
  return 'choices';
}

export function recordEvent(db: Db, matchId: string, kind: string, data: unknown): void {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM match_events WHERE match_id = ?').get(matchId) as { n: number };
  db.prepare('INSERT INTO match_events (match_id, seq, kind, json, at) VALUES (?, ?, ?, ?, ?)').run(matchId, r.n + 1, kind, JSON.stringify(data), nowIso());
}

export function events(db: Db, matchId: string): Array<{ seq: number; kind: string; data: any; at: string }> {
  return (db.prepare('SELECT seq, kind, json, at FROM match_events WHERE match_id = ? ORDER BY seq').all(matchId) as Array<{ seq: number; kind: string; json: string; at: string }>)
    .map((r) => ({ seq: r.seq, kind: r.kind, data: JSON.parse(r.json), at: r.at }));
}

export function bump(db: Db, concept: string, field: 'practiced' | 'misunderstood', note?: string): void {
  const label = CONCEPTS[concept] ?? concept;
  db.prepare(`INSERT INTO learning (concept, label, practiced, misunderstood, last_note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(concept) DO UPDATE SET ${field} = ${field} + 1, last_note = COALESCE(excluded.last_note, last_note), updated_at = excluded.updated_at`)
    .run(concept, label, field === 'practiced' ? 1 : 0, field === 'misunderstood' ? 1 : 0, note ?? null, nowIso());
}

export function profile(db: Db) {
  const rows = db.prepare('SELECT concept, label, practiced, misunderstood, last_note AS lastNote, updated_at AS updatedAt FROM learning ORDER BY misunderstood DESC, practiced DESC').all() as Array<{ concept: string; label: string; practiced: number; misunderstood: number; lastNote: string | null; updatedAt: string }>;
  const revisit = rows.filter((r) => r.misunderstood > 0).map((r) => r.label);
  const unseen = Object.entries(CONCEPTS).filter(([k]) => !rows.some((r) => r.concept === k)).map(([, v]) => v);
  return { concepts: rows, revisit, notYetPracticed: unseen };
}

export interface ReviewItem { kind: 'illegal-attempt' | 'debatable' | 'good'; turn: number | null; title: string; detail: string }

/** A short review: a few meaningful decisions and one next lesson tied to the deck. */
export function review(db: Db, matchId: string, deckGuide: { keyCards?: Array<{ name: string; cmc: number; roles: string[] }>; commander?: { name: string } | null } | null) {
  const ev = events(db, matchId);
  const items: ReviewItem[] = [];
  let missed = 0, illegalTiming = 0, illegal = 0, commanderCasts = 0, tutorAsks = 0, followed = 0, recs = 0;
  let lastDecision: any = null;
  let lastRec: string | null = null;
  for (const e of ev) {
    if (e.kind === 'decision') { lastDecision = e.data; continue; }
    if (e.kind === 'tutor') {
      tutorAsks++;
      if (e.data.recommendedActionId) { lastRec = e.data.recommendedActionId; recs++; }
      continue;
    }
    if (e.kind !== 'action') continue;
    const a = e.data;
    if (!a.accepted && !/earlier position/.test(a.error ?? '')) {
      illegal++;
      if (/timing|sorcery|main phase/i.test(a.error ?? '')) illegalTiming++;
      if (items.filter((i) => i.kind === 'illegal-attempt').length < 2) items.push({ kind: 'illegal-attempt', turn: a.turn ?? null, title: `Tried: ${a.label ?? a.id}`, detail: `Forge refused it: ${a.error}. This was not legal in that position — not a strategy question.` });
      continue;
    }
    if (lastRec) { if (a.id === lastRec) followed++; lastRec = null; }
    if (a.isCommanderCast) commanderCasts++;
    if (lastDecision?.type === 'PassPriority' && a.id === 'ok' && lastDecision.myTurn && /MAIN/.test(lastDecision.phase ?? '') && (lastDecision.readySpells?.length ?? 0) > 0 && !lastDecision.stackSize) {
      missed++;
      if (items.filter((i) => i.kind === 'debatable').length < 2) items.push({ kind: 'debatable', turn: a.turn ?? null, title: `Passed your main phase with ${lastDecision.readySpells.length} castable spell(s)`, detail: `You could have cast ${lastDecision.readySpells.slice(0, 3).join(', ')}. Holding cards can be right (bluffing, waiting for a better moment), so this is a judgment call — but unused mana usually means a slower board.` });
    }
  }
  const outcome = ev.find((e) => e.kind === 'outcome')?.data ?? null;
  if (outcome?.humanWon) items.push({ kind: 'good', turn: outcome.turns ?? null, title: 'You won the game', detail: 'Look at which cards carried the win — those are the ones to learn first.' });

  let lesson: { title: string; why: string; cards: string[] };
  const cheap = (deckGuide?.keyCards ?? []).filter((c) => c.cmc <= 3).map((c) => c.name).slice(0, 4);
  if (illegalTiming > 0) lesson = { title: 'Timing: sorcery speed versus instant speed', why: `${illegalTiming} attempt(s) were refused for timing. Creatures, sorceries and most permanents need your main phase with an empty stack; instants and abilities can be used whenever you have priority.`, cards: [] };
  else if (missed >= 2) lesson = { title: 'Spend your mana every turn', why: `You passed ${missed} main phases with castable spells. Plan each turn around a land drop plus spells that use the rest of your mana.`, cards: cheap };
  else if (commanderCasts === 0 && deckGuide?.commander) lesson = { title: `Getting ${deckGuide.commander.name} onto the battlefield`, why: 'Your commander was never cast. Its ability is the engine of this deck — aim to cast it on turn 3 or 4 with ramp.', cards: [deckGuide.commander.name] };
  else if (illegal > 0) lesson = { title: 'Reading what Forge offers', why: 'Use "What can I do?" before acting: it lists exactly what is legal right now.', cards: [] };
  else lesson = { title: 'Combat math', why: 'Next, practise attacking and blocking: count power against toughness before each combat and decide what you are willing to trade.', cards: [] };

  return {
    matchId, outcome, items: items.slice(0, 4), lesson,
    stats: { actions: ev.filter((e) => e.kind === 'action').length, illegalAttempts: illegal, debatablePasses: missed, tutorQuestions: tutorAsks, recommendationsGiven: recs, recommendationsFollowed: followed },
    note: 'This review is built from the recorded decisions of this game. Forge does not offer undo or replay of a position here, so the review describes choices rather than replaying them.',
  };
}
