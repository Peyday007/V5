/**
 * What a capability finding means, and what it may create.
 *
 * ---------------------------------------------------------------------------
 * The one rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides which table it lands in, by a **lookup rather than
 * a reading**. `domain/industry.ts` makes the same argument for the same
 * reason, and `domain/opportunitySignals.ts` made it first: the judgement is
 * made once, by the only party that can make it — somebody who read the
 * source — and everything after that is Brain matching a value from a closed
 * set exactly. Nothing here inspects a sentence.
 *
 * ---------------------------------------------------------------------------
 * The rule that is specific to this kernel
 * ---------------------------------------------------------------------------
 *
 * Two of the nine findings create a **capability row**, and neither of them
 * may ever mark it held. `CAPABILITY_REQUIRED` says producing in a category
 * needs something; `CAPABILITY_TAUGHT` says producing there develops it. Both
 * are facts about machines. Whether *this company* holds a capability is a
 * fact about this company, it has its own two sources (a person's declaration,
 * or work this project actually delivered), and there is no value of
 * `capability_finding` that could establish it.
 *
 * That separation is what stops a well-sourced packet about what motorcycle
 * production teaches being read, three joins later, as evidence that this
 * company can build motorcycles — which is §37's "a definition is not an
 * implementation" arriving in a factory.
 */
import {
  CAPABILITY_FINDINGS,
  CATEGORY_EVIDENCE_KINDS,
  DEMAND_SIGNAL_KINDS,
  DISTRIBUTION_CHANNEL_KINDS,
  ENTRY_BARRIER_KINDS,
  INCUMBENT_WEAKNESS_KINDS,
  MACHINE_CATEGORY_KINDS,
  type CapabilityFinding,
  type CapabilityRelation,
  type CategoryEvidenceKind,
  type DemandSignalKind,
  type DistributionChannelKind,
  type EntryBarrierKind,
  type IncumbentWeaknessKind,
  type MachineCategoryKind,
} from './types.ts';

export { CAPABILITY_FINDINGS };
export type { CapabilityFinding };

export function isCapabilityFinding(value: unknown): value is CapabilityFinding {
  return typeof value === 'string' && (CAPABILITY_FINDINGS as readonly string[]).includes(value);
}

export function isMachineCategoryKind(value: unknown): value is MachineCategoryKind {
  return typeof value === 'string' && (MACHINE_CATEGORY_KINDS as readonly string[]).includes(value);
}

export function isCategoryEvidenceKind(value: unknown): value is CategoryEvidenceKind {
  return (
    typeof value === 'string' && (CATEGORY_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

export function isDemandSignalKind(value: unknown): value is DemandSignalKind {
  return typeof value === 'string' && (DEMAND_SIGNAL_KINDS as readonly string[]).includes(value);
}

export function isDistributionChannelKind(value: unknown): value is DistributionChannelKind {
  return (
    typeof value === 'string' &&
    (DISTRIBUTION_CHANNEL_KINDS as readonly string[]).includes(value)
  );
}

export function isIncumbentWeaknessKind(value: unknown): value is IncumbentWeaknessKind {
  return (
    typeof value === 'string' && (INCUMBENT_WEAKNESS_KINDS as readonly string[]).includes(value)
  );
}

export function isEntryBarrierKind(value: unknown): value is EntryBarrierKind {
  return typeof value === 'string' && (ENTRY_BARRIER_KINDS as readonly string[]).includes(value);
}

/**
 * What a finding produces: a category, a capability edge, or a row of evidence
 * about the category the round was asking about.
 *
 * A `Record` over the whole union rather than three `Set`s, so a finding added
 * later is a compile error until somebody says what it creates. §27 records
 * what two `Set`s that must be total between them cost — a refusal fell into
 * the exhausting branch by default because neither named it.
 */
export type FindingTarget =
  | { table: 'CATEGORY'; kind: MachineCategoryKind }
  | { table: 'CAPABILITY'; relation: CapabilityRelation }
  | { table: 'EVIDENCE'; kind: CategoryEvidenceKind };

const CREATES: Readonly<Record<CapabilityFinding, FindingTarget>> = Object.freeze({
  PRODUCT_CATEGORY: { table: 'CATEGORY', kind: 'PRODUCT_CATEGORY' },
  ADJACENT_CATEGORY: { table: 'CATEGORY', kind: 'ADJACENT_CATEGORY' },
  CAPABILITY_REQUIRED: { table: 'CAPABILITY', relation: 'REQUIRES' },
  CAPABILITY_TAUGHT: { table: 'CAPABILITY', relation: 'TEACHES' },
  DEMAND_EVIDENCE: { table: 'EVIDENCE', kind: 'DEMAND_EVIDENCE' },
  DISTRIBUTION_CHANNEL: { table: 'EVIDENCE', kind: 'DISTRIBUTION_CHANNEL' },
  INCUMBENT_WEAKNESS: { table: 'EVIDENCE', kind: 'INCUMBENT_WEAKNESS' },
  ENTRY_BARRIER: { table: 'EVIDENCE', kind: 'ENTRY_BARRIER' },
  BOUGHT_IN_COMPONENT: { table: 'EVIDENCE', kind: 'BOUGHT_IN_COMPONENT' },
});

export function targetForFinding(finding: CapabilityFinding): FindingTarget {
  return CREATES[finding];
}

/**
 * Every finding names what it is about, and for four of them the name comes
 * from a closed set.
 *
 * A category and a capability carry a *name* — free text, because nobody can
 * enumerate the world's machine categories or engineering capabilities in
 * advance, which is the whole premise of this kernel and the reason there is
 * no list of either in this repository. The four evidence kinds that have a
 * vocabulary carry a *value*, and reading either out of the claim sentence
 * would be the prose-parsing §25's Westbrook defect records.
 *
 * `BOUGHT_IN_COMPONENT` is the fifth evidence kind and is deliberately free
 * text: a starter motor, a hydraulic pump and a flight control computer are
 * not members of any set somebody could have written down first.
 *
 * `null` here means free text. It does **not** mean unvalidated: the subject
 * is still required and still trimmed.
 */
export function subjectVocabularyFor(finding: CapabilityFinding): readonly string[] | null {
  if (finding === 'DEMAND_EVIDENCE') return DEMAND_SIGNAL_KINDS;
  if (finding === 'DISTRIBUTION_CHANNEL') return DISTRIBUTION_CHANNEL_KINDS;
  if (finding === 'INCUMBENT_WEAKNESS') return INCUMBENT_WEAKNESS_KINDS;
  if (finding === 'ENTRY_BARRIER') return ENTRY_BARRIER_KINDS;
  return null;
}

/**
 * Whether a finding must carry the date the source observed it.
 *
 * Only a demand signal. §30 settled this one table along and the reasoning is
 * unchanged: an undated buying signal cannot be told apart from one somebody
 * remembers from March, and a category made enterable by a stale one is the
 * expensive direction to be wrong in. A certification requirement and a
 * capability are not that kind of fact, and requiring a date of them would
 * produce invented ones.
 */
export function findingTakesObservedOn(finding: CapabilityFinding): boolean {
  return finding === 'DEMAND_EVIDENCE';
}

/**
 * The deterministic reduction of a capability's name to its identity.
 *
 * Lowercased, runs of anything that is not a letter or a digit collapsed to a
 * single dash, ends trimmed. "Chassis Engineering", "chassis engineering" and
 * "Chassis  engineering" are one capability; "chassis engineering" and "frame
 * design" are two.
 *
 * That second case is a real limit rather than an oversight, and it is the
 * honest one to take: joining them needs a reader deciding that two phrases
 * mean one thing, which is exactly `SEMANTIC_MERGE_FLOOR`'s territory (§24) —
 * and a guess here would silently weld together two capability chains that are
 * not the same chain, which is worse than holding two rows a person can see.
 */
export function capabilitySlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A category's full name from its root down, which is what a question about it
 * actually has to say.
 *
 * "Pumps" is not a researchable subject. "Powered cleaning equipment →
 * commercial pressure washers → pumps" is. A question composed from the leaf
 * alone would be the scope defect §25 records, arriving through a foreign key
 * instead of through prose.
 */
export function pathOf(
  categoryId: string,
  byId: ReadonlyMap<string, { id: string; parentId: string | null; name: string }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(categoryId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.unshift(current.name);
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null;
  }
  return out;
}

export function depthOf(
  categoryId: string,
  byId: ReadonlyMap<string, { id: string; parentId: string | null; name: string }>,
): number {
  return Math.max(0, pathOf(categoryId, byId).length - 1);
}

/**
 * One line per finding, for the assignment a worker actually reads.
 *
 * §33 records why this belongs in the assignment rather than only on the
 * submission tool: by the time somebody is filling in a claim they have
 * already decided what they were looking for, and the submission tool is the
 * wrong end of the job.
 */
export const FINDING_GUIDE: Readonly<Record<CapabilityFinding, string>> = Object.freeze({
  PRODUCT_CATEGORY:
    'the source names a narrower or more specific class of machine inside this one — set ' +
    'capability_subject to its name',
  ADJACENT_CATEGORY:
    'the source names a different class of machine connected to this one: built by the same ' +
    'kind of producer, sold through the same channel, or sharing major components',
  CAPABILITY_REQUIRED:
    'the source establishes that producing in this category requires a particular engineering, ' +
    'manufacturing, supply or servicing capability — set capability_subject to the capability',
  CAPABILITY_TAUGHT:
    'the source establishes that producing in this category develops or depends on building ' +
    'up a capability, which is what makes a later category easier to enter',
  DEMAND_EVIDENCE:
    'the source publishes an observation that buyers here are actually buying — volumes, ' +
    'registrations, a fleet purchase, a tender, a replacement cycle, a realised price, a ' +
    'backlog or an installed base, carrying the date the source observed it',
  DISTRIBUTION_CHANNEL:
    'the source establishes how product in this category actually reaches whoever pays for it',
  INCUMBENT_WEAKNESS:
    'the source documents a failure, recall, gap, delay or unmet requirement in what is on ' +
    'the market today — not an opinion that existing products are poor',
  ENTRY_BARRIER:
    'the source establishes something that must be obtained, certified, tooled or reached ' +
    'before anybody may produce here',
  BOUGHT_IN_COMPONENT:
    'the source establishes a component or subsystem that producers in this category buy in ' +
    'rather than make — set capability_subject to the component',
});

/**
 * The four closed sets a subject may have to come from, as one sentence for a
 * tool description.
 *
 * Composed from the vocabularies rather than restated, so a value added to one
 * of them appears here without anybody remembering to update a string.
 */
export function describeVocabularies(): string {
  return [
    `DEMAND_EVIDENCE: ${DEMAND_SIGNAL_KINDS.join(', ')}`,
    `DISTRIBUTION_CHANNEL: ${DISTRIBUTION_CHANNEL_KINDS.join(', ')}`,
    `INCUMBENT_WEAKNESS: ${INCUMBENT_WEAKNESS_KINDS.join(', ')}`,
    `ENTRY_BARRIER: ${ENTRY_BARRIER_KINDS.join(', ')}`,
  ].join('; ');
}

/**
 * The capability declaration on one claim, validated once.
 *
 * ---------------------------------------------------------------------------
 * Why this is a function rather than two copies of a rule
 * ---------------------------------------------------------------------------
 *
 * Two readers check this declaration — `services/research/schema.ts` for a
 * pass a provider returned, and `mcp/researchTools.ts` for a claim a worker
 * submitted over the wire. This repository has had to write *a rule applied by
 * one of two readers is worse than none* five times, and every instance was
 * two implementations that agreed on the day they were written. So both call
 * this, and it is the only thing that decides.
 *
 * ---------------------------------------------------------------------------
 * Refused here, where the worker can still fix it
 * ---------------------------------------------------------------------------
 *
 * Every failure below refuses the submission rather than dropping the field.
 * §27 records why: truncation and silent dropping are the outcomes a worker
 * cannot recover from, because they are reported as success. Refused, the
 * worker corrects one field and submits the same claims again on the same
 * item, with the attempt still there to spend.
 */
export interface CapabilityDeclaration {
  finding: CapabilityFinding | null;
  subject: string | null;
  observedOn: string | null;
}

export type CapabilityCheck =
  | { ok: true; value: CapabilityDeclaration }
  | { ok: false; error: string };

/** ISO-8601 to the day, which is the resolution a published observation has. */
const OBSERVED_ON = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

export function validateCapabilityFinding(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  observedOn: unknown;
}): CapabilityCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const observedOn = tidy(input.observedOn);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about building anything, which
     * is most claims. Its companions must then be absent too: a subject with
     * no finding is a value nothing will ever read, and storing it would look
     * like it had done something.
     */
    if (subject) {
      return {
        ok: false,
        error:
          `${where}: capability_subject was given with no capability_finding. Say which kind ` +
          'of fact about building this establishes, or leave the subject out.',
      };
    }
    if (observedOn) {
      return {
        ok: false,
        error: `${where}: capability_observed_on was given with no capability_finding.`,
      };
    }
    return { ok: true, value: { finding: null, subject: null, observedOn: null } };
  }

  if (!isCapabilityFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: capability_finding must be one of ${CAPABILITY_FINDINGS.join(', ')}, or ` +
        'omitted when the claim says nothing about what building a machine takes or teaches.',
    };
  }
  const finding = input.finding;

  if (!subject) {
    return {
      ok: false,
      error: `${where}: a ${finding} finding must set capability_subject. ${describeSubject(finding)}`,
    };
  }
  const vocabulary = subjectVocabularyFor(finding);
  if (vocabulary && !vocabulary.includes(subject)) {
    return {
      ok: false,
      error:
        `${where}: capability_subject for a ${finding} finding must be one of ` +
        `${vocabulary.join(', ')}. "${subject}" is not one of them — say which of those this ` +
        'is, and put the detail in the claim itself.',
    };
  }

  if (findingTakesObservedOn(finding)) {
    if (!observedOn) {
      return {
        ok: false,
        error:
          `${where}: a DEMAND_EVIDENCE finding must set capability_observed_on to the date the ` +
          'source observed it. An undated buying signal cannot be told apart from one somebody ' +
          'remembers from years ago, and it is what decides whether a category is enterable.',
      };
    }
    if (!OBSERVED_ON.test(observedOn)) {
      return {
        ok: false,
        error: `${where}: capability_observed_on must be an ISO-8601 date, such as 2026-03-14.`,
      };
    }
  } else if (observedOn) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding carries no observation date, so capability_observed_on ` +
        'must be omitted. Only DEMAND_EVIDENCE has one.',
    };
  }

  return {
    ok: true,
    value: { finding, subject, observedOn: observedOn || null },
  };
}

function describeSubject(finding: CapabilityFinding): string {
  const vocabulary = subjectVocabularyFor(finding);
  if (vocabulary) return `It must be one of ${vocabulary.join(', ')}.`;
  if (finding === 'PRODUCT_CATEGORY' || finding === 'ADJACENT_CATEGORY') {
    return "It is the category's own name as the source calls it, not a sentence about it.";
  }
  if (finding === 'BOUGHT_IN_COMPONENT') {
    return "It is the component's own name as the source calls it.";
  }
  return (
    'It is the capability itself — what an organisation must be able to do — named as shortly ' +
    'as it can be while still being the same capability wherever it appears.'
  );
}
