/**
 * Does a packet show the restored research capability?
 *
 * A pure function over rows, deliberately. The acceptance instrument for the
 * correction batch is a script an operator runs against production, and a
 * script whose judgement lives inside its own I/O cannot be tested — so the
 * judgement lives here and the script is the I/O around it. If this could not
 * tell a corrected packet from the one that ran before the correction, the
 * whole P1–P7 proof would be a formatting exercise.
 *
 * Each clause names the regression it exists to catch. They are written so that
 * the first live packet — researched by the engine before the fix — fails
 * several of them, which is what makes passing mean something.
 */
import type {
  Requirement,
  RequirementCoverage,
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
} from '../../domain/types.ts';
import { TERMINAL_ORCHESTRATION } from './outcome.ts';

export interface Clause {
  id: string;
  what: string;
  ok: boolean;
  detail: string;
  /**
   * True when the packet contained nothing for this clause to judge.
   *
   * A clause nothing exercised is not a clause that passed, and printing it as
   * PASS is how an instrument flatters the thing it is measuring. The first
   * live packet "passed" the conditional-dependents clause because it had no
   * conditional dependency at all — every one was HARD, which is precisely the
   * defect. Vacuous passes are reported as NOT EXERCISED and counted apart.
   */
  vacuous?: boolean;
}

export interface CapabilityInput {
  orchestration: ResearchOrchestration;
  /** The current attempt of each fragment. */
  fragments: ResearchFragment[];
  /** Every attempt, including superseded ones — repairs are counted here. */
  attempts: ResearchFragment[];
  claims: ResearchClaim[];
  citable: ResearchClaim[];
  accepted: ResearchClaim[];
  coverage: Map<string, { fragmentKey: string; status: string; reason: string | null }>;
  requirements: Requirement[];
  requirementCoverage: RequirementCoverage[];
  items: WorkItem[];
  /** The filed report's text, when there is one and it could be read. */
  documentText: string | null;
}

export function evaluateCapability(input: CapabilityInput): Clause[] {
  const {
    orchestration,
    fragments,
    attempts,
    claims,
    citable,
    accepted,
    coverage,
    requirements,
    requirementCoverage,
    items,
  } = input;
  const live = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');
  const clauses: Clause[] = [];
  const check = (id: string, what: string, ok: boolean, detail: string, vacuous = false): void => {
    clauses.push({ id, what, ok, detail, vacuous });
  };

  // --- P1. Accepted evidence is never discarded --------------------------
  //
  // The decisive regression: three fragments recorded integrity PASS and lost
  // every accepted claim because their fragment failed coverage. A claim that
  // cleared the gate is evidence whatever happened to the rest of its fragment.
  const fromBlocked = citable.length - accepted.length;
  const acceptedInBlocked = claims.filter(
    (claim) =>
      claim.accepted &&
      fragments.some(
        (fragment) => fragment.id === claim.fragmentId && fragment.status === 'BLOCKED',
      ),
  ).length;
  /**
   * A note on what this clause can and cannot tell you.
   *
   * `citable` comes from `citableClaims`, which is the *corrected* query. Run
   * against a packet researched before the correction it reports what would
   * reach synthesis today, not what reached it then — so it passes on the first
   * live packet, and the number it prints is the size of the regression rather
   * than evidence against it: 40 citable against 17 that were actually used.
   *
   * So this verifies the carrying mechanism is in place, and it is honest to
   * say so rather than to let a pass read as proof the packet did the right
   * thing. What discriminates on a real packet is P2, P3 and P3c.
   */
  check(
    'P1',
    'accepted claims from blocked fragments still reach synthesis',
    acceptedInBlocked === 0 || fromBlocked >= acceptedInBlocked,
    `${acceptedInBlocked} accepted claim(s) sit in blocked fragments; ${fromBlocked} of them are citable` +
      ' (measures the mechanism, not what this packet used at the time)',
    acceptedInBlocked === 0,
  );

  // And they must be annotated rather than silently promoted: an accepted claim
  // whose requirement is still open is two facts, and both have to be said.
  const annotated = [...coverage.values()].filter((entry) => entry.status === 'BLOCKED').length;
  check(
    'P1b',
    'claims from blocked fragments carry a coverage annotation',
    annotated === fromBlocked,
    `${annotated} annotated / ${fromBlocked} carried`,
  );

  // --- P2. Every eligible fragment was attempted --------------------------
  //
  // A fragment left BLOCKED with repair budget unspent is the "zero planned
  // attempts" failure: it was not researched and not repaired, it was written
  // off. Terminal fragments must have spent their attempts or have been
  // stranded by something that could not itself be repaired.
  const unspent = fragments.filter(
    (fragment) =>
      fragment.status === 'BLOCKED' &&
      fragment.attempt < fragment.maxRepairs &&
      !(fragment.blockedReason ?? '').toLowerCase().includes('depend'),
  );
  check(
    'P2',
    'no fragment was abandoned with repair budget left',
    unspent.length === 0,
    unspent.length === 0
      ? 'every blocked fragment spent its attempts or was stranded by a dependency'
      : unspent.map((f) => `${f.fragmentKey} at ${f.attempt}/${f.maxRepairs}`).join(', '),
  );

  // Repairs, where they happened, were planned rather than repeated.
  const repairs = attempts.filter((fragment) => fragment.attempt > 1);
  const planned = repairs.filter((fragment) => (fragment.repairReason ?? '').length > 40);
  check(
    'P2b',
    'each repair carried a plan, not a re-run',
    repairs.length === planned.length,
    `${planned.length} planned / ${repairs.length} repair attempt(s)`,
  );

  // --- P3. Conditional dependents continue --------------------------------
  //
  // The live packet cancelled the penalty questions because the licence trigger
  // was unsettled. A conditional dependent researches the conditional.
  const conditional = fragments.filter((fragment) =>
    fragment.dependsOn.some((dependency) => dependency.kind === 'CONDITIONAL'),
  );
  const conditionalStranded = conditional.filter(
    (fragment) =>
      fragment.status === 'BLOCKED' && (fragment.blockedReason ?? '').toLowerCase().includes('depend'),
  );
  check(
    'P3',
    'no conditional dependent was stranded by its dependency',
    conditionalStranded.length === 0,
    conditional.length === 0
      ? 'no conditional dependency in this packet'
      : `${conditional.length} conditional dependent(s), ${conditionalStranded.length} stranded`,
    conditional.length === 0,
  );

  /**
   * And the failure the first live packet actually shows, which P3 misses.
   *
   * That packet passed P3 vacuously: it had no conditional dependency, because
   * every dependency was HARD — and three fragments were CANCELLED behind them,
   * which is the whole defect. A dependent cancelled for its dependency's
   * failure is the thing typed dependencies exist to stop, so it is checked
   * directly rather than inferred from the absence of a kind nobody used.
   */
  const cancelledBehind = fragments.filter(
    (fragment) =>
      fragment.status === 'CANCELLED' &&
      (fragment.dependsOn.length > 0 ||
        (fragment.cancelledReason ?? '').toLowerCase().includes('depend')),
  );
  check(
    'P3c',
    'no dependent was cancelled for its dependency failing',
    cancelledBehind.length === 0,
    cancelledBehind.length === 0
      ? 'nothing was cancelled behind a dependency'
      : cancelledBehind.map((fragment) => fragment.fragmentKey).join(', '),
  );

  // The planner must have typed them at all. A packet whose every dependency is
  // HARD either genuinely has none that are conditional, or was planned by the
  // code this correction replaced — and the count is how you tell.
  const typed = fragments.flatMap((fragment) => fragment.dependsOn);
  check(
    'P3b',
    'dependencies carry kinds',
    typed.length === 0 || typed.every((dependency) => Boolean(dependency.kind)),
    typed.length === 0
      ? 'no dependencies in this packet'
      : `${typed.filter((d) => d.kind === 'HARD').length} HARD / ` +
        `${typed.filter((d) => d.kind === 'CONDITIONAL').length} CONDITIONAL / ` +
        `${typed.filter((d) => d.kind === 'SEQUENCING').length} SEQUENCING`,
  );

  // --- P4. Unresolved retrieval is reported honestly ----------------------
  //
  // A source nobody could read is not a rejected claim. It must be recorded as
  // unresolved, and it must not carry a rejection reason blaming the research.
  const unread = claims.filter((claim) => claim.retrievalState !== 'RETRIEVED');
  const misblamed = unread.filter((claim) => (claim.rejectionReason ?? '').length > 0);
  check(
    'P4',
    'unreadable sources are recorded as unresolved, not rejected',
    misblamed.length === 0,
    `${unread.length} claim(s) with an unread source; ${misblamed.length} wrongly carry a rejection reason`,
    // Nothing recorded a blocked source, so nothing exercised the rule. On a
    // packet from before the column existed every row reads RETRIEVED, which
    // would otherwise be a pass meaning "the question was never asked".
    unread.length === 0,
  );

  // --- P5. One activation drained the authorized lifecycle ----------------
  //
  // Terminal, with an empty queue, and no state that needs a person to nudge it.
  check(
    'P5',
    'the packet reached a terminal state',
    TERMINAL_ORCHESTRATION.has(orchestration.status),
    `status ${orchestration.status}${orchestration.completedAt ? `, completed ${orchestration.completedAt}` : ''}`,
  );
  check(
    'P5b',
    'the queue is empty',
    live.length === 0,
    live.length === 0 ? 'nothing QUEUED or LEASED' : `${live.length} live item(s)`,
  );

  // --- P6. The filed document exists and cites what it claims -------------
  const text = input.documentText;
  if (text !== null) {
    check('P6', 'the canonical artifact is readable from the store', text.length > 0,
      text.length > 0 ? `${text.length} bytes` : 'the row exists and the object does not');

    // Every citation resolves to a citable claim, and every citable claim that
    // came from a blocked fragment is marked as such where it is cited.
    const cited = [...text.matchAll(/clm_[0-9a-f]{20}/g)].map((match) => match[0] ?? '');
    const known = new Set(citable.map((claim) => claim.id));
    const dangling = [...new Set(cited)].filter((claimId) => !known.has(claimId));
    check('P6b', 'every citation resolves to a citable claim', dangling.length === 0,
      `${new Set(cited).size} distinct citation(s); ${dangling.length} unresolvable`);
    // The detail said "the report names the incomplete fragments" whether or
    // not it did — a diagnostic that reports the pass wording on a failure,
    // which is the class of defect that already cost this project three
    // deploys. It now says which of the two happened.
    const statesCoverage = text.includes('coverage');
    check('P6c', 'incomplete coverage is stated in the report',
      annotated === 0 || statesCoverage,
      annotated === 0
        ? 'nothing to annotate'
        : statesCoverage
          ? `the report names the ${annotated} incomplete claim(s)`
          : `${annotated} claim(s) carried from blocked fragments and the report never says so`,
      annotated === 0);
  } else {
    check('P6', 'the canonical artifact is readable from the store', false,
      'no document on the orchestration, or its object could not be read');
  }

  // --- P7. Requirement coverage is honest ---------------------------------
  const mandatory = requirements.filter((requirement) => requirement.necessity === 'MANDATORY');
  const settled = requirementCoverage.filter((entry) => entry.status === 'SATISFIED').length;
  const declared = requirementCoverage.filter((entry) => entry.status === 'NOT_REQUIRED').length;
  check(
    'P7',
    'every mandatory requirement is settled or explicitly declared open',
    settled + declared >= mandatory.length,
    `${mandatory.length} mandatory: ${settled} satisfied, ${declared} declared unresolved`,
  );
  // Every declared gap must say why. A narrowing with no reason is the Brain
  // deciding a goal was smaller than it was.
  const unexplained = requirementCoverage.filter(
    (entry) => entry.status === 'NOT_REQUIRED' && (entry.userOverride ?? '').length === 0,
  );
  check('P7b', 'every declared gap carries its reason', unexplained.length === 0,
    `${unexplained.length} unexplained`);

  return clauses;
}
