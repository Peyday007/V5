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
import { FACT_KEY_LIST } from './construction.ts';
import { stateFromField, statesNamedIn, US_STATES } from './jurisdiction.ts';

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
  UNIT_ECONOMIC: null,
  ROLE_OCCUPANT: null,
  ROLE_TERMS: null,
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
  if (finding === 'UNIT_ECONOMIC' || finding === 'ROLE_TERMS') return FACT_KEY_LIST;
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
  return (
    finding === 'CAPITAL_RESTRUCTURING' ||
    finding === 'TRANSACTION_TYPE' ||
    finding === 'UNIT_ECONOMIC' ||
    finding === 'ROLE_OCCUPANT' ||
    finding === 'ROLE_TERMS'
  );
}

/** Whether a finding cannot be filed without its qualifier. */
export function findingNeedsQualifier(finding: StructuralFinding): boolean {
  return finding === 'CAPITAL_RESTRUCTURING' || finding === 'ROLE_OCCUPANT' || finding === 'ROLE_TERMS';
}

/** Whether a finding cannot be filed without its figure: a unit economic with no number says nothing. */
export function findingNeedsAmount(finding: StructuralFinding): boolean {
  return finding === 'UNIT_ECONOMIC' || finding === 'ROLE_TERMS';
}

/**
 * Who pays and who supplies, from a TRANSACTION_TYPE's qualifier (W-13):
 * `payer -> supplier`. Either side may be left empty when the source names
 * only one. A declared field split on its declared separator — never a
 * reading of the claim's sentence.
 */
export function transactionParties(qualifier: string | null | undefined): { payer: string | null; supplier: string | null } {
  if (!qualifier || !qualifier.includes('->')) return { payer: null, supplier: null };
  const [payer, supplier] = qualifier.split('->', 2).map((one) => one.replace(/\s+/g, ' ').trim());
  return { payer: payer || null, supplier: supplier || null };
}

/** The role and, when named, the paying buyer type, from a role finding's qualifier: `role` or `role @ buyer`. */
export function roleQualifier(qualifier: string | null | undefined): { roleId: string | null; buyer: string | null } {
  if (!qualifier) return { roleId: null, buyer: null };
  const [role, buyer] = qualifier.split('@', 2).map((one) => one.replace(/\s+/g, ' ').trim());
  const roleId = role ? role.toLowerCase().replace(/[^a-z0-9:]+/g, '_').replace(/^_+|_+$/g, '') || null : null;
  return { roleId, buyer: buyer || null };
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
  return finding === 'CAPITAL_REQUIREMENT' || finding === 'CAPITAL_RESTRUCTURING' || findingNeedsAmount(finding);
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
    'the source describes how money changes hands here: what is bought, on what terms — set ' +
    'structural_qualifier to "<who pays> -> <who supplies>" as the source names them',
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
  UNIT_ECONOMIC:
    'the source states a figure for a price, rate, cost or payment term — structural_subject is ' +
    'the fact key, structural_qualifier the paying buyer type when it is about one, and ' +
    'structural_amount_cents the figure in hundredths of the key\'s unit (cents for dollars, ' +
    '15 for a 15% share, 3000 for 30 days)',
  ROLE_OCCUPANT:
    'the source names who stands in a commercial role (broker, reseller, financier, lessor…) — ' +
    'structural_subject is the occupant\'s name, structural_qualifier the role, optionally ' +
    '"role @ buyer type" when that buyer pays the occupant',
  ROLE_TERMS:
    'the source states what a commercial role is paid — structural_subject is the fact key ' +
    '(e.g. broker_take_rate, financing_margin), structural_qualifier the role (optionally ' +
    '"role @ buyer type"), structural_amount_cents the figure in hundredths of the key\'s unit',
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

/**
 * The key two names of one buyer population share (F3, 2026-11-15): case,
 * punctuation, "&"/"and", a leading article and plural endings are noise, so
 * "Independent Restaurants", "independent restaurant" and "The independent
 * restaurants" are one buyer. It is the map's own normalisation (`norm` in
 * `cash/construct.ts` and `industry/transfer.ts`) with plurals folded, and it
 * folds nothing else: a qualifier ("chain restaurants") is a different
 * population, never a near-match.
 */
export function buyerNameKey(name: string | null | undefined): string {
  const words = (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words.shift();
  return words
    .map((word) => {
      if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
      if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
      return word;
    })
    .join(' ');
}

/** The organisation nouns a state's agencies are named by, singular to plural. */
const AGENCY_NOUNS: Readonly<Record<string, string>> = {
  department: 'departments',
  division: 'divisions',
  office: 'offices',
  bureau: 'bureaus',
  agency: 'agencies',
  commission: 'commissions',
  board: 'boards',
  authority: 'authorities',
  administration: 'administrations',
};
const AGENCY = Object.keys(AGENCY_NOUNS).join('|');
const STATE_PATTERNS_LONGEST_FIRST = [...US_STATES].sort((a, b) => b.length - a.length).map((state) => new RegExp(`\\b${state}\\b`, 'gi'));
const AGENCY_OF = new RegExp(`^(.*?)\\b(${AGENCY}) of (?:the )?(.+)$`, 'i');
const AGENCY_AFTER = new RegExp(`^(.+?)\\s+(${AGENCY})$`, 'i');
const AGENCY_ANY = new RegExp(`\\b(?:${AGENCY})\\b`, 'i');
const withoutStates = (text: string): string =>
  STATE_PATTERNS_LONGEST_FIRST.reduce((rest, pattern) => rest.replace(pattern, ' '), text)
    .replace(/\b(?:state|commonwealth)(?: of)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The buyer population one named payer belongs to, as a map name (2026-11-15):
 * production held 49 priced openings whose payers are single organisations
 * (one state's named department, "School District of Philadelphia") beside
 * 11 unrelated buyer types, so no payer was a population the map held and no
 * published price reached construction.
 *
 * A closed set of rules, never a reading (§8): a place in brackets or after a
 * comma is dropped; a school district, a university, a city, a county and a
 * state's own agency become the population of their kind ("state <x>
 * departments"); any other state name is removed, because a buyer name that
 * names a jurisdiction is one construction refuses; anything else — a named
 * federal office, "US residential homeowners" — is kept as the named
 * population it already is. Null when nothing is left. Pure.
 */
/**
 * The payer a research sentence names, or null when the sentence names none.
 * Production stores an opening's payer as the claim's prose ("GitHub, Inc. is
 * the payer: it runs…", "The payer/buyer is St. Louis Development
 * Corporation", "Buyers who pay for … are primarily small business
 * operators, …"), so a name is read out of the known phrasings before it is
 * generalised; a sentence that names nobody yields null rather than a buyer
 * type made of prose.
 */
export function payerNamedIn(payer: string | null | undefined): string | null {
  return remembered(payerNamedInMemo, payer ?? '', readPayerNamedIn);
}

/**
 * Both payer readings are pure in one string and cost dozens of regular
 * expressions each, and the planner asks them of the same few hundred payers
 * once per arrangement (W15, production 2026-11-17: `payerNamedIn` and
 * `statesNamedIn` among the heaviest frames of 10–20 s event-loop stalls). A
 * payer is read once; the table is bounded and simply emptied when full.
 */
const PAYER_MEMO_MAX = 8_192;
const payerNamedInMemo = new Map<string, string | null>();
const buyerPopulationMemo = new Map<string, string | null>();
function remembered(memo: Map<string, string | null>, key: string, read: (key: string) => string | null): string | null {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = read(key);
  if (memo.size >= PAYER_MEMO_MAX) memo.clear();
  memo.set(key, value);
  return value;
}

function readPayerNamedIn(payer: string): string | null {
  const unbracketed = (payer ?? '')
    // An abbreviation's full stop does not end a name ("St. Louis", "GitHub, Inc.").
    .replace(/\b(St|Mt|Ft|Inc|Co|Corp|Ltd|LLC|Dept|Univ|Assn|Bros|No|U\.S|Dr|Jr|Sr)\./g, '$1')
    // Nor does one inside a word ("Freelancer.com"): held aside while the sentence is split, restored in the name.
    .replace(/(\w)\.(?=\w)/g, `$1${INNER_DOT}`)
    .replace(/\s+/g, ' ')
    .trim();
  const text = unbracketed.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const words = (one: string): number => one.split(/\s+/).filter(Boolean).length;
  const restore = (one: string): string => one.split(INNER_DOT).join('.');
  const clean = (one: string | undefined): string | null => {
    let name = (one ?? '')
      .replace(/^(?:market:\s*[^.]*\.\s*)/i, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      // A clause after the name says what the payer does, not who it is ("the employer who posts the project").
      .split(/[;:]| — | - |,\s*(?:which|who|whose|where|that)\b|\s+(?:who|which|whose|that|where|when|because|through|via|in exchange)\s+/i)[0]!
      .replace(/[.,]+$/, '')
      .trim();
    // A list too long to be one name is read by its first member ("universities, research institutions, …").
    if (words(name) > 8) name = name.split(/,|\s+(?:such as|including|like)\s+/i)[0]!.trim();
    name = restore(name);
    // "paid by Crucinova itself": the reflexive points back at the name, which is the payer.
    name = name.replace(/\s+(?:itself|themselves|himself|herself)$/i, '').trim();
    // A money amount or a price word is what is listed, not who pays ("Fragment brand page lists resale prices from $180").
    if (/[$€£¥]|\b(?:prices?|pricing|fees?|costs?)\b/i.test(name)) return null;
    return name && words(name) <= 8 && !NOT_A_PAYER.test(name) && !GENERIC_PAYER.has(buyerNameKey(name)) && namesABuyer(bareName(name)) ? name : null;
  };
  // "A homeowner (the payer) can hire …": the bracket is the only thing that says who pays, so it is read before brackets are dropped.
  const bracketed = /(?:^|[.;:]\s+)([^.;:()]+?)\s*\((?:is\s+)?(?:the|as)\s+(?:payer|buyer|purchaser)s?\)/i.exec(unbracketed);
  const fromBracket = bracketed ? clean(bracketed[1]) : null;
  if (fromBracket) return fromBracket;
  // "Payer/contracting party for the <place> opening: <who>" — the clause after the colon is read on its own.
  const contracting = /\b(?:payer|buyer)\s*\/\s*contracting party\b[^:]*:\s*(.+)$/i.exec(text) ?? /^contracting party\b[^:]*:\s*(.+)$/i.exec(text);
  if (contracting) return payerNamedIn(restore(contracting[1]!));
  const patterns: RegExp[] = [
    // "… the client who posted the request, describing themselves as the owner of a bakery": the self-description is the population.
    /\bdescrib(?:ing|es|ed)\s+(?:themselves|himself|herself|itself)\s+as\s+([^.;:]+)/i,
    /\b(?:the\s+)?(?:payer(?:\s*\/\s*buyer)?|buyer(?:\s*\/\s*payer)?|purchaser|client)\s+(?:is|are|was|would be|will be)\s+(?:the\s+)?([^.;:]+)/i,
    /^([^.;:]+?)\s+(?:is|are)\s+the\s+(?:payer|buyer|purchaser)s?\b/i,
    /\b(?:buyers|payers|customers|clients)\s+(?:who\s+pay\s+[^.]*?\s+)?(?:are|include|tend to be|consist of)\s+(?:primarily|mainly|mostly|typically)?\s*([^.;:]+)/i,
    /\bname[sd]?\s+([^.;:]+?)\s+as\s+(?:the\s+)?(?:payer|buyer)s?\b/i,
    /\bpaid\s+(?:for\s+)?by\s+(?:the\s+)?([^.;:]+)/i,
    // A source that names who pays ("GoTranscript's Billing Terms name universities, …").
    /\b(?:terms|pricing|price list|page|contract|notice|solicitation|rfp|rfq|policy|agreement|listing|filing|documentation|faq)s?\s+(?:name|names|named|list|lists|listed|identify|identifies|identified)\s+([^.;:]+)/i,
    // "<Agency> issued RFP 2026-…": whoever issues a solicitation is the one who pays under it.
    /([^.;:]+?)\s+(?:has\s+|have\s+)?(?:issued|released|published|posted)\s+(?:an?\s+|the\s+|its\s+|a\s+new\s+)?(?:rfp|rfq|rfi|ifb|solicitation|request for (?:proposals?|quotes?|quotations?|qualifications|bids?)|invitation (?:to|for) bids?)\b/i,
    // "the listing '…' was posted by a homeowner on Thumbtack".
    /\b(?:posted|listed|issued|commissioned|requested)\s+by\s+([^.;:]+?)(?=\s+(?:on|in|at|for|through|via|who|which|that)\b|[.;:,]|$)/i,
    // "<Who> pays $2,500 per …", "Homeowners pay …".
    /^([^.;:]+?)\s+(?:pays|pay|paid)\b/i,
  ];
  for (const re of patterns) {
    const hit = re.exec(text);
    const name = hit ? clean(hit[1]) : null;
    if (name) return name;
  }
  // A short noun phrase with no verb of reporting is itself a name.
  if (words(text) <= 8 && !/\b(?:is|are|was|were|reports?|says?|pays?|book|receive|tested|runs?|name)\b/i.test(text)) {
    const name = restore(text.replace(/[.,;:]+$/, '').replace(/^(?:the|a|an)\s+/i, ''));
    return NOT_A_PAYER.test(name) || GENERIC_PAYER.has(buyerNameKey(name)) || !namesABuyer(bareName(name)) ? null : name;
  }
  return null;
}

/** Holds a full stop inside a word while a sentence is split at its full stops. */
const INNER_DOT = '․';
/** A reading that names nobody: a pronoun, or a statement that the payer is not known. */
// A document is not a payer either ("the listing 'Window and gutter cleaning'" names what was posted, not who posted it).
const NOT_A_PAYER = /^(?:it|its|they|them|this|that|these|those|he|she|we|you|someone|anyone|whoever|unknown|unclear|unspecified|not|none|no|n\/a|listing|posting|request|rfp|rfq|solicitation|advert|advertisement|notice)\b/i;
/** A role word alone says there is a payer, not who it is (as `buyerNameKey` writes it). */
const GENERIC_PAYER: ReadonlySet<string> = new Set(['buyer', 'payer', 'customer', 'client', 'purchaser', 'user', 'end user']);

/** A name that opens on a connective, a pronoun or an adverb is the rest of a sentence, not who buys ("therefore an unidentified individual"). */
const FRAGMENT_START = /^(?:therefore|thus|hence|so|then|also|however|moreover|furthermore|accordingly|consequently|i\.?e\.?|e\.?g\.?|itself|themselves|himself|herself|it|its|this|that|which|these|those|they|them|he|she|we|you|someone|anyone|whoever|whom|who)\b/i;
/** A name that ends on a reflexive points back at a sentence's subject ("Crucinova itself"). */
// A name cut off mid-clause ends on a connective or an article (production 2026-11-20: "GitHub Inc operates the bug bounty program and").
const FRAGMENT_END = /\b(?:itself|themselves|himself|herself|and|or|but|with|of|the|to|for|a|an|which|that|who)$/i;
/** A bare verb form names an act, not anyone who acts ("paying"): the participles payer prose leaves behind. */
const BARE_VERB = /^(?:pay|paying|paid|pays|buy|buying|bought|buys|purchas(?:e|es|ed|ing)|hir(?:e|es|ed|ing)|us(?:e|es|ed|ing)|sell(?:s|ing)?|sold|order(?:s|ed|ing)?|seek(?:s|ing)?|want(?:s|ed|ing)?|need(?:s|ed|ing)?|request(?:s|ed|ing)|post(?:s|ed|ing)|contract(?:s|ed|ing)|subscrib(?:e|es|ed|ing)|book(?:s|ed|ing)|spend(?:s|ing)?|spent|fund(?:s|ed|ing)|commission(?:s|ed|ing))$/i;
/** A party described as not known is nobody a list can be built of ("anonymous members of the public", "… of unknown business"). */
const UNKNOWN_PARTY = /\b(?:unknown|unidentified|unspecified|unnamed|undisclosed|anonymous|unclear|not (?:known|identified|specified|named|disclosed))\b/i;
/** A named fellowship whose name holds one of those words is a real organisation ("Alcoholics Anonymous"). */
const NAMED_ANONYMOUS = /\b(?:alcoholics|narcotics|overeaters|gamblers|debtors|sex addicts|cocaine|al-anon) anonymous\b/i;

/** The name with its article and closing punctuation removed, as every buyer-name rule reads it. */
const bareName = (name: string | null | undefined): string => (name ?? '').replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, '').replace(/[.,;:!?]+$/, '').trim();

/** Whether a name names any buyer at all: not a sentence's leftovers, and not a party nobody knows. */
function namesABuyer(text: string): boolean {
  if (!/[a-z]/i.test(text)) return false;
  // An acronym is a name, not a pronoun ("IT departments", "WHO").
  const acronym = /^[A-Z]{2,}\b/.test(text);
  if ((!acronym && FRAGMENT_START.test(text)) || FRAGMENT_END.test(text) || BARE_VERB.test(text)) return false;
  if (UNKNOWN_PARTY.test(text) && !NAMED_ANONYMOUS.test(text)) return false;
  if (RECORD_OR_CLAUSE.test(text) || CAMEL_FIELD.test(text)) return false;
  return true;
}

/**
 * A data record's field or a sentence's verb phrase is not a name (production,
 * 2026-11-20: goal A's price questions asked what "owner id is null and owner
 * info is empty" and "GitHub Bug Bounty Program Overhaul does not specify"
 * pay). Refused: an empty-value predicate ("is null", "are empty", "is
 * missing"), a negated report ("does not specify", "did not say"), a
 * placeholder value (null, undefined, NaN, N/A) and a field-shaped token
 * ("owner_id", "ownerId", "owner id").
 */
const RECORD_OR_CLAUSE = /\b(?:is|are|was|were)\s+(?:null|empty|blank|missing|undefined|none|absent|unset|not\s+(?:given|provided|available|stated|listed))\b|\b(?:does|do|did|doesn['’]t|don['’]t|didn['’]t)\s+(?:not\s+)?(?:specify|say|state|mention|name|identify|disclose|list|give|provide)\b|\b(?:null|undefined|nan)\b|\bn\/a\b|\b[a-z]+_[a-z_]+\b|\b(?:id|ids|info)\s+(?:is|are|field)\b|\bnot\s+specif\w*/i;
/** A camel-cased field name ("ownerId", "ownerInfo"), read case-sensitively so "Medicaid" stays a word. */
const CAMEL_FIELD = /\b[a-z]+(?:Id|ID|Info)\b/;

/**
 * Whether a buyer name names a kind of buyer someone could build a list of
 * (production, 2026-11-19): plans said "Build the list of <buyer> from a
 * published directory" over "paying", "therefore an unidentified individual",
 * "Crucinova itself" and "anonymous members of the public" — the leftovers of
 * a payer sentence, or a statement that the payer is not known. Refused: a
 * name that opens on a connective, pronoun or adverb, ends on a reflexive, is
 * a bare verb form, or describes an unknown, anonymous or unidentified party.
 *
 * Refused too, since the same day's transfer test: one named organisation
 * (`namesOneOrganisation`). Plans led with "Constructed: VA", "St Louis
 * Development Corporation" and "Artisanal Sudoku" as buyer populations, and
 * their steps built a list of one organisation, pooled it into shared runs and
 * offered "the next run to a fresh group" of it. One organisation is a buyer —
 * an opening names it as its payer and is modelled as that one buyer — but it
 * is not a population an arrangement can be constructed over. A closed set of
 * rules, never a reading (§8). Pure.
 */
export function namesABuyerPopulation(name: string | null | undefined): boolean {
  const text = bareName(name);
  return namesABuyer(text) && !isOneOrganisation(text) && !isOneOrganisation(subjectOf(text));
}

/**
 * The subject of a buyer name written as a sentence: the words before a
 * spaced dash, a colon, a semicolon or a parenthesis, and before the first
 * verb of a clause ("GitHub Inc is the payer — its bug bounty page publishes
 * rewards …" is about "GitHub Inc"). Audit of goal wst_7b4fcbb5f2384f31b6c3,
 * 2026-11-23: that sentence reached the industry map as a buyer node, passed
 * as a population because the whole sentence is not a proper name, and the
 * plan swept one company as 1–200 repeat buyers and 4,314 contacts. A name
 * with no such boundary is its own subject. Pure.
 */
export function subjectOf(text: string): string {
  const clause = text.split(/\s+[—–-]\s+|\s*[:;(]\s*/)[0] ?? text;
  const verb = clause.match(/^(.+?)\s+(?:is|are|was|were|pays?|paid|publishes|published|runs|ran|offers|offered|awards|awarded|rewards|rewarded|operates|operated|hosts|hosted|will)\b/i);
  return bareName(verb ? verb[1] : clause);
}

/** Words a proper name keeps in lower case ("Society of Actuaries", "Bank of the West"). */
const NAME_PARTICLE = /^(?:of|the|and|for|in|on|at|de|du|la|le|von|van|&)$/i;
/** Acronyms that name a kind of buyer, not one organisation ("SMB", "HOA"). A closed set. */
const KIND_ACRONYM: ReadonlySet<string> = new Set(['SMB', 'SME', 'MSP', 'MSSP', 'HOA', 'ISV', 'VAR', 'OEM', 'CPA', 'RIA', 'NGO', 'NPO', 'DSO', 'MSO', 'REIT', 'LLC', 'DTC', 'B2B', 'B2C', 'SAAS', 'PE', 'VC', 'GC']);

/**
 * Single-word names of well-known companies and platforms, which a sentence
 * leaves capitalised like any common noun ("Amazon", "Upwork"). A closed set:
 * a camel-cased or domain-shaped word ("GitHub", "Freelancer.com") is read as
 * a brand by `ONE_BRAND_WORD` without needing to be listed.
 */
const KNOWN_COMPANY: ReadonlySet<string> = new Set([
  'github', 'gitlab', 'google', 'alphabet', 'amazon', 'microsoft', 'apple', 'meta', 'facebook', 'instagram', 'twitter', 'netflix',
  'upwork', 'fiverr', 'etsy', 'ebay', 'shopify', 'stripe', 'salesforce', 'oracle', 'adobe', 'uber', 'airbnb', 'reddit', 'walmart',
  'tesla', 'spotify', 'substack', 'patreon', 'kickstarter', 'indiegogo', 'thumbtack', 'yelp', 'angi', 'craigslist', 'canva', 'atlassian',
  'zapier', 'hubspot', 'mailchimp', 'squarespace', 'wix', 'godaddy', 'notion', 'figma', 'dropbox', 'openai', 'anthropic', 'nvidia', 'intel',
]);
/** One word that is a brand by its shape: an inner capital after a lower-case letter ("GitHub", "eBay"), or a domain ("Freelancer.com"). */
const ONE_BRAND_WORD = /^(?:[A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*|[A-Za-z0-9-]+\.(?:com|io|org|net|co|ai|app|dev))$/;
/**
 * A singular organisation noun followed by a capitalised name ("Dutch cleaning
 * company De Poetsfee", "the software firm Acme"): a description of one
 * named company, never the kind it belongs to ("cleaning companies").
 */
const DESCRIBED_COMPANY = /\b(?:company|firm|agency|business|corporation|startup|start-up|brand|publisher|platform|retailer|manufacturer|provider|vendor|studio|consultancy|organi[sz]ation|bank|school|hospital|clinic|charity|foundation|nonprofit|non-profit|website|marketplace|newspaper|magazine|newsletter)\s+(?:called\s+|named\s+)?[A-Z0-9]/;
/** One governing or investing body as the head of the name ("the production committee", "a school board"). */
const ONE_BODY = /\b(?:committee|commission|consortium|syndicate|board|council|panel|jury|tribunal|cabinet|senate|parliament)$/i;
/**
 * The members of one body named with a determiner ("the production committee
 * investors", "a school board's members"); the investor noun may be cut short
 * by a display. Without a determiner the phrase is a kind ("Production
 * committee investors" are the investors in every such committee).
 */
const ONE_BODYS_MEMBERS = /\b(?:the|a|an|one)\s+(?:[\w-]+\s+){0,3}?(?:committee|commission|consortium|syndicate|panel|jury|tribunal)\s+(?:members?|investo\w*|backers?|shareholders?|funders?|donors?|partners?|chairs?|officers?)\b/i;
/** The people belonging to one named party ("Toei's investors", "the committee's members"). */
const ONES_PEOPLE = /['’]s\s+(?:investo\w*|shareholders?|backers?|funders?|donors?|members?|board|founders?|owners?|employees?|staff|team|partners?|stakeholders?|executives?|management)\b/i;

/** One public body by its form ("City of Ridgeport", "Department of Labor"). */
const PUBLIC_BODY = /^(?:the )?(?:city|county|town|township|village|borough|municipality|state|commonwealth|province|department|ministry|office|bureau|port|university) of\b/i;
/**
 * A singular organisation noun as the head of a lower-case description ("State
 * university continuing-education office", "Regional community foundation",
 * "State draw-game operator"): one body described, never a kind of buyer, which
 * is plural ("Dental practices"). Holdout planning cases, 2026-11-23: each was
 * modelled as a population of repeat buyers.
 */
const ORG_HEAD = /^(?:department|office|agency|authority|council|commission|committee|board|bureau|ministry|district|foundation|trust|operator|processor|retailer|wholesaler|manufacturer|distributor|cooperative|co-op|university|college|school|hospital|clinic|city|county|municipality|government|company|corporation|firm|institute|institution|association|society|club|federation|union|regulator|insurer|bank|utility|publisher|platform|marketplace|programme|program|administrator|sponsor|organizer|organiser)$/i;
function headOfDescription(text: string): string | null {
  const clause = (text.split(/\s*,\s*|\s+[—–-]\s+|\s*[:;(]\s*/)[0] ?? text).trim();
  const lead = clause.split(/\s+(?:of|in|at|near|for|across|under|with)\s+/i)[0]!.trim();
  const words = lead.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? words[words.length - 1]!.replace(/[^A-Za-z-]/g, '') : null;
}

function isOneOrganisation(text: string): boolean {
  if (PUBLIC_BODY.test(text)) return true;
  const described = headOfDescription(text);
  if (described && ORG_HEAD.test(described)) return true;
  if (ONE_BODY.test(text) || ONE_BODYS_MEMBERS.test(text) || ONES_PEOPLE.test(text) || DESCRIBED_COMPANY.test(text)) return true;
  if (!/\s/.test(text) && (ONE_BRAND_WORD.test(text) || KNOWN_COMPANY.has(text.toLowerCase()))) return true;
  const words = text.split(' ').filter((w) => !NAME_PARTICLE.test(w));
  if (words.length === 0 || !words.every((w) => /^[A-Z0-9]/.test(w))) return false;
  // In "<X> of <Y>" the head is X ("Society of Actuaries" is a society), and a place after "in"/"at" is where, not who ("Homeowners in Mechanicsburg, PA").
  const lead = text.split(/\s+(?:of|in|at|near|across|around|throughout)\s+/i)[0]!;
  const before = lead.split(' ').filter((w) => !NAME_PARTICLE.test(w));
  const headOf = before.length > 0 ? before : words;
  const head = headOf[headOf.length - 1]!;
  if (lead !== text && before.length === 1 && /[^s]s$/i.test(head)) return false;
  // An all-capitals head is an acronym ("VA", "PA DEP"), never a plural, unless it names a kind ("SMB").
  if (/^[A-Z0-9&.-]{2,}$/.test(head)) return !KIND_ACRONYM.has(head.replace(/[.&-]/g, '').toUpperCase());
  // One capitalised word is as often a sentence's first common noun ("Homeowner") as a name: not read as one organisation.
  if (words.length === 1) return false;
  // A title-cased plural head is a kind of buyer written as a heading; a head ending in -ss is singular ("Business Class").
  return !/[^s]s$/i.test(head);
}

/**
 * Whether a buyer name names one organisation rather than a kind of buyer: a
 * proper name in title case ("Artisanal Sudoku", "St Louis Development
 * Corporation", "Society of Actuaries") or an acronym ("VA", "PA DEP"). A
 * population is a common noun phrase ("Dental practices", "IT departments"),
 * a title-cased plural ("Senior Living Communities") or a kind acronym ("SMB").
 *
 * Production plan reads, 2026-11-19, added: a one-word brand ("GitHub",
 * "Freelancer.com", a listed well-known company), a singular organisation
 * noun before a capitalised name ("Dutch cleaning company De Poetsfee"), and
 * one body or its people ("the production committee", "Production committee
 * investors", "Toei's investors"). Pure.
 */
export function namesOneOrganisation(name: string | null | undefined): boolean {
  const text = bareName(name);
  return namesABuyer(text) && isOneOrganisation(text);
}

export function buyerPopulationName(payer: string | null | undefined): string | null {
  return remembered(buyerPopulationMemo, payer ?? '', readBuyerPopulationName);
}

function readBuyerPopulationName(payer: string): string | null {
  const named = payerNamedIn(payer);
  if (!named) return null;
  let text = named.replace(/\s+/g, ' ').trim();
  // "…, Mechanicsburg, PA" or "…, Harrisburg, Pennsylvania 17110": a place, not who pays.
  const comma = text.indexOf(',');
  if (comma > 0 && statesNamedIn(text.slice(comma)).length > 0) text = text.slice(0, comma).trim();
  // "small business operators, freelancers and educators": a list of populations is filed under the first, the one named as primary.
  else if (comma > 0 && !/^,\s*(?:inc|llc|ltd|co|corp|plc|lp|llp|pllc|pc|na)\b/i.test(text.slice(comma))) text = text.slice(0, comma).trim();
  text = text.replace(/^the\s+/i, '').replace(/[.,;:]+$/, '').trim();
  if (!text) return null;
  // "owner of a small bakery" -> "small bakery owners": a role over one business is the population of that role.
  const role = /^(owner|operator|manager|founder|proprietor)s?\s+of\s+(?:an?\s+|the\s+|their\s+|his\s+|her\s+)?(.+)$/i.exec(text);
  if (role) text = `${role[2]!.replace(/\s+in\s+.*$/i, '').trim()} ${role[1]!.toLowerCase()}s`;
  // "PA PUC Bureau of …": a leading postal code is the state its agency belongs to.
  const code = /^([A-Z]{2})\s+(.+)$/.exec(text);
  const coded = code ? stateFromField(code[1]) : null;
  if (code && coded && AGENCY_ANY.test(code[2]!)) text = `${coded} ${code[2]!}`;
  if (/\b(?:school district|public schools|school board|board of education|unified school)\b/i.test(text)) return 'school districts';
  if (/\b(?:universit(?:y|ies)|colleges?)\b/i.test(text)) return 'universities and colleges';
  if (/^(?:city|town|village|borough|township) of\b/i.test(text) || /\b(?:city|town|borough|township) (?:council|government)\b/i.test(text)) return 'municipal governments';
  if (/^county of\b/i.test(text) || /\bcounty(?: government| commissioners)?$/i.test(text)) return 'county governments';
  if (statesNamedIn(text).length > 0) {
    if (/^(?:state|commonwealth) of [a-z ]+$/i.test(text)) return 'state governments';
    // "<State> Department of <X>" -> "state <x> departments".
    const of = AGENCY_OF.exec(text);
    if (of && statesNamedIn(of[1]!).length > 0 && statesNamedIn(of[3]!).length === 0) return `state ${of[3]!.toLowerCase()} ${AGENCY_NOUNS[of[2]!.toLowerCase()]}`.slice(0, 90);
    // "<State> Environmental Protection Department" -> "state environmental protection departments".
    const after = AGENCY_AFTER.exec(text);
    const rest = after && statesNamedIn(after[1]!).length > 0 ? withoutStates(after[1]!) : '';
    if (after && rest) return `state ${rest.toLowerCase()} ${AGENCY_NOUNS[after[2]!.toLowerCase()]}`.slice(0, 90);
    text = withoutStates(text).replace(/^(?:the|of|in)\s+/i, '').trim();
  }
  if (!/[a-z]/i.test(text) || statesNamedIn(text).length > 0) return null;
  // One organisation no rule above generalised ("VA", "St Louis Development Corporation") is a payer, not a population to map.
  return namesABuyerPopulation(text) ? text.slice(0, 90) : null;
}

/**
 * The live BUYER_TYPE node a declared buyer name means, or null. An exact
 * (case-insensitive) name wins; otherwise `buyerNameKey` decides. Among
 * several, the one under `preferRoot` (the subtree a question asked about)
 * wins, then the oldest.
 */
export function matchBuyerType<N extends { id: string; parentId: string | null; kind: string; name: string; retiredAt: string | null; createdAt: string }>(
  name: string,
  nodes: Iterable<N>,
  preferRoot: string | null = null,
): N | null {
  const all = [...nodes];
  const byId = new Map(all.map((one) => [one.id, one]));
  const rootOf = (id: string): string => {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current && current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current?.id ?? id;
  };
  const live = all.filter((one) => one.kind === 'BUYER_TYPE' && !one.retiredAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const want = name.replace(/\s+/g, ' ').trim().toLowerCase();
  const key = buyerNameKey(name);
  if (!key) return null;
  const exact = live.filter((one) => one.name.toLowerCase() === want);
  const pool = exact.length > 0 ? exact : live.filter((one) => buyerNameKey(one.name) === key);
  return pool.find((one) => preferRoot !== null && rootOf(one.id) === preferRoot) ?? pool[0] ?? null;
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
        'omitted. Only CAPITAL_RESTRUCTURING, TRANSACTION_TYPE, UNIT_ECONOMIC and the two ROLE ' +
        'kinds name another thing.',
    };
  }
  if (finding === 'TRANSACTION_TYPE' && qualifier && !qualifier.includes('->')) {
    return {
      ok: false,
      error:
        `${where}: a TRANSACTION_TYPE's structural_qualifier is "<who pays> -> <who supplies>". ` +
        'Leave a side empty when the source names only one, or omit the qualifier.',
    };
  }
  if (findingNeedsQualifier(finding) && finding !== 'CAPITAL_RESTRUCTURING' && !qualifier) {
    return {
      ok: false,
      error: `${where}: a ${finding} finding must set structural_qualifier to the role it is about (optionally "role @ buyer type").`,
    };
  }
  if (finding === 'CAPITAL_RESTRUCTURING') {
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
  if (findingNeedsAmount(finding) && amountCents === null) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding states a figure, so structural_amount_cents is required ` +
        '(hundredths of the fact key\'s unit). A claim with no figure carries no finding.',
    };
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
