// 1v1 and noncombat considerations for the seeded matchups. Statements about specific cards come
// from tags supplied by the caller (oracle data); nothing here invents card text.
export interface DeckTraits { readonly usesGoad: boolean; readonly ownLifeLossTrigger: boolean; readonly defenseIsAttackOnly: boolean; readonly noncombatDrain: boolean }

export function valueInPod(t: DeckTraits, opponents: number): { readonly goad: 'USEFUL' | 'WEAK_OR_HARMFUL' | 'NONE'; readonly note: string } {
  if (!t.usesGoad) return { goad: 'NONE', note: 'No goad.' };
  return opponents <= 1
    ? { goad: 'WEAK_OR_HARMFUL', note: 'In 1v1 goaded creatures must attack the only opponent\'s opposing player (you); goad is no protection and can hurt.' }
    : { goad: 'USEFUL', note: 'Multiplayer: goad redirects attacks, but kills it causes credit the attacker\'s controller.' };
}

export function attackOnlyDefenseStops(defenseIsAttackOnly: boolean, opponentNoncombatDrain: boolean): boolean {
  return defenseIsAttackOnly && !opponentNoncombatDrain;
}
