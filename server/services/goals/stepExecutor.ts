/**
 * Who performs a plan's step, and — separately — whether it needs the owner's
 * approval. Owner, 2026-11-20:
 *
 *   "Do not construct plans that quietly assign substantial recurring work to
 *   the owner. Brain should identify how its own agents, tools, connected
 *   services, and authorized external providers will perform the necessary
 *   operations … Do not represent approval authority as routine labor. Do not
 *   assume Brain can perform an action merely because it can describe that
 *   action."
 *
 * What was wrong: a step carried one word, `owner: 'BRAIN' | 'PERSON'`, set
 * from its cost and from words in its text, so a $350 inbox purchase (an
 * approval: money leaves the owner's pot), "Collect payment" (Brain's work
 * through Stripe, once the owner connects it) and "Sell … through a partner"
 * (Brain's outreach, with an agreement the owner signs) all read `[PERSON]`,
 * and nothing said whether Brain could do any step at all.
 *
 * The rule: a step is an operation from a closed vocabulary
 * (`STEP_OPERATIONS`), chosen by the builder from the step's structure (an
 * arrangement's stage, a reconstruction change's dimension) — never from its
 * wording. Each operation names the capabilities it needs. The executor is
 * read from what Brain has registered: the integration registry (§103) and the
 * capability vocabulary with its live readers (`cash/capabilities.ts`). A
 * capability neither declares is CAPABILITY_MISSING, with what to acquire; one
 * declared but not connected is a permission (and, when only the owner can
 * supply its credential, a one-time CREDENTIAL approval). Approval is its own
 * list — a payment, a legal commitment, a credential, a standing grant — and
 * is never the executor.
 */
import type { StepPerformer } from '../../domain/planIntegrity.ts';
import { CAPABILITIES, DELIVERABLE_CAPABILITIES, readCapabilities } from '../cash/capabilities.ts';
import { integrationsView } from '../integrations/health.ts';
import { INTEGRATIONS } from '../integrations/registry.ts';

/* ------------------------------------------------------------------ */
/* What Brain has registered                                            */
/* ------------------------------------------------------------------ */

/**
 * PRESENT — read usable now. NOT_CONNECTED — implemented and declared, and its
 * connection or credential is absent now. UNREAD — declared, and not read
 * (no reading was taken, or the reader could not answer). NOT_DECLARED — no
 * integration and no capability reader provides it: Brain cannot do it.
 */
export type CapabilityAvailability = 'PRESENT' | 'NOT_CONNECTED' | 'UNREAD' | 'NOT_DECLARED';

export interface InventoryEntry {
  id: string;
  state: CapabilityAvailability;
  /** The integrations or Brain operations that provide it, by name. */
  via: string[];
  /** What makes it usable, when it is not: the registry's owner action or the capability's next step. */
  remedy: string | null;
  /** Only the owner can supply what is missing (no automatic repair is under way). */
  ownerOnly: boolean;
}

export interface CapabilityInventory {
  /** Whether connection states were read, or only declarations are known. */
  read: boolean;
  entries: Record<string, InventoryEntry>;
}

/** Capabilities Brain's own code provides with no external integration. */
const INTERNAL_PROVIDER: Record<string, string> = Object.fromEntries(
  DELIVERABLE_CAPABILITIES.map((one) => [one.id, "Brain's deliverable renderers"]),
);

/**
 * Every capability Brain has registered, with no state read: the integration
 * registry's declared capabilities, and the capability vocabulary's entries
 * that have a reader (an entry with no reader, such as SIGN_AN_AGREEMENT, is a
 * word for something no integration provides). Pure.
 */
export function declaredInventory(): CapabilityInventory {
  const entries: Record<string, InventoryEntry> = {};
  const add = (id: string, via: string) => {
    const e = (entries[id] ??= { id, state: 'UNREAD', via: [], remedy: null, ownerOnly: false });
    if (!e.via.includes(via)) e.via.push(via);
  };
  for (const one of INTEGRATIONS) for (const cap of one.capabilities) add(cap, one.name);
  for (const one of [...CAPABILITIES, ...DELIVERABLE_CAPABILITIES]) {
    if (one.read && !entries[one.id]) add(one.id, INTERNAL_PROVIDER[one.id] ?? 'Brain');
  }
  return { read: false, entries };
}

const INTEGRATION_AVAILABILITY: Record<string, CapabilityAvailability> = {
  CONNECTED: 'PRESENT',
  CONFIGURED: 'PRESENT',
  REPAIRING: 'UNREAD',
  UNREACHABLE: 'UNREAD',
  NEEDS_OWNER: 'NOT_CONNECTED',
  REFUSED: 'NOT_CONNECTED',
  NOT_IN_USE: 'NOT_CONNECTED',
};
const RANK: Record<CapabilityAvailability, number> = { PRESENT: 0, UNREAD: 1, NOT_CONNECTED: 2, NOT_DECLARED: 3 };

/**
 * The inventory read now: each declared capability's state from the
 * capability vocabulary's live reader where it has one (the same reading
 * `missingPermissions` and `deliveryReading` use), else from the health of the
 * integrations that declare it (`integrationsView`: presence, then the newest
 * recorded live check). A read that fails leaves every state UNREAD, never
 * PRESENT (invariant 39).
 */
export async function readCapabilityInventory(): Promise<CapabilityInventory> {
  const base = declaredInventory();
  try {
    const view = await integrationsView();
    const vocabulary = new Set([...CAPABILITIES, ...DELIVERABLE_CAPABILITIES].filter((one) => one.read).map((one) => one.id));
    const readings = new Map((await readCapabilities(Object.keys(base.entries).filter((id) => vocabulary.has(id)))).map((r) => [r.id, r]));
    for (const entry of Object.values(base.entries)) {
      const providers = view.integrations.filter((one) => one.capabilities.includes(entry.id));
      const reading = readings.get(entry.id);
      const fromProviders = providers.map((one) => INTEGRATION_AVAILABILITY[one.state] ?? 'UNREAD').sort((a, b) => RANK[a] - RANK[b])[0];
      entry.state = reading
        ? reading.state === 'PRESENT' ? 'PRESENT' : reading.state === 'MISSING' ? 'NOT_CONNECTED' : 'UNREAD'
        : (fromProviders ?? 'UNREAD');
      // Name the providers that are usable first.
      const usable = providers.filter((one) => INTEGRATION_AVAILABILITY[one.state] === 'PRESENT').map((one) => one.name);
      if (usable.length > 0) entry.via = [...usable, ...entry.via.filter((v) => !usable.includes(v))];
      if (entry.state === 'NOT_CONNECTED') {
        entry.remedy = providers.map((one) => one.ownerAction).find((a): a is string => !!a) ?? reading?.definition?.nextStep ?? null;
        entry.ownerOnly = !providers.some((one) => one.state === 'REPAIRING');
      }
    }
    return { read: true, entries: base.entries };
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ */
/* The operations a step can be                                         */
/* ------------------------------------------------------------------ */

interface OperationSpec {
  /** What performing it is, in words. */
  does: string;
  /** Capabilities it needs: every group, any one capability within a group. */
  needs: readonly (readonly string[])[];
  /** Recurring or operational work (each buyer, each deal, each period). */
  routine: boolean;
  /** The step acquires a capability. */
  acquisition?: boolean;
  /** Another party performs the work; Brain's `needs` are its own part. */
  byProvider?: boolean;
}

const LIST = ['FIND_PUBLISHED_CONTACTS', 'DISCOVER_LOCAL_BUSINESSES', 'FIND_DECISION_MAKERS', 'RESEARCH_A_QUESTION'];
const SEND = ['SEND_A_MESSAGE'];
const REPLIES = ['READ_REPLIES'];
const BILL = ['ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT'];
const PRODUCE = [...DELIVERABLE_CAPABILITIES.map((one) => one.id), 'BUILD_SOFTWARE'];

export const STEP_OPERATIONS = {
  RESEARCH: { does: 'research the question and record sourced answers', needs: [['RESEARCH_A_QUESTION', 'CHEAP_MODEL_READS']], routine: false },
  REACH_BUYERS: { does: 'build the buyer list, send the outreach and read the replies', needs: [LIST, SEND, REPLIES], routine: true },
  SEND_OFFER: { does: 'send the offer and read the replies', needs: [SEND, REPLIES], routine: true },
  NEGOTIATE_TERMS: { does: 'ask for and negotiate written terms by message', needs: [SEND, REPLIES], routine: false },
  RECRUIT_PARTNER: { does: 'find a partner who already serves the buyers and agree referral terms by message', needs: [LIST, SEND, REPLIES], routine: false },
  BUY_SENDING_CAPACITY: { does: 'buy and connect sending inboxes', needs: [['BUY_SENDING_INBOXES']], routine: false, acquisition: true },
  BUY_PAID_LEADS: { does: 'buy leads through an advertising platform or lead marketplace', needs: [['BUY_PAID_LEADS']], routine: true },
  SET_OFFER: { does: 'change the offer Brain sends (its price or shape)', needs: [SEND], routine: false },
  SET_PAYMENT_TERMS: { does: 'change how buyers pay (a deposit, prepayment)', needs: [BILL], routine: false },
  COLLECT_PAYMENT: { does: 'invoice each buyer and read the payment', needs: [BILL], routine: true },
  PAY_SUPPLIER: { does: 'pay the supplier for each order', needs: [['PAY_A_SUPPLIER']], routine: true },
  SUPPLIER_DELIVERS: { does: 'deliver to each buyer, Brain confirming delivery by message', needs: [SEND, REPLIES], routine: true, byProvider: true },
  BRAIN_PRODUCES: { does: 'produce and verify the deliverable for each buyer', needs: [PRODUCE], routine: true },
  PLAN_DECISION: { does: "a decision the goal's planner makes and applies", needs: [], routine: false },
  OWNER_TASK: { does: 'work the plan gives the owner', needs: [], routine: false },
} as const satisfies Record<string, OperationSpec>;
export type StepOperation = keyof typeof STEP_OPERATIONS;

/** What must be acquired for a capability nothing registered provides. */
const ACQUIRE: Record<string, string> = {
  BUY_PAID_LEADS: 'an advertising or lead-marketplace account (Google Ads, Meta, Thumbtack) declared as an integration Brain operates under a spending grant (§103)',
  PAY_A_SUPPLIER: 'a way for Brain to pay a supplier under a spending grant (a payout or bill-pay integration declared in the registry, §103)',
  BUY_SENDING_INBOXES: 'an inbox seller Brain can order from (Instantly or InboxKit, §110)',
};
const acquireFor = (cap: string) => ACQUIRE[cap] ?? `an integration that provides ${cap}, declared in the registry (§103)`;

/** Standing authorities a plan needs granted once (`planAuthority`): a permission, and an approval, never labor. */
const GRANT = /^(CONTACT_BUYER|QUOTE_AND_INVOICE|ACCEPT_PAYMENT)$/;

/* ------------------------------------------------------------------ */
/* The executor record                                                  */
/* ------------------------------------------------------------------ */

export type ApprovalKind = 'PAYMENT' | 'LEGAL_COMMITMENT' | 'CREDENTIAL' | 'STANDING_GRANT' | 'AUTHORITY';

export interface ApprovalReason {
  kind: ApprovalKind;
  why: string;
  /** Given once (a connection, a grant, a signature) rather than at each occurrence. */
  once: boolean;
}

export interface StepExecutor {
  performedBy: StepPerformer;
  operation: StepOperation;
  /** What performing it is. */
  does: string;
  /** Brain's integrations and operations that perform it (Brain's own part, when a provider performs the work). */
  via: string[];
  /** The supplier or partner that performs the work, when one does. */
  provider: string | null;
  /** The capabilities it needs, each with the state it was read in. */
  capabilities: { id: string; state: CapabilityAvailability }[];
  routine: boolean;
  acquisition: boolean;
  /** What must be acquired before it can be performed. */
  acquire: string[];
  /** One-time permissions and connections it needs that are not in place. */
  permissions: string[];
  /** Whether the owner's approval is needed, and why. Never labor. */
  approval: { needed: boolean; reasons: ApprovalReason[] };
}

export interface OperationRequest {
  operation: StepOperation;
  /** The supplier or partner that performs the work, by name. */
  provider?: string | null;
  /** Money the step commits from the owner's account (major units); a positive figure is a PAYMENT approval. */
  cost?: number | null;
  /** A payment the step makes, in words, whatever its figure (an order paid from buyers' money; an unestablished cost). */
  pays?: string | null;
  /** A legal commitment in the owner's name, in words. */
  signs?: string | null;
  /**
   * A decision or authority only the owner holds that the step waits on (the
   * goal's next test names one: a grant, a connection, how much may be
   * committed). An approval, never the owner doing the step.
   */
  authority?: string | null;
  /** OWNER_TASK: why the owner, and whether it is routine. */
  ownerTask?: { why: string; routine: boolean } | null;
  /** The step's execution dependencies (`PlanStep.execution`): grants and providers not in place. */
  execution?: readonly string[];
  /** Overrides whether it is routine (an operation used once in this plan). */
  routine?: boolean;
}

const money = (n: number) => `${Math.round(n).toLocaleString('en-US')}`;

/**
 * The executor of one step: read from the inventory, never from the step's
 * words. Pure.
 */
export function stepExecutor(req: OperationRequest, inventory: CapabilityInventory = declaredInventory()): StepExecutor {
  const spec: OperationSpec = STEP_OPERATIONS[req.operation];
  const capabilities: StepExecutor['capabilities'] = [];
  const via: string[] = [];
  const acquire: string[] = [];
  const permissions: string[] = [];
  const reasons: ApprovalReason[] = [];
  for (const group of spec.needs) {
    const held = group.map((id) => inventory.entries[id]).filter((e): e is InventoryEntry => !!e).sort((a, b) => RANK[a.state] - RANK[b.state]);
    const best = held[0];
    if (!best) {
      for (const id of group) capabilities.push({ id, state: 'NOT_DECLARED' });
      acquire.push(group.length === 1 ? acquireFor(group[0]!) : `one of ${group.join(', ')}: ${acquireFor(group[0]!)}`);
      continue;
    }
    capabilities.push({ id: best.id, state: best.state });
    for (const v of best.via.slice(0, 1)) if (!via.includes(`${v} (${best.id})`)) via.push(`${v} (${best.id})`);
    if (best.state === 'NOT_CONNECTED') {
      permissions.push(`${best.via[0] ?? best.id} connected for ${best.id}${best.remedy ? `: ${best.remedy}` : ''}`);
      if (best.ownerOnly) reasons.push({ kind: 'CREDENTIAL', why: `${best.via[0] ?? best.id} is not connected, and only the owner can supply its credential`, once: true });
    }
  }
  for (const one of req.execution ?? []) {
    if (permissions.some((p) => p.startsWith(one))) continue;
    if (GRANT.test(one)) {
      permissions.push(`standing authority for ${one} on this project`);
      reasons.push({ kind: 'STANDING_GRANT', why: `Brain's standing authority for ${one} on this project is not granted`, once: true });
    } else if (!capabilities.some((c) => c.state === 'NOT_CONNECTED')) {
      permissions.push(one);
    }
  }
  if (req.cost !== null && req.cost !== undefined && req.cost > 0) reasons.push({ kind: 'PAYMENT', why: `${money(req.cost)} from the owner's money, inside the goal's limits`, once: false });
  else if (req.pays) reasons.push({ kind: 'PAYMENT', why: req.pays, once: false });
  if (req.authority) reasons.push({ kind: 'AUTHORITY', why: req.authority, once: true });
  if (req.signs) reasons.push({ kind: 'LEGAL_COMMITMENT', why: req.signs, once: true });
  if (req.operation === 'BUY_SENDING_CAPACITY' && !reasons.some((r) => r.kind === 'PAYMENT')) {
    reasons.push({ kind: 'PAYMENT', why: 'from the inbox pot the owner funds (`inboxes fund`), priced by the seller first (§110)', once: false });
  }
  const routine = req.ownerTask ? req.ownerTask.routine : (req.routine ?? spec.routine);
  const performedBy: StepPerformer =
    req.operation === 'OWNER_TASK' ? 'OWNER' : acquire.length > 0 ? 'CAPABILITY_MISSING' : spec.byProvider ? 'PROVIDER' : 'BRAIN';
  return {
    performedBy,
    operation: req.operation,
    does: req.operation === 'OWNER_TASK' && req.ownerTask ? req.ownerTask.why : spec.does,
    via: spec.needs.length === 0 && req.operation !== 'OWNER_TASK' ? ["the goal's planner"] : via,
    provider: req.provider ?? (spec.byProvider ? 'the supplier' : null),
    capabilities,
    routine,
    acquisition: spec.acquisition === true,
    acquire,
    permissions: [...new Set(permissions)],
    approval: { needed: reasons.length > 0, reasons },
  };
}

/* ------------------------------------------------------------------ */
/* How a person reads it                                                */
/* ------------------------------------------------------------------ */

const KIND_WORDS: Record<ApprovalKind, string> = {
  PAYMENT: 'payment',
  LEGAL_COMMITMENT: 'legal commitment',
  CREDENTIAL: 'credential',
  STANDING_GRANT: 'standing grant',
  AUTHORITY: "the owner's decision",
};

/** "performed by …" for one step. Pure. */
export function performedBySentence(e: StepExecutor): string {
  const through = e.via.length > 0 ? ` through ${e.via.join(', ')}` : '';
  switch (e.performedBy) {
    case 'BRAIN':
      return `Brain${through}${e.provider ? `, with ${e.provider}` : ''}`;
    case 'PROVIDER':
      return `${e.provider ?? 'a provider'}; Brain's part${through}`;
    case 'OWNER':
      return `the owner (${e.does})${e.routine ? ' — ROUTINE work' : ''}`;
    case 'CAPABILITY_MISSING':
      return `nobody yet — CAPABILITY MISSING: acquire ${e.acquire.join('; ')}`;
  }
}

/** "approval needed: yes (…)" or "approval needed: no". Pure. */
export function approvalSentence(e: StepExecutor): string {
  if (!e.approval.needed) return 'approval needed: no';
  return `approval needed: yes (${e.approval.reasons.map((r) => `${KIND_WORDS[r.kind]}${r.once ? ', once' : ''}: ${r.why}`).join('; ')})`;
}

/** One line per step: performed by X; approval needed: yes/no (why). Pure. */
export function executorLine(e: StepExecutor): string {
  return `performed by ${performedBySentence(e)}; ${approvalSentence(e)}`;
}

export interface PlanExecution {
  /** What Brain performs automatically, step by step. */
  brain: string[];
  /** What other systems or providers perform. */
  providers: string[];
  /** Capabilities that must be acquired. */
  acquire: string[];
  /** Permissions and connections required. */
  permissions: string[];
  /** Money the plan commits, and the services it depends on. */
  costs: string[];
  dependencies: string[];
  /** Actions that genuinely require the owner's approval. */
  approvals: string[];
  /** Work the plan gives the owner (the design objective is none that is routine). */
  ownerWork: string[];
}

/**
 * The plan's execution in the six parts the owner named (2026-11-20), read
 * from its steps' executor records. Pure.
 */
export function planExecution(steps: readonly { order: number; label: string; cost: number | null; executor?: StepExecutor }[]): PlanExecution {
  const out: PlanExecution = { brain: [], providers: [], acquire: [], permissions: [], costs: [], dependencies: [], approvals: [], ownerWork: [] };
  const uniq = (list: string[], one: string) => {
    if (!list.includes(one)) list.push(one);
  };
  for (const s of steps) {
    const e = s.executor;
    if (!e) continue;
    const name = `step ${s.order} (${s.label.slice(0, 60)})`;
    if (e.performedBy === 'BRAIN') out.brain.push(`${name}: ${e.does}${e.via.length ? ` — ${e.via.join(', ')}` : ''}`);
    if (e.performedBy === 'PROVIDER' || e.provider) out.providers.push(`${name}: ${e.provider ?? 'a provider'}`);
    if (e.performedBy === 'OWNER') out.ownerWork.push(`${name}: ${e.does}${e.routine ? ' (routine)' : ' (one-off)'}`);
    if (e.acquisition) uniq(out.acquire, `${name} acquires it: ${e.does}`);
    for (const a of e.acquire) uniq(out.acquire, a);
    for (const p of e.permissions) uniq(out.permissions, p);
    for (const v of e.via) uniq(out.dependencies, v);
    if (s.cost !== null && s.cost > 0) out.costs.push(`${name}: ${money(s.cost)}`);
    for (const r of e.approval.reasons) uniq(out.approvals, `${KIND_WORDS[r.kind]}${r.once ? ' (once)' : ''}: ${r.why} — ${name}`);
  }
  return out;
}
