/**
 * The deterministic half: what the director proposed, checked against the live
 * rows, and made true.
 *
 * ---------------------------------------------------------------------------
 * Why the two halves are separate files
 * ---------------------------------------------------------------------------
 *
 * `director.ts` is pure and therefore useless as a control — the same sentence
 * `services/dispatch/router.ts` has to say about routing, and for the same
 * reason. This module is where a decision meets a row it does not own, and every
 * one of them is applied with a guard the decision cannot supply:
 *
 *   - a disposition moves by compare-and-swap naming the state it came from, so
 *     two ticks reading one open uncertainty produce one transition;
 *   - a new question is opened by a unique key, so a redelivery opens nothing;
 *   - a new fragment is created only when the packet has no live work, is
 *     created `PLANNED`, and is therefore subject to **the packet's own existing
 *     approval** — the envelope check or a person — rather than to any rule
 *     invented here.
 *
 * That last one is the load-bearing decision of this file. A director that could
 * queue its own research would be a second approval path, and §16's whole safety
 * argument is that nobody supplies the limits their own plan is judged against.
 * Instead a director-created fragment lands `PLANNED` and `advanceOnce`'s
 * existing approval branch picks it up: under an envelope it is validated
 * against the same rules the original plan was, and under per-person approval it
 * waits for the same person. No new authorization exists anywhere in this
 * faculty.
 *
 * ---------------------------------------------------------------------------
 * What it cannot do
 * ---------------------------------------------------------------------------
 *
 * Accept or reject a claim. Move a coverage status. Change an
 * independent-source minimum downward. Advance an audit verdict. Approve a plan.
 * Cancel a fragment that is running. Write anything at all when the packet is
 * terminal. Each of those lives where it already lived, and there is no import
 * here that could reach one.
 */
import {
  createFragments,
  listClaims,
  FragmentBudgetRefused,
} from '../../../repos/research.ts';
import { listCoverage, listRequirements } from '../../../repos/reconciliation.ts';
import {
  currentPlanVersion,
  linkUncertainties,
  openUncertainty,
  reassessUncertainty,
  recordPlanRevision,
  setUncertaintyDisposition,
} from '../../../repos/researchIntelligence.ts';
import { recordEvent } from '../../../repos/events.ts';
import { direct, type DirectorDecision, type DirectorSnapshot } from './director.ts';
import { ensureProblemModel } from './model.ts';
import { floorFor } from './depth.ts';
import { readGraph, seedUncertainties } from './uncertainty.ts';
import { assessSufficiency, type SufficiencyReading } from './sufficiency.ts';
import type {
  PlanRevisionReason,
  ResearchFragment,
  ResearchOrchestration,
} from '../../../domain/types.ts';

/**
 * How many questions the director may add to one packet, ever.
 *
 * Not a budget and not an evidence bar: a bound on a *loop*. Adaptive planning
 * that can create work from findings can in principle create work from the
 * findings of the work it created, and a campaign that grows forever is a
 * campaign nobody can approve. Reaching it is reported rather than silent —
 * §27's lesson that truncation is the one outcome a caller cannot recover from,
 * because it is delivered as success.
 */
export const MAX_DIRECTED_FRAGMENTS = 12;

export interface DirectedResult {
  /** Questions opened, dispositions moved, depths raised — anything written. */
  applied: string[];
  /** Decisions the guards refused, kept because a refusal is worth reading. */
  refused: string[];
  /** Fragments created, which the caller must re-derive to act on. */
  created: number;
  /** The ordered agenda, so a caller can say what is next and why. */
  agenda: { uncertaintyKey: string; why: string }[];
  sufficiency: SufficiencyReading;
}

/**
 * Run the faculty over one packet.
 *
 * Called from `advancePacket` after repairs and before anything is queued, and
 * safe to call at any other time: it derives from rows, writes only through
 * guarded statements, and a second call on unchanged rows writes nothing.
 *
 * `mayCreateWork` is the caller's statement that the packet is quiescent —
 * nothing leased, nothing queued. New questions are only opened then, because
 * opening one mid-flight would park the packet at its approval gate while a
 * worker was still holding an item, and the worker's own result may be the thing
 * that makes the new question unnecessary.
 */
export async function directResearch(input: {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  mayCreateWork: boolean;
}): Promise<DirectedResult> {
  const { orchestration, fragments } = input;

  const model = await ensureProblemModel(orchestration);
  const planVersion = Math.max(1, await currentPlanVersion(orchestration.id));

  const seeded = await seedUncertainties({ orchestration, fragments, model, planVersion });
  if (seeded.opened.length > 0) {
    await recordPlanRevision({
      orchestrationId: orchestration.id,
      projectId: orchestration.projectId,
      reason: 'INITIAL_PLAN',
      summary:
        `${seeded.opened.length} decision-relevant question(s) opened from the approved plan, ` +
        `with ${seeded.linked} declared relationship(s) between them.`,
      decisions: seeded.opened.map((one) => ({
        kind: 'OPEN',
        uncertaintyKey: one.uncertaintyKey,
        invalidating: one.invalidating,
        consequence: one.consequence,
        depth: one.depth,
      })),
      applied: seeded.opened.map((one) => one.uncertaintyKey),
    });
  }

  const [graph, claims, requirements, coverage] = await Promise.all([
    readGraph(orchestration.id),
    listClaims(orchestration.id),
    listRequirements(orchestration.id),
    listCoverage(orchestration.id),
  ]);

  const snapshot: DirectorSnapshot = {
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    fragments,
    claims,
    uncertainties: graph.uncertainties,
    links: graph.links,
    requirements,
    coverage,
    mayRecordGaps: orchestration.unresolvedGapPolicy === 'RECORD_GAPS',
  };

  const verdict = direct(snapshot);

  const applied: string[] = [];
  const refused: string[] = [];
  let created = 0;

  // How many questions this packet has already grown. Counted from the rows
  // rather than from this pass, so a restart cannot reset the bound.
  let directedSoFar = graph.uncertainties.filter(
    (one) => one.origin === 'CONTRADICTION' || one.origin === 'COVERAGE_GAP' || one.origin === 'FINDING',
  ).length;

  const byKey = new Map(graph.uncertainties.map((one) => [one.uncertaintyKey, one]));
  const fragmentKeys = new Set(fragments.map((fragment) => fragment.fragmentKey));
  let nextIndex = fragments.reduce((top, fragment) => Math.max(top, fragment.fragmentIndex), -1) + 1;

  for (const decision of verdict.decisions) {
    switch (decision.kind) {
      case 'RESOLVE_UNCERTAINTY': {
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: decision.uncertaintyKey,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'RESOLVED',
          reason: decision.why,
          resolvedByFragmentId: decision.fragmentId,
          belief: decision.belief,
          beliefBasis: 'EVIDENCE',
          uncertaintyLevel: 0,
        });
        (ok ? applied : refused).push(
          `${ok ? 'resolved' : 'could not resolve'} ${decision.uncertaintyKey}`,
        );
        break;
      }

      case 'MARK_UNRESOLVABLE': {
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: decision.uncertaintyKey,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'UNRESOLVABLE',
          reason: decision.why,
          resolvedByFragmentId: decision.fragmentId,
        });
        (ok ? applied : refused).push(
          `${ok ? 'recorded unresolvable' : 'could not mark unresolvable'} ${decision.uncertaintyKey}`,
        );
        break;
      }

      case 'MARK_ACCESS_BLOCKED': {
        /*
         * Deliberately not a disposition change.
         *
         * An unreadable source is a fact about the network, and the question is
         * exactly as open as it was. Recording it as any terminal disposition
         * would turn "we could not read it" into "we established something",
         * which §33's own correction calls the more expensive direction of the
         * same mistake. What changes is the belief basis and nothing else.
         */
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: decision.uncertaintyKey,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'INVESTIGATING',
          reason: decision.why,
          beliefBasis: 'UNKNOWN',
        });
        (ok ? applied : refused).push(
          `${ok ? 'recorded access failure on' : 'could not record access failure on'} ` +
            decision.uncertaintyKey,
        );
        break;
      }

      case 'RETIRE_BRANCH': {
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: decision.uncertaintyKey,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'RETIRED',
          reason: decision.why,
        });
        if (ok) {
          applied.push(`retired ${decision.uncertaintyKey}`);
          await recordEvent({
            projectId: orchestration.projectId,
            layerId: orchestration.layerId,
            entityType: 'RUN',
            entityId: orchestration.runId,
            eventType: 'RESEARCH_BRANCH_RETIRED',
            payload: {
              orchestrationId: orchestration.id,
              uncertaintyKey: decision.uncertaintyKey,
              because: decision.becauseKey,
              why: decision.why,
            },
          });
        } else {
          refused.push(`could not retire ${decision.uncertaintyKey}`);
        }
        break;
      }

      case 'RAISE_DEPTH': {
        /*
         * Raised only. `reassessUncertainty` is given the stronger of the two,
         * so a decision that somehow proposed a weaker rung changes nothing —
         * the direction is enforced here rather than trusted from the caller,
         * because a depth allocator that could lower a bar is a budget in
         * disguise (§16).
         */
        const before = byKey.get(decision.uncertaintyKey);
        if (!before) {
          refused.push(`no such question ${decision.uncertaintyKey}`);
          break;
        }
        const ok = await reassessUncertainty({
          orchestrationId: orchestration.id,
          uncertaintyKey: decision.uncertaintyKey,
          depth: decision.to,
          depthBasis: decision.why,
        });
        (ok ? applied : refused).push(
          `${ok ? 'raised depth on' : 'could not raise depth on'} ${decision.uncertaintyKey}`,
        );
        break;
      }

      case 'OPEN_CHALLENGE': {
        if (!input.mayCreateWork) {
          refused.push(`deferred challenge for ${decision.uncertaintyKey}: work is in flight`);
          break;
        }
        const parent = byKey.get(decision.uncertaintyKey);
        if (!parent) {
          refused.push(`no such question ${decision.uncertaintyKey}`);
          break;
        }
        /*
         * A challenge of a challenge is refused by construction.
         *
         * Two sources disagreeing about the resolution of a disagreement is a
         * real thing and it is a person's to look at, not a third round of
         * automatic work. §15's rule that no two attempts may be the same search
         * twice, applied one altitude up.
         */
        if (parent.origin === 'CONTRADICTION') {
          refused.push(
            `will not open a challenge to a challenge (${decision.uncertaintyKey}); a ` +
              'disagreement about a disagreement is a person\'s to settle',
          );
          break;
        }
        if (directedSoFar >= MAX_DIRECTED_FRAGMENTS) {
          refused.push(
            `the plan has already grown by ${MAX_DIRECTED_FRAGMENTS} question(s); ` +
              `${decision.uncertaintyKey} needs a person rather than another automatic round`,
          );
          break;
        }
        const source = fragments.find(
          (fragment) => fragment.fragmentKey === decision.uncertaintyKey,
        );
        if (!source) {
          refused.push(`no fragment carries ${decision.uncertaintyKey}`);
          break;
        }
        const opened = await openUncertainty({
          orchestrationId: orchestration.id,
          projectId: orchestration.projectId,
          problemModelId: model.id,
          uncertaintyKey: decision.challengesKey,
          question: decision.question,
          whyItMatters: decision.why,
          consumerKind: 'CONCLUSION',
          consumerRef: parent.consumerRef,
          consequence: parent.consequence,
          reversibility: parent.reversibility,
          invalidating: parent.invalidating,
          stoppingCondition:
            'The disagreement is explained — a different definition, timeframe, geography or ' +
            'population — or a source that settles it is found and cited. Never by averaging.',
          depth: 'CONTESTED_DEEP',
          depthBasis: decision.why,
          origin: 'CONTRADICTION',
          originRef: decision.claimIds.join(','),
          planVersion: planVersion + 1,
        });
        await linkUncertainties({
          orchestrationId: orchestration.id,
          fromKey: decision.challengesKey,
          toKey: decision.uncertaintyKey,
          kind: 'CHALLENGES',
          reason: decision.why,
        });
        if (!fragmentKeys.has(decision.challengesKey)) {
          const made = await createDirectedFragment({
            orchestration,
            source,
            fragmentKey: decision.challengesKey,
            fragmentIndex: nextIndex,
            question: decision.question,
            whyItMatters: decision.why,
            depthFloor: floorFor('CONTESTED_DEEP'),
            contradictionTargets: decision.claimIds,
            requirementIds: source.requirementIds,
          });
          if (made.ok) {
            nextIndex += 1;
            created += 1;
            directedSoFar += 1;
            fragmentKeys.add(decision.challengesKey);
            applied.push(`opened challenge ${decision.challengesKey}`);
          } else {
            refused.push(`could not open challenge ${decision.challengesKey}: ${made.reason}`);
          }
        } else if (opened.created) {
          applied.push(`opened challenge question ${decision.challengesKey}`);
        }
        break;
      }

      case 'OPEN_FOLLOW_UP_WORK': {
        if (!input.mayCreateWork) {
          refused.push(`deferred follow-up ${decision.uncertaintyKey}: work is in flight`);
          break;
        }
        if (directedSoFar >= MAX_DIRECTED_FRAGMENTS) {
          refused.push(
            `the plan has already grown by ${MAX_DIRECTED_FRAGMENTS} question(s); ` +
              `${decision.uncertaintyKey} needs a person`,
          );
          break;
        }
        const template = fragments[0];
        if (!template) {
          refused.push(`no fragment to inherit scope from for ${decision.uncertaintyKey}`);
          break;
        }
        if (fragmentKeys.has(decision.uncertaintyKey)) break;
        const made = await createDirectedFragment({
          orchestration,
          source: template,
          fragmentKey: decision.uncertaintyKey,
          fragmentIndex: nextIndex,
          question: decision.question,
          whyItMatters: decision.why,
          depthFloor: floorFor(byKey.get(decision.uncertaintyKey)?.depth ?? 'CORROBORATED'),
          contradictionTargets: [],
          requirementIds: [],
        });
        if (made.ok) {
          nextIndex += 1;
          created += 1;
          directedSoFar += 1;
          fragmentKeys.add(decision.uncertaintyKey);
          applied.push(`opened follow-up ${decision.uncertaintyKey}`);
        } else {
          refused.push(`could not open follow-up ${decision.uncertaintyKey}: ${made.reason}`);
        }
        break;
      }

      case 'INVESTIGATE_NEXT':
        // Advice, recorded on the revision and nowhere else. The queue decides
        // what a worker is handed, and a second scheduler here would be one more
        // thing to disagree with it.
        break;
    }
  }

  const reading = assessSufficiency({
    uncertainties: (await readGraph(orchestration.id)).uncertainties,
    links: graph.links,
    requirements,
    coverage,
    claims,
    fragments,
    mayRecordGaps: snapshot.mayRecordGaps,
  });

  if (applied.length > 0 || refused.length > 0) {
    await recordPlanRevision({
      orchestrationId: orchestration.id,
      projectId: orchestration.projectId,
      reason: revisionReasonFor(verdict.decisions),
      summary: verdict.summary,
      decisions: verdict.decisions,
      applied,
    });
  }

  return { applied, refused, created, agenda: verdict.agenda, sufficiency: reading };
}

function revisionReasonFor(decisions: DirectorDecision[]): PlanRevisionReason {
  if (decisions.some((decision) => decision.kind === 'OPEN_CHALLENGE')) return 'CONTRADICTION';
  if (decisions.some((decision) => decision.kind === 'RETIRE_BRANCH')) return 'BRANCH_RETIRED';
  return 'EVIDENCE_ARRIVED';
}

/**
 * A question the director opened, created as a fragment the packet's own
 * approval still has to pass.
 *
 * `PLANNED`, always. That single word is what keeps this faculty inside §16:
 * `advanceOnce` refuses to queue a PLANNED fragment and routes it to the
 * envelope check or to a person, so a directed question is approved by exactly
 * the mechanism the original plan was and by no other.
 *
 * Scope, source classes and exclusions are inherited from the fragment the
 * question came out of — §15's rule that a repair carries its requirements,
 * scope and evidence bar forward, applied to a question that is new rather than
 * repeated. A directed fragment that invented its own scope would be answering
 * an easier question than the one that raised it.
 */
async function createDirectedFragment(input: {
  orchestration: ResearchOrchestration;
  source: ResearchFragment;
  fragmentKey: string;
  fragmentIndex: number;
  question: string;
  whyItMatters: string;
  depthFloor: number;
  contradictionTargets: string[];
  requirementIds: string[];
}): Promise<{ ok: boolean; reason: string }> {
  try {
    await createFragments([
      {
        orchestrationId: input.orchestration.id,
        projectId: input.orchestration.projectId,
        layerId: input.orchestration.layerId,
        fragmentIndex: input.fragmentIndex,
        fragmentKey: input.fragmentKey,
        question: input.question,
        geography: input.source.geography,
        timeframe: input.source.timeframe,
        population: input.source.population,
        definitions: input.source.definitions,
        requiredEvidence: input.source.requiredEvidence,
        acceptableSourceTypes: input.source.acceptableSourceTypes,
        excludedSourceTypes: input.source.excludedSourceTypes,
        completionCriteria: input.source.completionCriteria,
        // No dependency. The question exists because the evidence for something
        // else already arrived, so making it wait on that fragment would be
        // waiting for something that has already happened.
        dependsOn: [],
        // The floor the depth implies, or the plan's own, whichever is higher.
        // Never lower: this module can make a question harder to close and can
        // never make one easier.
        minIndependentSources: Math.max(
          input.depthFloor,
          input.source.minIndependentSources,
        ),
        whyItMatters: input.whyItMatters,
        requirementIds: input.requirementIds,
        contradictionTargets: input.contradictionTargets,
        expectedClaimTypes: input.source.expectedClaimTypes,
        prohibitedEvidence: input.source.prohibitedEvidence,
        failureConditions: input.source.failureConditions,
        status: 'PLANNED',
      },
    ]);
    return { ok: true, reason: '' };
  } catch (error) {
    if (error instanceof FragmentBudgetRefused) {
      return { ok: false, reason: error.detail };
    }
    throw error;
  }
}
