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
import { isNonPurchasePayment, nonPurchaseSentence, paymentNatureOf } from '../../domain/paymentNature.ts';
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { byClaimTime, everyPage, missionsForRounds } from '../russell/roundMissions.ts';
import { claimsByIds, constructedRoundBuckets, goalPriceIdeasOfClaims, structuralClaims, unfiledConstructedRoundClaims, unfiledUnitEconomicClaims } from '../../repos/research.ts';
import { goalPriceQuestionOf } from '../goals/goalWork.ts';
import { arrangementForLegacyKey } from '../../repos/monetization.ts';
import { ARRANGEMENT_BUCKET_MARK, arrangementKeyOfBucket } from '../cash/arrangementLibrary.ts';
import { planBuyerType } from '../cash/construct.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { readMoneyFigures, readSubCentRates } from '../cash/figures.ts';
import { readShareOrCount } from './shareCountFacts.ts';
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
  buyerNameKey,
  buyerPopulationName,
  namesABuyerPopulation,
  isCapitalMechanism,
  isCapitalRequirement,
  isConstraintKind,
  matchBuyerType,
  nodeKindForFinding,
  pathOf,
  roleQualifier,
  transactionParties,
} from '../../domain/industry.ts';
import { listProjectFacts, recordClaimFact, type RecordedFact } from '../../repos/construction.ts';
import { readNonPriceFact } from './nonPriceFacts.ts';
import { FACT_KEYS, isFactKey, type FactKey } from '../../domain/construction.ts';
import {
  bootstrapQuestion,
  BOOTSTRAP_TITLE,
  bucketById,
  capitalQuestion,
  contextLine,
  capitalTitle,
  mapQuestion,
  mapTitle,
  scanQuestion,
  scanTitle,
  transferQuestion,
  transferTitle,
} from './questions.ts';
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

function roleQuestion(input: { roleId: string; label: string; path: readonly string[]; objective: string | null }): string {
  const seed = SEED_ROLES.find((one) => one.id === input.roleId);
  const controls = seed ? seed.controls.map((one) => one.toLowerCase().replace(/_/g, ' ')).join(', ') : null;
  return [
    `Within ${input.path.join(' → ')}: does anyone stand as ${input.label} on the flows of money and work, ` +
      (controls ? `controlling ${controls}, ` : '') +
      'and could an operation occupy that position legally and contractually without doing the physical work itself? ' +
      'Name who occupies it now, what the position is paid and on what terms, the duties and risks that follow from it, ' +
      'and any licence, bond, registration or contract term that decides who may stand there. Where nobody occupies ' +
      'it, say so plainly rather than naming a plausible occupant.',
    contextLine(input.objective),
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
  /**
   * Who the rounds are filed under (W-1). The kernel passes it: an ACTIVE
   * sprint's id and objective, or `cashModeId: null` and no objective when the
   * standing research grant asked — then the question carries the neutral
   * standing line and a sprint's wind-down does not stop it. Omitted, the
   * project's sprint row is used as before.
   */
  filing?: { cashModeId: string | null; objective: string | null };
  /** How many kernel rounds may be open at once; `MAX_OPEN_KERNEL_ROUNDS` when omitted. */
  cap?: number;
}): Promise<OpenedRound[]> {
  const sprint = input.filing ? null : await getCashMode(input.projectId);
  const filing = input.filing ?? (sprint ? { cashModeId: sprint.id, objective: sprint.objective } : null);
  if (!filing) return [];
  const mode = { objective: filing.objective };
  const cap = Math.max(0, Math.trunc(input.cap ?? MAX_OPEN_KERNEL_ROUNDS));

  const byId = new Map(input.snapshot.nodes.map((one) => [one.id, one]));
  const coverageByNode = new Map(input.snapshot.coverage.map((one) => [one.node.id, one]));
  const out: OpenedRound[] = [];

  /*
   * Roles no record represents (ARCH-01, COM-13-1), in the slots the
   * allocator's own asks leave free. Without this nothing in production ever
   * asked about them: `unrepresentedRoleAsks` existed and no path called it.
   */
  const open = input.snapshot.rounds.filter((one) => one.state === 'OPEN');
  const free = cap - open.length - input.asks.length;
  /*
   * The allocator fills every slot whenever its own queue is longer than the
   * cap, which on a growing map is always, so free slots alone would starve
   * this branch exactly as the missing call did. While no role question is
   * open, one slot is held for one: the allocator's lowest-ranked ask (its
   * last) yields it and is simply planned again next pass. Never the only ask
   * the allocator gave, and never above the cap.
   */
  const roleOpen = open.some((one) => roleIdOfBucket(one.bucketId) !== null);
  const reserve = !roleOpen && free <= 0 && input.asks.length >= 2 && open.length + 1 <= cap;
  const given = new Set(input.asks.map((one) => `${one.nodeId}|${one.bucketId}`));
  const roleAsks = (await roleAsksFromSnapshot(input.snapshot, reserve ? 1 : free)).filter((one) => !given.has(`${one.nodeId}|${one.bucketId}`));
  const allocated = reserve && roleAsks.length > 0 ? input.asks.slice(0, Math.max(0, cap - open.length - 1)) : input.asks;
  const asks = [...allocated, ...roleAsks];
  // Which map buyers an observed unit economic already prices (F3): read once, only when a MAP ask needs it.
  const priced = asks.some((one) => one.purpose === 'MAP') ? await pricedBuyerIds(input.projectId) : new Set<string>();

  for (const ask of asks) {
    const composed = await compose({ ask, mode, byId, coverage: coverageByNode, priced });
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
          cashModeId: filing.cashModeId,
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

/** The map buyers an OBSERVED or VERIFIED project-level price, unit cost or volume fact is segmented to. */
async function pricedBuyerIds(projectId: string): Promise<Set<string>> {
  const facts = await listProjectFacts(projectId);
  return new Set(
    facts
      .filter((one) => (one.status === 'OBSERVED' || one.status === 'VERIFIED') && FACT_KEYS[one.key].kind === 'POSITIVE' && FACT_KEYS[one.key].unit.startsWith('USD') && one.segment?.startsWith('map_'))
      .map((one) => one.segment!.slice('map_'.length)),
  );
}

/**
 * The buyer types at or directly under a subject that no observed fact prices:
 * their names, an empty list when the subject holds no buyer type yet (the
 * question then asks for whichever buyers research finds), or null when every
 * buyer here is priced and the question asks nothing more. Pure.
 */
export function unpricedBuyersUnder(nodeId: string, byId: ReadonlyMap<string, IndustryNode>, priced: ReadonlySet<string>): string[] | null {
  const node = byId.get(nodeId);
  if (!node) return null;
  const buyers = node.kind === 'BUYER_TYPE' ? [node] : [...byId.values()].filter((one) => one.parentId === nodeId && one.kind === 'BUYER_TYPE' && !one.retiredAt);
  if (buyers.length === 0) return [];
  const unpriced = buyers.filter((one) => !priced.has(one.id)).map((one) => one.name);
  return unpriced.length > 0 ? unpriced : null;
}

async function compose(input: {
  ask: Ask;
  mode: { objective: string | null };
  byId: Map<string, IndustryNode>;
  coverage: Map<string, { children: number; scanFound: number }>;
  priced?: ReadonlySet<string>;
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
        unpricedBuyers: unpricedBuyersUnder(ask.nodeId, input.byId, input.priced ?? new Set()),
      }),
    };
  }

  /*
   * A §82 transfer (W-8): a held precedent's design carried to this population,
   * asked as a hypothesis that names its material differences.
   */
  const { transferOfBucket, transferWords } = await import('./transfer.ts');
  const transfer = transferOfBucket(ask.bucketId);
  if (transfer) {
    const precedent = await getOpportunity(transfer.precedentId);
    if (!precedent) return null;
    const words = transferWords(transfer.design, precedent, path);
    return {
      title: transferTitle(precedent, path),
      question: transferQuestion({ precedent, design: words.design, position: words.position, differences: words.differences, path, objective: mode.objective }),
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
  origins?: { kind: 'NODE' | 'CONSTRAINT' | 'CAPITAL' | 'FACT'; id: string; claimId: string; origin: OpportunityOrigin }[];
  /** Economic facts filed from claims that stated a figure or a role's occupant (W-5, W-6). */
  facts?: RecordedFact[];
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
  // No sprint row is needed: a round the standing research grant asked is
  // filed with no sprint (W-1), and filing what ran is never new discovery.

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
  if (kind === 'BUYER_TYPE' && !(round.purpose === 'BOOTSTRAP' && !round.nodeId) && !namesABuyerPopulation(subject)) {
    // "therefore an unidentified individual", "paying": a buyer node is a population a list can be built of (production, 2026-11-19).
    out.refused.push({ claimId: claim.id, why: `"${subject}" is a sentence fragment or an unknown party, not a kind of buyer a list can be built of.` });
    return false;
  }
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
      // Who pays and who supplies, as the finding declared them (W-13).
      ...(finding === 'TRANSACTION_TYPE' ? transactionParties(claim.structuralQualifier) : {}),
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

  if (finding === 'UNIT_ECONOMIC' || finding === 'ROLE_TERMS' || finding === 'ROLE_OCCUPANT') {
    return fileEconomicFact({ projectId: input.projectId, claim, round, byNodeId: input.byNodeId, out });
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

/** Claim types that reason or recommend rather than report what a source shows: a hypothesis, never an observation. */
const HYPOTHESIS_CLAIM_TYPES = new Set<ResearchClaim['claimType']>(['UNSUPPORTED_ASSERTION', 'INFERENCE', 'CALCULATION', 'FORECAST', 'RECOMMENDATION', 'DECISION', 'INSTRUCTION']);

/**
 * How strongly a gated claim's figure is known (W-5). A sourced, gated claim
 * that reports what its source shows is OBSERVED — observed in the world,
 * dated, with the claim as its lineage. A claim that reasons, forecasts or
 * carries no source is a hypothesis: ASSUMPTION. Never VERIFIED: that is a
 * person's attestation, and a machine does not make it.
 */
export function claimFactStatus(claim: Pick<ResearchClaim, 'sourceUrl' | 'sourced' | 'derived' | 'claimType' | 'accepted'>): 'OBSERVED' | 'ASSUMPTION' {
  if (!claim.accepted || !claim.sourced || !claim.sourceUrl || claim.derived || HYPOTHESIS_CLAIM_TYPES.has(claim.claimType)) return 'ASSUMPTION';
  return 'OBSERVED';
}

/** When a claim's figure was observed: the source's own date, else when it was read, else when it was filed. */
export function claimObservedAt(claim: Pick<ResearchClaim, 'sourceDate' | 'retrievedAt' | 'createdAt'>): string {
  for (const one of [claim.sourceDate, claim.retrievedAt, claim.createdAt]) {
    if (one && Number.isFinite(Date.parse(one))) return new Date(Date.parse(one)).toISOString();
  }
  return new Date().toISOString();
}

/** The buyer subject a declared name means, preferring the subtree the round asked about. */
function buyerNode(name: string, round: IndustryRound, byNodeId: Map<string, IndustryNode>): IndustryNode | null {
  const want = name.replace(/\s+/g, ' ').trim().toLowerCase();
  const rootOf = (id: string | null): string | null => {
    let current = id ? (byNodeId.get(id) ?? null) : null;
    const seen = new Set<string>();
    while (current && current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = byNodeId.get(current.parentId) ?? null;
    }
    return current?.id ?? null;
  };
  // Exact first, then the normalised name (F3): "Independent Restaurants" is the map's "independent restaurant".
  return matchBuyerType(want, byNodeId.values(), rootOf(round.nodeId));
}

/**
 * A claim that states a unit economic, a role's terms or a role's occupant,
 * filed as a project-level construction fact (W-5, W-6). The figure is
 * hundredths of the fact key's unit — a declared field, never read from the
 * sentence. A buyer the claim names that the map does not hold yet is refused
 * and filed on a later pass, once it is: the restructuring rule.
 */
async function fileEconomicFact(input: {
  projectId: string;
  claim: ResearchClaim;
  round: IndustryRound;
  byNodeId: Map<string, IndustryNode>;
  out: Absorbed & { origins: NonNullable<Absorbed['origins']> };
}): Promise<boolean> {
  const { claim, round, out } = input;
  const finding = claim.structuralFinding!;
  const subject = claim.structuralSubject!;
  const occupantFinding = finding === 'ROLE_OCCUPANT';
  const key = occupantFinding ? 'role_occupants' : subject;
  if (!isFactKey(key)) {
    out.refused.push({ claimId: claim.id, why: `"${subject}" is not a fact the construction prices.` });
    return false;
  }
  const role = finding === 'UNIT_ECONOMIC' ? { roleId: null, buyer: claim.structuralQualifier } : roleQualifier(claim.structuralQualifier);
  if (finding !== 'UNIT_ECONOMIC' && !role.roleId) {
    out.refused.push({ claimId: claim.id, why: `A ${finding} that names no role says nothing about one.` });
    return false;
  }
  let value = 1;
  if (!occupantFinding) {
    if (claim.structuralAmountCents === null || !Number.isFinite(claim.structuralAmountCents)) {
      out.refused.push({ claimId: claim.id, why: `A ${finding} with no figure prices nothing. It stays as evidence on its claim.` });
      return false;
    }
    value = claim.structuralAmountCents / 100;
    if (FACT_KEYS[key].kind === 'RATE' && value > 1) {
      out.refused.push({ claimId: claim.id, why: `${key} is a share, and ${value} is more than the whole.` });
      return false;
    }
  }
  let segment: string | null = null;
  if (role.buyer && (FACT_KEYS[key].segment || occupantFinding)) {
    const buyer = buyerNode(role.buyer, round, input.byNodeId);
    if (!buyer) {
      out.refused.push({ claimId: claim.id, why: `It is about "${role.buyer}", which is not a buyer type on the map yet. It is filed once that buyer is.` });
      return false;
    }
    segment = `map_${buyer.id}`;
  }
  const recorded = await recordClaimFact({
    projectId: input.projectId,
    nodeId: round.nodeId,
    claimId: claim.id,
    key,
    segment,
    low: value,
    high: value,
    status: claimFactStatus(claim),
    measures: claim.claim.slice(0, 500),
    sourceTitle: claim.sourceTitle ?? claim.sourcePublisher ?? claim.sourceUrl ?? 'research claim',
    sourceUrl: claim.sourceUrl,
    sourceKind: claim.primarySource ? 'PRIMARY' : 'SECONDARY',
    roleId: role.roleId,
    occupant: occupantFinding ? subject : null,
    observedAt: claimObservedAt(claim),
  });
  if (!recorded) return false;
  (out.facts ??= []).push(recorded);
  out.origins.push({ kind: 'FACT', id: recorded.id, claimId: claim.id, origin: originOfFinding(finding) });
  await recordCashEvent({
    projectId: input.projectId,
    kind: 'INDUSTRY_FACT_ABSORBED',
    actorRef: 'BRAIN',
    summary: `${key}${segment ? ` for ${segment}` : ''} filed from research as ${recorded.status.toLowerCase()}${recorded.roleId ? ` (role ${recorded.roleId})` : ''}.`,
    detail: { factId: recorded.id, claimId: claim.id, key, segment, status: recorded.status, nodeId: round.nodeId, roleId: recorded.roleId ?? null, observedAt: recorded.observedAt ?? null, validUntil: recorded.validUntil ?? null },
  });
  return true;
}

/** `file`, for the tests that drive one declared finding into its table without a mission. */
export { file as fileFinding };

/* ------------------------------------------------------------ back-fill (F3) */

/** Facts the back-fill files per pass, at most: small enough never to hold a tick. */
export const BACKFILL_BATCH = 20;
/** UNIT_ECONOMIC claims one pass reads, at most, before it stops for the tick. */
const BACKFILL_SCAN = 200;
/** Card fields whose gated claim states what the payer pays, and what serving them costs. */
const BACKFILL_FIELDS: Readonly<Record<string, { key: FactKey; end: 'LOW' | 'HIGH'; measures: string }>> = {
  revenueRange: { key: 'price_per_unit', end: 'LOW', measures: 'what this buyer pays per unit of work, as published' },
  price: { key: 'price_per_unit', end: 'LOW', measures: 'what this buyer pays per unit of work, as published' },
  directCosts: { key: 'contractor_rate_per_unit', end: 'HIGH', measures: 'the direct cost of supplying one unit of this buyer’s work, as published' },
};
/** Where each project's UNIT_ECONOMIC scan stopped, so a pass that filed nothing moves on rather than rereading it. */
const unitEconomicCursor = new Map<string, string>();
/** Where each project's constructed-round scan stopped, for the same reason. */
const constructedCursor = new Map<string, string>();

export interface Backfilled {
  filed: RecordedFact[];
  /** Facts filed this pass that supersede one filed under an older figure rule (`rederiveClaimFacts`). */
  refiled: RecordedFact[];
  /** Claims read and left unfiled: a buyer the map does not hold, no figure, not gated. */
  skipped: number;
}

/** Which of the back-fill's sources a candidate came from. */
export type BackfillSource = 'UNIT_ECONOMIC' | 'CARD_EVIDENCE' | 'CONSTRUCTED_ROUND';

/** A claim the back-fill would file, and as what. */
export interface BackfillCandidate {
  source: BackfillSource;
  claim: ResearchClaim;
  /** The live buyer type the fact files against; null when `newBuyer` must be put on the map first. */
  buyer: IndustryNode | null;
  /**
   * The buyer population an opening's payer extracts to that the map does not
   * hold yet: the back-fill adds it exactly as `mapPricedPayers` does (from the
   * opening's gated payer claim), then files against it.
   */
  newBuyer?: { population: string; opening: PricedOpening; payerClaimId: string };
  /**
   * The population a goal's price question asked about, when the map holds no
   * buyer type the plan reads for it: the back-fill puts it on the map
   * (`mapAskedPopulation`), established by this accepted, sourced answer, then
   * files against it.
   */
  askedPopulation?: AskedPopulation;
  key: FactKey;
  amount: number;
  /** The top of a stated range; absent, the fact is the point `amount`. */
  high?: number;
  measures: string;
}

/** What mapping a priced opening's payer reads from the opening. */
interface PricedOpening {
  id: string;
  payer: string;
  industry: string | null;
}

/** One claim (or card fact) the back-fill read, with what it would file or why it would not. */
export interface BackfillDecision {
  source: BackfillSource;
  claimId: string | null;
  candidate: BackfillCandidate | null;
  /** Why it is not filed; null for a candidate. */
  reason: string | null;
  /** The buyer wording that matched no mapped buyer type, when that is the reason. */
  unmatchedBuyer?: string;
  /**
   * False for a card fact refused before its claim is read (no payer, not
   * USD, no mapped buyer): the writer never counted those as skipped.
   */
  countsAsSkipped: boolean;
}

/**
 * The buyer population a goal's price question (`goal-price-` need,
 * `sendPortfolioNeeds`) asked about, read from the question Brain wrote —
 * its scope `price:<ref>` and the buyers it names — never from the answer.
 */
export interface AskedPopulation {
  /** The population's ref (`ConstructedArrangement.demand.ref`), the question's own scope. */
  ref: string;
  /** The buyers as the construction names them, resolved through the ref when it is a map node. */
  name: string;
  /** The industry of the opening the ref names, when it names one: the sector a new buyer type is put under. */
  industry: string | null;
  opportunityId: string | null;
}

/**
 * For each claim that answers a goal's price question, the population that
 * question asked about (production 2026-11-20, runs 44749620314 and
 * 44750150850: ten goal-price fragments ACCEPTED, 16 accepted `price_per_unit`
 * claims with an amount, no construction fact names any of them). The link is
 * claim → orchestration → mission → idea → the `goal-price-` need
 * (`goalPriceIdeasOfClaims`), and the population is the need's scope. A ref
 * that is a map node (a map-derived arrangement's demand) is resolved to the
 * node's name, and one that is an opening (an opening-derived demand) lends
 * the opening's industry; otherwise the name the question states is the
 * construction's demand name verbatim.
 */
async function askedPopulations(projectId: string, claims: readonly ResearchClaim[], nodes: readonly IndustryNode[]): Promise<Map<string, AskedPopulation>> {
  const out = new Map<string, AskedPopulation>();
  if (claims.length === 0) return out;
  const ideas = await goalPriceIdeasOfClaims(projectId, claims.map((one) => one.id));
  const openings = new Map<string, { industry: string | null; id: string } | null>();
  for (const [claimId, idea] of ideas) {
    const asked = goalPriceQuestionOf(idea);
    if (!asked) continue;
    const mapped = nodes.find((one) => one.id === asked.ref && one.kind === 'BUYER_TYPE');
    if (!openings.has(asked.ref)) {
      const opening = mapped ? null : await getOpportunity(asked.ref);
      openings.set(asked.ref, opening && opening.projectId === projectId ? { id: opening.id, industry: opening.industry } : null);
    }
    const opening = openings.get(asked.ref) ?? null;
    out.set(claimId, { ref: asked.ref, name: mapped ? mapped.name : asked.buyer, industry: opening?.industry ?? null, opportunityId: opening?.id ?? null });
  }
  return out;
}

/**
 * Source 1's verdict on one declared UNIT_ECONOMIC claim, by the kernel's own rules.
 *
 * An answer to a question Brain asked about a named population is filed
 * against that population (`asked`): the buyer is the question's own, through
 * `planBuyerType` — the node the plan reads a `map_<node>` fact from for that
 * demand — and never the researcher's free-text qualifier, which in
 * production held sentences ("GitHub Inc is the payer …") that matched no
 * buyer type. When the map holds no such node, the candidate carries the
 * population to put on it (guarded by `namesABuyerPopulation`). Every claim
 * Brain did not ask about a population is matched by its qualifier, as before.
 */
function judgeUnitEconomic(claim: ResearchClaim, nodes: readonly IndustryNode[], asked?: AskedPopulation): BackfillDecision {
  const refuse = (reason: string, unmatchedBuyer?: string): BackfillDecision => ({
    source: 'UNIT_ECONOMIC',
    claimId: claim.id,
    candidate: null,
    reason,
    countsAsSkipped: true,
    ...(unmatchedBuyer ? { unmatchedBuyer } : {}),
  });
  const key = claim.structuralSubject;
  if (!isFactKey(key)) return refuse('subject is not a construction fact key');
  if (!FACT_KEYS[key].segment) return refuse('fact key is not per buyer segment');
  if (asked) {
    // Invariant 39: only an accepted, sourced claim with a figure is filed, and only for a population a question named.
    if (!claim.accepted) return refuse('claim is not gated (accepted)');
    if (!claim.sourceUrl) return refuse('claim has no source URL');
    const amount = (claim.structuralAmountCents ?? NaN) / 100;
    if (!Number.isFinite(amount)) return refuse('declared amount is not a number');
    if (FACT_KEYS[key].kind === 'RATE' && amount > 1) return refuse('rate is more than the whole');
    if (FACT_KEYS[key].kind === 'POSITIVE' && amount <= 0) return refuse('a figure that must be positive is zero or less: a free tier or an unstated amount is not what a paying buyer pays');
    // A price is money these buyers pay: a figure the claim says is paid to them runs the other way (invariant 39).
    if (key === 'price_per_unit' && claimPaysPopulation(claim.claim, asked.name)) return refuse(`the claim states money paid to "${asked.name}", not a price they pay`);
    if (key === 'price_per_unit' && isNonPurchasePayment(claim.claim)) return refuse(`the claim states ${nonPurchaseSentence(paymentNatureOf(claim.claim))}`);
    const buyer = planBuyerType(asked.name, nodes);
    if (!buyer && !namesABuyerPopulation(asked.name)) return refuse('the population the price question asked about is not a buyer population, so none is mapped', asked.name);
    return {
      source: 'UNIT_ECONOMIC',
      claimId: claim.id,
      candidate: {
        source: 'UNIT_ECONOMIC',
        claim,
        buyer,
        ...(buyer ? {} : { askedPopulation: asked }),
        key,
        amount,
        measures: `answering Brain's price question about "${asked.name}": ${claim.claim}`,
      },
      reason: null,
      countsAsSkipped: true,
    };
  }
  if (!claim.structuralQualifier) return refuse('claim names no buyer qualifier');
  const buyer = matchBuyerType(claim.structuralQualifier, nodes);
  if (!buyer) return refuse('buyer qualifier matches no mapped buyer type', claim.structuralQualifier);
  if (key === 'price_per_unit' && claimPaysPopulation(claim.claim, buyer.name)) return refuse(`the claim states money paid to "${buyer.name}", not a price they pay`);
  if (key === 'price_per_unit' && isNonPurchasePayment(claim.claim)) return refuse(`the claim states ${nonPurchaseSentence(paymentNatureOf(claim.claim))}`);
  const amount = (claim.structuralAmountCents ?? NaN) / 100;
  if (!Number.isFinite(amount)) return refuse('declared amount is not a number');
  if (FACT_KEYS[key].kind === 'RATE' && amount > 1) return refuse('rate is more than the whole');
  if (FACT_KEYS[key].kind === 'POSITIVE' && amount <= 0) return refuse('a figure that must be positive is zero or less: a free tier or an unstated amount is not what a paying buyer pays');
  return {
    source: 'UNIT_ECONOMIC',
    claimId: claim.id,
    candidate: { source: 'UNIT_ECONOMIC', claim, buyer, key, amount, measures: claim.claim },
    reason: null,
    countsAsSkipped: true,
  };
}

/**
 * The live buyer type an opening's payer belongs to: the payer by name, else
 * the population `buyerPopulationName` puts it in — so one state's named
 * department files under the population of such state departments.
 */
export function payerBuyerType(payer: string, nodes: readonly IndustryNode[]): IndustryNode | null {
  const direct = matchBuyerType(payer, nodes);
  if (direct) return direct;
  const population = buyerPopulationName(payer);
  return population ? matchBuyerType(population, nodes) : null;
}

/** Source 2's verdicts: every EVIDENCE card fact for a price or a direct cost not yet filed, in card order. */
async function cardEvidenceDecisions(projectId: string, nodes: readonly IndustryNode[]): Promise<BackfillDecision[]> {
  const evidence = (await cardFactsForProject(projectId)).filter((one) => one.kind === 'EVIDENCE' && one.claimId);
  const facts = evidence.filter((one) => BACKFILL_FIELDS[one.field]);
  if (facts.length === 0) return [];
  const filed = new Set((await listProjectFacts(projectId)).map((one) => one.sourceClaimId).filter((id): id is string => !!id));
  const pending = facts.filter((one) => !filed.has(one.claimId!));
  if (pending.length === 0) return [];
  const payerClaim = new Map(evidence.filter((one) => one.field === 'payer').map((one) => [one.opportunityId, one.claimId!]));
  const openings = new Map((await listOpportunities({ projectId })).map((one) => [one.id, one]));
  const out: BackfillDecision[] = [];
  const early = (claimId: string, reason: string, unmatchedBuyer?: string): BackfillDecision => ({
    source: 'CARD_EVIDENCE',
    claimId,
    candidate: null,
    reason,
    countsAsSkipped: false,
    ...(unmatchedBuyer ? { unmatchedBuyer } : {}),
  });
  const matched: { fact: (typeof pending)[number]; buyer: IndustryNode | null; newBuyer?: { population: string; opening: PricedOpening; payerClaimId: string | null } }[] = [];
  for (const fact of pending) {
    const opening = openings.get(fact.opportunityId);
    if (!opening) out.push(early(fact.claimId!, 'card opening not found'));
    else if (!opening.payer) out.push(early(fact.claimId!, 'opening names no payer'));
    else if (opening.duplicateOfId) out.push(early(fact.claimId!, 'opening is a duplicate'));
    else if ((opening.currency ?? '').toUpperCase() !== 'USD') out.push(early(fact.claimId!, `opening currency is ${opening.currency ?? 'unset'}, not USD`));
    else {
      // The payer is read out of the stored prose and generalised exactly as a buyer node is named (`buyerPopulationName`).
      const buyer = payerBuyerType(opening.payer, nodes);
      const population = buyer ? null : buyerPopulationName(opening.payer);
      if (buyer) matched.push({ fact, buyer });
      else if (population) {
        matched.push({ fact, buyer: null, newBuyer: { population, opening: { id: opening.id, payer: opening.payer, industry: opening.industry }, payerClaimId: payerClaim.get(opening.id) ?? null } });
      } else out.push(early(fact.claimId!, 'opening payer names no buyer population', opening.payer));
    }
  }
  if (matched.length === 0) return out;
  const claimIds = matched.flatMap((one) => [one.fact.claimId!, ...(one.newBuyer?.payerClaimId ? [one.newBuyer.payerClaimId] : [])]);
  const claims = new Map((await claimsByIds([...new Set(claimIds)])).map((one) => [one.id, one]));
  const used = new Set<string>();
  for (const { fact, buyer, newBuyer } of matched) {
    const claim = claims.get(fact.claimId!);
    const spec = BACKFILL_FIELDS[fact.field]!;
    const refuse = (reason: string, unmatchedBuyer?: string): BackfillDecision => ({
      source: 'CARD_EVIDENCE',
      claimId: fact.claimId!,
      candidate: null,
      reason,
      countsAsSkipped: true,
      ...(unmatchedBuyer ? { unmatchedBuyer } : {}),
    });
    // A population is put on the map only from a payer research established: the opening's gated, sourced payer claim.
    const payer = newBuyer?.payerClaimId ? claims.get(newBuyer.payerClaimId) : undefined;
    if (!claim) out.push(refuse('claim not found'));
    else if (!claim.accepted) out.push(refuse('claim is not gated (accepted)'));
    else if (!claim.sourceUrl) out.push(refuse('claim has no source URL'));
    else if (newBuyer && !(payer && payer.accepted && payer.sourceUrl)) out.push(refuse('opening payer is not sourced evidence, so its population is not mapped', newBuyer.population));
    else if (used.has(claim.id)) out.push(refuse('claim already used by another card field'));
    else {
      used.add(claim.id);
      const figures = dealLevelFigures(readMoneyFigures(claim.claim, 'USD').filter((one) => one.cents > 0));
      if (figures.length === 0) out.push(refuse('claim states no positive USD figure'));
      else {
        const cents = spec.end === 'LOW' ? Math.min(...figures.map((one) => one.cents)) : Math.max(...figures.map((one) => one.cents));
        out.push({
          source: 'CARD_EVIDENCE',
          claimId: claim.id,
          candidate: {
            source: 'CARD_EVIDENCE',
            claim,
            buyer,
            ...(newBuyer && payer ? { newBuyer: { population: newBuyer.population, opening: newBuyer.opening, payerClaimId: payer.id } } : {}),
            key: spec.key,
            amount: cents / 100,
            measures: `${spec.measures}: ${claim.claim}`,
          },
          reason: null,
          countsAsSkipped: true,
        });
      }
    }
  }
  return out;
}

/**
 * Source 3's verdicts: gated claims a goal's constructed-arrangement round
 * produced, read whether or not the round ever settles (B1c, 2026-11-17).
 *
 * Production 08cba93f, goal wst_7b4fcbb5f2384f31b6c3: `TRACE claims 7 stored 0
 * in_plan 0`. Round goal-…-mx-2821cce3c372 r1, still OPEN, held accepted
 * claims such as "Oppizi charges $0.47 per postcard piece for a 10,000-home
 * EDDM run". The harvest files an opening only from a claim carrying an
 * opportunity_signal (a published price list is not an opening), source 1
 * reads only a claim that declares UNIT_ECONOMIC (these predate the question
 * asking for it), and source 2 reads only a card's evidence (no card exists
 * without an opening). So a published per-unit price for exactly the buyers
 * the arrangement names reached nothing.
 *
 * The round asked about one arrangement whose buyers are a map buyer type
 * (`monetization_paths.industry_node_id`, by the round's 12-hex key), so the
 * buyer is the round's own, never read from the prose. A claim qualifies by
 * stating a USD figure per unit (`perUnit`); what is filed is the deal-level
 * figure (`dealLevelFigures`) at its lowest — the unfavourable end, the card
 * rule's own — as `price_per_unit`. A claim that declares a structural finding
 * is source 1's; one with no per-unit figure, or on an arrangement whose
 * buyers are not a live map buyer type, is skipped.
 */
type RoundBuyer =
  | { buyer: IndustryNode; reason?: undefined; unmatchedBuyer?: undefined; sides: ArrangementSides }
  | { buyer: null; reason: string; unmatchedBuyer?: string; sides?: undefined };

/** Who an arrangement sells to and who it buys fulfilment from, as its stored design names them. */
export interface ArrangementSides {
  demand: string | null;
  supply: string | null;
}

/**
 * Whose price a constructed round's claim is (B1g, production 2026-11-18): of
 * 200 constructed-round claims, 185 were refused because their arrangement's
 * `industry_node_id` was null — set only when the demand came from the map,
 * on 297 of 1,316 arrangements. The plan never reads facts by that column: it
 * reads a `map_<node>` fact for every arrangement whose demand name is that
 * node's population (`planBuyerType`, construct.ts). So the buyer is the map
 * node when the arrangement names one, else the plan's own match for the
 * arrangement's demand (its stored design, else its opening's payer). When
 * the map holds no such population there is no key the plan reads, and the
 * claim is refused with the population named — never filed against a guess.
 * A pathway round (`mx-pw…`, `PATHWAY_KEY_PREFIX` in goals/plan.ts) is keyed by a hash of an opening and a gap and
 * names no arrangement, so it has no buyer to file against.
 */
async function constructedRoundBuyer(projectId: string, bucketId: string, nodes: readonly IndustryNode[]): Promise<RoundBuyer> {
  const key = arrangementKeyOfBucket(bucketId);
  if (!key) {
    return { buyer: null, reason: bucketId.includes(`${ARRANGEMENT_BUCKET_MARK}pw`) ? 'round is a pathway construction, which names no arrangement' : 'round names no arrangement key' };
  }
  const arrangement = await arrangementForLegacyKey(projectId, key);
  if (!arrangement) return { buyer: null, reason: 'round’s arrangement is not in the library' };
  const mapped = arrangement.industryNodeId ? nodes.find((one) => one.id === arrangement.industryNodeId) : undefined;
  const sides = arrangementSides(arrangement.design);
  if (mapped && mapped.kind === 'BUYER_TYPE' && !mapped.retiredAt) return { buyer: mapped, sides };
  const designed = sides.demand;
  let demand = typeof designed === 'string' && designed.trim() ? designed : null;
  if (!demand && arrangement.opportunityId) demand = (await getOpportunity(arrangement.opportunityId))?.payer ?? null;
  if (!demand && mapped) demand = mapped.name;
  if (!demand) return { buyer: null, reason: 'round’s arrangement names no buyers' };
  const buyer = planBuyerType(demand, nodes);
  return buyer ? { buyer, sides } : { buyer: null, reason: 'round’s arrangement buyers are no live map buyer type, so the plan reads no fact for them', unmatchedBuyer: demand };
}

function arrangementSides(design: Record<string, unknown>): ArrangementSides {
  const arrangement = design['arrangement'] as { demand?: { name?: unknown }; supply?: { name?: unknown } | null } | undefined;
  const name = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return { demand: name(arrangement?.demand?.name), supply: name(arrangement?.supply?.name) };
}

/** Words that name no particular side of a trade, so sharing one says nothing about whose price a claim states. */
const SIDE_STOPWORDS = new Set(
  'the and that this with for from who which their them they per each one any all are was were has have had its into onto upon order orders on-order commercial local small business businesses buyer buyers buying company companies firm firms provider providers service services work works other new own'.split(' '),
);

function sideTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || SIDE_STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * Whether a constructed round's claim prices the arrangement's SUPPLY rather
 * than what its buyers pay (B1i, production 2026-11-18).
 *
 * Arrangement 2821cce3c372 sells slots on a shared EDDM postcard to local
 * businesses and buys the run from "Commercial printers and mail houses that
 * print and enter EDDM mailings on order". Its round returned "Oppizi charges
 * $0.47 per postcard piece for a 10,000-home EDDM run, total $4,675" and three
 * USPS EDDM postage rates — every one a price the operator PAYS for the run —
 * and all four were filed as `price_per_unit`, what a slot buyer pays, which
 * #1085 then raised to $4,675 per slot. The round's own question asks for
 * these as "the fixed cost of one shared run".
 *
 * A claim prices the supply when it names a term of the arrangement's supply
 * that its demand does not use (here: printer, print, mail house, EDDM,
 * mailing). That errs toward cost: a slot price stated in the supply's words
 * is held back as a cost rather than read as revenue, and no unknown is ever
 * read as a buyer's payment (invariant 39).
 */
export function claimPricesSupply(claimText: string, sides: ArrangementSides | undefined): boolean {
  if (!sides?.supply) return false;
  const demand = sideTerms(sides.demand ?? '');
  const supplyOnly = [...sideTerms(sides.supply)].filter((one) => !demand.has(one));
  if (supplyOnly.length === 0) return false;
  const claim = sideTerms(claimText);
  return supplyOnly.some((one) => claim.has(one));
}

/**
 * Whether a claim names `population` as the side money is paid TO (production
 * 2026-11-20, prj_22fb4fec: GitHub's $10,000 bug-bounty rewards, money GitHub
 * pays security researchers, were filed as `price_per_unit` — what the asked
 * population pays — on three buyer nodes). A price fact is what these buyers
 * pay; a reward, bounty, wage or payout they receive runs the other way.
 *
 * Read from the claim's own words only, by three shapes: a paying verb whose
 * object is the population ("GitHub pays security researchers"), the
 * population as the subject of a receiving verb ("researchers earn up to"),
 * and a payment made "to" it ("rewards of up to $10,000 to researchers"). A
 * claim that names no recipient is not judged: its direction is unknown, and
 * the fact is filed as before. Pure.
 */
export function claimPaysPopulation(claimText: string, population: string): boolean {
  // The population's head noun ("researchers" in "Security researchers", "programs" in "Companies running bug bounty programs"):
  // a modifier word ("bounty") names something else, and matching it would read "pays researchers bounties" as paying the programs.
  const head = [...sideTerms(population)].pop();
  if (!head) return false;
  const text = claimText.toLowerCase().replace(/\s+/g, ' ');
  const esc = (one: string) => one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [...new Set([head, `${head}s`, `${head}es`, ...(head.endsWith('y') ? [`${head.slice(0, -1)}ies`] : [])])];
  const term = `(?:${forms.map(esc).join('|')})\\b`;
  // Words between a verb and its object that are not a preposition (a preposition starts an adjunct, not the recipient).
  const filler = '(?:(?!(?:for|of|per|up|to|in|on|at|from|with|by|as|than)\\b)[a-z0-9\'-]+ ){0,3}';
  const shapes = [
    new RegExp(`\\b(?:pays?|paid|paying|awards?|awarded|awarding|rewards?|rewarded|rewarding|compensates?|compensated|remunerates?|remunerated|tips?|tipped) ${filler}${term}`),
    new RegExp(`\\b${term} (?:[a-z0-9'-]+ ){0,2}?(?:earns?|earned|earning|(?:are|is|were|was|get|gets|got) (?:paid|awarded|rewarded|compensated)\\b|(?:receives?|received|receiving) (?:up to |as much as |an? |their )?(?:\\$|usd\\b|payments?\\b|payouts?\\b|rewards?\\b|bount|awards?\\b|wages?\\b|stipends?\\b|grants?\\b|commissions?\\b|compensation\\b))`),
    new RegExp(`\\b(?:paid|awarded|payable|payouts?|bount(?:y|ies)|rewards?|wages?|stipends?|prizes?)\\b[^.;]{0,80}?\\bto (?:[a-z0-9'-]+ ){0,3}?${term}`),
  ];
  return shapes.some((one) => one.test(text));
}

/**
 * A constructed round's claim the price readers refused, read for a close
 * rate or a buyer count (R3, `readShareOrCount`): the plan reads
 * `account_win_rate` as the arrangement's conversion and `accounts_reachable`
 * as its buyers (`constructionObservations`, cash/construct.ts). Filed only
 * from an OBSERVED claim that states no money, against the round's own buyer;
 * a percentage or a count that is neither keeps its refusal with why appended.
 * A decision that already files something, or whose round has no buyer, is
 * returned as it is.
 */
function shareOrCountDecision(decision: BackfillDecision, claim: ResearchClaim, buyer: IndustryNode | null): BackfillDecision {
  if (decision.candidate || !buyer || decision.claimId !== claim.id) return decision;
  if (readMoneyFigures(claim.claim, 'USD').some((one) => one.cents > 0)) return decision;
  const read = readShareOrCount(claim.claim, buyer.name);
  if (read === null) return decision;
  if ('refused' in read) return { ...decision, reason: `${decision.reason ?? 'refused'}; ${read.refused}` };
  if (claimFactStatus(claim) !== 'OBSERVED') return { ...decision, reason: `${decision.reason ?? 'refused'}; it states ${read.key} but is not an observation a source reports` };
  return {
    source: 'CONSTRUCTED_ROUND',
    claimId: claim.id,
    candidate: { source: 'CONSTRUCTED_ROUND', claim, buyer, key: read.key, amount: read.low, high: read.high, measures: `${read.measures}, from a constructed arrangement's research: ${claim.claim}` },
    reason: null,
    countsAsSkipped: true,
  };
}

async function constructedRoundDecisions(
  projectId: string,
  nodes: readonly IndustryNode[],
  rows: readonly { claim: ResearchClaim; bucketId: string }[],
): Promise<BackfillDecision[]> {
  const buyerByBucket = new Map<string, RoundBuyer>();
  const out: BackfillDecision[] = [];
  for (const { claim, bucketId } of rows) {
    const refuse = (reason: string, unmatchedBuyer?: string): BackfillDecision => ({ source: 'CONSTRUCTED_ROUND', claimId: claim.id, candidate: null, reason, countsAsSkipped: true, ...(unmatchedBuyer ? { unmatchedBuyer } : {}) });
    if (!buyerByBucket.has(bucketId)) buyerByBucket.set(bucketId, await constructedRoundBuyer(projectId, bucketId, nodes));
    const resolved = buyerByBucket.get(bucketId)!;
    if (!resolved.buyer) {
      out.push(refuse(resolved.reason, resolved.unmatchedBuyer));
      continue;
    }
    const buyer = resolved.buyer;
    const stated = readMoneyFigures(claim.claim, 'USD').filter((one) => one.cents > 0);
    const supply = claimPricesSupply(claim.claim, resolved.sides) ? supplyQuote(claim.claim) : null;
    if (supply && supply.basis !== 'TOTAL') {
      // What the arrangement pays its supplier: a run's total as its fixed cost, a rate as a per-unit cost, at the unfavourable (high) end.
      out.push({
        source: 'CONSTRUCTED_ROUND',
        claimId: claim.id,
        candidate: { source: 'CONSTRUCTED_ROUND', claim, buyer, key: supply.key, amount: supply.amount, measures: `${supply.why}, from a constructed arrangement's research: ${claim.claim}` },
        reason: null,
        countsAsSkipped: true,
      });
      continue;
    }
    if (!stated.some((one) => one.perUnit)) {
      out.push(nonPriceDecision(claim, buyer, refuse));
      continue;
    }
    const figures = dealLevelFigures(stated);
    out.push({
      source: 'CONSTRUCTED_ROUND',
      claimId: claim.id,
      candidate: {
        source: 'CONSTRUCTED_ROUND',
        claim,
        buyer,
        key: 'price_per_unit',
        amount: Math.min(...figures.map((one) => one.cents)) / 100,
        measures: `what these buyers are published paying ${figures[0]!.perUnit ? 'per unit' : 'per deal (the stated total)'}, from a constructed arrangement's research: ${claim.claim}`,
      },
      reason: null,
      countsAsSkipped: true,
    });
  }
  return out.map((decision, i) => shareOrCountDecision(decision, rows[i]!.claim, buyerByBucket.get(rows[i]!.bucketId)?.buyer ?? null));
}

/**
 * A constructed round's claim that states no per-unit price, read for the one
 * non-price figure the plan reads per buyer (R2, `readNonPriceFact`): what one
 * of these buyers buys a month, filed as `account_units_per_month` exactly as
 * stated, only from an OBSERVED claim. Everything else — a close or reply rate,
 * a market's total over a period, a percentage price cut — is refused naming
 * why, because the plan reads no fact for it.
 */
function nonPriceDecision(claim: ResearchClaim, buyer: IndustryNode, refuse: (reason: string) => BackfillDecision): BackfillDecision {
  const read = readNonPriceFact(claim.claim);
  if ('refused' in read) return refuse(`claim states no positive USD figure per unit, and ${read.refused}`);
  if (claimFactStatus(claim) !== 'OBSERVED') return refuse('claim states a volume per buyer but is not an observation a source reports');
  return {
    source: 'CONSTRUCTED_ROUND',
    claimId: claim.id,
    candidate: { source: 'CONSTRUCTED_ROUND', claim, buyer, key: read.key, amount: read.low, high: read.high, measures: `${read.measures}, from a constructed arrangement's research: ${claim.claim}` },
    reason: null,
    countsAsSkipped: true,
  };
}

/**
 * The figures a claim states at the level of one deal (B1f, 2026-11-18).
 *
 * The plan reads a `price_per_unit` fact as `value`, "what a buyer pays per
 * transaction" (`composeArrangement`, quant/mechanism.ts), multiplied by how
 * many transactions a buyer makes (`need_rate`). A figure per postcard piece is
 * not one transaction: production filed "Oppizi charges $0.47 per postcard
 * piece for a 10,000-home EDDM run, total $4,675" as a $0.47 deal, so the
 * arrangement 2821cce3c372 was worth 0 cents. When a claim states both a rate
 * and a figure that is not per anything — the total for the quantity it names
 * — the total is what one buyer pays for one deal, and only it is returned. A
 * claim that states rates alone keeps them: nothing here multiplies a rate by a
 * quantity read from prose.
 */
export function dealLevelFigures<T extends { perUnit: boolean }>(figures: readonly T[]): T[] {
  const totals = figures.filter((one) => !one.perUnit);
  return totals.length > 0 ? totals : [...figures];
}

/** Superseding facts one pass writes, at most (its own bound, apart from the filing batch). */
export const REDERIVE_BATCH = BACKFILL_BATCH;
/** Where each project's re-derivation scan stopped (by fact id), so a long fact list is read across ticks. */
const rederiveCursor = new Map<string, string>();
/** The fact keys a figure read out of claim prose is filed under, and the end of a claim's figures each takes. */
const REDERIVE_ENDS: Readonly<Partial<Record<FactKey, 'LOW' | 'HIGH'>>> = { price_per_unit: 'LOW', contractor_rate_per_unit: 'HIGH' };

/**
 * The figure the current rule files from a claim for a fact filed from it, or
 * null when the fact already holds it (B1h, 2026-11-18).
 *
 * `dealLevelFigures` changed what is filed from a claim that states both a
 * rate and a total, but a fact is filed once per claim, so production kept
 * "Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total
 * $4,675" as a $0.47 deal and the arrangement 2821cce3c372 was worth 0 cents.
 * A fact is re-derived only when its value is a per-unit figure the claim
 * states and the current rule now reads a different, deal-level one from the
 * same claim: a figure a claim declared (source 1) or a claim that states
 * rates alone is never touched.
 */
export function rederivedAmount(fact: Pick<RecordedFact, 'key' | 'low' | 'high'>, claimText: string): number | null {
  const end = REDERIVE_ENDS[fact.key];
  if (!end) return null;
  const stated = readMoneyFigures(claimText, 'USD').filter((one) => one.cents > 0);
  const deal = dealLevelFigures(stated);
  if (deal.length === stated.length) return null;
  const held = Math.round(Math.min(fact.low, fact.high) * 100);
  if (deal.some((one) => one.cents === held)) return null;
  if (!stated.some((one) => one.perUnit && one.cents === held)) return null;
  const cents = end === 'LOW' ? Math.min(...deal.map((one) => one.cents)) : Math.max(...deal.map((one) => one.cents));
  return cents / 100;
}

/**
 * What a claim that prices an arrangement's SUPPLY states that supply costs
 * (B1j, production 2026-11-18), at the unfavourable (high) end, or null when
 * it states no figure the readers accept.
 *
 * "Oppizi charges $0.47 per postcard piece for a 10,000-home EDDM run, total
 * $4,675" states a per-unit rate AND the total for the quantity it names: the
 * total is what one whole run costs whether one buyer or many share it, the
 * mechanism's `fixed_cost`, filed as `fixed_cost_per_run` (#1091 filed it as
 * `contractor_rate_per_unit` 4675, which a pooled design never reads, so the
 * plan's fixed cost stayed unknown). A rate alone ("$0.26 per piece") is a
 * per-unit cost, and so is a sub-cent rate ("$0.259 per piece",
 * `readSubCentRates`), which `readMoneyFigures` refuses and #1085 had read as
 * $259. A total with no rate beside it states no quantity, and keeps #1091's
 * reading (`basis: 'TOTAL'`) for the facts already filed that way.
 */
export function supplyQuote(claimText: string): { key: 'fixed_cost_per_run' | 'contractor_rate_per_unit'; amount: number; basis: 'RUN' | 'UNIT' | 'TOTAL'; why: string } | null {
  const stated = readMoneyFigures(claimText, 'USD').filter((one) => one.cents > 0);
  const rates = stated.filter((one) => one.perUnit);
  const totals = stated.filter((one) => !one.perUnit);
  const high = (figures: readonly { cents: number }[]) => Math.max(...figures.map((one) => one.cents)) / 100;
  if (rates.length > 0 && totals.length > 0) {
    return { key: 'fixed_cost_per_run', amount: high(totals), basis: 'RUN', why: "what the arrangement's supplier charges for one whole run (the stated total for the stated quantity) — the fixed cost of one shared run, never these buyers' price" };
  }
  const fine = rates.length > 0 ? rates.map((one) => one.cents / 100) : readSubCentRates(claimText, 'USD');
  if (fine.length > 0) return { key: 'contractor_rate_per_unit', amount: Math.max(...fine), basis: 'UNIT', why: "what the arrangement's supplier charges per unit — a direct cost, never these buyers' price" };
  if (totals.length > 0) return { key: 'contractor_rate_per_unit', amount: high(totals), basis: 'TOTAL', why: "what the arrangement's supplier charges per run (the stated total) — a direct cost, never these buyers' price" };
  return null;
}

/** The fact keys a claim pricing an arrangement's supply may have been filed under, rightly or not. */
const SUPPLY_FILED_KEYS: readonly FactKey[] = ['price_per_unit', 'contractor_rate_per_unit'];

/**
 * What a filed claim fact means under the current rules, or null when it
 * already means that. A `price_per_unit` or `contractor_rate_per_unit` filed
 * from a constructed round's claim that prices the arrangement's supply
 * (`claimPricesSupply`, B1i) is what `supplyQuote` reads from the claim: a
 * run's total as `fixed_cost_per_run`, a rate (a sub-cent one included) as
 * `contractor_rate_per_unit`. A `price_per_unit` whose claim states no figure
 * the readers accept is withdrawn as an ASSUMPTION, which no plan reads as
 * evidence. Otherwise the B1h rule.
 */
export function rederivedMeaning(
  fact: Pick<RecordedFact, 'key' | 'low' | 'high'> & { status?: RecordedFact['status'] },
  claimText: string,
  sides: ArrangementSides | undefined,
): { key: FactKey; amount: number; status?: 'ASSUMPTION'; why: string } | null {
  if (SUPPLY_FILED_KEYS.includes(fact.key) && claimPricesSupply(claimText, sides)) {
    const quote = supplyQuote(claimText);
    if (!quote) {
      // Already withdrawn, or a cost with nothing to replace it: withdrawing again would chain forever.
      if (fact.key !== 'price_per_unit' || fact.status === 'ASSUMPTION') return null;
      return { key: 'price_per_unit', amount: Math.min(fact.low, fact.high), status: 'ASSUMPTION', why: 'withdrawn: the claim prices the arrangement’s supply and states no figure the reader accepts' };
    }
    const held = Math.min(fact.low, fact.high);
    if (quote.key === fact.key && Math.abs(quote.amount - held) < 1e-9 && fact.status !== 'ASSUMPTION') return null;
    return { key: quote.key, amount: quote.amount, why: quote.why };
  }
  const amount = rederivedAmount(fact, claimText);
  if (amount === null) return null;
  return { key: fact.key, amount, why: fact.key === 'price_per_unit' ? 'what these buyers pay per deal (the stated total)' : 'the direct cost of one deal (the stated total)' };
}

/** Each claim's constructed arrangement's two sides, for the claims a round answered. */
async function supplySidesOf(projectId: string, claimIds: readonly string[]): Promise<Map<string, ArrangementSides>> {
  const out = new Map<string, ArrangementSides>();
  const buckets = await constructedRoundBuckets(projectId, [...new Set(claimIds)]);
  const byKey = new Map<string, ArrangementSides | null>();
  for (const [claimId, bucketId] of buckets) {
    const key = arrangementKeyOfBucket(bucketId);
    if (!key) continue;
    if (!byKey.has(key)) {
      const arrangement = await arrangementForLegacyKey(projectId, key);
      byKey.set(key, arrangement ? arrangementSides(arrangement.design) : null);
    }
    const sides = byKey.get(key);
    if (sides) out.set(claimId, sides);
  }
  return out;
}

/**
 * Supersede claim facts the back-fill filed under an older figure rule (B1h).
 * The old fact is never written: a new fact names it (`supersedes_fact_id`)
 * and readers resolve the current one (`listProjectFacts`), so the
 * $0.47 stays as history and the plan reads $4,675. Bounded (`BACKFILL_SCAN`
 * facts read from a cursor, `REDERIVE_BATCH` writes) and idempotent: a fact is
 * superseded at most once, and a re-derived fact already holds the current
 * rule's figure, so a replay writes nothing.
 */
export async function rederiveClaimFacts(projectId: string, batch = REDERIVE_BATCH): Promise<RecordedFact[]> {
  const out: RecordedFact[] = [];
  const after = rederiveCursor.get(projectId) ?? '';
  const scan = (await listProjectFacts(projectId))
    .filter((one) => one.sourceClaimId && one.recordedBy === 'BRAIN' && REDERIVE_ENDS[one.key] && one.id > after)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, BACKFILL_SCAN);
  if (scan.length === 0) {
    rederiveCursor.set(projectId, '');
    return out;
  }
  const claims = new Map((await claimsByIds([...new Set(scan.map((one) => one.sourceClaimId!))])).map((one) => [one.id, one]));
  const sides = await supplySidesOf(projectId, scan.filter((one) => SUPPLY_FILED_KEYS.includes(one.key)).map((one) => one.sourceClaimId!));
  let reached = '';
  for (const fact of scan) {
    if (out.length >= batch) break;
    reached = fact.id;
    const claim = claims.get(fact.sourceClaimId!);
    if (!claim || !claim.accepted || !claim.sourceUrl) continue;
    const meaning = rederivedMeaning(fact, claim.claim, sides.get(claim.id));
    if (meaning === null) continue;
    const { key, amount, status } = meaning;
    const recorded = await recordClaimFact({
      projectId,
      nodeId: fact.nodeId ?? null,
      claimId: claim.id,
      key,
      segment: fact.segment,
      low: amount,
      high: amount,
      status: status ?? claimFactStatus(claim),
      measures: `${meaning.why}, re-derived from the claim: ${claim.claim}`.slice(0, 500),
      sourceTitle: claim.sourceTitle ?? claim.sourcePublisher ?? claim.sourceUrl ?? 'research claim',
      sourceUrl: claim.sourceUrl,
      sourceKind: claim.primarySource ? 'PRIMARY' : 'SECONDARY',
      observedAt: claimObservedAt(claim),
      supersedesFactId: fact.id,
    });
    if (!recorded) continue;
    out.push(recorded);
    await recordCashEvent({
      projectId,
      kind: 'INDUSTRY_FACT_ABSORBED',
      actorRef: 'BRAIN',
      summary: `${fact.key} re-derived from its claim as ${key} ${amount}${status ? ` (${status.toLowerCase()}, not evidence)` : ''} (was ${fact.low}); the earlier fact is kept as history.`,
      detail: { factId: recorded.id, supersedes: fact.id, claimId: claim.id, key, previousKey: fact.key, segment: recorded.segment, status: recorded.status, previous: fact.low, amount, rederived: true },
    });
  }
  // Everything read: start over next pass. Otherwise resume after the last one read.
  rederiveCursor.set(projectId, reached === scan[scan.length - 1]!.id && scan.length < BACKFILL_SCAN ? '' : reached);
  return out;
}

/** What a dry run of the back-fill found: its pool, as the writer computes it, and nothing written. */
export interface BackfillPool {
  /** False when the map holds no live buyer type, and the back-fill reads nothing. */
  hasBuyerTypes: boolean;
  /** UNIT_ECONOMIC claims read (at most `BACKFILL_SCAN`; from `afterId`, since the writer's cursor lives in the server's memory). */
  unitEconomicRead: number;
  decisions: BackfillDecision[];
}

/**
 * The back-fill's candidate selection with no write (a DRY RUN, for the
 * census): both sources, every decision with its reason. `backfillClaimFacts`
 * files from exactly these judgements.
 */
export async function backfillCandidates(projectId: string, cursors: BackfillCursors = {}): Promise<BackfillPool> {
  const nodes = await listNodes(projectId);
  const hasBuyerTypes = nodes.some((one) => one.kind === 'BUYER_TYPE' && !one.retiredAt);
  // Each source from its own cursor, as the writer reads it: source 3's is never source 1's (B1g).
  const declared = await unfiledUnitEconomicClaims(projectId, cursors.unitEconomic ?? unitEconomicCursor.get(projectId) ?? '', BACKFILL_SCAN);
  const population = await askedPopulations(projectId, declared, nodes);
  // With no buyer type on the map, only an answer to a population's price question can file (it maps its population).
  if (!hasBuyerTypes) {
    const answers = declared.filter((claim) => population.has(claim.id));
    return { hasBuyerTypes: false, unitEconomicRead: declared.length, decisions: answers.map((claim) => judgeUnitEconomic(claim, nodes, population.get(claim.id))) };
  }
  const asked = await unfiledConstructedRoundClaims(projectId, cursors.constructed ?? constructedCursor.get(projectId) ?? '', BACKFILL_SCAN);
  return {
    hasBuyerTypes: true,
    unitEconomicRead: declared.length,
    decisions: [
      ...declared.map((claim) => judgeUnitEconomic(claim, nodes, population.get(claim.id))),
      ...(await cardEvidenceDecisions(projectId, nodes)),
      ...(await constructedRoundDecisions(projectId, nodes, asked)),
    ],
  };
}

/** Where each source's scan starts; a source left out starts where the writer's own cursor for it stands. */
export interface BackfillCursors {
  /** Source 1: UNIT_ECONOMIC claims after this id. */
  unitEconomic?: string;
  /** Source 3: constructed-round claims after this id. */
  constructed?: string;
}

/**
 * Writes a pass keeps for source 3 (constructed rounds), out of its batch
 * (B1g): it ran only in whatever room sources 1 and 2 left, so a project with
 * twenty unfiled declared or card figures never read a constructed round.
 * Sources 1 and 2 share the rest; source 3 also takes whatever they leave.
 */
export function backfillConstructedShare(batch: number): number {
  return Math.floor(Math.max(0, batch) / 2);
}

/**
 * File construction facts from gated claims research already holds (F3,
 * 2026-11-15): production held 16 786 sourced claims and no construction fact,
 * because only a claim from an open kernel round's mission was ever read.
 *
 * Two sources, each a claim that already states a figure for a buyer the map
 * holds:
 *   1. a UNIT_ECONOMIC claim with a declared amount, from any orchestration,
 *      whose buyer qualifier names a map buyer type — filed by the kernel's
 *      own rules (`fileEconomicFact`);
 *   2. a claim a card holds as EVIDENCE for its price or direct costs, on an
 *      opening whose payer names a map buyer type — the figure read by the
 *      money reader the card uses (`readMoneyFigures`), at the unfavourable
 *      end (the lowest price, the highest cost), in USD only.
 *
 * Bounded (`BACKFILL_BATCH` writes, `BACKFILL_SCAN` reads) and idempotent: a
 * fact is unique by its claim, so a replay files nothing twice. Provenance is
 * the claim; the status is the claim's (`claimFactStatus`), never VERIFIED.
 * Which claims qualify is decided by the same judgements `backfillCandidates`
 * reports, so the census's dry run is this selection.
 */
export async function backfillClaimFacts(projectId: string, batch = BACKFILL_BATCH): Promise<Backfilled> {
  const out: Backfilled = { filed: [], refiled: [], skipped: 0 };
  // Sources 1 and 2 stop short of source 3's share, so they cannot starve it; source 3 then has the whole remainder.
  const reserved = backfillConstructedShare(batch);
  let limit = batch - reserved;
  const room = () => limit - out.filed.length;
  const nodes = await listNodes(projectId);
  // With no buyer type on the map only source 1's answers to a population's price question can file: they map their population.
  const hasBuyerTypes = nodes.some((one) => one.kind === 'BUYER_TYPE' && !one.retiredAt);

  // 0. Facts filed under an older figure rule, re-derived first: a pass that files nothing new still corrects them.
  if (hasBuyerTypes) out.refiled.push(...(await rederiveClaimFacts(projectId)));

  const fileOne = async (input: BackfillCandidate): Promise<void> => {
    const { claim } = input;
    // Every source's price passes here: a reward, grant, rebate or wage is never what a buyer pays (audit 2026-11-23, `paymentNatureOf`).
    if (input.key === 'price_per_unit' && isNonPurchasePayment(claim.claim)) {
      out.skipped += 1;
      return;
    }
    let buyer = input.buyer;
    if (!buyer && input.newBuyer) {
      // An earlier candidate this pass may already have mapped this population.
      buyer = payerBuyerType(input.newBuyer.opening.payer, nodes) ?? (await mapPayerPopulation(projectId, input.newBuyer.opening, input.newBuyer.population, input.newBuyer.payerClaimId, claim.id, nodes)).node;
    }
    if (!buyer && input.askedPopulation) {
      // An earlier answer this pass may already have mapped this population.
      buyer = planBuyerType(input.askedPopulation.name, nodes) ?? (await mapAskedPopulation(projectId, input.askedPopulation, claim.id, nodes));
    }
    if (!buyer) return;
    const recorded = await recordClaimFact({
      projectId,
      nodeId: buyer.id,
      claimId: claim.id,
      key: input.key,
      segment: `map_${buyer.id}`,
      low: input.amount,
      high: input.high ?? input.amount,
      status: claimFactStatus(claim),
      measures: input.measures.slice(0, 500),
      sourceTitle: claim.sourceTitle ?? claim.sourcePublisher ?? claim.sourceUrl ?? 'research claim',
      sourceUrl: claim.sourceUrl,
      sourceKind: claim.primarySource ? 'PRIMARY' : 'SECONDARY',
      observedAt: claimObservedAt(claim),
    });
    if (!recorded) return;
    out.filed.push(recorded);
    await recordCashEvent({
      projectId,
      kind: 'INDUSTRY_FACT_ABSORBED',
      actorRef: 'BRAIN',
      summary: `${input.key} for ${buyer.name} back-filed from an existing claim as ${recorded.status.toLowerCase()}.`,
      detail: { factId: recorded.id, claimId: claim.id, key: input.key, segment: recorded.segment, status: recorded.status, nodeId: buyer.id, backfill: true, observedAt: recorded.observedAt ?? null, validUntil: recorded.validUntil ?? null },
    });
  };
  const consume = async (decision: BackfillDecision): Promise<void> => {
    if (decision.candidate) await fileOne(decision.candidate);
    else if (decision.countsAsSkipped) out.skipped += 1;
  };

  // 1. Declared unit economics outside any open round, from where the last pass stopped.
  const declared = await unfiledUnitEconomicClaims(projectId, unitEconomicCursor.get(projectId) ?? '', BACKFILL_SCAN);
  const population = await askedPopulations(projectId, declared, nodes);
  let reached = '';
  for (const claim of declared) {
    if (room() <= 0) break;
    reached = claim.id;
    const asked = population.get(claim.id);
    if (!hasBuyerTypes && !asked) continue;
    await consume(judgeUnitEconomic(claim, nodes, asked));
  }
  // Everything read: start over next pass (a buyer added since may now match). Otherwise resume after the last one read.
  unitEconomicCursor.set(projectId, reached === declared[declared.length - 1]?.id && declared.length < BACKFILL_SCAN ? '' : reached);
  if (!hasBuyerTypes) return out;

  // 2. Prices and costs cards hold as evidence, for payers the map names.
  if (room() > 0) {
    for (const decision of await cardEvidenceDecisions(projectId, nodes)) {
      if (room() <= 0) break;
      await consume(decision);
    }
  }
  limit = batch;
  if (room() <= 0) return out;

  // 3. Per-unit prices a constructed-arrangement round found, for its own buyers, settled or not.
  const asked = await unfiledConstructedRoundClaims(projectId, constructedCursor.get(projectId) ?? '', BACKFILL_SCAN);
  let last = '';
  for (const decision of await constructedRoundDecisions(projectId, nodes, asked)) {
    if (room() <= 0) break;
    last = decision.claimId ?? last;
    await consume(decision);
  }
  // Everything read: start over next pass (an arrangement mapped since may now match). Otherwise resume after the last one read.
  constructedCursor.set(projectId, last === asked[asked.length - 1]?.claim.id && asked.length < BACKFILL_SCAN ? '' : last);
  return out;
}

/* ------------------------------------------------- priced payers on the map */

/** Buyer populations one pass adds to the map from priced openings, at most. */
export const PAYER_NODES_PER_PASS = 10;
/** The sector a priced payer is filed under when its opening names no industry. */
export const UNCLASSIFIED_SECTOR = 'Unclassified';
/** Node kinds an opening's industry may name as the part of the economy a buyer sits in. */
const SECTOR_KINDS: ReadonlySet<string> = new Set(['SECTOR', 'SUB_INDUSTRY', 'ADJACENT_INDUSTRY', 'VALUE_CHAIN_LAYER']);

export interface MappedPayers {
  /** Buyer-type nodes this pass created, in order. */
  created: IndustryNode[];
  /** Openings whose mapping failed, with why; one never stops the others. */
  failures: string[];
}

/**
 * Put the payers of priced openings on the map as buyer populations
 * (2026-11-15). Production: construction_facts stayed 0 after the F3
 * back-fill, because it files a card's price only against a payer the map
 * already names, and the map held 11 buyer types while 49 priced openings
 * named organisations none of them were.
 *
 * An opening qualifies when it is in USD, its payer is EVIDENCE (a gated,
 * sourced claim), its price or direct cost is EVIDENCE with a positive USD
 * figure not yet filed as a fact, and its payer — by name or by the population
 * `buyerPopulationName` puts it in — matches no live buyer type. It becomes a
 * DISCOVERED `BUYER_TYPE` under the sector node its industry names (an
 * existing one first, else a root SECTOR of that name, else
 * `UNCLASSIFIED_SECTOR`), established by the payer claim; repeated payers of
 * one population are one node. `backfillClaimFacts` then files the price
 * against it, on the same pass or the next.
 *
 * Absorbing, not discovery: no research is opened. Bounded
 * (`PAYER_NODES_PER_PASS`), idempotent (a mapped payer matches next time, and
 * `createNode` is unique by parent and name), and one opening that fails is
 * recorded and never stops the others.
 */
export async function mapPricedPayers(projectId: string, limit = PAYER_NODES_PER_PASS): Promise<MappedPayers> {
  const out: MappedPayers = { created: [], failures: [] };
  const facts = (await cardFactsForProject(projectId)).filter((one) => one.kind === 'EVIDENCE' && one.claimId);
  const priceFacts = facts.filter((one) => BACKFILL_FIELDS[one.field]);
  if (priceFacts.length === 0) return out;
  const filed = new Set((await listProjectFacts(projectId)).map((one) => one.sourceClaimId).filter((id): id is string => !!id));
  const payerClaim = new Map(facts.filter((one) => one.field === 'payer').map((one) => [one.opportunityId, one.claimId!]));
  const unfiledPrice = new Map<string, string[]>();
  for (const fact of priceFacts) {
    if (filed.has(fact.claimId!) || !payerClaim.has(fact.opportunityId)) continue;
    unfiledPrice.set(fact.opportunityId, [...(unfiledPrice.get(fact.opportunityId) ?? []), fact.claimId!]);
  }
  if (unfiledPrice.size === 0) return out;
  const openings = (await listOpportunities({ projectId }))
    .filter((one) => unfiledPrice.has(one.id) && one.payer && !one.duplicateOfId && (one.currency ?? '').toUpperCase() === 'USD')
    .sort((a, b) => a.id.localeCompare(b.id));
  if (openings.length === 0) return out;
  const nodes = await listNodes(projectId);
  const pending = openings.filter((one) => !payerBuyerType(one.payer!, nodes) && buyerPopulationName(one.payer));
  if (pending.length === 0) return out;
  const claims = new Map(
    (await claimsByIds([...new Set(pending.flatMap((one) => [payerClaim.get(one.id)!, ...unfiledPrice.get(one.id)!]))])).map((one) => [one.id, one]),
  );
  const gated = (id: string | undefined): ResearchClaim | null => {
    const claim = id ? claims.get(id) : undefined;
    return claim && claim.accepted && claim.sourceUrl ? claim : null;
  };

  for (const opening of pending) {
    if (out.created.length >= limit) break;
    try {
      // An earlier payer this pass may already have mapped this one's population.
      if (payerBuyerType(opening.payer!, nodes)) continue;
      const population = buyerPopulationName(opening.payer)!;
      const payer = gated(payerClaim.get(opening.id));
      const price = unfiledPrice
        .get(opening.id)!
        .map(gated)
        .find((claim) => claim && readMoneyFigures(claim.claim, 'USD').some((one) => one.cents > 0));
      if (!payer || !price) continue;
      const made = await mapPayerPopulation(projectId, { id: opening.id, payer: opening.payer!, industry: opening.industry }, population, payer.id, price.id, nodes);
      if (made.created) out.created.push(made.node);
    } catch (error) {
      out.failures.push(`${opening.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/**
 * Put one priced opening's payer population on the map: a DISCOVERED
 * `BUYER_TYPE` under the sector its industry names, established by the payer
 * claim, with an `INDUSTRY_BUYER_MAPPED` event when it is new. The one way a
 * payer becomes a buyer node — `mapPricedPayers` and the back-fill both call
 * it. Unique by parent and name, so a replay creates nothing; `nodes` is
 * extended in place.
 */
async function mapPayerPopulation(
  projectId: string,
  opening: PricedOpening,
  population: string,
  payerClaimId: string,
  priceClaimId: string,
  nodes: IndustryNode[],
): Promise<{ node: IndustryNode; created: boolean }> {
  const parent = await sectorFor(projectId, opening.industry, nodes, payerClaimId);
  const made = await createNode({
    projectId,
    parentId: parent.id,
    kind: 'BUYER_TYPE',
    name: population,
    description: `Payer of priced opening ${opening.id} ("${opening.payer.slice(0, 120)}"), established by claim ${payerClaimId}; priced by claim ${priceClaimId}.`,
    origin: 'DISCOVERED',
    sourceClaimId: payerClaimId,
  });
  if (!nodes.some((one) => one.id === made.node.id)) nodes.push(made.node);
  if (made.created) {
    await recordCashEvent({
      projectId,
      opportunityId: opening.id,
      kind: 'INDUSTRY_BUYER_MAPPED',
      actorRef: 'BRAIN',
      summary: `Buyer population "${population}" added to the map under "${parent.name}" from the priced payer "${opening.payer.slice(0, 120)}".`,
      detail: { nodeId: made.node.id, parentId: parent.id, payer: opening.payer, payerClaimId, priceClaimId, opportunityId: opening.id },
    });
  }
  return { node: made.node, created: made.created };
}

/**
 * Put the population a goal's price question asked about on the map, from an
 * accepted, sourced answer to that question (`judgeUnitEconomic` holds the
 * gates): a DISCOVERED `BUYER_TYPE` named exactly as the construction named
 * the buyers, under the sector its opening's industry names (else
 * `UNCLASSIFIED_SECTOR`), established by that claim — the `mapPayerPopulation`
 * precedent, with the question's population in place of an opening's payer.
 * Only a name `namesABuyerPopulation` accepts is mapped, so no population is
 * invented from a record field or a sentence. Unique by parent and name;
 * `nodes` is extended in place.
 */
async function mapAskedPopulation(projectId: string, asked: AskedPopulation, claimId: string, nodes: IndustryNode[]): Promise<IndustryNode | null> {
  const name = asked.name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!namesABuyerPopulation(name)) return null;
  // Mapped only when the plan would read a fact filed against it for these buyers: a node nothing reads is not created.
  const probe = { id: '', parentId: null, kind: 'BUYER_TYPE', name, retiredAt: null, createdAt: '' } as unknown as IndustryNode;
  if (!planBuyerType(asked.name, [probe])) return null;
  const parent = await sectorFor(projectId, asked.industry, nodes, claimId);
  const made = await createNode({
    projectId,
    parentId: parent.id,
    kind: 'BUYER_TYPE',
    name,
    description: `Buyers Brain asked the price of (graph price:${asked.ref.slice(0, 120)}), established by the accepted answer ${claimId}.`,
    origin: 'DISCOVERED',
    sourceClaimId: claimId,
  });
  if (!nodes.some((one) => one.id === made.node.id)) nodes.push(made.node);
  if (made.created) {
    await recordCashEvent({
      projectId,
      opportunityId: asked.opportunityId,
      kind: 'INDUSTRY_BUYER_MAPPED',
      actorRef: 'BRAIN',
      summary: `Buyer population "${made.node.name}" added to the map under "${parent.name}" from an accepted answer to Brain's price question about it.`,
      detail: { nodeId: made.node.id, parentId: parent.id, population: asked.ref, priceClaimId: claimId, opportunityId: asked.opportunityId },
    });
  }
  // The plan reads a `map_<node>` fact only from a node it would match to these buyers; anything else is not filed.
  return planBuyerType(asked.name, nodes);
}

/** The live sector node an opening's industry names, else a root SECTOR of that name (or `UNCLASSIFIED_SECTOR`), created once. */
async function sectorFor(projectId: string, industry: string | null, nodes: IndustryNode[], claimId: string): Promise<IndustryNode> {
  const name = (industry ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || UNCLASSIFIED_SECTOR;
  const key = buyerNameKey(name);
  const named = nodes
    .filter((one) => !one.retiredAt && SECTOR_KINDS.has(one.kind) && buyerNameKey(one.name) === key)
    .sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null) || a.createdAt.localeCompare(b.createdAt));
  if (named[0]) return named[0];
  const made = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'DISCOVERED', sourceClaimId: claimId });
  if (!nodes.some((one) => one.id === made.node.id)) nodes.push(made.node);
  return made.node;
}
