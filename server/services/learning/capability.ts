/**
 * When one limitation keeps stopping worthwhile work, propose changing Brain.
 *
 * ---------------------------------------------------------------------------
 * Derived from outcomes, decided by a person
 * ---------------------------------------------------------------------------
 *
 * A proposal exists because outcome rows say the same blocker stopped at least
 * `RECURRENCE_FLOOR` attempts on at least two different subjects. It is never
 * stored: it is recomputed from those rows on every read, so it sharpens as
 * attempts accumulate and quietly reports "has not recurred since" once the
 * blocker stops. What *is* stored is a person's answer — which route to take,
 * the change request it became, and the instant the change went live — because
 * none of those can be derived.
 *
 * ---------------------------------------------------------------------------
 * Three routes, compared on what is actually known
 * ---------------------------------------------------------------------------
 *
 * Implement it (a factory campaign on this repository), connect an existing
 * service, or have a person do it each time. Each route says whether it is
 * viable here and why, what it would cost in the units something measured —
 * and says UNKNOWN where nothing did — and the first cheap way to test it.
 * Brain recommends one and says why; it never picks for the person.
 *
 * ---------------------------------------------------------------------------
 * Verification is the same rows, read after the change
 * ---------------------------------------------------------------------------
 *
 * Once a person records that the change is live, the proposal reads the
 * attempts launched *after* that instant: any that hit the same blocker means
 * NOT_SOLVED; at least one that performed work and none that hit it means
 * SOLVED; none yet means AWAITING_EVIDENCE. Nobody is asked whether it worked,
 * and nothing counts as evidence that was launched before the change existed.
 */
import { createHash } from 'node:crypto';
import {
  RECURRENCE_FLOOR,
  type Approach,
  type BlockerClass,
  type CapabilityRoute,
  type EvidenceClass,
} from '../../domain/learning.ts';
import {
  currentOutcomes,
  listCapabilityDecisions,
  listOutcomes,
  listPredictions,
  withdrawnTargets,
  listCorrections,
  type CapabilityDecision,
  type OutcomePrediction,
  type OutcomeRecord,
} from '../../repos/learning.ts';

/** Blockers that are Brain's own machinery refusing Brain's own work. */
const INTERNAL: ReadonlySet<BlockerClass> = new Set(['PLAN_OUTSIDE_ENVELOPE', 'ENVELOPE_UNAVAILABLE']);

export interface RouteOption {
  route: Exclude<CapabilityRoute, 'DECLINE'>;
  viable: boolean;
  why: string;
  cost: { evidence: EvidenceClass; text: string };
  firstTest: string;
}

export interface FactoryObjectiveDraft {
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptanceConditions: { statement: string; verification: string; mandatory: boolean }[];
}

export type ProposalState =
  | 'PROPOSED'
  | 'DECLINED'
  | 'APPROVED'
  | 'AWAITING_EVIDENCE'
  | 'VERIFIED_SOLVED'
  | 'NOT_SOLVED';

export interface CapabilityProposal {
  blockerKey: string;
  approach: Approach;
  blockerClass: BlockerClass;
  /** The refusal in Brain's own recorded words. */
  reason: string;
  occurrences: number;
  subjects: number;
  outcomeIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  unlocks: string;
  valueEvidence: string;
  options: RouteOption[];
  recommended: Exclude<CapabilityRoute, 'DECLINE'> | null;
  recommendedBecause: string;
  objective: FactoryObjectiveDraft | null;
  /** Attempts after the last occurrence, measured: did the blocker stop? */
  sinceLastSeen: { attempts: number; performedWork: number };
  decisions: CapabilityDecision[];
  state: ProposalState;
  verification: string;
}

/** Brain's refusal sentence with the per-attempt names taken out, so two refusals for one reason are one key. */
export function blockerSignature(detail: string | null): string {
  return (detail ?? '')
    .replace(/fragment "[^"]*"/g, 'fragment')
    .replace(/\b(?:orc|rcn|cop|rms|bin)_[a-z0-9]+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function blockerKeyOf(outcome: OutcomeRecord): string {
  const detail = typeof outcome.conditions['blockerDetail'] === 'string' ? outcome.conditions['blockerDetail'] : null;
  const digest = createHash('sha256').update(blockerSignature(detail)).digest('hex').slice(0, 12);
  return `${outcome.approach}:${outcome.blockerClass ?? 'OTHER'}:${digest}`;
}

/** The recurring blockers in one project, each with its routes compared. */
export async function capabilityProposals(projectId: string): Promise<CapabilityProposal[]> {
  const [all, corrections, decisions, predictions] = await Promise.all([
    listOutcomes(projectId),
    listCorrections(projectId),
    listCapabilityDecisions(projectId),
    listPredictions(projectId),
  ]);
  return deriveProposals({ outcomes: all, corrections, decisions, predictions });
}

export function deriveProposals(input: {
  outcomes: OutcomeRecord[];
  corrections: Parameters<typeof withdrawnTargets>[0];
  decisions: CapabilityDecision[];
  predictions: OutcomePrediction[];
}): CapabilityProposal[] {
  const withdrawn = withdrawnTargets(input.corrections);
  const outcomes = currentOutcomes(input.outcomes).filter(
    (outcome) => !withdrawn.has(`OUTCOME|${outcome.id}`),
  );
  const blocked = outcomes.filter(
    (outcome) => !outcome.workPerformed && outcome.result === 'NOT_ATTEMPTED' && outcome.blockerClass,
  );
  const groups = new Map<string, OutcomeRecord[]>();
  for (const outcome of blocked) {
    const key = blockerKeyOf(outcome);
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }

  const out: CapabilityProposal[] = [];
  for (const [key, group] of groups) {
    const subjects = new Set(group.map((one) => one.subjectId));
    if (group.length < RECURRENCE_FLOOR || subjects.size < 2) continue;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const blockerClass = first.blockerClass!;
    const reason =
      (typeof last.conditions['blockerDetail'] === 'string' && last.conditions['blockerDetail']) ||
      last.explanation;
    const approachOutcomes = outcomes.filter((one) => one.approach === first.approach);
    const later = approachOutcomes.filter(
      (one) => one.observedAt > last.observedAt && one.result !== 'ONGOING',
    );
    const signals = new Map<string, number>();
    for (const one of group) {
      const signal = String(one.conditions['signal'] ?? 'unrecorded');
      signals.set(signal, (signals.get(signal) ?? 0) + 1);
    }
    const everQualified = approachOutcomes.filter((one) => one.result === 'SUCCEEDED').length;
    const internal = INTERNAL.has(blockerClass);
    const options = routeOptions({ blockerClass, count: group.length, internal });
    const recommended: CapabilityProposal['recommended'] = internal
      ? 'IMPLEMENT'
      : blockerClass === 'WAITING_ON_PERSON'
        ? 'PERSON'
        : null;
    const recommendedBecause = internal
      ? `The refusal comes from Brain's own machinery, so it recurs on every attempt: a person ` +
        `approving each one is ${group.length} decision(s) so far and one more per future attempt, ` +
        'while changing Brain removes the refusal for all of them.'
      : blockerClass === 'WAITING_ON_PERSON'
        ? 'The attempts stopped at a decision that belongs to a person; that decision is the remedy.'
        : 'The cause is not established from the rows, so Brain recommends a reading before any route.';

    const decisions = input.decisions.filter((one) => one.blockerKey === key);
    const { state, verification } = verify({
      decisions,
      predictions: input.predictions,
      approachOutcomes,
      key,
    });

    out.push({
      blockerKey: key,
      approach: first.approach,
      blockerClass,
      reason,
      occurrences: group.length,
      subjects: subjects.size,
      outcomeIds: group.map((one) => one.id),
      firstSeenAt: first.observedAt,
      lastSeenAt: last.observedAt,
      unlocks:
        `${subjects.size} opening(s) whose deep dive never ran — ` +
        [...signals.entries()].map(([signal, count]) => `${count} ${signal}`).join(', ') +
        ' — and every future dive for as long as the refusal persists.',
      valueEvidence:
        everQualified > 0
          ? `${everQualified} deep dive(s) in this project have established a payer, so a dive that runs ` +
            'is known to be able to produce one.'
          : 'No deep dive in this project has yet established a payer, so what an unblocked dive is ' +
            'worth is not measured. What is measured is that none of these could produce any evidence ' +
            'at all while the refusal stands.',
      options,
      recommended,
      recommendedBecause,
      objective: internal ? objectiveFor({ approach: first.approach, reason, count: group.length, subjects: subjects.size }) : null,
      sinceLastSeen: {
        attempts: later.length,
        performedWork: later.filter((one) => one.workPerformed).length,
      },
      decisions,
      state,
      verification,
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}

function routeOptions(input: {
  blockerClass: BlockerClass;
  count: number;
  internal: boolean;
}): RouteOption[] {
  return [
    {
      route: 'IMPLEMENT',
      viable: input.internal || input.blockerClass === 'STALLED',
      why: input.internal
        ? "The refusal is Brain's own code refusing Brain's own work; only a change to Brain removes it."
        : 'Only worth it once the cause is established from the rows.',
      cost: {
        evidence: 'UNKNOWN',
        text:
          'One Software Factory campaign on this repository. How long one takes here has not been ' +
          'measured, so no figure is given.',
      },
      firstTest:
        'After the change is live, launch one probe dive: it must record at least one research pass ' +
        'and must not be refused for the same reason.',
    },
    {
      route: 'CONNECT_SERVICE',
      viable: !input.internal && input.blockerClass !== 'WAITING_ON_PERSON',
      why: input.internal
        ? 'No outside service answers a check Brain performs on its own plan.'
        : 'Possible where the missing ability is something a service already provides.',
      cost: { evidence: 'UNKNOWN', text: 'Not assessed: no candidate service is recorded.' },
      firstTest: 'Name the service and connect it to one blocked attempt before any other.',
    },
    {
      route: 'PERSON',
      viable: true,
      why: input.internal
        ? 'A person can approve each refused plan in Needs you, one at a time.'
        : 'A person can answer each blocked attempt.',
      cost: {
        evidence: 'MEASURED',
        text: `${input.count} person decision(s) so far, one per blocked attempt, and one more for each future attempt. How many minutes each takes is not recorded.`,
      },
      firstTest: 'Answer the newest blocked attempt and see whether its research then runs.',
    },
  ];
}

/** The factory ask a person would approve, composed from the rows rather than a template. */
function objectiveFor(input: {
  approach: Approach;
  reason: string;
  count: number;
  subjects: number;
}): FactoryObjectiveDraft {
  return {
    objective:
      `Stop Brain refusing its own ${input.approach === 'CASH_DEEP_DIVE' ? 'deep-dive' : 'work'} plans. ` +
      `${input.count} attempts on ${input.subjects} different subjects ended before any work was ` +
      `done, each with the same recorded refusal: "${input.reason}"`,
    expectedOutcome:
      'The next attempt Brain launches performs work (at least one research pass is recorded) ' +
      'instead of stopping at the same refusal, and the refusal still fires for a plan that ' +
      'genuinely instructs a forbidden action.',
    nonGoals: [
      'Widening what any approval envelope authorizes. A refusal that is correct must stay a refusal.',
      'Approving any plan by hand or editing any recorded outcome.',
    ],
    acceptanceConditions: [
      {
        statement:
          'A regression test compiles the plan text that was refused and shows it now passes the ' +
          'envelope, and was run against the unfixed code to confirm it failed there first.',
        verification: 'npm test',
        mandatory: true,
      },
      {
        statement: 'A plan that genuinely instructs the forbidden action is still refused.',
        verification: 'npm test',
        mandatory: true,
      },
    ],
  };
}

function verify(input: {
  decisions: CapabilityDecision[];
  predictions: OutcomePrediction[];
  approachOutcomes: OutcomeRecord[];
  key: string;
}): { state: ProposalState; verification: string } {
  const latest = input.decisions[input.decisions.length - 1];
  if (!latest) {
    return { state: 'PROPOSED', verification: 'No person has decided on this yet.' };
  }
  if (latest.route === 'DECLINE') {
    return { state: 'DECLINED', verification: `Declined: ${latest.reason}` };
  }
  const landed = [...input.decisions].reverse().find((one) => one.landedAt);
  if (!landed?.landedAt) {
    return {
      state: 'APPROVED',
      verification:
        `Approved as ${latest.route}` +
        (latest.changeRequestId ? ` (change request ${latest.changeRequestId})` : '') +
        '. Nothing is verified until a person records the instant the change went live.',
    };
  }
  const since = landed.landedAt;
  const launchedAfter = new Set(
    input.predictions
      .filter((one) => one.decidedAt > since)
      .map((one) => `${one.subjectId}|${one.attempt}`),
  );
  const after = input.approachOutcomes.filter(
    (one) => launchedAfter.has(`${one.subjectId}|${one.attempt}`) && one.result !== 'ONGOING',
  );
  const hits = after.filter((one) => one.result === 'NOT_ATTEMPTED' && blockerKeyOf(one) === input.key);
  const worked = after.filter((one) => one.workPerformed);
  if (hits.length > 0) {
    return {
      state: 'NOT_SOLVED',
      verification:
        `${hits.length} attempt(s) launched after the change went live at ${since} hit the same ` +
        `refusal (${hits.map((one) => one.id).join(', ')}). The change did not solve it.`,
    };
  }
  if (worked.length > 0) {
    return {
      state: 'VERIFIED_SOLVED',
      verification:
        `${worked.length} attempt(s) launched after ${since} performed work and none hit the ` +
        `refusal (${worked.map((one) => one.id).join(', ')}).`,
    };
  }
  return {
    state: 'AWAITING_EVIDENCE',
    verification: `The change went live at ${since}; no attempt launched since then has settled yet.`,
  };
}
