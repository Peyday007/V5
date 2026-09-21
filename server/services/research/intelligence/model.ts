/**
 * What Brain believes it was asked, written down so it can be shown to be wrong.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a second boundary contract
 * ---------------------------------------------------------------------------
 *
 * `boundary_contracts` says what the research is *bounded by*: geography,
 * timeframe, population, definitions, excluded subjects, the completion
 * standard. Every one of those is referenced here and none is restated, for the
 * reason `shared_findings` gives about claims — a copy is a second place for the
 * truth to live, and it is the one nobody reconciles.
 *
 * What the contract has no column for is what the work is *for*: the decision
 * downstream, what being wrong would cost, and the four categories a single
 * "constraints" list collapses.
 *
 * ---------------------------------------------------------------------------
 * The four categories, and why collapsing them is the defect
 * ---------------------------------------------------------------------------
 *
 * A CONSTRAINT binds. A PREFERENCE is how somebody would like it if everything
 * else is equal. An EXAMPLE illustrates a property and is not a list of the only
 * acceptable answers. An ASSUMPTION is something nobody has checked.
 *
 * Stored as one list of sentences they are all read the same way — as things
 * the research must obey literally — and that is the Westbrook defect (§25) one
 * altitude up: the rule is applied correctly and the question it is applied to
 * is not the one anybody asked. A person naming three industries as examples of
 * *the kind of buyer they mean* gets a search restricted to three industries,
 * runs correctly, and answers a narrower question than the one they have.
 *
 * So an example carries the **property it was an example of**, and
 * `searchableBeyondExamples` reads that property rather than the examples. A
 * constraint carries the **reason it exists**, so Brain can later ask whether
 * the reason still applies — a constraint with no reason can only be obeyed for
 * ever, which is how a temporary choice becomes policy.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is inferred from prose
 * ---------------------------------------------------------------------------
 *
 * Every field is read from a row: the orchestration, the boundary contract the
 * plan already wrote, and the approval envelope named by id. A version derived
 * this way is marked `CONTRACT` or `ASSIGNMENT`, never `PERSON` — because
 * *somebody said so* and *nobody said anything and this is the default* are
 * different facts, and a model that could not tell them apart would present a
 * default as a decision. A richer reading is a `PROPOSAL`, validated in
 * `proposals.ts`, and it is a separate version rather than an edit.
 */
import {
  currentProblemModel,
  recordProblemModel,
} from '../../../repos/researchIntelligence.ts';
import { contractFor } from '../../../repos/reconciliation.ts';
import { getApprovalEnvelope } from '../approvalEnvelope.ts';
import type {
  ResearchOrchestration,
  ResearchProblemModel,
  ResearchReversibility,
  ResearchStakes,
  StatedExample,
} from '../../../domain/types.ts';

/**
 * The reading a packet gets before anybody says anything richer.
 *
 * Deliberately modest. It names the outcome and the decision from rows that
 * already exist, records the envelope's prohibitions as the authority that was
 * *not* granted, and leaves stakes at MODERATE — because a packet nobody has
 * told Brain the stakes of is not a low-stakes packet, and it is not a critical
 * one either.
 */
export async function ensureProblemModel(
  orchestration: ResearchOrchestration,
): Promise<ResearchProblemModel> {
  const existing = await currentProblemModel(orchestration.id);
  if (existing) return existing;

  const contract = await contractFor(orchestration.id);
  const envelope = orchestration.approvalEnvelopeId
    ? getApprovalEnvelope(orchestration.approvalEnvelopeId)
    : null;

  /*
   * What the answer is *for*.
   *
   * The contract's own `decisionSupported` where the plan stated one — it is
   * the field that exists for exactly this. Otherwise null, and null is carried
   * forward rather than filled with a paraphrase of the question: "the decision
   * this supports is answering the question" is a sentence that reads like
   * content and contains none, and `sufficiencyOf` would then have something to
   * check the synthesis against that could never fail.
   */
  const decision = contract?.decisionSupported?.trim() || null;

  /*
   * The authority this packet holds, from the envelope rather than from prose.
   *
   * Recorded as what it is: reading published sources. `forbiddenActions` is a
   * regular expression and is deliberately not decompiled into sentences here —
   * what a reader needs is the envelope's own `authorization`, which is the
   * sentence a person authorized, and the id so the rules themselves can be
   * read.
   */
  const authority = envelope
    ? [
        envelope.authorization,
        `Bounded by approval envelope ${envelope.id}, which is in code and cannot be widened ` +
          'by anything this packet does.',
      ]
    : [];

  return await recordProblemModel({
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    boundaryContractId: contract?.id ?? null,
    version: 1,
    outcomeSought: contract?.primaryQuestion?.trim() || orchestration.title,
    decisionSupported: decision,
    whyItMatters: null,
    stakes: 'MODERATE',
    reversibility: 'REVERSIBLE',
    consequenceIfWrong: null,
    timeHorizon: contract?.timeframe ?? null,
    successCriteria: contract?.completionStandard ? [contract.completionStandard] : [],
    // The contract's prohibited assumptions are genuine constraints and they
    // carry their own reason: they are prohibited because assuming them would
    // answer the question rather than establish it.
    constraints: (contract?.prohibitedAssumptions ?? []).map((statement) => ({
      statement: `Do not assume: ${statement}`,
      reason: 'The plan named this as something that must be established rather than assumed.',
    })),
    preferences: [],
    examples: [],
    assumptions: [],
    // What the packet is explicitly not about. The contract already holds this
    // and it is the one list a research plan routinely gets wrong by ignoring.
    nonGoals: contract?.excludedSubjects ?? [],
    uselessIf: [],
    authorityGranted: authority,
    derivedFrom: contract ? 'CONTRACT' : 'ASSIGNMENT',
    rationale:
      contract
        ? 'Read from the boundary contract this packet\'s plan already wrote. Nothing here ' +
          'was inferred from the wording of the assignment.'
        : 'This packet has no boundary contract yet, so the reading is the orchestration\'s ' +
          'own title and assignment and nothing more.',
  });
}

/**
 * Supersede the current reading with a richer one.
 *
 * A new version, never an edit. The old reading stays exactly as written,
 * because what Brain believed when it planned the research is what explains the
 * plan, and a campaign whose interpretation could be rewritten afterwards is one
 * whose fragments can never be accounted for.
 */
export async function reviseProblemModel(input: {
  orchestration: ResearchOrchestration;
  revision: Partial<
    Pick<
      ResearchProblemModel,
      | 'outcomeSought'
      | 'decisionSupported'
      | 'whyItMatters'
      | 'stakes'
      | 'reversibility'
      | 'consequenceIfWrong'
      | 'timeHorizon'
      | 'successCriteria'
      | 'constraints'
      | 'preferences'
      | 'examples'
      | 'assumptions'
      | 'nonGoals'
      | 'uselessIf'
    >
  >;
  derivedFrom: 'PROPOSAL' | 'PERSON';
  reason: string;
  rationale?: string | null;
}): Promise<ResearchProblemModel> {
  const current = await ensureProblemModel(input.orchestration);
  const next = { ...current, ...input.revision };
  return await recordProblemModel({
    orchestrationId: current.orchestrationId,
    projectId: current.projectId,
    boundaryContractId: current.boundaryContractId,
    version: current.version + 1,
    outcomeSought: next.outcomeSought,
    decisionSupported: next.decisionSupported,
    whyItMatters: next.whyItMatters,
    stakes: next.stakes,
    reversibility: next.reversibility,
    consequenceIfWrong: next.consequenceIfWrong,
    timeHorizon: next.timeHorizon,
    successCriteria: next.successCriteria,
    constraints: next.constraints,
    preferences: next.preferences,
    examples: next.examples,
    assumptions: next.assumptions,
    nonGoals: next.nonGoals,
    uselessIf: next.uselessIf,
    // Never revisable from here. The authority a packet holds is the envelope a
    // person named, and a revision that could widen it would be the thing §16
    // exists instead of.
    authorityGranted: current.authorityGranted,
    derivedFrom: input.derivedFrom,
    rationale: input.rationale ?? null,
    revisedFromVersion: current.version,
    revisionReason: input.reason,
  });
}

/**
 * What search may generalise over, given the examples the person gave.
 *
 * The answer is the **properties**, not the examples. An example whose property
 * nobody stated is returned as itself and marked — because without the property
 * the only honest reading is that the example is all anybody said, and guessing
 * the property would be the compiler inferring intent, which §25 refuses in the
 * one place that already cost a wrong answer.
 *
 * Required scenario 2 is this function: a user supplies three example
 * industries, the property is "a buyer who already pays for this outsourced",
 * and research is free to look outside the three. What it must never do is turn
 * the three into a whitelist.
 */
export interface ExampleReading {
  /** Properties the examples illustrate. Search may generalise over these. */
  generalisableProperties: string[];
  /** Examples that stated no property, kept verbatim. */
  unexplained: StatedExample[];
  /**
   * True when at least one example carries a property, which is the condition
   * under which treating the list as exhaustive would be wrong.
   */
  exhaustiveWouldBeWrong: boolean;
}

export function readExamples(model: ResearchProblemModel): ExampleReading {
  const withProperty = model.examples.filter(
    (example) => (example.property ?? '').trim().length > 0,
  );
  return {
    generalisableProperties: [
      ...new Set(withProperty.map((example) => example.property!.trim())),
    ],
    unexplained: model.examples.filter((example) => !(example.property ?? '').trim()),
    exhaustiveWouldBeWrong: withProperty.length > 0,
  };
}

/**
 * The stakes and reversibility an uncertainty inherits when nothing narrower is
 * known about it.
 *
 * Inheriting rather than defaulting: a packet whose decision is irreversible
 * makes every question inside it worth more, and starting each one at MODERATE
 * would lose that. The uncertainty may still be re-ranked upward by the director
 * from evidence; nothing re-ranks it downward.
 */
export function inheritedWeight(model: ResearchProblemModel | null): {
  consequence: ResearchStakes;
  reversibility: ResearchReversibility;
} {
  return {
    consequence: model?.stakes ?? 'MODERATE',
    reversibility: model?.reversibility ?? 'REVERSIBLE',
  };
}
