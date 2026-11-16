/**
 * The organisation an expanding venture would need, derived from the labour
 * map and never from an org chart (program fpg_ea512f54…, VENT-24-3).
 *
 * ---------------------------------------------------------------------------
 * Where a role comes from
 * ---------------------------------------------------------------------------
 *
 * §41 puts the burden on the person: Brain is the default producer, and a
 * human role exists only where the necessity test established one
 * (`HUMAN_REQUIRED`) or where a bottleneck names a capability nobody holds.
 * So this module invents no role. It reads the labour snapshot the labour
 * owner already builds (`laborSnapshot`), the bottlenecks `composeView`
 * already reports, and the contractors a person has already approved, and it
 * groups the tasks nothing else can cover by **responsibility** — the reason a
 * person is needed and the capability involved — rather than by a generic
 * function box. A function label (engineering, finance, operations…) is what
 * the tasks' own workflows are called; none is imposed, and a snapshot with no
 * such task yields no role at all.
 *
 * ---------------------------------------------------------------------------
 * What it prepares, and what it refuses to do
 * ---------------------------------------------------------------------------
 *
 * For each role it prepares a specification, a cost model (withheld, naming
 * the unpriced tasks, whenever a task has no published rate — null is unknown,
 * never free), the sourcing routes the market options name, a recruitment
 * process, evaluation criteria, onboarding, the tasks it would take and who it
 * answers to. Hiring an employee, making a binding offer, sharing candidate
 * data, engaging a paid recruiter and signing an agreement are always
 * `REQUIRES_AUTHORIZATION`; coordinating a contractor a person already
 * approved is permitted. Hiring automation is `NOT_ESTABLISHED` until a
 * job-specific quality and fairness assessment is on record — model fluency
 * is not evidence that it selects reliable people.
 *
 * The capability is later-stage: with no active objective whose tasks depend
 * on a role, the reading is `DORMANT` and requests no capacity. The
 * derivation is pure, performs no write and creates nothing (invariants 44,
 * 45). `organizationFor` reads the same rows the labour owner already reads —
 * `laborSnapshot`, `composeView`'s bottlenecks — and the manufacturing kernel
 * reports it on every pass, so the reading exists in the running Brain without
 * a second store or schedule.
 */
import { laborSnapshot, type LaborSnapshot, type TaskCoverage } from './map.ts';
import { composeView, plan, type Bottleneck } from './view.ts';
import { NON_HUMAN_LAYERS, type HumanNecessityReason, type LaborChannel, type RateBasis } from '../../domain/types.ts';

export const AUTHORIZED_ACTIONS = [
  'HIRE_EMPLOYEE',
  'BINDING_OFFER',
  'SHARE_CANDIDATE_DATA',
  'ENGAGE_PAID_RECRUITER',
  'SIGN_AGREEMENT',
] as const;
export type AuthorizedAction = (typeof AUTHORIZED_ACTIONS)[number];

export interface ApprovedContractor {
  /** The task the person approved this contractor for. */
  taskId: string;
  contractorRef: string;
  approvedByRef: string;
}

export interface ActiveObjective {
  id: string;
  /** The labour tasks the objective's work depends on. */
  taskIds: string[];
}

export interface AutomationAssessment {
  /** The assessment was made for this job, not borrowed from a general benchmark. */
  jobSpecific: boolean;
  /** Measured quality on the job's own criteria, 0..1, or null when not measured. */
  quality: number | null;
  /** Measured fairness across candidate groups, 0..1, or null when not measured. */
  fairness: number | null;
  /** Where the measurement is recorded. */
  evidenceRef: string | null;
}

export interface AutomationProposal {
  /** Which role the automation would screen or select for, by role key. */
  roleKey: string;
  tool: string;
  assessment: AutomationAssessment | null;
}

export interface RateFigure {
  basis: RateBasis;
  lowCents: number;
  highCents: number;
}

export interface RecruitmentStep {
  step: string;
  /** PREPARE is Brain's to do; REQUIRES_AUTHORIZATION needs a person's recorded decision. */
  status: 'PREPARE' | 'REQUIRES_AUTHORIZATION';
  action: AuthorizedAction | null;
}

export interface OrganizationalRole {
  key: string;
  /** The reason a person is needed, or the bottleneck that makes one necessary. */
  responsibility: string;
  reason: HumanNecessityReason | null;
  capabilityId: string | null;
  /** Read from the tasks' own workflows; never a fixed vocabulary. */
  functions: string[];
  /** What triggered the role: HUMAN_REQUIRED tasks and bottlenecks. */
  derivedFrom: string[];
  specification: { title: string; outputs: string[]; rationale: string[] };
  /** Null is withheld: a task here has no published rate. */
  cost: { rates: RateFigure[]; unpricedTaskIds: string[] } | null;
  unpricedTaskIds: string[];
  sourcing: { channel: LaborChannel; jurisdiction: string | null; sourceClaimId: string }[];
  recruitment: RecruitmentStep[];
  evaluationCriteria: string[];
  onboarding: string[];
  taskAllocation: string[];
  accountability: string;
  automation: { tool: string; status: 'ESTABLISHED' | 'NOT_ESTABLISHED'; because: string }[];
  state: 'ACTIVE' | 'DORMANT';
  /** Objectives whose tasks depend on this role. Empty when dormant. */
  dependentObjectives: string[];
}

export interface OrganizationReading {
  state: 'ACTIVE' | 'DORMANT';
  roles: OrganizationalRole[];
  /** Approved contractors Brain may coordinate now, without further authorisation. */
  coordination: { taskId: string; contractorRef: string; status: 'PERMITTED' }[];
  /** Roles an active objective needs: the only capacity this capability asks for. */
  capacityRequested: number;
  because: string;
}

const AUTHORIZATION_STEPS: { step: string; action: AuthorizedAction }[] = [
  { step: 'engage a paid recruiter, if one is used', action: 'ENGAGE_PAID_RECRUITER' },
  { step: 'share candidate data with anyone outside Brain', action: 'SHARE_CANDIDATE_DATA' },
  { step: 'make a binding offer', action: 'BINDING_OFFER' },
  { step: 'hire as an employee', action: 'HIRE_EMPLOYEE' },
  { step: 'sign the engagement agreement', action: 'SIGN_AGREEMENT' },
];

function roleKey(reason: HumanNecessityReason | null, capabilityId: string | null, fallback: string): string {
  return `${reason ?? 'BOTTLENECK'}:${capabilityId ?? fallback}`;
}

function rates(tasks: TaskCoverage[]): { rates: RateFigure[]; unpriced: string[] } {
  const unpriced: string[] = [];
  const byBasis = new Map<RateBasis, RateFigure>();
  for (const one of tasks) {
    const priced = one.options.filter((option) => option.rateCents !== null && option.rateBasis !== null);
    if (priced.length === 0) {
      unpriced.push(one.task.id);
      continue;
    }
    for (const option of priced) {
      const basis = option.rateBasis!;
      const cents = option.rateCents!;
      const into = byBasis.get(basis);
      byBasis.set(basis, into ? { basis, lowCents: Math.min(into.lowCents, cents), highCents: Math.max(into.highCents, cents) } : { basis, lowCents: cents, highCents: cents });
    }
  }
  return { rates: [...byBasis.values()].sort((a, b) => a.basis.localeCompare(b.basis)), unpriced: unpriced.sort() };
}

function assessAutomation(proposal: AutomationProposal): { tool: string; status: 'ESTABLISHED' | 'NOT_ESTABLISHED'; because: string } {
  const a = proposal.assessment;
  if (!a) return { tool: proposal.tool, status: 'NOT_ESTABLISHED', because: 'No quality or fairness assessment is on record; fluency is not evidence of reliable selection.' };
  if (!a.jobSpecific) return { tool: proposal.tool, status: 'NOT_ESTABLISHED', because: 'The assessment on record is not specific to this job.' };
  if (a.quality === null || a.fairness === null || !a.evidenceRef) {
    return { tool: proposal.tool, status: 'NOT_ESTABLISHED', because: 'The job-specific assessment lacks a measured quality, a measured fairness or the record it came from.' };
  }
  return { tool: proposal.tool, status: 'ESTABLISHED', because: `Job-specific assessment ${a.evidenceRef}: quality ${a.quality}, fairness ${a.fairness}.` };
}

/**
 * The roles the labour map makes necessary, prepared and never filled.
 * Pure: reads what it is given, writes nothing.
 */
export function deriveOrganization(input: {
  snapshot: Pick<LaborSnapshot, 'coverage'>;
  bottlenecks: readonly Bottleneck[];
  approvedContractors?: readonly ApprovedContractor[];
  activeObjectives?: readonly ActiveObjective[];
  automation?: readonly AutomationProposal[];
}): OrganizationReading {
  const approved = input.approvedContractors ?? [];
  const objectives = input.activeObjectives ?? [];
  const coveredByContractor = new Set(approved.map((one) => one.taskId));
  const live = input.snapshot.coverage.filter((one) => one.task.retiredAt === null);

  // A bottleneck that names a missing capability makes a role of the tasks it holds.
  const bottleneckCapabilities = new Map<string, Bottleneck>();
  for (const one of input.bottlenecks) {
    if (one.kind === 'CAPABILITY_MISSING' && one.capabilityId && one.tasks > 0) bottleneckCapabilities.set(one.capabilityId, one);
  }

  const groups = new Map<string, { reason: HumanNecessityReason | null; capabilityId: string | null; tasks: TaskCoverage[]; derivedFrom: Set<string> }>();
  const coordination: OrganizationReading['coordination'] = [];
  for (const one of live) {
    const human = one.necessity.verdict === 'HUMAN_REQUIRED';
    const bottleneck = one.necessity.blockers.find((b) => b.kind === 'CAPABILITY_MISSING' && b.capabilityId && bottleneckCapabilities.has(b.capabilityId));
    if (!human && !bottleneck) continue;
    if (coveredByContractor.has(one.task.id)) {
      for (const contractor of approved.filter((c) => c.taskId === one.task.id)) coordination.push({ taskId: one.task.id, contractorRef: contractor.contractorRef, status: 'PERMITTED' });
      continue;
    }
    const reason = human ? one.necessity.reason : null;
    const capabilityId = one.task.capabilityId ?? bottleneck?.capabilityId ?? null;
    const key = roleKey(reason, capabilityId, one.workflow.id);
    const group = groups.get(key) ?? { reason, capabilityId, tasks: [], derivedFrom: new Set<string>() };
    group.tasks.push(one);
    if (human) group.derivedFrom.add(`task ${one.task.id} HUMAN_REQUIRED${reason ? ` (${reason})` : ''}`);
    if (bottleneck?.capabilityId) group.derivedFrom.add(`bottleneck CAPABILITY_MISSING ${bottleneck.capabilityId}`);
    groups.set(key, group);
  }

  const roles: OrganizationalRole[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const functions = [...new Set(group.tasks.map((one) => one.workflow.name))].sort();
    const outputs = group.tasks.map((one) => one.task.output);
    const priced = rates(group.tasks);
    const sourcing = group.tasks.flatMap((one) => one.options.map((option) => ({ channel: option.channel, jurisdiction: option.jurisdiction, sourceClaimId: option.sourceClaimId })));
    const responsibility = group.reason
      ? `${group.reason.toLowerCase().replace(/_/g, ' ')} for ${functions.join(', ')}`
      : `capability ${group.capabilityId} that no one available holds`;
    const dependentObjectives = objectives.filter((o) => o.taskIds.some((id) => group.tasks.some((t) => t.task.id === id))).map((o) => o.id).sort();
    const recruitment: RecruitmentStep[] = [
      { step: 'prepare the role specification and evaluation criteria', status: 'PREPARE', action: null },
      { step: 'compare the sourcing routes on record and their rates', status: 'PREPARE', action: null },
      ...AUTHORIZATION_STEPS.map((one) => ({ step: one.step, status: 'REQUIRES_AUTHORIZATION' as const, action: one.action })),
    ];
    roles.push({
      key,
      responsibility,
      reason: group.reason,
      capabilityId: group.capabilityId,
      functions,
      derivedFrom: [...group.derivedFrom].sort(),
      specification: {
        title: `${functions.join(' / ')}: ${group.reason ? group.reason.toLowerCase().replace(/_/g, ' ') : 'missing capability'}`,
        outputs,
        rationale: group.tasks.map((one) => one.necessity.summary),
      },
      cost: priced.unpriced.length === 0 ? { rates: priced.rates, unpricedTaskIds: [] } : null,
      unpricedTaskIds: priced.unpriced,
      sourcing,
      recruitment,
      evaluationCriteria: [
        ...outputs.map((output) => `produces "${output}" to the task's own acceptance`),
        ...(group.reason === 'ACCOUNTABILITY_LICENSING' ? ['holds the licence or standing the accountability requires, verified at source'] : []),
        ...(group.capabilityId ? [`demonstrates capability ${group.capabilityId} on a sample of the real work`] : []),
      ],
      onboarding: [...new Set(group.tasks.map((one) => `the ${one.workflow.name} workflow and its records`))],
      taskAllocation: group.tasks.map((one) => one.task.id),
      accountability: `answers for ${outputs.length} output(s); Brain verifies each against its acceptance and the owner holds every decision marked REQUIRES_AUTHORIZATION`,
      automation: (input.automation ?? []).filter((one) => one.roleKey === key).map(assessAutomation),
      state: dependentObjectives.length > 0 ? 'ACTIVE' : 'DORMANT',
      dependentObjectives,
    });
  }

  const active = roles.filter((one) => one.state === 'ACTIVE').length;
  const because =
    roles.length === 0
      ? 'No task the labour map holds needs a person nobody available can provide, so no role is derived.'
      : active === 0
        ? `${roles.length} role(s) are specified and ready for promotion; no active objective depends on them, so none requests capacity.`
        : `${active} of ${roles.length} role(s) are needed by an active objective.`;
  return { state: active > 0 ? 'ACTIVE' : 'DORMANT', roles, coordination, capacityRequested: active, because };
}

/**
 * The organisation reading for one project, from the labour owner's own rows.
 *
 * Read-only. Three facts come from rows rather than from a caller:
 *  - the bottlenecks are `composeView`'s, over `laborSnapshot` and `plan`;
 *  - an approved contractor is a live allocation a **person** decided onto a
 *    human layer — somebody already chose who does that task, so Brain
 *    coordinates them rather than specifying a new role;
 *  - an active objective is a live workflow tied to an opportunity: its tasks
 *    are work a commercial commitment depends on. A workflow tied to nothing
 *    leaves its roles DORMANT.
 */
export async function organizationFor(projectId: string): Promise<OrganizationReading> {
  const snapshot = await laborSnapshot(projectId);
  const view = composeView(snapshot, plan(snapshot));
  const approvedContractors: ApprovedContractor[] = snapshot.coverage
    .filter((one) => one.allocation && one.allocation.decidedBy === 'PERSON' && !NON_HUMAN_LAYERS.includes(one.allocation.productionLayer))
    .map((one) => ({ taskId: one.task.id, contractorRef: one.allocation!.id, approvedByRef: one.allocation!.decidedByRef ?? 'person' }));
  const byWorkflow = new Map<string, string[]>();
  for (const one of snapshot.coverage) {
    if (one.task.retiredAt !== null || one.workflow.retiredAt !== null || one.workflow.opportunityId === null) continue;
    byWorkflow.set(one.workflow.id, [...(byWorkflow.get(one.workflow.id) ?? []), one.task.id]);
  }
  const activeObjectives: ActiveObjective[] = [...byWorkflow.entries()].map(([workflowId, taskIds]) => {
    const opportunityId = snapshot.coverage.find((c) => c.workflow.id === workflowId)!.workflow.opportunityId!;
    return { id: `opportunity:${opportunityId}`, taskIds };
  });
  return deriveOrganization({ snapshot, bottlenecks: view.bottlenecks, approvedContractors, activeObjectives });
}
