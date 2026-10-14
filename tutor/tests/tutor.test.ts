import { describe, expect, it } from 'vitest';
import { viewerSafe, legalActions, describePosition, ruleOfThumb } from '../server/games/mtg/tutorContext.ts';
import { ask, type TutorKit } from '../server/tutor/tutor.ts';
import type { CoachModel } from '../server/tutor/llm.ts';
import { answersCurrentDecision } from '../server/app.ts';

/** A position shaped like the bridge's snapshot, with an opponent's hand and library the player must not see. */
function position(): Record<string, any> {
  return {
    revision: 12, decisionSince: 10, status: 'waiting', turn: 3, phase: 'MAIN1', phaseLabel: 'Main phase', gameType: 'Commander',
    activePlayerId: 1, priorityPlayerId: 1, humanPlayerId: 1,
    players: [
      { id: 1, name: 'You', isHuman: true, life: 40, handCount: 2, libraryCount: 90,
        hand: [{ id: 101, name: 'Sol Ring', zone: 'HAND' }, { id: 102, name: 'Plains', zone: 'HAND', isLand: true }],
        battlefield: [], graveyard: [], exile: [], command: [], commanders: [] },
      { id: 2, name: 'Mutant Menace (AI)', isHuman: false, life: 40, handCount: 7, libraryCount: 92,
        hand: [{ id: 201, name: 'SECRET OPPONENT CARD', zone: 'HAND' }],
        library: [{ id: 202, name: 'SECRET TOP CARD' }],
        revealedHand: [{ id: 203, hidden: true, name: 'SECRET FACE DOWN' }],
        battlefield: [{ id: 204, hidden: true, name: 'SECRET MORPH', tapped: false, controllerId: 2 }], graveyard: [], exile: [], command: [], commanders: [] },
    ],
    stack: [], combat: [], log: [{ seq: 1, type: 'ZONE', message: 'You played Plains.' }],
    decision: {
      kind: 'input', type: 'PassPriority', prompt: 'Priority: You',
      actions: [
        { id: 'play:102:1', label: 'Play Plains', category: 'land', cardId: 102 },
        { id: 'play:101:2', label: 'Cast Sol Ring', category: 'spell', cardId: 101, affordable: true, hasTargets: true },
        { id: 'ok', label: 'Pass priority', category: 'button' },
      ],
    },
  };
}

const kit = (): TutorKit => ({
  gameName: 'Magic', viewerSafe: (s) => viewerSafe(s as any), describe: (s) => describePosition(s as any, null),
  legalActionIds: (s) => new Map(legalActions(s as any).map((a) => [a.id, a.label])),
  options: () => ({ headline: 'options', points: [], rules: [], source: 'test' }),
  unavailable: () => ({ headline: 'why', points: [], rules: [], source: 'test' }),
  recent: () => ({ headline: 'recent', points: [], rules: [], source: 'test' }),
  ruleOfThumb: (s) => ruleOfThumb(s as any), explainCard: async () => null,
});

function model(answer: unknown, seen: string[] = []): CoachModel {
  return { configured: true, label: 'test model', json: async (_sys, user) => { seen.push(user); return answer; } };
}

describe('what the tutor may see', () => {
  it('drops opponents\' hands, libraries and face-down identities', () => {
    const safe = viewerSafe(position());
    const text = JSON.stringify(safe) + describePosition(safe, null);
    expect(text).not.toMatch(/SECRET/);
    expect(safe.players[1].hand).toBeUndefined();
    expect(safe.players[1].handCount).toBe(7);
    expect(safe.players[0].hand.map((c: any) => c.name)).toEqual(['Sol Ring', 'Plains']);
  });

  it('never puts hidden information into a model prompt', async () => {
    const seen: string[] = [];
    await ask(kit(), model({ recommendedActionId: 'ok', reason: 'r', consequence: 'c', alternatives: [] }, seen), position(), 'recommend');
    expect(seen.length).toBe(1);
    expect(seen[0]).not.toMatch(/SECRET/);
  });
});

describe('recommendations', () => {
  it('are a legal action at the current revision', async () => {
    const a = await ask(kit(), model({ recommendedActionId: 'play:102:1', reason: 'land drop', consequence: 'more mana', alternatives: [{ actionId: 'play:101:2', why: 'ramp' }, { actionId: 'bogus', why: 'x' }] }), position(), 'recommend');
    expect(a.recommendation).toMatchObject({ actionId: 'play:102:1', label: 'Play Plains', source: 'model', revision: 12 });
    expect(a.recommendation!.alternatives.map((x) => x.actionId)).toEqual(['play:101:2']);
  });

  it('discard a model suggestion that is not a legal action', async () => {
    const a = await ask(kit(), model({ recommendedActionId: 'play:999:1', reason: 'x', consequence: 'y', alternatives: [] }), position(), 'recommend');
    expect(a.recommendation!.source).toBe('rule-of-thumb');
    expect(a.model.error).toMatch(/not a legal action/);
  });

  it('still work, labelled as a rule of thumb, with no model or a failing one', async () => {
    const none: CoachModel = { configured: false, label: 'none', json: async () => { throw new Error('unused'); } };
    const failing: CoachModel = { configured: true, label: 'slow', json: async () => { throw new Error('timed out'); } };
    for (const m of [none, failing]) {
      const a = await ask(kit(), m, position(), 'recommend');
      expect(a.recommendation!.source).toBe('rule-of-thumb');
      expect(['play:102:1', 'play:101:2', 'ok', null]).toContain(a.recommendation!.actionId);
    }
  });

  it('go stale only when the decision changes, not on a redraw of the same decision', () => {
    const s = position();
    expect(answersCurrentDecision(s, 12)).toBe(true);
    expect(answersCurrentDecision(s, 10)).toBe(true);
    expect(answersCurrentDecision(s, 9)).toBe(false);
    expect(answersCurrentDecision({ ...s, decision: null }, 10)).toBe(false);
  });
});
