/**
 * One project's industry kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass: a hook fixes one
 * entrance and a derivation reaches every entrance plus everything already
 * stranded. A tick that dies halfway leaves rows the next one reads correctly,
 * and two instances running it produce one round, because the arbiter is a
 * unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * Two authorities, and each one's off switch stops only its own rounds
 * ---------------------------------------------------------------------------
 *
 * Growing Brain's map of the economy is a standing capability, not a cash
 * sprint's (W-1, docs/INTELLIGENCE-RECOVERY-2026-11-14.md). So a pass runs
 * under one of two authorities:
 *
 * - **SPRINT** — an ACTIVE Cash Mode sprint. Its rounds are filed under the
 *   sprint, carry its objective, ask every purpose, and stop when a person
 *   winds the sprint down (`launchableUnderCashMode`).
 * - **STANDING** — no active sprint, and a live standing research grant other
 *   than the sprint's own (§80's grant shape). Its rounds are filed with no
 *   sprint (`cash_mode_id` NULL, migration 150), carry the neutral standing
 *   context line, and ask only the structural questions (BOOTSTRAP and MAP):
 *   an opening search files openings into a sprint's portfolio, and there is
 *   none. Revoking or letting that grant expire is what stops it. The sprint's
 *   own grant never counts here, because a person winding the sprint down has
 *   said to stop the discovery that grant carried. It runs only in a project
 *   that already holds economic work — a sprint row, a map, or a live money
 *   goal — so a grant given for something else never starts mapping the economy.
 *
 * Absorbing runs whatever the authority says: filing what research already
 * found is not new discovery, the spending happened when it ran.
 *
 * ---------------------------------------------------------------------------
 * Bounded by concurrency and by database pressure, and by nothing else
 * ---------------------------------------------------------------------------
 *
 * There is no lifetime quota (§24). How many questions may be open at once is
 * `kernelConcurrency`: a floor plus the research surfaces sitting idle,
 * capped by the grant the rounds launch under. Under database pressure (§63)
 * the sprint kernel keeps running, as the tick has always let it, and the
 * standing kernel opens nothing: it is optional work whose output nobody is
 * waiting on this minute. The pressure reading is read here, never changed.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import {
  countLiveNodes,
  listCapitalForProject,
  openIndustryRoundsByCandidate,
} from '../../repos/industry.ts';
import { listGoals, liveGoalNamed } from '../../repos/russellAuthority.ts';
import { listWorkstreams } from '../../repos/register.ts';
import { databasePressure } from '../../db/pressure.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { CASH_DISCOVERY_AUTHORITY_NAME } from '../cash/discoveryAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../russell/launch.ts';
import {
  allocate,
  kernelConcurrency,
  NO_SIGNALS,
  type Ask,
  type SubjectSignals,
} from './allocate.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { graphSnapshot, type GraphSnapshot } from './graph.ts';
import type { CashMode, IndustryRoundPurpose, RussellGoal } from '../../domain/types.ts';
import type { Workstream } from '../../domain/register.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  /** The map as it stood when the decision was made. */
  nodes: number;
  openRounds: number;
  /** Which authority this pass ran under; null when none allowed opening. */
  basis?: KernelBasis | null;
  /** The asks chosen, with their score parts, before they were opened. */
  asks?: Ask[];
  /** §82 transfer asks chosen this pass (W-8): a held precedent's design carried to another population. */
  transfers?: Ask[];
  /** What failed this pass, in words. A failure in one step no longer stops the others. */
  failures?: string[];
}

export type KernelBasis = 'SPRINT' | 'STANDING';

/** What may open kernel rounds in a project, and under whose name. */
export interface KernelAuthority {
  allowed: boolean;
  basis: KernelBasis | null;
  /** The sprint row rounds are filed under; null under the standing grant. */
  cashModeId: string | null;
  /** The sprint's objective; null under the standing grant (neutral wording). */
  objective: string | null;
  /** The concurrency of the grant the rounds launch under; null when unknown. */
  grantCap: number | null;
  /** Which purposes this authority asks. */
  purposes: readonly IndustryRoundPurpose[] | undefined;
  /** In words, always naming what would change the answer. */
  reason: string;
}

/** The structural questions: all the standing authority asks. */
export const STANDING_PURPOSES: readonly IndustryRoundPurpose[] = Object.freeze(['BOOTSTRAP', 'MAP']);

const NOTHING_ABSORBED: Absorbed = { nodes: [], constraints: [], capital: [], settled: [], refused: [] };

const EMPTY: KernelPass = {
  opened: [],
  absorbed: NOTHING_ABSORBED,
  declined: [],
  nodes: 0,
  openRounds: 0,
  basis: null,
};

/**
 * The live standing research grant the world map may run under: STANDING,
 * ACTIVE, started, unexpired, allowing RESEARCH, and not the sprint's own.
 */
export function standingWorldGrant(goals: readonly RussellGoal[], now: string): RussellGoal | null {
  return (
    goals.find(
      (goal) =>
        (goal.purpose ?? 'STANDING') === 'STANDING' &&
        goal.state === 'ACTIVE' &&
        goal.startsAt <= now &&
        (!goal.expiresAt || goal.expiresAt > now) &&
        goal.allowedWork.includes(RESEARCH_WORK_CLASS) &&
        goal.name !== CASH_DISCOVERY_AUTHORITY_NAME,
    ) ?? null
  );
}

/** Whether a goal is live: not archived, cancelled or paused. */
function liveGoal(goal: Workstream): boolean {
  return !goal.archivedAt && !goal.cancelledAt && !goal.pausedAt;
}

/**
 * Which authority, if any, may open kernel rounds in this project now.
 *
 * `mode` and `goals` may be passed by a caller that has already read them.
 */
export async function kernelAuthority(
  projectId: string,
  input: { mode?: CashMode | null; now?: string } = {},
): Promise<KernelAuthority> {
  const now = input.now ?? new Date().toISOString();
  const mode = input.mode !== undefined ? input.mode : await getCashMode(projectId);
  if (mode?.state === 'ACTIVE') {
    const grant = await liveGoalNamed(projectId, CASH_DISCOVERY_AUTHORITY_NAME);
    return {
      allowed: true,
      basis: 'SPRINT',
      cashModeId: mode.id,
      objective: mode.objective,
      grantCap: grant?.maxConcurrent ?? null,
      purposes: undefined,
      reason: 'Cash Mode is active.',
    };
  }
  const grant = standingWorldGrant(await listGoals(projectId), now);
  if (!grant) {
    const sprint = mode ? `${(await discoveryAllowed(projectId)).reason} ` : '';
    return {
      allowed: false,
      basis: null,
      cashModeId: null,
      objective: null,
      grantCap: null,
      purposes: undefined,
      reason:
        `${sprint}No standing research grant other than the sprint's own is live, so nothing may be ` +
        'spent mapping the economy here; a person granting one resumes it.',
    };
  }
  return {
    allowed: true,
    basis: 'STANDING',
    cashModeId: null,
    objective: null,
    grantCap: grant.maxConcurrent,
    purposes: STANDING_PURPOSES,
    reason: `The standing research grant "${grant.name}" (${grant.id}) authorizes growing the map with no sprint.`,
  };
}

export async function runIndustryKernel(projectId: string): Promise<KernelPass> {
  const mode = await getCashMode(projectId);
  /*
   * Cheap for the many projects with no economic work at all: no sprint row,
   * no map, no round still to absorb, and no standing grant over a money goal.
   */
  if (!mode) {
    const grant = standingWorldGrant(await listGoals(projectId), new Date().toISOString());
    const nothingToAbsorb = async () => (await openIndustryRoundsByCandidate(projectId)).size === 0;
    if (!grant) {
      // Two reads for the ordinary project: no sprint, no grant, nothing still running.
      if (await nothingToAbsorb()) return EMPTY;
    } else if ((await countLiveNodes(projectId)) === 0 && !(await holdsMoneyGoal(projectId)) && (await nothingToAbsorb())) {
      return EMPTY;
    }
  }

  /*
   * Absorb first, deliberately: what a settled round filed changes what the
   * allocator sees, and allocating first would make every discovery a tick late.
   * A finding that will not absorb must not stop the map growing (2026-11-02).
   */
  const failures: string[] = [];
  let absorbed: Absorbed;
  try {
    absorbed = await absorb({ projectId });
  } catch (error) {
    failures.push(`absorb: ${error instanceof Error ? error.message : String(error)}`);
    absorbed = NOTHING_ABSORBED;
  }

  const snapshot = await graphSnapshot(projectId);
  const counts = {
    nodes: snapshot.nodes.filter((one) => one.retiredAt === null).length,
    openRounds: snapshot.rounds.filter((one) => one.state === 'OPEN').length,
  };
  const authority = await kernelAuthority(projectId, { mode });
  if (!authority.allowed) {
    return {
      opened: [],
      absorbed,
      declined: [{ subject: 'every subject on the map', why: authority.reason }],
      ...counts,
      basis: null,
      failures,
    };
  }
  if (authority.basis === 'STANDING') {
    if (!mode && counts.nodes === 0 && !(await holdsMoneyGoal(projectId))) {
      return { ...EMPTY, absorbed, ...counts, failures };
    }
    if (databasePressure().state === 'SHEDDING') {
      return {
        opened: [],
        absorbed,
        declined: [
          {
            subject: 'every subject on the map',
            why:
              'The database is shedding optional work (§63), and the standing map is optional: ' +
              'it opens again on the first tick at NORMAL.',
          },
        ],
        ...counts,
        basis: 'STANDING',
        failures,
      };
    }
  }

  const cap = kernelConcurrency({ spare: await spareSurfaces(projectId), grantCap: authority.grantCap });
  const plan = await planFrom(snapshot, { cap, purposes: authority.purposes });
  /*
   * The §82 transfer (W-8), under either authority and with no live goal: a
   * design a held opening shows working, carried to a buyer population on the
   * map that is not its own, asked as a hypothesis. In the slots the plan
   * leaves free; while none is open, one slot is held for one, taken from the
   * plan's lowest-ranked ask — the same reservation role questions get.
   */
  let planned = plan.asks;
  let transfers: Ask[] = [];
  try {
    const { precedentsIn, transferAsks, transferOfBucket } = await import('./transfer.ts');
    const precedents = await precedentsIn(snapshot);
    if (precedents.length > 0) {
      const free = cap - counts.openRounds - planned.length;
      const transferOpen = snapshot.rounds.some((one) => one.state === 'OPEN' && transferOfBucket(one.bucketId) !== null);
      const reserve = !transferOpen && free <= 0 && planned.length >= 2 && counts.openRounds + 1 <= cap;
      transfers = transferAsks({ snapshot, precedents, limit: reserve ? 1 : free });
      if (reserve && transfers.length > 0) planned = planned.slice(0, Math.max(0, cap - counts.openRounds - 1));
    }
  } catch (error) {
    failures.push(`transfer: ${error instanceof Error ? error.message : String(error)}`);
  }
  let opened: OpenedRound[] = [];
  try {
    opened = await openAsks({
      projectId,
      asks: [...transfers, ...planned],
      snapshot,
      filing: { cashModeId: authority.cashModeId, objective: authority.objective },
      cap,
    });
  } catch (error) {
    failures.push(`open: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    opened,
    absorbed,
    declined: plan.declined,
    ...counts,
    basis: authority.basis,
    asks: planned,
    transfers,
    failures,
  };
}

/**
 * The allocation for one snapshot, with the free slots counted from it.
 *
 * Exported separately from the pass that acts on it so that a person — or a
 * test — can ask *what would Brain do next* without anything being created.
 * The signals (goals reaching each subject, unpriced positions) are read here
 * so the plan a person reads is the plan the pass would make.
 */
export async function planFrom(
  snapshot: GraphSnapshot,
  options: { cap?: number; purposes?: readonly IndustryRoundPurpose[]; signals?: SubjectSignals } = {},
): Promise<{ asks: Ask[]; declined: { subject: string; why: string }[] }> {
  const openRounds = snapshot.rounds.filter((one) => one.state === 'OPEN').length;
  const capital = await listCapitalForProject(snapshot.projectId);
  const cap = options.cap ?? kernelConcurrency({ spare: 0, grantCap: null });
  return allocate({
    snapshot,
    slots: Math.max(0, cap - openRounds),
    capitalDecomposed: new Set(capital.map((one) => one.opportunityId)),
    signals: options.signals ?? (await subjectSignals(snapshot)),
    purposes: options.purposes,
  });
}

/** Idle research surfaces this project may use; null when unreadable (lifts nothing). */
async function spareSurfaces(projectId: string): Promise<number | null> {
  try {
    const { cashSpareSurfaces } = await import('../cash/researchRoom.ts');
    return await cashSpareSurfaces(projectId);
  } catch {
    return null;
  }
}

async function holdsMoneyGoal(projectId: string): Promise<boolean> {
  const goals = await listWorkstreams({ projectIds: [projectId] });
  return goals.some((goal) => goal.projectId === projectId && liveGoal(goal) && goal.target !== null);
}

/**
 * What the allocator reads beside the snapshot: which live goals reach each
 * subject, and how many facts leave the positions in each subject's subtree
 * unpriced. A failure reads as no signal — never as a favourable one.
 */
export async function subjectSignals(snapshot: GraphSnapshot): Promise<SubjectSignals> {
  if (snapshot.nodes.length === 0) return NO_SIGNALS;
  const goalsReaching = new Map<string, number>();
  const goalReachedAt = new Map<string, string>();
  try {
    const { interpretIntent } = await import('./construction/intent.ts');
    const { subtreeFor } = await import('./construction/service.ts');
    const goals = (await listWorkstreams({ projectIds: [snapshot.projectId] })).filter(
      (goal) => goal.projectId === snapshot.projectId && liveGoal(goal),
    );
    for (const goal of goals) {
      const text = [goal.title, goal.intent, goal.outcome].filter(Boolean).join(' ');
      const industry = interpretIntent(text).industry;
      for (const node of subtreeFor(snapshot.nodes, industry)) {
        goalsReaching.set(node.id, (goalsReaching.get(node.id) ?? 0) + 1);
        const held = goalReachedAt.get(node.id);
        if (!held || goal.createdAt > held) goalReachedAt.set(node.id, goal.createdAt);
      }
    }
  } catch {
    /* no goal signal */
  }
  return { goalsReaching, goalReachedAt, unpriced: await unpricedBySubject(snapshot) };
}

/**
 * Distinct unpriced fact keys over the open positions of each root's subtree,
 * credited to every subject in it. The construction engine is pure but not
 * cheap, so the reading is kept until the map, its constraints or its openings
 * change.
 */
async function unpricedBySubject(snapshot: GraphSnapshot): Promise<Map<string, number>> {
  const fingerprint = [
    snapshot.nodes.length,
    snapshot.nodes.reduce((newest, one) => (one.updatedAt > newest ? one.updatedAt : newest), ''),
    snapshot.constraints.length,
    snapshot.opportunities.length,
  ].join('|');
  const held = unpricedMemo.get(snapshot.projectId);
  if (held && held.fingerprint === fingerprint) return held.reading;
  const reading = new Map<string, number>();
  try {
    const { assembleEvidence, evidenceFromMap, subtreeFor } = await import('./construction/service.ts');
    const { heldFromRows, openWorld } = await import('./construction/openWorld.ts');
    const records = heldFromRows(snapshot.nodes, snapshot.opportunities);
    const roots = snapshot.nodes.filter((one) => one.parentId === null && one.retiredAt === null);
    for (const root of roots) {
      const subtree = subtreeFor(snapshot.nodes, root.name);
      const map = evidenceFromMap(subtree, snapshot.constraints);
      if (map.flows.length === 0) continue;
      const evidence = assembleEvidence({ text: root.name, industry: root.name, geography: null, map, recorded: [] });
      const keys = new Set<string>();
      for (const one of openWorld(evidence, records).arrangements) for (const key of one.unpriced) keys.add(key);
      for (const node of subtree) reading.set(node.id, Math.max(reading.get(node.id) ?? 0, keys.size));
    }
  } catch {
    /* no pricing signal */
  }
  unpricedMemo.set(snapshot.projectId, { fingerprint, reading });
  return reading;
}
const unpricedMemo = new Map<string, { fingerprint: string; reading: Map<string, number> }>();
