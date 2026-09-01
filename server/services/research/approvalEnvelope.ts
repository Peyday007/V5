/**
 * Approving a plan without a person, but only inside limits a person set first.
 *
 * §16 stops a browser-initiated run after planning because spending an
 * allowance on a decomposition nobody has read is the failure that rule exists
 * to prevent. That reasoning is about *unreviewed* plans. It is not a reason to
 * ask again for a decision somebody has already made in full: when the topic,
 * the scope, the source restrictions and the execution have all been authorized
 * in advance, a second click adds a delay and no judgement.
 *
 * So there are two modes and the difference between them is where the judgement
 * happened, never whether it happened:
 *
 *   HUMAN                  a person reads this plan and approves it.
 *   AUTO_WITHIN_ENVELOPE   a person authorized these limits in advance, and
 *                          Brain checks the plan against them mechanically.
 *
 * Four things make the second one safe, and removing any of them breaks it:
 *
 *   1. **The envelope lives here, in code, not in the row.** An orchestration
 *      stores only an envelope *id*. Whoever starts a packet cannot supply the
 *      limits their own plan will be judged against, and a row naming an
 *      envelope this build does not define validates against nothing and is
 *      refused rather than waved through.
 *
 *   2. **The check is a pure function over rows.** No model reads it, no model
 *      writes it, and no model is asked whether the plan fits. A model that
 *      could argue for its own plan is a model approving itself, which is the
 *      one thing this must never become.
 *
 *   3. **It approves; it does not exempt.** Everything downstream is untouched
 *      — the evidence gate, the verification pass, the synthesis check and all
 *      three audit roles run exactly as they do for a human-approved packet.
 *      The envelope decides whether research may *start*, and nothing else.
 *
 *   4. **Anything outside the envelope goes to a person.** Not a warning, not a
 *      narrowed plan, not a retry: NEEDS_HUMAN, with the reasons recorded.
 *
 * This is deliberately not a policy engine. There is one envelope, it is a
 * constant, and adding a second is a code change somebody reviews. Capacity-
 * aware and goal-level authorization are Step 11's, and building their
 * machinery here on the strength of one packet would be exactly the
 * over-generalisation this file exists instead of.
 */
import crypto from 'node:crypto';
import type { ResearchFragment, ResearchOrchestration } from '../../domain/types.ts';

/**
 * Bumped whenever the checks below change meaning.
 *
 * Recorded on every automatic approval, because "Brain approved this" is only
 * auditable if you can tell which rules it applied.
 */
export const ENVELOPE_VALIDATOR_VERSION = '2026-09-01.1';

/** The exact assignment the Step 10 envelope authorizes, and nothing else. */
export const MICHIGAN_LICENSING_ASSIGNMENT = `Determine whether, under Michigan law, a success-fee intermediary who arranges
the sale of a privately held business must hold a real-estate broker licence, a
business-broker licence, or any equivalent licence, when the transaction
transfers no interest in real property and no lease.

Decision this informs: whether a success-fee intermediary may lawfully operate
in Michigan without a licence, and what follows if it may not.

Audience: the operator of a business-brokerage platform deciding whether
Michigan is a state it can serve.

In scope, and only this:
  1. The licence trigger — the Michigan statutory definition of the licensed
     activity, quoting the language that says what conduct requires a licence.
  2. The real-property condition — the specific provision determining whether
     the trigger depends on an interest in real property or a lease, including
     how Michigan treats a "business opportunity" or "business enterprise".
  3. The applicable inclusion or exemption — any express Michigan carve-out or
     inclusion addressing business brokers, business-opportunity brokers or M&A
     intermediaries dealing in businesses with no real-property component,
     with its exact scope and conditions.
  4. Material consequences of getting it wrong — the penalty, the enforceability
     of the fee agreement, and any private right of action, each from the
     statute or regulation that creates it.

Out of scope: other states; federal securities-broker registration; tax; the
2023 federal M&A broker exemption except where Michigan law refers to it;
anything not needed to answer the four items above.

Evidence standard: primary sources only — the Michigan Occupational Code and
its licensing article, the administrative rules, and published guidance or
declaratory rulings from Michigan's Department of Licensing and Regulatory
Affairs or the Board of Real Estate Brokers and Salespersons. A law-firm
article, a brokerage association page or a secondary summary may be used to
locate a primary source and may not support a claim on its own.

Completion standard: each of the four items answered from a quoted primary
provision with its citation, or explicitly recorded as unresolved with the
search that failed. A statutory question is settled by one directly inspected
primary source; it does not need two, and it is not settled by two secondary
ones.`;

export interface ApprovalEnvelope {
  id: string;
  /** What the operator authorized, in their words, for the audit row. */
  authorization: string;
  /** The assignment text this envelope authorizes, pinned by digest. */
  assignmentSha256: string;
  maxFragments: number;
  /** Every fragment's geography must match this. */
  geography: RegExp;
  /** A fragment naming any of these is out of scope by construction. */
  forbiddenScope: RegExp;
  /** Source types a fragment may accept. Anything else is outside. */
  allowedSourceTypes: RegExp;
  /** Language that would mean spending money or acting on the world. */
  forbiddenActions: RegExp;
  /** The evidence floor the envelope refuses to see lowered. */
  minIndependentSourcesFloor: number;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The one envelope that exists.
 *
 * Frozen, and keyed by an id a caller can name but not define.
 */
export const APPROVAL_ENVELOPES: Readonly<Record<string, ApprovalEnvelope>> = Object.freeze({
  STEP10_MICHIGAN_LICENSING_V1: Object.freeze({
    id: 'STEP10_MICHIGAN_LICENSING_V1',
    authorization:
      'The operator authorized this exact topic, scope, source restriction and execution in ' +
      'advance, for one packet, as the Step 10 real-research acceptance.',
    assignmentSha256: sha256(MICHIGAN_LICENSING_ASSIGNMENT),
    maxFragments: 4,
    geography: /michigan|\bmi\b/i,
    forbiddenScope:
      /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|minnesota|mississippi|missouri|montana|nebraska|nevada|ohio|oklahoma|oregon|pennsylvania|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|new york|new jersey|north carolina|south carolina|west virginia|rhode island|new hampshire|new mexico|north dakota|south dakota)\b/i,
    allowedSourceTypes:
      /(statut|regulation|administrative rule|occupational code|licensing act|regulator|declaratory ruling|attorney general|agency guidance|lara|department of licensing|board of real estate|official|primary|government|case law|court)/i,
    forbiddenActions:
      /\b(purchase|pay|payment|subscribe|subscription|invoice|licence fee to access|paywall bypass|contact|telephone|phone call|email the|write to|submit a request to|file a complaint|register with|apply for)\b/i,
    minIndependentSourcesFloor: 1,
  } satisfies ApprovalEnvelope),
});

export function getApprovalEnvelope(id: string): ApprovalEnvelope | null {
  return Object.prototype.hasOwnProperty.call(APPROVAL_ENVELOPES, id)
    ? (APPROVAL_ENVELOPES[id] as ApprovalEnvelope)
    : null;
}

export interface EnvelopeVerdict {
  fits: boolean;
  envelopeId: string;
  validatorVersion: string;
  reasons: string[];
  checked: Record<string, unknown>;
}

/**
 * Does this plan fit what was authorized?
 *
 * Deterministic, total, and side-effect free. Every reason it returns names the
 * fragment and the rule, because "outside the envelope" with no detail is an
 * escalation a person cannot act on.
 */
export function planFitsEnvelope(input: {
  envelope: ApprovalEnvelope;
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
}): EnvelopeVerdict {
  const { envelope, orchestration, fragments } = input;
  const reasons: string[] = [];

  // The assignment itself, pinned. A packet whose text drifted by one word is
  // not the packet that was authorized, whatever its title says.
  const actual = sha256(orchestration.assignment);
  if (actual !== envelope.assignmentSha256) {
    reasons.push(
      'The assignment is not the text this envelope authorizes. The envelope pins an exact ' +
        'assignment by digest, so any change to the question, the scope or the evidence ' +
        'standard needs a person.',
    );
  }

  // Nothing that skips the real path may be auto-approved. A fixture supplies
  // its own claims, so approving one automatically would authorize a rehearsal
  // rather than research.
  if (orchestration.fixture) {
    reasons.push('This is a fixture packet, which supplies its own claims. Only a person may approve one.');
  }

  // Narrowing the goal is a separate decision, and this envelope does not carry
  // it. A packet allowed to record gaps could declare its way to complete.
  if (orchestration.unresolvedGapPolicy) {
    reasons.push(
      'This packet is authorized to record unresolved gaps, which narrows what it claims to ' +
        'answer. That is a decision about the goal and it is not inside this envelope.',
    );
  }

  if (fragments.length === 0) {
    reasons.push('There is no plan to approve.');
  }
  if (fragments.length > envelope.maxFragments) {
    reasons.push(
      `The plan proposes ${fragments.length} fragments; the envelope authorizes at most ` +
        `${envelope.maxFragments}. A broader decomposition is a broader spend.`,
    );
  }

  for (const fragment of fragments) {
    const where = `fragment "${fragment.fragmentKey}"`;
    const prose = [
      fragment.question,
      fragment.definitions ?? '',
      fragment.population ?? '',
      fragment.completionCriteria.join(' '),
    ].join(' \n');

    const geography = fragment.geography ?? '';
    if (!envelope.geography.test(geography)) {
      reasons.push(`${where} declares geography "${geography || '(none)'}", which is not Michigan.`);
    }
    if (envelope.forbiddenScope.test(prose) || envelope.forbiddenScope.test(geography)) {
      reasons.push(`${where} reaches outside Michigan.`);
    }
    if (envelope.forbiddenActions.test(prose)) {
      reasons.push(
        `${where} describes an action outside reading published sources. The envelope authorizes ` +
          'no spending and no contact with anybody.',
      );
    }
    if (fragment.acceptableSourceTypes.length === 0) {
      reasons.push(`${where} declares no acceptable source types, so nothing bounds what it may cite.`);
    }
    for (const source of fragment.acceptableSourceTypes) {
      if (!envelope.allowedSourceTypes.test(source)) {
        reasons.push(
          `${where} accepts "${source}", which is not a primary statute, regulation or regulator source.`,
        );
      }
    }
    if (fragment.minIndependentSources < envelope.minIndependentSourcesFloor) {
      reasons.push(
        `${where} sets minIndependentSources to ${fragment.minIndependentSources}, below the ` +
          `envelope's floor of ${envelope.minIndependentSourcesFloor}.`,
      );
    }
    if (fragment.requiredEvidence.length === 0) {
      reasons.push(`${where} declares no evidence lanes, so the gate has nothing to apply.`);
    }
  }

  return {
    fits: reasons.length === 0,
    envelopeId: envelope.id,
    validatorVersion: ENVELOPE_VALIDATOR_VERSION,
    reasons,
    checked: {
      fragments: fragments.length,
      maxFragments: envelope.maxFragments,
      assignmentMatches: actual === envelope.assignmentSha256,
      geographies: fragments.map((f) => f.geography ?? null),
    },
  };
}
