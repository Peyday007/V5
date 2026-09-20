/**
 * What §13 asks Brain to surface, and what §11 asks it to measure.
 *
 * ---------------------------------------------------------------------------
 * Six readings, and every one of them is derived
 * ---------------------------------------------------------------------------
 *
 * Human dependencies, the automation frontier, the bottlenecks, where more
 * human capability would help, where a role has already been compressed, and
 * which openings have stopped needing people. Nothing here is stored: a
 * frontier that had to be recomputed by somebody remembering would be stale
 * from the moment a capability was connected, and the whole reason §7 asks for
 * *continuous* compression is that the answer changes as Brain changes.
 *
 * ---------------------------------------------------------------------------
 * Every figure is counted or it is UNKNOWN
 * ---------------------------------------------------------------------------
 *
 * §11 asks for cost per output, time per output, error rate and human hours.
 * Brain holds rows for none of them, so all four report `UNKNOWN` and name
 * what would measure them. That is invariant 33 — no figure reported that was
 * not measured — and it is the whole difference between a dashboard and a
 * reading. The temptation is real and is worse here than usual: an invented
 * automation percentage is exactly the number somebody would quote in a
 * decision about whether to keep employing somebody.
 *
 * The one figure that *is* counted says what its denominator is. §29 records
 * why: "0 of 8 settled" was accurate and read as failure, because eight is not
 * a quantity until you know eight of what. Here the denominator is **tasks
 * that have an allocation at all** — not units of work, not hours, not
 * revenue — and a reader who took it for a share of output would be reading a
 * number nobody measured.
 */
import { laborSnapshot, type LaborSnapshot, type TaskCoverage } from './map.ts';
import { allocate, MAX_OPEN_LABOR_ROUNDS } from './allocate.ts';
import { layerIsHuman, questionAnsweredBy } from '../../domain/labor.ts';
import { AUTOMATED_CHANNELS, PRODUCTION_LAYERS } from '../../domain/types.ts';
import type { LaborBlockerKind } from './necessity.ts';
import type {
  HumanNecessityReason,
  LaborChannel,
  ProductionLayer,
  RateBasis,
} from '../../domain/types.ts';

export interface HumanDependency {
  taskId: string;
  path: string;
  output: string;
  layer: ProductionLayer;
  reason: HumanNecessityReason;
  rationale: string;
  /**
   * What actually backs this role.
   *
   * Three answers, not two, and the first version of this had two — a boolean
   * called `established`, read off `verdict === 'HUMAN_REQUIRED'`, which the
   * report then printed as *"established by a published source"*. That is
   * false whenever a person answered the necessity question themselves, which
   * is most of them on a new map: the verdict says the *test* settled it, not
   * that a source did. Driving the report is what showed it, because the
   * sentence was wrong on the very first row it printed.
   *
   * `RESEARCH` is a gated claim. `PERSON` is somebody answering the question.
   * `ASSERTED` is neither — the allocation names a reason and nothing answers
   * the question behind it, which is exactly the kind of role §7 asks Brain to
   * keep re-examining.
   */
  backing: 'RESEARCH' | 'PERSON' | 'ASSERTED';
  /** How many published ways this capability could be sourced are on record. */
  sourcingOptions: number;
  since: string;
}

export interface FrontierItem {
  taskId: string;
  path: string;
  output: string;
  /** What it is produced by today, or null where nobody has decided. */
  layer: ProductionLayer | null;
  /**
   * Everything still standing in the way. Empty means it is ready to move now.
   */
  blockers: { kind: LaborBlockerKind; statement: string; remedy: string }[];
  /** Published evidence that this work is done by software somewhere. */
  automatedPrecedents: number;
}

export interface Bottleneck {
  kind: LaborBlockerKind;
  /** How many live tasks this is currently holding. */
  tasks: number;
  statement: string;
  remedy: string;
  /** The capability it names, where every task naming it names the same one. */
  capabilityId: string | null;
}

export interface CapacityNeed {
  taskId: string;
  path: string;
  output: string;
  /** What is missing: somewhere to source it, or a decision at all. */
  kind: 'NO_SOURCING_ESTABLISHED' | 'NOBODY_HAS_DECIDED';
  statement: string;
  reason: HumanNecessityReason | null;
}

export interface CompressionEvent {
  taskId: string;
  path: string;
  from: ProductionLayer;
  to: ProductionLayer;
  /** What the human role had existed for. */
  wasFor: HumanNecessityReason | null;
  at: string;
  rationale: string;
  /**
   * Which direction. Reported rather than filtered, because a reading that
   * showed only the compressions would be a scoreboard rather than a record —
   * and a task that went back to a person is the single most useful thing in
   * this table.
   */
  direction: 'COMPRESSED' | 'ESCALATED';
}

export interface WorkflowEconomics {
  workflowId: string;
  name: string;
  opportunityId: string | null;
  tasks: number;
  /** Tasks with a live allocation on a person. */
  humanTasks: number;
  /** Tasks with a live allocation on Brain, a tool or a service. */
  machineTasks: number;
  /** Tasks nobody has decided. Counted apart, never folded into either. */
  undecided: number;
  /** Whether every decided task here is produced without a person. */
  fullyAutomated: boolean;
  /** How many human tasks this workflow has shed since it was created. */
  compressedSince: number;
}

export type EvidenceClass = 'MEASURED' | 'UNKNOWN';

export interface Figure {
  key: string;
  label: string;
  /** The number, or null. Null is never rendered as zero. */
  value: number | null;
  /** What the number counts, so it can never be read as something else. */
  denominator: string | null;
  evidence: EvidenceClass;
  /** Where it came from, or what would produce it. */
  note: string;
}

export interface LaborView {
  projectId: string;
  at: string;
  workflows: number;
  tasks: number;
  /** §13's six, in the order the brief asks for them. */
  humanDependencies: HumanDependency[];
  automationFrontier: FrontierItem[];
  bottlenecks: Bottleneck[];
  capacityNeeds: CapacityNeed[];
  roleCompression: CompressionEvent[];
  economics: WorkflowEconomics[];
  /** §11, with an evidence class on every one. */
  measurements: Figure[];
  /** What Brain would ask next and why, without anything being created. */
  nextQuestions: { subject: string; purpose: string; why: string }[];
  /** Considered and not asked, with the reason. */
  declined: { subject: string; why: string }[];
  /** One sentence a person can read without opening anything. */
  summary: string;
}

export async function laborView(projectId: string): Promise<LaborView> {
  const snapshot = await laborSnapshot(projectId);
  return composeView(snapshot, plan(snapshot));
}

/**
 * The allocation decision for one snapshot, without acting on it.
 *
 * Exported so a person — or a test — can ask *what would Brain do next* with
 * nothing created. `services/realize/prove.ts` and `planFrom` split reading
 * from applying for the same reason: somebody should be able to look before
 * anything moves.
 */
export function plan(snapshot: LaborSnapshot): {
  asks: { subject: string; purpose: string; why: string }[];
  declined: { subject: string; why: string }[];
} {
  const open = snapshot.rounds.filter((one) => one.state === 'OPEN').length;
  const result = allocate({
    snapshot,
    slots: Math.max(0, MAX_OPEN_LABOR_ROUNDS - open),
  });
  return {
    asks: result.asks.map((one) => ({
      subject: one.subject,
      purpose: one.purpose,
      why: one.why,
    })),
    declined: result.declined,
  };
}

export function composeView(
  snapshot: LaborSnapshot,
  planned: { asks: { subject: string; purpose: string; why: string }[]; declined: { subject: string; why: string }[] },
): LaborView {
  const live = snapshot.coverage;

  return {
    projectId: snapshot.projectId,
    at: snapshot.at,
    workflows: snapshot.workflows.filter((one) => one.retiredAt === null).length,
    tasks: live.length,
    humanDependencies: humanDependencies(live),
    automationFrontier: automationFrontier(live),
    bottlenecks: bottlenecks(live),
    capacityNeeds: capacityNeeds(live),
    roleCompression: roleCompression(live),
    economics: economics(snapshot, live),
    measurements: measurements(live),
    nextQuestions: planned.asks,
    declined: planned.declined,
    summary: summarize(live),
  };
}

/** §13's HUMAN DEPENDENCIES: what people do here, and why they remain necessary. */
function humanDependencies(coverage: readonly TaskCoverage[]): HumanDependency[] {
  const out: HumanDependency[] = [];
  for (const one of coverage) {
    const allocation = one.allocation;
    if (!allocation || !layerIsHuman(allocation.productionLayer)) continue;
    if (!allocation.necessityReason) continue;
    out.push({
      taskId: one.task.id,
      path: one.path,
      output: one.task.output,
      layer: allocation.productionLayer,
      reason: allocation.necessityReason,
      rationale: allocation.rationale,
      backing: backingFor(one, allocation.necessityReason),
      sourcingOptions: one.options.length,
      since: allocation.createdAt,
    });
  }
  /*
   * Weakest backing first, deliberately.
   *
   * A role nothing has checked is the one worth looking at first — §7's whole
   * request — and a list ordered by date would bury it under roles a published
   * rule has already settled.
   */
  return out.sort((a, b) =>
    BACKING_RANK[a.backing] !== BACKING_RANK[b.backing]
      ? BACKING_RANK[a.backing] - BACKING_RANK[b.backing]
      : a.since < b.since
        ? -1
        : 1,
  );
}

const BACKING_RANK: Readonly<Record<HumanDependency['backing'], number>> = Object.freeze({
  ASSERTED: 0,
  PERSON: 1,
  RESEARCH: 2,
});

/**
 * What backs one human role, read from the answer behind its reason.
 *
 * Three of the six reasons answer no question at all — they are judgements
 * about this operation rather than facts a source can settle — so a role held
 * for one of them is `ASSERTED` unless somebody recorded the judgement, which
 * there is nowhere to do. Saying `RESEARCH` about it would be the claim this
 * whole field exists to stop making.
 */
function backingFor(
  coverage: TaskCoverage,
  reason: HumanNecessityReason | null,
): HumanDependency['backing'] {
  if (!reason) return 'ASSERTED';
  const question = questionAnsweredBy(reason);
  if (!question) return 'ASSERTED';
  const reading = coverage.necessity.questions.find((one) => one.question === question);
  if (!reading || reading.answer !== 'YES') return 'ASSERTED';
  if (reading.basis === 'RESEARCHED') return 'RESEARCH';
  if (reading.basis === 'PERSON') return 'PERSON';
  return 'ASSERTED';
}

/**
 * §13's AUTOMATION FRONTIER: which human responsibilities Brain is close to
 * absorbing.
 *
 * Ordered by how far away each one is, which is a count of blockers rather
 * than a score — the same refusal `portfolio.ts` makes. A task with none left
 * is ready to move *now*, and it leads.
 */
function automationFrontier(coverage: readonly TaskCoverage[]): FrontierItem[] {
  const out: FrontierItem[] = [];
  for (const one of coverage) {
    const layer = one.allocation?.productionLayer ?? null;
    // Already produced without a person: there is no frontier here to report.
    if (layer && !layerIsHuman(layer)) continue;
    out.push({
      taskId: one.task.id,
      path: one.path,
      output: one.task.output,
      layer,
      blockers: one.necessity.blockers.map((blocker) => ({
        kind: blocker.kind,
        statement: blocker.statement,
        remedy: blocker.remedy,
      })),
      automatedPrecedents: one.options.filter((option) =>
        AUTOMATED_CHANNELS.includes(option.channel),
      ).length,
    });
  }
  return out.sort((a, b) =>
    a.blockers.length !== b.blockers.length
      ? a.blockers.length - b.blockers.length
      : b.automatedPrecedents - a.automatedPrecedents,
  );
}

/** §13's BOTTLENECKS: what currently prevents additional Brain execution. */
function bottlenecks(coverage: readonly TaskCoverage[]): Bottleneck[] {
  const groups = new Map<
    LaborBlockerKind,
    { tasks: number; statement: string; remedy: string; capabilities: Set<string> }
  >();
  for (const one of coverage) {
    const layer = one.allocation?.productionLayer ?? null;
    if (layer && !layerIsHuman(layer)) continue;
    for (const blocker of one.necessity.blockers) {
      const group = groups.get(blocker.kind) ?? {
        tasks: 0,
        statement: blocker.statement,
        remedy: blocker.remedy,
        capabilities: new Set<string>(),
      };
      group.tasks += 1;
      if (blocker.capabilityId) group.capabilities.add(blocker.capabilityId);
      groups.set(blocker.kind, group);
    }
  }
  return [...groups.entries()]
    .map(([kind, group]) => ({
      kind,
      tasks: group.tasks,
      statement: group.statement,
      remedy: group.remedy,
      /*
       * Only where every task naming this blocker names the same capability.
       *
       * Two tasks blocked on two different integrations are two remedies, and
       * naming one of them would send somebody to fix half the problem while
       * believing they had fixed it.
       */
      capabilityId: group.capabilities.size === 1 ? [...group.capabilities][0]! : null,
    }))
    .sort((a, b) => b.tasks - a.tasks);
}

/** §13's HUMAN CAPACITY NEEDS: where more human capability would actually help. */
function capacityNeeds(coverage: readonly TaskCoverage[]): CapacityNeed[] {
  const out: CapacityNeed[] = [];
  for (const one of coverage) {
    const allocation = one.allocation;
    if (!allocation) {
      out.push({
        taskId: one.task.id,
        path: one.path,
        output: one.task.output,
        kind: 'NOBODY_HAS_DECIDED',
        statement:
          'Nothing says who produces this. ' +
          (one.necessity.blockers[0]?.remedy ?? 'Ask the necessity test of it.'),
        reason: null,
      });
      continue;
    }
    if (!layerIsHuman(allocation.productionLayer)) continue;
    if (one.options.length > 0) continue;
    out.push({
      taskId: one.task.id,
      path: one.path,
      output: one.task.output,
      kind: 'NO_SOURCING_ESTABLISHED',
      statement:
        'A person produces this and nothing published has been read about where that ' +
        'capability is actually sourced or what it costs.',
      reason: allocation.necessityReason,
    });
  }
  return out;
}

/**
 * §13's ROLE COMPRESSION: where Brain improvements have reduced human workload.
 *
 * Read from the allocation chain, which is the only place it could be read
 * from — current state is exactly what forgot. That is why both decision
 * tables are append-only, and it is the clearest reason in this kernel for
 * §5's rule.
 */
function roleCompression(coverage: readonly TaskCoverage[]): CompressionEvent[] {
  const out: CompressionEvent[] = [];
  for (const one of coverage) {
    for (let index = 1; index < one.history.length; index += 1) {
      const before = one.history[index - 1]!;
      const after = one.history[index]!;
      const wasHuman = layerIsHuman(before.productionLayer);
      const isHuman = layerIsHuman(after.productionLayer);
      if (wasHuman === isHuman) continue;
      out.push({
        taskId: one.task.id,
        path: one.path,
        from: before.productionLayer,
        to: after.productionLayer,
        wasFor: before.necessityReason,
        at: after.createdAt,
        rationale: after.rationale,
        direction: wasHuman ? 'COMPRESSED' : 'ESCALATED',
      });
    }
  }
  return out.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
}

/**
 * §13's NEW BUSINESS ECONOMICS: which openings have materially stopped needing
 * people.
 *
 * Counts rather than currency, and that is not a shortcut. What the brief asks
 * for is businesses whose economics improved because Brain absorbed work that
 * used to cost labour — and turning that into a figure would need a rate per
 * task nobody has set. `undecided` is counted apart from both sides for the
 * same reason an unknown is never favourable: a workflow with two Brain tasks
 * and eight nobody has looked at is not eighty per cent automated.
 */
function economics(
  snapshot: LaborSnapshot,
  coverage: readonly TaskCoverage[],
): WorkflowEconomics[] {
  const byWorkflow = new Map<string, TaskCoverage[]>();
  for (const one of coverage) {
    byWorkflow.set(one.workflow.id, [...(byWorkflow.get(one.workflow.id) ?? []), one]);
  }

  const out: WorkflowEconomics[] = [];
  for (const workflow of snapshot.workflows) {
    if (workflow.retiredAt !== null) continue;
    const mine = byWorkflow.get(workflow.id) ?? [];
    let humanTasks = 0;
    let machineTasks = 0;
    let undecided = 0;
    let compressedSince = 0;
    for (const one of mine) {
      if (!one.allocation) undecided += 1;
      else if (layerIsHuman(one.allocation.productionLayer)) humanTasks += 1;
      else machineTasks += 1;
      for (let index = 1; index < one.history.length; index += 1) {
        const before = one.history[index - 1]!;
        const after = one.history[index]!;
        if (layerIsHuman(before.productionLayer) && !layerIsHuman(after.productionLayer)) {
          compressedSince += 1;
        }
      }
    }
    out.push({
      workflowId: workflow.id,
      name: workflow.name,
      opportunityId: workflow.opportunityId,
      tasks: mine.length,
      humanTasks,
      machineTasks,
      undecided,
      // Decided *and* without a person. A workflow where nobody has decided
      // anything is not automated, however few humans are on it.
      fullyAutomated: mine.length > 0 && humanTasks === 0 && undecided === 0,
      compressedSince,
    });
  }
  return out.sort((a, b) => b.compressedSince - a.compressedSince);
}

/**
 * §11's measurements, four of which Brain cannot take.
 *
 * Saying so is the whole value. A cost per output that was actually a guess
 * would be quoted in a decision about whether to keep employing somebody, and
 * `evidence` exists so that no reader has to work out which of these was
 * counted.
 */
function measurements(coverage: readonly TaskCoverage[]): Figure[] {
  const allocated = coverage.filter((one) => one.allocation !== null);
  const byLayer = new Map<ProductionLayer, number>();
  for (const one of allocated) {
    const layer = one.allocation!.productionLayer;
    byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
  }
  const human = allocated.filter((one) => layerIsHuman(one.allocation!.productionLayer)).length;

  const figures: Figure[] = [
    {
      key: 'tasks',
      label: 'Tasks on the map',
      value: coverage.length,
      denominator: null,
      evidence: 'MEASURED',
      note: 'Live tasks in live workflows, counted from rows.',
    },
    {
      key: 'allocated',
      label: 'Tasks somebody has decided',
      value: allocated.length,
      denominator: `of ${coverage.length} tasks`,
      evidence: 'MEASURED',
      note:
        'The denominator for every share below. A task nobody has decided is counted here and ' +
        'nowhere else — it is not evidence of automation and not evidence of a human role.',
    },
    {
      key: 'machineTasks',
      label: 'Tasks produced without a person',
      value: allocated.length - human,
      denominator: `of ${allocated.length} decided tasks`,
      evidence: 'MEASURED',
      note:
        'A count of tasks, not of work. Two tasks are not two equal amounts of anything, so ' +
        'this is not a share of output, of hours or of cost — none of which Brain measures.',
    },
    {
      key: 'humanTasks',
      label: 'Tasks produced by a person',
      value: human,
      denominator: `of ${allocated.length} decided tasks`,
      evidence: 'MEASURED',
      note: 'Each one names which of the six reasons makes a person necessary.',
    },
  ];

  for (const layer of PRODUCTION_LAYERS) {
    const count = byLayer.get(layer) ?? 0;
    if (count === 0) continue;
    figures.push({
      key: `layer:${layer}`,
      label: `Tasks on ${layer}`,
      value: count,
      denominator: `of ${allocated.length} decided tasks`,
      evidence: 'MEASURED',
      note: 'Counted from the live allocation on each task.',
    });
  }

  /*
   * The four the brief asks for and Brain cannot answer.
   *
   * Reported rather than omitted, because an absent row reads as *nothing to
   * say about it* and the honest answer is *this is not measured, and here is
   * what would measure it*. §30 draws the same distinction between MISSING and
   * UNKNOWN for a capability, one table along.
   */
  figures.push(
    {
      key: 'costPerOutput',
      label: 'Cost per completed output',
      value: null,
      denominator: null,
      evidence: 'UNKNOWN',
      note:
        'Brain holds no row recording what one output of a task cost. It would need a rate on ' +
        'the human side and a cost attribution on the Brain side, and neither exists.',
    },
    {
      key: 'timePerOutput',
      label: 'Time per completed output',
      value: null,
      denominator: null,
      evidence: 'UNKNOWN',
      note:
        'Nothing times a task. `bin_events` times a research bin, which is not the same unit ' +
        'and must not be reported as though it were.',
    },
    {
      key: 'errorRate',
      label: 'Error and rework rate',
      value: null,
      denominator: null,
      evidence: 'UNKNOWN',
      note: 'Nothing records a rejected or reworked output per task.',
    },
    {
      key: 'humanHours',
      label: 'Human hours consumed',
      value: null,
      denominator: null,
      evidence: 'UNKNOWN',
      note:
        'Nobody reports hours to this Brain. A sourcing option’s published PER_HOUR rate says ' +
        'what an hour costs, and says nothing about how many were worked.',
    },
  );

  return figures;
}

function summarize(coverage: readonly TaskCoverage[]): string {
  if (coverage.length === 0) {
    return 'Nothing is on the labor map yet. It fills itself from qualified openings that ' +
      'declare which capabilities delivering them needs, and a person can name a workflow ' +
      'directly.';
  }
  const allocated = coverage.filter((one) => one.allocation !== null);
  const human = allocated.filter((one) => layerIsHuman(one.allocation!.productionLayer));
  const ready = coverage.filter(
    (one) =>
      one.necessity.verdict === 'BRAIN_DEFENSIBLE' &&
      (one.allocation === null || layerIsHuman(one.allocation.productionLayer)),
  );

  const parts = [
    `${coverage.length} task${coverage.length === 1 ? '' : 's'} on the map, ` +
      `${allocated.length} decided and ${coverage.length - allocated.length} not.`,
  ];
  if (human.length > 0) {
    const researched = human.filter(
      (one) => backingFor(one, one.allocation!.necessityReason) === 'RESEARCH',
    ).length;
    parts.push(
      `${human.length} need${human.length === 1 ? 's' : ''} a person, ${researched} of them on a ` +
        'published rule and the rest on somebody’s own answer.',
    );
  }
  if (ready.length > 0) {
    parts.push(
      `${ready.length} ${ready.length === 1 ? 'is' : 'are'} established as defensible for Brain ` +
        'and still allocated to a person or to nobody.',
    );
  }
  return parts.join(' ');
}

/** Exported for the report, so a channel reads the same way in both. */
export function describeRate(
  rateCents: number | null,
  basis: RateBasis | null,
  channel: LaborChannel,
): string {
  if (rateCents === null || basis === null) {
    return `${channel}, at a rate no source publishes`;
  }
  const amount = (rateCents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${channel}, at ${amount} ${basis.replace('PER_', 'per ').toLowerCase()}`;
}
