/**
 * The semantic half, and the wall in front of it.
 *
 * ---------------------------------------------------------------------------
 * Why there is a model in this at all
 * ---------------------------------------------------------------------------
 *
 * `director.ts` reads rows and nothing else, which is right for everything it
 * decides and is not enough for two things a campaign genuinely needs: what a
 * finding *means*, and which new question it raises. "The county publishes this
 * under a different name, so the register we were told to search does not exist
 * as such" is not derivable from a status column by anything, and a Brain that
 * pretended otherwise would be inventing the judgement rather than declining it.
 *
 * So a worker may propose. What arrives is **data, never an instruction** — the
 * same rule §11 applies to an imported transcript and §8 applies to an audit
 * verdict, at a third door.
 *
 * ---------------------------------------------------------------------------
 * What the wall refuses
 * ---------------------------------------------------------------------------
 *
 * - An unknown field refuses the **whole** proposal, not the field. A partially
 *   applied proposal is a plan with a hole in it, and the half that was applied
 *   is indistinguishable afterwards from one somebody meant.
 * - An action outside the closed set, matched exactly. No substring matching, no
 *   closest match, no inference — `services/audit/schema.ts`'s rule, which
 *   exists because "approximately APPROVE" is how model prose becomes state.
 * - A key that does not resolve inside *this* packet. Every reference is
 *   re-resolved against rows; nothing a proposal names can reach another
 *   orchestration or another project.
 * - Any change to what the packet is *allowed* to do. The approval envelope,
 *   the evidence bar, the independent-source minimum, the coverage decision and
 *   the audit verdict are not reachable from here, by absence of an import.
 * - A `PERSON_ONLY` escalation over work Brain can do. That one is the subject
 *   of the block below.
 *
 * ---------------------------------------------------------------------------
 * Person-only, and why the vocabulary is closed
 * ---------------------------------------------------------------------------
 *
 * The failure this prevents is a research system that asks a person to do its
 * research: "what does this cost?", "who is the buyer?", "how would we reach
 * them?" are all *discoverable*, and a question like that in front of a person
 * is Brain declining work while looking as though it is waiting for them. §30
 * had to correct exactly this once, when a card asked the owner for nine
 * commercial facts Brain could have looked up.
 *
 * So an escalation names a **kind** from a closed set, every member of which is
 * something no amount of research produces: a preference only they hold, a
 * consent, a judgement that is theirs to make, an irreversible decision, a
 * secret, a credential, or an authorization to affect the world. A proposal
 * naming anything else is refused **by name**, with the sentence saying that the
 * question is Brain's to answer — because a silent refusal would teach a worker
 * nothing and the next proposal would be the same.
 */
import {
  getUncertainty,
  linkUncertainties,
  openUncertainty,
  recordPlanRevision,
  setUncertaintyDisposition,
} from '../../../repos/researchIntelligence.ts';
import { ensureProblemModel, reviseProblemModel } from './model.ts';
import type {
  ResearchOrchestration,
  ResearchStakes,
  ResearchReversibility,
  StatedConstraint,
  StatedExample,
  UncertaintyLinkKind,
} from '../../../domain/types.ts';
import {
  RESEARCH_REVERSIBILITY,
  RESEARCH_STAKES,
  UNCERTAINTY_LINK_KINDS,
} from '../../../domain/types.ts';

/**
 * The only things that genuinely require the person rather than research.
 *
 * Each one is a fact about *them* or an authority only they hold. Nothing on
 * this list becomes answerable by looking harder, which is the test for being on
 * it.
 */
export const PERSON_ONLY_KINDS = [
  'SUBJECTIVE_PREFERENCE',
  'CONSENT',
  'VALUE_JUDGEMENT',
  'IRREVERSIBLE_DECISION',
  'SECRET_BRAIN_CANNOT_ACCESS',
  'CREDENTIAL_OR_CONNECTION',
  'AUTHORIZATION_TO_SPEND',
  'AUTHORIZATION_TO_CONTACT',
  'AUTHORIZATION_TO_PUBLISH',
] as const;
export type PersonOnlyKind = (typeof PERSON_ONLY_KINDS)[number];

export const PROPOSAL_ACTIONS = [
  'REFRAME_OBJECTIVE',
  'OPEN_UNCERTAINTY',
  'LINK_UNCERTAINTIES',
  'RETIRE_UNCERTAINTY',
  'ESCALATE_PERSON_ONLY',
] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export interface ProposalRefusal {
  ok: false;
  /** Every reason, because a proposal refused for one thing usually has two. */
  reasons: string[];
}

export interface ProposalAccepted {
  ok: true;
  applied: string[];
  refused: string[];
}

export type ProposalOutcome = ProposalRefusal | ProposalAccepted;

/** Exactly the fields a proposal may carry. Anything else refuses the whole. */
const ALLOWED_FIELDS: Readonly<Record<ProposalAction, readonly string[]>> = Object.freeze({
  REFRAME_OBJECTIVE: [
    'action',
    'why',
    'decision_supported',
    'why_it_matters',
    'stakes',
    'reversibility',
    'consequence_if_wrong',
    'time_horizon',
    'constraints',
    'preferences',
    'examples',
    'assumptions',
    'non_goals',
    'useless_if',
  ],
  OPEN_UNCERTAINTY: [
    'action',
    'why',
    'uncertainty_key',
    'question',
    'why_it_matters',
    'stopping_condition',
    'consequence',
    'invalidating',
    'because_of',
  ],
  LINK_UNCERTAINTIES: ['action', 'why', 'from_key', 'to_key', 'kind'],
  RETIRE_UNCERTAINTY: ['action', 'why', 'uncertainty_key'],
  ESCALATE_PERSON_ONLY: [
    'action',
    'why',
    'uncertainty_key',
    'kind',
    'question',
    'what_it_authorizes',
    'exactly_what_is_needed',
  ],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 2000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function stringList(value: unknown, max = 20): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    const one = text(entry, 600);
    if (!one) return null;
    out.push(one);
  }
  return out;
}

function constraintList(value: unknown): StatedConstraint[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const out: StatedConstraint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    for (const field of Object.keys(entry)) {
      if (field !== 'statement' && field !== 'reason') return null;
    }
    const statement = text(entry['statement'], 600);
    if (!statement) return null;
    out.push({ statement, reason: text(entry['reason'], 600) });
  }
  return out;
}

function exampleList(value: unknown): StatedExample[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const out: StatedExample[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    for (const field of Object.keys(entry)) {
      if (field !== 'statement' && field !== 'property') return null;
    }
    const statement = text(entry['statement'], 600);
    if (!statement) return null;
    out.push({ statement, property: text(entry['property'], 600) });
  }
  return out;
}

/** A key a fragment could carry: lowercase, digits, dashes and underscores. */
const KEY = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/**
 * Validate a worker's proposal and apply what survives.
 *
 * All-or-nothing on *validation*: one malformed action refuses the proposal
 * whole, and nothing is written. Per-action on *application*: a proposal that
 * validates may still be refused a particular change by a guard over live rows
 * — a key that is already closed, a person-only escalation over discoverable
 * work — and each refusal is returned so the worker can see it and the revision
 * row keeps it.
 */
export async function applyProposal(input: {
  orchestration: ResearchOrchestration;
  actions: unknown;
  actorRef: string;
}): Promise<ProposalOutcome> {
  const { orchestration } = input;

  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    return { ok: false, reasons: ['A proposal must be a non-empty list of actions.'] };
  }
  if (input.actions.length > 20) {
    return { ok: false, reasons: ['A proposal may carry at most 20 actions.'] };
  }

  const reasons: string[] = [];
  const parsed: Record<string, unknown>[] = [];

  input.actions.forEach((raw, index) => {
    const where = `actions[${index}]`;
    if (!isRecord(raw)) {
      reasons.push(`${where} is not an object.`);
      return;
    }
    const action = raw['action'];
    // Matched exactly against the closed set. No substring, no closest match.
    const known = PROPOSAL_ACTIONS.find((candidate) => candidate === action);
    if (!known) {
      reasons.push(
        `${where}.action is not one of ${PROPOSAL_ACTIONS.join(', ')}.`,
      );
      return;
    }
    const allowed = ALLOWED_FIELDS[known];
    for (const field of Object.keys(raw)) {
      if (!allowed.includes(field)) {
        reasons.push(
          `${where} carries "${field}", which ${known} does not take. A field nobody defined ` +
            'is a field nobody validated, so the whole proposal is refused rather than the field.',
        );
      }
    }
    if (!text(raw['why'], 1200)) {
      reasons.push(`${where}.why must say why this change is being proposed.`);
    }
    parsed.push(raw);
  });

  if (reasons.length > 0) return { ok: false, reasons };

  const applied: string[] = [];
  const refused: string[] = [];

  for (const [index, raw] of parsed.entries()) {
    const where = `actions[${index}]`;
    const action = raw['action'] as ProposalAction;
    const why = text(raw['why'], 1200)!;

    switch (action) {
      case 'REFRAME_OBJECTIVE': {
        const stakes = RESEARCH_STAKES.find((one) => one === raw['stakes']);
        const reversibility = RESEARCH_REVERSIBILITY.find((one) => one === raw['reversibility']);
        const constraints = constraintList(raw['constraints']);
        const preferences = constraintList(raw['preferences']);
        const examples = exampleList(raw['examples']);
        const assumptions = stringList(raw['assumptions']);
        const nonGoals = stringList(raw['non_goals']);
        const uselessIf = stringList(raw['useless_if']);
        if (
          !constraints ||
          !preferences ||
          !examples ||
          !assumptions ||
          !nonGoals ||
          !uselessIf ||
          (raw['stakes'] !== undefined && !stakes) ||
          (raw['reversibility'] !== undefined && !reversibility)
        ) {
          refused.push(`${where}: one of its lists or enums is malformed.`);
          break;
        }
        const current = await ensureProblemModel(orchestration);
        await reviseProblemModel({
          orchestration,
          derivedFrom: 'PROPOSAL',
          reason: why,
          rationale: `Proposed by ${input.actorRef} and validated before it was recorded.`,
          revision: {
            decisionSupported:
              text(raw['decision_supported'], 1200) ?? current.decisionSupported,
            whyItMatters: text(raw['why_it_matters'], 1200) ?? current.whyItMatters,
            // Raised or lowered as proposed: stakes are a statement about the
            // world, not a permission, and nothing downstream of them can loosen
            // an evidence requirement — `allocateDepth` can only ever raise a
            // source floor and `floorFor` is taken as a maximum with the plan's.
            stakes: (stakes ?? current.stakes) as ResearchStakes,
            reversibility: (reversibility ?? current.reversibility) as ResearchReversibility,
            consequenceIfWrong:
              text(raw['consequence_if_wrong'], 1200) ?? current.consequenceIfWrong,
            timeHorizon: text(raw['time_horizon'], 300) ?? current.timeHorizon,
            constraints: constraints.length > 0 ? constraints : current.constraints,
            preferences: preferences.length > 0 ? preferences : current.preferences,
            examples: examples.length > 0 ? examples : current.examples,
            assumptions: assumptions.length > 0 ? assumptions : current.assumptions,
            nonGoals: nonGoals.length > 0 ? nonGoals : current.nonGoals,
            uselessIf: uselessIf.length > 0 ? uselessIf : current.uselessIf,
          },
        });
        applied.push(`${where}: recorded a new reading of the objective.`);
        break;
      }

      case 'OPEN_UNCERTAINTY': {
        const key = text(raw['uncertainty_key'], 64);
        const question = text(raw['question'], 1200);
        const matters = text(raw['why_it_matters'], 1200);
        const stopping = text(raw['stopping_condition'], 1200);
        const consequence = RESEARCH_STAKES.find((one) => one === raw['consequence']);
        if (!key || !KEY.test(key) || !question || !matters || !stopping) {
          refused.push(
            `${where}: a new question needs a key, the question, why it matters and what would ` +
              'settle it. A question with no stopping condition cannot be judged and would run ' +
              'until the budget stopped it.',
          );
          break;
        }
        if (raw['consequence'] !== undefined && !consequence) {
          refused.push(`${where}: consequence is not one of ${RESEARCH_STAKES.join(', ')}.`);
          break;
        }
        // `because_of` is re-resolved inside this packet. A follow-up that
        // named a question in another orchestration would be a proposal
        // reaching across a project boundary.
        const because = text(raw['because_of'], 64);
        if (because && !(await getUncertainty(orchestration.id, because))) {
          refused.push(`${where}: "${because}" is not a question in this packet.`);
          break;
        }
        const opened = await openUncertainty({
          orchestrationId: orchestration.id,
          projectId: orchestration.projectId,
          uncertaintyKey: key,
          question,
          whyItMatters: matters,
          consumerKind: 'CONCLUSION',
          consequence: consequence ?? 'MODERATE',
          invalidating: raw['invalidating'] === true,
          stoppingCondition: stopping,
          origin: 'FINDING',
          originRef: because ?? input.actorRef,
        });
        if (because) {
          await linkUncertainties({
            orchestrationId: orchestration.id,
            fromKey: because,
            toKey: key,
            kind: 'FOLLOW_UP',
            reason: why,
          });
        }
        applied.push(
          opened.created
            ? `${where}: opened "${key}".`
            : `${where}: "${key}" was already open, so nothing changed.`,
        );
        break;
      }

      case 'LINK_UNCERTAINTIES': {
        const from = text(raw['from_key'], 64);
        const to = text(raw['to_key'], 64);
        const kind = UNCERTAINTY_LINK_KINDS.find((one) => one === raw['kind']);
        if (!from || !to || !kind) {
          refused.push(
            `${where}: a link needs both keys and one of ${UNCERTAINTY_LINK_KINDS.join(', ')}.`,
          );
          break;
        }
        if (from === to) {
          refused.push(`${where}: a question cannot depend on itself.`);
          break;
        }
        const [a, b] = await Promise.all([
          getUncertainty(orchestration.id, from),
          getUncertainty(orchestration.id, to),
        ]);
        if (!a || !b) {
          refused.push(`${where}: one of those questions is not in this packet.`);
          break;
        }
        await linkUncertainties({
          orchestrationId: orchestration.id,
          fromKey: from,
          toKey: to,
          kind: kind as UncertaintyLinkKind,
          reason: why,
        });
        applied.push(`${where}: linked ${from} -> ${to} as ${kind}.`);
        break;
      }

      case 'RETIRE_UNCERTAINTY': {
        const key = text(raw['uncertainty_key'], 64);
        if (!key) {
          refused.push(`${where}: no question named.`);
          break;
        }
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: key,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'RETIRED',
          reason: why,
        });
        (ok ? applied : refused).push(
          ok
            ? `${where}: retired "${key}".`
            : `${where}: "${key}" is not open in this packet, so nothing was retired.`,
        );
        break;
      }

      case 'ESCALATE_PERSON_ONLY': {
        const key = text(raw['uncertainty_key'], 64);
        const kind = PERSON_ONLY_KINDS.find((one) => one === raw['kind']);
        const question = text(raw['question'], 1200);
        const authorizes = text(raw['what_it_authorizes'], 1200);
        const exactly = text(raw['exactly_what_is_needed'], 600);
        if (!key) {
          refused.push(`${where}: no question named.`);
          break;
        }
        if (!kind) {
          /*
           * The refusal that matters, and it says which half is wrong.
           *
           * Everything not on the list is discoverable, and a discoverable
           * question in front of a person is Brain declining its own work while
           * appearing to wait for them.
           */
          refused.push(
            `${where}: "${String(raw['kind'])}" is not something only a person can supply. ` +
              `The kinds that are: ${PERSON_ONLY_KINDS.join(', ')}. Anything else — a price, a ` +
              'contact channel, a legal requirement, an integration, a competitor, a delivery ' +
              'method — is research, and it is Brain\'s to do rather than the person\'s to ' +
              'attest to.',
          );
          break;
        }
        if (!question || !authorizes || !exactly) {
          /*
           * §24's rule at a new door: an escalation with no answering transition
           * is stuck rather than waiting. A person handed "we need input" cannot
           * act; a person handed one question, why Brain cannot answer it, what
           * their answer will let happen, and the exact thing required, can.
           */
          refused.push(
            `${where}: a person-only request must ask one explicit question, say what the ` +
              'answer will authorize, and name exactly what is needed. "What did you do?" is ' +
              'not a question anybody can act on.',
          );
          break;
        }
        const ok = await setUncertaintyDisposition({
          orchestrationId: orchestration.id,
          uncertaintyKey: key,
          from: ['OPEN', 'INVESTIGATING'],
          to: 'PERSON_ONLY',
          /*
           * The four things a person needs in order to act, in the order they
           * need them: what is being asked, why Brain cannot answer it, exactly
           * what would settle it, and what their answer will allow. Composed by
           * Brain from validated fields rather than pasted from prose, so the
           * shape is the same every time and no part of it can be left out.
           */
          reason:
            `${kind}. ${question} Brain cannot answer this because it is not discoverable. ` +
            `What is needed: ${exactly.replace(/[.\s]+$/, '')}. ` +
            `Answering it would allow: ${authorizes.replace(/[.\s]+$/, '')}.`,
        });
        (ok ? applied : refused).push(
          ok
            ? `${where}: escalated "${key}" as ${kind}.`
            : `${where}: "${key}" is not open in this packet.`,
        );
        break;
      }
    }
  }

  await recordPlanRevision({
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    reason: 'PERSON',
    summary:
      `${applied.length} change(s) applied and ${refused.length} refused, from a proposal by ` +
      `${input.actorRef}.`,
    decisions: parsed,
    applied,
    actorKind: 'WORKER',
    actorRef: input.actorRef,
  });

  return { ok: true, applied, refused };
}
