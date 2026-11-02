// League scoring: 1 point for each of the first two credited eliminations, 2 for the final one.
// Credit goes to the controller of the source that caused the elimination, never to whoever
// forced an attack. Ambiguous cases are surfaced for a house-rule decision, never assigned.
export type EliminationCause =
  | 'OWN_SPELL_OR_ABILITY' // the credited player's own spell, creature or ability
  | 'OWN_TRIGGER' // e.g. Kardur's own life-loss trigger
  | 'FORCED_ATTACK' // goad: the attacker's controller is credited
  | 'COMBAT_DAMAGE'
  | 'COMMANDER_DAMAGE'
  | 'SIMULTANEOUS'
  | 'ALTERNATE_LOSS';

export interface Elimination {
  readonly eliminated: string;
  readonly cause: EliminationCause;
  /** Controller of the source that caused it (for FORCED_ATTACK: the attacking creature's controller). */
  readonly creditedTo: string | null;
  /** Who forced the attack, recorded for the log; earns nothing. */
  readonly forcedBy?: string | null;
}

export interface HouseRules {
  /** Cause kinds a human has ruled on; absent => needs a ruling and scores nothing meanwhile. */
  readonly ruled: Partial<Record<'SIMULTANEOUS' | 'COMMANDER_DAMAGE' | 'ALTERNATE_LOSS', 'CREDIT_CONTROLLER' | 'NO_CREDIT'>>;
}

export interface ScoredElimination {
  readonly eliminated: string;
  readonly creditedTo: string | null;
  readonly points: number;
  readonly needsRuling: boolean;
  readonly note: string;
}

export function scoreGame(elims: readonly Elimination[], rules: HouseRules = { ruled: {} }): { readonly rows: ScoredElimination[]; readonly totals: Record<string, number> } {
  const rows: ScoredElimination[] = [];
  const totals: Record<string, number> = {};
  const n = elims.length;
  elims.forEach((e, i) => {
    const value = i === n - 1 && n > 1 ? 2 : 1;
    let credited = e.creditedTo;
    let needsRuling = false;
    let note = '';
    if (e.cause === 'SIMULTANEOUS' || e.cause === 'COMMANDER_DAMAGE' || e.cause === 'ALTERNATE_LOSS') {
      const r = rules.ruled[e.cause];
      if (r === undefined) { needsRuling = true; credited = null; note = `House rule needed for ${e.cause}; nothing assigned.`; }
      else if (r === 'NO_CREDIT') { credited = null; note = `House rule: ${e.cause} earns no points.`; }
    }
    if (e.cause === 'FORCED_ATTACK') note = `Forced attack: credited to the attacker's controller${e.forcedBy ? `, not ${e.forcedBy}` : ''}.`;
    const points = credited && !needsRuling ? value : 0;
    if (credited && points) totals[credited] = (totals[credited] ?? 0) + points;
    rows.push({ eliminated: e.eliminated, creditedTo: credited, points, needsRuling, note });
  });
  return { rows, totals };
}
