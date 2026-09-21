/**
 * What a dealflow finding means, what it may create, and the one validator
 * both submission doors call.
 *
 * ---------------------------------------------------------------------------
 * The rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides which table it lands in, by a **lookup rather than
 * a reading**. `domain/industry.ts` makes the argument for the same reason and
 * `domain/opportunitySignals.ts` before it: the judgement is made once, by the
 * only party that can make it — somebody who actually read the source — and
 * everything after that is Brain matching a value from a closed set exactly.
 * Nothing here inspects a sentence, and nothing downstream may either.
 *
 * ---------------------------------------------------------------------------
 * A jurisdiction is a column, never a sentence
 * ---------------------------------------------------------------------------
 *
 * §25 records the Westbrook defect: a compiler read a state out of prose and
 * produced "official Michigan public records … in Westbrook, OH" with every
 * row around it healthy. Cross-border trade is (product × jurisdiction) keyed
 * from end to end — the same trailer is legal in one market and unregistrable
 * in the next — so the jurisdiction travels as its own declared field on every
 * finding that has one. A requirement whose destination had to be recovered
 * from the claim text would be the same defect, in the one place where being
 * confidently wrong means the equipment is built before anybody finds out.
 */
import {
  COMMERCIAL_STRUCTURES,
  COMPLIANCE_LAYERS,
  COST_COMPONENTS,
  DEAL_FINDINGS,
  DEAL_OBSERVATION_KINDS,
  DEAL_PARTY_KINDS,
  DEAL_ROUND_PURPOSES,
  DEAL_STAGES,
  REQUIREMENT_POSTURES,
  type CommercialStructure,
  type ComplianceLayer,
  type CostComponent,
  type DealFinding,
  type DealObservationKind,
  type DealPartyKind,
  type DealRoundPurpose,
  type DealStage,
  type RequirementPosture,
} from './types.ts';

export {
  COMMERCIAL_STRUCTURES,
  COMPLIANCE_LAYERS,
  COST_COMPONENTS,
  DEAL_FINDINGS,
  REQUIREMENT_POSTURES,
};
export type { CommercialStructure, ComplianceLayer, CostComponent, DealFinding };

export function isDealFinding(value: unknown): value is DealFinding {
  return typeof value === 'string' && (DEAL_FINDINGS as readonly string[]).includes(value);
}

export function isComplianceLayer(value: unknown): value is ComplianceLayer {
  return typeof value === 'string' && (COMPLIANCE_LAYERS as readonly string[]).includes(value);
}

export function isCostComponent(value: unknown): value is CostComponent {
  return typeof value === 'string' && (COST_COMPONENTS as readonly string[]).includes(value);
}

export function isCommercialStructure(value: unknown): value is CommercialStructure {
  return typeof value === 'string' && (COMMERCIAL_STRUCTURES as readonly string[]).includes(value);
}

export function isDealPartyKind(value: unknown): value is DealPartyKind {
  return typeof value === 'string' && (DEAL_PARTY_KINDS as readonly string[]).includes(value);
}

export function isDealRoundPurpose(value: unknown): value is DealRoundPurpose {
  return typeof value === 'string' && (DEAL_ROUND_PURPOSES as readonly string[]).includes(value);
}

export function isDealStage(value: unknown): value is DealStage {
  return typeof value === 'string' && (DEAL_STAGES as readonly string[]).includes(value);
}

export function isDealObservationKind(value: unknown): value is DealObservationKind {
  return typeof value === 'string' && (DEAL_OBSERVATION_KINDS as readonly string[]).includes(value);
}

/**
 * The equipment key two rows are matched on.
 *
 * ---------------------------------------------------------------------------
 * Deliberately the weakest matcher that could work
 * ---------------------------------------------------------------------------
 *
 * Case, surrounding whitespace and internal runs of it, and nothing else. It
 * does not stem, does not strip plurals, does not drop adjectives and does not
 * know that a "fuel tanker semi-trailer" and a "fuel tank trailer" might be
 * the same thing. §37 settled why: *a matcher that tried harder would produce
 * confident wrong answers, and missing a match costs a reading while inventing
 * one tells somebody a thing exists.* Here an invented match pairs a buyer
 * with a supplier that cannot build what they need, and every row around it
 * reads healthy.
 *
 * The classes converge instead by Brain supplying the vocabulary: a supply
 * question names the class **verbatim from Brain's own rows** and asks the
 * worker to declare it back unchanged, exactly as `scanQuestion` carries the
 * subject path. That is a convergence mechanism somebody can read, rather than
 * a similarity threshold nobody can audit.
 */
export function equipmentKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same normalization for a market name, so two spellings of one country do not split it. */
export function jurisdictionKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * What each finding creates.
 *
 * A `Record` over the whole union rather than a `Set` of the ones that do, so
 * a finding added later is a compile error until somebody says where it lands.
 * §27 records what two `Set`s that must be total between them cost: a refusal
 * fell into the exhausting branch by default because neither named it.
 */
export type DealFindingTarget =
  | 'PARTY'
  | 'REQUIREMENT'
  | 'COST'
  | 'STRUCTURE_EVIDENCE'
  /** A fact about a party already on the map, attached to the round's own subject. */
  | 'PARTY_ATTRIBUTE';

const TARGET: Readonly<Record<DealFinding, DealFindingTarget>> = Object.freeze({
  BUYER_NEED: 'PARTY',
  SUPPLIER_CAPABILITY: 'PARTY',
  DECISION_MAKER: 'PARTY_ATTRIBUTE',
  COMPLIANCE_REQUIREMENT: 'REQUIREMENT',
  REQUIREMENT_ABSENCE: 'REQUIREMENT',
  COST_COMPONENT: 'COST',
  COMMERCIAL_PRECEDENT: 'STRUCTURE_EVIDENCE',
});

export function targetForFinding(finding: DealFinding): DealFindingTarget {
  return TARGET[finding];
}

/** Which side a party finding puts the subject on, or null where it makes no party. */
const SIDE: Readonly<Record<DealFinding, DealPartyKind | null>> = Object.freeze({
  BUYER_NEED: 'BUYER',
  SUPPLIER_CAPABILITY: 'SUPPLIER',
  DECISION_MAKER: null,
  COMPLIANCE_REQUIREMENT: null,
  REQUIREMENT_ABSENCE: null,
  COST_COMPONENT: null,
  COMMERCIAL_PRECEDENT: null,
});

export function partyKindForFinding(finding: DealFinding): DealPartyKind | null {
  return SIDE[finding];
}

/**
 * The posture a requirement finding writes.
 *
 * `PROHIBITED` is not here, and its absence is the point: no worker declares a
 * prohibition as a separate kind, because a prohibition is a requirement at
 * the `IMPORT_BARRIER` layer that the source says cannot be met. Whether it
 * can be met is a reading of the requirement's own statement — which is
 * exactly what this module refuses to do — so it is declared instead, as the
 * layer, and `POSTURE_BY_FINDING` says what the finding itself asserts.
 */
const POSTURE_BY_FINDING: Readonly<Record<DealFinding, RequirementPosture | null>> = Object.freeze({
  BUYER_NEED: null,
  SUPPLIER_CAPABILITY: null,
  DECISION_MAKER: null,
  COMPLIANCE_REQUIREMENT: 'REQUIRED',
  REQUIREMENT_ABSENCE: 'NONE_FOUND',
  COST_COMPONENT: null,
  COMMERCIAL_PRECEDENT: null,
});

export function postureForFinding(finding: DealFinding): RequirementPosture | null {
  return POSTURE_BY_FINDING[finding];
}

/**
 * Which closed set a finding's `deal_value` must come from, or null where the
 * finding carries no value at all.
 *
 * Reading any of these out of the claim sentence would be the prose-parsing
 * §25's Westbrook defect records — a confidently wrong answer that every row
 * around it agrees with.
 */
export function valueVocabularyFor(finding: DealFinding): readonly string[] | null {
  if (finding === 'COMPLIANCE_REQUIREMENT' || finding === 'REQUIREMENT_ABSENCE') {
    return COMPLIANCE_LAYERS;
  }
  if (finding === 'COST_COMPONENT') return COST_COMPONENTS;
  if (finding === 'COMMERCIAL_PRECEDENT') return COMMERCIAL_STRUCTURES;
  return null;
}

/** Whether a finding must name the market it is about. */
export function findingRequiresJurisdiction(finding: DealFinding): boolean {
  return finding === 'COMPLIANCE_REQUIREMENT' || finding === 'REQUIREMENT_ABSENCE';
}

/**
 * Whether a finding must carry a figure.
 *
 * Only a cost component, and there it is **required** rather than permitted —
 * which is the opposite of `structural_amount_cents`, deliberately. A capital
 * requirement with no published figure is a real and useful finding, because
 * `readCapital` withholds the total and says so. A cost *component* with no
 * figure is nothing at all: it names a line in an arithmetic and supplies no
 * number, so it could only ever make the landed cost look complete while
 * contributing nothing to it.
 */
export function findingRequiresAmount(finding: DealFinding): boolean {
  return finding === 'COST_COMPONENT';
}

/** Whether a finding must name an equipment class. All but one do. */
export function findingRequiresEquipment(finding: DealFinding): boolean {
  return finding !== 'DECISION_MAKER';
}

/**
 * Which end of the lane a cost component's jurisdiction names.
 *
 * ---------------------------------------------------------------------------
 * A lookup, because the proxy was wrong
 * ---------------------------------------------------------------------------
 *
 * A worker declares one `deal_jurisdiction` per claim, and for a cost line the
 * market that field names depends entirely on which line it is: an ex-works
 * price is about the country the factory is in, a duty rate is about the
 * country the goods are entering, and a freight rate is about the lane between
 * them. The first version of this read the *round's purpose* instead — a proxy
 * that happens to be wrong exactly where it matters, because a supply question
 * routinely turns up a published factory price and stamping it with the
 * supplier's country as a *destination* makes it invisible to every lane out
 * of that class.
 *
 * So it is a `Record` over the whole union rather than a reading: a component
 * added later is a compile error until somebody says which end it belongs to.
 * `ORIGIN` leaves the destination null, which is what makes a factory price
 * apply to every lane — the nullable column in the schema exists for exactly
 * this.
 */
export type CostEnd = 'ORIGIN' | 'DESTINATION';

const COST_END: Readonly<Record<CostComponent, CostEnd>> = Object.freeze({
  FACTORY_PRICE: 'ORIGIN',
  INLAND_ORIGIN: 'ORIGIN',
  EXPORT_HANDLING: 'ORIGIN',
  /*
   * Freight, insurance and financing are about the lane rather than about one
   * end, and they are filed against the destination deliberately: a rate to
   * one market says nothing about a rate to another, so treating them as
   * origin-side — applying to every lane — would carry one market's freight
   * into another market's landed cost.
   */
  OCEAN_FREIGHT: 'DESTINATION',
  INSURANCE: 'DESTINATION',
  FINANCING_COST: 'DESTINATION',
  IMPORT_DUTY: 'DESTINATION',
  IMPORT_TAX: 'DESTINATION',
  CUSTOMS_CLEARANCE: 'DESTINATION',
  INLAND_DESTINATION: 'DESTINATION',
  INSPECTION: 'DESTINATION',
  CERTIFICATION_COST: 'DESTINATION',
  BUYER_ALTERNATIVE: 'DESTINATION',
});

export function costEndFor(component: CostComponent): CostEnd {
  return COST_END[component];
}

/** One line per finding, for the tool description that asks a worker to choose. */
export const DEAL_FINDING_GUIDE: Readonly<Record<DealFinding, string>> = Object.freeze({
  BUYER_NEED:
    'a named organisation that needs a named class of equipment, with what triggered it',
  SUPPLIER_CAPABILITY:
    'a named manufacturer or supplier that builds or supplies that class, for export',
  DECISION_MAKER:
    'who actually decides a purchase at an organisation, or how its procurement runs',
  COMPLIANCE_REQUIREMENT:
    'something the destination market or the buyer demands of these goods before they may ' +
    'be imported, registered, operated or accepted',
  REQUIREMENT_ABSENCE:
    'a documented search establishing that one layer demands nothing here — name where you ' +
    'looked in searched_repositories, or this is not established',
  COST_COMPONENT:
    'a published figure for one line of the landed cost, or what the buyer pays today — ' +
    'and here deal_subject is what the figure is *per* (one unit, one forty-foot container, ' +
    'one shipment), because a figure whose basis nobody stated cannot be added to another',
  COMMERCIAL_PRECEDENT:
    'evidence that a named commercial structure is actually used in this trade — and here ' +
    'deal_subject is what the source says it pays, in the source\u2019s own words including ' +
    'ranges, because Brain never converts a range into a rate',
});

export interface DealDeclaration {
  finding: DealFinding | null;
  subject: string | null;
  equipmentClass: string | null;
  jurisdiction: string | null;
  value: string | null;
  amountCents: number | null;
  currency: string | null;
}

export type DealCheck =
  | { ok: true; value: DealDeclaration }
  | { ok: false; error: string };

const ABSENT: DealDeclaration = Object.freeze({
  finding: null,
  subject: null,
  equipmentClass: null,
  jurisdiction: null,
  value: null,
  amountCents: null,
  currency: null,
});

/**
 * Validate one claim's dealflow declaration.
 *
 * Called by the MCP tool and by the provider-path parser, and by nothing else.
 * A second copy of the *rule* is how two doors come to disagree about what a
 * valid declaration is, which this repository has had to record five times.
 *
 * `searchedRepositories` is taken because one finding — and only one — is a
 * claim that something does not exist, and §14 is explicit that such a claim
 * is established by a documented search of the places it would be, or not at
 * all. Checking it here rather than at absorb time means the worker is told
 * while it still has the attempt to spend, which is §27's truncation lesson:
 * the one outcome a worker cannot recover from is the one reported as success.
 */
export function validateDealFinding(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  equipmentClass: unknown;
  jurisdiction: unknown;
  value: unknown;
  amountCents: unknown;
  currency: unknown;
  searchedRepositories?: unknown;
}): DealCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const equipmentClass = tidy(input.equipmentClass);
  const jurisdiction = tidy(input.jurisdiction);
  const value = tidy(input.value);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about a transaction, which is
     * most claims. Its companions must then be absent too: a value with no
     * finding is a field nothing will ever read, and storing it would look
     * like it had done something.
     */
    for (const [name, given] of [
      ['deal_subject', subject],
      ['deal_equipment', equipmentClass],
      ['deal_jurisdiction', jurisdiction],
      ['deal_value', value],
      ['deal_currency', tidy(input.currency)],
    ] as const) {
      if (given) {
        return {
          ok: false,
          error:
            `${where}: ${name} was given with no deal_finding. Say which kind of transaction ` +
            'fact this establishes, or leave the field out.',
        };
      }
    }
    if (!absent(input.amountCents)) {
      return {
        ok: false,
        error: `${where}: deal_amount_cents was given with no deal_finding.`,
      };
    }
    return { ok: true, value: ABSENT };
  }

  if (!isDealFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: deal_finding must be one of ${DEAL_FINDINGS.join(', ')}, or omitted when ` +
        'the claim says nothing about a cross-border transaction.',
    };
  }
  const finding = input.finding;

  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set deal_subject — ${DEAL_FINDING_GUIDE[finding]}. ` +
        'It is the name of the thing, as the source writes it, not a sentence about it.',
    };
  }

  if (findingRequiresEquipment(finding) && !equipmentClass) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set deal_equipment — which class of equipment it ` +
        'is about. Where the assignment named a class, declare that class back verbatim, ' +
        'because two spellings of one class are two classes to Brain.',
    };
  }
  if (!findingRequiresEquipment(finding) && equipmentClass) {
    return {
      ok: false,
      error: `${where}: a ${finding} finding is about an organisation rather than a class of ` +
        'equipment, so deal_equipment must be left out.',
    };
  }

  if (findingRequiresJurisdiction(finding) && !jurisdiction) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set deal_jurisdiction — the market it applies in. ` +
        'The same goods are legal in one market and unregistrable in the next, so a ' +
        'requirement with no market attached establishes nothing.',
    };
  }

  const vocabulary = valueVocabularyFor(finding);
  if (vocabulary) {
    if (!value) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding must set deal_value to one of ` +
          `${vocabulary.join(', ')}.`,
      };
    }
    if (!vocabulary.includes(value)) {
      return {
        ok: false,
        error:
          `${where}: deal_value for a ${finding} finding must be one of ${vocabulary.join(', ')}. ` +
          `"${value}" is not one of them — say which of those this is, and put the detail in ` +
          'the claim itself.',
      };
    }
  } else if (value) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding takes no deal_value. Putting one there would write a ` +
        'field nothing reads, which is worse than refusing it because it looks like it worked.',
    };
  }

  let amountCents: number | null = null;
  if (!absent(input.amountCents)) {
    if (typeof input.amountCents !== 'number' || !Number.isInteger(input.amountCents)) {
      return { ok: false, error: `${where}: deal_amount_cents must be a whole number of cents.` };
    }
    if (input.amountCents < 0) {
      return { ok: false, error: `${where}: deal_amount_cents must not be negative.` };
    }
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure. Only COST_COMPONENT does, because ` +
          'it names a line in an arithmetic.',
      };
    }
    amountCents = input.amountCents;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: a COST_COMPONENT finding must set deal_amount_cents. A cost line with no ` +
        'figure makes the landed cost look complete while contributing nothing to it, which ' +
        'is the one way this table can make a deal look cheaper than it is.',
    };
  }

  /*
   * The currency travels with the figure.
   *
   * Not taken from the sprint: cross-border prices genuinely arrive in several
   * currencies, and stamping them all with one would make the mixed-currency
   * reading in `landedEconomics` unreachable — a mechanism nothing calls, at
   * the number that decides whether a deal is worth doing. Brain never
   * converts, so a lane whose figures disagree has its total withheld.
   */
  const currencyRaw = tidy(input.currency).toUpperCase();
  let currency: string | null = null;
  if (currencyRaw) {
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so deal_currency has nothing to ` +
          'describe.',
      };
    }
    if (!/^[A-Z]{3}$/.test(currencyRaw)) {
      return {
        ok: false,
        error:
          `${where}: deal_currency must be a three-letter ISO 4217 code such as USD, EUR or ` +
          `CNY. "${currencyRaw}" is not one, and a currency Brain guessed at is a figure ` +
          'nobody can check.',
      };
    }
    currency = currencyRaw;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: a COST_COMPONENT finding must set deal_currency. A figure with no currency ` +
        'is a number that can be added to the wrong things.',
    };
  }

  if (finding === 'REQUIREMENT_ABSENCE') {
    const searched = Array.isArray(input.searchedRepositories)
      ? input.searchedRepositories.filter((one) => typeof one === 'string' && one.trim() !== '')
      : [];
    if (searched.length === 0) {
      return {
        ok: false,
        error:
          `${where}: a REQUIREMENT_ABSENCE finding must name where you looked, in ` +
          'searched_repositories. "Nobody has looked" and "somebody looked and there is ' +
          'nothing" must never read the same, and only the search tells them apart.',
      };
    }
  }

  return {
    ok: true,
    value: {
      finding,
      subject,
      equipmentClass: equipmentClass || null,
      jurisdiction: jurisdiction || null,
      value: value || null,
      amountCents,
      currency,
    },
  };
}
