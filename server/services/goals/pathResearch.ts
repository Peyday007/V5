/**
 * Research the path to the money for the openings a goal's plan rests on.
 *
 * A plan is only as good as the facts under each opening, and most of them
 * start unknown: how long until money is actually in the account, what it
 * costs, what has to go out first, what buyers really pay. The scenario engine
 * sweeps an unknown; it never learns it. So for the openings closest to being
 * a realistic plan — judged on every opening Brain holds, not only the few the
 * simulation fits — each missing fact that published sources can settle
 * becomes one narrow research need through the ordinary path: `raiseNeed`, the
 * same question key the engine-gap pass uses, `startDependentWork` turning it
 * into an idea, and the standing research grant deciding whether it runs. The
 * answer lands on the card through the evidence gate and the next plan reading
 * uses it.
 *
 * It asks for the path rather than a number: each step between first contact
 * and money in the account, who decides it, how long it takes and the payment
 * terms — because that is what turns "3 to 60 days" into a fact.
 *
 * What research cannot settle is not asked here: whether buyers will say yes
 * is a test, and reaching them is a permission.
 */
import { getOpportunity, listNeeds } from '../../repos/cashPortfolio.ts';
import { closeNeed, raiseNeed } from '../cash/needs.ts';
import { cardFact } from '../../repos/cashCardFacts.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { questionKey } from '../cash/conditions.ts';
import { diveOwnsItsQuestions } from '../cash/operate.ts';
import { parseBlockerKey } from '../../domain/types.ts';
import type { ChainLink, PlanReading } from './plan.ts';

/**
 * The smallest share of what is still needed an opening must be able to bring
 * to be worth researching. Several smaller sources may still make the goal,
 * but each has to matter: an opening that cannot bring a tenth of the gap even
 * if every buyer agreed costs research it can never repay.
 */
export const MIN_SHARE_WORTH_RESEARCHING = 0.1;

/** At most this many openings per goal get path research at once. */
export const PATH_RESEARCH_OPENINGS = 4;
/** And at most this many path questions open per goal at once. */
export const MAX_OPEN_PATH_QUESTIONS = 8;
/** A question whose research ended without an answer is asked again after this long… */
export const REASK_AFTER_MS = 24 * 60 * 60 * 1000;
/** …and at most this many times in all, so a question nobody can answer stops. */
export const MAX_ASKINGS = 3;

const FIELDS_FOR: Partial<Record<ChainLink, { field: string; ask: string }[]>> = {
  SETTLES_IN_TIME: [
    {
      field: 'timeToFirstCash',
      ask:
        'Lay out the path from first contact to money actually in the seller’s account: each step, who decides it, ' +
        'how long each takes, and the published payment or payout terms — then state the days from start to usable cash.',
    },
  ],
  ECONOMICS: [
    { field: 'directCosts', ask: 'Find the published costs of delivering one sale: tools, materials, fees, subcontracted work, shipping.' },
    { field: 'requiredCapital', ask: 'State the most money that goes out before any comes back for one sale, and when it goes out.' },
  ],
  OFFER_AND_PRICE: [
    { field: 'revenueRange', ask: 'Find what buyers are published as actually paying for this — a figure or a range, each with its source and date.' },
  ],
};

export async function researchGoalPaths(input: {
  reading: PlanReading;
  projectId: string;
  now?: Date;
  /** Each opening's outcome in words, for the operator readout. */
  trace?: string[];
  /** Decide only: raise and withdraw nothing. */
  dryRun?: boolean;
  /**
   * Research surfaces idle with nothing waiting. Each one lets one more
   * opening, and two more questions, be researched at once — the caps below
   * are a floor for a busy fleet, not a ceiling on an idle one.
   */
  spare?: number;
}): Promise<string[]> {
  const spare = Math.max(0, Math.trunc(input.spare ?? 0));
  const openingCap = PATH_RESEARCH_OPENINGS + spare;
  const questionCap = MAX_OPEN_PATH_QUESTIONS + 2 * spare;
  const note = (line: string) => input.trace?.push(line);
  const now = input.now ?? new Date();
  const raised: string[] = [];
  const considered = input.reading.considered;
  const ids = new Set(considered.map((one) => one.opportunityId));
  const open = await listNeeds({ projectId: input.projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));
  /*
   * The cap counts questions whose research is still alive. Production,
   * 2026-10-29: 161 questions sat OPEN on these openings with their research
   * long dead, and counting them filled the cap of eight before the loop
   * began, so nothing was ever asked or asked again.
   */
  let openHere = 0;
  for (const one of open) {
    if (!one.opportunityId || !ids.has(one.opportunityId) || !one.requestKey?.startsWith('question:')) continue;
    if (await researchAlive(one.candidateId)) openHere += 1;
  }

  /*
   * The questions that could change the next decision first: ways that pay in
   * steps before an award, then the openings the plan is actually built from,
   * then the ones closest to complete, then the largest supported reach. The
   * rest wait; they never stop discovery, which runs on its own counter.
   */
  const remaining = input.reading.target.remainingCents / 100;
  const floor = remaining * MIN_SHARE_WORTH_RESEARCHING;
  const potential = (one: (typeof considered)[number]) => Math.max(one.supportedReach, one.potentialReach ?? 0);
  // Biggest possible contribution first, so research goes where an answer can
  // change what Brain pursues; an award only after ways that pay in steps.
  const order = [...considered].sort(
    (a, b) =>
      Number(a.competitiveAward) - Number(b.competitiveAward) ||
      potential(b) - potential(a) ||
      b.supportedReach - a.supportedReach ||
      a.missing.length - b.missing.length,
  );
  /*
   * What the run measured (§79): an unknown whose answer cannot change the
   * choice of strategy is not researched, and one that waiting for would cost
   * the deadline is acted on or learned by doing instead. Questions that do
   * change the choice go first, largest value first.
   */
  const priority = new Map<string, NonNullable<PlanReading['researchPriority']>[number]>();
  for (const one of input.reading.researchPriority ?? []) if (one.opportunityId && one.field) priority.set(`${one.opportunityId}:${one.field}`, one);
  const valueOf = (id: string) => Math.max(0, ...[...priority.values()].filter((one) => one.opportunityId === id && one.decision === 'RESEARCH_FIRST').map((one) => one.value));
  if (priority.size > 0) order.sort((a, b) => valueOf(b.opportunityId) - valueOf(a.opportunityId));
  let openings = 0;
  for (const one of order) {
    if (openings >= openingCap || openHere >= questionCap) break;
    let asks = one.missing.flatMap((link) => FIELDS_FOR[link] ?? []);
    if (asks.length === 0) continue;
    /*
     * Worth asking about only if the answer could change what Brain pursues.
     * An opening whose most, even with every buyer agreeing, is under a tenth
     * of the gap is not researched further: its costs and timing cannot make
     * it a plan. One with no price buyers are shown to pay — none at all, or
     * only a guess — is asked one thing first, what buyers actually pay,
     * because that answer decides whether anything else is worth asking.
     */
    if (potential(one) < floor && one.potentialReach !== null) {
      note(`${one.title.slice(0, 60)}: too small to matter — at most ${Math.round(potential(one))} of the ${Math.round(remaining)} still needed, even if every buyer agreed`);
      continue;
    }
    if (one.supportedReach < floor) {
      // No supported price big enough yet: what buyers actually pay decides
      // whether anything else about it is worth asking, so ask that alone.
      asks = [FIELDS_FOR.OFFER_AND_PRICE![0]!];
    }
    const opportunity = await getOpportunity(one.opportunityId);
    if (!opportunity) continue;
    if (diveOwnsItsQuestions(opportunity)) {
      note(`${one.title.slice(0, 60)}: its deep dive owns these questions (${opportunity.validationState})`);
      continue;
    }
    // An opening counts toward the budget only when it gets live research:
    // spending the budget on openings where nothing could be asked left the
    // next ones unresearched.
    let actedHere = false;
    for (const { field, ask } of asks) {
      if (openHere >= questionCap) break;
      const measured = priority.get(`${one.opportunityId}:${field}`);
      if (measured && measured.decision !== 'RESEARCH_FIRST') {
        note(`${one.title.slice(0, 60)} ${field}: not asked — ${measured.decision.toLowerCase().replace(/_/g, ' ')}: ${measured.reason}`);
        continue;
      }
      const key = questionKey(opportunity.id, field);
      // Already established from a source or by a person: asking again would
      // be settled the instant it was raised and re-raised on the next read.
      const known = await cardFact(opportunity.id, field);
      if (known && known.value !== null && known.kind !== 'RECOMMENDATION') {
        note(`${one.title.slice(0, 60)} ${field}: already established (${String(known.value).slice(0, 40)})`);
        continue;
      }
      let nextStep = ask;
      if (keys.has(key)) {
        // Already asked. Ask again only when that research ended without an
        // answer a while ago — and never the same way: production held 161
        // such questions OPEN for ever, their missions FAILED, so the openings
        // a goal rests on were never researched again.
        const stale = open.find((one) => one.requestKey === key);
        if (!stale) continue;
        if (stale.occurrence >= MAX_ASKINGS) {
          note(`${one.title.slice(0, 60)} ${field}: asked ${stale.occurrence} times already`);
          continue;
        }
        const ended = await endedWithoutAnswer(stale.candidateId, now);
        if (!ended) {
          if (await researchAlive(stale.candidateId)) actedHere = true;
          note(`${one.title.slice(0, 60)} ${field}: ${(await researchAlive(stale.candidateId)) ? 'being researched' : 'ended less than a day ago'}`);
          continue;
        }
        if (input.dryRun) {
          note(`${one.title.slice(0, 60)} ${field}: would ask again (${ended.reason.slice(0, 80)})`);
          actedHere = true;
          continue;
        }
        const closed = await closeNeed({
          needId: stale.id,
          to: 'WITHDRAWN',
          resolution: `Its research ended without an answer (${ended.reason}); asked again a different way.`,
          actorUserId: 'BRAIN',
        });
        if (!closed.ok) continue;
        keys.delete(key);
        nextStep = differentMethod(ask, stale.occurrence + 1, ended.reason);
      }
      if (input.dryRun) {
        note(`${one.title.slice(0, 60)} ${field}: would ask`);
        actedHere = true;
        continue;
      }
      const need = await raiseNeed({
        projectId: input.projectId,
        opportunityId: opportunity.id,
        actorRef: 'BRAIN',
        blockedAction: `The path to money for "${opportunity.title.slice(0, 120)}"`,
        whyItMatters:
          'A goal plan rests on this opening, and until this is established from sources its numbers are a sweep of guesses rather than a plan.',
        recommendedPath: nextStep,
        setupEffort: 'One bounded look.',
        nextStep,
        completionCondition: `The ${field} is recorded on this card.`,
        blocksState: 'EXECUTING',
        requestKey: key,
        blockerKey: parseBlockerKey(`FIELD:${field}`),
      });
      if (!need.ok) {
        note(`${one.title.slice(0, 60)} ${field}: refused — ${need.reason}`);
        continue;
      }
      keys.add(key);
      openHere += 1;
      actedHere = true;
      raised.push(need.value.id);
      note(`${one.title.slice(0, 60)} ${field}: asked`);
    }
    if (actedHere) openings += 1;
  }
  note(`live path questions ${openHere} of ${questionCap}; openings researched ${openings} of ${openingCap}`);
  return raised;
}

/**
 * The same question, asked a different way. The second asking names what went
 * wrong and turns to other kinds of source; the third answers from comparable
 * published cases. Never the identical search twice.
 */
export function differentMethod(ask: string, asking: number, previous: string): string {
  const why = previous.replace(/\s+/g, ' ').trim().slice(0, 240);
  const method =
    asking <= 2
      ? 'Do not repeat that approach. Use other kinds of source — the buyer’s or platform’s own published terms and payout pages, official filings, trade or industry publications, archived copies of pages that are now unavailable — and say which you used.'
      : 'Two attempts found no direct answer. Answer from the closest comparable published cases instead: name each comparable business or transaction, its published figure or terms with source and date, and how it compares to this opening. Say plainly if nothing comparable is published.';
  return `${ask} An earlier attempt ended without an answer: ${why}. ${method}`;
}

/** True while a question is waiting to be asked or its research is still under way. */
async function researchAlive(candidateId: string | null): Promise<boolean> {
  if (!candidateId) return true;
  const candidate = await getCandidate(candidateId);
  if (!candidate) return false;
  if (candidate.state === 'REJECTED' || candidate.state === 'PARKED' || candidate.state === 'MERGED' || candidate.state === 'DONE') return false;
  const mission = await latestMissionForCandidate(candidateId);
  if (!mission) return true;
  // A mission parked on a person uses no capacity and is not research under way.
  return mission.state !== 'FAILED' && mission.state !== 'CANCELLED' && mission.state !== 'DONE' && mission.state !== 'NEEDS_HUMAN';
}

/** Why the question's research ended without an answer, when it did so long enough ago. */
async function endedWithoutAnswer(candidateId: string | null, now: Date): Promise<{ reason: string } | null> {
  if (!candidateId) return null;
  const candidate = await getCandidate(candidateId);
  if (!candidate) return null;
  const mission = await latestMissionForCandidate(candidateId);
  if (mission) {
    // A mission parked on a person for a day — the judge asked for more and
    // nothing could be attempted — is as stuck as a failed one.
    if (mission.state !== 'FAILED' && mission.state !== 'CANCELLED' && mission.state !== 'NEEDS_HUMAN') return null;
    if (now.getTime() - Date.parse(mission.completedAt ?? mission.updatedAt) < REASK_AFTER_MS) return null;
    return { reason: mission.terminalReason ?? mission.waitingOn ?? `the research ${mission.state.toLowerCase()} without saying why` };
  }
  // No mission: the idea was parked or turned away before any research ran.
  if (candidate.state !== 'PARKED' && candidate.state !== 'REJECTED') return null;
  if (now.getTime() - Date.parse(candidate.updatedAt) < REASK_AFTER_MS) return null;
  return { reason: candidate.reason ?? `the question was ${candidate.state.toLowerCase()} before any research ran` };
}
