/**
 * What a structural finding means, and what it may create.
 *
 * ---------------------------------------------------------------------------
 * The one rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides which table it lands in, by a **lookup rather than
 * a reading**. `domain/opportunitySignals.ts` makes the same argument for the
 * same reason: the judgement is made once, by the only party that can make it
 * — somebody who read the source — and everything after that is Brain matching
 * a value from a closed set exactly. Nothing here inspects a sentence.
 *
 * Three of the ten kinds create no node. They are facts *about* a subject
 * rather than subjects of their own, and a graph that accepted them would
 * become a place to put everything — at which point "what is underneath
 * animation" stops having an answer.
 */
import {
  CAPITAL_MECHANISMS,
  CAPITAL_REQUIREMENTS,
  CONSTRAINT_KINDS,
  INDUSTRY_NODE_KINDS,
  STRUCTURAL_FINDINGS,
  type CapitalMechanism,
  type CapitalRequirement,
  type ConstraintKind,
  type IndustryNodeKind,
  type StructuralFinding,
} from './types.ts';

export { STRUCTURAL_FINDINGS };
export type { StructuralFinding };

export function isStructuralFinding(value: unknown): value is StructuralFinding {
  return typeof value === 'string' && (STRUCTURAL_FINDINGS as readonly string[]).includes(value);
}

export function isConstraintKind(value: unknown): value is ConstraintKind {
  return typeof value === 'string' && (CONSTRAINT_KINDS as readonly string[]).includes(value);
}

export function isCapitalRequirement(value: unknown): value is CapitalRequirement {
  return typeof value === 'string' && (CAPITAL_REQUIREMENTS as readonly string[]).includes(value);
}

export function isCapitalMechanism(value: unknown): value is CapitalMechanism {
  return typeof value === 'string' && (CAPITAL_MECHANISMS as readonly string[]).includes(value);
}

export function isIndustryNodeKind(value: unknown): value is IndustryNodeKind {
  return typeof value === 'string' && (INDUSTRY_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * The node kind a structural finding creates, or null for the three that
 * create none.
 *
 * A `Record` over the whole union rather than a `Set` of the ones that do, so
 * a kind added later is a compile error until somebody says what it creates.
 * §27 records what two `Set`s that must be total between them cost: a refusal
 * fell into the exhausting branch by default because neither named it.
 */
const CREATES: Readonly<Record<StructuralFinding, IndustryNodeKind | null>> = Object.freeze({
  SUB_INDUSTRY: 'SUB_INDUSTRY',
  VALUE_CHAIN_LAYER: 'VALUE_CHAIN_LAYER',
  BUYER_TYPE: 'BUYER_TYPE',
  FULFILMENT_SOURCE: 'FULFILMENT_SOURCE',
  TRANSACTION_TYPE: 'TRANSACTION_TYPE',
  BOTTLENECK: 'BOTTLENECK',
  ADJACENT_INDUSTRY: 'ADJACENT_INDUSTRY',
  HIDDEN_CONSTRAINT: null,
  CAPITAL_REQUIREMENT: null,
  CAPITAL_RESTRUCTURING: null,
});

export function nodeKindForFinding(finding: StructuralFinding): IndustryNodeKind | null {
  return CREATES[finding];
}

/**
 * Every finding names what it is about, and for three of them the name comes
 * from a closed set.
 *
 * The seven that create a node carry a *name* — free text, because nobody can
 * enumerate the world's sub-industries in advance, which is the whole premise
 * of this kernel. The other three carry a *value*: a capital requirement is
 * one of sixteen, a restructuring is one of twenty-five, a hidden constraint
 * is one of fourteen. Both are the same field because both answer the same
 * question, and reading either out of the claim sentence would be the
 * prose-parsing §25's Westbrook defect records — a confidently wrong answer
 * that every row around it agrees with.
 *
 * `null` here means free text. It does **not** mean unvalidated: the subject
 * is still required, still trimmed, and still the only thing that can name a
 * node.
 */
export function subjectVocabularyFor(finding: StructuralFinding): readonly string[] | null {
  if (finding === 'CAPITAL_REQUIREMENT') return CAPITAL_REQUIREMENTS;
  if (finding === 'CAPITAL_RESTRUCTURING') return CAPITAL_MECHANISMS;
  if (finding === 'HIDDEN_CONSTRAINT') return CONSTRAINT_KINDS;
  return null;
}

/**
 * Whether a finding may say which *other* thing it is about.
 *
 * Only a restructuring: it answers a requirement, and which one decides
 * whether its published residual reduces anything. Everything else is about
 * itself, and accepting a qualifier on one would let a caller write a value
 * nothing ever reads — worse than refusing it, because it looks like it did
 * something.
 */
export function findingTakesQualifier(finding: StructuralFinding): boolean {
  return finding === 'CAPITAL_RESTRUCTURING';
}

/**
 * Whether a finding may carry a figure.
 *
 * The two capital kinds, and nothing else. A bottleneck with a number on it
 * would be a number nothing sums; a sub-industry with one would be a valuation
 * nobody asked for. The absence of a figure on a capital finding is
 * meaningful — see `readCapital` — so it is never required, only permitted.
 */
export function findingTakesAmount(finding: StructuralFinding): boolean {
  return finding === 'CAPITAL_REQUIREMENT' || finding === 'CAPITAL_RESTRUCTURING';
}

/**
 * Kept as the name it has always had, now meaning *creates something named in
 * the map* rather than *needs a subject at all* — every finding needs one.
 */
export function findingCreatesNode(finding: StructuralFinding): boolean {
  return CREATES[finding] !== null;
}

/**
 * Which of an expanded node's children are *narrower economies* rather than
 * facts about the one above them.
 *
 * Only these are asked the decomposition question again, which is what keeps
 * recursion from running forever: a bottleneck, a buyer type and a transaction
 * type are leaves of understanding rather than places with more inside them,
 * so mapping them would produce a graph of adjectives. They are still scanned
 * for openings, because a bottleneck is exactly where an opening lives.
 */
const RECURSES: Readonly<Record<IndustryNodeKind, boolean>> = Object.freeze({
  SECTOR: true,
  SUB_INDUSTRY: true,
  VALUE_CHAIN_LAYER: true,
  ADJACENT_INDUSTRY: true,
  BUYER_TYPE: false,
  FULFILMENT_SOURCE: false,
  TRANSACTION_TYPE: false,
  BOTTLENECK: false,
});

export function kindRecurses(kind: IndustryNodeKind): boolean {
  return RECURSES[kind];
}

/**
 * One line per finding, for the assignment a worker actually reads.
 *
 * §33 records why this belongs in the assignment rather than only on the
 * submission tool: by the time somebody is filling in a claim they have
 * already decided what they were looking for, and the submission tool is the
 * wrong end of the job.
 */
export const FINDING_GUIDE: Readonly<Record<StructuralFinding, string>> = Object.freeze({
  SUB_INDUSTRY:
    'the source names a narrower industry inside this one — set structural_subject to its name',
  VALUE_CHAIN_LAYER:
    'the source names a stage of producing or delivering here — set structural_subject to it',
  BUYER_TYPE:
    'the source names a kind of organisation that pays for this work',
  FULFILMENT_SOURCE:
    'the source names who or what actually performs the work that gets paid for',
  TRANSACTION_TYPE:
    'the source describes how money changes hands here: what is bought, on what terms',
  BOTTLENECK:
    'the source documents a constraint on supply — a shortage, a queue, a chokepoint',
  ADJACENT_INDUSTRY:
    'the source names a different industry connected to this one',
  HIDDEN_CONSTRAINT:
    'the source establishes something that changes the economics and is not obvious from ' +
    'outside — not a risk every business has',
  CAPITAL_REQUIREMENT:
    'the source states a specific thing that requires owner capital, ideally with a figure',
  CAPITAL_RESTRUCTURING:
    'the source documents a practice that removes, defers or shifts a capital requirement',
});

/**
 * The three closed sets a subject may have to come from, as one sentence for a
 * tool description.
 *
 * Composed from the vocabularies rather than restated, so a value added to one
 * of them appears here without anybody remembering to update a string. A
 * description that drifts from the enum beside it is how a worker is told to
 * send something the schema refuses.
 */
export const CAPITAL_REQUIREMENTS_GUIDE = [
  `CAPITAL_REQUIREMENT — one of ${(subjectVocabularyFor('CAPITAL_REQUIREMENT') ?? []).join(', ')}`,
  `CAPITAL_RESTRUCTURING — one of ${(subjectVocabularyFor('CAPITAL_RESTRUCTURING') ?? []).join(', ')}`,
  `HIDDEN_CONSTRAINT — one of ${(subjectVocabularyFor('HIDDEN_CONSTRAINT') ?? []).join(', ')}`,
].join('; ');

/**
 * A node's full name from its root down, which is what a question about it
 * actually has to say.
 *
 * "Finishing" is not a researchable subject. "Animation and anime production →
 * TV animation → finishing" is. A question composed from the leaf alone would
 * be the scope defect §25 records, arriving through a foreign key instead of
 * through prose.
 */
export function pathOf(
  nodeId: string,
  byId: ReadonlyMap<string, { id: string; parentId: string | null; name: string }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(nodeId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current.name);
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null;
  }
  return out;
}

export function depthOf(
  nodeId: string,
  byId: ReadonlyMap<string, { id: string; parentId: string | null; name: string }>,
): number {
  return Math.max(0, pathOf(nodeId, byId).length - 1);
}

/**
 * The structural declaration on one claim, validated once.
 *
 * ---------------------------------------------------------------------------
 * Why this is a function rather than two copies of a rule
 * ---------------------------------------------------------------------------
 *
 * Two readers check this declaration — `services/research/schema.ts` for a
 * pass a provider returned, and `mcp/researchTools.ts` for a claim a worker
 * submitted over the wire. This repository has had to write *a rule applied by
 * one of two readers is worse than none* four times, and every instance was
 * two implementations that agreed on the day they were written. So both call
 * this, and it is the only thing that decides.
 *
 * ---------------------------------------------------------------------------
 * Refused here, where the worker can still fix it
 * ---------------------------------------------------------------------------
 *
 * Every failure below refuses the submission rather than dropping the field.
 * §27 records why: truncation and silent dropping are the outcomes a worker
 * cannot recover from, because they are reported as success — a correct plan
 * cut mid-JSON was re-submitted identically until the bin retired. Refused,
 * the worker corrects one field and submits the same claims again on the same
 * item, with the attempt still there to spend.
 */
export interface StructuralDeclaration {
  finding: StructuralFinding | null;
  subject: string | null;
  qualifier: string | null;
  amountCents: number | null;
}

export type StructuralCheck =
  | { ok: true; value: StructuralDeclaration }
  | { ok: false; error: string };

export function validateStructural(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  qualifier: unknown;
  amountCents: unknown;
}): StructuralCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const qualifier = tidy(input.qualifier);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing structural, which is most
     * claims. Its companions must then be absent too: a subject with no
     * finding is a value nothing will ever read, and storing it would look
     * like it had done something.
     */
    if (subject) {
      return {
        ok: false,
        error:
          `${where}: structural_subject was given with no structural_finding. Say which kind ` +
          'of structural fact this establishes, or leave the subject out.',
      };
    }
    if (qualifier) {
      return {
        ok: false,
        error: `${where}: structural_qualifier was given with no structural_finding.`,
      };
    }
    if (!absent(input.amountCents)) {
      return {
        ok: false,
        error: `${where}: structural_amount_cents was given with no structural_finding.`,
      };
    }
    return { ok: true, value: { finding: null, subject: null, qualifier: null, amountCents: null } };
  }

  if (!isStructuralFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: structural_finding must be one of ${STRUCTURAL_FINDINGS.join(', ')}, or ` +
        'omitted when the claim says nothing about how the industry is put together.',
    };
  }
  const finding = input.finding;

  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set structural_subject. ` +
        describeSubject(finding),
    };
  }
  const vocabulary = subjectVocabularyFor(finding);
  if (vocabulary && !vocabulary.includes(subject)) {
    return {
      ok: false,
      error:
        `${where}: structural_subject for a ${finding} finding must be one of ` +
        `${vocabulary.join(', ')}. "${subject}" is not one of them — say which of those this ` +
        'is, and put the detail in the claim itself.',
    };
  }

  if (qualifier && !findingTakesQualifier(finding)) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding is about itself, so structural_qualifier must be ` +
        'omitted. Only CAPITAL_RESTRUCTURING names another thing.',
    };
  }
  if (findingTakesQualifier(finding)) {
    if (!qualifier) {
      return {
        ok: false,
        error:
          `${where}: a CAPITAL_RESTRUCTURING must set structural_qualifier to the requirement ` +
          `it answers, one of ${CAPITAL_REQUIREMENTS.join(', ')}. A structure that does not ` +
          'say what it answers reduces nothing.',
      };
    }
    if (!isCapitalRequirement(qualifier)) {
      return {
        ok: false,
        error:
          `${where}: structural_qualifier must be one of ${CAPITAL_REQUIREMENTS.join(', ')}.`,
      };
    }
  }

  let amountCents: number | null = null;
  if (!absent(input.amountCents)) {
    if (!findingTakesAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so structural_amount_cents must ` +
          'be omitted. Only the two capital kinds have an amount.',
      };
    }
    if (
      typeof input.amountCents !== 'number' ||
      !Number.isFinite(input.amountCents) ||
      !Number.isInteger(input.amountCents) ||
      input.amountCents < 0
    ) {
      return {
        ok: false,
        error:
          `${where}: structural_amount_cents must be a whole number of minor units, not ` +
          'negative. Leave it out where no source publishes an amount — an unknown is ' +
          'recorded as unknown and withholds the minimum, which is the correct outcome.',
      };
    }
    amountCents = input.amountCents;
  }

  return {
    ok: true,
    value: {
      finding,
      subject,
      qualifier: qualifier || null,
      amountCents,
    },
  };
}

function describeSubject(finding: StructuralFinding): string {
  const vocabulary = subjectVocabularyFor(finding);
  return vocabulary
    ? `It must be one of ${vocabulary.join(', ')}.`
    : "It is the subject's own name as the source calls it, not a sentence about it — and " +
        'nothing else can supply it.';
}
