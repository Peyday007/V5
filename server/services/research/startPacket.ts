/**
 * Starting a research packet, from anywhere.
 *
 * This existed as thirty lines inside an operator route, which made it look
 * like a console feature. It is not. Starting a packet is the moment a goal
 * becomes work the Brain will carry out, and the console is only the first
 * caller of it — a scheduler, an agent turn or the Brain's own decider are the
 * others, and none of them has a `Request` or an HTML page to render.
 *
 * So the shape here is deliberately not the route's shape. It takes a goal, a
 * target, who is starting it and under what authority; it returns rows and a
 * census. It renders nothing, it reads no headers, and it never decides who is
 * allowed to call it — that decision belongs to the caller's own boundary,
 * which has already made it by the time it gets here.
 *
 * Two things it does that the route did not:
 *
 *   1. It takes the approval policy as an argument instead of hard-coding
 *      "a person approves this one". §16 is a rule about *approval*, and the
 *      unit approval applies to is a decision, not a constant.
 *
 *   2. It reads the archive before it creates anything. §13 says the default
 *      is not to research, and a caller that cannot see what the project
 *      already holds cannot honour that default. The census is mechanical —
 *      no provider, no model, nothing spent.
 */
import type {
  Layer,
  Project,
  ResearchOrchestration,
  ResearchRun,
} from '../../domain/types.ts';
import { getProject } from '../../repos/projects.ts';
import { listLayers } from '../../repos/layers.ts';
import { createRun } from '../../repos/runs.ts';
import { createOrchestration } from '../../repos/research.ts';
import { runTypeForNewPacket } from '../runArtifacts.ts';
import { inventoryProject } from '../reconcile/plan.ts';
import { listMembershipsForProject } from '../../repos/identity.ts';
import { workType } from '../queue/workTypes.ts';
import { advancePacket, type AdvanceResult } from './packetRunner.ts';

/**
 * How much research this goal is authorized to consume.
 *
 * Every field is a ceiling rather than a target: authorization to run five
 * packets is not an instruction to run five. Nothing enforces these yet — see
 * `SUPPORTED_APPROVAL_MODES` below, and `docs/ROADMAP.md` for where the
 * enforcement is scheduled — and the type exists now so that the decision
 * about approval can be recorded in one place instead of being rediscovered by
 * each caller.
 */
export interface ResearchBudget {
  /** How many packets this goal may produce. */
  maxPackets: number | null;
  /** How many fragments in total across all of them. */
  maxFragments: number | null;
  /** ISO-8601 instant after which no further work may be created. */
  deadline: string | null;
  /**
   * Money the Brain may spend outside the connected allowance, in cents.
   *
   * Not a number a caller chooses. It is zero, and it is in the type so that a
   * future non-zero value has to be introduced deliberately rather than by an
   * omitted field defaulting to something.
   */
  externalSpendCents: 0;
  /**
   * Whether metered overages beyond the connected allowance are permitted.
   *
   * False, and only a person may make it true — never a policy, a default or a
   * caller. §16 and invariant 18.
   */
  paidOveragesEnabled: false;
}

/**
 * Who has approved what, before anything is researched.
 *
 * PER_PACKET is the rule the console has always followed: the packet is planned
 * in full, and a person reads the plan and approves it before a fragment is
 * researched. The approval is about this packet.
 *
 * GOAL_BUDGET is the rule the Brain needs to be autonomous: a person approves
 * the goal, its boundaries, its source requirements and how much research
 * effort it may consume, and the Brain then creates and dispatches whatever
 * packets that goal needs without asking again for each one. The approval is
 * about the goal.
 *
 * The difference is which risk is being controlled. PER_PACKET controls
 * *scope* — a person sees each decomposition before it is researched.
 * GOAL_BUDGET controls *spend* — a person sets a ceiling once and the
 * decomposition is trusted to the gate. Neither one lowers the evidence bar,
 * and neither one is a route around §16: something authorized this, and the
 * row says which.
 */
export type ApprovalPolicy =
  | { mode: 'PER_PACKET' }
  | { mode: 'GOAL_BUDGET'; goalId: string; budget: ResearchBudget };

/**
 * The modes `startPacket` will actually act on today.
 *
 * GOAL_BUDGET is deliberately absent. Accepting it would mean setting
 * `autoApprove` and letting the packet research itself, and nothing in the
 * Brain yet counts packets, counts fragments or watches a deadline — so the
 * budget half of the authorization would be decorative while the approval half
 * took effect. A ceiling nothing enforces is worse than no ceiling, because
 * the person who set it believes they have one.
 *
 * The parameter is here now so that the decision has one home when the counter
 * arrives. Until then this refuses, by name, with the reason.
 */
export const SUPPORTED_APPROVAL_MODES: ApprovalPolicy['mode'][] = ['PER_PACKET'];

export class ApprovalModeUnavailable extends Error {
  constructor(readonly mode: ApprovalPolicy['mode']) {
    super(
      `The "${mode}" approval mode is not enforceable yet: nothing in the Brain counts packets, ` +
        'counts fragments or watches a deadline, so its budget would not be a limit. Start this ' +
        'packet with per-packet approval, or implement budget accounting first.',
    );
    this.name = 'ApprovalModeUnavailable';
  }
}

export class NoSuchTarget extends Error {
  constructor() {
    // One message for a project that is not there and a layer that is not
    // there, because from outside they are the same fact and invariant 23 does
    // not stop applying because the caller is in-process.
    super('No such layer.');
    this.name = 'NoSuchTarget';
  }
}

export class GoalIncomplete extends Error {
  constructor(what: string) {
    super(`A packet needs ${what}.`);
    this.name = 'GoalIncomplete';
  }
}

/**
 * What the project already holds, before this packet adds anything.
 *
 * Recorded rather than acted on. The decision it feeds — which of the goal's
 * requirements the archive already answers — cannot be made until the goal has
 * been decomposed into requirements, which is the planning pass. What can be
 * said here, cheaply and truthfully, is how much there is to reconcile
 * against, and whether any of it is unreadable: a project whose documents
 * cannot be read has an archive that will answer nothing, and a packet started
 * against it will research things the project may well already know.
 */
export interface ArchiveCensus {
  claims: number;
  documentsRead: number;
  documentsUnreadable: number;
}

/**
 * Whether anybody can actually do the work this packet just queued.
 *
 * The queue's refusals are correct and silent by design: a worker sees only
 * projects it is a member of, and a project it may not have is *absent* rather
 * than refused (invariant 23). That is the right trade at the boundary and it
 * has one cost — from the worker's side, "there is no work" and "that work is
 * not yours" are the same sentence.
 *
 * So the honest place to say it is here, where the work is created and the
 * memberships are readable. A packet queued into a project no connected worker
 * belongs to is not queued; it is parked, and nothing downstream will ever say
 * so. Reported rather than refused: creating work before granting access is a
 * legitimate order to do things in, as long as somebody is told.
 */
export interface ClaimantCensus {
  /** Workers with an active membership on this project. */
  workers: number;
  /** Of those, the ones holding every scope the queued work requires. */
  eligible: number;
}

export interface StartPacketInput {
  projectId: string;
  layerId: string;
  title: string;
  assignment: string;
  /** How this packet came to be authorized. */
  approval: ApprovalPolicy;
  /**
   * The principal that started it, for the caller's own audit row.
   *
   * Carried rather than used: `startPacket` performs no authorization, and a
   * caller that has not already made that decision must not reach here.
   */
  startedBy?: { kind: 'PERSON' | 'BRAIN'; id: string } | undefined;
}

export interface StartPacketResult {
  project: Project;
  layer: Layer;
  run: ResearchRun;
  orchestration: ResearchOrchestration;
  advanced: AdvanceResult;
  archive: ArchiveCensus;
  claimants: ClaimantCensus;
}

/**
 * Create the run and the orchestration, and queue exactly one planning job.
 *
 * The one thing this must not do is start researching. §16 is explicit that a
 * run a person initiated is planned in full and then stops before anything is
 * spent, and the temptation is a single extra call — advance straight through
 * PLANNING — which would spend the allowance on a decomposition nobody had
 * seen.
 */
export async function startPacket(input: StartPacketInput): Promise<StartPacketResult> {
  if (!SUPPORTED_APPROVAL_MODES.includes(input.approval.mode)) {
    throw new ApprovalModeUnavailable(input.approval.mode);
  }

  const title = input.title.trim();
  const assignment = input.assignment.trim();
  if (!title || !assignment) throw new GoalIncomplete('a title and an assignment');

  if (!input.projectId || !input.layerId) throw new NoSuchTarget();
  const project = await getProject(input.projectId);
  if (!project) throw new NoSuchTarget();
  const layer = (await listLayers(project.id)).find((candidate) => candidate.id === input.layerId);
  if (!layer) throw new NoSuchTarget();

  // Before anything is created. Reading the archive after queueing the plan
  // would still be reading it, but it would no longer be able to inform
  // whether the packet should exist.
  const inventory = await inventoryProject(project.id);
  const archive: ArchiveCensus = {
    claims: inventory.claims.length,
    documentsRead: inventory.documentsRead,
    documentsUnreadable: inventory.documentsUnreadable,
  };

  // The run is the assignment Brain issued, and the orchestration is how it
  // gets carried out. A run always exists — that is what lets an artifact
  // filed by a worker land through exactly the path a hand-uploaded report
  // does, with the same naming, the same versioning and the same lineage.
  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    // The run type describes what the work is *for* the layer, and a packet
    // researched by a worker is the same kind of contribution as one
    // researched in process. It is not always FOUNDATION, though: that targets
    // v1 by definition, so a second packet on a layer that already has a
    // document would be declined by the importer as a duplicate.
    runType: await runTypeForNewPacket(layer.id),
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: assignment,
  });

  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title,
    assignment,
    provider: 'WORKER',
    // Under PER_PACKET nothing about this packet runs without a person, which
    // is what the flag means. It is not a preference; it is the §16 gate, and
    // it is false here because that is what the policy said rather than
    // because it is the only value the column has ever held.
    autoApprove: input.approval.mode !== 'PER_PACKET',
  });

  const advanced = await advancePacket(orchestration.id);

  return {
    project,
    layer,
    run,
    orchestration,
    advanced,
    archive,
    claimants: await countClaimants(project.id, advanced),
  };
}

/** How many connected workers could actually claim what was just queued. */
async function countClaimants(
  projectId: string,
  advanced: AdvanceResult,
): Promise<ClaimantCensus> {
  const memberships = (await listMembershipsForProject(projectId)).filter(
    (membership) => membership.principalType === 'WORKER' && membership.active,
  );

  // The scopes the work that was actually queued demands, from the registry
  // rather than from a list here — a work type whose scopes change must not
  // leave this check quietly answering the old question.
  const required = new Set<string>();
  for (const entry of advanced.enqueued) {
    for (const scope of workType(entry.workType).requiredScopes) required.add(scope);
  }

  const eligible = memberships.filter((membership) =>
    [...required].every((scope) => membership.scopes.includes(scope as never)),
  );
  return { workers: memberships.length, eligible: eligible.length };
}
