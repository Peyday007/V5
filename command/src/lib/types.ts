/**
 * The fields the Command Center renders, from Brain's own response types.
 * Each names its server source; the server is the contract, this is a reader.
 */

// server/services/russell/summary.ts
export interface SummaryLine { sentence: string; detail: string | null; retrying: boolean }
export interface WorkSummary {
  cash: SummaryLine; research: SummaryLine; build: SummaryLine;
  figures: {
    money: { receivedCents: number; earnedCents: number; unpaidCostsCents: number; currency: string } | null;
    opportunities: { readyToTest: number; qualified: number; candidates: number; signals: number } | null;
    builds: { live: number; waitingRelease: number; blocked: number; complete: number } | null;
  };
}

// server/services/russell/inbox.ts
export type InboxAction =
  | { type: 'GRANT_RESEARCH_AUTHORITY' }
  | { type: 'ANSWER_REQUEST'; requestId: string; choices: { key: string; label: string; consequence: string }[]; recommendation: string | null }
  | { type: 'SOFTWARE'; requestId: string }
  | { type: 'OPEN'; destination: string; label: string }
  | { type: 'EXTERNAL'; url: string; label: string };
export interface InboxItem {
  id: string; category: string; title: string; reason: string; ifIgnored: string; requestedAction: string;
  affects: string; continuing: string; urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER'; since: string | null; action: InboxAction;
}
export interface Inbox { items: InboxItem[]; categories: { key: string; label: string }[]; unreadable: { source: string; temporary: boolean }[] }

// server/services/goals/briefing.ts, model.ts
export interface GoalBriefing {
  headline: string;
  active: { goalId: string; title: string; waiting: string; next: string; by: string }[];
  milestones: { goalId: string; title: string; next: string; dueAt: string | null; deadline: string | null; overdue: boolean }[];
  agingBlockers: { goalId: string; title: string; blocker: string; remedy: string; by: string; ageHours: number | null }[];
  decisions: { goalId: string; goalTitle: string; [k: string]: unknown }[];
  counts: { active: number; paused: number; cancelled: number; complete: number; needsYou: number; blocked: number };
  generatedAt: string;
}
export interface TargetReading {
  metric: string; metricLabel: string; currency: string; projectId: string; targetCents: number; achievedCents: number;
  remainingCents: number; achieved: boolean; daysLeft: number | null; execution?: { windowDays: number; startedAt: string | null } | null;
  notCounted: { label: string; cents: number }[]; capitalCeilingCents: number | null; hoursCeiling: number | null;
  resources: string | null; proven: boolean; [k: string]: unknown;
}
export interface GoalView {
  id: string; title: string; projectId: string | null; projectName: string | null; intent: string; outcome: string | null;
  purposeLabel: string; owner: { userId: string; name: string } | null; dueAt: string | null; deadline: string | null; overdue: boolean;
  commitmentLabel: string; lifecycle: string; lifecycleReason: string; target: TargetReading | null; state: string; stateEvidence: string;
  waiting: { kind: string; detail: string; since: string | null }; next: { action: string; by: string; afterwards: string | null };
  blockers: { [k: string]: unknown }[]; decisions: { [k: string]: unknown }[]; obligations: string[];
  work?: GoalWorkLink[];
  priority: { [k: string]: unknown } | null; pausedAt: string | null; pausedReason: string | null; createdAt: string; updatedAt: string;
}
export interface DecisionResult { ok: boolean; reason: string | null; consequence: string }

// server/services/operator/actions.ts (GoalSummary, readGoalPlanSummary)
export interface GoalSummary {
  id: string; title: string; projectId: string | null; state: string; stateEvidence: string; lifecycle: string;
  target: TargetReading | null; dueAt: string | null; deadline?: string | null; waiting: unknown; next: unknown;
  openDecisions: number; blockers: number; priority: number | null;
}
export interface PlanStrategy { key: string; label: string; verdict: string; constraintsFailed: unknown; sweep: unknown; conservativeSettled: unknown }
export interface CommitteeDefect { claim: string; evidenceRef: string; why: string; critical: boolean; opportunityId: string | null; fact: string }
export interface CommitteeView {
  tier: string; verdict: string; blocks: boolean; blocker: string | null; criticalDefects: number; reviewMs: number | null;
  roles: {
    role: string; verdict: string; critical: boolean; defects: CommitteeDefect[]; open: string[]; citations: string[];
    settled?: { subject: string; research: string; outcome: string; why: string; sourceUrls: string[] }[];
    specialist?: { verdict: string; model: string; reason: string; defects: CommitteeDefect[] } | null;
  }[];
  investigations: { opportunityId: string; fact: string; established: string[]; broken: string[] }[];
}
export interface PlanSummary {
  goalId: string; kind?: 'OBJECTIVE'; readAt?: string; verdict?: string; chosenStrategy?: unknown;
  strategies?: PlanStrategy[]; nextTest?: unknown; decision?: unknown; interpretation?: unknown; error?: unknown;
  forecast?: ({ committee?: CommitteeView | null; conservativeSettled?: unknown; remainingCents?: number | null; daysLeft?: number | null; acceptance?: unknown; infeasible?: unknown; degraded?: unknown; steps?: unknown } & Record<string, unknown>) | null;
  reading?: null; note?: string;
}

// server/services/engineering/watchdog.ts
export interface Utilization {
  pools: { pool: string; waiting: number; running: number; capacity: number; idle: boolean; because: string }[] | null;
  readAt: string | null; ageSeconds: number | null; source: 'LIVE' | 'CACHED' | 'NONE'; note: string | null;
}

// server/services/fleet/view.ts, workforce.ts
export interface FleetView {
  provisioned: number; usable: number; measured: { value: number | null; evidence: string; explanation: string };
  active: number; available: number; cooling: number; unhealthy: number; backlog: { ready: number; leased: number; needsHuman: number };
  bottleneck: string; bottleneckExplanation: string; ifWeAddedCapacity: string;
  surfaces: { routineId: string; name: string; accountName: string; state: string; stateLabel: string; usable: boolean; reason: string | null;
    lastOutcome: string; lastFiredAt: string | null; consecutiveFailures: number; headroom: { used: number; limit: number | null };
    requiredAction: { who: string; problem: string; what: string; detail: string } | null }[];
}
export interface WorkforceJob { binId: string | null; title: string | null; routineName: string | null; since: string | null }
export interface WorkforceView {
  accounts: { accountId: string; name: string; status: string; statusSentence: string; routines: { total: number; usable: number; held: number };
    capacity: { inFlight: number; limit: number | null }; current: WorkforceJob[];
    last24h: { started: number; arrived: number; assigned: number; completed: number; handedBack: number; failed: number; researchPasses: number };
    lastWorkAt: string | null; nextQueued: WorkforceJob | null }[];
  queue: { ready: number; leased: number };
  totals: { connected: number; working: number; idleWithWork: number; completed24h: number; researchPasses24h: number; unattributed24h: number };
  movement: { at: string; accountName: string | null; title: string | null; event: string }[];
  windowHours: number; readAt: string;
}
export interface WorkEntry {
  id: string; source: string; group: 'WORKING_NOW' | 'UP_NEXT' | 'EXPLORING' | 'WAITING' | 'FINISHED'; title: string; why: string | null;
  state: string; waitingOn: string | null; updatedAt: string; priorityLabel: string | null; blocked: boolean;
}
export interface WorkResponse {
  missions: unknown[];
  work: { items: WorkEntry[]; emptyReason: string | null; explanation: string | null };
}
export interface FactoryFleet {
  ready: boolean; reason: string;
  capacity: { available: number; registered: number; rateLimited: number; quarantined: number; paused: number; ceilingEvidence: string };
  workers: { id: string; name: string; kind: string; model: string; modelClass: string; maxConcurrency: number; availability: string;
    rateLimitedUntil: string | null; consecutiveFailures: number }[];
}

// server/domain/types.ts (Russell conversations)
export interface Conversation { id: string; title: string; projectId: string | null; visibility: string; closedAt: string | null; createdAt: string; updatedAt: string }
export interface Message {
  id: string; conversationId: string; role: 'USER' | 'RUSSELL' | 'SYSTEM'; content: string; status: 'COMPLETE' | 'PENDING' | 'FAILED';
  pendingReason: string | null; pendingDetail?: string | null; createdAt: string;
}
export interface Thread { conversation: Conversation; turns: Message[] }

// server/services/integrations/health.ts
export interface IntegrationsView {
  integrations: { id: string; name: string; purpose: string; heldBy: string; state: string; detail: string;
    credentials: { name: string; where: string; required: boolean; state: string }[]; capabilities: string[];
    dailyCeiling: number | null; ownerAction: string | null; checkedAt: string; lastCheck: { recordedAt: string; state: string; detail: string } | null }[];
  repairs: { id: string; integrationId: string; kind: string; state: string; detail: string; recordedAt: string }[];
  ownerActions: { integration: string; action: string }[];
}
export interface OperatorIntegrations { integrations: { id: string; name: string; capabilities: string[]; health: { state: string; at: string; detail: string } | null; ownerAction: string | null }[] }

// server/services/cash/view.ts (FULL scope)
export interface CashPosition {
  currency: string; pipelineCents: number; customerPaymentsCents: number; availableFundsCents: number; unpaidCommitmentsCents: number;
  heldCommitmentsCents: number; reservesCents: number; deployableCents: number; completedContributionCents: number; shortfall: boolean;
}
export interface CashCommitment { id: string; amountCents: number; currency: string; purpose: string; expectedResult: string; stopCondition: string; state: string; spentCents: number | null; createdAt?: string }
export interface CashView {
  scope: 'FULL' | 'SHARED';
  authority?: { exists: boolean; lines: string[]; maxConcurrent: number; heldCents: number; maxCommittedCents: number; maxPerActionCents: number; committedCents: number; spentCents: number; allowedActions: string[] };
  myCash?: { position: CashPosition; entries: { entry: { id: string; kind: string; amountCents: number; currency: string; note?: string | null; occurredAt?: string; createdAt?: string; [k: string]: unknown }; effect: string }[]; commitments: CashCommitment[] };
}
export interface CashMode { root: { projectId: string; projectName: string } | null; mode: { state: string; currency: string; activatedAt: string; objective: string | null } | null; objective: { summary: string; full: string } }

export interface Deficiency { id: string; intervention: string; why: string; goalId: string | null; deficiency: string; title: string; observed: string; cause: string | null; [k: string]: unknown }
export interface EngineeringOutcome { candidateId: string; title: string; goalId: string | null; deficiency: string; intervention: string; stage: string; status: string; next: string; sentence: string; factory: { status: string; prUrl: string | null; deployed: boolean; verified: boolean } | null; measurement: { metric: string; before: unknown; after: unknown; verdict: string } | null }
export interface OperatorHistory { runs: { id: string; state: string; startedAt: string; summary: string | null; tools: string[]; error: unknown }[]; learnings: { goalId: string; lesson: string; evidence: string; at: string }[]; actions: { type: string; at: string; payload: unknown }[] }

export interface Health { ok: boolean; schemaVersion: number | string; revision?: string | null; driver?: string; providers: { name: string; available: boolean; reason: string | null; model: string | null }[] }

// server/services/russell/work.ts — the card facts added 2026-11-24
export interface WorkCard { startedAt: string | null; finishedAt: string | null; worker: string | null; result: string | null }
export interface WorkEntryFull extends WorkEntry {
  card?: WorkCard;
  links: { missionId: string | null; orchestrationId: string | null; binId: string | null; documentId: string | null; conversationId: string | null; layerId: string | null };
  how: { label: string; value: string }[];
  priorityReason: string | null;
}
export interface GoalWorkLink { binId: string; state: string; workerOnIt: boolean }

// server/services/operator/resources.ts
export interface ResourceReading {
  key: string; name: string; accomplishing: string; waiting: number | null; running: number | null; capacity: number | null;
  atLimit: boolean | null; idleBesideWork: boolean; why: string; brainDoing: string; spendingHelps: 'YES' | 'NO' | 'UNKNOWN';
  spending: string; costPerHour: number | null;
}
export interface ResourcesView { readAt: string | null; source: string; resources: ResourceReading[] }

// server/services/research/backlog.ts
export interface BacklogReading {
  readAt: string; total: number; launchable: number; obsolete: number; held: number;
  categories: { category: string; purpose: string; contribution: string; tier: number; count: number; launchable: number; obsolete: number; byPriority: Record<string, number>; finished7d: { done: number; useful: number; failed: number; cancelled: number } }[];
  goals: { goalId: string | null; title: string; state: string; count: number; obsolete: number; held: number }[];
  obsoleteReasons: { reason: string; text: string; count: number; retirable: boolean }[];
  samples: { category: string; title: string; obsolete: string | null }[];
  limits: string[];
}

// server/routes/command.ts GET /command/reports
export type Section<T> = { ok: true; value: T } | { ok: false; error: string };
export interface InventoryItem { id: string; status: string; capability: string; symptom: string; evidence: string; rootCause: string | null; severity: string; owner: string | null; verificationCriteria: string | null; result: string | null; verification: { kind: string; ref: string; detail: string } | null; note: string | null; updatedAt: string }
export interface ReportsView {
  readAt: string;
  inventory: Section<InventoryItem[]>;
  engineering: Section<EngineeringOutcome[]>;
  deficiencies: Section<{ diagnosis: Record<string, unknown> & { title?: string; deficiency?: string; observed?: string; cause?: string | null }; intervention: string; why: string }[]>;
  runs: Section<{ id: string; state: string; model: string; startedAt: string; finishedAt: string | null; summary: string | null; toolCalls: unknown[]; error: string | null }[]>;
  learnings: Section<{ id: string; goalId: string | null; lesson: string; evidence: string; recordedAt?: string }[]>;
  hourly: Section<{ noticeId: string; readyAt: string | null; subject: string; text: string }[]>;
  audits: Section<{ id: string; projectId: string; layerId: string | null; verdict: string; summary: string; confidence: number | null; mode: string; createdAt: string }[]>;
  interventions: Section<{ byKind: Record<string, number>; minutesAvoided: number; [k: string]: unknown }>;
}
