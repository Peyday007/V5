/**
 * The operational metareasoning controller (META-18-2, layer 3).
 *
 * "A controller identifies information needs and failure modes, selects tools
 * and alternative representations, decomposes tasks, generates multiple
 * independent hypotheses, compares them against real evidence, chooses the
 * next action based on decision value, tracks results, and modifies its
 * method when results invalidate the reasoning."
 *
 * `decideNext` is that controller as a pure function of a recorded snapshot —
 * the knowledge reading (`knowledgeModel.ts`), the mechanism model, the method
 * catalogue and its outcomes (`methodLibrary.ts`), the candidate actions, the
 * paired samples when a quantitative model exists, and the results of earlier
 * actions. Pure for the reason `intelligence/director.ts` gives: a decision
 * taken over recorded inputs can be explained afterwards.
 *
 * It is not a second orchestration engine. It owns no scheduler, queue, lease
 * or store. `recordControllerDecision` appends the decision through the
 * existing `recordBinEvent` writer, and `handOff` gives the chosen action to an
 * owner that already exists:
 *
 *   RESEARCH     → `quant/needs.ts` `sendNeeds` (a research uncertainty on the
 *                  named orchestration, or a research candidate)
 *   METHOD_GAP   → the method library's capability-gap and declared-method rows
 *   FACTORY      → the improvement loop's `registerDirected`, which is the
 *                  existing path from a weakness to a Factory objective
 *   EXPERIMENT / DECIDE → recorded only; the caller's own owner acts on it
 *
 * Decision value: with paired samples, an action is worth the expected value
 * of perfect information about the input it resolves (`quant/value.ts`), less
 * its cost. Without samples, it is worth how much its answer could move the
 * contest between the two leading hypotheses. An action whose answer cannot
 * change the decision is never chosen (§79).
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { informationValue, type InformationAction, type InformationInput } from '../quant/value.ts';
import { sendNeeds, type Need, type NeedDelivery } from '../quant/needs.ts';
import type { KnowledgeReading } from './knowledgeModel.ts';
import type { MechanismModel } from './knowledgeModel.ts';
import {
  detectWeakInferences,
  diagnoseCapabilityGap,
  recordCapabilityGap,
  recordDeclaredMethod,
  recordMethodOutcome,
  selectMethods,
  type CapabilityGap,
  type InferenceStep,
  type MethodJudgment,
  type MethodOutcome,
  type MethodSpec,
  type ProblemProfile,
  type WeakInference,
} from './methodLibrary.ts';

/* ------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* ------------------------------------------------------------------------- */

export interface Hypothesis {
  id: string;
  statement: string;
  /** What it was derived from — a representation, a failure mode, a counter-model. Two with one basis are not independent. */
  basis: string;
}

/** A piece of real evidence and which hypotheses it bears on. Only a sourced item counts. */
export interface EvidenceItem {
  id: string;
  source: string | null;
  bears: Record<string, 'SUPPORTS' | 'REFUTES'>;
}

export type ActionKind = 'RESEARCH' | 'EXPERIMENT' | 'METHOD_GAP' | 'FACTORY' | (string & {});

export interface CandidateAction {
  key: string;
  kind: ActionKind;
  subject: string;
  question: string;
  /** The input key (paired samples) or need this action resolves. */
  resolves: string;
  /** Hypotheses whose standing the answer would change. */
  discriminates: string[];
  /** In the same units as the decision value. 0 when unknown. */
  cost: number;
}

/** What came of an action taken earlier. */
export interface ActionResult {
  actionKey: string;
  hypothesisId: string;
  outcome: 'CONFIRMED' | 'CONTRADICTED' | 'INCONCLUSIVE';
  evidence: string | null;
  at: string;
  /** The `at` of the decision this result scores, so a result is tracked once against the decision it bears on. */
  decisionAt?: string | null;
}

/** The decision the controller made last time, as recorded. */
export interface PriorDecision {
  methodId: string | null;
  representation: string | null;
  leadingHypothesis: string | null;
  excludedMethods: string[];
}

export interface ControllerSnapshot {
  problem: ProblemProfile;
  knowledge: KnowledgeReading | null;
  mechanism: MechanismModel | null;
  catalogue: readonly MethodSpec[];
  outcomes: readonly MethodOutcome[];
  /** Hypotheses a caller already holds; the controller adds its own. */
  hypotheses?: readonly Hypothesis[];
  evidence: readonly EvidenceItem[];
  actions: readonly CandidateAction[];
  /** Paired samples from a quantitative model, when one exists. */
  worlds?: { inputs: InformationInput[]; actions: InformationAction[] } | null;
  /** The reasoning chain behind the current leading conclusion, if any. */
  chain?: readonly InferenceStep[];
  results?: readonly ActionResult[];
  prior?: PriorDecision | null;
  now?: string;
}

/* ------------------------------------------------------------------------- */
/* Decision                                                                   */
/* ------------------------------------------------------------------------- */

export interface FailureMode {
  kind: 'CONFLICTING_EVIDENCE' | 'OUTDATED_EVIDENCE' | 'UNKNOWN_MECHANISM' | 'WEAK_INFERENCE' | 'NO_FITTING_METHOD' | 'METHOD_INVALIDATED';
  subject: string;
  detail: string;
}

export interface Representation {
  id: string;
  methodId: string;
  why: string;
}

export interface Subproblem {
  key: string;
  question: string;
  from: 'KNOWLEDGE_NEED' | 'MECHANISM_UNKNOWN' | 'FAILURE_MODE';
}

export interface ScoredHypothesis extends Hypothesis {
  /** Laplace-smoothed share of sourced evidence that supports it. */
  score: number;
  supports: string[];
  refutes: string[];
}

export interface ValuedAction extends CandidateAction {
  value: number;
  net: number;
  valueBasis: 'INFORMATION_VALUE' | 'HYPOTHESIS_DISCRIMINATION';
}

export interface ControllerDecision {
  problemId: string;
  at: string;
  informationNeeds: string[];
  failureModes: FailureMode[];
  method: MethodJudgment | null;
  representation: Representation | null;
  alternativeRepresentations: Representation[];
  decomposition: Subproblem[];
  hypotheses: ScoredHypothesis[];
  leadingHypothesis: string | null;
  /** Every candidate with its decision value, best first. */
  valued: ValuedAction[];
  /** The action to take next, or null: then the best course is to decide on the leading hypothesis. */
  next: ValuedAction | null;
  /** DECIDE when no action's answer could change the decision. */
  verdict: 'ACT_ON_NEXT' | 'DECIDE';
  /** Set when a result invalidated the method or representation and the controller changed it. */
  methodChange: { from: string | null; to: string | null; reason: string } | null;
  excludedMethods: string[];
  weakInferences: WeakInference[];
  capabilityGap: CapabilityGap | null;
}

/** Score each hypothesis against the sourced evidence. Unsourced items are ignored, not weighed lightly. */
export function scoreHypotheses(hypotheses: readonly Hypothesis[], evidence: readonly EvidenceItem[]): ScoredHypothesis[] {
  return hypotheses
    .map((h) => {
      const supports: string[] = [];
      const refutes: string[] = [];
      for (const e of evidence) {
        if (!e.source) continue;
        const bearing = e.bears[h.id];
        if (bearing === 'SUPPORTS') supports.push(e.id);
        else if (bearing === 'REFUTES') refutes.push(e.id);
      }
      const score = Math.round(((supports.length + 1) / (supports.length + refutes.length + 2)) * 1000) / 1000;
      return { ...h, score, supports, refutes };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * The controller's own hypotheses: the mechanism as modelled under each
 * selected representation, and one counter-model per failure mode. Merged
 * with the caller's, one per basis so every hypothesis kept is independent.
 */
export function generateHypotheses(
  problem: ProblemProfile,
  representations: readonly Representation[],
  failureModes: readonly FailureMode[],
  given: readonly Hypothesis[] = [],
): Hypothesis[] {
  const out: Hypothesis[] = [...given];
  for (const r of representations) {
    out.push({ id: `holds:${r.id}`, statement: `${problem.question}: the transaction works as the ${r.id} representation models it`, basis: `representation:${r.id}` });
  }
  for (const f of failureModes) {
    if (f.kind === 'NO_FITTING_METHOD' || f.kind === 'WEAK_INFERENCE') continue;
    out.push({ id: `fails:${f.subject}`, statement: `${problem.question}: the transaction fails at ${f.subject} (${f.detail})`, basis: `counter:${f.subject}` });
  }
  const seen = new Set<string>();
  return out.filter((h) => {
    if (seen.has(h.basis) || seen.has(`id:${h.id}`)) return false;
    seen.add(h.basis);
    seen.add(`id:${h.id}`);
    return true;
  });
}

function failureModesOf(snapshot: ControllerSnapshot, weak: readonly WeakInference[]): FailureMode[] {
  const out: FailureMode[] = [];
  for (const claim of snapshot.knowledge?.claims ?? []) {
    if (claim.status === 'CONFLICTING') out.push({ kind: 'CONFLICTING_EVIDENCE', subject: claim.facet, detail: claim.reason });
    if (claim.status === 'OUTDATED') out.push({ kind: 'OUTDATED_EVIDENCE', subject: claim.facet, detail: claim.reason });
  }
  for (const role of snapshot.mechanism?.unknown ?? []) {
    out.push({ kind: 'UNKNOWN_MECHANISM', subject: role, detail: `no supported evidence says ${role}` });
  }
  for (const w of weak) out.push({ kind: 'WEAK_INFERENCE', subject: w.stepId, detail: `${w.type}: ${w.detail}` });
  // One failure mode per subject and kind.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.kind}\u0000${f.subject}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function decompose(snapshot: ControllerSnapshot, failureModes: readonly FailureMode[]): Subproblem[] {
  const out: Subproblem[] = [];
  for (const need of snapshot.knowledge?.needs ?? []) out.push({ key: `need:${need}`, question: `What does the evidence say about ${need}?`, from: 'KNOWLEDGE_NEED' });
  for (const role of snapshot.mechanism?.roles ?? []) {
    if (role.status === 'UNKNOWN') out.push({ key: `role:${role.role}`, question: role.question, from: 'MECHANISM_UNKNOWN' });
  }
  for (const f of failureModes) {
    if (f.kind === 'CONFLICTING_EVIDENCE') out.push({ key: `conflict:${f.subject}`, question: `Which of the conflicting claims about ${f.subject} holds here?`, from: 'FAILURE_MODE' });
  }
  return out;
}

/** Results that contradict the hypothesis the prior method was chosen to support. */
function invalidations(snapshot: ControllerSnapshot): ActionResult[] {
  const prior = snapshot.prior;
  if (!prior?.leadingHypothesis) return [];
  return (snapshot.results ?? []).filter((r) => r.outcome === 'CONTRADICTED' && r.hypothesisId === prior.leadingHypothesis);
}

/** Value each candidate action, best first. Pure. */
export function valueActions(
  actions: readonly CandidateAction[],
  hypotheses: readonly ScoredHypothesis[],
  worlds: ControllerSnapshot['worlds'],
): ValuedAction[] {
  const byInput = new Map<string, number>();
  if (worlds && worlds.actions.length > 0 && worlds.inputs.length > 0) {
    const reading = informationValue({ inputs: worlds.inputs, actions: worlds.actions });
    for (const i of reading.inputs) byInput.set(i.key, i.changesDecision ? i.value : 0);
  }
  const [first, second] = hypotheses;
  // How contested the lead is: 1 when the top two are level, 0 when one has it settled.
  const contest = first && second ? 1 - Math.abs(first.score - second.score) : first ? 1 - first.score : 0;
  const leaders = new Set([first?.id, second?.id].filter((x): x is string => Boolean(x)));

  return actions
    .map((a): ValuedAction => {
      let value: number;
      let valueBasis: ValuedAction['valueBasis'];
      if (byInput.has(a.resolves)) {
        value = byInput.get(a.resolves)!;
        valueBasis = 'INFORMATION_VALUE';
      } else {
        const touchesLead = a.discriminates.filter((h) => leaders.has(h)).length;
        // An answer bears on the decision only if it can move one of the two hypotheses contesting it.
        value = touchesLead === 0 ? 0 : contest * (touchesLead >= 2 ? 1 : 0.5);
        valueBasis = 'HYPOTHESIS_DISCRIMINATION';
      }
      value = Math.round(value * 1e6) / 1e6;
      return { ...a, value, net: Math.round((value - a.cost) * 1e6) / 1e6, valueBasis };
    })
    .sort((x, y) => y.net - x.net || y.value - x.value || x.key.localeCompare(y.key));
}

/**
 * The controller. Pure: the same snapshot gives the same decision.
 */
export function decideNext(snapshot: ControllerSnapshot): ControllerDecision {
  const at = snapshot.now ?? new Date().toISOString();
  const weakInferences = detectWeakInferences(snapshot.chain ?? []);

  // Method change: a result that contradicts what the method was chosen for counts against the method.
  const invalid = invalidations(snapshot);
  const excludedMethods = [...(snapshot.prior?.excludedMethods ?? [])];
  let outcomes = [...snapshot.outcomes];
  if (invalid.length > 0 && snapshot.prior?.methodId && !excludedMethods.includes(snapshot.prior.methodId)) {
    excludedMethods.push(snapshot.prior.methodId);
    outcomes = [
      ...outcomes,
      ...invalid.map((r) => ({
        methodId: snapshot.prior!.methodId!,
        problemId: snapshot.problem.id,
        domain: snapshot.problem.domain,
        features: snapshot.problem.features.map((f) => f.feature),
        succeeded: false,
        errorClass: 'hypothesis-contradicted',
        at: r.at,
      })),
    ];
  }

  const usable = snapshot.catalogue.filter((m) => !excludedMethods.includes(m.id));
  const selection = selectMethods(usable, snapshot.problem, outcomes, 3);
  const representations: Representation[] = selection.chosen.map((j) => ({
    id: j.methodId,
    methodId: j.methodId,
    why: j.reasons.slice(0, 3).join('; '),
  }));
  const method = selection.chosen[0] ?? null;
  const representation = representations[0] ?? null;

  const failureModes = failureModesOf(snapshot, weakInferences);
  if (selection.noFit) failureModes.push({ kind: 'NO_FITTING_METHOD', subject: snapshot.problem.domain, detail: 'no method in the catalogue fits this problem' });
  let methodChange: ControllerDecision['methodChange'] = null;
  if (invalid.length > 0) {
    const reason = `result ${invalid.map((r) => r.actionKey).join(', ')} contradicted ${snapshot.prior?.leadingHypothesis}, which ${snapshot.prior?.methodId ?? 'the prior method'} was chosen to establish`;
    failureModes.push({ kind: 'METHOD_INVALIDATED', subject: snapshot.prior?.methodId ?? 'method', detail: reason });
    methodChange = { from: snapshot.prior?.methodId ?? null, to: method?.methodId ?? null, reason };
  }

  const hypotheses = scoreHypotheses(
    generateHypotheses(snapshot.problem, representations, failureModes, snapshot.hypotheses ?? []),
    [
      ...snapshot.evidence,
      // A tracked result is evidence too, once it names where it was observed.
      ...(snapshot.results ?? [])
        .filter((r) => r.outcome !== 'INCONCLUSIVE')
        .map((r): EvidenceItem => ({ id: `result:${r.actionKey}`, source: r.evidence, bears: { [r.hypothesisId]: r.outcome === 'CONFIRMED' ? 'SUPPORTS' : 'REFUTES' } })),
    ],
  );

  let capabilityGap: CapabilityGap | null = null;
  const actions = [...snapshot.actions];
  if (selection.noFit || invalid.length > 0) {
    capabilityGap = diagnoseCapabilityGap(
      { problem: snapshot.problem, methodsTried: excludedMethods, errorClasses: invalid.map(() => 'hypothesis-contradicted') },
      snapshot.catalogue,
      outcomes,
    );
    if (selection.noFit) {
      // With no fitting method, obtaining one bears on every hypothesis.
      actions.push({
        key: `method-gap:${capabilityGap.proposedMethod.id}`,
        kind: 'METHOD_GAP',
        subject: capabilityGap.absentCapability,
        question: `Obtain or derive ${capabilityGap.absentCapability}, then verify it outside ${snapshot.problem.domain}`,
        resolves: capabilityGap.proposedMethod.id,
        discriminates: hypotheses.slice(0, 2).map((h) => h.id),
        cost: 0,
      });
    }
  }

  const valued = valueActions(actions, hypotheses, snapshot.worlds ?? null);
  const top = valued[0];
  const next = top && top.value > 0 && top.net > 0 ? top : null;

  return {
    problemId: snapshot.problem.id,
    at,
    informationNeeds: [...(snapshot.knowledge?.needs ?? []), ...(snapshot.mechanism?.unknown ?? []).map((r) => `mechanism:${r}`)],
    failureModes,
    method,
    representation,
    alternativeRepresentations: representations.slice(1),
    decomposition: decompose(snapshot, failureModes),
    hypotheses,
    leadingHypothesis: hypotheses[0]?.id ?? null,
    valued,
    next,
    verdict: next ? 'ACT_ON_NEXT' : 'DECIDE',
    methodChange,
    excludedMethods,
    weakInferences,
    capabilityGap,
  };
}

/** What the next decision needs to know about this one. */
export function priorOf(decision: ControllerDecision): PriorDecision {
  return {
    methodId: decision.method?.methodId ?? null,
    representation: decision.representation?.id ?? null,
    leadingHypothesis: decision.leadingHypothesis,
    excludedMethods: decision.excludedMethods,
  };
}

/* ------------------------------------------------------------------------- */
/* Rows and hand-off                                                          */
/* ------------------------------------------------------------------------- */

export const CONTROLLER_EVENTS = {
  DECISION: 'REASONING_CONTROLLER_DECISION',
  RESULT: 'REASONING_CONTROLLER_RESULT',
} as const;

export interface ControllerDeps {
  record?: typeof recordBinEvent;
  projectId?: string | null;
  caller?: string;
  sendNeeds?: typeof sendNeeds;
  /** The improvement loop's directed registration; loaded lazily so the loop can import this module. */
  registerDirected?: (weakness: import('../../domain/improvement.ts').Weakness, now?: Date) => Promise<{ candidate: { id: string }; created: boolean }>;
  recordCapabilityGap?: typeof recordCapabilityGap;
  recordDeclaredMethod?: typeof recordDeclaredMethod;
  recordDecision?: typeof recordControllerDecision;
}

/** Append the decision through the existing writer. */
export async function recordControllerDecision(decision: ControllerDecision, deps: ControllerDeps = {}): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: CONTROLLER_EVENTS.DECISION,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'reasoning-controller',
    outcome: decision.methodChange ? 'METHOD_CHANGED' : decision.verdict,
    reason: (decision.next ? `${decision.next.kind} ${decision.next.key}` : `decide on ${decision.leadingHypothesis ?? 'nothing'}`).slice(0, 480),
    measures: { decision },
  });
}

/** Track a result: one row, and one method outcome so the library learns from it. */
export async function recordActionResult(
  result: ActionResult,
  decision: { problemId: string; method: Pick<MethodJudgment, 'methodId'> | null },
  problem: ProblemProfile,
  deps: ControllerDeps = {},
): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: CONTROLLER_EVENTS.RESULT,
    projectId: deps.projectId ?? null,
    workloadClass: deps.caller ?? 'reasoning-controller',
    outcome: result.outcome,
    reason: `${result.actionKey} → ${result.hypothesisId}`.slice(0, 480),
    measures: { result, problemId: decision.problemId, methodId: decision.method?.methodId ?? null, decisionAt: result.decisionAt ?? null },
  });
  if (decision.method && result.outcome !== 'INCONCLUSIVE') {
    await recordMethodOutcome(
      {
        methodId: decision.method.methodId,
        problemId: problem.id,
        domain: problem.domain,
        features: problem.features.map((f) => f.feature),
        succeeded: result.outcome === 'CONFIRMED',
        errorClass: result.outcome === 'CONTRADICTED' ? 'hypothesis-contradicted' : null,
        at: result.at,
      },
      { record: deps.record, projectId: deps.projectId ?? null, caller: deps.caller },
    );
  }
}

export type HandOff =
  | { to: 'RESEARCH'; deliveries: NeedDelivery[] }
  | { to: 'METHOD_GAP'; method: string }
  | { to: 'FACTORY'; candidateId: string; created: boolean }
  | { to: 'NONE'; reason: string };

export interface HandOffContext {
  projectId: string | null;
  actorRef: string;
  orchestrationId?: string | null;
}

/** Give the chosen action to the owner that already exists for it. */
export async function handOff(decision: ControllerDecision, ctx: HandOffContext, deps: ControllerDeps = {}): Promise<HandOff> {
  const next = decision.next;
  if (!next) return { to: 'NONE', reason: 'no action could change the decision; decide on the leading hypothesis' };

  if (next.kind === 'RESEARCH') {
    if (!ctx.projectId) return { to: 'NONE', reason: 'a research need is sent within a project, and none was named' };
    const need: Need = { subject: next.subject, question: next.question, route: 'RESEARCH', permissions: [] };
    const deliveries = await (deps.sendNeeds ?? sendNeeds)({
      projectId: ctx.projectId,
      actorRef: ctx.actorRef,
      graphScope: `controller:${decision.problemId}`,
      needs: [need],
      orchestrationId: ctx.orchestrationId ?? null,
    });
    return { to: 'RESEARCH', deliveries };
  }

  if (next.kind === 'METHOD_GAP' && decision.capabilityGap) {
    const rowDeps = { record: deps.record, projectId: ctx.projectId, caller: deps.caller ?? 'reasoning-controller' };
    await (deps.recordCapabilityGap ?? recordCapabilityGap)(decision.capabilityGap, rowDeps);
    if (decision.capabilityGap.remedy === 'DERIVE') await (deps.recordDeclaredMethod ?? recordDeclaredMethod)(decision.capabilityGap.proposedMethod, rowDeps);
    return { to: 'METHOD_GAP', method: decision.capabilityGap.proposedMethod.id };
  }

  if (next.kind === 'FACTORY') {
    const register = deps.registerDirected ?? (await import('../improvement/loop.ts')).registerDirected;
    const { candidate, created } = await register({
      key: `reasoning:${next.key}`.slice(0, 120),
      kind: 'REASONING_CAPABILITY',
      title: next.subject.slice(0, 200),
      problem: next.question.slice(0, 1000),
      metric: 'READY_OPPORTUNITIES_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'research/reasoningController',
      mutationScope: ['server/services/research/**', 'server/services/quant/**'],
      frequency: 1,
      denominator: 1,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: next.question.slice(0, 300),
      samples: [decision.problemId],
      knownCause: decision.methodChange?.reason ?? null,
    });
    return { to: 'FACTORY', candidateId: candidate.id, created };
  }

  return { to: 'NONE', reason: `${next.kind} is acted on by the caller's own owner; the decision is recorded` };
}

/** Decide, record, and hand off. The one entry point a caller needs. */
export async function runController(
  snapshot: ControllerSnapshot,
  ctx: HandOffContext,
  deps: ControllerDeps = {},
): Promise<{ decision: ControllerDecision; handOff: HandOff }> {
  const decision = decideNext(snapshot);
  const rowDeps = { ...deps, projectId: deps.projectId ?? ctx.projectId };
  await (deps.recordDecision ?? recordControllerDecision)(decision, rowDeps);
  // A method a result invalidated names the capability that was absent, whatever the next action is:
  // the gap is the library's to obtain or derive, not a request for more facts about this one case.
  if (decision.methodChange && decision.capabilityGap && decision.next?.kind !== 'METHOD_GAP') {
    const gapDeps = { record: rowDeps.record, projectId: rowDeps.projectId ?? null, caller: rowDeps.caller ?? 'reasoning-controller' };
    await (deps.recordCapabilityGap ?? recordCapabilityGap)(decision.capabilityGap, gapDeps);
    if (decision.capabilityGap.remedy === 'DERIVE') await (deps.recordDeclaredMethod ?? recordDeclaredMethod)(decision.capabilityGap.proposedMethod, gapDeps);
  }
  const handed = await handOff(decision, ctx, rowDeps);
  return { decision, handOff: handed };
}

/* ------------------------------------------------------------------------- */
/* History: the controller's own rows, read back                              */
/* ------------------------------------------------------------------------- */

/** One problem's latest recorded decision, and the results tracked against it since. */
export interface ControllerHistory {
  problemId: string;
  decidedAt: string;
  prior: PriorDecision;
  /** Results recorded after the latest decision: the ones the next decision has not yet consumed. */
  results: ActionResult[];
}

function isActionResult(v: unknown): v is ActionResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['actionKey'] === 'string' && typeof r['hypothesisId'] === 'string' && typeof r['outcome'] === 'string' && typeof r['at'] === 'string';
}

/**
 * Fold decision and result rows, oldest first, into each problem's history. A
 * decision resets the pending results, because the decision that followed a
 * result already consumed it. Pure, so the fold is testable without rows.
 */
export function foldControllerHistory(
  rows: readonly { eventType: string; measures: Record<string, unknown> }[],
): Map<string, ControllerHistory> {
  const out = new Map<string, ControllerHistory>();
  for (const row of rows) {
    if (row.eventType === CONTROLLER_EVENTS.DECISION) {
      const d = row.measures['decision'] as Partial<ControllerDecision> | undefined;
      if (!d || typeof d.problemId !== 'string' || typeof d.at !== 'string') continue;
      out.set(d.problemId, {
        problemId: d.problemId,
        decidedAt: d.at,
        prior: {
          methodId: d.method?.methodId ?? null,
          representation: d.representation?.id ?? null,
          leadingHypothesis: d.leadingHypothesis ?? null,
          excludedMethods: Array.isArray(d.excludedMethods) ? d.excludedMethods.filter((m): m is string => typeof m === 'string') : [],
        },
        results: [],
      });
    } else if (row.eventType === CONTROLLER_EVENTS.RESULT) {
      const problemId = row.measures['problemId'];
      const result = row.measures['result'];
      if (typeof problemId !== 'string' || !isActionResult(result)) continue;
      const h = out.get(problemId);
      if (h) h.results.push(result);
    }
  }
  return out;
}

/** Read one caller's controller history from `bin_events`, the rows the existing writer appended. */
export async function readControllerHistory(caller: string, limit = 5000): Promise<Map<string, ControllerHistory>> {
  const rows = await getDb().all<{ event_type: string; measures: string | null; at: string }>(
    `SELECT event_type, measures, at, id FROM bin_events
      WHERE workload_class = ? AND event_type IN (?, ?)
      ORDER BY at DESC, id DESC LIMIT ?`,
    [caller, CONTROLLER_EVENTS.DECISION, CONTROLLER_EVENTS.RESULT, Math.max(1, Math.floor(limit))],
  );
  // Ids are random, so rows written in the same millisecond tie on `at` in no particular order. A result is
  // only ever recorded after the decision it answers, so within one instant the decision is folded first;
  // otherwise the decision would reset the results it was meant to carry.
  const rank = (t: string) => (t === CONTROLLER_EVENTS.DECISION ? 0 : 1);
  const ordered = rows.reverse().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a.event_type) - rank(b.event_type)));
  const parsed: { eventType: string; measures: Record<string, unknown> }[] = [];
  for (const row of ordered) {
    try {
      const m: unknown = row.measures ? JSON.parse(row.measures) : null;
      if (m && typeof m === 'object') parsed.push({ eventType: row.event_type, measures: m as Record<string, unknown> });
    } catch {
      // A row that does not parse is skipped, never guessed.
    }
  }
  return foldControllerHistory(parsed);
}
