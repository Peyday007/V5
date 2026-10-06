/**
 * What Brain is doing for you, across its four kinds of work, in a few lines
 * (Integration 3).
 *
 * Home answers "what is Brain doing for me right now" and used to answer it
 * about research alone: no money, no builds. This is the light reading behind
 * its summary strip. It reuses the projections the destinations already
 * render — `sharedFrontier` and `cashPosition` for Cash, `researchOverview`
 * for Research, the factory's own campaign list for Build — and composes one
 * sentence per kind, so Home never repeats a destination's derivation and never
 * pulls the full Cash view to draw four lines.
 *
 * A kind that could not be read says so in its own slot, as temporary when the
 * database is the reason; the other three still render. Money figures appear
 * only for somebody who may read the sprint in full (§34): a member sees how
 * far discovery has got and no figure.
 */
import { classifyInfraFailure } from '../../db/infra.ts';
import { findCashRoot } from '../cash/root.ts';
import { decideCashRead } from '../cash/access.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { sharedFrontier } from '../cash/shared.ts';
import { cashPosition } from '../cash/money.ts';
import { formatMoney } from '../cash/figures.ts';
import { researchOverview } from '../research/overview.ts';
import { listCampaigns } from '../../repos/factory.ts';

export interface SummaryLine {
  /** One sentence a person reads. */
  sentence: string;
  /** A second, quieter line, when there is something worth adding. */
  detail: string | null;
  /** True when this slot could not be read and Brain will try again. */
  retrying: boolean;
}

export interface WorkSummary {
  cash: SummaryLine;
  research: SummaryLine;
  build: SummaryLine;
}

function unreadable(noun: string, error: unknown): SummaryLine {
  const temporary = classifyInfraFailure(error) !== null;
  return {
    sentence: temporary
      ? `Brain could not read ${noun} just now — it will try again.`
      : `Brain could not read ${noun}.`,
    detail: null,
    retrying: temporary,
  };
}

async function cashLine(): Promise<SummaryLine> {
  const root = await findCashRoot();
  const mode = root ? await getCashMode(root.id) : null;
  if (!root || !mode) {
    return { sentence: 'Cash is not running. Starting it is one button on Cash.', detail: null, retrying: false };
  }
  const access = await decideCashRead(root.id);
  if (access.scope === 'NONE') {
    return { sentence: 'Cash is running.', detail: null, retrying: false };
  }
  const frontier = await sharedFrontier({ projectId: root.id });
  const tiers = frontier.byTier;
  const discovery =
    `${tiers.READY_TO_TEST} ready to test, ${tiers.QUALIFIED} qualified, ` +
    `${tiers.CANDIDATE} candidates and ${tiers.SIGNAL} signals being researched.`;
  if (mode.state !== 'ACTIVE') {
    return {
      sentence: `Cash is ${mode.state === 'WINDING_DOWN' ? 'winding down' : 'archived'}: no new discovery.`,
      detail: discovery,
      retrying: false,
    };
  }
  if (access.scope !== 'FULL') {
    return { sentence: `Cash: ${discovery}`, detail: null, retrying: false };
  }
  const position = await cashPosition({ projectId: root.id, currency: mode.currency });
  const money = (cents: number): string => formatMoney(cents, position.currency);
  return {
    sentence:
      `${money(position.customerPaymentsCents)} received, ` +
      `${money(position.completedContributionCents)} earned after costs` +
      (position.unpaidCommitmentsCents > 0 ? `, ${money(position.unpaidCommitmentsCents)} of costs still to pay` : '') +
      '.',
    detail: `${discovery}${position.shortfall ? ' Deployable cash is negative, so nothing new is committed.' : ''}`,
    retrying: false,
  };
}

async function researchLine(projectId: string): Promise<SummaryLine> {
  const overview = await researchOverview(projectId);
  const retrying = overview.counts.RETRYING > 0;
  return {
    sentence: overview.headline,
    detail:
      overview.goals.length > 0
        ? `${overview.goals.length} research ${overview.goals.length === 1 ? 'goal' : 'goals'} with a budget.`
        : null,
    retrying,
  };
}

const LIVE_BUILD = new Set(['PLANNING', 'EXECUTING', 'INTEGRATING', 'REVIEWING', 'REPAIRING', 'VERIFYING', 'ASSEMBLING']);

async function buildLine(projectId: string): Promise<SummaryLine> {
  const campaigns = await listCampaigns(projectId);
  const live = campaigns.filter((one) => LIVE_BUILD.has(one.state)).length;
  const waiting = campaigns.filter((one) => one.state === 'AWAITING_RELEASE').length;
  const blocked = campaigns.filter((one) => one.state === 'BLOCKED').length;
  const done = campaigns.filter((one) => one.state === 'COMPLETE').length;
  if (campaigns.length === 0) {
    return { sentence: 'Nothing is being built in this project.', detail: null, retrying: false };
  }
  const parts: string[] = [];
  if (live) parts.push(`${live} being built`);
  if (waiting) parts.push(`${waiting} waiting for your release`);
  if (blocked) parts.push(`${blocked} stopped`);
  if (done) parts.push(`${done} complete`);
  if (parts.length === 0) {
    return { sentence: 'No build is active in this project.', detail: null, retrying: false };
  }
  return { sentence: `${parts.join(', ')}.`, detail: null, retrying: false };
}

export async function workSummary(projectId: string | null): Promise<WorkSummary> {
  const none: SummaryLine = { sentence: 'There is no project here yet.', detail: null, retrying: false };
  const [cash, research, build] = await Promise.all([
    cashLine().catch((error: unknown) => unreadable('Cash', error)),
    projectId ? researchLine(projectId).catch((error: unknown) => unreadable('research', error)) : none,
    projectId ? buildLine(projectId).catch((error: unknown) => unreadable('builds', error)) : none,
  ]);
  return { cash, research, build };
}
