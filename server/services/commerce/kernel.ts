/**
 * One project's commerce kernel step, for the tick.
 *
 * ---------------------------------------------------------------------------
 * Derived on the tick, never hooked to a moment
 * ---------------------------------------------------------------------------
 *
 * Everything here is re-derived from rows on every pass, which is the sixth
 * time this repository has needed that distinction: a hook fixes one entrance
 * and a derivation reaches every entrance plus everything already stranded. A
 * sprint activated before this kernel existed gets a channel map on the next
 * tick with nobody pressing anything; a tick that dies halfway leaves rows the
 * next one reads correctly; and two instances running it produce one round,
 * because the arbiter is a unique index rather than a check-then-write.
 *
 * ---------------------------------------------------------------------------
 * The three loops the brief names are three passes here
 * ---------------------------------------------------------------------------
 *
 * **Learn** is `absorb`: what the finished rounds established becomes rows,
 * and every ranking and stage below is re-derived from them. **Operate** is
 * `openAsks` and `prepareTest`: the next questions, and how far the bounded
 * test can get. **Self-expand** is `audit`: the capabilities this loop needs
 * and does not have become `cash_needs` rows with a recommended path, raised
 * without anything having failed and without anybody asking.
 *
 * Absorb runs first, deliberately. A round that settled on the previous pass
 * has products or figures to file, and filing them changes what the allocator
 * sees: a proposition that has just gained its last missing cost should be
 * read as testable on this pass rather than on the next one. Allocating first
 * would make every discovery a tick late, for ever.
 *
 * ---------------------------------------------------------------------------
 * It refuses to run where discovery is refused
 * ---------------------------------------------------------------------------
 *
 * Opening a round is new discovery, so it is behind `discoveryAllowed` — the
 * same gate the buckets and the industry kernel are behind. Absorbing is not:
 * filing what research already found is not new discovery, the spending
 * happened when it ran, and dropping results because the sprint wound down
 * would throw away work already paid for. Preparing a test is not either, and
 * that is the sharper case: a wound-down sprint must still be able to say what
 * is blocking a piece somebody may want to finish by hand.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import {
  listChannels,
  listCommerceRounds,
  listEvidenceForProject,
  listPropositions,
  listTests,
} from '../../repos/commerce.ts';
import { nowIso } from '../../repos/util.ts';
import { discoveryAllowed } from '../cash/lifecycle.ts';
import { allocate, MAX_OPEN_COMMERCE_ROUNDS, type Ask } from './allocate.ts';
import { auditCapabilities, type CapabilityAudit } from './audit.ts';
import { absorb, openAsks, type Absorbed, type OpenedRound } from './expand.ts';
import { byRank, read, type Reading } from './reading.ts';
import { prepareTest } from './test.ts';
import type {
  CommerceChannel,
  CommerceEvidence,
  CommerceRound,
  CommerceTest,
} from '../../domain/types.ts';

export interface KernelPass {
  /** Rounds opened this pass, each carrying why the allocator chose it. */
  opened: OpenedRound[];
  /** What the finished rounds established. */
  absorbed: Absorbed;
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  /** Bounded tests prepared or moved, with the blocker where there is one. */
  tests: { propositionId: string; blocker: string | null; detail: string }[];
  /** Capabilities this loop needs and does not have, raised as needs. */
  capabilities: CapabilityAudit;
  channels: number;
  propositions: number;
  openRounds: number;
}

const EMPTY: KernelPass = {
  opened: [],
  absorbed: { channels: [], propositions: [], evidence: [], settled: [], refused: [] },
  declined: [],
  tests: [],
  capabilities: { raised: [], present: [], missing: [] },
  channels: 0,
  propositions: 0,
  openRounds: 0,
};

/** Everything one pass reads, fetched once. */
export interface Snapshot {
  projectId: string;
  channels: CommerceChannel[];
  readings: Reading[];
  rounds: CommerceRound[];
  tests: CommerceTest[];
  evidence: CommerceEvidence[];
  at: string;
}

/**
 * The whole kernel as one reading, with nothing written.
 *
 * Exported separately from the pass that acts on it so a person — or a test —
 * can ask *what would Brain do next* without anything being created.
 * `services/realize/prove.ts` splits reading from applying for the same
 * reason: somebody should be able to look before anything moves.
 */
export async function snapshot(projectId: string): Promise<Snapshot> {
  const [channels, propositions, evidence, rounds, tests] = await Promise.all([
    listChannels(projectId),
    listPropositions(projectId),
    listEvidenceForProject(projectId),
    listCommerceRounds(projectId),
    listTests(projectId),
  ]);

  const channelById = new Map(channels.map((one) => [one.id, one]));
  const byProposition = new Map<string, CommerceEvidence[]>();
  const byChannel = new Map<string, CommerceEvidence[]>();
  for (const row of evidence) {
    if (row.propositionId) {
      const held = byProposition.get(row.propositionId) ?? [];
      held.push(row);
      byProposition.set(row.propositionId, held);
    } else if (row.channelId) {
      const held = byChannel.get(row.channelId) ?? [];
      held.push(row);
      byChannel.set(row.channelId, held);
    }
  }

  /*
   * One live test per proposition, and the most recent settled one otherwise.
   *
   * Ordered newest-last by `listTests`, so the last match wins. §23 records
   * what an unordered read of the same shape cost: `binForOrchestration` had
   * no `ORDER BY` and returned a spent bin while the live one was running,
   * then told a reader the packet was stranded.
   */
  const testFor = new Map<string, CommerceTest>();
  for (const test of tests) testFor.set(test.propositionId, test);

  const readings = propositions.map((proposition) =>
    read({
      proposition,
      channel: channelById.get(proposition.channelId) ?? null,
      evidence: byProposition.get(proposition.id) ?? [],
      channelEvidence: byChannel.get(proposition.channelId) ?? [],
      test: testFor.get(proposition.id) ?? null,
      rounds: rounds.filter((one) => one.propositionId === proposition.id),
    }),
  );
  readings.sort(byRank);

  return { projectId, channels, readings, rounds, tests, evidence, at: nowIso() };
}

export function planFrom(input: Snapshot): { asks: Ask[]; declined: { subject: string; why: string }[] } {
  const openRounds = input.rounds.filter((one) => one.state === 'OPEN').length;
  return allocate({
    channels: input.channels,
    readings: input.readings,
    rounds: input.rounds,
    slots: Math.max(0, MAX_OPEN_COMMERCE_ROUNDS - openRounds),
    now: input.at,
  });
}

export async function runCommerceKernel(projectId: string): Promise<KernelPass> {
  // One read answers it for the many projects that hold no sprint at all,
  // which is what makes this cheap enough to run for every project every tick.
  if (!(await getCashMode(projectId))) return EMPTY;

  const absorbed = await absorb({ projectId });
  const state = await snapshot(projectId);

  /*
   * Preparing a test is not new discovery, so it runs whatever the sprint's
   * state is — and it never spends. What it does is settle, from rows, how far
   * this piece could get and what the first missing thing is, so that a
   * blocked piece says which of four different things is blocking it rather
   * than sitting at a stage nobody can read.
   */
  const tests: KernelPass['tests'] = [];
  for (const reading of state.readings) {
    if (reading.proposition.retiredAt) continue;
    if (!reading.economics.contributionPerUnit.known && !reading.test) continue;
    const prepared = await prepareTest({
      projectId,
      reading,
      existing: reading.test,
    });
    if (prepared.test) {
      tests.push({
        propositionId: reading.proposition.id,
        blocker: prepared.blocker,
        detail: prepared.detail,
      });
    }
  }

  const capabilities = await auditCapabilities({ projectId, readings: state.readings });

  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) {
    return {
      opened: [],
      absorbed,
      declined: [{ subject: 'every channel and product on the map', why: gate.reason }],
      tests,
      capabilities,
      channels: state.channels.filter((one) => one.retiredAt === null).length,
      propositions: state.readings.filter((one) => one.proposition.retiredAt === null).length,
      openRounds: state.rounds.filter((one) => one.state === 'OPEN').length,
    };
  }

  const plan = planFrom(state);
  const opened = await openAsks({
    projectId,
    asks: plan.asks,
    readings: state.readings,
    channels: state.channels,
  });

  return {
    opened,
    absorbed,
    declined: plan.declined,
    tests,
    capabilities,
    channels: state.channels.filter((one) => one.retiredAt === null).length,
    propositions: state.readings.filter((one) => one.proposition.retiredAt === null).length,
    openRounds: state.rounds.filter((one) => one.state === 'OPEN').length,
  };
}
