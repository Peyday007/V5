/**
 * What this Brain can actually do on an opportunity's behalf, and how it knows.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `cash_opportunities.required_capabilities` was written by the card, stored as
 * JSON, read back by the mapper — and consulted by nothing. So an opportunity
 * could declare that collecting its money needs a payment processor, reach
 * `READY` with that declaration intact, and start executing against a Brain
 * that has no payment processor and had never been asked. The plan's own rule
 * is the opposite: **use verified capabilities, and record a concrete need when
 * one is missing.** A declaration nothing reads is neither.
 *
 * ---------------------------------------------------------------------------
 * Two answers that must not be one answer
 * ---------------------------------------------------------------------------
 *
 * `MISSING` means Brain understands the capability and does not have it: no
 * integration, and a specific thing somebody could go and set up. `UNKNOWN`
 * means nobody has told Brain what this capability *is* — it is not in the
 * vocabulary, so there is nothing to check and no remedy to name beyond
 * "describe it".
 *
 * Collapsing them would make an unrecognised word read as a settled absence,
 * which is invariant 39 in the expensive direction: "we could not tell" must
 * never read the same as "we checked". They produce different needs, with
 * different next steps.
 *
 * ---------------------------------------------------------------------------
 * "Verified" means a row, never a constant
 * ---------------------------------------------------------------------------
 *
 * A capability that reports itself present because a boolean in this file says
 * so is a label. `RESEARCH_A_QUESTION` is `PRESENT` only when the fleet
 * actually has a healthy execution surface, read from `fleet_routines` — the
 * same reading `auditAdmission` uses, so the two cannot disagree about whether
 * this Brain can do research today.
 *
 * Messaging, invoicing, payment and owner notification are read from this
 * project's provider connection (§50): PRESENT only when a credential is
 * deployed and the provider answered for it, in live mode, within the last
 * day. That sentence used to say every one of them was declared MISSING
 * because no integration existed; the correction is recorded rather than
 * quietly applied. Publishing and signing still have no reader, and not
 * because nothing was built — both are ALWAYS_PROHIBITED_COMMERCIAL, so no
 * connector could make them Brain's to do.
 */
import { separationCapacity } from '../research/auditAdmission.ts';
import { liveReading } from '../external/connections.ts';
import type { ExternalProvider } from '../../domain/types.ts';

export type CapabilityState = 'PRESENT' | 'MISSING' | 'UNKNOWN';

export interface CapabilityDefinition {
  id: string;
  /** What it lets an opportunity do, in the words a person decides in. */
  does: string;
  /** What would have to exist for it to be present. */
  requires: string;
  /** The first thing somebody would actually do about it. */
  nextStep: string;
  /**
   * Whether Brain can answer from its own rows.
   *
   * `null` means there is nothing to read: no integration of this kind has
   * ever been connected, so the answer is `MISSING` without a query. A
   * capability with a reader may still be `MISSING` — a fleet with no healthy
   * surface cannot research anything — and the difference between "no reader"
   * and "the reader said no" is what keeps the report a reading.
   */
  read: ((projectId: string | null) => Promise<boolean | CapabilityAnswer>) | null;
}

/** A reader's answer with its reason, for the readers that have one. */
export interface CapabilityAnswer {
  present: boolean;
  /** Safe to show: why it reads as it does. */
  detail: string;
  /** True when the reader could not tell at all — reported as UNKNOWN. */
  unknown?: boolean;
}

/**
 * A capability that exists only through a provider connection (§50).
 *
 * PRESENT only when this project's live connection reads HEALTHY: a row
 * somebody created, a credential actually deployed, and the provider having
 * answered for *that* credential within the last day in live mode. An adapter
 * class existing, or a secret having been entered, is not the capability —
 * and a Stripe key the provider reports as test mode proves the path without
 * making invoicing a real customer available, so it reads MISSING with that
 * said.
 */
function throughConnection(provider: ExternalProvider) {
  return async (projectId: string | null): Promise<CapabilityAnswer> => {
    if (!projectId) {
      return {
        present: false,
        unknown: true,
        detail: 'A provider connection belongs to one project, and no project was named.',
      };
    }
    const reading = await liveReading(projectId, provider);
    if (!reading) {
      return { present: false, detail: 'No connection for this provider exists on this project.' };
    }
    if (reading.state === 'HEALTHY') return { present: true, detail: reading.says };
    return { present: false, detail: `The connection reads ${reading.state}: ${reading.says}` };
  };
}

const RESEARCH: CapabilityDefinition = {
  id: 'RESEARCH_A_QUESTION',
  does: 'Send a bounded question to a worker and take back gated, sourced claims.',
  requires: 'One enabled Routine with a registered secret and a bound worker.',
  nextStep:
    'Register or re-enable a Routine with `npm run fleet`, then check that a fire arrives and ' +
    'finishes something.',
  read: async () => (await separationCapacity()).surfaces >= 1,
};

const NOTIFY_OWNER: CapabilityDefinition = {
  id: 'NOTIFY_OWNER',
  does: 'Tell the project owner, on their own phone, that a decision is waiting or an action finished.',
  requires: 'A healthy ntfy connection on this project, with its private topic deployed as a secret.',
  nextStep:
    'Open External actions, connect "Push messages to your own phone", have an administrator set ' +
    'the named deployment secret to your private topic, and press Check.',
  read: throughConnection('NTFY'),
};

/**
 * The capabilities this Brain has a word for.
 *
 * Deliberately short. A vocabulary that listed everything a cash sprint could
 * conceivably want would report a confident `MISSING` about things nobody has
 * thought through, and `MISSING` is a claim that Brain understands the thing.
 * Anything not here is `UNKNOWN`, which says so.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  RESEARCH,
  NOTIFY_OWNER,
  {
    id: 'SEND_A_MESSAGE',
    does: 'Deliver a message to a buyer at an address or number they published.',
    requires:
      'A healthy email connection (Resend) on this project, sending from a verified domain. ' +
      'Contacting a buyer also needs a standing commercial authority covering CONTACT_BUYER, and ' +
      'every message to a third party is approved by a person before it is sent.',
    nextStep:
      'Open External actions, connect Email, have an administrator set the named deployment ' +
      'secret to a Resend API key, and press Check. Until then the message is sent by a person ' +
      'and recorded as a confirmed action on the opportunity.',
    read: throughConnection('RESEND'),
  },
  {
    id: 'ISSUE_AN_INVOICE',
    does: 'Produce and send an invoice a buyer can pay.',
    requires:
      'A healthy Stripe connection on this project in LIVE mode. A test-mode key proves the path ' +
      'and deliberately does not make this present.',
    nextStep:
      'Open External actions, connect Stripe with a test-mode key first, issue a test invoice to ' +
      'yourself and watch it read back issued, paid and settled; then deploy the live key.',
    read: throughConnection('STRIPE'),
  },
  {
    id: 'TAKE_A_PAYMENT',
    does: 'Accept money from a buyer.',
    requires:
      'A payment processor: a healthy Stripe connection on this project in LIVE mode. Payment is taken through the ' +
      'invoice Brain issued, and Brain reads back paid and settled as two separate facts.',
    nextStep:
      'Connect Stripe as for invoicing. Until then, payment is taken outside Brain and reaches ' +
      'the ledger as a SETTLEMENT carrying a verifiable reference.',
    read: throughConnection('STRIPE'),
  },
  {
    id: 'PUBLISH_A_LISTING',
    does: 'Put an offer somewhere buyers will see it.',
    requires:
      'Not available to Brain by policy: PUBLISH_EXTERNALLY is in ALWAYS_PROHIBITED_COMMERCIAL, ' +
      'so no connector and no grant can make Brain publish an offer.',
    nextStep:
      'The listing is published by a person and recorded as an action. Letting Brain publish ' +
      'would be a policy change a person makes in code review, not a connection.',
    read: null,
  },
  {
    id: 'SIGN_AN_AGREEMENT',
    does: 'Execute a contract with a buyer.',
    requires:
      'Not available to Brain by policy: signing binds the account, which is an ' +
      'IDENTITY_BEARING_ACT in ALWAYS_PROHIBITED_COMMERCIAL. A signature connector would not change that.',
    nextStep: 'The agreement is signed by a person and recorded as an action.',
    read: null,
  },
]);

const BY_ID = new Map(CAPABILITIES.map((one) => [one.id, one]));

export interface CapabilityReading {
  id: string;
  state: CapabilityState;
  /** Present only for a capability Brain has a word for. */
  definition: CapabilityDefinition | null;
  /** Why it reads as it does, when the reader said. */
  detail: string | null;
}

/**
 * Read one capability, now.
 *
 * Never cached. A fleet that lost its last healthy Routine an hour ago must not
 * still be reported as able to research, and a cache is the difference between
 * a reading and a memory of one.
 */
export async function readCapability(
  id: string,
  projectId: string | null = null,
): Promise<CapabilityReading> {
  const definition = BY_ID.get(id.trim());
  if (!definition) return { id: id.trim(), state: 'UNKNOWN', definition: null, detail: null };
  if (!definition.read) {
    return { id: definition.id, state: 'MISSING', definition, detail: definition.requires };
  }
  try {
    const answer = await definition.read(projectId);
    if (typeof answer === 'boolean') {
      return { id: definition.id, state: answer ? 'PRESENT' : 'MISSING', definition, detail: null };
    }
    return {
      id: definition.id,
      state: answer.unknown ? 'UNKNOWN' : answer.present ? 'PRESENT' : 'MISSING',
      definition,
      detail: answer.detail,
    };
  } catch {
    // A reader that could not answer has not answered. Reporting PRESENT here
    // would be a favourable assumption about the one capability that decides
    // whether anything can be researched at all.
    return { id: definition.id, state: 'UNKNOWN', definition, detail: null };
  }
}

export async function readCapabilities(
  ids: readonly string[],
  projectId: string | null = null,
): Promise<CapabilityReading[]> {
  const seen = new Set<string>();
  const out: CapabilityReading[] = [];
  for (const id of ids) {
    const key = id.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(await readCapability(key, projectId));
  }
  return out;
}

/**
 * The need one unavailable capability raises, composed by the server.
 *
 * Returned rather than written, because whether to raise it is the caller's
 * decision and composing it is not. A screen that paraphrased the remedy would
 * eventually paraphrase it wrongly — the same reason `describeAuthority` and
 * `CONSEQUENCE` are server-composed.
 */
export function needForCapability(reading: CapabilityReading, blockedAction: string): {
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  setupEffort: string;
  nextStep: string;
  completionCondition: string;
} | null {
  if (reading.state === 'PRESENT') return null;
  if (reading.state === 'UNKNOWN' || !reading.definition) {
    return {
      blockedAction,
      whyItMatters:
        `This piece says it needs "${reading.id}", and Brain has no word for that — so nothing ` +
        'was checked and nothing is claimed about whether it exists.',
      recommendedPath:
        'Name the capability from the ones Brain understands, or describe what it has to do so a ' +
        'capability can be added.',
      setupEffort: 'A few minutes of describing it.',
      nextStep: `Rewrite the required capability "${reading.id}" as something Brain can check.`,
      completionCondition:
        'The opportunity no longer requires a capability Brain has no word for.',
    };
  }
  return {
    blockedAction,
    whyItMatters: `${reading.definition.does} Brain cannot do that here.`,
    recommendedPath: reading.definition.requires,
    setupEffort: 'Depends on the integration; nothing about it is guessed here.',
    nextStep: reading.definition.nextStep,
    completionCondition: `${reading.definition.id} reads PRESENT, or this piece stops requiring it.`,
  };
}
