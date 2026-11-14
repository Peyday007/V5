/**
 * Who would perform an opening's delivery, and whether Brain may be credited
 * with it (PORT-05, source S-0064).
 *
 * "AI can perform substantial discovery, writing, research, analysis, coding,
 * sales preparation, coordination and, when proven suitable, fulfillment. When
 * human or physical capability is required, Brain can find and organize
 * independent providers while the owner remains physically absent. Do not
 * credit Brain with a delivery capability merely because it can discuss it;
 * demonstrate capability with appropriate real-world or production evidence.
 * Don't confuse self-operable businesses with services that the owner must
 * perform personally."
 *
 * The approved reading of S-0064: Brain judges fitness per case from evidence
 * and records the judgment; no fixed rule is implied. So this module holds no
 * list of industries, categories or deliverables that are "AI work". It reads
 * one opening's rows and answers three questions, each with the evidence that
 * answered it:
 *
 *   * **Who performs the delivery** — `SELF_OPERABLE` (Brain's own work: the
 *     Factory, the research pipeline, a deliverable renderer), `PROVIDER_ORGANIZED`
 *     (an independent person or supplier does the human or physical part while
 *     the owner stays physically absent) or `OWNER_PERFORMED` (the owner must do
 *     it personally). When no row and no stated fact says, the mode is `null`:
 *     not knowing is an answer, never a favourable assumption (invariant 39).
 *   * **Whether Brain is credited with the delivery** — only on real-world or
 *     production evidence: every delivery capability the opening needs reads
 *     `PRESENT` from `services/cash/capabilities.ts` (each of which is itself a
 *     reading of a row or a proof this process ran), or Brain's own fulfilment
 *     of this opening is recorded as delivered or accepted, or settled money
 *     for a delivery Brain performed. A card's prose, a research claim or a
 *     model being able to talk about the task credits nothing; the judgment
 *     names exactly which evidence is missing instead.
 *   * **What is AI-performable regardless** — discovery, writing, research,
 *     analysis, coding, sales preparation and coordination are work Brain does
 *     on any opening (`AI_PERFORMABLE_WORK`); fulfilment is credited only when
 *     proven. Owner-performed delivery is never reported as self-operable.
 *
 * The judgment is recorded on the opening's own append-only ledger
 * (`cash_events`, kind `CAPABILITY_CREDIT_JUDGED`) — no new store — and only
 * when it differs from the newest one recorded, so re-judging an unchanged
 * opening writes nothing.
 */
import { createHash } from 'node:crypto';
import type { CapabilityReading, CapabilityState } from '../cash/capabilities.ts';
import type { FulfillmentKind } from '../../domain/cashFulfillment.ts';

/** The work Brain performs on any opening, whatever is delivered. Fulfilment is not in it. */
export const AI_PERFORMABLE_WORK = [
  'DISCOVERY',
  'WRITING',
  'RESEARCH',
  'ANALYSIS',
  'CODING',
  'SALES_PREPARATION',
  'COORDINATION',
] as const;
export type AiPerformableWork = (typeof AI_PERFORMABLE_WORK)[number];

export const DELIVERY_MODES = ['SELF_OPERABLE', 'PROVIDER_ORGANIZED', 'OWNER_PERFORMED'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const CAPABILITY_CREDIT_EVENT = 'CAPABILITY_CREDIT_JUDGED';

/**
 * Capabilities that sell, collect or contract rather than deliver. They gate
 * the commercial action they name (each blocks only its own action, §65), and
 * say nothing about whether Brain can perform the delivery itself.
 */
export const COMMERCIAL_CAPABILITIES: ReadonlySet<string> = new Set([
  'SEND_A_MESSAGE',
  'ISSUE_AN_INVOICE',
  'TAKE_A_PAYMENT',
  'ISSUE_A_REFUND',
  'PUBLISH_A_LISTING',
  'SIGN_AN_AGREEMENT',
]);

/** A fulfilment kind whose work is Brain's own machinery, completion read from its rows (§27). */
const BRAIN_PERFORMED_KINDS: ReadonlySet<FulfillmentKind> = new Set<FulfillmentKind>(['SOFTWARE', 'RESEARCH']);

/** Fulfilment events that say the delivery landed. A worker's "done" is not among them. */
const DELIVERED_EVENTS: ReadonlySet<string> = new Set(['DELIVERED', 'ACCEPTED']);

/** Settled-outcome kinds that only exist after a delivery happened and was paid for. */
const DELIVERY_OUTCOMES: ReadonlySet<string> = new Set(['REALIZED_CONTRIBUTION', 'FULFILLMENT_DURATION']);

export interface CreditFulfilment {
  id: string;
  kind: FulfillmentKind;
  performer: string;
  supplierName: string | null;
  declaredBy: string;
}

export interface CreditFulfilmentEvent {
  id: string;
  fulfillmentId: string;
  kind: string;
  evidenceRef: string | null;
}

export interface CreditOutcome {
  id: string;
  kind: string;
  valueCents: number | null;
}

/** Everything one judgment reads. Every field comes from a row; nothing is a caller's claim. */
export interface CreditCase {
  opportunityId: string;
  projectId: string;
  /** The opening's `required_capabilities`. */
  requiredCapabilities: readonly string[];
  /** The reading of each capability now (`readingFrom`); an id absent here is UNKNOWN. */
  capabilityStates: ReadonlyMap<string, CapabilityState>;
  /** The opening's free-text `fulfillment_owner`: a description, which can classify but never credit. */
  fulfillmentOwner: string | null;
  /** The opening's free-text `delivery_method`, read the same way. */
  deliveryMethod: string | null;
  fulfilments: readonly CreditFulfilment[];
  fulfilmentEvents: readonly CreditFulfilmentEvent[];
  outcomes: readonly CreditOutcome[];
}

export interface CreditEvidence {
  /** What kind of row it is. */
  kind: 'CAPABILITY' | 'FULFILMENT' | 'FULFILMENT_EVENT' | 'OUTCOME' | 'STATED';
  /** The row id or capability id it resolves to. */
  ref: string;
  note: string;
}

export interface CapabilityCredit {
  opportunityId: string;
  projectId: string;
  /** Who performs the delivery; null when nothing establishes it. */
  mode: DeliveryMode | null;
  /** Whether Brain is credited with performing the delivery itself. */
  credited: boolean;
  /** For PROVIDER_ORGANIZED: the provider's delivery is evidenced (credit is the provider's, never Brain's). */
  providerDelivered: boolean;
  /** True for PROVIDER_ORGANIZED: the owner does not have to be physically present. */
  ownerPhysicallyAbsent: boolean | null;
  /** The work Brain performs on this opening regardless of delivery. */
  aiPerformable: readonly AiPerformableWork[];
  /** Delivery capabilities this opening needs, with their reading. */
  deliveryCapabilities: { id: string; state: CapabilityState }[];
  evidence: CreditEvidence[];
  /** Exactly what is missing before Brain could be credited; empty when credited. */
  missingEvidence: string[];
  reason: string;
}

const OWNER_WORDS = /\b(?:the owner|owner(?:'s)? (?:own|personally|himself|herself|themselves)|i will|i'll|myself|me personally|in person by the owner)\b/i;
const PROVIDER_WORDS = /\b(?:subcontract(?:or|ed|ing)?|contractor|freelancer|supplier|vendor|provider|agency|partner|third[- ]party|outsourc(?:e|ed|ing))\b/i;

function normal(text: string): string {
  return text.trim().toLowerCase();
}

/** A PERSON fulfilment performed by whoever declared it, or by "owner": the owner doing it personally. */
function performedByOwner(f: CreditFulfilment): boolean {
  const performer = normal(f.performer);
  return performer === 'owner' || performer === 'the owner' || (performer.length > 0 && performer === normal(f.declaredBy));
}

/** The delivery mode from rows first, then from what the opening states; null when neither says. */
function deliveryMode(input: CreditCase, deliveryCaps: string[], evidence: CreditEvidence[]): DeliveryMode | null {
  // A declared fulfilment is a row: it names who performs the obligation an agreement created.
  const owner = input.fulfilments.find((f) => f.kind === 'PERSON' && performedByOwner(f));
  if (owner) {
    evidence.push({ kind: 'FULFILMENT', ref: owner.id, note: `performed by ${owner.performer}, who declared it: the owner doing it personally` });
    return 'OWNER_PERFORMED';
  }
  const provider = input.fulfilments.find((f) => f.kind === 'SUPPLIER' || f.kind === 'PERSON');
  if (provider) {
    evidence.push({ kind: 'FULFILMENT', ref: provider.id, note: `${provider.kind === 'SUPPLIER' ? 'supplier' : 'an independent person'} ${provider.supplierName ?? provider.performer} performs it` });
    return 'PROVIDER_ORGANIZED';
  }
  const brain = input.fulfilments.find((f) => BRAIN_PERFORMED_KINDS.has(f.kind));
  if (brain) {
    evidence.push({ kind: 'FULFILMENT', ref: brain.id, note: `${brain.kind === 'SOFTWARE' ? 'the Software Factory' : 'the research pipeline'} performs it` });
    return 'SELF_OPERABLE';
  }
  // No fulfilment declared yet. What the opening states can classify — toward
  // the owner or a provider, which never credits Brain — and a delivery
  // capability Brain has a word for says the work is Brain's kind of work.
  const stated = [input.fulfillmentOwner, input.deliveryMethod].filter((t): t is string => !!t && t.trim().length > 0).join(' — ');
  if (stated && OWNER_WORDS.test(stated)) {
    evidence.push({ kind: 'STATED', ref: input.opportunityId, note: `the opening states the owner performs it: "${stated.slice(0, 120)}"` });
    return 'OWNER_PERFORMED';
  }
  if (stated && PROVIDER_WORDS.test(stated)) {
    evidence.push({ kind: 'STATED', ref: input.opportunityId, note: `the opening states a provider performs it: "${stated.slice(0, 120)}"` });
    return 'PROVIDER_ORGANIZED';
  }
  const known = deliveryCaps.filter((id) => input.capabilityStates.has(id) && input.capabilityStates.get(id) !== 'UNKNOWN');
  if (deliveryCaps.length > 0 && known.length === deliveryCaps.length) {
    evidence.push({ kind: 'STATED', ref: input.opportunityId, note: `the delivery needs ${deliveryCaps.join(', ')}, which Brain's own machinery performs` });
    return 'SELF_OPERABLE';
  }
  return null;
}

/**
 * Judge one opening. Pure: the same rows always give the same judgment.
 *
 * Credit is Brain's only when the mode is SELF_OPERABLE and production
 * evidence exists — every delivery capability PRESENT, or Brain's own
 * fulfilment of this opening delivered or accepted, or settled money for it.
 */
export function judgeCapabilityCredit(input: CreditCase): CapabilityCredit {
  const evidence: CreditEvidence[] = [];
  const deliveryIds = [...new Set(input.requiredCapabilities.map((id) => id.trim()).filter((id) => id.length > 0 && !COMMERCIAL_CAPABILITIES.has(id)))];
  const deliveryCapabilities = deliveryIds.map((id) => ({ id, state: input.capabilityStates.get(id) ?? ('UNKNOWN' as CapabilityState) }));
  const mode = deliveryMode(input, deliveryIds, evidence);

  const brainFulfilments = new Set(input.fulfilments.filter((f) => BRAIN_PERFORMED_KINDS.has(f.kind)).map((f) => f.id));
  const providerFulfilments = new Set(input.fulfilments.filter((f) => !BRAIN_PERFORMED_KINDS.has(f.kind)).map((f) => f.id));
  const brainDelivered = input.fulfilmentEvents.filter((e) => brainFulfilments.has(e.fulfillmentId) && DELIVERED_EVENTS.has(e.kind));
  const providerDeliveredEvents = input.fulfilmentEvents.filter((e) => providerFulfilments.has(e.fulfillmentId) && DELIVERED_EVENTS.has(e.kind));
  const settled = input.outcomes.filter((o) => DELIVERY_OUTCOMES.has(o.kind));
  const allPresent = deliveryCapabilities.length > 0 && deliveryCapabilities.every((c) => c.state === 'PRESENT');

  const missingEvidence: string[] = [];
  let credited = false;
  let reason: string;

  if (mode === 'SELF_OPERABLE') {
    for (const c of deliveryCapabilities.filter((one) => one.state === 'PRESENT')) {
      evidence.push({ kind: 'CAPABILITY', ref: c.id, note: 'reads PRESENT now' });
    }
    for (const e of brainDelivered) {
      evidence.push({ kind: 'FULFILMENT_EVENT', ref: e.id, note: `Brain's own fulfilment recorded ${e.kind}${e.evidenceRef ? ` (${e.evidenceRef})` : ''}` });
    }
    // Settled money proves a delivery only when Brain performed it.
    const settledBrain = brainFulfilments.size > 0 ? settled : [];
    for (const o of settledBrain) evidence.push({ kind: 'OUTCOME', ref: o.id, note: `settled ${o.kind}` });
    credited = allPresent || brainDelivered.length > 0 || settledBrain.length > 0;
    if (credited) {
      reason = allPresent
        ? `Brain is credited: every delivery capability reads PRESENT (${deliveryCapabilities.map((c) => c.id).join(', ')})`
        : `Brain is credited: its own delivery of this opening is on record`;
    } else {
      for (const c of deliveryCapabilities.filter((one) => one.state !== 'PRESENT')) {
        missingEvidence.push(`${c.id} reads ${c.state}: no proof Brain can perform it`);
      }
      if (deliveryCapabilities.length === 0) missingEvidence.push('the opening names no delivery capability a proof could read');
      missingEvidence.push('no delivered, accepted or settled delivery by Brain is recorded for this opening');
      reason = 'Not credited: the delivery is Brain\'s kind of work, but nothing has proved Brain can perform it';
    }
  } else if (mode === 'PROVIDER_ORGANIZED') {
    for (const e of providerDeliveredEvents) {
      evidence.push({ kind: 'FULFILMENT_EVENT', ref: e.id, note: `the provider's delivery recorded ${e.kind}${e.evidenceRef ? ` (${e.evidenceRef})` : ''}` });
    }
    missingEvidence.push('the delivery is a provider\'s, so Brain is credited with organizing it, never with performing it');
    reason = providerDeliveredEvents.length > 0
      ? 'Provider-organized: an independent provider delivered it while the owner stayed physically absent; Brain is credited with the coordination only'
      : 'Provider-organized: an independent provider performs the human or physical work; Brain finds and organizes them and the owner stays physically absent';
  } else if (mode === 'OWNER_PERFORMED') {
    missingEvidence.push('the owner must perform the delivery personally, so it is not a self-operable business');
    reason = 'Owner-performed: a service the owner must perform personally, never counted as self-operable';
  } else {
    missingEvidence.push('nobody has established who would perform the delivery: no fulfilment is declared and the opening states none');
    for (const c of deliveryCapabilities.filter((one) => one.state !== 'PRESENT')) {
      missingEvidence.push(`${c.id} reads ${c.state}`);
    }
    reason = 'Not credited: who performs the delivery is unknown, and an unknown is not a capability';
  }

  return {
    opportunityId: input.opportunityId,
    projectId: input.projectId,
    mode,
    credited,
    providerDelivered: mode === 'PROVIDER_ORGANIZED' && providerDeliveredEvents.length > 0,
    ownerPhysicallyAbsent: mode === 'PROVIDER_ORGANIZED' || mode === 'SELF_OPERABLE' ? true : mode === 'OWNER_PERFORMED' ? false : null,
    aiPerformable: AI_PERFORMABLE_WORK,
    deliveryCapabilities,
    evidence,
    missingEvidence: credited ? [] : missingEvidence,
    reason,
  };
}

/** What makes two judgments the same: everything but the free-text notes' wording. */
export function creditFingerprint(credit: CapabilityCredit): string {
  const canonical = JSON.stringify({
    mode: credit.mode,
    credited: credit.credited,
    providerDelivered: credit.providerDelivered,
    caps: credit.deliveryCapabilities.map((c) => `${c.id}=${c.state}`).sort(),
    evidence: credit.evidence.map((e) => `${e.kind}:${e.ref}`).sort(),
    missing: [...credit.missingEvidence].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export interface CreditRecordPorts {
  /** The newest recorded judgment's fingerprint for this opening, or null. */
  latestFingerprint(opportunityId: string): Promise<string | null>;
  record(credit: CapabilityCredit, fingerprint: string): Promise<void>;
}

/**
 * Record a judgment once: written only when it differs from the newest one on
 * the opening's ledger, so a tick that re-judges an unchanged opening writes nothing.
 */
export async function recordCapabilityCredit(credit: CapabilityCredit, ports: CreditRecordPorts): Promise<{ recorded: boolean; fingerprint: string }> {
  const fingerprint = creditFingerprint(credit);
  if ((await ports.latestFingerprint(credit.opportunityId)) === fingerprint) return { recorded: false, fingerprint };
  await ports.record(credit, fingerprint);
  return { recorded: true, fingerprint };
}

/** The production ledger: the opening's own `cash_events`. */
export async function productionCreditPorts(): Promise<CreditRecordPorts> {
  const { cashEventsOfKind, recordCashEvent } = await import('../../repos/cashMode.ts');
  return {
    async latestFingerprint(opportunityId) {
      const events = await cashEventsOfKind(opportunityId, CAPABILITY_CREDIT_EVENT);
      const newest = events.at(-1);
      return newest && typeof newest.detail.fingerprint === 'string' ? newest.detail.fingerprint : null;
    },
    async record(credit, fingerprint) {
      await recordCashEvent({
        projectId: credit.projectId,
        opportunityId: credit.opportunityId,
        kind: CAPABILITY_CREDIT_EVENT,
        actorRef: 'BRAIN',
        summary: credit.reason.slice(0, 400),
        detail: {
          fingerprint,
          mode: credit.mode,
          credited: credit.credited,
          providerDelivered: credit.providerDelivered,
          ownerPhysicallyAbsent: credit.ownerPhysicallyAbsent,
          aiPerformable: [...credit.aiPerformable],
          deliveryCapabilities: credit.deliveryCapabilities,
          evidence: credit.evidence,
          missingEvidence: credit.missingEvidence,
        },
      });
    },
  };
}

/** Read one opening's rows into a case. Null when the opening does not exist. */
export async function readCreditCase(opportunityId: string, capabilityReadings?: ReadonlyMap<string, CapabilityReading>): Promise<CreditCase | null> {
  const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
  const { fulfillmentsForOpportunity, fulfillmentEvents } = await import('../../repos/cashFulfillment.ts');
  const { outcomesFor } = await import('../../repos/cashJourney.ts');
  const { readAllCapabilities, readingFrom } = await import('../cash/capabilities.ts');
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) return null;
  // Read now, never cached across judgments: a capability lost an hour ago must not still credit.
  const readings = capabilityReadings ?? (await readAllCapabilities());
  const capabilityStates = new Map<string, CapabilityState>();
  for (const id of opportunity.requiredCapabilities) {
    const key = id.trim();
    if (key) capabilityStates.set(key, readingFrom(readings, key).state);
  }
  const fulfilments = await fulfillmentsForOpportunity(opportunity.projectId, opportunity.id);
  const events = (await Promise.all(fulfilments.map((f) => fulfillmentEvents(f.id)))).flat();
  const outcomes = await outcomesFor({ projectId: opportunity.projectId, opportunityId: opportunity.id });
  return {
    opportunityId: opportunity.id,
    projectId: opportunity.projectId,
    requiredCapabilities: opportunity.requiredCapabilities,
    capabilityStates,
    fulfillmentOwner: opportunity.fulfillmentOwner,
    deliveryMethod: opportunity.deliveryMethod,
    fulfilments: fulfilments.map((f) => ({ id: f.id, kind: f.kind, performer: f.performer, supplierName: f.supplierName, declaredBy: f.declaredBy })),
    fulfilmentEvents: events.map((e) => ({ id: e.id, fulfillmentId: e.fulfillmentId, kind: e.kind, evidenceRef: e.evidenceRef })),
    outcomes: outcomes.map((o) => ({ id: o.id, kind: o.kind, valueCents: o.valueCents })),
  };
}

/** Judge an opening from its rows and record the judgment if it changed. */
export async function judgeAndRecordCapabilityCredit(opportunityId: string, ports?: CreditRecordPorts): Promise<(CapabilityCredit & { recorded: boolean }) | null> {
  const input = await readCreditCase(opportunityId);
  if (!input) return null;
  const credit = judgeCapabilityCredit(input);
  const { recorded } = await recordCapabilityCredit(credit, ports ?? (await productionCreditPorts()));
  return { ...credit, recorded };
}

/* --------------------------------------------------- the scheduled recording */

/**
 * How often the whole-Brain goals tick re-judges and records the openings live
 * goals pursue. A judgment is written only when it changed, so this bounds the
 * reading cost (one capability read, then each opening's rows), not the rows.
 */
export const CREDIT_RECORD_EVERY_MS = 30 * 60_000;

/** Opening states whose delivery is no longer a question: never re-judged. */
const SETTLED_STATES: ReadonlySet<string> = new Set(['ARCHIVED', 'DECLINED', 'COLLECTED']);

export interface CreditRecordingReport {
  judged: number;
  recorded: number;
  /** Openings whose judgment could not be taken, with why; the rest still recorded. */
  failed: { opportunityId: string; error: string }[];
}

export interface CreditRecordingDeps {
  ports?: CreditRecordPorts;
  readCase?: (opportunityId: string, readings: ReadonlyMap<string, CapabilityReading>) => Promise<CreditCase | null>;
  readCapabilities?: () => Promise<ReadonlyMap<string, CapabilityReading>>;
  /** The opening's state, so settled ones are skipped; null when it does not exist. */
  stateOf?: (opportunityId: string) => Promise<string | null>;
}

/**
 * Judge each opening from its rows and record the judgment on its own ledger
 * when it differs from the newest one there (the approved reading of S-0064:
 * Brain judges fitness per case from evidence and records the judgment).
 * Capabilities are read once for the pass, so every opening is judged against
 * the same moment. One opening failing never stops the others.
 */
export async function recordCapabilityCredits(opportunityIds: readonly string[], deps: CreditRecordingDeps = {}): Promise<CreditRecordingReport> {
  const report: CreditRecordingReport = { judged: 0, recorded: 0, failed: [] };
  const unique = [...new Set(opportunityIds.filter(Boolean))];
  if (unique.length === 0) return report;
  const ports = deps.ports ?? (await productionCreditPorts());
  const stateOf =
    deps.stateOf ??
    (async (id: string) => {
      const { getOpportunity } = await import('../../repos/cashPortfolio.ts');
      return (await getOpportunity(id))?.state ?? null;
    });
  const readings = await (deps.readCapabilities ?? (async () => (await import('../cash/capabilities.ts')).readAllCapabilities()))();
  const readCase = deps.readCase ?? readCreditCase;
  for (const id of unique) {
    try {
      const state = await stateOf(id);
      if (state === null || SETTLED_STATES.has(state)) continue;
      const input = await readCase(id, readings);
      if (!input) continue;
      const { recorded } = await recordCapabilityCredit(judgeCapabilityCredit(input), ports);
      report.judged += 1;
      if (recorded) report.recorded += 1;
    } catch (error) {
      report.failed.push({ opportunityId: id, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
    }
  }
  return report;
}

let lastCreditRecording = 0;

/**
 * At most once per `CREDIT_RECORD_EVERY_MS`, from the whole-Brain goals tick
 * (`assembleGoals` with `projectIds: null`). Null when not due. A failure is
 * returned, never thrown into the tick.
 */
export async function recordCapabilityCreditsIfDue(
  opportunityIds: readonly string[],
  clock: { nowMs?: number; force?: boolean } = {},
  deps: CreditRecordingDeps = {},
): Promise<CreditRecordingReport | { error: string } | null> {
  const nowMs = clock.nowMs ?? Date.now();
  if (!clock.force && nowMs - lastCreditRecording < CREDIT_RECORD_EVERY_MS) return null;
  lastCreditRecording = nowMs;
  try {
    return await recordCapabilityCredits(opportunityIds, deps);
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
  }
}

/** Tests: forget when the last pass ran. */
export function forgetCreditRecording(): void {
  lastCreditRecording = 0;
}
