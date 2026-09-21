/**
 * The decision-relevant uncertainty graph, seeded from rows and ranked without
 * inventing a probability.
 *
 * ---------------------------------------------------------------------------
 * Why an uncertainty is not a fragment
 * ---------------------------------------------------------------------------
 *
 * A fragment is an execution container for a bounded question: one assignment,
 * one worker, one gate, one repair budget. An uncertainty is the *reason* that
 * question is worth asking. They look the same on the first pass of a campaign
 * and stop being the same the moment evidence arrives, because the two things
 * that happen next can only be said about an uncertainty:
 *
 *   - A fragment can succeed completely and leave its uncertainty open, because
 *     what it established was not the decisive part.
 *   - A finding can *retire* an uncertainty — the question is still open and no
 *     longer bears on the decision — and the fragments behind it are cancelled
 *     as a consequence rather than as a judgement about their evidence.
 *
 * With only fragments there is nothing to say either of those about, which is
 * why a campaign built on fragments alone can repair a question and can never
 * abandon one.
 *
 * ---------------------------------------------------------------------------
 * Ranking without a score
 * ---------------------------------------------------------------------------
 *
 * `rank` is lexicographic over observable facts, in a fixed order, exactly like
 * `cashPortfolio`'s ordering and for the identical reason: a weighted score
 * needs weights, the weights are a judgement nobody made, and the number it
 * produces reads like a measurement. Every tier here is a row or a count of
 * rows.
 *
 * An unknown never ranks something higher (invariant 39). `uncertaintyLevel`
 * starts at 100 — maximally unresolved — so a question nobody has looked at
 * outranks one that has been partly answered, which is the direction that
 * cannot hide work.
 */
import {
  linkUncertainties,
  listUncertainties,
  listUncertaintyLinks,
  openUncertainty,
} from '../../../repos/researchIntelligence.ts';
import { listCoverage, listRequirements } from '../../../repos/reconciliation.ts';
import { allocateDepth } from './depth.ts';
import { inheritedWeight } from './model.ts';
import type {
  Requirement,
  ResearchFragment,
  ResearchOrchestration,
  ResearchProblemModel,
  ResearchUncertainty,
  ResearchUncertaintyLink,
  UncertaintyLinkKind,
} from '../../../domain/types.ts';

/**
 * Seed one uncertainty per planned question.
 *
 * Keyed by the fragment key, which both planning entrances already make unique
 * per packet — `brain_propose_fragments` refuses a duplicate and `placePlan`
 * carries the compiler's own. So this is idempotent by something the caller
 * does not choose, and running it on every advance creates nothing the first
 * run created.
 *
 * It reads the requirement rows rather than the fragments where it can, because
 * the requirement is what says whether the question is MANDATORY — and a
 * mandatory question whose answer the rest of the packet is built on is exactly
 * what `invalidating` means.
 */
export async function seedUncertainties(input: {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  model: ResearchProblemModel | null;
  planVersion: number;
}): Promise<{ opened: ResearchUncertainty[]; linked: number }> {
  const { orchestration, fragments, model, planVersion } = input;
  if (fragments.length === 0) return { opened: [], linked: 0 };

  /*
   * The cheap answer first.
   *
   * This runs on every advance, and an advance can recurse several times in one
   * pass. On a forty-fragment plan the loop below is eighty round trips to
   * discover that nothing changed, every time. One read settles it: a packet
   * whose keys all have a question already has nothing to seed, and a key
   * appearing later — a repair, a challenge, a follow-up — fails this check and
   * takes the full path.
   */
  const already = new Set(
    (await listUncertainties(orchestration.id)).map((one) => one.uncertaintyKey),
  );
  if (fragments.every((fragment) => already.has(fragment.fragmentKey))) {
    return { opened: [], linked: 0 };
  }

  const requirements = await listRequirements(orchestration.id);
  const byKey = new Map<string, Requirement>(
    requirements.map((requirement) => [requirement.requirementKey, requirement]),
  );
  const coverage = await listCoverage(orchestration.id);
  const coverageByRequirement = new Map(coverage.map((row) => [row.requirementId, row]));

  /*
   * Which fragments something else is built on.
   *
   * A HARD dependency is the plan's own statement that the dependent cannot
   * even be phrased until this is settled — which is the definition of an
   * uncertainty that can invalidate the path. Read from `depends_on` rather
   * than from any prose, so nothing is inferred.
   */
  const hardlyDependedOn = new Set<string>();
  for (const fragment of fragments) {
    for (const dependency of fragment.dependsOn) {
      if (dependency.kind === 'HARD') hardlyDependedOn.add(dependency.key);
    }
  }

  const weight = inheritedWeight(model);
  const opened: ResearchUncertainty[] = [];
  let linked = 0;

  const byId = new Map<string, Requirement>(
    requirements.map((requirement) => [requirement.id, requirement]),
  );

  for (const fragment of fragments) {
    /*
     * Which requirement this question is answering.
     *
     * The fragment's own `requirement_ids` first, because that is the link
     * `coverProposal` writes and it is a row rather than a coincidence of
     * naming; the key match second, because a fragment created before that link
     * existed carries only the key. Reading the key alone was wrong and cost a
     * real failure: `placePlan` and the MCP proposal both key requirements by
     * the fragment key, but a fragment created directly with an explicit
     * `requirementIds` need not, and the requirement then looked unaddressed.
     */
    const requirement =
      fragment.requirementIds.map((id) => byId.get(id)).find((one) => one !== undefined) ??
      byKey.get(fragment.fragmentKey);
    const coverageRow = requirement
      ? coverageByRequirement.get(requirement.id)
      : undefined;
    const invalidating = hardlyDependedOn.has(fragment.fragmentKey);

    /*
     * A mandatory question the rest of the packet rests on is worth more than
     * the packet's own baseline, and nothing here can move it the other way:
     * `consequence` starts at whatever the problem model says and is only ever
     * raised.
     */
    const consequence = invalidating
      ? 'CRITICAL'
      : requirement?.necessity === 'MANDATORY'
        ? weight.consequence === 'LOW'
          ? 'MODERATE'
          : weight.consequence
        : weight.consequence;

    const depth = allocateDepth({
      consequence,
      reversibility: weight.reversibility,
      invalidating,
      // Nothing has been researched yet at seeding time, so there is no
      // disagreement to have observed. The director raises this later from real
      // claims rather than this pass guessing at it.
      conflictingClaims: 0,
      expectedClaimTypes: fragment.expectedClaimTypes,
    });

    /*
     * What the archive already said, carried onto the uncertainty as a *belief*
     * rather than as an answer.
     *
     * `PRESENT_BUT_UNVERIFIED` and `STALE` are the two coverage statuses that
     * mean the project holds a candidate answer nothing supports. Recording
     * that as `ASSUMED` is the honest reading: it is what Brain currently
     * thinks and it is not evidence, and the distinction is what stops a
     * synthesis citing it as though it were.
     */
    const belief =
      coverageRow && (coverageRow.status === 'PRESENT_BUT_UNVERIFIED' || coverageRow.status === 'STALE')
        ? {
            currentBelief:
              `The archive holds a candidate answer (${coverageRow.status}): ` +
              (coverageRow.reasons[0] ?? 'recorded without support'),
            beliefBasis: 'ASSUMED' as const,
          }
        : { currentBelief: null, beliefBasis: 'UNKNOWN' as const };

    const result = await openUncertainty({
      orchestrationId: orchestration.id,
      projectId: orchestration.projectId,
      problemModelId: model?.id ?? null,
      uncertaintyKey: fragment.fragmentKey,
      question: fragment.question,
      whyItMatters:
        fragment.whyItMatters?.trim() ||
        requirement?.rationale?.trim() ||
        'The plan named this as part of answering the goal.',
      // The fragment is what consumes the answer today; where a requirement
      // exists it is the more honest consumer, because the requirement is what
      // the goal actually asked for and the fragment is how it is being asked.
      consumerKind: requirement ? 'REQUIREMENT' : 'FRAGMENT',
      consumerRef: requirement?.id ?? fragment.id,
      currentBelief: belief.currentBelief,
      beliefBasis: belief.beliefBasis,
      consequence,
      reversibility: weight.reversibility,
      invalidating,
      stoppingCondition:
        fragment.completionCriteria[0] ??
        'The fragment clears its evidence gate, or its repair ladder is exhausted.',
      depth: depth.depth,
      depthBasis: depth.basis,
      origin: 'PLAN',
      originRef: fragment.id,
      planVersion,
    });
    if (result.created) opened.push(result.uncertainty);
  }

  /*
   * The graph, from declared dependencies only.
   *
   * `HARD` and `CONDITIONAL` map straight across because they mean the same
   * thing one altitude up. `SEQUENCING` becomes `EVIDENTIARY` rather than being
   * dropped: it says the two bear on each other and that a failure costs
   * nothing, which is exactly what EVIDENTIARY means and is why required
   * scenario 5 works — a failed source never cancels a dependent that can still
   * contribute.
   */
  const planned = new Set(fragments.map((fragment) => fragment.fragmentKey));
  for (const fragment of fragments) {
    for (const dependency of fragment.dependsOn) {
      if (!planned.has(dependency.key)) continue;
      const kind: UncertaintyLinkKind =
        dependency.kind === 'HARD'
          ? 'HARD_PREREQUISITE'
          : dependency.kind === 'CONDITIONAL'
            ? 'CONDITIONAL'
            : 'EVIDENTIARY';
      const link = await linkUncertainties({
        orchestrationId: orchestration.id,
        fromKey: dependency.key,
        toKey: fragment.fragmentKey,
        kind,
        reason: `Declared by the plan as a ${dependency.kind} dependency.`,
      });
      if (link) linked += 1;
    }
  }

  return { opened, linked };
}

/** An uncertainty still capable of changing. */
export function isLive(uncertainty: ResearchUncertainty): boolean {
  return uncertainty.disposition === 'OPEN' || uncertainty.disposition === 'INVESTIGATING';
}

const CONSEQUENCE_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
};

export interface RankedUncertainty {
  uncertainty: ResearchUncertainty;
  /** How many other live uncertainties are built on this one. */
  dependents: number;
  /** The sentence that says why it is where it is. */
  why: string;
}

/**
 * Order the live uncertainties by what is worth investigating next.
 *
 * Five tiers, applied in order and never combined into a number:
 *
 *   1. It can invalidate the path. The cheapest decisive question first is the
 *      whole of required scenario 1 — a business campaign with no reachable
 *      payer must find that out before optimising fulfilment.
 *   2. Consequence of being wrong.
 *   3. How many live questions are built on it. Connectivity, counted from the
 *      link table rather than guessed.
 *   4. How unresolved it still is.
 *   5. Creation order, so the result is deterministic and a caller comparing
 *      two runs is comparing decisions rather than map iteration order.
 */
export function rank(
  uncertainties: ResearchUncertainty[],
  links: ResearchUncertaintyLink[],
): RankedUncertainty[] {
  const live = uncertainties.filter(isLive);
  const liveKeys = new Set(live.map((one) => one.uncertaintyKey));

  const dependents = new Map<string, number>();
  for (const link of links) {
    // Only blocking-shaped edges count as something being built on it.
    // EVIDENTIARY and COMPARATIVE deliberately do not: a question nothing is
    // blocked by is not made urgent by being cited.
    if (link.kind !== 'HARD_PREREQUISITE' && link.kind !== 'CONDITIONAL') continue;
    if (!liveKeys.has(link.toKey)) continue;
    dependents.set(link.fromKey, (dependents.get(link.fromKey) ?? 0) + 1);
  }

  return live
    .map((uncertainty) => {
      const count = dependents.get(uncertainty.uncertaintyKey) ?? 0;
      const why = uncertainty.invalidating
        ? 'A wrong answer here would make the rest of the path pointless.'
        : count > 0
          ? `${count} other open question(s) are built on this one.`
          : uncertainty.consequence === 'CRITICAL' || uncertainty.consequence === 'HIGH'
            ? `Being wrong about this is ${uncertainty.consequence.toLowerCase()}-consequence.`
            : 'Ordinary priority: nothing is blocked on it and little rides on it.';
      return { uncertainty, dependents: count, why };
    })
    .sort((a, b) => {
      const invalidating =
        Number(b.uncertainty.invalidating) - Number(a.uncertainty.invalidating);
      if (invalidating !== 0) return invalidating;
      const consequence =
        (CONSEQUENCE_RANK[a.uncertainty.consequence] ?? 9) -
        (CONSEQUENCE_RANK[b.uncertainty.consequence] ?? 9);
      if (consequence !== 0) return consequence;
      if (b.dependents !== a.dependents) return b.dependents - a.dependents;
      if (b.uncertainty.uncertaintyLevel !== a.uncertainty.uncertaintyLevel) {
        return b.uncertainty.uncertaintyLevel - a.uncertainty.uncertaintyLevel;
      }
      if (a.uncertainty.createdAt !== b.uncertainty.createdAt) {
        return a.uncertainty.createdAt < b.uncertainty.createdAt ? -1 : 1;
      }
      return a.uncertainty.uncertaintyKey < b.uncertainty.uncertaintyKey ? -1 : 1;
    });
}

/**
 * Everything downstream of one uncertainty, by link kind.
 *
 * The kinds are kept apart rather than flattened, because what a caller does
 * with each is opposite: a HARD_PREREQUISITE's dependents are stranded when it
 * fails, a CONDITIONAL's carry the condition forward, an EVIDENTIARY's are
 * untouched, and a COMPARATIVE's become *more* decisive. Flattening them is how
 * a campaign cancels work it should have continued.
 */
export function downstream(
  key: string,
  links: ResearchUncertaintyLink[],
): Record<UncertaintyLinkKind, string[]> {
  const out: Record<UncertaintyLinkKind, string[]> = {
    HARD_PREREQUISITE: [],
    CONDITIONAL: [],
    EVIDENTIARY: [],
    COMPARATIVE: [],
    FOLLOW_UP: [],
    CHALLENGES: [],
  };
  for (const link of links) {
    if (link.fromKey !== key) continue;
    out[link.kind].push(link.toKey);
  }
  return out;
}

/** Read the graph for one packet in one go, so callers do not each fetch it. */
export async function readGraph(orchestrationId: string): Promise<{
  uncertainties: ResearchUncertainty[];
  links: ResearchUncertaintyLink[];
}> {
  const [uncertainties, links] = await Promise.all([
    listUncertainties(orchestrationId),
    listUncertaintyLinks(orchestrationId),
  ]);
  return { uncertainties, links };
}
