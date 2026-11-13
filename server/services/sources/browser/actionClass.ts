/**
 * What a browser workflow would do to the world, judged before it runs
 * (ACQ-21-5).
 *
 * `browserWorkflow.ts` operates a site through recorded steps. Operating a site
 * can read it and it can change it, and those are very different things: a
 * read may be repeated, retried and run thousands of times, while a mutation
 * changes state that somebody else owns, and some mutations (a purchase, a
 * publication, a message sent, a deletion) cannot be taken back at all. So each
 * step, and the workflow as a whole, is classified as one of:
 *
 *  - IDEMPOTENT_READ: navigation, waiting, checking the page, extracting text,
 *    downloading, filling a search or filter and showing its results. Running it
 *    twice changes nothing.
 *  - MUTATION: submitting a form, saving, creating, updating, uploading. It
 *    changes state, so it runs only as an already-approved action.
 *  - CONSEQUENTIAL: destructive or externally consequential: buying, paying,
 *    ordering, publishing, sending, deleting, cancelling, transferring, signing
 *    an agreement. It runs only under an approval that names it as
 *    consequential, and it is detected here, before any step is submitted.
 *
 * The judgment reads the step itself: its kind, its locator's role, accessible
 * name, label, test id, selector or text, the form it submits, and the address
 * it navigates to. It never reads the host, and it names no host, category or
 * industry: the same steps on any site are judged the same way. Every label
 * carries the evidence it rests on, so Brain records the judgment per case
 * (approved reading of S-0301) instead of applying an unexplained rule.
 *
 * An approval is bound to the exact step it approved (its index and a
 * fingerprint of its content). A step that changed after approval is a
 * different step, and its old approval does not cover it. An approval for a
 * MUTATION never covers a CONSEQUENTIAL step.
 *
 * Pure: no I/O, no clock, no database. The caller records the judgment.
 */
import { createHash } from 'node:crypto';
import type { BrowserWorkflow, Locator, WorkflowStep } from '../browserWorkflow.ts';

export const ACTION_CLASSES = ['IDEMPOTENT_READ', 'MUTATION', 'CONSEQUENTIAL'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

const RANK: Record<ActionClass, number> = { IDEMPOTENT_READ: 0, MUTATION: 1, CONSEQUENTIAL: 2 };

/** The more consequential of two classes. Pure. */
export function moreConsequential(a: ActionClass, b: ActionClass): ActionClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Whether an approval granted for `approved` covers a step judged `needed`. Pure. */
export function covers(approved: ActionClass, needed: ActionClass): boolean {
  return RANK[approved] >= RANK[needed];
}

export interface StepJudgment {
  index: number;
  kind: WorkflowStep['kind'];
  actionClass: ActionClass;
  /** Content fingerprint of the step; an approval is bound to it. */
  fingerprint: string;
  /** What the label rests on, in words a reviewer can check against the step. */
  evidence: string[];
}

export interface WorkflowJudgment {
  actionClass: ActionClass;
  steps: StepJudgment[];
  /** Indexes of the steps that change state (MUTATION or CONSEQUENTIAL), in order. */
  effectSteps: number[];
  /** The first step that is CONSEQUENTIAL, or null. Known before any step runs. */
  firstConsequential: number | null;
}

/** A person's (or a recorded policy's) approval of one effectful step. */
export interface ApprovedAction {
  stepIndex: number;
  /** The step fingerprint the approval was given for. */
  fingerprint: string;
  actionClass: ActionClass;
  approvedBy: string;
  approvedAt: string;
}

export interface ActionRefusal {
  index: number;
  actionClass: ActionClass;
  reason: string;
}

export interface ActionAuthorization {
  permitted: boolean;
  judgment: WorkflowJudgment;
  refusals: ActionRefusal[];
  /** The approvals that were actually used, one per effectful step. */
  used: ApprovedAction[];
}

/* ------------------------------------------------------------------------- */
/* Signals                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Verbs whose effect is destructive or reaches outside the session. They are
 * actions, not domains: nothing here names a kind of site.
 */
const CONSEQUENTIAL_SIGNAL =
  /\b(buy|purchase|place[ -]?order|order now|submit order|confirm (order|purchase|payment)|check ?out|pay|payment|subscribe|donate|bid|publish|post now|go live|send|reply|delete|remove|erase|destroy|discard|cancel|unsubscribe|terminate|close account|deactivate|transfer|withdraw|refund|wire|sign (the )?(contract|agreement|document)|e-?sign|accept (offer|terms|agreement)|approve|reject|decline|archive)\b/i;

/** Verbs that change state without being irreversible on their face. */
const MUTATION_SIGNAL =
  /\b(submit|save|update|edit|create|add|new|register|sign ?up|join|apply|upload|attach|import|enroll|book|reserve|request|invite|share|rename|move|assign|set|change|enable|disable|connect|link account|follow|like|vote|rate|comment|confirm)\b/i;

/**
 * Controls whose effect is only to show something: a search, a filter, paging,
 * sorting, opening a detail view. A submit of one of these is a read.
 */
const READ_SIGNAL =
  /\b(search|find|look ?up|filter|refine|sort|show|view|display|open|expand|collapse|more|next|previous|prev|back|page|go to|details?|results?|preview|refresh|reload|export|download|print|close|dismiss|ok|got it|tab|menu)\b/i;

/** Roles that navigate or reveal rather than act. */
const READ_ROLES = new Set(['link', 'tab', 'menuitem', 'treeitem', 'option', 'searchbox', 'combobox', 'row', 'cell', 'heading', 'img']);

/** URL path segments that perform an action when merely visited. */
const CONSEQUENTIAL_PATH = /\/(delete|remove|destroy|cancel|unsubscribe|checkout|pay|purchase|order\/confirm|publish|send|transfer|withdraw)(\/|$|\?)/i;
const MUTATION_PATH = /\/(logout|log-out|signout|sign-out|create|new|edit|update|save|submit|confirm|approve|activate)(\/|$|\?)/i;

function locatorWords(loc: Locator | undefined): string[] {
  if (!loc) return [];
  const words: string[] = [];
  for (const key of ['name', 'label', 'text', 'testId', 'css'] as const) {
    const v = loc[key];
    if (typeof v === 'string' && v.trim()) words.push(`${key}=${JSON.stringify(v.trim())}`);
  }
  return words;
}

/** The locator's human-meaningful text, with test-id and selector separators read as spaces. */
function locatorText(loc: Locator | undefined): string {
  if (!loc) return '';
  return [loc.name, loc.label, loc.text, loc.testId, loc.css]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-#.[\]="':>]+/g, ' ');
}

function describe(loc: Locator | undefined): string {
  const parts = loc?.role ? [`role=${loc.role}`, ...locatorWords(loc)] : locatorWords(loc);
  return parts.length ? parts.join(' ') : 'no locator';
}

/** Content fingerprint of one step. Pure and stable for equal content. */
export function stepFingerprint(step: WorkflowStep): string {
  return createHash('sha256').update(canonical(step)).digest('hex').slice(0, 32);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/* ------------------------------------------------------------------------- */
/* Classification                                                             */
/* ------------------------------------------------------------------------- */

interface FormContext {
  /** Indexes of fields filled, selected or checked since the last submission. */
  pending: number[];
  /** Whether every pending field reads as a search or filter control. */
  allSearch: boolean;
}

function isSearchField(loc: Locator | undefined): boolean {
  if (!loc) return false;
  if (loc.role === 'searchbox') return true;
  const text = locatorText(loc);
  return /\b(search|find|query|keyword|filter|look ?up|q)\b/i.test(text) && !MUTATION_SIGNAL.test(text.replace(/\b(search|filter)\b/gi, ''));
}

/** Judge a submission (a click on a control, or a fill that submits) against the form it sends. */
function judgeSubmission(text: string, role: string | undefined, form: FormContext, evidence: string[]): ActionClass {
  const consequential = text.match(CONSEQUENTIAL_SIGNAL);
  if (consequential) {
    evidence.push(`the control says "${consequential[0]}", which is destructive or externally consequential`);
    return 'CONSEQUENTIAL';
  }
  const mutation = text.match(MUTATION_SIGNAL);
  if (mutation) {
    evidence.push(`the control says "${mutation[0]}", which changes state`);
    return 'MUTATION';
  }
  const read = text.match(READ_SIGNAL);
  if (read && (form.pending.length === 0 || form.allSearch)) {
    evidence.push(`the control says "${read[0]}", which only shows information`);
    return 'IDEMPOTENT_READ';
  }
  if (form.pending.length > 0 && !form.allSearch) {
    evidence.push(`it submits the form filled at step(s) ${form.pending.join(', ')}, which are not search or filter fields`);
    return 'MUTATION';
  }
  if (form.pending.length > 0) {
    evidence.push(`it submits only search or filter fields (step(s) ${form.pending.join(', ')})`);
    return 'IDEMPOTENT_READ';
  }
  if (role && READ_ROLES.has(role)) {
    evidence.push(`a ${role} navigates or reveals; nothing is submitted`);
    return 'IDEMPOTENT_READ';
  }
  if (role === 'button' || /\bsubmit\b/i.test(text)) {
    evidence.push('a button with no form pending and no state-changing words');
    return 'IDEMPOTENT_READ';
  }
  evidence.push('no form is pending and the control carries no state-changing words');
  return 'IDEMPOTENT_READ';
}

/**
 * Classify every step of a workflow, in order, carrying the form being filled
 * from step to step so a submit is judged against what it sends. Pure: depends
 * only on the steps, never on the host.
 */
export function classifyWorkflow(workflow: Pick<BrowserWorkflow, 'steps'>): WorkflowJudgment {
  const steps: StepJudgment[] = [];
  let form: FormContext = { pending: [], allSearch: true };
  const reset = (): void => {
    form = { pending: [], allSearch: true };
  };
  const addField = (index: number, loc: Locator | undefined): void => {
    form.pending.push(index);
    form.allSearch &&= isSearchField(loc);
  };

  (workflow.steps ?? []).forEach((step, index) => {
    const evidence: string[] = [];
    let actionClass: ActionClass = 'IDEMPOTENT_READ';
    switch (step.kind) {
      case 'navigate': {
        let path = '';
        try {
          const u = new URL(step.url);
          path = `${u.pathname}${u.search}`;
        } catch {
          path = step.url;
        }
        const c = path.match(CONSEQUENTIAL_PATH);
        const m = path.match(MUTATION_PATH);
        if (c) {
          actionClass = 'CONSEQUENTIAL';
          evidence.push(`visiting ${JSON.stringify(path)} performs "${c[1]}" by address alone`);
        } else if (m) {
          actionClass = 'MUTATION';
          evidence.push(`visiting ${JSON.stringify(path)} performs "${m[1]}" by address alone`);
        } else {
          evidence.push('a navigation reads a page');
        }
        reset();
        break;
      }
      case 'wait':
      case 'expect':
        evidence.push(`a ${step.kind} step only observes the page`);
        break;
      case 'extract':
        evidence.push('an extract step copies text the page already shows');
        break;
      case 'download':
        evidence.push('a download retrieves a file the page offers; nothing is submitted');
        break;
      case 'fill':
      case 'select':
      case 'check': {
        addField(index, step.locator);
        if (step.kind === 'fill' && step.submit) {
          actionClass = judgeSubmission(locatorText(step.locator), step.locator.role, form, evidence);
          evidence.unshift(`it fills ${describe(step.locator)} and submits`);
          reset();
        } else {
          evidence.push(`it sets ${describe(step.locator)} without submitting; the effect, if any, is the submission's`);
        }
        break;
      }
      case 'click': {
        evidence.push(`it clicks ${describe(step.locator)}`);
        actionClass = judgeSubmission(locatorText(step.locator), step.locator.role, form, evidence);
        if (form.pending.length > 0) reset();
        break;
      }
    }
    steps.push({ index, kind: step.kind, actionClass, fingerprint: stepFingerprint(step), evidence });
  });

  const actionClass = steps.reduce<ActionClass>((acc, s) => moreConsequential(acc, s.actionClass), 'IDEMPOTENT_READ');
  const effectSteps = steps.filter((s) => s.actionClass !== 'IDEMPOTENT_READ').map((s) => s.index);
  const firstConsequential = steps.find((s) => s.actionClass === 'CONSEQUENTIAL')?.index ?? null;
  return { actionClass, steps, effectSteps, firstConsequential };
}

/**
 * Whether a workflow may run given the approvals recorded for it. Every
 * effectful step needs its own approval, bound to its index and fingerprint and
 * granted for at least its class. A read-only workflow needs none. Pure: it is
 * decided before any step is submitted, and the refusal names each step.
 */
export function authorizeActions(workflow: Pick<BrowserWorkflow, 'steps'>, approvals: readonly ApprovedAction[]): ActionAuthorization {
  const judgment = classifyWorkflow(workflow);
  const refusals: ActionRefusal[] = [];
  const used: ApprovedAction[] = [];
  for (const index of judgment.effectSteps) {
    const step = judgment.steps[index]!;
    const forIndex = approvals.filter((a) => a.stepIndex === index);
    const exact = forIndex.filter((a) => a.fingerprint === step.fingerprint);
    const sufficient = exact.find((a) => covers(a.actionClass, step.actionClass));
    if (sufficient) {
      used.push(sufficient);
      continue;
    }
    let reason: string;
    if (forIndex.length === 0) reason = `step ${index} is ${step.actionClass} and has no approval`;
    else if (exact.length === 0) reason = `step ${index} changed after it was approved; its approval covers a different step`;
    else reason = `step ${index} is ${step.actionClass} but was approved only as ${exact[0]!.actionClass}`;
    refusals.push({ index, actionClass: step.actionClass, reason });
  }
  return { permitted: refusals.length === 0, judgment, refusals, used };
}
