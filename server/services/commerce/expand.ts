/**
 * Opening the kernel's questions, and absorbing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets
 * the path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this adds is
 * a new way *in* to machinery Steps 4 to 12C already built, and none of it is
 * a second set of rules.
 *
 * ---------------------------------------------------------------------------
 * Absorbing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. `commerceSpec` decides which table a finding
 * lands in; nothing here inspects a sentence, infers a figure or decides that
 * something *sounds like* a purchase. That is §8 at the table that decides
 * whether money is spent, and it is why the margin can be trusted to be about
 * published reality rather than about what a model expected a product to cost.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { commerceClaims } from '../../repos/research.ts';
import { commerceSpec } from '../../domain/commerce.ts';
import {
  closeCommerceRound,
  createChannel,
  createProposition,
  fillProposition,
  getChannel,
  listChannels,
  listPropositions,
  openCommerceRound,
  openCommerceRoundsByCandidate,
  recordEvidence,
} from '../../repos/commerce.ts';
import {
  channelsQuestion,
  CHANNELS_TITLE,
  economicsQuestion,
  economicsTitle,
  eligibilityQuestion,
  eligibilityTitle,
  productsQuestion,
  productsTitle,
  supplyQuestion,
  supplyTitle,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { Reading } from './reading.ts';
import type {
  CommerceChannel,
  CommerceEvidence,
  CommerceProposition,
  CommerceRound,
  ResearchClaim,
} from '../../domain/types.ts';

const OPENED = 'COMMERCE_ROUND_OPENED';
const ABSORBED = 'COMMERCE_FINDINGS_ABSORBED';

export interface OpenedRound {
  roundId: string;
  purpose: CommerceRound['purpose'];
  channelId: string | null;
  propositionId: string | null;
  candidateId: string;
  round: number;
  question: string;
  why: string;
}

/**
 * Turn the allocator's decisions into work.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything. The same
 * shape `openRound` and `openAsks` already have, for the same reason.
 */
export async function openAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  readings: readonly Reading[];
  channels: readonly CommerceChannel[];
}): Promise<OpenedRound[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const channelById = new Map(input.channels.map((one) => [one.id, one]));
  const readingById = new Map(input.readings.map((one) => [one.proposition.id, one]));
  const out: OpenedRound[] = [];

  for (const ask of input.asks) {
    const composed = compose({ ask, mode, channelById, readingById });
    if (!composed) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openCommerceRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      purpose: ask.purpose,
      channelId: ask.channelId,
      propositionId: ask.propositionId,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: opened.round.id,
        purpose: ask.purpose,
        channelId: ask.channelId,
        propositionId: ask.propositionId,
        candidateId: candidate.id,
        round: ask.round,
        /*
         * The allocator's own reason, recorded beside the work it produced.
         *
         * `services/dispatch/router.ts` keeps its decision answerable from a
         * recorded input rather than from a re-run, and this is that promise
         * kept: "why did Brain research this" resolves to a sentence written
         * at the moment it was decided, over a snapshot that has since moved.
         */
        why: ask.why,
        rank: ask.rank,
      },
    });

    out.push({
      roundId: opened.round.id,
      purpose: ask.purpose,
      channelId: ask.channelId,
      propositionId: ask.propositionId,
      candidateId: candidate.id,
      round: ask.round,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

function compose(input: {
  ask: Ask;
  mode: { objective: string };
  channelById: Map<string, CommerceChannel>;
  readingById: Map<string, Reading>;
}): { title: string; question: string } | null {
  const { ask, mode } = input;

  if (ask.purpose === 'CHANNELS') {
    return { title: CHANNELS_TITLE, question: channelsQuestion(mode.objective, ask.round) };
  }

  if (ask.purpose === 'PRODUCTS' || ask.purpose === 'ELIGIBILITY') {
    const channel = ask.channelId ? input.channelById.get(ask.channelId) : null;
    if (!channel) return null;
    if (ask.purpose === 'ELIGIBILITY') {
      return {
        title: eligibilityTitle(channel),
        question: eligibilityQuestion({ channel, objective: mode.objective }),
      };
    }
    const known = [...input.readingById.values()].filter(
      (one) => one.proposition.channelId === channel.id,
    ).length;
    return {
      title: productsTitle(channel),
      question: productsQuestion({
        channel,
        objective: mode.objective,
        round: ask.round,
        knownSoFar: known,
      }),
    };
  }

  const reading = ask.propositionId ? input.readingById.get(ask.propositionId) : null;
  if (!reading) return null;
  const channel = input.channelById.get(reading.proposition.channelId) ?? null;

  if (ask.purpose === 'SUPPLY') {
    return {
      title: supplyTitle(reading.proposition),
      question: supplyQuestion({ proposition: reading.proposition, channel, objective: mode.objective }),
    };
  }

  return {
    title: economicsTitle(reading.proposition),
    question: economicsQuestion({
      proposition: reading.proposition,
      channel,
      objective: mode.objective,
      missing: reading.economics.unknown,
    }),
  };
}

export interface Absorbed {
  channels: CommerceChannel[];
  propositions: CommerceProposition[];
  evidence: CommerceEvidence[];
  /** Rounds settled this pass, with what each one produced. */
  settled: { roundId: string; found: number }[];
  /** Declarations that could not be filed, and why. Reported, never guessed. */
  refused: { claimId: string; why: string }[];
}

/**
 * File what the kernel's questions established.
 *
 * Not gated by the sprint's lifecycle, and that is deliberate and unchanged
 * from `harvest` and from the industry kernel's `absorb`: filing what research
 * already found is not new discovery — the spending happened when it ran — and
 * dropping results because the sprint wound down would throw away work already
 * paid for. §30's rule that winding down ends new discovery and never a
 * customer's obligation, one table along.
 */
export async function absorb(input: {
  projectId: string;
  limit?: number;
}): Promise<Absorbed> {
  const out: Absorbed = {
    channels: [],
    propositions: [],
    evidence: [],
    settled: [],
    refused: [],
  };
  const mode = await getCashMode(input.projectId);
  if (!mode) return out;

  const limit = Math.max(1, input.limit ?? 80);
  const live = await openCommerceRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to.
   *
   * Through the mission, exactly as `harvest` does it, because a mission is
   * what links a round's candidate to the orchestration it launched. An
   * orchestration with no mission belongs to no kernel round, which is honest
   * rather than a gap: nobody asked a commerce question for it, and absorbing
   * its claims would file findings against a proposition nothing chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<string, { round: CommerceRound; missionDone: boolean }>();
  for (const mission of missions) {
    if (!mission.orchestrationId || !mission.candidateId) continue;
    const round = live.get(mission.candidateId);
    if (round) {
      byOrchestration.set(mission.orchestrationId, {
        round,
        missionDone: mission.state === 'DONE',
      });
    }
  }
  if (byOrchestration.size === 0) return out;

  const channels = await listChannels(input.projectId);
  const channelByName = new Map(channels.map((one) => [one.name.toLowerCase(), one]));
  const propositions = await listPropositions(input.projectId);
  const foundPerRound = new Map<string, number>();

  const claims = await commerceClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit,
  });

  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    const filed = await file({
      projectId: input.projectId,
      cashModeId: mode.id,
      claim: entry.claim,
      round: context.round,
      channelByName,
      propositions,
      out,
    });
    if (filed) {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   *
   * `found` is what the next round is decided against, so a round whose
   * mission has finished has to record what it produced — **including
   * nothing**. Leaving a barren round OPEN would stop it ever being asked
   * again while looking like it was still running, which is the state this
   * whole kernel is built to make impossible.
   */
  for (const [, { round, missionDone }] of byOrchestration) {
    if (!missionDone) continue;
    const found = foundPerRound.get(round.id) ?? 0;
    if (await closeCommerceRound({ id: round.id, to: 'HARVESTED', found })) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  if (out.channels.length + out.propositions.length + out.evidence.length > 0) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: ABSORBED,
      actorRef: 'BRAIN',
      summary:
        `${out.channels.length} channel${out.channels.length === 1 ? '' : 's'}, ` +
        `${out.propositions.length} proposition${out.propositions.length === 1 ? '' : 's'} and ` +
        `${out.evidence.length} reading${out.evidence.length === 1 ? '' : 's'} were filed from ` +
        'what the commerce kernel established.',
      detail: {
        channelIds: out.channels.map((one) => one.id),
        propositionIds: out.propositions.map((one) => one.id),
        evidenceIds: out.evidence.map((one) => one.id),
        refused: out.refused,
      },
    });
  }
  return out;
}

/**
 * One declared finding into the one table its kind belongs in.
 *
 * Every branch refuses rather than improvises. A reading about a proposition
 * on a round that names none is *reported* as refused rather than attached to
 * something plausible — attaching it would be Brain deciding which product a
 * figure was about, which is the confidently wrong answer §25 records.
 */
async function file(input: {
  projectId: string;
  cashModeId: string;
  claim: ResearchClaim;
  round: CommerceRound;
  channelByName: Map<string, CommerceChannel>;
  propositions: CommerceProposition[];
  out: Absorbed;
}): Promise<boolean> {
  const { claim, round, out } = input;
  const finding = claim.commerceFinding;
  const subject = claim.commerceSubject;
  if (!finding || !subject) return false;
  const spec = commerceSpec(finding);

  if (spec.creates === 'CHANNEL') {
    const created = await createChannel({
      projectId: input.projectId,
      name: subject,
      description: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    input.channelByName.set(created.channel.name.toLowerCase(), created.channel);
    if (created.created) {
      out.channels.push(created.channel);
      return true;
    }
    return false;
  }

  if (spec.creates === 'PROPOSITION') {
    /*
     * A product names its channel, and the channel has to already exist.
     *
     * Resolved by name from rows already written rather than created here,
     * deliberately: a `CHANNEL` finding is what puts a channel on the map, and
     * letting a product candidate create one as a side effect would mean a
     * channel could arrive with no claim establishing that it *is* a channel —
     * the origin CHECK satisfied by a row that never answered the question.
     *
     * A round about a channel supplies it when the claim's own qualifier does
     * not resolve, which is the ordinary case: a PRODUCTS round already knows
     * which channel it asked about.
     */
    const named = claim.commerceQualifier
      ? input.channelByName.get(claim.commerceQualifier.toLowerCase())
      : undefined;
    const channel = named ?? (round.channelId ? await getChannel(round.channelId) : null);
    if (!channel) {
      out.refused.push({
        claimId: claim.id,
        why:
          `It names "${claim.commerceQualifier}" as the channel, and no channel by that name is ` +
          'on the map. It is filed once one is — Brain does not create a channel as a side ' +
          'effect of a product, because that channel would have nothing establishing it is one.',
      });
      return false;
    }
    const created = await createProposition({
      projectId: input.projectId,
      cashModeId: input.cashModeId,
      channelId: channel.id,
      product: subject,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created.created) {
      input.propositions.push(created.proposition);
      out.propositions.push(created.proposition);
      return true;
    }
    return false;
  }

  /*
   * Everything else is a reading, and the round says what it is about.
   *
   * A round about one proposition files against that proposition; a round
   * about a channel files against the channel, because a platform's commission
   * and its eligibility rules are facts about the channel rather than about
   * any one product sold on it.
   */
  const target = targetOf({ round, subject, channelByName: input.channelByName });
  if (!target) {
    out.refused.push({
      claimId: claim.id,
      why:
        `A ${finding} was declared on a ${round.purpose} round, which is about no one ` +
        `proposition or channel, and "${subject}" does not name a channel on the map. There is ` +
        'nothing for the reading to be about, so it stays as evidence on its claim rather than ' +
        'being attached to whichever channel happens to be nearest.',
    });
    return false;
  }

  const recorded = await recordEvidence({
    projectId: input.projectId,
    propositionId: target.propositionId,
    channelId: target.channelId,
    kind: finding,
    statement: claim.claim,
    origin: 'CLAIM',
    sourceClaimId: claim.id,
    amountMinor: claim.commerceAmountMinor,
    ratePpm: claim.commerceRatePpm,
    days: claim.commerceDays,
    countUnits: claim.commerceCount,
    /*
     * The source's own date, never the date Brain filed it.
     *
     * §30's rule that an undated signal cannot be told apart from one somebody
     * remembers from March. `sourceDate` is null on plenty of claims and that
     * is recorded as null rather than back-filled from `created_at`, which
     * would make every reading look freshly observed.
     */
    observedAt: claim.sourceDate,
  });
  if (!recorded) return false;
  out.evidence.push(recorded);

  /*
   * A supplier reading also fills the proposition's own supplier, where it is
   * still blank.
   *
   * `fillProposition` only ever fills a blank, so a second supplier found
   * later does not overwrite the first — it stays on its own evidence row
   * where a reader can see that two exist. §5's rule that new evidence never
   * silently overwrites old, at a column.
   */
  if (finding === 'SUPPLIER_AVAILABLE' && target.propositionId) {
    await fillProposition({ id: target.propositionId, supplier: subject });
  }
  return true;
}

/**
 * Which row a reading is about.
 *
 * The round decides it wherever the round names something, which is every
 * round but the bootstrap. A `CHANNELS` round establishes several platforms at
 * once and their published commissions with them, so there the *subject* has
 * to say which platform each figure belongs to — and it is matched **exactly**
 * against a channel already on the map rather than being resolved by
 * similarity. A fee attached to whichever channel happened to be nearest would
 * be the confidently wrong answer §25 records, at the number that decides a
 * margin.
 *
 * `subject` is deliberately not compared on a round that already names its
 * subject: an ELIGIBILITY round about one channel knows which channel it
 * asked about, and requiring a worker to re-type the platform's name exactly
 * would refuse correct work over a spelling.
 */
function targetOf(input: {
  round: CommerceRound;
  subject: string;
  channelByName: Map<string, CommerceChannel>;
}): { propositionId: string | null; channelId: string | null } | null {
  const { round } = input;
  if (round.propositionId) return { propositionId: round.propositionId, channelId: null };
  if (round.channelId) return { propositionId: null, channelId: round.channelId };
  const named = input.channelByName.get(input.subject.toLowerCase());
  return named ? { propositionId: null, channelId: named.id } : null;
}
