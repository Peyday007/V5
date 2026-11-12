/**
 * Incompatible goals, what they cost, and 2-3 coherent ways out. A conflict is
 * named; its cost is stated in deck-building terms (slots and roles), never as
 * a made-up probability.
 */
import type { Alternative, Conflict, DesignIntent, DesignPlan, Question } from './types.ts';

const hasCloser = (i: DesignIntent) =>
  i.winEngines.length > 0 || i.archetypes.some((a) => ['aggro', 'combo', 'life-drain', 'go-wide'].includes(a));

export function detectConflicts(i: DesignIntent): Conflict[] {
  const out: Conflict[] = [];
  const open = (id: Conflict['id']) => !i.resolved.includes(id);
  if (i.defensive && i.speed === 'fast' && open('DEFENSIVE_VS_FAST_CLOSE')) {
    out.push({
      id: 'DEFENSIVE_VS_FAST_CLOSE',
      name: 'Defensive and fast-winning',
      cost:
        'Interaction, lifegain and sweepers take slots that a fast clock needs for threats and ramp. A deck that spends ' +
        'about a third of its nonland slots stopping the table has fewer slots to present a quick win, so it either wins later or defends less.',
    });
  } else if (i.defensive && !hasCloser(i) && open('DEFENSIVE_NO_CLOSER')) {
    out.push({
      id: 'DEFENSIVE_NO_CLOSER',
      name: 'Defensive with no closing path',
      cost: 'A deck that only answers things never ends the game; games run long and the table gets turns to find answers of its own.',
    });
  }
  if (i.curve === 'high' && !i.earlyMana && !i.secondaryPreferences.includes('ramp') && open('HIGH_CURVE_NO_EARLY_MANA')) {
    out.push({
      id: 'HIGH_CURVE_NO_EARLY_MANA',
      name: 'High curve with no early mana',
      cost: 'Expensive spells with no ramp are stranded in hand for several turns, which is the most common way such a deck loses.',
    });
  }
  return out;
}

export function alternativesFor(c: Conflict): Alternative[] {
  switch (c.id) {
    case 'DEFENSIVE_VS_FAST_CLOSE':
      return [
        {
          id: 'fortress-drain', conflict: c.id, title: 'Fortress with a drain finish',
          summary: 'Keep the defence; close with noncombat life loss so the finish does not depend on attacking through blockers.',
          tradeoffs: ['Keeps removal and lifegain at full strength.', 'Wins in the middle game rather than early.', 'Drain finishes are weak to lifegain and to being hated out.'],
          patch: { speed: 'medium', addWinEngines: ['lifedrain'], addArchetypes: ['life-drain'] },
        },
        {
          id: 'fast-light-defence', conflict: c.id, title: 'Fast clock with light defence',
          summary: 'Prioritise the quick win; keep a few cheap answers and incidental lifegain rather than a wall.',
          tradeoffs: ['Wins early when the draw cooperates.', 'Fewer answers: a single sweeper or removal spell on your threat hurts more.', 'Less able to stabilise after falling behind.'],
          patch: { defensive: false, addWinEngines: ['combat'], addPreferences: ['removal'], addArchetypes: ['aggro'] },
        },
        {
          id: 'protected-threats', conflict: c.id, title: 'Few threats, heavily protected',
          summary: 'A small number of strong win conditions backed by protection and counters, accepting a slower, safer finish.',
          tradeoffs: ['Threats survive removal and sweepers.', 'Relies on few cards, so it is less redundant.', 'Slower than the fast clock you asked for.'],
          patch: { speed: 'medium', addPreferences: ['protection', 'counter'] },
        },
      ];
    case 'DEFENSIVE_NO_CLOSER':
      return [
        { id: 'add-drain', conflict: c.id, title: 'Add a noncombat drain finish', summary: 'Close with life loss that ignores blockers.', tradeoffs: ['Ends games without attacking.', 'Slower and easy to disrupt with lifegain.'], patch: { addWinEngines: ['lifedrain'], addArchetypes: ['life-drain'] } },
        { id: 'add-tokens', conflict: c.id, title: 'Add a go-wide finish', summary: 'Close with a swarm once the table is stable.', tradeoffs: ['Cheap to rebuild after a sweeper.', 'Vulnerable to mass removal.'], patch: { addWinEngines: ['tokens'], addArchetypes: ['go-wide'] } },
        { id: 'add-combo', conflict: c.id, title: 'Add a small combo finish', summary: 'A short list of win-the-game pieces behind the defence.', tradeoffs: ['Ends the game decisively.', 'Few pieces, so more single-card reliance.'], patch: { addWinEngines: ['combo'], addArchetypes: ['combo'] } },
      ];
    case 'HIGH_CURVE_NO_EARLY_MANA':
      return [
        { id: 'add-ramp', conflict: c.id, title: 'Add mana ramp', summary: 'Pay for the curve with ramp and mana rocks.', tradeoffs: ['Casts the big spells on time.', 'Ramp cards are weak late.'], patch: { earlyMana: true, addPreferences: ['ramp'] } },
        { id: 'lower-curve', conflict: c.id, title: 'Lower the curve', summary: 'Trade the biggest spells for cheaper ones.', tradeoffs: ['More consistent early turns.', 'Less top-end power.'], patch: { curve: 'low' } },
      ];
  }
}

export function planDesign(intent: DesignIntent): DesignPlan {
  const conflicts = detectConflicts(intent);
  const assumptions = [...intent.assumptions];
  if (conflicts.length === 0) {
    return { state: 'COHERENT', intent, conflicts, alternatives: [], question: null, assumptions };
  }
  const first = conflicts[0]!;
  const alternatives = alternativesFor(first);
  // One decision at most: the first conflict is asked, the rest wait their turn.
  for (const later of conflicts.slice(1)) {
    assumptions.push(`${later.name} is not decided yet; it will be raised after the current question.`);
  }
  const question: Question = {
    conflict: first.id,
    text: `${first.name}: ${first.cost} Which direction do you want?`,
    options: alternatives.map((a) => ({ id: a.id, title: a.title })),
  };
  return { state: 'NEEDS_DECISION', intent, conflicts, alternatives, question, assumptions };
}

/** Apply a chosen alternative; the conflict is resolved and recorded. */
export function chooseAlternative(intent: DesignIntent, altId: string): DesignIntent {
  const conflicts = detectConflicts(intent);
  for (const c of conflicts) {
    const alt = alternativesFor(c).find((a) => a.id === altId);
    if (!alt) continue;
    const next: DesignIntent = JSON.parse(JSON.stringify(intent));
    const p = alt.patch;
    if (p.speed !== undefined) next.speed = p.speed;
    if (p.defensive !== undefined) next.defensive = p.defensive;
    if (p.curve !== undefined) next.curve = p.curve;
    if (p.earlyMana !== undefined) next.earlyMana = p.earlyMana;
    if (p.risk !== undefined) next.risk = p.risk;
    next.winEngines = [...new Set([...next.winEngines, ...(p.addWinEngines ?? [])])];
    next.secondaryPreferences = [...new Set([...next.secondaryPreferences, ...(p.addPreferences ?? [])])];
    next.archetypes = [...new Set([...next.archetypes.filter((a) => a !== 'custom'), ...(p.addArchetypes ?? [])])];
    next.resolved = [...next.resolved, c.id];
    next.revision = intent.revision + 1;
    next.history = [...intent.history, { revision: next.revision, utterance: `chose: ${alt.title}` }];
    next.weights = {
      consistency: next.risk === 'consistency' ? 2 : 1,
      speed: next.speed === 'fast' ? 2 : 1,
      interaction: next.defensive ? 2 : 1,
      closing: next.speed === 'fast' || next.winEngines.length ? 2 : 1,
    };
    return next;
  }
  throw new Error(`No open conflict offers the alternative "${altId}".`);
}
