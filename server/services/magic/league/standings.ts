export interface GameResult { readonly points: Readonly<Record<string, number>> }
export function standings(games: readonly GameResult[]): { player: string; points: number; games: number }[] {
  const t = new Map<string, { points: number; games: number }>();
  for (const g of games) for (const [p, pts] of Object.entries(g.points)) {
    const cur = t.get(p) ?? { points: 0, games: 0 };
    t.set(p, { points: cur.points + pts, games: cur.games + 1 });
  }
  return [...t.entries()].map(([player, v]) => ({ player, ...v })).sort((a, b) => b.points - a.points || a.player.localeCompare(b.player));
}
