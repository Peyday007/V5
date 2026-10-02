/**
 * What the loop has actually got to, for a person.
 *
 * ---------------------------------------------------------------------------
 * Planned, tested and operational stay three things
 * ---------------------------------------------------------------------------
 *
 * The brief asks for the kernel's *actual* maturity, with planned, tested and
 * operational capabilities kept distinct. §37 settled how: six independent
 * dimensions and **no aggregate**, because the moment one exists every reader
 * uses it and the parts become decoration. So this reports what exists, what
 * has been measured and what has only been read about, side by side, and
 * composes no percentage from them.
 *
 * ---------------------------------------------------------------------------
 * Every number here is a row
 * ---------------------------------------------------------------------------
 *
 * Nothing is estimated, projected or smoothed. A figure that could not be
 * derived is absent with the reason, never a zero — §29's rule that a default
 * published as a measurement is the error nobody checks, and §33's correction
 * where a live round's `found` default reported "0 openings" about the work
 * that had produced the whole portfolio.
 */
import { basisOf } from '../../domain/commerce.ts';
import { snapshot, planFrom, type Snapshot } from './kernel.ts';
import type { Reading } from './reading.ts';
import type {
  CommerceBasis,
  CommerceChannel,
  CommerceStage,
  CommerceTest,
} from '../../domain/types.ts';

export interface CommerceView {
  projectId: string;
  /** Where the loop has got to, with no single number standing for it. */
  maturity: Maturity;
  channels: ChannelView[];
  /** The strongest five, in rank order, with why and what would change it. */
  best: PropositionView[];
  /** Everything, so nothing is hidden by the top-five cut. */
  all: PropositionView[];
  /** Bounded tests, and the precise blocker on each one that has not run. */
  tests: TestView[];
  /** What Brain would ask next and why, and what it considered and did not. */
  next: { subject: string; purpose: string; why: string }[];
  declined: { subject: string; why: string }[];
  /** Live rounds, so "nothing known" and "being asked" are distinguishable. */
  asking: { purpose: string; subject: string; openedAt: string }[];
}

/**
 * The maturity, as counts of rows rather than as a stage.
 *
 * Deliberately not one word. A loop with nine products, three margins and no
 * test is at a different place from one with one product and a settled test,
 * and no single label separates them — §37's six dimensions, at a smaller
 * scale and for the same reason.
 */
export interface Maturity {
  channels: number;
  propositions: number;
  /** How many have published evidence that somebody bought. */
  withPurchase: number;
  /** How many have attention and nothing showing a purchase. */
  attentionOnly: number;
  withSupplier: number;
  /** How many have a contribution that can be derived at all. */
  withDerivableMargin: number;
  /** How many of those clear zero. */
  withPositiveMargin: number;
  /** How many rest on a measurement rather than on published figures. */
  withMeasuredEvidence: number;
  testsPrepared: number;
  testsBlocked: number;
  testsSettled: number;
  /**
   * The loop's own furthest point, and it is a fact rather than a score.
   *
   * The furthest stage any live proposition has reached — which says what has
   * happened and deliberately not how close anything is to finishing. Nothing
   * here is a percentage, because there is no denominator that is not made up.
   */
  furthestStage: CommerceStage | null;
  /**
   * What has never been measured, said in words.
   *
   * Present on every view, and usually the most important line on it: until a
   * bounded test settles, every figure in this kernel is read from somebody
   * else's published page, and reporting those as though they were results of
   * ours would be the invented-measurement §37 exists to refuse.
   */
  measurement: string;
}

export interface ChannelView {
  id: string;
  name: string;
  origin: string;
  /** SEED means a person named it, which is the only way TikTok gets here. */
  seeded: boolean;
  retiredReason: string | null;
  propositions: number;
  /** What the channel charges and requires, where anything establishes it. */
  terms: { kind: string; statement: string; figure: string | null; basis: CommerceBasis }[];
  prohibits: string[];
}

export interface PropositionView {
  id: string;
  product: string;
  channel: string | null;
  audience: string | null;
  supplier: string | null;
  stage: CommerceStage;
  /** The counts that decide the rank, so the order can be argued with. */
  purchaseReadings: number;
  attentionReadings: number;
  /** The contribution, or the reason it is withheld. Never a zero. */
  contribution: { minor: number; basis: CommerceBasis } | null;
  contributionWithheld: string | null;
  breakEvenAcquisition: number | null;
  upfrontCash: { minor: number; basis: CommerceBasis } | null;
  upfrontWithheld: string | null;
  daysToUsableCash: number | null;
  /** Which load-bearing figures nobody has established. The work remaining. */
  unknown: string[];
  /** Every assumption the arithmetic rests on that no source stated. */
  assumptions: string[];
  next: { what: string; owner: string; blockedBy: string | null };
  wouldChange: string[];
  /** Live rounds about it, so a blank reads as "being asked" where it is. */
  asking: string[];
}

export interface TestView {
  id: string;
  propositionId: string;
  product: string;
  state: string;
  ceilingMinor: number;
  blocker: string | null;
  blockerDetail: string | null;
  stopRule: string;
}

export async function commerceView(projectId: string): Promise<CommerceView> {
  const state = await snapshot(projectId);
  return compose(state);
}

export function compose(state: Snapshot): CommerceView {
  const live = state.readings.filter((one) => one.proposition.retiredAt === null);
  const plan = planFrom(state);
  const channelById = new Map(state.channels.map((one) => [one.id, one]));

  const all = live.map((one) => propositionView(one, channelById));

  return {
    projectId: state.projectId,
    maturity: maturityOf(state, live),
    channels: state.channels.map((channel) => channelView(channel, state)),
    /*
     * Five, because the brief asks for five. The cut is on the display and not
     * on the derivation: `all` holds every one of them in the same order, so a
     * piece that fell sixth is one scroll away rather than invisible.
     */
    best: all.slice(0, 5),
    all,
    tests: state.tests.map((test) => testView(test, state)),
    next: plan.asks.map((ask) => ({
      subject: ask.subject,
      purpose: ask.purpose,
      why: ask.why,
    })),
    declined: plan.declined,
    asking: state.rounds
      .filter((one) => one.state === 'OPEN')
      .map((one) => ({
        purpose: one.purpose,
        subject:
          (one.propositionId
            ? live.find((r) => r.proposition.id === one.propositionId)?.proposition.product
            : one.channelId
              ? channelById.get(one.channelId)?.name
              : 'the channels themselves') ?? 'a subject that has since been retired',
        openedAt: one.openedAt,
      })),
  };
}

function maturityOf(state: Snapshot, live: readonly Reading[]): Maturity {
  const stages: readonly CommerceStage[] = [
    'DEMAND_SIGNAL',
    'PRODUCT_CANDIDATE',
    'SUPPLIER_VALIDATED',
    'ECONOMICS_ESTABLISHED',
    'OFFER_READY',
    'TEST_RUNNING',
    'FULFILLING',
    'SETTLED',
  ];
  let furthest: CommerceStage | null = null;
  for (const reading of live) {
    const index = stages.indexOf(reading.stage);
    if (index < 0) continue;
    if (furthest === null || index > stages.indexOf(furthest)) furthest = reading.stage;
  }

  const measured = live.filter((one) =>
    [...(one.economics.inputs ? Object.values(one.economics.inputs) : [])].some(
      (input) => input?.basis === 'MEASURED',
    ),
  ).length;

  return {
    channels: state.channels.filter((one) => one.retiredAt === null).length,
    propositions: live.length,
    withPurchase: live.filter((one) => one.purchases.length > 0).length,
    attentionOnly: live.filter((one) => one.purchases.length === 0 && one.attention.length > 0)
      .length,
    withSupplier: live.filter(
      (one) =>
        one.proposition.supplier !== null ||
        one.supply.some((row) => row.kind === 'SUPPLIER_AVAILABLE'),
    ).length,
    withDerivableMargin: live.filter((one) => one.economics.contributionPerUnit.known).length,
    withPositiveMargin: live.filter(
      (one) => one.economics.contributionPerUnit.known && one.economics.contributionPerUnit.minor > 0,
    ).length,
    withMeasuredEvidence: measured,
    testsPrepared: state.tests.length,
    testsBlocked: state.tests.filter((one) => one.state === 'BLOCKED').length,
    testsSettled: state.tests.filter((one) => one.state === 'SETTLED').length,
    furthestStage: furthest,
    measurement:
      measured > 0
        ? `${measured} proposition${measured === 1 ? '' : 's'} rest${measured === 1 ? 's' : ''} ` +
          'partly on a measurement from a settled test. Everything else is read from published ' +
          'sources, which is an estimate about our economics however good the source.'
        : 'Nothing here has been measured. Every figure is read from somebody else\'s published ' +
          'page, which makes it an estimate about our economics rather than a result of ours — ' +
          'a bounded sales test is the only thing that changes that, and none has settled.',
  };
}

function channelView(channel: CommerceChannel, state: Snapshot): ChannelView {
  const rows = state.evidence.filter((one) => one.channelId === channel.id);
  const terms = rows
    .filter((one) =>
      ['PLATFORM_FEE', 'PAYMENT_FEE', 'PAYOUT_DELAY', 'PLATFORM_ELIGIBILITY', 'FULFILMENT_REQUIREMENT'].includes(
        one.kind,
      ),
    )
    .map((one) => ({
      kind: one.kind,
      statement: one.statement,
      figure: figureText(one.amountMinor, one.ratePpm, one.days, one.countUnits),
      basis: basisOf(one.origin),
    }));
  return {
    id: channel.id,
    name: channel.name,
    origin: channel.origin,
    seeded: channel.origin === 'SEED',
    retiredReason: channel.retiredReason,
    propositions: state.readings.filter(
      (one) => one.proposition.channelId === channel.id && one.proposition.retiredAt === null,
    ).length,
    terms,
    prohibits: rows.filter((one) => one.kind === 'PROHIBITED_PRODUCT').map((one) => one.statement),
  };
}

function propositionView(
  reading: Reading,
  channelById: Map<string, CommerceChannel>,
): PropositionView {
  const margin = reading.economics.contributionPerUnit;
  const upfront = reading.economics.upfrontCash;
  const days = reading.economics.daysToUsableCash;
  return {
    id: reading.proposition.id,
    product: reading.proposition.product,
    channel: channelById.get(reading.proposition.channelId)?.name ?? null,
    audience: reading.proposition.audience,
    supplier: reading.proposition.supplier,
    stage: reading.stage,
    purchaseReadings: reading.purchases.length,
    attentionReadings: reading.attention.length,
    contribution: margin.known ? { minor: margin.minor, basis: margin.basis } : null,
    contributionWithheld: margin.known ? null : margin.why,
    /*
     * Present only alongside a derived contribution, because it *is* the
     * contribution under another name. Reporting it when the contribution is
     * withheld would be publishing the same withheld number through a second
     * door.
     */
    breakEvenAcquisition: margin.known ? margin.minor : null,
    upfrontCash: upfront.known ? { minor: upfront.minor, basis: upfront.basis } : null,
    upfrontWithheld: upfront.known ? null : upfront.why,
    daysToUsableCash: days.known ? days.days : null,
    unknown: [...reading.economics.unknown],
    assumptions: [...reading.economics.assumptions],
    next: {
      what: reading.next.what,
      owner: reading.next.owner,
      blockedBy: reading.next.blockedBy,
    },
    wouldChange: [...reading.wouldChange],
    asking: reading.asking.map((one) => one.purpose),
  };
}

function testView(test: CommerceTest, state: Snapshot): TestView {
  return {
    id: test.id,
    propositionId: test.propositionId,
    product:
      state.readings.find((one) => one.proposition.id === test.propositionId)?.proposition.product ??
      'a proposition that has since been retired',
    state: test.state,
    ceilingMinor: test.ceilingMinor,
    blocker: test.blockerKind,
    blockerDetail: test.blockerDetail,
    stopRule: test.stopRule,
  };
}

/**
 * A figure with its unit attached, or null where there is none.
 *
 * Null rather than `0` or `"—"`, because a figure column that prints something
 * for an absent value is the default-published-as-a-measurement defect at the
 * last hop. The unit is in the string because the four shapes are genuinely
 * different quantities and a bare number would invite the reader to do the
 * arithmetic the schema refuses to.
 */
function figureText(
  amountMinor: number | null,
  ratePpm: number | null,
  days: number | null,
  count: number | null,
): string | null {
  if (amountMinor !== null) return `${amountMinor} minor units`;
  if (ratePpm !== null) return `${(ratePpm / 10_000).toFixed(2)}%`;
  if (days !== null) return `${days} day${days === 1 ? '' : 's'}`;
  if (count !== null) return `${count}`;
  return null;
}
