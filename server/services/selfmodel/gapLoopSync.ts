/**
 * The improvement loop's candidates, worked as capability-gap loops (AUTO-20-2, §87/§88).
 *
 * `gapLoop.ts` gives the steps a vocabulary and a durable record; this is the
 * caller. Every pass of the improvement tick reads each candidate it touched
 * — and every gap whose recorded loop has not yet continued — and appends the
 * steps the candidate's own rows now justify but the gap's record lacks. The
 * record is never the source of the decision: the improvement candidate is,
 * and this only writes down, step by step, what the existing owner did.
 *
 *   NOTICE           the candidate exists: the rows showed a weakness
 *   HYPOTHESIS       what closing it enables, the metric that moves, how the
 *                    decision could fail, and the cause judged from the record
 *   SEARCH_EXISTING  the method archive, the system scan's components and the
 *                    owner path in the running image — always before ACQUIRE
 *   VALUE            written by the loop before it acts, from `gapValue.ts`: every
 *                    option costed and compared, the best one taken. Here only a
 *                    choice made without that comparison is recorded, marked so
 *   ACQUIRE          the existing execution owner the work went to
 *   VERIFY           the metric before and after delivery, on production rows
 *   INTEGRATE        kept as a versioned capability, or retired
 *   CONTINUE         what the loop resumes, and when it reconsiders the gap
 *
 * SEARCH_EXISTING is not only written down here. `searchBeforeAcquire` runs the
 * search, records NOTICE, HYPOTHESIS and SEARCH_EXISTING, and returns what it
 * found; the improvement loop calls it *before* it opens research or submits a
 * Factory change, refuses to hand the work to an owner without it, and puts
 * what it found into the research assignment and the engineering objective.
 * The archive count it records is the very count the stage decision read.
 *
 * Because the steps due are derived from the candidate and the gap's rows
 * alone, a worker that dies or a deploy that restarts the process loses
 * nothing: the next tick reads both and records what is missing. Every step is
 * recorded at most once per value, so re-running a pass changes nothing.
 */
import type { ImprovementCandidate } from '../../repos/improvement.ts';
import { readGapLoop, recordGapStep, searchExisting, type ExistingMatch, type GapCause, type GapLoopState, type GapLoopStep } from './gapLoop.ts';

export interface DueStep {
  step: GapLoopStep;
  summary: string;
  detail: Record<string, unknown>;
}

/** The cause, judged from what the candidate's own record says, with the basis written down. Pure. */
export function judgeCause(candidate: Pick<ImprovementCandidate, 'kind' | 'problem' | 'evidence'>): { cause: GapCause; basis: string } {
  if (candidate.evidence['methodInadequacy']) {
    return { cause: 'METHOD_INADEQUATE', basis: 'an earlier attempt was kept without effect or reverted and the weakness persists' };
  }
  const known = typeof candidate.evidence['knownCause'] === 'string' ? (candidate.evidence['knownCause'] as string) : '';
  const text = `${candidate.problem} ${known}`;
  if (/\b(permission|forbidden|unauthori[sz]ed|not authori[sz]ed|401|403|credential)\b/i.test(text)) {
    return { cause: 'PERMISSION_GAP', basis: 'the record names an authorization refusal' };
  }
  if (/\b(provider|timed? ?out|timeout|unreachable|rate.?limit|quota|gpu|model call|5\d\d)\b/i.test(text)) {
    return { cause: 'UNAVAILABLE_PROVIDER', basis: 'the record names a provider or route that did not answer' };
  }
  if (/\b(no data|missing data|dataset|no source|unreadable source|coverage)\b/i.test(text)) {
    return { cause: 'MISSING_DATASET', basis: 'the record names information that was not available' };
  }
  if (candidate.kind === 'CLAIM_REJECTION') {
    return { cause: 'REASONING_DEFECT', basis: 'workers produced claims the gate rejected' };
  }
  return { cause: 'OTHER', basis: known ? `known cause: ${known}` : `not yet distinguishable from the ${candidate.kind} record; research or measurement settles it` };
}

function chosenOption(c: ImprovementCandidate): { chosen: string; ref: string } | null {
  if (c.decision === 'COMBINED') return { chosen: `combine into the candidate already owning ${c.ownerComponent}`, ref: `COMBINED:${c.combinedIntoId ?? ''}` };
  if (c.changeRequestId) return { chosen: `a Factory change to ${c.ownerComponent}`, ref: `FACTORY:${c.changeRequestId}` };
  if (c.decision === 'REJECTED') return { chosen: 'abandon the direction: no evidence justified a change', ref: 'ABANDON' };
  if (c.researchGoalId) return { chosen: 'commission method research before changing anything', ref: `RESEARCH:${c.researchGoalId}` };
  const handoff = ownerHandoff(c);
  if (handoff) return { chosen: `hand to the existing owner ${handoff.owner} (${handoff.route})`, ref: c.deliveredRef! };
  return null;
}

/**
 * A gap the loop handed to a non-software owner (S-0249: integration manager, commercial workflow,
 * research/ingestion, a watched fact): `deliveredRef` is `OWNER:<route>:<owner>` (loop.ts handToOwner).
 */
function ownerHandoff(c: ImprovementCandidate): { route: string; owner: string } | null {
  const ref = c.deliveredRef;
  if (!ref || !ref.startsWith('OWNER:')) return null;
  const rest = ref.slice('OWNER:'.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  return { route: rest.slice(0, colon), owner: rest.slice(colon + 1) };
}

function acquisition(c: ImprovementCandidate): { owner: string; ref: string } | null {
  if (c.changeRequestId) return { owner: `Factory (change request ${c.changeRequestId}${c.campaignId ? `, campaign ${c.campaignId}` : ''})`, ref: `FACTORY:${c.changeRequestId}` };
  if (c.researchGoalId) return { owner: `research goal ${c.researchGoalId} worked by the free lane and Claude routines`, ref: `RESEARCH:${c.researchGoalId}` };
  const handoff = ownerHandoff(c);
  if (handoff) return { owner: `${handoff.owner} (${handoff.route})`, ref: c.deliveredRef! };
  return null;
}

const MEASURED: readonly string[] = ['KEPT', 'KEPT_NO_EFFECT', 'REVERTED'];

/**
 * The steps a candidate's rows justify that its gap's record lacks, in loop
 * order. Pure over the candidate, the gap state and what the search found.
 */
export function gapStepsDue(c: ImprovementCandidate, state: GapLoopState, found: { archiveClaims: number; existing: readonly ExistingMatch[] } | null): DueStep[] {
  const due: DueStep[] = [];
  const has = (step: GapLoopStep) => Boolean(state.latest[step]);
  if (!has('NOTICE')) {
    due.push({
      step: 'NOTICE',
      summary: c.title.slice(0, 200),
      detail: { observation: c.problem, kind: c.kind, frequency: c.frequency, denominator: c.denominator, owner: c.ownerComponent, attempt: c.attempt },
    });
  }
  if (!has('HYPOTHESIS')) {
    const { cause, basis } = judgeCause(c);
    due.push({
      step: 'HYPOTHESIS',
      summary: `cause ${cause}: ${basis}`.slice(0, 200),
      detail: {
        cause,
        basis,
        enables: `${c.ownerComponent} stops producing: ${c.title}`,
        measure: c.downstreamMetric ? `${c.metric}, then ${c.downstreamMetric}` : c.metric,
        failureMode: 'the metric does not move after delivery, or the downstream metric regresses; then the method was inadequate and a different one is tried',
      },
    });
  }
  if (!has('SEARCH_EXISTING') && found) {
    // A candidate handed to an owner before the search ran (rows from before the loop searched first)
    // is recorded as searched afterwards, never as if the search had preceded the work.
    const after = Boolean(c.changeRequestId || c.researchGoalId || ownerHandoff(c));
    due.push({
      step: 'SEARCH_EXISTING',
      summary: `${found.archiveClaims} archive claim(s), ${found.existing.length} existing match(es)${after ? ' (recorded after the work was handed off)' : ''}`,
      detail: {
        searched: ['method archive (accepted claims)', 'system scan components', `owner path ${c.ownerComponent}`],
        archiveClaims: found.archiveClaims,
        existing: found.existing.slice(0, 10),
        beforeAcquire: !after,
      },
    });
  }
  // VALUE is computed and recorded by the improvement loop before it acts (`gapValue.ts`, loop.ts
  // valueNextStep). What is written here is only the record of a choice made without that comparison —
  // a combination, a rejection or a hand-off from before the loop valued its steps — and it says so:
  // it names the choice, and states that no alternative was weighed rather than listing any as if it had been.
  const option = chosenOption(c);
  const latestValue = state.latest.VALUE?.detail;
  const evaluated = latestValue?.['evaluated'] === true;
  if (option && !evaluated && latestValue?.['ref'] !== option.ref) {
    due.push({
      step: 'VALUE',
      summary: `${option.chosen} (recorded from the candidate; not valued against alternatives)`.slice(0, 200),
      detail: {
        evaluated: false,
        chosen: option.chosen,
        ref: option.ref,
        alternatives: 'none weighed: this choice was made before the loop valued its next step, and is recorded as such',
        severity: c.severity,
        frequency: c.frequency,
        denominator: c.denominator,
      },
    });
  }
  const acquired = acquisition(c);
  if (acquired && (has('SEARCH_EXISTING') || found) && state.latest.ACQUIRE?.detail['ref'] !== acquired.ref) {
    due.push({ step: 'ACQUIRE', summary: `handed to ${acquired.owner}`.slice(0, 200), detail: { owner: acquired.owner, ref: acquired.ref } });
  }
  const result = c.result as { before?: { value?: number | null }; after?: { value?: number | null }; primary?: { verdict?: string } } | null;
  if (c.decision && MEASURED.includes(c.decision) && !has('VERIFY')) {
    due.push({
      step: 'VERIFY',
      summary: `${c.metric}: ${result?.before?.value ?? 'unknown'} → ${result?.after?.value ?? 'unknown'} (${result?.primary?.verdict ?? 'unknown'})`,
      detail: {
        baseline: `${c.metric} = ${result?.before?.value ?? 'unknown'} in the window before delivery`,
        comparison: `${c.metric} = ${result?.after?.value ?? 'unknown'} after ${c.deliveredRef ?? 'delivery'} on production rows; verdict ${result?.primary?.verdict ?? 'unknown'}`,
        passed: c.decision === 'KEPT',
      },
    });
  }
  if (c.decision && MEASURED.includes(c.decision) && !has('INTEGRATE')) {
    const kept = c.decision === 'KEPT';
    due.push({
      step: 'INTEGRATE',
      summary: kept ? `kept ${c.ownerComponent} @ ${c.deliveredRef ?? 'unknown'}` : `retired: ${c.decision}`,
      detail: {
        capability: kept ? c.title : `retired attempt ${c.attempt}: ${c.title}`,
        version: c.deliveredRef ?? 'unknown',
        provenance: `improvement candidate ${c.id} (${c.weaknessKey}), ${c.changeRequestId ?? 'no change request'}`,
        owner: c.ownerComponent,
        status: kept ? 'ACTIVE' : 'RETIRED',
        knownFailureModes: kept ? [] : [c.decisionReason ?? c.decision],
      },
    });
  }
  if (c.decision && !has('CONTINUE')) {
    due.push({
      step: 'CONTINUE',
      summary: `${c.decision}; the loop resumed its ranked candidates`,
      detail: {
        resumed: 'the improvement tick advances the next ranked open candidate on its next pass',
        reconsider:
          c.decision === 'KEPT'
            ? 'the detector keeps reading the metric; a recurrence opens a new attempt'
            : 'a weakness still present after the recurrence window opens a new attempt with a different method',
        decision: c.decision,
      },
    });
  }
  return due;
}

export interface SearchFound {
  archiveClaims: number;
  existing: ExistingMatch[];
  /** True when this call ran the search and recorded it; false when an earlier SEARCH_EXISTING row answered. */
  recorded: boolean;
}

/** The search terms and paths for a candidate: its owner component and its kind. Pure. */
export function searchQueryFor(c: Pick<ImprovementCandidate, 'ownerComponent' | 'kind'>): { terms: string[]; paths: string[] } {
  return { terms: [c.ownerComponent.split('/').pop()?.replace(/\.[a-z]+$/, '') ?? '', c.kind.toLowerCase()], paths: [c.ownerComponent] };
}

/**
 * Search what exists before anything is acquired (AUTO-20-2 step 3). Called by
 * the improvement loop before it opens research or submits engineering: records
 * NOTICE and HYPOTHESIS if missing, then SEARCH_EXISTING, and returns what was
 * found for the decision to use. `archiveClaims` is the count the caller's own
 * stage decision read, so the row records what decided. An earlier search on
 * the gap answers without searching again.
 */
export async function searchBeforeAcquire(
  c: ImprovementCandidate,
  input: { archiveClaims: number; root?: string; search?: typeof searchExisting },
): Promise<SearchFound> {
  const state = await readGapLoop(c.weaknessKey);
  const prior = state.latest.SEARCH_EXISTING;
  if (prior) {
    const existing = Array.isArray(prior.detail['existing']) ? (prior.detail['existing'] as ExistingMatch[]) : [];
    return { archiveClaims: Number(prior.detail['archiveClaims'] ?? 0), existing, recorded: false };
  }
  const existing = await (input.search ?? searchExisting)({ ...searchQueryFor(c), root: input.root });
  const found = { archiveClaims: input.archiveClaims, existing };
  for (const step of gapStepsDue(c, state, found).filter((s) => s.step === 'NOTICE' || s.step === 'HYPOTHESIS' || s.step === 'SEARCH_EXISTING')) {
    await recordGapStep({ gapKey: c.weaknessKey, step: step.step, summary: step.summary, detail: step.detail });
  }
  return { ...found, recorded: true };
}

/** Record the steps one candidate's rows justify. Returns the steps written. */
export async function syncCandidateGap(c: ImprovementCandidate, input: { archive?: () => Promise<number>; root?: string } = {}): Promise<GapLoopStep[]> {
  const state = await readGapLoop(c.weaknessKey);
  const needsSearch = !state.latest.SEARCH_EXISTING;
  const found = needsSearch
    ? {
        archiveClaims: input.archive ? await input.archive() : 0,
        existing: await searchExisting({ ...searchQueryFor(c), root: input.root }),
      }
    : null;
  const written: GapLoopStep[] = [];
  for (const step of gapStepsDue(c, state, found)) {
    await recordGapStep({ gapKey: c.weaknessKey, step: step.step, summary: step.summary, detail: step.detail });
    written.push(step.step);
  }
  return written;
}
