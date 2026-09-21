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
 * Two of the eleven findings create a **capability row**, and neither of them
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
  ACQUISITION_CONTRIBUTIONS,
  CAPABILITY_FINDINGS,
  CAPITAL_BASES,
  CAPITAL_SCENARIOS,
  CATEGORY_EVIDENCE_KINDS,
  DEMAND_SIGNAL_KINDS,
  DISTRIBUTION_CHANNEL_KINDS,
  ENTRY_BARRIER_KINDS,
  INCUMBENT_WEAKNESS_KINDS,
  MACHINE_CAPITAL_REQUIREMENTS,
  MACHINE_CATEGORY_KINDS,
  type AcquisitionContribution,
  type CapabilityFinding,
  type CapabilityRelation,
  type CapitalBasis,
  type CapitalScenario,
  type CategoryEvidenceKind,
  type DemandSignalKind,
  type DistributionChannelKind,
  type EntryBarrierKind,
  type IncumbentWeaknessKind,
  type MachineCapitalRequirement,
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

export function isMachineCapitalRequirement(value: unknown): value is MachineCapitalRequirement {
  return (
    typeof value === 'string' &&
    (MACHINE_CAPITAL_REQUIREMENTS as readonly string[]).includes(value)
  );
}

export function isCapitalScenario(value: unknown): value is CapitalScenario {
  return typeof value === 'string' && (CAPITAL_SCENARIOS as readonly string[]).includes(value);
}

export function isCapitalBasis(value: unknown): value is CapitalBasis {
  return typeof value === 'string' && (CAPITAL_BASES as readonly string[]).includes(value);
}

export function isAcquisitionContribution(value: unknown): value is AcquisitionContribution {
  return (
    typeof value === 'string' && (ACQUISITION_CONTRIBUTIONS as readonly string[]).includes(value)
  );
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
  | { table: 'EVIDENCE'; kind: CategoryEvidenceKind }
  | { table: 'CAPITAL' }
  | { table: 'ACQUISITION' };

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
  CAPITAL_REQUIREMENT: { table: 'CAPITAL' },
  ACQUISITION_CANDIDATE: { table: 'ACQUISITION' },
});

export function targetForFinding(finding: CapabilityFinding): FindingTarget {
  return CREATES[finding];
}

/**
 * Every finding names what it is about, and for five of them the name comes
 * from a closed set.
 *
 * A category and a capability carry a *name* — free text, because nobody can
 * enumerate the world's machine categories or engineering capabilities in
 * advance, which is the whole premise of this kernel and the reason there is
 * no list of either in this repository. The kinds that have a vocabulary carry
 * a *value*, and reading either out of the claim sentence would be the
 * prose-parsing §25's Westbrook defect records.
 *
 * `ACQUISITION_CANDIDATE` is free text for the same reason a category is:
 * nobody can enumerate the world's firms in advance. What it *would
 * contribute* is closed, and that is its qualifier.
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
  if (finding === 'CAPITAL_REQUIREMENT') return MACHINE_CAPITAL_REQUIREMENTS;
  return null;
}

/**
 * The *second* closed value a finding names, where its kind has one.
 *
 * `null` means the finding has no qualifier, and a qualifier given for one of
 * those is refused rather than stored: a value nothing will ever read, stored,
 * looks like it did something. §38's `structural_qualifier` is the same column
 * one kernel along and for the same reason — the judgement is made once by
 * whoever read the source, and everything after is a lookup.
 */
export function qualifierVocabularyFor(finding: CapabilityFinding): readonly string[] | null {
  if (finding === 'CAPITAL_REQUIREMENT') return CAPITAL_SCENARIOS;
  if (finding === 'ACQUISITION_CANDIDATE') return ACQUISITION_CONTRIBUTIONS;
  return null;
}

/**
 * Whether a finding may carry a money range, and must say what kind of figure
 * it is.
 *
 * Only a capital requirement, and the amount is **optional** even there: *the
 * requirement is real and nobody publishes what it costs* is a finding worth
 * having, and refusing it would push a worker towards producing an estimate —
 * which is the one output this kernel most needs never to receive. What is not
 * optional is the basis, because a figure whose kind nobody stated cannot be
 * weighed against one whose kind they did.
 */
export function findingTakesAmount(finding: CapabilityFinding): boolean {
  return finding === 'CAPITAL_REQUIREMENT';
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
  return finding === 'DEMAND_EVIDENCE' || finding === 'CAPITAL_REQUIREMENT';
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
  CAPITAL_REQUIREMENT:
    'the source establishes something entering this category costs owner money — set ' +
    'capability_subject to which requirement it is, capability_qualifier to which shape of ' +
    'the business the figure is about, capability_basis to what kind of figure it is, and ' +
    'capability_observed_on to the date it was true. Give the amount as ' +
    'capability_amount_low_minor and capability_amount_high_minor in minor units with ' +
    'capability_currency, or leave all three out: a requirement nobody publishes a figure ' +
    'for is a real finding and is worth submitting, and an estimate of your own is not',
  ACQUISITION_CANDIDATE:
    'the source names a firm that could be bought rather than built past — set ' +
    'capability_subject to its name and capability_qualifier to what buying it would ' +
    'contribute. This is identification only: nothing here approaches, values, offers to or ' +
    'commits to anybody, and no part of this system can',
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
    `CAPITAL_REQUIREMENT: ${MACHINE_CAPITAL_REQUIREMENTS.join(', ')}`,
  ].join('; ');
}

/**
 * The two qualifier sets, and the bases, as one sentence for a tool
 * description.
 *
 * Composed rather than restated, so a value added to one appears here without
 * anybody remembering a string.
 */
export function describeQualifiers(): string {
  return [
    `CAPITAL_REQUIREMENT capability_qualifier: ${CAPITAL_SCENARIOS.join(', ')}`,
    `CAPITAL_REQUIREMENT capability_basis: ${CAPITAL_BASES.join(', ')}`,
    `ACQUISITION_CANDIDATE capability_qualifier: ${ACQUISITION_CONTRIBUTIONS.join(', ')}`,
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
  /** The second closed value, where the finding's kind has one. */
  qualifier: string | null;
  /** What kind of figure the amount is. Only a capital requirement has one. */
  basis: string | null;
  /**
   * The published range in minor units, or null on all three.
   *
   * Null is a *finding* rather than a blank: the requirement is established and
   * nothing publishes what it costs. Everything downstream withholds a total
   * rather than summing past it, because a total that skipped an unpriced
   * requirement is smaller than anything published says — the direction nobody
   * checks, because it looks like a bargain.
   */
  amountLowMinor: number | null;
  amountHighMinor: number | null;
  currency: string | null;
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
  qualifier?: unknown;
  basis?: unknown;
  amountLowMinor?: unknown;
  amountHighMinor?: unknown;
  currency?: unknown;
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
    for (const [name, value] of [
      ['capability_qualifier', input.qualifier],
      ['capability_basis', input.basis],
      ['capability_amount_low_minor', input.amountLowMinor],
      ['capability_amount_high_minor', input.amountHighMinor],
      ['capability_currency', input.currency],
    ] as const) {
      if (!absent(value)) {
        return {
          ok: false,
          error: `${where}: ${name} was given with no capability_finding.`,
        };
      }
    }
    return { ok: true, value: EMPTY_DECLARATION };
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
          `${where}: a ${finding} finding must set capability_observed_on to the date the ` +
          'source observed it. An undated buying signal cannot be told apart from one somebody ' +
          'remembers from years ago, and an undated cost from one published before a tariff ' +
          'changed — and both are what decide whether a category may be entered.',
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
        'must be omitted. Only DEMAND_EVIDENCE and CAPITAL_REQUIREMENT have one.',
    };
  }

  const qualifierVocabulary = qualifierVocabularyFor(finding);
  const qualifier = tidy(input.qualifier);
  if (qualifierVocabulary) {
    if (!qualifier) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding must set capability_qualifier to one of ` +
          `${qualifierVocabulary.join(', ')}. ${describeQualifier(finding)}`,
      };
    }
    if (!qualifierVocabulary.includes(qualifier)) {
      return {
        ok: false,
        error:
          `${where}: capability_qualifier for a ${finding} finding must be one of ` +
          `${qualifierVocabulary.join(', ')}. "${qualifier}" is not one of them.`,
      };
    }
  } else if (qualifier) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding carries no capability_qualifier, so it must be ` +
        'omitted. Put the detail in the claim itself.',
    };
  }

  const money = validateAmount({ where, finding, input });
  if (!money.ok) return money;

  return {
    ok: true,
    value: {
      finding,
      subject,
      observedOn: observedOn || null,
      qualifier: qualifier || null,
      basis: money.basis,
      amountLowMinor: money.amountLowMinor,
      amountHighMinor: money.amountHighMinor,
      currency: money.currency,
    },
  };
}

const EMPTY_DECLARATION: CapabilityDeclaration = Object.freeze({
  finding: null,
  subject: null,
  observedOn: null,
  qualifier: null,
  basis: null,
  amountLowMinor: null,
  amountHighMinor: null,
  currency: null,
});

/** A declaration that says nothing, for a claim that carries no finding. */
export function emptyCapabilityDeclaration(): CapabilityDeclaration {
  return EMPTY_DECLARATION;
}

type AmountCheck =
  | {
      ok: true;
      basis: string | null;
      amountLowMinor: number | null;
      amountHighMinor: number | null;
      currency: string | null;
    }
  | { ok: false; error: string };

/**
 * The money half, and the asymmetry in it is the point.
 *
 * The **basis is required** wherever a figure could exist, because a figure
 * whose kind nobody stated cannot be weighed against one whose kind they did —
 * §14's rule that a claim must be judged by a standard that fits what it
 * claims, arriving at a column. The **amount is optional**, because *this is
 * required and nobody publishes what it costs* is a real finding: refusing it
 * would leave a worker with nothing to submit but an estimate of their own,
 * which is the one output this kernel most needs never to receive.
 *
 * A bare number is refused for `figures.ts`' reason one section along: reading
 * a currency into it would be the unknown taken as the favourable assumption,
 * and a thousandfold error reported as something somebody published is worse
 * than no figure at all.
 */
function validateAmount(args: {
  where: string;
  finding: CapabilityFinding;
  input: {
    basis?: unknown;
    amountLowMinor?: unknown;
    amountHighMinor?: unknown;
    currency?: unknown;
  };
}): AmountCheck {
  const { where, finding, input } = args;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const basis = typeof input.basis === 'string' ? input.basis.trim() : '';
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';

  if (!findingTakesAmount(finding)) {
    for (const [name, value] of [
      ['capability_basis', input.basis],
      ['capability_amount_low_minor', input.amountLowMinor],
      ['capability_amount_high_minor', input.amountHighMinor],
      ['capability_currency', input.currency],
    ] as const) {
      if (!absent(value)) {
        return {
          ok: false,
          error:
            `${where}: a ${finding} finding carries no money, so ${name} must be omitted. ` +
            'Only CAPITAL_REQUIREMENT does.',
        };
      }
    }
    return { ok: true, basis: null, amountLowMinor: null, amountHighMinor: null, currency: null };
  }

  if (!basis) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set capability_basis to one of ` +
        `${CAPITAL_BASES.join(', ')}. A regulator's published fee and somebody's market ` +
        'estimate are both worth having and are not the same fact.',
    };
  }
  if (!isCapitalBasis(basis)) {
    return {
      ok: false,
      error:
        `${where}: capability_basis must be one of ${CAPITAL_BASES.join(', ')}. ` +
        `"${basis}" is not one of them.`,
    };
  }

  const lowGiven = !absent(input.amountLowMinor);
  const highGiven = !absent(input.amountHighMinor);
  if (!lowGiven && !highGiven) {
    if (currency) {
      return {
        ok: false,
        error:
          `${where}: capability_currency was given with no amount. Either give the published ` +
          'range, or leave the currency out as well — a requirement nobody publishes a figure ' +
          'for is a finding worth submitting exactly as it is.',
      };
    }
    return { ok: true, basis, amountLowMinor: null, amountHighMinor: null, currency: null };
  }
  if (lowGiven !== highGiven) {
    return {
      ok: false,
      error:
        `${where}: give both capability_amount_low_minor and capability_amount_high_minor, or ` +
        'neither. A source that publishes one figure sets them equal, so every reader has one ' +
        'shape to handle.',
    };
  }

  const low = asMinor(input.amountLowMinor);
  const high = asMinor(input.amountHighMinor);
  if (low === null || high === null) {
    return {
      ok: false,
      error:
        `${where}: capability_amount_low_minor and capability_amount_high_minor must be whole ` +
        'non-negative numbers of minor units — 1250000 for $12,500.00, never "12,500" or "$12.5k".',
    };
  }
  if (high < low) {
    return {
      ok: false,
      error: `${where}: capability_amount_high_minor must not be below capability_amount_low_minor.`,
    };
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return {
      ok: false,
      error:
        `${where}: an amount must carry capability_currency as a three-letter ISO 4217 code. ` +
        'A bare number takes the unknown as a favourable assumption, and a figure in the wrong ' +
        "currency reported as something somebody published is worse than no figure.",
    };
  }
  return { ok: true, basis, amountLowMinor: low, amountHighMinor: high, currency };
}

function asMinor(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function describeQualifier(finding: CapabilityFinding): string {
  if (finding === 'CAPITAL_REQUIREMENT') {
    return 'It is which shape of the business the figure is about, not how large it is.';
  }
  return 'It is what buying this firm would contribute, not why it is attractive.';
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
