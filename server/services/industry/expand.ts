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
 * and all three audit roles decide whether it stands. §24's sentence, at the
 * industry map — everything this adds is a new way *in* to machinery Steps 4
 * to 12C already built, and none of it is a second set of rules.
 *
 * ---------------------------------------------------------------------------
 * Absorbing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. `nodeKindForFinding` decides which table a
 * finding lands in; nothing here inspects a sentence, infers a level or
 * decides that something *sounds like* a sub-industry. That is §8 at the table
 * that decides what the economy looks like, and it is the reason the map can
 * be trusted to be about published reality rather than about what a model
 * expected an industry to contain.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { structuralClaims } from '../../repos/research.ts';
import {
  closeIndustryRound,
  createNode,
  listCapitalFor,
  listNodes,
  openIndustryRound,
  openIndustryRoundsByCandidate,
  recordCapitalEntry,
  recordConstraint,
} from '../../repos/industry.ts';
import { getOpportunity, listOpportunities } from '../../repos/cashPortfolio.ts';
import {
  isCapitalMechanism,
  isCapitalRequirement,
  isConstraintKind,
  nodeKindForFinding,
  pathOf,
} from '../../domain/industry.ts';
import {
  bootstrapQuestion,
  BOOTSTRAP_TITLE,
  bucketById,
  capitalQuestion,
  capitalTitle,
  mapQuestion,
  mapTitle,
  scanQuestion,
  scanTitle,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { GraphSnapshot } from './graph.ts';
import type {
  CapitalStructure,
  IndustryNode,
  IndustryRound,
  OpportunityConstraint,
  ResearchClaim,
} from '../../domain/types.ts';

const OPENED = 'INDUSTRY_ROUND_OPENED';
const ABSORBED = 'INDUSTRY_FINDINGS_ABSORBED';

export interface OpenedRound {
  roundId: string;
  purpose: IndustryRound['purpose'];
  nodeId: string | null;
  bucketId: string | null;
  opportunityId: string | null;
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
 * shape `openRound` already has, for the same reason.
 */
export async function openAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: GraphSnapshot;
}): Promise<OpenedRound[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const byId = new Map(input.snapshot.nodes.map((one) => [one.id, one]));
  const coverageByNode = new Map(input.snapshot.coverage.map((one) => [one.node.id, one]));
  const out: OpenedRound[] = [];

  for (const ask of input.asks) {
    const composed = await compose({ ask, mode, byId, coverage: coverageByNode });
    if (!composed) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openIndustryRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      nodeId: ask.nodeId,
      purpose: ask.purpose,
      bucketId: ask.bucketId,
      opportunityId: ask.opportunityId,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: ask.opportunityId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: opened.round.id,
        purpose: ask.purpose,
        nodeId: ask.nodeId,
        bucketId: ask.bucketId,
        opportunityId: ask.opportunityId,
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
      nodeId: ask.nodeId,
      bucketId: ask.bucketId,
      opportunityId: ask.opportunityId,
      candidateId: candidate.id,
      round: ask.round,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

async function compose(input: {
  ask: Ask;
  mode: { objective: string };
  byId: Map<string, IndustryNode>;
  coverage: Map<string, { children: number; scanFound: number }>;
}): Promise<{ title: string; question: string } | null> {
  const { ask, mode } = input;
  if (ask.purpose === 'BOOTSTRAP') {
    return { title: BOOTSTRAP_TITLE, question: bootstrapQuestion(mode.objective, ask.round) };
  }

  if (ask.purpose === 'CAPITAL') {
    if (!ask.opportunityId) return null;
    const opportunity = await getOpportunity(ask.opportunityId);
    if (!opportunity) return null;
    const path = ask.nodeId ? pathOf(ask.nodeId, input.byId) : [];
    return {
      title: capitalTitle(opportunity),
      question: capitalQuestion({ opportunity, path, objective: mode.objective }),
    };
  }

  if (!ask.nodeId) return null;
  const path = pathOf(ask.nodeId, input.byId);
  if (path.length === 0) return null;
  const coverage = input.coverage.get(ask.nodeId);

  if (ask.purpose === 'MAP') {
    return {
      title: mapTitle(path),
      question: mapQuestion({
        path,
        objective: mode.objective,
        round: ask.round,
        childrenSoFar: coverage?.children ?? 0,
      }),
    };
  }

  const bucket = bucketById(ask.bucketId);
  if (!bucket) return null;
  return {
    title: scanTitle(bucket, path),
    question: scanQuestion({
      bucket,
      path,
      objective: mode.objective,
      round: ask.round,
      foundSoFar: coverage?.scanFound ?? 0,
    }),
  };
}

export interface Absorbed {
  nodes: IndustryNode[];
  constraints: OpportunityConstraint[];
  capital: CapitalStructure[];
  /** Rounds settled this pass, with what each one produced. */
  settled: { roundId: string; found: number }[];
  /** Declarations that could not be filed, and why. Reported, never guessed. */
  refused: { claimId: string; why: string }[];
}

/**
 * File what the kernel's questions established.
 *
 * Not gated by the sprint's lifecycle, and that is deliberate and unchanged
 * from `harvest`: filing what research already found is not new discovery —
 * the spending happened when it ran — and dropping results because the sprint
 * wound down would throw away work already paid for.
 */
export async function absorb(input: {
  projectId: string;
  limit?: number;
}): Promise<Absorbed> {
  const out: Absorbed = { nodes: [], constraints: [], capital: [], settled: [], refused: [] };
  const mode = await getCashMode(input.projectId);
  if (!mode) return out;

  const limit = Math.max(1, input.limit ?? 60);
  const live = await openIndustryRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to.
   *
   * Through the mission, exactly as `harvest` does it, because a mission is
   * what links a round's candidate to the orchestration it launched. An
   * orchestration with no mission belongs to no kernel round, which is honest
   * rather than a gap: nobody asked a kernel question for it, and absorbing
   * its claims would put findings into the map under a subject nothing chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<string, { round: IndustryRound; missionDone: boolean }>();
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

  const nodes = await listNodes(input.projectId);
  const byNodeId = new Map(nodes.map((one) => [one.id, one]));
  const foundPerRound = new Map<string, number>();

  const claims = await structuralClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit,
  });
  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    const filed = await file({
      projectId: input.projectId,
      claim: entry.claim,
      round: context.round,
      byNodeId,
      out,
    });
    if (filed) {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
  }

  /*
   * What a SCAN round produced is openings, and they are not filed here.
   *
   * A scan is the ten mechanism questions with a scope: its output goes
   * through `harvest`, which writes `cash_opportunities`, and almost none of
   * its claims carry a structural finding at all. Counting only what *this*
   * module filed would have recorded `found = 0` for a scan that turned up
   * five openings — and three of those in a row is `BARREN_ROUNDS`, so the
   * subject producing the most work in the sprint would have been the first
   * one killed as barren.
   *
   * Read from the openings' own `orchestration_id`, which `harvest` writes at
   * promotion, rather than from anything this pass remembers. `harvest` runs
   * earlier in the same tick, so by the time a round settles its openings are
   * already there; one that arrives later is counted on the pass that closes
   * the round, because the round stays OPEN until its mission is done.
   */
  const openingsPerOrchestration = new Map<string, number>();
  for (const opportunity of await listOpportunities({ projectId: input.projectId })) {
    if (!opportunity.orchestrationId) continue;
    openingsPerOrchestration.set(
      opportunity.orchestrationId,
      (openingsPerOrchestration.get(opportunity.orchestrationId) ?? 0) + 1,
    );
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
  for (const [orchestrationId, { round, missionDone }] of byOrchestration) {
    if (!missionDone) continue;
    const found =
      (foundPerRound.get(round.id) ?? 0) +
      (round.purpose === 'SCAN' ? (openingsPerOrchestration.get(orchestrationId) ?? 0) : 0);
    if (await closeIndustryRound({ id: round.id, to: 'HARVESTED', found })) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  if (out.nodes.length + out.constraints.length + out.capital.length > 0) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: ABSORBED,
      actorRef: 'BRAIN',
      summary:
        `${out.nodes.length} subject${out.nodes.length === 1 ? '' : 's'}, ` +
        `${out.constraints.length} constraint${out.constraints.length === 1 ? '' : 's'} and ` +
        `${out.capital.length} capital entr${out.capital.length === 1 ? 'y' : 'ies'} were filed ` +
        'from what the kernel established.',
      detail: {
        nodeIds: out.nodes.map((one) => one.id),
        constraintIds: out.constraints.map((one) => one.id),
        capitalIds: out.capital.map((one) => one.id),
        refused: out.refused,
      },
    });
  }
  return out;
}

/**
 * One declared finding into the one table its kind belongs in.
 *
 * Every branch refuses rather than improvises. A capital finding on a round
 * that names no opening has nowhere to go and is *reported* as refused rather
 * than attached to something plausible — attaching it would be Brain deciding
 * which piece of work a figure was about, which is the confidently wrong
 * answer §25 records.
 */
async function file(input: {
  projectId: string;
  claim: ResearchClaim;
  round: IndustryRound;
  byNodeId: Map<string, IndustryNode>;
  out: Absorbed;
}): Promise<boolean> {
  const { claim, round, out } = input;
  const finding = claim.structuralFinding;
  const subject = claim.structuralSubject;
  if (!finding || !subject) return false;

  const kind = nodeKindForFinding(finding);
  if (kind) {
    const created = await createNode({
      projectId: input.projectId,
      /*
       * A discovered subject hangs off the subject that was asked about, and
       * the bootstrap's sectors hang off nothing.
       *
       * Never off "the nearest plausible parent": the round says which subject
       * this question was about, and that row is the only thing that can say
       * where a finding belongs.
       */
      parentId: round.nodeId,
      kind: round.purpose === 'BOOTSTRAP' && !round.nodeId ? 'SECTOR' : kind,
      name: subject,
      description: claim.claim,
      origin: round.purpose === 'BOOTSTRAP' ? 'BOOTSTRAP' : 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created.created) {
      input.byNodeId.set(created.node.id, created.node);
      out.nodes.push(created.node);
      return true;
    }
    return false;
  }

  if (finding === 'HIDDEN_CONSTRAINT') {
    if (!isConstraintKind(subject)) {
      out.refused.push({
        claimId: claim.id,
        why: `"${subject}" is not one of the constraint kinds Brain records.`,
      });
      return false;
    }
    /*
     * A constraint belongs to the piece of work the round was about, or to the
     * subject when the round was about a subject. Exactly one, because the
     * schema says so and because one counted twice is one over-weighted.
     */
    const recorded = await recordConstraint({
      projectId: input.projectId,
      opportunityId: round.opportunityId,
      nodeId: round.opportunityId ? null : round.nodeId,
      kind: subject,
      statement: claim.claim,
      effect: claim.evidenceExcerpt,
      sourceClaimId: claim.id,
    });
    if (recorded) {
      out.constraints.push(recorded);
      return true;
    }
    return false;
  }

  if (!round.opportunityId) {
    out.refused.push({
      claimId: claim.id,
      why:
        `A ${finding} was declared on a round that is not about one opening, so there is ` +
        'nothing for the figure to be the capital of. It stays as evidence on its claim.',
    });
    return false;
  }

  if (finding === 'CAPITAL_REQUIREMENT') {
    if (!isCapitalRequirement(subject)) {
      out.refused.push({
        claimId: claim.id,
        why: `"${subject}" is not one of the capital requirements Brain records.`,
      });
      return false;
    }
    const recorded = await recordCapitalEntry({
      projectId: input.projectId,
      opportunityId: round.opportunityId,
      entryKind: 'REQUIREMENT',
      requirement: subject,
      amountCents: claim.structuralAmountCents,
      statement: claim.claim,
      sourceClaimId: claim.id,
    });
    if (recorded) {
      out.capital.push(recorded);
      return true;
    }
    return false;
  }

  if (!isCapitalMechanism(subject)) {
    out.refused.push({
      claimId: claim.id,
      why: `"${subject}" is not one of the capital structures Brain records.`,
    });
    return false;
  }
  const answers = claim.structuralQualifier;
  if (!answers || !isCapitalRequirement(answers)) {
    out.refused.push({
      claimId: claim.id,
      why: 'A structure that does not name the requirement it answers reduces nothing.',
    });
    return false;
  }

  /*
   * A restructuring names the requirement it answers by kind, and the row it
   * answers is that requirement *on this opening*.
   *
   * Resolved from rows already written rather than from ordering, because a
   * claim can arrive before the requirement it answers — the gate accepts
   * claims in one batch and nothing orders them. Where the requirement is not
   * there yet the structure is refused and stays as evidence; the next pass,
   * once the requirement has been filed, files it.
   */
  const rows = await listCapitalFor(round.opportunityId);
  const target = rows.find(
    (one) => one.entryKind === 'REQUIREMENT' && one.requirement === answers,
  );
  if (!target) {
    out.refused.push({
      claimId: claim.id,
      why:
        `It answers a ${answers} requirement that has not been established for this opening ` +
        'yet. It is filed once that requirement is.',
    });
    return false;
  }

  const recorded = await recordCapitalEntry({
    projectId: input.projectId,
    opportunityId: round.opportunityId,
    entryKind: 'RESTRUCTURING',
    mechanism: subject,
    answersId: target.id,
    residualCents: claim.structuralAmountCents,
    statement: claim.claim,
    sourceClaimId: claim.id,
  });
  if (recorded) {
    out.capital.push(recorded);
    return true;
  }
  return false;
}
