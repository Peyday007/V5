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
 *
 * ---------------------------------------------------------------------------
 * Where a finding came from, and roles nobody holds yet (OPP-03, COM-13-1)
 * ---------------------------------------------------------------------------
 *
 * Every row `absorb` files is stamped with the origin `construction/origins.ts`
 * names for it, inside the `INDUSTRY_FINDINGS_ABSORBED` payload that already
 * records it: a constraint kind is CONSTRAINT, and everything else a gated
 * claim established is WORLD — activity observed outside Brain's own database.
 * The stamp is read off the declared finding kind, never off the sentence.
 *
 * `unrepresentedRoleAsks` turns a mapped flow's role set (`construction/
 * roles.ts`) into asks about the positions on it that no record represents.
 * They are ordinary SCAN asks whose bucket names the role, so they open
 * through `openAsks` and `createCandidate` exactly like every other question:
 * no second research pipeline, no new purpose, no migration.
 *
 * `openAsks` is what calls it in production: whatever slots the allocator's
 * own asks leave free under `MAX_OPEN_KERNEL_ROUNDS`, it fills with
 * `roleAsksFromSnapshot` — the role asks of every mapped subject that no round
 * has asked yet — and, while no role question is open, it holds one slot for
 * one, taken from the allocator's lowest-ranked ask, which is planned again
 * next pass. The cap is the one the allocator works under, so role questions
 * never raise what the kernel may have open.
 */
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { byClaimTime, everyPage, missionsForRounds } from '../russell/roundMissions.ts';
import { structuralClaims } from '../../repos/research.ts';
import {
  closeIndustryRound,
  countFiledFromOrchestration,
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
import { sprintGoalLine } from '../../domain/operatingModel.ts';
import type { OpportunityOrigin } from './construction/origins.ts';
import { commercialRoles, SEED_ROLES, type FlowRoles } from './construction/roles.ts';
import { MAX_OPEN_KERNEL_ROUNDS, type Ask } from './allocate.ts';
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

/**
 * The origin of an absorbed finding, from its declared kind alone.
 *
 * A constraint the research established is the CONSTRAINT origin — a reason a
 * different arrangement may exist. Every other kind came from a gated claim
 * about a public source, which is what WORLD means: observed outside Brain's
 * own database. Never read from the claim's sentence (§8).
 */
export function originOfFinding(finding: string): OpportunityOrigin {
  return finding === 'HIDDEN_CONSTRAINT' ? 'CONSTRAINT' : 'WORLD';
}

/** A SCAN bucket that asks about one commercial role rather than one mechanism. */
const ROLE_BUCKET = 'role:';

export function roleBucketId(roleId: string): string {
  return `${ROLE_BUCKET}${roleId}`;
}

export function roleIdOfBucket(bucketId: string | null): string | null {
  return bucketId && bucketId.startsWith(ROLE_BUCKET) ? bucketId.slice(ROLE_BUCKET.length) || null : null;
}

/**
 * Asks about the roles on a subject's mapped flows that no record represents.
 *
 * A role is represented when an actor in the evidence stands in it — then its
 * sources carry that actor beside the flow — or when the evidence itself
 * named it (an EVIDENCE role). A seed role whose only source is the flow is a
 * position Brain can name but holds no record of, and that is exactly the
 * question ARCH-01 says Brain must be able to ask. A role the evidence refuses
 * (occupiable NO) is not asked about: the record already answered it.
 *
 * One ask per role per subject, because the round key is the subject and the
 * bucket; which flows it was missing from travels in `why`. Only flows the
 * map recorded count — a reference pack is not a record. Pure.
 */
export function unrepresentedRoleAsks(input: {
  nodeId: string;
  subject: string;
  since: string;
  sets: readonly FlowRoles[];
  round?: number;
  rank?: number;
}): Ask[] {
  const missing = new Map<string, { label: string; flows: string[] }>();
  for (const set of input.sets) {
    if (set.flow.source.kind !== 'MAP') continue;
    for (const role of set.roles) {
      if (role.origin !== 'SEED') continue;
      if (role.occupiable.answer === 'NO') continue;
      if (role.sources.length > 1) continue;
      const entry = missing.get(role.roleId) ?? { label: role.label, flows: [] };
      entry.flows.push(`${set.flowKey} (${set.flow.terms})`);
      missing.set(role.roleId, entry);
    }
  }
  return [...missing].map(([roleId, entry]) => ({
    purpose: 'SCAN' as const,
    nodeId: input.nodeId,
    bucketId: roleBucketId(roleId),
    opportunityId: null,
    round: Math.max(1, Math.trunc(input.round ?? 1)),
    rank: input.rank ?? 0,
    subject: input.subject,
    since: input.since,
    why:
      `No record represents a ${entry.label} on ${entry.flows.length} mapped flow` +
      `${entry.flows.length === 1 ? '' : 's'} of ${input.subject}: ${entry.flows.join('; ')}.`,
  }));
}

/**
 * The role asks Brain has not opened yet, read from the snapshot it already holds.
 *
 * One pass per subject on the map (a root node): its recorded subtree and
 * constraints become evidence exactly as the r01.com-13-1 probe reads them
 * (`evidenceFromMap` → `assembleEvidence` → `commercialRoles`), and
 * `unrepresentedRoleAsks` names the roles no record represents. A subject and
 * role that already have a round of any state are skipped: the round key is
 * the subject and the bucket, so it is asked once and its answer is absorbed
 * like any other. Ordered by when Brain came to know the subject, then by
 * role order. At most `limit`. Reads nothing beyond the snapshot.
 */
export async function roleAsksFromSnapshot(snapshot: GraphSnapshot, limit: number): Promise<Ask[]> {
  const room = Math.max(0, Math.trunc(limit));
  if (room === 0) return [];
  const { assembleEvidence, evidenceFromMap, subtreeFor } = await import('./construction/service.ts');
  const asked = new Set(snapshot.rounds.filter((one) => one.nodeId && one.bucketId).map((one) => `${one.nodeId}|${one.bucketId}`));
  const roots = snapshot.nodes
    .filter((one) => one.parentId === null && one.retiredAt === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const out: Ask[] = [];
  for (const root of roots) {
    const map = evidenceFromMap(subtreeFor(snapshot.nodes, root.name), snapshot.constraints);
    if (map.flows.length === 0) continue;
    const evidence = assembleEvidence({ text: root.name, industry: root.name, geography: null, map, recorded: [] });
    const asks = unrepresentedRoleAsks({ nodeId: root.id, subject: root.name, since: root.createdAt, sets: commercialRoles(evidence) });
    for (const ask of asks) {
      if (asked.has(`${ask.nodeId}|${ask.bucketId}`)) continue;
      out.push(ask);
      if (out.length >= room) return out;
    }
  }
  return out;
}

function roleTitle(label: string, path: readonly string[]): string {
  return `Who could stand as ${label} — in ${path[path.length - 1] ?? 'this subject'}`;
}

function roleQuestion(input: { roleId: string; label: string; path: readonly string[]; objective: string }): string {
  const seed = SEED_ROLES.find((one) => one.id === input.roleId);
  const controls = seed ? seed.controls.map((one) => one.toLowerCase().replace(/_/g, ' ')).join(', ') : null;
  return [
    `Within ${input.path.join(' → ')}: does anyone stand as ${input.label} on the flows of money and work, ` +
      (controls ? `controlling ${controls}, ` : '') +
      'and could an operation occupy that position legally and contractually without doing the physical work itself? ' +
      'Name who occupies it now, what the position is paid and on what terms, the duties and risks that follow from it, ' +
      'and any licence, bond, registration or contract term that decides who may stand there. Where nobody occupies ' +
      'it, say so plainly rather than naming a plausible occupant.',
    sprintGoalLine(input.objective),
  ].join(' ');
}

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
 * A round insert lost its `ON CONFLICT DO NOTHING` race.
 *
 * Thrown to roll back the candidate created in the same transaction, never
 * caught outside `openAsks`'s own loop.
 */
class RoundNotOpened extends Error {}

/**
 * Turn the allocator's decisions into work.
 *
 * The candidate and its round commit together, in one transaction. A round
 * insert that loses its `ON CONFLICT DO NOTHING` race means another pass
 * already opened this exact question, and the candidate this call just
 * created would otherwise be left committed with nothing pointing at it —
 * **not** harmless, whatever an earlier version of this comment claimed: the
 * candidate is created `SHARED` with a project, and Russell's tick judges and
 * can launch any unjudged `SHARED` candidate, orphan or not. So a crash
 * between the two writes, or two passes racing on the same round key, used to
 * be able to produce a research mission Brain pays for while no round points
 * at it and its answer is never absorbed. Rolling both writes back together
 * makes a lost race exactly as if this call had never happened.
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

  /*
   * Roles no record represents (ARCH-01, COM-13-1), in the slots the
   * allocator's own asks leave free. Without this nothing in production ever
   * asked about them: `unrepresentedRoleAsks` existed and no path called it.
   */
  const open = input.snapshot.rounds.filter((one) => one.state === 'OPEN');
  const free = MAX_OPEN_KERNEL_ROUNDS - open.length - input.asks.length;
  /*
   * The allocator fills every slot whenever its own queue is longer than the
   * cap, which on a growing map is always, so free slots alone would starve
   * this branch exactly as the missing call did. While no role question is
   * open, one slot is held for one: the allocator's lowest-ranked ask (its
   * last) yields it and is simply planned again next pass. Never the only ask
   * the allocator gave, and never above the cap.
   */
  const roleOpen = open.some((one) => roleIdOfBucket(one.bucketId) !== null);
  const reserve = !roleOpen && free <= 0 && input.asks.length >= 2 && open.length + 1 <= MAX_OPEN_KERNEL_ROUNDS;
  const given = new Set(input.asks.map((one) => `${one.nodeId}|${one.bucketId}`));
  const roleAsks = (await roleAsksFromSnapshot(input.snapshot, reserve ? 1 : free)).filter((one) => !given.has(`${one.nodeId}|${one.bucketId}`));
  const allocated = reserve && roleAsks.length > 0 ? input.asks.slice(0, Math.max(0, MAX_OPEN_KERNEL_ROUNDS - open.length - 1)) : input.asks;
  const asks = [...allocated, ...roleAsks];

  for (const ask of asks) {
    const composed = await compose({ ask, mode, byId, coverage: coverageByNode });
    if (!composed) continue;

    let round: IndustryRound;
    try {
      round = await getDb().transaction(async (): Promise<IndustryRound> => {
        const candidate = await createCandidate({
          projectId: input.projectId,
          visibility: 'SHARED',
          conversationId: null,
          sourceMessageId: null,
          title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
          statement: composed.question,
        });

        const result = await openIndustryRound({
          projectId: input.projectId,
          cashModeId: mode.id,
          nodeId: ask.nodeId,
          purpose: ask.purpose,
          bucketId: ask.bucketId,
          opportunityId: ask.opportunityId,
          round: ask.round,
          candidateId: candidate.id,
        });
        if (!result.created) throw new RoundNotOpened();
        return result.round;
      });
    } catch (error) {
      if (error instanceof RoundNotOpened) continue;
      // One ask that cannot be written must not stop the others behind it.
      console.error(`[brain] industry ask ${ask.purpose} ${ask.subject.slice(0, 80)} not opened: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const candidateId = round.candidateId;
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: ask.opportunityId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: round.id,
        purpose: ask.purpose,
        nodeId: ask.nodeId,
        bucketId: ask.bucketId,
        opportunityId: ask.opportunityId,
        candidateId,
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
      roundId: round.id,
      purpose: ask.purpose,
      nodeId: ask.nodeId,
      bucketId: ask.bucketId,
      opportunityId: ask.opportunityId,
      candidateId,
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

  const roleId = roleIdOfBucket(ask.bucketId);
  if (roleId) {
    const label = SEED_ROLES.find((one) => one.id === roleId)?.label ?? roleId.replace(/_/g, ' ');
    return {
      title: roleTitle(label, path),
      question: roleQuestion({ roleId, label, path, objective: mode.objective }),
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
  /**
   * The origin of every row filed this pass (OPP-03), from its finding kind.
   * Optional only so a caller's empty result stays valid; `absorb` always sets it.
   */
  origins?: { kind: 'NODE' | 'CONSTRAINT' | 'CAPITAL'; id: string; claimId: string; origin: OpportunityOrigin }[];
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
  const out: Absorbed & { origins: NonNullable<Absorbed['origins']> } = { nodes: [], constraints: [], capital: [], settled: [], refused: [], origins: [] };
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
  const rounds = await missionsForRounds([...live.keys()]);
  const byOrchestration = new Map<string, IndustryRound>();
  for (const [candidateId, round] of live) {
    for (const orchestrationId of rounds.get(candidateId)?.orchestrationIds ?? []) {
      byOrchestration.set(orchestrationId, round);
    }
  }

  const nodes = await listNodes(input.projectId);
  const byNodeId = new Map(nodes.map((one) => [one.id, one]));

  const fileAll = async (
    entries: readonly { claim: ResearchClaim; orchestrationId: string }[],
  ): Promise<void> => {
    for (const entry of entries) {
      const round = byOrchestration.get(entry.orchestrationId);
      if (!round) continue;
      await file({ projectId: input.projectId, claim: entry.claim, round, byNodeId, out });
    }
  };

  // Rounds still being worked on: what has been gated so far, within budget.
  const working = [...live]
    .filter(([candidateId]) => !rounds.get(candidateId)?.outcome)
    .flatMap(([candidateId]) => rounds.get(candidateId)?.orchestrationIds ?? []);
  const workingClaims = await structuralClaims({
    projectId: input.projectId,
    orchestrationIds: working,
    limit,
  });

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
  /*
   * A round whose idea has ended files every claim it produced first — a
   * complete, paged read rather than the pass's budget, in claim order across
   * every round ending this pass — so nothing it established is left behind a
   * closed round. DONE is HARVESTED; FAILED or CANCELLED is ABANDONED (RES-2):
   * it answered as far as it ever will, and left OPEN it held its slot for ever.
   */
  const ending = [...live].filter(([candidateId]) => rounds.get(candidateId)?.outcome);
  const endingClaims: { claim: ResearchClaim; orchestrationId: string }[] = [];
  for (const [candidateId] of ending) {
    const entry = rounds.get(candidateId)!;
    endingClaims.push(
      ...(await everyPage((offset, size) =>
        structuralClaims({
          projectId: input.projectId,
          orchestrationIds: entry.orchestrationIds,
          limit: size,
          offset,
        }),
      )),
    );
  }
  await fileAll(byClaimTime([...workingClaims, ...endingClaims]));
  for (const [candidateId, round] of ending) {
    const entry = rounds.get(candidateId)!;
    /*
     * Derived from the rows this round's findings filed, rather than tallied
     * from what this pass wrote: tallying is correct only while every pass
     * that absorbs a round also closes it, and a tick dying between the two
     * would record a productive round as barren. Summed over every attempt's
     * orchestration, because a redo files under the same round.
     */
    let found = 0;
    for (const orchestrationId of entry.orchestrationIds) {
      found +=
        (await countFiledFromOrchestration(orchestrationId)) +
        (round.purpose === 'SCAN' ? (openingsPerOrchestration.get(orchestrationId) ?? 0) : 0);
    }
    if (await closeIndustryRound({ id: round.id, to: entry.outcome!, found })) {
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
        origins: out.origins,
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
  out: Absorbed & { origins: NonNullable<Absorbed['origins']> };
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
      out.origins.push({ kind: 'NODE', id: created.node.id, claimId: claim.id, origin: originOfFinding(finding) });
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
      out.origins.push({ kind: 'CONSTRAINT', id: recorded.id, claimId: claim.id, origin: originOfFinding(finding) });
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
      out.origins.push({ kind: 'CAPITAL', id: recorded.id, claimId: claim.id, origin: originOfFinding(finding) });
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
    out.origins.push({ kind: 'CAPITAL', id: recorded.id, claimId: claim.id, origin: originOfFinding(finding) });
    return true;
  }
  return false;
}
