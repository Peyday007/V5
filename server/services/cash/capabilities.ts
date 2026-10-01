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
 * this Brain can do research today. `SEND_A_MESSAGE` is `PRESENT` only when a
 * real effect adapter is registered for it (`effects.ts`'s
 * `contactBuyerAdapter`), so the moment a messaging integration exists is the
 * moment it can be checked rather than assumed — and on this Brain, with none
 * registered, it reads exactly as it did when this was `read: null`.
 *
 * Everything else in the vocabulary is declared `MISSING` with the integration
 * it needs named, which is the honest state of this version: §30 says plainly
 * that it records the authorization and the money and does not itself issue an
 * invoice or move funds. Making any of those report `PRESENT` would be the
 * invented measurement this file exists to refuse.
 */
import { separationCapacity } from '../research/auditAdmission.ts';
import { contactBuyerAdapter } from './effects.ts';

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
  read: (() => Promise<boolean>) | null;
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
  {
    id: 'SEND_A_MESSAGE',
    does: 'Deliver a message to a buyer at an address or number they published.',
    requires: 'An outbound messaging integration connected to this Brain.',
    nextStep:
      'Until one exists, the message is sent by a person and the send is recorded as a confirmed ' +
      'action on the opportunity.',
    // `PRESENT` means a real effect adapter is registered for this operation —
    // never a boolean somebody flipped. With none registered, which is every
    // deployment of this Brain today, this reads MISSING exactly as it did
    // when `read` was `null`.
    read: async () => contactBuyerAdapter() !== null,
  },
  {
    id: 'ISSUE_AN_INVOICE',
    does: 'Produce and send an invoice a buyer can pay.',
    requires: 'An invoicing integration, and the account details it bills from.',
    nextStep:
      'Until one exists, the invoice is issued outside Brain and the settlement is recorded ' +
      'against its own reference.',
    read: null,
  },
  {
    id: 'TAKE_A_PAYMENT',
    does: 'Accept money from a buyer.',
    requires: 'A payment processor connected to this Brain.',
    nextStep:
      'Until one exists, payment is taken outside Brain and reaches the ledger as a SETTLEMENT ' +
      'carrying a verifiable reference.',
    read: null,
  },
  {
    id: 'PUBLISH_A_LISTING',
    does: 'Put an offer somewhere buyers will see it.',
    requires: 'A publishing integration, and a person authorizing PUBLISH_OFFER.',
    nextStep:
      'Until one exists, the listing is published by a person. Note that publishing is an ' +
      'ALWAYS_PROHIBITED_COMMERCIAL action for Brain itself whatever integration exists.',
    read: null,
  },
  {
    id: 'SIGN_AN_AGREEMENT',
    does: 'Execute a contract with a buyer.',
    requires: 'A signature integration, and somebody with authority to bind the account.',
    nextStep: 'Until one exists, the agreement is signed by a person and recorded as an action.',
    read: null,
  },
]);

const BY_ID = new Map(CAPABILITIES.map((one) => [one.id, one]));

export interface CapabilityReading {
  id: string;
  state: CapabilityState;
  /** Present only for a capability Brain has a word for. */
  definition: CapabilityDefinition | null;
}

/**
 * Read one capability, now.
 *
 * Never cached. A fleet that lost its last healthy Routine an hour ago must not
 * still be reported as able to research, and a cache is the difference between
 * a reading and a memory of one.
 */
export async function readCapability(id: string): Promise<CapabilityReading> {
  const definition = BY_ID.get(id.trim());
  if (!definition) return { id: id.trim(), state: 'UNKNOWN', definition: null };
  if (!definition.read) return { id: definition.id, state: 'MISSING', definition };
  try {
    return {
      id: definition.id,
      state: (await definition.read()) ? 'PRESENT' : 'MISSING',
      definition,
    };
  } catch {
    // A reader that could not answer has not answered. Reporting PRESENT here
    // would be a favourable assumption about the one capability that decides
    // whether anything can be researched at all.
    return { id: definition.id, state: 'UNKNOWN', definition };
  }
}

export async function readCapabilities(ids: readonly string[]): Promise<CapabilityReading[]> {
  const seen = new Set<string>();
  const out: CapabilityReading[] = [];
  for (const id of ids) {
    const key = id.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(await readCapability(key));
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
