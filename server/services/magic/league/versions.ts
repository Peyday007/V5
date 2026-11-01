// Opponent deck versions: an observation creates a new version; the baseline snapshot is never mutated.
export interface OpponentVersion {
  readonly version: number;
  readonly commander: string | 'UNKNOWN';
  readonly source: 'BASELINE' | 'OBSERVED';
  readonly observedOn: string | null;
  readonly cardsRevealed: readonly string[];
}

export function applyObservation(history: readonly OpponentVersion[], obs: { commander?: string; revealed?: readonly string[]; on: string }): OpponentVersion[] {
  const cur = history[history.length - 1];
  if (!cur) throw new Error('An opponent needs a baseline version before observations.');
  const commander = obs.commander ?? cur.commander;
  const revealed = [...new Set([...cur.cardsRevealed, ...(obs.revealed ?? [])])];
  const changed = commander !== cur.commander || revealed.length !== cur.cardsRevealed.length;
  if (!changed) return [...history];
  return [...history, { version: cur.version + 1, commander, source: 'OBSERVED', observedOn: obs.on, cardsRevealed: revealed }];
}
