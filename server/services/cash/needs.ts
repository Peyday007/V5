/**
 * A missing capability, with somewhere to go.
 *
 * The plan is exact about this and it is the whole of the module: an explicit
 * missing need is a valid execution state, and it must carry a **recommended
 * way forward** rather than a generic blocked label. So a need with no
 * recommendation and no next step is refused at creation rather than stored and
 * shown to somebody as "blocked".
 *
 * §24's sentence, at a new altitude: a state that says "waiting for a person"
 * which that person cannot resolve is not waiting, it is stuck. A need is the
 * answering transition's *description*, and one without it is the defect this
 * codebase has now recorded six times.
 *
 * **A need never stops unrelated work.** Nothing reads this table to decide
 * whether an opportunity may proceed. Brain continues independent work while a
 * need is open, which is what the plan means by "an explicit missing need is a
 * valid execution state".
 */
import {
  claimNeedContinuation,
  createNeedOnce,
  getNeed,
  getOpportunity,
  listNeeds,
  needForKey,
  needsAwaitingContinuation,
  occurrencesOf,
  openNeedForKey,
  recordNeedContinuation,
  settleNeed,
} from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { readNeedCondition } from './conditions.ts';
import { parseBlockerKey } from '../../domain/types.ts';
import type { BlockerKey, BlockerKind, CashNeed, CashOpportunityState } from '../../domain/types.ts';
import type { Outcome } from './opportunities.ts';

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export async function raiseNeed(input: {
  projectId: string;
  opportunityId?: string | null;
  actorRef: string;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  expectedCostCents?: number | null;
  setupEffort: string;
  nextStep: string;
  /**
   * What settles it, in a form somebody can check.
   *
   * Required, for the reason `recommendedPath` and `nextStep` already are: a
   * need whose answer nobody can verify is a status rather than a remedy, and
   * `runContinuations` below reads exactly this to decide whether an answer
   * actually happened.
   */
  completionCondition: string;
  /** The opportunity transition waiting on it, when one is. */
  blocksState?: CashOpportunityState | null;
  /** The idea Brain started because of it, when it could start one. */
  candidateId?: string | null;
  /**
   * What makes this need the same need.
   *
   * With one, raising it twice returns the row that already exists rather than
   * filling the review with one entry per tick. Without one, every call is a
   * new need — which is right for something a person typed and wrong for
   * anything a loop derives.
   */
  requestKey?: string | null;
  /**
   * The shared fact this need is blocked on, when it has a typed cause.
   *
   * One key per fact, never per opportunity (`CAPABILITY:SEND_A_MESSAGE`), so
   * every need blocked on one fact is found with one indexed read. A malformed
   * key is refused rather than stored: a key that matched loosely would make
   * one fact look like another.
   */
  blockerKey?: BlockerKey | string | null;
}): Promise<Outcome<CashNeed>> {
  let blockerKey: BlockerKey | null = null;
  if (input.blockerKey !== undefined && input.blockerKey !== null) {
    blockerKey = parseBlockerKey(input.blockerKey);
    if (!blockerKey) {
      return refuse(
        `"${String(input.blockerKey)}" is not a blocker key. A key is PERSON or <KIND>:<argument>, ` +
          'with the kind from the closed set in domain/types.ts.',
      );
    }
  }
  const fields = {
    blockedAction: input.blockedAction.trim(),
    whyItMatters: input.whyItMatters.trim(),
    recommendedPath: input.recommendedPath.trim(),
    setupEffort: input.setupEffort.trim(),
    nextStep: input.nextStep.trim(),
    completionCondition: input.completionCondition.trim(),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value) continue;
    return refuse(
      `A need has to name the blocked action, why it matters, the recommended way forward, the ` +
        `setup effort, the exact next step and what would settle it. "${name}" is empty, and a ` +
        'need with a blank there is a blocked label rather than something somebody can act on.',
    );
  }
  if (
    input.expectedCostCents !== undefined &&
    input.expectedCostCents !== null &&
    (!Number.isFinite(input.expectedCostCents) ||
      Math.trunc(input.expectedCostCents) !== input.expectedCostCents ||
      input.expectedCostCents < 0)
  ) {
    return refuse('An expected cost is a whole number of cents, or null for "not known".');
  }

  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) {
      return refuse('No opportunity with that id.');
    }
  }

  const key = input.requestKey?.trim() || null;
  let occurrence = 1;
  if (key) {
    const outstanding = await openNeedForKey(input.projectId, key);
    if (outstanding) {
      // The same condition, still open, read back rather than raised again. A
      // loop that derives a need every tick must add one entry to the review,
      // not one per tick — and the caller wants the row either way, because it
      // is what the continuation is waiting on.
      return {
        ok: true,
        value: outstanding,
        message: 'This need was already raised. Nothing was added.',
      };
    }
    /*
     * A blockage that came back is a new occurrence, not the old row again.
     *
     * This asked `needForKey`, which answers with the newest row whatever its
     * state — so once a capability need was resolved the key was spent, and the
     * capability going missing a month later found the resolved row, was told
     * it had already been raised, and never reached the review. Reopening the
     * old one instead would rewrite a resolution that was true when it was
     * written; a new row keeps both facts.
     */
    occurrence = (await occurrencesOf(input.projectId, key)) + 1;
  }

  const { need, created } = await createNeedOnce({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    ...fields,
    expectedCostCents: input.expectedCostCents ?? null,
    blocksState: input.blocksState ?? null,
    candidateId: input.candidateId ?? null,
    requestKey: key,
    occurrence,
    blockerKey,
  });
  if (!created) {
    // Another pass raised the same condition at the same moment. One entry in
    // the review, one event on the history.
    return { ok: true, value: need, message: 'This need was already raised. Nothing was added.' };
  }

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    kind: 'CASH_NEED_RAISED',
    actorRef: input.actorRef,
    summary: `Blocked: ${fields.blockedAction}. Recommended: ${fields.recommendedPath}.`,
    detail: {
      nextStep: fields.nextStep,
      completionCondition: fields.completionCondition,
      blocksState: input.blocksState ?? null,
      expectedCostCents: input.expectedCostCents ?? null,
      blockerKey,
    },
  });

  return {
    ok: true,
    value: need,
    message:
      'Recorded, with a recommended way forward. Independent work carries on while this is open.',
  };
}

export async function closeNeed(input: {
  needId: string;
  to: 'RESOLVED' | 'WITHDRAWN';
  resolution: string;
  actorUserId: string;
  /**
   * How the condition was established, when the caller already knows.
   *
   * Brain supplies `BRAIN_READ_THE_ROW` after checking. A person supplies
   * nothing and is checked.
   */
  verifiedBy?: CashNeed['verifiedBy'];
  /**
   * An authorized way round a condition that does not hold.
   *
   * The integration is still missing and the work is being done another way —
   * by hand, on somebody's own account, through a service Brain cannot reach.
   * That is a real and common answer, and it is **not** the same fact as the
   * condition being met, so it is recorded as `PERSON_SUBSTITUTE` and says what
   * is being done instead. Without it, a need whose condition fails is refused.
   */
  substitute?: string | null;
}): Promise<Outcome<CashNeed>> {
  const need = await getNeed(input.needId);
  if (!need) return refuse('No need with that id.');
  const resolution = input.resolution.trim();
  if (!resolution) {
    return refuse('Say what was done, or why it is no longer needed. Both are worth keeping.');
  }

  /*
   * A written explanation is not a working integration.
   *
   * This accepted any non-empty sentence, so "done" resolved a need whose
   * capability was still missing — and the piece it was blocking went straight
   * back to waiting on a thing that had not happened, with a resolution on the
   * record saying otherwise. `completion_condition` was required at creation
   * and read by nothing.
   *
   * Withdrawing is deliberately exempt: it asserts that the need no longer
   * matters rather than that it was met, which is a fact a person may simply
   * state.
   */
  let verifiedBy: CashNeed['verifiedBy'] = null;
  if (input.to === 'RESOLVED') {
    const substitute = input.substitute?.trim() || null;
    if (input.verifiedBy === 'BRAIN_READ_THE_ROW') {
      verifiedBy = 'BRAIN_READ_THE_ROW';
    } else {
      const reading = await readNeedCondition(need);
      if (reading?.holds) {
        verifiedBy = 'BRAIN_READ_THE_ROW';
      } else if (substitute) {
        verifiedBy = 'PERSON_SUBSTITUTE';
      } else if (reading) {
        return refuse(
          `This is not settled yet: ${reading.reading} The condition it named was "` +
            `${need.completionCondition ?? 'none recorded'}". If the work is being done another ` +
            'way, say what you are doing instead and Brain will record that rather than ' +
            'pretending the condition was met.',
        );
      } else {
        // Nothing here can check this condition, so the person's word is the
        // only reading there is — recorded as exactly that.
        verifiedBy = 'PERSON_SUBSTITUTE';
      }
    }
  }

  const settled = await settleNeed({
    id: input.needId,
    to: input.to,
    resolution:
      verifiedBy === 'PERSON_SUBSTITUTE' && input.substitute?.trim()
        ? `${resolution} (done another way: ${input.substitute.trim()})`
        : resolution,
    actorUserId: input.actorUserId,
    verifiedBy,
  });
  if (!settled) return refuse(`This need is already ${need.state.toLowerCase()}.`);

  await recordCashEvent({
    projectId: need.projectId,
    opportunityId: need.opportunityId,
    kind: `CASH_NEED_${input.to}`,
    actorRef: input.actorUserId,
    summary: resolution,
    detail: {
      needId: need.id,
      blockedAction: need.blockedAction,
      occurrence: need.occurrence,
      verifiedBy,
    },
  });
  const after = await getNeed(input.needId);
  return {
    ok: true,
    value: after!,
    message:
      verifiedBy === 'PERSON_SUBSTITUTE'
        ? 'Recorded as done another way. The capability is still missing, and Brain says so.'
        : 'Recorded.',
  };
}

export async function openNeeds(projectId: string): Promise<CashNeed[]> {
  return listNeeds({ projectId, states: ['OPEN'] });
}

/* ------------------------------------------------------------------------- */
/* Who acquires what a need names (AUTO-20-2 step 5, S-0249)                  */
/* ------------------------------------------------------------------------- */

/**
 * The execution owner that already acquires what a need is blocked on.
 *
 * S-0249: "Factory for software changes; research/ingestion for information;
 * existing integration managers for connectors; commercial workflows for
 * independently authorized interactions." A need is none of those by default:
 * it is the cash need path's own row, and a missing supplier is not a code
 * change. The typed blocker key already says which fact the need waits on, so
 * the owner is read from it rather than guessed from prose — and an untyped
 * need stays with the path that owns it (reconsider watches it, operate resumes
 * the piece once it is settled) rather than becoming an engineering objective.
 */
export type NeedRoute = 'INTEGRATION' | 'COMMERCIAL' | 'RESEARCH' | 'WATCH' | 'PERSON';

export interface NeedExecutionOwner {
  route: NeedRoute;
  /** The existing module that owns acquiring it. */
  owner: string;
  why: string;
}

const NEED_OWNER: Readonly<Record<BlockerKind, NeedExecutionOwner>> = Object.freeze({
  CAPABILITY: {
    route: 'INTEGRATION',
    owner: 'server/services/cash/capabilities.ts',
    why: 'a missing cash capability is a connector or integration; the capability registry reads it PRESENT once it is connected',
  },
  SOURCE_HOST: {
    route: 'RESEARCH',
    owner: 'server/services/cash/reconsider.ts',
    why: 'an unreadable source host is an ingestion gap; a RETRIEVED reading after the block settles it',
  },
  EVIDENCE: {
    route: 'RESEARCH',
    owner: 'server/services/goals/pathResearch.ts',
    why: 'missing evidence is information; the path research owner raises and closes these needs',
  },
  FIELD: {
    route: 'RESEARCH',
    owner: 'server/services/goals/pathResearch.ts',
    why: 'an unanswered card field is information the research path answers',
  },
  AUTHORITY: {
    route: 'PERSON',
    owner: 'server/services/cash/authority.ts',
    why: 'a commercial grant is made by a person first (invariant 38); Brain cannot grant itself one',
  },
  MANUFACTURING: {
    route: 'PERSON',
    owner: 'server/services/cash/capabilities.ts',
    why: 'a capability this company holds is attested by a person (invariant 42)',
  },
  PERSON: {
    route: 'PERSON',
    owner: 'server/services/cash/needs.ts',
    why: 'only a person can say; the need stays in their review with its recommended path',
  },
  SUPPLIER: {
    route: 'COMMERCIAL',
    owner: 'server/services/cash/operate.ts',
    why: 'a supplier relationship is an independently authorized commercial interaction, not a code change',
  },
  CUSTOMER: {
    route: 'COMMERCIAL',
    owner: 'server/services/cash/operate.ts',
    why: 'a payer is established through the commercial workflow, not through software',
  },
  DEPENDENCY: {
    route: 'WATCH',
    owner: 'server/services/cash/reconsider.ts',
    why: 'it waits on another piece reaching a state; reconsider watches the transition',
  },
  DATE: {
    route: 'WATCH',
    owner: 'server/services/cash/reconsider.ts',
    why: "it waits on a date; reconsider compares it to Brain's clock",
  },
  COST: {
    route: 'WATCH',
    owner: 'server/services/cash/reconsider.ts',
    why: 'it waits on a cost falling; reconsider watches the named cost',
  },
  REGULATION: {
    route: 'WATCH',
    owner: 'server/services/cash/reconsider.ts',
    why: 'it waits on a rule changing; reconsider watches it',
  },
} as Record<BlockerKind, NeedExecutionOwner>);

const UNTYPED_NEED_OWNER: NeedExecutionOwner = {
  route: 'WATCH',
  owner: 'server/services/cash/operate.ts',
  why: 'the need names no typed cause; its own recommended path and completion condition are the remedy, and the need continuation resumes the piece once it is settled',
};

/** The owner that acquires what a need waits on, from its typed blocker key. Pure. */
export function needExecutionOwner(blockerKey: string | null | undefined): NeedExecutionOwner {
  const parsed = blockerKey ? parseBlockerKey(blockerKey) : null;
  if (!parsed) return UNTYPED_NEED_OWNER;
  const kind = (parsed === 'PERSON' ? 'PERSON' : parsed.slice(0, parsed.indexOf(':'))) as BlockerKind;
  return NEED_OWNER[kind] ?? UNTYPED_NEED_OWNER;
}

/**
 * The real work row that now carries a need: an idea the research owner
 * captured for its question (`startDependentWork` → a Russell candidate whose
 * missions run on the fleet), or the execution job the commercial owner holds
 * for its opening (`reconcileCashJobs` → `cash_jobs`, dealt to a person).
 */
export interface NeedWork {
  kind: 'RESEARCH_IDEA' | 'CASH_JOB';
  ref: string;
  /** True when this hand-off's own call of the owner's pass created it. */
  created: boolean;
}

/**
 * Why a need carries no work after the hand-off, when it does not.
 *
 * - `PERSON`: only a person can supply it (a secret, a grant, an attestation).
 * - `FACTORY`: what it waits on is code; the Software Factory is the owner.
 * - `FACT`: it waits on a watched fact (a date, a dependency, a cost, a rule,
 *   a reading); no worker can make that happen sooner.
 * - `DECLINED`: the owner's own pass ran and refused to take it (an opening not
 *   eligible for a job, a question its rules do not launch); the reason says why.
 */
export type NeedWait = 'PERSON' | 'FACTORY' | 'FACT' | 'DECLINED';

export interface NeedHandoff {
  needId: string;
  projectId: string;
  opportunityId: string | null;
  route: NeedRoute;
  owner: string;
  /** The work row allocated for it, or null with `waitsOn` saying why. */
  work: NeedWork | null;
  waitsOn: NeedWait | null;
  reason: string;
}

const LIVE_RESEARCH_DEAD = new Set(['REJECTED', 'PARKED', 'MERGED', 'DONE']);
const LIVE_MISSION_DEAD = new Set(['FAILED', 'CANCELLED', 'DONE', 'NEEDS_HUMAN']);

/** The research idea a need points at, when that idea's research is still alive. */
async function liveResearchFor(candidateId: string | null): Promise<string | null> {
  if (!candidateId) return null;
  const { getCandidate } = await import('../../repos/russellCandidates.ts');
  const { latestMissionForCandidate } = await import('../../repos/russellMissions.ts');
  const candidate = await getCandidate(candidateId);
  if (!candidate || LIVE_RESEARCH_DEAD.has(candidate.state)) return null;
  const mission = await latestMissionForCandidate(candidateId);
  if (mission && LIVE_MISSION_DEAD.has(mission.state)) return null;
  return candidate.id;
}

/**
 * Hand a gap's open needs to the owners that acquire them, and have those
 * owners allocate the work (AUTO-20-2 step 5, S-0249: "Allocate actual workers
 * and time; do not stop at a recommendation or spec").
 *
 * Nothing new is scheduled here: each owner's own allocation pass is run now,
 * once per project, and the work row it leaves on the need is read back.
 *
 * - RESEARCH: `startDependentWork` captures an idea for each question need and
 *   points the need at it; the Russell loop runs its missions on the fleet.
 * - COMMERCIAL: `reconcileCashJobs` prepares and deals the execution job for
 *   an eligible opening; the job's tasks are derived from its open needs.
 * - INTEGRATION: a capability a person must supply waits on that person; one
 *   that is code waits on the Factory, which the improvement loop engineers.
 * - WATCH: a watched fact; reconsideration reads it, and nothing is allocated.
 * - PERSON: waits on the person.
 *
 * Reconsideration runs first, so a need whose fact already changed settles
 * before anything is allocated for it. Each still-open need gets one
 * `CASH_NEED_ROUTED` event recording the work row (or why there is none), and
 * a need already settled is skipped.
 */
export async function handNeedsToOwners(input: {
  needIds: readonly string[];
  gapKey: string;
  actorRef: string;
  now?: string;
}): Promise<{ handed: NeedHandoff[]; skipped: number }> {
  const at = input.now ?? new Date().toISOString();
  const handed: NeedHandoff[] = [];
  let skipped = 0;
  const open: CashNeed[] = [];
  for (const id of [...new Set(input.needIds)]) {
    const need = await getNeed(id);
    if (!need || need.state !== 'OPEN') skipped += 1;
    else open.push(need);
  }
  // The fact each need waits on, read now: one that changed settles here rather than being worked.
  const { reconsiderAffected } = await import('./reconsider.ts');
  for (const projectId of new Set(open.map((n) => n.projectId))) await reconsiderAffected(projectId, { now: at });

  const researchRan = new Map<string, Set<string>>();
  const jobsRan = new Set<string>();
  for (const before of open) {
    const need = await getNeed(before.id);
    if (!need || need.state !== 'OPEN') {
      skipped += 1;
      continue;
    }
    const owner = needExecutionOwner(need.blockerKey);
    const base = { needId: need.id, projectId: need.projectId, opportunityId: need.opportunityId, route: owner.route, owner: owner.owner };
    let one: NeedHandoff;
    if (owner.route === 'RESEARCH') {
      const existing = await liveResearchFor(need.candidateId);
      if (existing) {
        one = { ...base, work: { kind: 'RESEARCH_IDEA', ref: existing, created: false }, waitsOn: null, reason: `its question is being researched as idea ${existing}` };
      } else {
        if (!researchRan.has(need.projectId)) {
          const { startDependentWork } = await import('./operate.ts');
          researchRan.set(need.projectId, new Set((await startDependentWork(need.projectId)).map((w) => w.needId)));
        }
        const after = await getNeed(need.id);
        const started = await liveResearchFor(after?.candidateId ?? null);
        one = started
          ? { ...base, work: { kind: 'RESEARCH_IDEA', ref: started, created: researchRan.get(need.projectId)!.has(need.id) }, waitsOn: null, reason: `research idea ${started} captured for its question` }
          : {
              ...base,
              work: null,
              waitsOn: 'DECLINED',
              reason: need.requestKey?.startsWith('question:')
                ? 'the research owner did not launch it: its opening is ruled out, its deep dive owns the question, or there is no Cash sprint'
                : 'the research owner launches only card questions; this need is not one',
            };
      }
    } else if (owner.route === 'COMMERCIAL') {
      if (!need.opportunityId) {
        one = { ...base, work: null, waitsOn: 'DECLINED', reason: 'it names no opening, and the commercial workflow allocates work per opening' };
      } else {
        const { liveJobFor } = await import('../../repos/cashJobs.ts');
        let job = await liveJobFor(need.opportunityId);
        let created = false;
        if (!job && !jobsRan.has(need.projectId)) {
          jobsRan.add(need.projectId);
          const { reconcileCashJobs } = await import('./jobPipeline.ts');
          await reconcileCashJobs(need.projectId);
          job = await liveJobFor(need.opportunityId);
          created = job !== null;
        }
        one = job
          ? { ...base, work: { kind: 'CASH_JOB', ref: job.id, created }, waitsOn: null, reason: `execution job ${job.id} (${job.state}) carries it` }
          : { ...base, work: null, waitsOn: 'DECLINED', reason: 'the commercial workflow holds no execution job for its opening: the opening is not eligible for one' };
      }
    } else if (owner.route === 'INTEGRATION') {
      const parsed = need.blockerKey ? parseBlockerKey(need.blockerKey) : null;
      const capability = parsed && parsed !== 'PERSON' ? parsed.slice(parsed.indexOf(':') + 1) : '';
      const { capabilityAcquisition } = await import('./capabilities.ts');
      const acquisition = await capabilityAcquisition(capability);
      const waitsOn: NeedWait = acquisition.by === 'PERSON' ? 'PERSON' : acquisition.by === 'FACTORY' ? 'FACTORY' : 'FACT';
      one = { ...base, work: null, waitsOn, reason: acquisition.why };
    } else if (owner.route === 'WATCH') {
      one = { ...base, work: null, waitsOn: 'FACT', reason: owner.why };
    } else {
      one = { ...base, work: null, waitsOn: 'PERSON', reason: owner.why };
    }
    await recordCashEvent({
      projectId: need.projectId,
      opportunityId: need.opportunityId,
      kind: 'CASH_NEED_ROUTED',
      actorRef: input.actorRef,
      summary: (one.work
        ? `Handed to ${owner.owner} (${owner.route}) as ${one.work.kind} ${one.work.ref}: ${need.blockedAction}`
        : `Not acquirable by ${owner.owner} (${owner.route}), waits on ${one.waitsOn}: ${need.blockedAction}`
      ).slice(0, 400),
      detail: {
        needId: need.id,
        gapKey: input.gapKey,
        route: owner.route,
        owner: owner.owner,
        why: owner.why,
        blockerKey: need.blockerKey,
        work: one.work,
        waitsOn: one.waitsOn,
        reason: one.reason,
      },
    });
    handed.push(one);
  }
  const { requestDecisionRecompute } = await import('../../repos/cashDecisions.ts');
  for (const one of handed) {
    if (one.opportunityId && one.work) await requestDecisionRecompute(one.opportunityId, `NEED_ROUTED:${input.gapKey}`, at);
  }
  return { handed, skipped };
}
