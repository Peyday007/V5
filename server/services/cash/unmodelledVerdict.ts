import type { GoalPortfolio } from '../goals/portfolio.ts';

/**
 * The verdict of a goal model with no found opening to model (`composeGoalModel`).
 *
 * Production, 2026-11-21 (91bf9ef8, five goals): every plan read printed "No
 * live opportunity is far enough along to model" while the same reading had
 * modelled six to twelve constructed estimates and its best combination
 * settled a median $40,338 against a $50,000 target. The sentence described
 * the found openings only, and so contradicted the portfolio printed under it.
 *
 * The old sentence stands only when nothing at all was modelled. When
 * constructed estimates were, the verdict says how many, what the best
 * combination of them reaches and settles, against what target, and that its
 * reach is coverage of assumed inputs, never a probability (§60, §95).
 */
export function unmodelledVerdict(liveCount: number, portfolio: GoalPortfolio | null, currency: string): string {
  const found =
    liveCount === 0
      ? 'There is no live opportunity in this project to build a plan from'
      : 'No live opportunity is far enough along to model: each one is evidence only or has no price anywhere';
  const estimates = (portfolio?.demand ?? []).filter((one) => one.opportunityId.startsWith('arr_'));
  const modelled = estimates.filter((one) => !one.refused);
  if (!portfolio || modelled.length === 0) return `${found}.`;
  const money = (x: number) => `${currency} ${Math.round(x).toLocaleString('en-US')}`;
  const refused = estimates.length - modelled.length;
  // The old reason ("evidence only or has no price") is not every exclusion's: a stale or out-of-scope opening is left out too.
  const none = liveCount === 0 ? 'There is no live opportunity in this project' : 'No found opening is far enough along to model';
  const head = `${none}; ${modelled.length} constructed estimate(s) were modelled${refused ? ` (${refused} more refused)` : ''}`;
  const best = portfolio.best;
  const target = portfolio.limits.target;
  if (!best) return `${head}, and no combination of them can run inside the goal's limits against the ${money(target)} target.`;
  const members = best.members.filter((one) => one.opportunityId.startsWith('arr_')).length;
  const settled = best.settledP50 < target ? `settles a median ${money(best.settledP50)}, short of the ${money(target)} target` : `settles a median ${money(best.settledP50)} against the ${money(target)} target`;
  return `${head}: the best combination (${members} of them) reaches the target in ${(best.reach * 100).toFixed(1)}% of worlds, which is coverage of assumed inputs, not a probability, and ${settled}.`;
}
