/**
 * The adaptive research decision, as a pure function of a recorded snapshot.
 *
 * ---------------------------------------------------------------------------
 * Why pure, and why that is not the safety mechanism
 * ---------------------------------------------------------------------------
 *
 * `services/dispatch/router.ts` makes the argument for the first half: a
 * decision taken over a snapshot can be explained afterwards, because the
 * inputs were recorded. Re-running a decision against a database that has moved
 * answers a different question and reads like an explanation.
 *
 * It also makes the argument for the second half, and it applies here word for
 * word: being pure makes this **useless as a safety mechanism**. Nothing in this
 * module writes anything. Every decision it reaches is a proposal that
 * `apply.ts` validates against the live rows and may refuse — and every refusal
 * is kept on the revision, because a decision the deterministic layer declined
 * is worth reading and must never be shown as something that happened.
 *
 * ---------------------------------------------------------------------------
 * What this is allowed to decide
 * ---------------------------------------------------------------------------
 *
 * Only what bears on the *plan*: which question to ask next, which branch has
 * stopped being worth pursuing, which disagreement needs attacking, how hard to
 * look, and whether there is anything left worth doing. It cannot accept a
 * claim, move a coverage status, lower an evidence bar, advance an audit
 * verdict or approve a plan, and `apply.ts` has no path to any of those either.
 *
 * ---------------------------------------------------------------------------
 * Every decision is read off a row
 * ---------------------------------------------------------------------------
 *
 * There is no prose interpretation anywhere in this file. A fragment's status,
 * a claim's `contradiction_state`, a claim's `retrieval_state`, a coverage
 * status, a declared dependency kind — all rows Brain wrote. The two genuinely
 * semantic judgements a campaign needs (what a finding *means*, and which new
 * question it raises) arrive as a validated proposal through `proposals.ts` and
 * are a separate input to `apply.ts`, never something guessed here.
 */
import { DEPENDENCY_DOOM_PREFIX } from '../packetRunner.ts';
import { allocateDepth, strongerDepth } from './depth.ts';
import { downstream, isLive, rank } from './uncertainty.ts';
import type {
  RequirementCoverage,
  Requirement,
  ResearchClaim,
  ResearchDepth,
  ResearchFragment,
  RetrievalState,
  ResearchUncertainty,
  ResearchUncertaintyLink,
} from '../../../domain/types.ts';

/**
 * Everything the director is allowed to look at, read once.
 *
 * Passed in rather than fetched, so a caller can hand it a state it recorded and
 * get the same answer back — which is what makes "why did the plan change" a
 * question with an answer.
 */
export interface DirectorSnapshot {
  orchestrationId: string;
  projectId: string;
  fragments: ResearchFragment[];
  claims: ResearchClaim[];
  uncertainties: ResearchUncertainty[];
  links: ResearchUncertaintyLink[];
  requirements: Requirement[];
  coverage: RequirementCoverage[];
  /** True when a person authorized this packet to file short. */
  mayRecordGaps: boolean;
}

export type DirectorDecision =
  | {
      kind: 'RESOLVE_UNCERTAINTY';
      uncertaintyKey: string;
      fragmentId: string;
      belief: string;
      why: string;
    }
  | {
      kind: 'MARK_UNRESOLVABLE';
      uncertaintyKey: string;
      fragmentId: string | null;
      why: string;
    }
  | {
      kind: 'MARK_ACCESS_BLOCKED';
      uncertaintyKey: string;
      unreadableSources: number;
      why: string;
    }
  | {
      kind: 'RETIRE_BRANCH';
      uncertaintyKey: string;
      becauseKey: string;
      why: string;
    }
  | {
      kind: 'RAISE_DEPTH';
      uncertaintyKey: string;
      to: ResearchDepth;
      why: string;
    }
  | {
      kind: 'OPEN_CHALLENGE';
      uncertaintyKey: string;
      challengesKey: string;
      question: string;
      claimIds: string[];
      why: string;
    }
  | {
      kind: 'OPEN_FOLLOW_UP_WORK';
      uncertaintyKey: string;
      question: string;
      why: string;
    }
  | {
      kind: 'INVESTIGATE_NEXT';
      uncertaintyKey: string;
      why: string;
    };

export interface DirectorVerdict {
  decisions: DirectorDecision[];
  /** The ordered live agenda, so a caller can show what is next and why. */
  agenda: { uncertaintyKey: string; why: string }[];
  /** One sentence for the revision row. */
  summary: string;
}

/** A fragment blocked because something it depended on never arrived. */
function strandedByDependency(fragment: ResearchFragment): boolean {
  return (fragment.blockedReason ?? '').startsWith(DEPENDENCY_DOOM_PREFIX);
}

/**
 * Claims whose source nobody could open.
 *
 * §12 already draws this line at the gate — a source that could not be read
 * gets no verdict at all and is excluded from the rejection rate — and it has to
 * be drawn again here for the same reason one level up: an uncertainty whose
 * only evidence was unreadable is **not refuted**, and recording it as though it
 * were would turn a network problem into a finding about the world. Required
 * scenario 4.
 */
const UNREADABLE: readonly RetrievalState[] = [
  'PAYWALLED',
  'ROBOTS_BLOCKED',
  'JS_ONLY',
  'NOT_REACHABLE',
];

function unreadable(claims: ResearchClaim[]): ResearchClaim[] {
  return claims.filter((claim) => UNREADABLE.includes(claim.retrievalState));
}

/**
 * Decide what should change about the plan, given these rows.
 *
 * The order of the passes is not arbitrary: resolutions and failures first, so
 * that retirement reasons about dispositions this same call established; then
 * retirement, so depth and challenges are never raised on a branch that has just
 * stopped mattering; then the new work; then the agenda.
 */
export function direct(snapshot: DirectorSnapshot): DirectorVerdict {
  const decisions: DirectorDecision[] = [];
  const byKey = new Map(snapshot.uncertainties.map((one) => [one.uncertaintyKey, one]));
  const fragmentsByKey = new Map<string, ResearchFragment[]>();
  for (const fragment of snapshot.fragments) {
    const list = fragmentsByKey.get(fragment.fragmentKey) ?? [];
    list.push(fragment);
    fragmentsByKey.set(fragment.fragmentKey, list);
  }
  const claimsByFragment = new Map<string, ResearchClaim[]>();
  for (const claim of snapshot.claims) {
    if (!claim.fragmentId) continue;
    const list = claimsByFragment.get(claim.fragmentId) ?? [];
    list.push(claim);
    claimsByFragment.set(claim.fragmentId, list);
  }

  /*
   * A key's current fragment is the latest attempt. A repair creates a new row
   * with the same key, so reading "the fragment" as any of them would let an
   * earlier failed attempt decide the uncertainty's fate while a live retry is
   * running.
   */
  const latest = (key: string): ResearchFragment | null => {
    const list = fragmentsByKey.get(key) ?? [];
    if (list.length === 0) return null;
    return list.reduce((best, one) => (one.attempt >= best.attempt ? one : best));
  };

  // ---- 1. What the evidence settled, and what it did not. ------------------
  //
  // Both directions from rows. `ACCEPTED` means the fragment cleared the
  // seven-condition gate; nothing here re-judges any of it.
  for (const uncertainty of snapshot.uncertainties) {
    if (!isLive(uncertainty)) continue;
    const fragment = latest(uncertainty.uncertaintyKey);
    if (!fragment) continue;

    if (fragment.status === 'ACCEPTED') {
      const accepted = (claimsByFragment.get(fragment.id) ?? []).filter((claim) => claim.accepted);
      decisions.push({
        kind: 'RESOLVE_UNCERTAINTY',
        uncertaintyKey: uncertainty.uncertaintyKey,
        fragmentId: fragment.id,
        belief:
          `Established by ${accepted.length} accepted claim(s) that cleared the evidence gate.`,
        why: 'The fragment answering this question cleared its gate.',
      });
      continue;
    }

    if (fragment.status === 'BLOCKED' || fragment.status === 'REJECTED') {
      /*
       * Three different failures wearing one status, and they lead to three
       * different sentences in the report.
       */
      if (strandedByDependency(fragment)) {
        // Not this question's failure at all. Left live so that repairing the
        // dependency un-strands it — which is what BLOCKED exists to keep
        // available — and named rather than silently skipped.
        continue;
      }

      const blocked = unreadable(claimsByFragment.get(fragment.id) ?? []);
      if (blocked.length > 0 && fragment.attempt <= fragment.maxRepairs) {
        decisions.push({
          kind: 'MARK_ACCESS_BLOCKED',
          uncertaintyKey: uncertainty.uncertaintyKey,
          unreadableSources: blocked.length,
          why:
            `${blocked.length} source(s) for this question could not be opened. That is an ` +
            'access failure, not a finding, and the question stays open.',
        });
        continue;
      }

      decisions.push({
        kind: 'MARK_UNRESOLVABLE',
        uncertaintyKey: uncertainty.uncertaintyKey,
        fragmentId: fragment.id,
        why:
          fragment.blockedReason?.trim() ||
          'The evidence for this question did not clear the gate and no further attempt is planned.',
      });
    }
  }

  /*
   * The dispositions this call is about to establish, so the retirement pass
   * below reasons about them rather than about the snapshot it was handed.
   *
   * Reading the stale snapshot is the defect `advanceOnce` records in its own
   * comment — a pass that changed a fragment's status and then decided its
   * dependents were still in progress. Same shape, one altitude up.
   */
  const becoming = new Map<string, 'RESOLVED' | 'UNRESOLVABLE'>();
  for (const decision of decisions) {
    if (decision.kind === 'RESOLVE_UNCERTAINTY') becoming.set(decision.uncertaintyKey, 'RESOLVED');
    if (decision.kind === 'MARK_UNRESOLVABLE') becoming.set(decision.uncertaintyKey, 'UNRESOLVABLE');
  }

  const failed = (key: string): boolean => {
    if (becoming.get(key) === 'UNRESOLVABLE') return true;
    const uncertainty = byKey.get(key);
    if (!uncertainty) return false;
    return uncertainty.disposition === 'UNRESOLVABLE' || uncertainty.disposition === 'REFUTED';
  };

  // ---- 2. Branches that have stopped being worth pursuing. -----------------
  //
  // An uncertainty that can invalidate the path, and did not survive, takes
  // everything built on it with it — and **only** what is built on it in the
  // blocking sense. That distinction is the whole reason the link kinds exist:
  //
  //   HARD_PREREQUISITE — the dependent cannot be phrased without this. Retired.
  //   CONDITIONAL       — the dependent applies only if this came out a certain
  //                       way. Retired, because the antecedent is unknown rather
  //                       than false, and researching a consequent of an unknown
  //                       antecedent answers nothing.
  //   EVIDENTIARY       — the dependent is strengthened by this and blocked by
  //                       nothing. Untouched. Required scenario 5.
  //   COMPARATIVE       — a sibling being ruled out makes this one MORE
  //                       decisive, so it is raised rather than retired.
  //
  // Required scenario 1 is this pass: a campaign with no reachable payer must
  // stop before it optimises fulfilment, and this is where that happens.
  const retired = new Set<string>();
  for (const uncertainty of snapshot.uncertainties) {
    if (!uncertainty.invalidating) continue;
    if (!failed(uncertainty.uncertaintyKey)) continue;
    const edges = downstream(uncertainty.uncertaintyKey, snapshot.links);

    for (const key of [...edges.HARD_PREREQUISITE, ...edges.CONDITIONAL]) {
      const dependent = byKey.get(key);
      if (!dependent || !isLive(dependent)) continue;
      if (retired.has(key)) continue;
      retired.add(key);
      decisions.push({
        kind: 'RETIRE_BRANCH',
        uncertaintyKey: key,
        becauseKey: uncertainty.uncertaintyKey,
        why:
          `"${uncertainty.question}" could not be established, and this question only bears on ` +
          'the decision if it could. Researching it further would answer something nobody can use.',
      });
    }

    for (const key of edges.COMPARATIVE) {
      const sibling = byKey.get(key);
      if (!sibling || !isLive(sibling)) continue;
      if (retired.has(key)) continue;
      const to = strongerDepth(sibling.depth, 'CONTESTED_DEEP');
      if (to === sibling.depth) continue;
      decisions.push({
        kind: 'RAISE_DEPTH',
        uncertaintyKey: key,
        to,
        why:
          `The alternative it was being weighed against ("${uncertainty.question}") was ruled ` +
          'out, so this one now carries the decision on its own.',
      });
    }
  }

  // ---- 3. Disagreements that nobody has attacked. --------------------------
  //
  // A contradiction recorded and left alone is the defect this pass exists for:
  // `brain_report_contradiction` classified it, marked the claim and created no
  // work, so a packet could synthesize over two claims that cannot both be
  // right. Required scenario 6.
  //
  // Two things happen, and they are different. Depth is raised, because a live
  // disagreement is the one condition where more looking is certain to buy
  // something. And a CHALLENGES uncertainty is opened, which `apply.ts` turns
  // into a real fragment — so the challenge is work rather than a note.
  const challengedKeys = new Set(
    snapshot.links.filter((link) => link.kind === 'CHALLENGES').map((link) => link.toKey),
  );
  for (const uncertainty of snapshot.uncertainties) {
    /*
     * Live *or already settled*, and the second half is load-bearing.
     *
     * A settled question is exactly the dangerous one: its accepted claims are
     * what synthesis will cite, so a disagreement among them is the one an
     * audit cannot repair afterwards. Reading only the live ones worked while
     * the contradiction always arrived in the same pass the gate answered, and
     * left a hole the moment it arrived later — a contested claim on a resolved
     * question would get no challenge, and `assessSufficiency` would refuse the
     * synthesis for ever over work nothing was ever going to create.
     */
    const considered =
      isLive(uncertainty) ||
      uncertainty.disposition === 'RESOLVED' ||
      becoming.get(uncertainty.uncertaintyKey) === 'RESOLVED';
    if (!considered) continue;
    if (retired.has(uncertainty.uncertaintyKey)) continue;
    const fragment = latest(uncertainty.uncertaintyKey);
    if (!fragment) continue;
    const contested = (claimsByFragment.get(fragment.id) ?? []).filter(
      (claim) =>
        claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED',
    );
    if (contested.length === 0) continue;

    const depth = allocateDepth({
      consequence: uncertainty.consequence,
      reversibility: uncertainty.reversibility,
      invalidating: uncertainty.invalidating,
      conflictingClaims: contested.length,
      expectedClaimTypes: fragment.expectedClaimTypes,
    });
    if (depth.depth !== uncertainty.depth) {
      decisions.push({
        kind: 'RAISE_DEPTH',
        uncertaintyKey: uncertainty.uncertaintyKey,
        to: strongerDepth(uncertainty.depth, depth.depth),
        why: depth.basis,
      });
    }

    if (challengedKeys.has(uncertainty.uncertaintyKey)) continue;
    decisions.push({
      kind: 'OPEN_CHALLENGE',
      uncertaintyKey: uncertainty.uncertaintyKey,
      challengesKey: `${uncertainty.uncertaintyKey}--challenge`,
      question:
        `Which of the conflicting accounts of "${uncertainty.question}" is right, and on what ` +
        'basis? Establish the disagreement rather than choosing between the figures.',
      claimIds: contested.map((claim) => claim.id),
      why:
        `${contested.length} claim(s) on this question are contested and nothing has been done ` +
        'about it. A packet must not be synthesized over a disagreement nobody investigated.',
    });
  }

  /*
   * There is deliberately no pass here that opens a question for a mandatory
   * requirement nothing planned for.
   *
   * `assessPacket` asks exactly that at the synthesis boundary and answers it
   * by stopping the packet for a person, and `advanceOnce` says why in its own
   * comment: on this path spending the allowance is a decision a person makes,
   * so a packet short of its mandatory part is a question for them rather than
   * more research nobody agreed to. Growing a fragment here would take that
   * decision back, and the director has no business overturning a rule the
   * runner states with its reason.
   *
   * What is added instead is the *reading*: `assessSufficiency` counts covered
   * mandatory requirements against the total and the view shows both, so the
   * person deciding sees what is missing rather than a bare refusal.
   */

  // ---- 4b. Questions somebody opened that nothing is researching. ---------
  //
  // A worker's validated proposal (`proposals.ts`) opens a question and creates
  // no work, deliberately: what a finding *means* is a judgement, and what to do
  // about it is a plan, and letting one submission be both would make a worker
  // the planner. So the proposal writes the question and this pass decides
  // whether it becomes work — under the packet's own approval, like everything
  // else the director opens.
  //
  // Required scenario 7's second half: an early scout reveals two new decisive
  // uncertainties, and they become real fragments without a person rewriting the
  // plan.
  const researched = new Set(snapshot.fragments.map((fragment) => fragment.fragmentKey));
  for (const uncertainty of snapshot.uncertainties) {
    if (!isLive(uncertainty)) continue;
    if (retired.has(uncertainty.uncertaintyKey)) continue;
    if (researched.has(uncertainty.uncertaintyKey)) continue;
    // Only questions something opened *during* the run. A PLAN-origin question
    // with no fragment is one the archive already answered, and researching it
    // would be §13's waste arriving through this door.
    if (uncertainty.origin !== 'FINDING' && uncertainty.origin !== 'PERSON') continue;
    decisions.push({
      kind: 'OPEN_FOLLOW_UP_WORK',
      uncertaintyKey: uncertainty.uncertaintyKey,
      question: uncertainty.question,
      why: uncertainty.whyItMatters,
    });
  }

  // ---- 5. What to do next. -------------------------------------------------
  //
  // The agenda is the ranking, minus everything this pass is about to close. It
  // is advice: `apply.ts` records it and the queue still decides what a worker
  // is handed, because ordering work is the runner's job and duplicating it here
  // would be a second scheduler.
  const closing = new Set<string>([
    ...retired,
    ...decisions
      .filter(
        (decision) =>
          decision.kind === 'RESOLVE_UNCERTAINTY' || decision.kind === 'MARK_UNRESOLVABLE',
      )
      .map((decision) => decision.uncertaintyKey),
  ]);
  const agenda = rank(snapshot.uncertainties, snapshot.links)
    .filter((entry) => !closing.has(entry.uncertainty.uncertaintyKey))
    .map((entry) => ({ uncertaintyKey: entry.uncertainty.uncertaintyKey, why: entry.why }));

  if (agenda.length > 0) {
    decisions.push({
      kind: 'INVESTIGATE_NEXT',
      uncertaintyKey: agenda[0]!.uncertaintyKey,
      why: agenda[0]!.why,
    });
  }

  return {
    decisions,
    agenda,
    summary: summarize(decisions, agenda.length),
  };
}

function summarize(decisions: DirectorDecision[], remaining: number): string {
  if (decisions.length === 0) {
    return remaining === 0
      ? 'Nothing open and nothing to change.'
      : `${remaining} question(s) still open; nothing about the plan changed.`;
  }
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    counts.set(decision.kind, (counts.get(decision.kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .filter(([kind]) => kind !== 'INVESTIGATE_NEXT')
    .map(([kind, count]) => `${count} ${kind.toLowerCase().replace(/_/g, ' ')}`);
  if (parts.length === 0) return `${remaining} question(s) open; the agenda was re-ordered.`;
  return `${parts.join(', ')}; ${remaining} question(s) still open.`;
}
