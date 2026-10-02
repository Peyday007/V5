/**
 * The self-expansion pass: what this loop needs and does not have, raised
 * without anything having failed and without anybody asking.
 *
 * ---------------------------------------------------------------------------
 * It audits proactively, which is the whole point
 * ---------------------------------------------------------------------------
 *
 * The brief asks for missing capabilities to be found *even without failures
 * or owner prompting*. A capability discovered at the moment a piece needs it
 * is discovered too late: the research is already paid for, the piece is
 * already at the front of the queue, and the answer is "wait weeks for an
 * integration". So this runs on every tick from rows, and it raises the need
 * as soon as the loop *could* reach the step, rather than when it does.
 *
 * ---------------------------------------------------------------------------
 * A capability is read, never declared
 * ---------------------------------------------------------------------------
 *
 * `readCapability` answers from rows. `MISSING` means Brain understands the
 * capability and does not have it; `UNKNOWN` means nobody has told Brain what
 * it is. §30 keeps those apart deliberately, and this preserves the
 * distinction rather than collapsing it: an unrecognised capability is
 * reported as unrecognised and raises nothing, because raising a need for
 * something nobody has defined would produce a task with no possible answer.
 *
 * ---------------------------------------------------------------------------
 * It gates nothing
 * ---------------------------------------------------------------------------
 *
 * Nothing here refuses a proposition, charges an attempt, stops a round or
 * blocks unrelated work. §30's rule at a new table: a missing capability is a
 * need with somewhere to go, never a wall. The one place a missing capability
 * actually stops something is the bounded test, and that is a blocker on the
 * test's own row with its own answering transition.
 */
import { readCapability } from '../cash/capabilities.ts';
import { raiseNeed } from '../cash/needs.ts';
import type { Reading } from './reading.ts';

export interface CapabilityAudit {
  /** Needs raised or already open, by capability. */
  raised: { capability: string; needId: string | null; why: string }[];
  present: string[];
  /** Read as MISSING or UNKNOWN, with which. */
  missing: { capability: string; state: string }[];
}

/**
 * What this loop needs, and at which step it would need it.
 *
 * Each entry says *when* the need becomes real, so the audit can raise it as
 * soon as the loop is plausibly heading there rather than on the first tick of
 * an empty sprint — a review full of needs for a sprint that has found nothing
 * is the encouraging-screen-over-an-empty-project defect §29 removed.
 */
interface Requirement {
  capability: string;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  setupEffort: string;
  nextStep: string;
  completionCondition: string;
  /** Whether the loop has got far enough for this to be worth raising. */
  dueWhen: (readings: readonly Reading[]) => boolean;
}

const anyWithPurchase = (readings: readonly Reading[]) =>
  readings.some((one) => one.purchases.length > 0 && !one.proposition.retiredAt);

const anyWithMargin = (readings: readonly Reading[]) =>
  readings.some((one) => one.economics.contributionPerUnit.known && !one.proposition.retiredAt);

const REQUIREMENTS: readonly Requirement[] = Object.freeze([
  {
    capability: 'PUBLISH_A_LISTING',
    blockedAction: 'Run a bounded sales test on a product this Brain has qualified',
    whyItMatters:
      'Every figure behind a qualified product here is an estimate read from a published ' +
      'source. A bounded test is the only thing that turns one into a measurement, and it ' +
      'cannot start without somewhere to list the product.',
    recommendedPath:
      'Connect a storefront or a channel seller account this Brain can list through, or decide ' +
      'that listing stays a manual step somebody performs and tells Brain the result of.',
    setupEffort:
      'Hours, if an account already exists. Longer where the channel requires a business ' +
      'entity, a tax registration or a category approval — which is what the eligibility ' +
      'rounds establish.',
    nextStep:
      'Decide whether listing is a connection Brain makes or a step a person performs, and say ' +
      'which on the needs list.',
    completionCondition:
      'PUBLISH_A_LISTING reads PRESENT, or a person records that listing is manual and reports ' +
      'the result of a test into Brain themselves.',
    dueWhen: anyWithMargin,
  },
  {
    capability: 'TAKE_A_PAYMENT',
    blockedAction: 'Measure whether anybody actually pays, rather than whether they look',
    whyItMatters:
      'A test that can list but cannot take money measures interest, and this kernel exists to ' +
      'keep interest and buying apart. A measurement of interest filed as a sales result would ' +
      'be the exact confusion every other part of this loop is built to prevent.',
    recommendedPath:
      'Connect a payment processor, or rely on the channel\'s own checkout and record its ' +
      'settlement reports into Brain as measured evidence.',
    setupEffort: 'Days. Most processors require an entity and a bank account before they settle.',
    nextStep: 'Decide which processor or channel checkout the test would settle through.',
    completionCondition:
      'TAKE_A_PAYMENT reads PRESENT, or settlement reports from the channel are being recorded ' +
      'into Brain as measured evidence against the proposition they belong to.',
    dueWhen: anyWithMargin,
  },
  {
    capability: 'SEND_A_MESSAGE',
    blockedAction: 'Reach a supplier to confirm stock, lead time and terms before ordering',
    whyItMatters:
      'Supplier evidence from published pages is an estimate about a supplier rather than a ' +
      'commitment from one. Placing a first order against a published lead time nobody ' +
      'confirmed is how a test measures a supply failure instead of a demand result.',
    recommendedPath:
      'Connect a channel that can reach a named supplier, or keep supplier contact as a manual ' +
      'step and record what they confirm as evidence.',
    setupEffort: 'Hours.',
    nextStep: 'Decide whether Brain reaches suppliers or a person does.',
    completionCondition:
      'SEND_A_MESSAGE reads PRESENT, or a person records a supplier\'s confirmed terms against ' +
      'the proposition as evidence.',
    dueWhen: anyWithPurchase,
  },
]);

export async function auditCapabilities(input: {
  projectId: string;
  readings: readonly Reading[];
}): Promise<CapabilityAudit> {
  const out: CapabilityAudit = { raised: [], present: [], missing: [] };

  for (const requirement of REQUIREMENTS) {
    const reading = await readCapability(requirement.capability);
    if (reading.state === 'PRESENT') {
      out.present.push(requirement.capability);
      continue;
    }
    out.missing.push({ capability: requirement.capability, state: reading.state });

    /*
     * An unrecognised capability raises nothing.
     *
     * `UNKNOWN` means nobody has told Brain what the capability is, so a need
     * for it would name a remedy nobody can carry out — §24's escalation with
     * no answering transition, manufactured by the very pass that exists to
     * name remedies. It is reported and left alone.
     */
    if (reading.state !== 'MISSING') continue;
    if (!requirement.dueWhen(input.readings)) continue;

    /*
     * Keyed, so a loop that derives this every tick adds one row to the review
     * rather than one per tick. Scoped by project and capability rather than
     * by proposition: the integration is missing once, not once per product,
     * and a review holding thirty copies of one remedy is the card §33
     * deleted.
     */
    const raised = await raiseNeed({
      projectId: input.projectId,
      actorRef: 'BRAIN',
      blockedAction: requirement.blockedAction,
      whyItMatters: requirement.whyItMatters,
      recommendedPath: requirement.recommendedPath,
      setupEffort: requirement.setupEffort,
      nextStep: requirement.nextStep,
      completionCondition: requirement.completionCondition,
      requestKey: `commerce:capability:${requirement.capability}`,
    });
    out.raised.push({
      capability: requirement.capability,
      needId: raised.ok ? raised.value.id : null,
      why: raised.ok ? requirement.whyItMatters : raised.reason,
    });
  }

  return out;
}
