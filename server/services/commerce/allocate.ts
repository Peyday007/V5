/**
 * Which question the kernel asks next, and why.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason `services/dispatch/router.ts` is pure
 * ---------------------------------------------------------------------------
 *
 * A function over a recorded snapshot, so "why did Brain research that" is
 * answerable afterwards from an input rather than from a re-run against a
 * database that has moved on. Being pure also makes it useless as a safety
 * mechanism, which is deliberate and is the same split the dispatcher draws:
 * the exclusion is the unique index on `commerce_rounds`, so two ticks both
 * deciding correctly that a proposition needs its economics produce one round.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic over rules, never a weighted score
 * ---------------------------------------------------------------------------
 *
 * Six rules in a fixed order, each one a statement about what Brain has
 * already learned. The order is the brief's own: **finish what has already
 * been spent before starting the next search.** A proposition that is one
 * figure short of a derivable margin is the most immediate thing there is —
 * the round that found it and the round that supplied it are both already
 * paid for — so it goes first, and the broad search for new products waits.
 *
 * ---------------------------------------------------------------------------
 * It stops
 * ---------------------------------------------------------------------------
 *
 * Four bounds, each a bound rather than a preference. A subject with a live
 * round of a purpose is not asked that question twice at once. A settled round
 * waits out a cool-off. A subject asked `BARREN_ROUNDS` times for nothing is
 * not offered again, because Brain has now documented that there is nothing
 * there and §13's rule about the archive applies to Brain's own history. And a
 * proposition the channel forbids is asked nothing at all, because researching
 * the economics of something that may not be sold is the waste §13 exists to
 * stop.
 */
import { BARREN_ROUNDS, ROUND_COOL_OFF_MS } from '../cash/discovery.ts';
import { REQUIRED_FOR_MARGIN } from './economics.ts';
import type { Reading } from './reading.ts';
import type {
  CommerceChannel,
  CommerceRound,
  CommerceRoundPurpose,
} from '../../domain/types.ts';

export interface Ask {
  purpose: CommerceRoundPurpose;
  channelId: string | null;
  propositionId: string | null;
  round: number;
  /** Which rule admitted it. Lower is stronger, and the numbers are spaced. */
  rank: number;
  /**
   * What this is about, in words a person reads.
   *
   * Carried on the ask rather than resolved by each reader, because §29
   * records what a status nobody can read costs: the industry kernel's first
   * version left every decline reading `ind_d947…: there is no free slot`,
   * which is technically true and useless.
   */
  subject: string;
  /** When Brain came to know about the subject. The tiebreak between equals. */
  since: string;
  /** The recorded input, in words, so the decision can be argued with. */
  why: string;
}

/**
 * How many kernel questions may be open at once.
 *
 * Not an allowance — the subscription behind a research mission is already
 * paid for, and §24 records the cost of treating a count of missions as a
 * quota. It is a *concurrency* bound, which is the one limit here that is
 * real: the fleet has a measured fire ceiling, and this kernel competes for
 * the same slots the industry kernel and the deep dives do.
 *
 * Lower than the industry kernel's, deliberately. This kernel exists inside
 * the same sprint, and a new axis that took as many slots as the established
 * one would halve the throughput of work already under way on its first tick.
 */
export const MAX_OPEN_COMMERCE_ROUNDS = 3;

export interface AllocationInput {
  channels: readonly CommerceChannel[];
  readings: readonly Reading[];
  rounds: readonly CommerceRound[];
  /** How many more rounds may be opened now. Never negative. */
  slots: number;
  now: string;
}

export interface Allocation {
  asks: Ask[];
  /** Everything considered and not asked, with the reason. Reported, not acted on. */
  declined: { subject: string; why: string }[];
}

export function allocate(input: AllocationInput): Allocation {
  const slots = Math.max(0, Math.trunc(input.slots));
  const declined: Allocation['declined'] = [];
  const candidates: Ask[] = [];
  const now = Date.parse(input.now) || Date.now();

  const live = input.rounds.filter((one) => one.state === 'OPEN');
  const settled = input.rounds.filter((one) => one.state !== 'OPEN');
  const liveOf = (purpose: CommerceRoundPurpose, channelId: string | null, propositionId: string | null) =>
    live.some(
      (one) =>
        one.purpose === purpose && one.channelId === channelId && one.propositionId === propositionId,
    );
  const historyOf = (purpose: CommerceRoundPurpose, channelId: string | null, propositionId: string | null) =>
    settled.filter(
      (one) =>
        one.purpose === purpose && one.channelId === channelId && one.propositionId === propositionId,
    );

  /**
   * Whether this question may be asked again, and which round it would be.
   *
   * Null means no: something is live, the cool-off has not run out, or the
   * subject has been asked this and found nothing enough times that asking
   * again would be spending the allowance to re-learn an absence Brain has
   * already documented.
   */
  const nextRound = (
    purpose: CommerceRoundPurpose,
    channelId: string | null,
    propositionId: string | null,
    subject: string,
  ): number | null => {
    if (liveOf(purpose, channelId, propositionId)) {
      declined.push({ subject, why: `a ${purpose} round is already open for it` });
      return null;
    }
    const history = historyOf(purpose, channelId, propositionId);
    if (history.length === 0) return 1;

    /*
     * Only a *harvested* round with nothing in it is evidence of absence.
     *
     * An `ABANDONED` round is one whose mission ended without answering the
     * question — a mechanical failure, not a reading about the world. Counting
     * it as barren would retire a subject for a reason that was never about
     * the subject, which is *we could not tell* reading the same as *we
     * checked*.
     */
    const barren = history.filter(
      (one) => one.state === 'HARVESTED' && (one.found ?? 0) === 0,
    ).length;
    if (barren >= BARREN_ROUNDS) {
      declined.push({
        subject,
        why:
          `${barren} ${purpose} rounds found nothing, so Brain has documented that there is ` +
          'nothing there rather than not having looked',
      });
      return null;
    }
    const latest = history
      .map((one) => Date.parse(one.harvestedAt ?? one.openedAt) || 0)
      .reduce((best, one) => Math.max(best, one), 0);
    if (now - latest < ROUND_COOL_OFF_MS) {
      declined.push({ subject, why: `its last ${purpose} round settled inside the cool-off` });
      return null;
    }
    return Math.max(...history.map((one) => one.round)) + 1;
  };

  const liveChannels = input.channels.filter((one) => one.retiredAt === null);

  /*
   * Rule 100 — a proposition that is short of a derivable margin.
   *
   * The most immediate thing there is: the round that found the product and
   * the round that established its supplier are both already spent, and one
   * more figure turns a candidate into something a person can decide about.
   * It outranks the bootstrap for the reason the industry kernel's capital
   * rule does — on a pass with free slots both are asked, and the order only
   * decides what waits when they are scarce.
   */
  for (const reading of input.readings) {
    if (reading.proposition.retiredAt || reading.prohibited.length > 0) continue;
    if (reading.purchases.length === 0) continue;
    if (reading.economics.contributionPerUnit.known) continue;
    const missing = reading.economics.unknown;
    if (missing.length === 0 || missing.length === REQUIRED_FOR_MARGIN.length) continue;
    const subject = reading.proposition.product;
    const round = nextRound('ECONOMICS', null, reading.proposition.id, subject);
    if (round === null) continue;
    candidates.push({
      purpose: 'ECONOMICS',
      channelId: null,
      propositionId: reading.proposition.id,
      round,
      rank: 100,
      subject,
      since: reading.proposition.createdAt,
      why:
        `somebody is shown to have bought it and ${missing.length} of the margin's inputs ` +
        `${missing.length === 1 ? 'is' : 'are'} still unknown (${missing.join(', ')}), so one ` +
        'round turns a candidate into a decision',
    });
  }

  /*
   * Rule 150 — the channels bootstrap, when there is nothing to sell on.
   *
   * There is no list of platforms in this codebase and this is why. A seeded
   * channel satisfies it, which is how a person saying "start with TikTok"
   * becomes a row rather than a constant.
   */
  if (liveChannels.length === 0) {
    const round = nextRound('CHANNELS', null, null, 'the channels themselves');
    if (round !== null) {
      candidates.push({
        purpose: 'CHANNELS',
        channelId: null,
        propositionId: null,
        round,
        rank: 150,
        subject: 'the channels themselves',
        since: new Date(0).toISOString(),
        why: 'nothing is on the channel map, so there is nowhere for a product to be sold',
      });
    }
  }

  /*
   * Rule 200 — a proposition with a buyer and no supplier.
   *
   * Also already paid for, and it is the question that most often kills a
   * piece: plenty of things people demonstrably buy cannot be got at a cost
   * that leaves anything behind.
   */
  for (const reading of input.readings) {
    if (reading.proposition.retiredAt || reading.prohibited.length > 0) continue;
    if (reading.purchases.length === 0) continue;
    if (reading.supply.some((one) => one.kind === 'SUPPLIER_AVAILABLE')) continue;
    if (reading.proposition.supplier) continue;
    const subject = reading.proposition.product;
    const round = nextRound('SUPPLY', null, reading.proposition.id, subject);
    if (round === null) continue;
    candidates.push({
      purpose: 'SUPPLY',
      channelId: null,
      propositionId: reading.proposition.id,
      round,
      rank: 200,
      subject,
      since: reading.proposition.createdAt,
      why: 'somebody is shown to have bought it and nobody has established who would supply it',
    });
  }

  /*
   * Rule 300 — a channel nobody has read the rules of.
   *
   * Before the products, deliberately. A channel that forbids the category, or
   * requires a business entity nobody has, settles every proposition on it at
   * once — so asking it first is the cheapest question in the kernel, and
   * asking it last means researching products that could never have been sold.
   */
  for (const channel of liveChannels) {
    const known = input.readings.filter((one) => one.proposition.channelId === channel.id);
    const haveRules = known.some((one) => one.eligibility.length > 0);
    if (haveRules) continue;
    const round = nextRound('ELIGIBILITY', channel.id, null, channel.name);
    if (round === null) continue;
    candidates.push({
      purpose: 'ELIGIBILITY',
      channelId: channel.id,
      propositionId: null,
      round,
      rank: 300,
      subject: channel.name,
      since: channel.createdAt,
      why:
        'nothing establishes what this channel requires or forbids, and one round settles ' +
        'every proposition on it at once',
    });
  }

  /*
   * Rule 400 — what is actually being bought on a channel.
   *
   * The broad search, and the only rule that produces new propositions.
   * Deliberately below everything that finishes work already started.
   */
  for (const channel of liveChannels) {
    const round = nextRound('PRODUCTS', channel.id, null, channel.name);
    if (round === null) continue;
    const known = input.readings.filter((one) => one.proposition.channelId === channel.id).length;
    candidates.push({
      purpose: 'PRODUCTS',
      channelId: channel.id,
      propositionId: null,
      round,
      rank: 400,
      subject: channel.name,
      since: channel.createdAt,
      why:
        known === 0
          ? 'nothing is known about what is bought on this channel'
          : `${known} product${known === 1 ? '' : 's'} are known here and the search has not ` +
            'been exhausted',
    });
  }

  /*
   * Rule 500 — a proposition with attention and no purchase.
   *
   * Last, and that placement is the whole opinion this kernel has about
   * attention. It is worth one round to find out whether anybody actually
   * bought; it is not worth a round before every piece that already has a
   * buyer. A piece that comes back from this round with nothing stays where it
   * is, and after `BARREN_ROUNDS` it is not asked again.
   */
  for (const reading of input.readings) {
    if (reading.proposition.retiredAt || reading.prohibited.length > 0) continue;
    if (reading.purchases.length > 0) continue;
    if (reading.attention.length === 0) continue;
    const subject = reading.proposition.product;
    const round = nextRound('SUPPLY', null, reading.proposition.id, subject);
    if (round === null) continue;
    candidates.push({
      purpose: 'SUPPLY',
      channelId: null,
      propositionId: reading.proposition.id,
      round,
      rank: 500,
      subject,
      since: reading.proposition.createdAt,
      why:
        `it has ${reading.attention.length} attention reading` +
        `${reading.attention.length === 1 ? '' : 's'} and nothing showing anybody bought, so ` +
        'one round establishes whether there is a buyer behind the views',
    });
  }

  candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.since < b.since ? -1 : 1));

  const asks = candidates.slice(0, slots);
  for (const missed of candidates.slice(slots)) {
    declined.push({
      subject: missed.subject,
      why: `${missed.why} — but there is no free slot this pass, so it waits`,
    });
  }
  return { asks, declined };
}
