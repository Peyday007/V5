import type { ActivityVariable, Arrangement } from './types.ts';
import { forNewOperator, variableProblem } from './variables.ts';

export interface ArrangementReading {
  arrangement: Arrangement;
  /** Net per transaction in major units, or null with the reason. */
  netPerTransaction: number | null;
  withheld: string | null;
  capital: number | null;
  daysToCash: number | null;
  /** Variables behind the figure that are not VERIFIED. */
  unverified: string[];
}

function pick(vars: ActivityVariable[], key: string): ActivityVariable | null {
  const v = vars.find((x) => x.key === key);
  return v && !variableProblem(v) && v.state !== 'UNKNOWN' && v.value !== null ? v : null;
}

/** Revenue less direct cost, withheld unless both are stated. Unknown is never zero. */
export function readArrangement(arrangement: Arrangement, variables: ActivityVariable[]): ArrangementReading {
  const vars = forNewOperator(variables.filter((v) => v.activityId === arrangement.activityId));
  const price = pick(vars, 'price');
  const cost = pick(vars, 'directCost');
  const capital = pick(vars, 'capital');
  const days = pick(vars, 'daysToCash');
  const unverified = [price, cost, capital, days].filter((v): v is ActivityVariable => !!v && v.state !== 'VERIFIED').map((v) => v.key);
  const missing = [!price && 'price', !cost && 'directCost'].filter(Boolean) as string[];
  return {
    arrangement,
    netPerTransaction: missing.length ? null : (price as ActivityVariable).value! - (cost as ActivityVariable).value!,
    withheld: missing.length ? `${missing.join(' and ')} not established` : null,
    capital: capital?.value ?? null,
    daysToCash: days?.value ?? null,
    unverified,
  };
}

/**
 * Compare arrangements for the same need. Different needs are refused whole.
 * Order is lexicographic and unweighted: stated net first (higher), then
 * stated capital (lower), then days to cash (fewer); anything unstated sorts
 * last on that criterion, never as a favourable zero.
 */
export function compareArrangements(arrangements: Arrangement[], variables: ActivityVariable[]): { needId: string | null; ranked: ArrangementReading[]; refused: string | null } {
  if (!arrangements.length) return { needId: null, ranked: [], refused: null };
  const needId = arrangements[0]!.needId;
  if (arrangements.some((a) => a.needId !== needId)) return { needId: null, ranked: [], refused: 'arrangements serve different needs' };
  const readings = arrangements.map((a) => readArrangement(a, variables));
  const desc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
  const asc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);
  readings.sort((x, y) => desc(x.netPerTransaction, y.netPerTransaction) || asc(x.capital, y.capital) || asc(x.daysToCash, y.daysToCash) || x.arrangement.key.localeCompare(y.arrangement.key));
  return { needId, ranked: readings, refused: null };
}
