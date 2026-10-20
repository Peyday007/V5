/**
 * What a Freelancer job is worth to Brain, and what doing it costs.
 *
 * Every figure here names where it came from:
 *
 *   - The exchange rate is Freelancer's own, published on the project as
 *     `currency.exchange_rate` (units of USD per unit of the project's
 *     currency). Brain does not choose a rate; it records the one the platform
 *     quoted, with when it read it, beside every converted figure.
 *   - The fee is Freelancer's published freelancer fee for fixed-price work:
 *     10% of the project value or USD 5.00, whichever is greater
 *     (https://www.freelancer.com/feesandcharges, read 2026-10-19).
 *   - The execution cost is an estimate in worker activations of the fixed
 *     Claude subscription the research fleet already runs on, so its marginal
 *     cash cost is zero; Brain buys no inference per job. It is labelled an
 *     estimate everywhere it appears, and the measured figure is the bin's own
 *     recorded activations once the job runs.
 *
 * None of this is revenue. A qualifying job is a bid Brain could make.
 */
import type { JobCategory } from './classify.ts';

export const FREELANCER_FEE = Object.freeze({
  rate: 0.1,
  minimumUsd: 5,
  source: 'https://www.freelancer.com/feesandcharges',
  readOn: '2026-10-19',
});

/** Bounds in USD, converted into the project's currency at Freelancer's rate. */
export const MIN_BUDGET_USD = 30;
export const MAX_BID_USD = 250;
/** Below this net, after the fee, a job is not worth an activation and a bid. */
export const MIN_NET_USD = 20;

export interface CurrencyQuote {
  code: string;
  usdPerUnit: number;
  source: 'FREELANCER_PROJECT';
}

export function quoteOf(currency: { code?: string; exchange_rate?: number } | undefined): CurrencyQuote | null {
  if (!currency?.code) return null;
  if (currency.code === 'USD') return { code: 'USD', usdPerUnit: 1, source: 'FREELANCER_PROJECT' };
  const rate = Number(currency.exchange_rate);
  return Number.isFinite(rate) && rate > 0 ? { code: currency.code, usdPerUnit: rate, source: 'FREELANCER_PROJECT' } : null;
}

export function feeUsd(bidUsd: number): number {
  return Math.round(Math.max(bidUsd * FREELANCER_FEE.rate, FREELANCER_FEE.minimumUsd) * 100) / 100;
}

export interface ExecutionEstimate {
  /** Worker activations expected: authoring plus the bounded verification retries. */
  activations: number;
  /** Elapsed worker minutes expected, from the kind of work. */
  workerMinutes: number;
  /** Marginal cash spent per job: the fleet is a fixed subscription. */
  cashCostUsd: 0;
  basis: string;
}

const MINUTES: Record<JobCategory, number> = {
  RESEARCH_REPORT: 60,
  SPREADSHEET: 25,
  DOCUMENT: 30,
  PRESENTATION: 30,
  DATASET: 25,
  WEBSITE: 35,
  CODE: 35,
  GRAPHIC: 15,
  MODEL_3D: 20,
};

export function estimateExecution(categories: JobCategory[]): ExecutionEstimate {
  const research = categories.includes('RESEARCH_REPORT');
  // A research job runs packets (several fragments, verification, three audit roles);
  // a deliverable job is one authoring bin, with up to two corrections expected rarely.
  const activations = research ? 8 : 1 + categories.length;
  const workerMinutes = categories.reduce((n, c) => n + MINUTES[c], 0);
  return {
    activations,
    workerMinutes,
    cashCostUsd: 0,
    basis: research
      ? 'research packet: fragments, verification and three audit roles on the existing fleet'
      : `${categories.length} deliverable(s) authored in one bin, rendered and verified by Brain`,
  };
}

export interface JobEconomics {
  currency: string;
  usdPerUnit: number;
  /** The bid, in the project's own currency, whole units. */
  bid: number;
  bidUsd: number;
  feeUsd: number;
  netUsd: number;
  estimate: ExecutionEstimate;
}

/**
 * The bid, in the project's currency: inside the published budget, under the
 * USD ceiling, a little under the average bid where there is one.
 */
export function priceJob(input: {
  quote: CurrencyQuote;
  budgetMin: number;
  budgetMax: number | null;
  bidAvg: number | null;
  categories: JobCategory[];
}): JobEconomics {
  const { quote } = input;
  const floor = Math.max(input.budgetMin, Math.ceil(MIN_BUDGET_USD / quote.usdPerUnit));
  const ceiling = Math.min(input.budgetMax ?? input.budgetMin, Math.floor(MAX_BID_USD / quote.usdPerUnit));
  const target = input.bidAvg && input.bidAvg > 0 ? input.bidAvg * 0.9 : floor + (ceiling - floor) * 0.3;
  const bid = Math.round(Math.min(Math.max(target, floor), Math.max(floor, ceiling)));
  const bidUsd = Math.round(bid * quote.usdPerUnit * 100) / 100;
  const fee = feeUsd(bidUsd);
  return {
    currency: quote.code,
    usdPerUnit: quote.usdPerUnit,
    bid,
    bidUsd,
    feeUsd: fee,
    netUsd: Math.round((bidUsd - fee) * 100) / 100,
    estimate: estimateExecution(input.categories),
  };
}
