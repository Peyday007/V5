/**
 * Opening the kernel's questions, and absorbing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets the
 * path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this kernel
 * adds is a new way *in* to machinery Steps 4 to 12C already built, and none of
 * it is a second set of rules.
 *
 * ---------------------------------------------------------------------------
 * Absorbing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. `targetForFinding` decides which table a
 * finding lands in; nothing here inspects a sentence, infers a level or decides
 * that something *sounds like* a capability. That is §8 at the tables that
 * decide what this company would build next.
 *
 * ---------------------------------------------------------------------------
 * And it cannot mark a capability held
 * ---------------------------------------------------------------------------
 *
 * The one sentence worth reading twice. `absorb` imports `ensureCapability` and
 * `recordEdge`, and does not import `declareCapabilityHeld` — which is not a
 * convention but the reason the separation survives: there is no parameter, no
 * branch and no value of `capability_finding` that reaches it. A thousand
 * well-sourced claims about what motorcycle production develops leave every
 * capability in this ledger exactly as unheld as it was.
 */
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { capabilityClaims, countDeclaredCapabilityClaims } from '../../repos/research.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  closeManufacturingRound,
  createCategory,
  ensureCapability,
  getProgram,
  listCategories,
  openManufacturingRound,
  openRoundsByCandidate,
  recordCategoryEvidence,
  recordEdge,
} from '../../repos/manufacturing.ts';
import { pathOf, targetForFinding } from '../../domain/manufacturing.ts';
import {
  bootstrapQuestion,
  BOOTSTRAP_TITLE,
  capabilityQuestion,
  capabilityTitle,
  demandQuestion,
  demandTitle,
  integrationQuestion,
  integrationTitle,
  mapQuestion,
  mapTitle,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { LadderSnapshot } from './ladder.ts';
import type {
  Capability,
  CapabilityEdge,
  CategoryEvidenceEntry,
  MachineCategory,
  ManufacturingRound,
  ManufacturingRoundPurpose,
  ResearchClaim,
} from '../../domain/types.ts';

export interface OpenedRound {
  roundId: string;
  purpose: ManufacturingRoundPurpose;
  categoryId: string | null;
  candidateId: string;
  round: number;
  title: string;
  question: string;
  why: string;
}

/**
 * Turn the allocator's decisions into work.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything.
 */
export async function openAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: LadderSnapshot;
}): Promise<OpenedRound[]> {
  const { snapshot } = input;
  const byId = new Map(snapshot.categories.map((one) => [one.id, one]));
  const coverageById = new Map(snapshot.coverage.map((one) => [one.category.id, one]));
  const out: OpenedRound[] = [];

  for (const ask of input.asks) {
    const composed = compose({ ask, snapshot, byId, coverageById });
    if (!composed) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openManufacturingRound({
      programId: snapshot.program.id,
      projectId: input.projectId,
      categoryId: ask.categoryId,
      purpose: ask.purpose,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordEvent({
      projectId: input.projectId,
      entityType: 'MANUFACTURING_ROUND',
      entityId: opened.round.id,
      eventType: 'MANUFACTURING_ROUND_OPENED',
      payload: {
        summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
        purpose: ask.purpose,
        categoryId: ask.categoryId,
        candidateId: candidate.id,
        round: ask.round,
        /*
         * The allocator's own reason, recorded beside the work it produced.
         *
         * `services/dispatch/router.ts` keeps its decision answerable from a
         * recorded input rather than from a re-run, and this is that promise
         * kept: "why did Brain research this" resolves to a sentence written at
         * the moment it was decided, over a snapshot that has since moved.
         */
        why: ask.why,
        rank: ask.rank,
      },
    });

    out.push({
      roundId: opened.round.id,
      purpose: ask.purpose,
      categoryId: ask.categoryId,
      candidateId: candidate.id,
      round: ask.round,
      title: composed.title,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

function compose(input: {
  ask: Ask;
  snapshot: LadderSnapshot;
  byId: Map<string, MachineCategory>;
  coverageById: Map<string, LadderSnapshot['coverage'][number]>;
}): { title: string; question: string } | null {
  const { ask, snapshot } = input;
  const objective = snapshot.program.objective;

  if (ask.purpose === 'BOOTSTRAP') {
    return { title: BOOTSTRAP_TITLE, question: bootstrapQuestion(objective, ask.round) };
  }
  if (!ask.categoryId) return null;

  const path = pathOf(ask.categoryId, input.byId);
  if (path.length === 0) return null;
  const coverage = input.coverageById.get(ask.categoryId);

  if (ask.purpose === 'MAP') {
    return {
      title: mapTitle(path),
      question: mapQuestion({
        path,
        objective,
        round: ask.round,
        childrenSoFar: coverage?.children ?? 0,
      }),
    };
  }
  if (ask.purpose === 'DEMAND') {
    return {
      title: demandTitle(path),
      question: demandQuestion({
        path,
        objective,
        round: ask.round,
        foundSoFar:
          (coverage?.demand.length ?? 0) +
          (coverage?.distribution.length ?? 0) +
          (coverage?.weaknesses.length ?? 0),
      }),
    };
  }
  if (ask.purpose === 'CAPABILITY') {
    return {
      title: capabilityTitle(path),
      question: capabilityQuestion({
        path,
        objective,
        round: ask.round,
        knownSoFar: coverage?.requires.length ?? 0,
      }),
    };
  }
  return {
    title: integrationTitle(path),
    question: integrationQuestion({
      path,
      objective,
      requiredSoFar: (coverage?.requires ?? []).map((one) => one.name),
    }),
  };
}

export interface Absorbed {
  categories: MachineCategory[];
  capabilities: Capability[];
  edges: CapabilityEdge[];
  evidence: CategoryEvidenceEntry[];
  /** Rounds settled this pass, with what each one produced. */
  settled: { roundId: string; found: number }[];
  /** Declarations that could not be filed, and why. Reported, never guessed. */
  refused: { claimId: string; why: string }[];
}

const EMPTY_ABSORBED = (): Absorbed => ({
  categories: [],
  capabilities: [],
  edges: [],
  evidence: [],
  settled: [],
  refused: [],
});

/**
 * File what the kernel's questions established.
 *
 * Not gated by the programme's lifecycle, and that is deliberate: filing what
 * research already found is not new discovery — the spending happened when it
 * ran — and dropping results because somebody paused the programme would throw
 * away work already paid for. §30's rule, one section along.
 */
export async function absorb(input: { projectId: string; limit?: number }): Promise<Absorbed> {
  const out = EMPTY_ABSORBED();
  const program = await getProgram(input.projectId);
  if (!program) return out;

  const limit = Math.max(1, input.limit ?? 60);
  const live = await openRoundsByCandidate(program.id);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to.
   *
   * Through the mission, because a mission is what links a round's candidate to
   * the orchestration it launched. An orchestration with no mission belongs to
   * no round, which is honest rather than a gap: nobody asked a programme
   * question for it, and absorbing its claims would put findings into the
   * ladder under a category nothing chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<string, { round: ManufacturingRound; missionDone: boolean }>();
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

  const byCategoryId = new Map((await listCategories(program.id)).map((one) => [one.id, one]));

  const claims = await capabilityClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit,
  });
  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    await file({
      programId: program.id,
      projectId: input.projectId,
      claim: entry.claim,
      round: context.round,
      byCategoryId,
      out,
    });
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   *
   * `found` is what the next round is decided against, so a round whose mission
   * has finished has to record what it produced — **including nothing**.
   * Leaving a barren round OPEN would stop it ever being asked again while
   * looking like it was still running, which is the state this whole kernel is
   * built to make impossible.
   */
  for (const [orchestrationId, { round, missionDone }] of byOrchestration) {
    if (!missionDone) continue;
    /*
     * Derived from the claims rather than tallied from what this pass wrote.
     *
     * Tallying is only correct while every pass that absorbs a round also
     * closes it, and a tick that dies between the two breaks exactly that: the
     * claims are filed, the round is still OPEN, and the next pass writes
     * nothing because every insert conflicts. It would then record a round that
     * established five things as having established none — and `found` is what
     * barrenness is decided against, so the category would be declined as one
     * nobody should look at again.
     *
     * Derived, it is the same number however many times it is asked, which is
     * the property a crash window needs.
     */
    const found = await countDeclaredCapabilityClaims(orchestrationId);
    if (await closeManufacturingRound({ id: round.id, to: 'HARVESTED', found })) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  const filed =
    out.categories.length + out.capabilities.length + out.edges.length + out.evidence.length;
  if (filed > 0) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'MANUFACTURING_PROGRAM',
      entityId: program.id,
      eventType: 'MANUFACTURING_FINDINGS_ABSORBED',
      payload: {
        summary:
          `${out.categories.length} categor${out.categories.length === 1 ? 'y' : 'ies'}, ` +
          `${out.edges.length} capability link${out.edges.length === 1 ? '' : 's'} and ` +
          `${out.evidence.length} piece${out.evidence.length === 1 ? '' : 's'} of entry ` +
          'evidence were filed from what the programme established. No capability was marked ' +
          'as held: research cannot establish that.',
        categoryIds: out.categories.map((one) => one.id),
        capabilityIds: out.capabilities.map((one) => one.id),
        edgeIds: out.edges.map((one) => one.id),
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
 * Every branch refuses rather than improvises. A finding on a round that names
 * no category has nowhere to go and is *reported* as refused rather than
 * attached to something plausible — attaching it would be Brain deciding which
 * machine a fact was about, which is the confidently wrong answer §25 records.
 */
async function file(input: {
  programId: string;
  projectId: string;
  claim: ResearchClaim;
  round: ManufacturingRound;
  byCategoryId: Map<string, MachineCategory>;
  out: Absorbed;
}): Promise<boolean> {
  const { claim, round, out } = input;
  const finding = claim.capabilityFinding;
  const subject = claim.capabilitySubject;
  if (!finding || !subject) return false;

  const target = targetForFinding(finding);

  if (target.table === 'CATEGORY') {
    const created = await createCategory({
      programId: input.programId,
      projectId: input.projectId,
      /*
       * A discovered category hangs off the category that was asked about, and
       * the opening question's classes hang off nothing.
       *
       * Never off "the nearest plausible parent": the round says which category
       * this question was about, and that row is the only thing that can say
       * where a finding belongs.
       */
      parentId: round.categoryId,
      kind: target.kind,
      name: subject,
      description: claim.claim,
      origin: round.purpose === 'BOOTSTRAP' ? 'BOOTSTRAP' : 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created.created) {
      input.byCategoryId.set(created.category.id, created.category);
      out.categories.push(created.category);
      return true;
    }
    return false;
  }

  if (!round.categoryId) {
    out.refused.push({
      claimId: claim.id,
      why:
        `A ${finding} was declared on the opening question, which is not about any one ` +
        'category, so there is nothing for it to be a fact about. It stays as evidence on ' +
        'its claim.',
    });
    return false;
  }

  if (target.table === 'CAPABILITY') {
    /*
     * The capability arrives unheld, and there is no path from here that could
     * change that.
     *
     * `ensureCapability` has no parameter for it and this module does not
     * import `declareCapabilityHeld`. That is the separation the whole kernel
     * rests on, and it is a property of the code rather than a rule somebody
     * follows.
     */
    const { capability, created } = await ensureCapability({
      programId: input.programId,
      projectId: input.projectId,
      name: subject,
      description: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created) out.capabilities.push(capability);

    const edge = await recordEdge({
      programId: input.programId,
      categoryId: round.categoryId,
      capabilityId: capability.id,
      relation: target.relation,
      statement: claim.claim,
      sourceClaimId: claim.id,
    });
    if (edge) {
      out.edges.push(edge);
      return true;
    }
    return created;
  }

  const recorded = await recordCategoryEvidence({
    programId: input.programId,
    categoryId: round.categoryId,
    kind: target.kind,
    subject,
    statement: claim.claim,
    // Required for a demand signal by `validateCapabilityFinding` and by the
    // schema, so a claim that reached here with one absent cannot be a demand
    // signal. Carried rather than defaulted: §30's undated-signal rule.
    observedOn: claim.capabilityObservedOn,
    sourceClaimId: claim.id,
  });
  if (recorded) {
    out.evidence.push(recorded);
    return true;
  }
  return false;
}
