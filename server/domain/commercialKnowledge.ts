/**
 * Commercial knowledge read from public datasets (§121): the vocabulary and
 * the pure rules. Nothing here touches the network or the database.
 *
 * Every figure is classified on the same dimensions — industry (NAICS, the
 * classification the datasets themselves use), geography, period, size class,
 * what kind of quantity it is (volume, price, cost, margin, capital, cash
 * flow, operations, structure) and how it is known:
 *
 *   FACT       a figure the publisher printed, read as printed;
 *   ESTIMATE   arithmetic over facts (a mean, a share, a figure carried
 *              forward from an older year by a measured ratio), with its basis;
 *   INFERENCE  a model's reading — a classification or an interpretation;
 *   UNKNOWN    a figure the publisher withheld or nobody has measured, kept as
 *              a row so it is a gap rather than a silence (invariant 39).
 *
 * A derived figure never reads as a fact, and an inference never reads as an
 * estimate: the planner sees which it is.
 */
import { REVENUE_BASES, type RevenueBasis } from './construction.ts';

export const EPISTEMIC_CLASSES = ['FACT', 'ESTIMATE', 'INFERENCE', 'UNKNOWN'] as const;
export type Epistemic = (typeof EPISTEMIC_CLASSES)[number];

export const METRIC_CLASSES = ['VOLUME', 'PRICE', 'COST', 'MARGIN', 'CAPITAL', 'CASH_FLOW', 'OPERATIONS', 'STRUCTURE'] as const;
export type MetricClass = (typeof METRIC_CLASSES)[number];

/** Every metric Brain stores, its unit and its class. A Record, so a new metric is a compile error until classed. */
export const METRICS = {
  FIRMS: { label: 'Employer firms', unit: 'firms', class: 'VOLUME' },
  ESTABLISHMENTS: { label: 'Employer establishments', unit: 'establishments', class: 'VOLUME' },
  SMALL_ESTABLISHMENTS: { label: 'Employer establishments with fewer than 20 employees', unit: 'establishments', class: 'VOLUME' },
  NONEMPLOYER_ESTABLISHMENTS: { label: 'Nonemployer businesses (no paid employees)', unit: 'establishments', class: 'VOLUME' },
  EMPLOYMENT: { label: 'Paid employees (mid-March)', unit: 'employees', class: 'OPERATIONS' },
  ANNUAL_PAYROLL: { label: 'Annual payroll', unit: 'USD', class: 'COST' },
  RECEIPTS: { label: 'Receipts (revenue)', unit: 'USD', class: 'PRICE' },
  NONEMPLOYER_RECEIPTS: { label: 'Nonemployer receipts', unit: 'USD', class: 'PRICE' },
  // Derived per-industry economics: the reusable model.
  RECEIPTS_PER_FIRM: { label: 'Receipts per employer firm', unit: 'USD/firm/year', class: 'PRICE' },
  SMALL_FIRM_RECEIPTS_PER_FIRM: { label: 'Receipts per employer firm with fewer than 20 employees', unit: 'USD/firm/year', class: 'PRICE' },
  RECEIPTS_PER_EMPLOYEE: { label: 'Receipts per employee', unit: 'USD/employee/year', class: 'OPERATIONS' },
  PAYROLL_SHARE_OF_RECEIPTS: { label: 'Payroll as a share of receipts', unit: 'share', class: 'MARGIN' },
  REVENUE_AFTER_PAYROLL_SHARE: { label: 'Share of receipts left after payroll (an upper bound on gross margin for labour-only work)', unit: 'share', class: 'MARGIN' },
  AVERAGE_ANNUAL_WAGE: { label: 'Annual payroll per employee', unit: 'USD/employee/year', class: 'COST' },
  EMPLOYEES_PER_ESTABLISHMENT: { label: 'Employees per establishment', unit: 'employees', class: 'OPERATIONS' },
  NONEMPLOYER_RECEIPTS_PER_BUSINESS: { label: 'Receipts per nonemployer business', unit: 'USD/business/year', class: 'PRICE' },
  NONEMPLOYER_SHARE: { label: 'Share of businesses with no employees', unit: 'share', class: 'STRUCTURE' },
  SMALL_ESTABLISHMENT_SHARE: { label: 'Share of employer establishments with fewer than 20 employees', unit: 'share', class: 'STRUCTURE' },
  ESTABLISHMENT_GROWTH: { label: 'Change in employer establishments between two vintages', unit: 'share', class: 'STRUCTURE' },
  RECEIPTS_CURRENT_ESTIMATE: { label: 'Receipts carried to the newest payroll year by the payroll ratio', unit: 'USD', class: 'PRICE' },
  // SEC XBRL, per company and then per industry.
  PUBLIC_COMPANIES: { label: 'SEC registrants filing annual statements', unit: 'companies', class: 'VOLUME' },
  GROSS_MARGIN: { label: 'Gross margin of public companies (median)', unit: 'share', class: 'MARGIN' },
  OPERATING_MARGIN: { label: 'Operating margin of public companies (median)', unit: 'share', class: 'MARGIN' },
  RECEIVABLE_DAYS: { label: 'Days of revenue held as receivables (median)', unit: 'days', class: 'CASH_FLOW' },
  INVENTORY_DAYS: { label: 'Days of cost held as inventory (median)', unit: 'days', class: 'CASH_FLOW' },
  FIXED_ASSETS_PER_REVENUE: { label: 'Net property, plant and equipment per dollar of revenue (median)', unit: 'USD/USD', class: 'CAPITAL' },
} as const satisfies Record<string, { label: string; unit: string; class: MetricClass }>;
export type Metric = keyof typeof METRICS;

export function isMetric(value: unknown): value is Metric {
  return typeof value === 'string' && value in METRICS;
}

/* ------------------------------------------------------------------- NAICS */

/**
 * A NAICS code as the datasets spell it, normalised: CBP writes `11----` and
 * `113///`, SUSB `--` for the total and `11` for a sector, nonemployer `00`.
 * The total is `00`; everything else is its digits.
 */
export function normaliseNaics(raw: string): string | null {
  const s = raw.replace(/["\s]/g, '');
  if (s === '' || /^[-/]+$/.test(s) || s === '00' || s === '0') return '00';
  const digits = s.replace(/[-/]+$/, '');
  // Ranges such as 31-33 (manufacturing), 44-45 and 48-49 are sectors.
  const range = /^(\d{2})-(\d{2})$/.exec(digits);
  if (range) return range[1]!;
  return /^\d{2,6}$/.test(digits) ? digits : null;
}

export function naicsLevel(code: string): number {
  return code === '00' ? 0 : code.length;
}

/** The sector a code belongs to, folding the three split sectors (31-33, 44-45, 48-49) onto their first code. */
export function sectorOf(code: string): string {
  if (code === '00') return '00';
  const two = code.slice(0, 2);
  if (two === '32' || two === '33') return '31';
  if (two === '45') return '44';
  if (two === '49') return '48';
  return two;
}

/** The parent codes of a code, nearest first, ending at its sector. */
export function naicsAncestors(code: string): string[] {
  const out: string[] = [];
  for (let n = code.length - 1; n >= 2; n--) out.push(code.slice(0, n));
  return out;
}

/** What the businesses of a NAICS sector do, who pays them and how they are paid — the deterministic first reading. */
export interface SectorReading {
  name: string;
  activity: string;
  customer: CustomerCategory;
  revenue: RevenueBasis[];
}

export const CUSTOMER_CATEGORIES = ['BUSINESS', 'CONSUMER', 'GOVERNMENT', 'MIXED'] as const;
export type CustomerCategory = (typeof CUSTOMER_CATEGORIES)[number];

/**
 * NAICS 2022 sectors. The names are the classification's own; the activity,
 * customer and revenue basis are what the sector's definition states (NAICS
 * 2022 manual, sector descriptions): wholesale sells to businesses, retail to
 * households, real estate and rental earns rent, finance earns a financing
 * margin. A subindustry the GPU reads differently is recorded as MODEL.
 */
export const NAICS_SECTORS: Record<string, SectorReading> = {
  '11': { name: 'Agriculture, Forestry, Fishing and Hunting', activity: 'grow, raise or harvest', customer: 'BUSINESS', revenue: ['RESALE'] },
  '21': { name: 'Mining, Quarrying, and Oil and Gas Extraction', activity: 'extract', customer: 'BUSINESS', revenue: ['RESALE'] },
  '22': { name: 'Utilities', activity: 'supply power, water or gas', customer: 'MIXED', revenue: ['SUBSCRIPTION'] },
  '23': { name: 'Construction', activity: 'build, install or repair structures', customer: 'MIXED', revenue: ['SERVICE'] },
  '31': { name: 'Manufacturing', activity: 'make goods', customer: 'BUSINESS', revenue: ['RESALE'] },
  '42': { name: 'Wholesale Trade', activity: 'distribute goods to businesses', customer: 'BUSINESS', revenue: ['RESALE', 'FEE'] },
  '44': { name: 'Retail Trade', activity: 'sell goods to households', customer: 'CONSUMER', revenue: ['RESALE'] },
  '48': { name: 'Transportation and Warehousing', activity: 'move or store goods and people', customer: 'BUSINESS', revenue: ['SERVICE'] },
  '51': { name: 'Information', activity: 'publish, broadcast or process information', customer: 'MIXED', revenue: ['SUBSCRIPTION', 'FEE'] },
  '52': { name: 'Finance and Insurance', activity: 'lend, insure or invest', customer: 'MIXED', revenue: ['FINANCING', 'FEE'] },
  '53': { name: 'Real Estate and Rental and Leasing', activity: 'rent, lease or broker assets', customer: 'MIXED', revenue: ['RENT', 'FEE'] },
  '54': { name: 'Professional, Scientific, and Technical Services', activity: 'apply expertise', customer: 'BUSINESS', revenue: ['SERVICE'] },
  '55': { name: 'Management of Companies and Enterprises', activity: 'manage affiliated companies', customer: 'BUSINESS', revenue: ['FEE'] },
  '56': { name: 'Administrative and Support and Waste Management and Remediation Services', activity: 'support other organisations’ operations', customer: 'BUSINESS', revenue: ['SERVICE'] },
  '61': { name: 'Educational Services', activity: 'teach', customer: 'CONSUMER', revenue: ['SERVICE', 'SUBSCRIPTION'] },
  '62': { name: 'Health Care and Social Assistance', activity: 'treat and care', customer: 'CONSUMER', revenue: ['SERVICE'] },
  '71': { name: 'Arts, Entertainment, and Recreation', activity: 'entertain', customer: 'CONSUMER', revenue: ['FEE', 'SUBSCRIPTION'] },
  '72': { name: 'Accommodation and Food Services', activity: 'host and feed', customer: 'CONSUMER', revenue: ['RESALE', 'SERVICE'] },
  '81': { name: 'Other Services (except Public Administration)', activity: 'repair, maintain and serve', customer: 'MIXED', revenue: ['SERVICE'] },
  '92': { name: 'Public Administration', activity: 'govern', customer: 'GOVERNMENT', revenue: ['FEE'] },
  '99': { name: 'Industries not classified', activity: 'unclassified', customer: 'MIXED', revenue: ['SERVICE'] },
};

export function sectorReading(code: string): SectorReading | null {
  return NAICS_SECTORS[sectorOf(code)] ?? null;
}

export function isRevenueBasis(value: unknown): value is RevenueBasis {
  return typeof value === 'string' && (REVENUE_BASES as readonly string[]).includes(value);
}

/* --------------------------------------------------------------- geography */

/** The states by FIPS code, and the nation as `US`. */
export const US_STATES: Record<string, string> = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas', '06': 'California', '08': 'Colorado', '09': 'Connecticut',
  '10': 'Delaware', '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii', '16': 'Idaho', '17': 'Illinois',
  '18': 'Indiana', '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland',
  '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
  '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York', '37': 'North Carolina',
  '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
  '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont', '51': 'Virginia',
  '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
};

/** `US` or `US-<fips>`. */
export function geoCode(stateFips: string | null): string {
  return !stateFips || stateFips === '00' ? 'US' : `US-${stateFips}`;
}

export function geoLabel(code: string): string {
  if (code === 'US') return 'United States';
  return US_STATES[code.slice(3)] ?? code;
}

/** The one state a text names (or a metro the operator's words used), else null: a count is national unless a market is stated. */
export function stateNamedIn(text: string): string | null {
  const lower = ` ${text.toLowerCase().replace(/[^a-z ]+/g, ' ')} `;
  const metros: Record<string, string> = { detroit: '26', philadelphia: '42', pittsburgh: '42', chicago: '17', houston: '48', dallas: '48', austin: '48', atlanta: '13', miami: '12', seattle: '53', boston: '25', phoenix: '04', denver: '08' };
  const found = new Set<string>();
  for (const [fips, name] of Object.entries(US_STATES)) {
    if (name === 'Washington' && /\bwashington dc\b|\bwashington d c\b/.test(lower)) continue;
    if (lower.includes(` ${name.toLowerCase()} `)) found.add(fips);
  }
  for (const [word, fips] of Object.entries(metros)) if (lower.includes(` ${word} `)) found.add(fips);
  return found.size === 1 ? [...found][0]! : null;
}

/* ---------------------------------------------------------------- matching */

const STOP = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'for', 'in', 'on', 'to', 'with', 'by', 'at', 'from', 'that', 'who', 'which', 'their', 'its', 'as',
  'except', 'other', 'all', 'related', 'activities', 'services', 'service', 'businesses', 'business', 'firms', 'firm', 'companies', 'company',
  'operators', 'operator', 'owners', 'owner', 'owned', 'operated', 'small', 'mid', 'size', 'sized', 'large', 'local', 'independent', 'us',
  'establishments', 'industries', 'industry', 'buyers', 'buyer', 'sellers', 'people', 'organizations', 'organisations', 'providers', 'provider',
  'new', 'existing', 'year', 'end', 'sending', 'buying', 'selling', 'using', 'who', 'need', 'needs', 'they', 'them', 'such', 'shared', 'slot',
]);

/** Words a buyer description and a NAICS title spell differently, mapped onto the classification's words. */
const SYNONYMS: Record<string, string[]> = {
  hvac: ['heating', 'air', 'conditioning'],
  restaurant: ['restaurants', 'food'],
  restaurants: ['restaurants', 'food'],
  cafe: ['restaurants', 'coffee'],
  dentist: ['dentists'],
  dental: ['dentists'],
  lawyer: ['legal', 'lawyers'],
  lawyers: ['legal', 'lawyers'],
  attorney: ['legal', 'lawyers'],
  accountant: ['accounting'],
  accountants: ['accounting'],
  cpa: ['accounting'],
  bookkeeping: ['bookkeeping', 'accounting'],
  realtor: ['real', 'estate', 'agents'],
  realtors: ['real', 'estate', 'agents'],
  salon: ['beauty', 'salons'],
  salons: ['beauty', 'salons'],
  gym: ['fitness'],
  gyms: ['fitness'],
  trucking: ['trucking', 'freight'],
  truckers: ['trucking', 'freight'],
  courier: ['couriers', 'messengers'],
  couriers: ['couriers', 'messengers'],
  delivery: ['couriers', 'delivery'],
  landscaper: ['landscaping'],
  landscapers: ['landscaping'],
  plumber: ['plumbing'],
  plumbers: ['plumbing'],
  roofer: ['roofing'],
  roofers: ['roofing'],
  electrician: ['electrical'],
  electricians: ['electrical'],
  contractor: ['contractors'],
  contractors: ['contractors'],
  clinic: ['offices', 'physicians'],
  clinics: ['offices', 'physicians'],
  doctor: ['physicians'],
  doctors: ['physicians'],
  therapist: ['therapists'],
  therapists: ['therapists'],
  ecommerce: ['electronic', 'shopping'],
  shop: ['stores'],
  shops: ['stores'],
  store: ['stores'],
  stores: ['stores'],
  retailer: ['stores', 'retailers'],
  retailers: ['stores', 'retailers'],
  printer: ['printing'],
  printers: ['printing'],
  agency: ['agencies'],
  agencies: ['agencies'],
  marketing: ['marketing', 'advertising'],
  software: ['software'],
  saas: ['software', 'publishers'],
  school: ['schools'],
  schools: ['schools'],
  tutoring: ['educational', 'support', 'instruction'],
  daycare: ['child', 'care'],
  childcare: ['child', 'care'],
  church: ['religious'],
  churches: ['religious'],
  nonprofit: ['organizations'],
  nonprofits: ['organizations'],
  hotel: ['hotels'],
  hotels: ['hotels', 'motels'],
  bar: ['drinking', 'places'],
  bars: ['drinking', 'places'],
  autobody: ['automotive', 'body'],
  mechanic: ['automotive', 'repair'],
  mechanics: ['automotive', 'repair'],
  cleaners: ['cleaning', 'janitorial'],
  cleaning: ['cleaning', 'janitorial'],
  janitorial: ['janitorial'],
  pest: ['exterminating', 'pest'],
  warehouse: ['warehousing', 'storage'],
  warehouses: ['warehousing', 'storage'],
  freight: ['freight', 'trucking'],
  logistics: ['freight', 'transportation', 'logistics'],
  broker: ['brokers', 'brokerage'],
  brokers: ['brokers', 'brokerage'],
  insurance: ['insurance'],
  photographers: ['photographic'],
  photographer: ['photographic'],
  pharmacy: ['pharmacies'],
  pharmacies: ['pharmacies'],
  veterinarian: ['veterinary'],
  veterinarians: ['veterinary'],
  vet: ['veterinary'],
  vets: ['veterinary'],
  farm: ['farming'],
  farms: ['farming'],
  manufacturers: ['manufacturing'],
  manufacturer: ['manufacturing'],
  distributors: ['wholesalers', 'merchant'],
  distributor: ['wholesalers', 'merchant'],
  wholesalers: ['wholesalers', 'merchant'],
  property: ['property', 'real', 'estate'],
  landlords: ['lessors', 'real', 'estate'],
  landlord: ['lessors', 'real', 'estate'],
  construction: ['construction'],
  builders: ['construction', 'building'],
  builder: ['construction', 'building'],
};

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ers')) return word.slice(0, -1);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The content words of a text, stemmed, with synonyms spelt in the classification's words. */
export function contentWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)) {
    if (!raw || raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
    for (const one of SYNONYMS[raw] ?? []) out.add(stem(one));
  }
  return [...out];
}

export interface NaicsTitle {
  naics: string;
  label: string;
}

export interface LexicalMatch {
  naics: string;
  label: string;
  score: number;
  matched: string[];
}

/**
 * The NAICS industries whose title shares the buyer description's content
 * words, scored by the share of the title's words the description covers and
 * the share of the description's words the title covers (both matter: a short
 * title wholly inside a long description is a strong match). Deterministic;
 * the GPU is asked only when nothing scores above the floor.
 */
export function lexicalNaicsMatches(description: string, titles: readonly NaicsTitle[], limit = 8): LexicalMatch[] {
  const want = new Set(contentWords(description));
  if (want.size === 0) return [];
  const out: LexicalMatch[] = [];
  for (const title of titles) {
    if (title.naics.length < 4) continue;
    const words = contentWords(title.label);
    if (words.length === 0) continue;
    const matched = words.filter((w) => want.has(w));
    if (matched.length === 0) continue;
    const titleCover = matched.length / words.length;
    const descCover = matched.length / want.size;
    // Prefer the most specific code: a 6-digit title is a narrower claim than its 4-digit parent.
    const specificity = 0.02 * (title.naics.length - 4);
    out.push({ naics: title.naics, label: title.label, score: Math.round((0.6 * titleCover + 0.4 * descCover + specificity) * 1000) / 1000, matched });
  }
  out.sort((a, b) => b.score - a.score || b.naics.length - a.naics.length || a.naics.localeCompare(b.naics));
  return out.slice(0, limit);
}

/** The score a lexical match must reach to be filed without asking the GPU. */
export const LEXICAL_FLOOR = 0.55;

/**
 * The industries a buyer description is: the best title, then any title that
 * covers a word of the description the chosen ones leave uncovered ("accounting
 * and bookkeeping firms" is the accounting-and-bookkeeping industry group, not
 * only "Other Accounting Services"). Nested codes count once, at the broadest.
 * Null when nothing reaches the floor: the GPU is asked instead.
 */
export function chooseIndustries(description: string, titles: readonly NaicsTitle[], limit = 3): { codes: string[]; matches: LexicalMatch[] } | null {
  const lexical = lexicalNaicsMatches(description, titles, 40);
  const best = lexical[0];
  if (!best || best.score < LEXICAL_FLOOR) return null;
  const chosen = [best];
  const covered = new Set(best.matched);
  for (const m of lexical.slice(1)) {
    if (chosen.length >= limit) break;
    const adds = m.matched.filter((w) => !covered.has(w));
    if (m.score >= best.score * 0.85 || (adds.length > 0 && m.score >= LEXICAL_FLOOR)) {
      chosen.push(m);
      for (const w of adds) covered.add(w);
    }
  }
  const codes = withoutNested(chosen.map((c) => c.naics)).slice(0, limit);
  return { codes, matches: chosen.filter((c) => codes.includes(c.naics)) };
}

/** Buyer descriptions that say they mean small businesses: the count is the under-20-employee establishments plus the nonemployers when the words say owner-operated. */
export function sizeClassOf(description: string): 'ALL' | 'SMALL' {
  return /\b(small|owner[- ]operated|independent|local|family[- ]owned|solo|sole|mom[- ]and[- ]pop|micro)\b/i.test(description) ? 'SMALL' : 'ALL';
}

/** Codes that are each other's ancestors count once: keep the broadest of any chain. */
export function withoutNested(codes: readonly string[]): string[] {
  const sorted = [...new Set(codes)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const code of sorted) if (!kept.some((k) => code.startsWith(k))) kept.push(code);
  return kept;
}

/* --------------------------------------------------------------- economics */

export interface FactLike {
  id: string;
  metric: Metric;
  value: number;
  period: string;
  epistemic: Epistemic;
  sizeClass: string;
}

export interface DerivedFigure {
  metric: Metric;
  value: number;
  sizeClass: string;
  period: string;
  basis: string;
  inputs: string[];
}

function pick(facts: readonly FactLike[], metric: Metric, sizeClass = 'ALL'): FactLike[] {
  return facts.filter((f) => f.metric === metric && f.sizeClass === sizeClass && f.epistemic === 'FACT' && Number.isFinite(f.value)).sort((a, b) => b.period.localeCompare(a.period));
}

function sameYear(a: readonly FactLike[], b: readonly FactLike[]): [FactLike, FactLike] | null {
  for (const x of a) {
    const y = b.find((one) => one.period === x.period);
    if (y) return [x, y];
  }
  return null;
}

const round = (v: number, places = 4): number => Math.round(v * 10 ** places) / 10 ** places;

/**
 * The reusable economics of one industry in one geography, derived from the
 * published figures held for it. Each derived figure names the facts it was
 * computed from and the arithmetic, so a planner can see that it is an
 * ESTIMATE and of what. Pure.
 */
export function deriveEconomics(facts: readonly FactLike[]): DerivedFigure[] {
  const out: DerivedFigure[] = [];
  const ratio = (metric: Metric, num: Metric, den: Metric, sizeNum: string, sizeDen: string, scale: number, basis: string, sizeOut = sizeNum) => {
    const pair = sameYear(pick(facts, num, sizeNum), pick(facts, den, sizeDen));
    if (!pair || !(pair[1].value > 0) || !(pair[0].value >= 0)) return;
    out.push({ metric, value: round((pair[0].value * scale) / pair[1].value), sizeClass: sizeOut, period: pair[0].period, basis, inputs: [pair[0].id, pair[1].id] });
  };
  ratio('RECEIPTS_PER_FIRM', 'RECEIPTS', 'FIRMS', 'ALL', 'ALL', 1, 'receipts ÷ employer firms, same year and publisher');
  ratio('SMALL_FIRM_RECEIPTS_PER_FIRM', 'RECEIPTS', 'FIRMS', 'SMALL', 'SMALL', 1, 'receipts ÷ firms, enterprises under 20 employees');
  ratio('RECEIPTS_PER_EMPLOYEE', 'RECEIPTS', 'EMPLOYMENT', 'ALL', 'ALL', 1, 'receipts ÷ paid employees, same year');
  ratio('PAYROLL_SHARE_OF_RECEIPTS', 'ANNUAL_PAYROLL', 'RECEIPTS', 'ALL', 'ALL', 1, 'annual payroll ÷ receipts, same year');
  ratio('AVERAGE_ANNUAL_WAGE', 'ANNUAL_PAYROLL', 'EMPLOYMENT', 'ALL', 'ALL', 1, 'annual payroll ÷ paid employees, same year');
  ratio('EMPLOYEES_PER_ESTABLISHMENT', 'EMPLOYMENT', 'ESTABLISHMENTS', 'ALL', 'ALL', 1, 'paid employees ÷ establishments, same year');
  ratio('NONEMPLOYER_RECEIPTS_PER_BUSINESS', 'NONEMPLOYER_RECEIPTS', 'NONEMPLOYER_ESTABLISHMENTS', 'ALL', 'ALL', 1, 'nonemployer receipts ÷ nonemployer businesses');
  ratio('SMALL_ESTABLISHMENT_SHARE', 'SMALL_ESTABLISHMENTS', 'ESTABLISHMENTS', 'ALL', 'ALL', 1, 'establishments under 20 employees ÷ all establishments');

  const payShare = out.find((d) => d.metric === 'PAYROLL_SHARE_OF_RECEIPTS');
  if (payShare && payShare.value <= 1) {
    out.push({ metric: 'REVENUE_AFTER_PAYROLL_SHARE', value: round(1 - payShare.value), sizeClass: 'ALL', period: payShare.period, basis: '1 − payroll share of receipts (an upper bound on the margin of labour-only work; materials and rent come out of it too)', inputs: payShare.inputs });
  }

  // Share of businesses with no employees: nonemployers ÷ (nonemployers + employer establishments), nearest years.
  const non = pick(facts, 'NONEMPLOYER_ESTABLISHMENTS')[0];
  const est = pick(facts, 'ESTABLISHMENTS')[0];
  if (non && est && non.value + est.value > 0) {
    out.push({ metric: 'NONEMPLOYER_SHARE', value: round(non.value / (non.value + est.value)), sizeClass: 'ALL', period: non.period, basis: `nonemployer businesses ${non.period} ÷ (nonemployers ${non.period} + employer establishments ${est.period})`, inputs: [non.id, est.id] });
  }

  // Growth between the oldest and newest vintages of establishments.
  const ests = pick(facts, 'ESTABLISHMENTS');
  if (ests.length >= 2) {
    const newest = ests[0]!;
    const oldest = ests[ests.length - 1]!;
    if (oldest.value > 0 && newest.period !== oldest.period) {
      out.push({ metric: 'ESTABLISHMENT_GROWTH', value: round(newest.value / oldest.value - 1), sizeClass: 'ALL', period: newest.period, basis: `establishments ${newest.period} ÷ establishments ${oldest.period} − 1`, inputs: [newest.id, oldest.id] });
    }
  }

  // Receipts are published only in economic-census years; carry them to the newest payroll year by the payroll ratio.
  const receipts = pick(facts, 'RECEIPTS')[0];
  const payrolls = pick(facts, 'ANNUAL_PAYROLL');
  const payThen = receipts ? payrolls.find((p) => p.period === receipts.period) : undefined;
  const payNow = payrolls[0];
  if (receipts && payThen && payNow && payNow.period > receipts.period && payThen.value > 0) {
    out.push({ metric: 'RECEIPTS_CURRENT_ESTIMATE', value: Math.round(receipts.value * (payNow.value / payThen.value)), sizeClass: 'ALL', period: payNow.period, basis: `receipts ${receipts.period} × (payroll ${payNow.period} ÷ payroll ${payThen.period}): assumes the payroll share of receipts held`, inputs: [receipts.id, payThen.id, payNow.id] });
  }
  return out;
}

/* ----------------------------------------------------------- contradictions */

export type Resolution = 'PREFER_A' | 'PREFER_B' | 'RECONCILED' | 'UNRESOLVED';

/** How far apart two readings of one quantity may be before it is a contradiction. */
export const CONTRADICTION_TOLERANCE = 0.1;

export function relativeGap(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

/**
 * Two programs' counts of one quantity for one year. Both Census programs
 * read the same Business Register, so a gap inside the tolerance is a
 * definition difference (establishment vs enterprise frame, noise infusion)
 * and is reconciled; beyond it the program that publishes the quantity as
 * its primary measure is preferred, and the gap stays visible.
 */
export function resolveProgramGap(a: { value: number; primaryFor: boolean }, b: { value: number; primaryFor: boolean }): { gap: number; resolution: Resolution; reason: string } | null {
  const gap = relativeGap(a.value, b.value);
  if (gap === 0) return null;
  if (gap <= CONTRADICTION_TOLERANCE) return { gap, resolution: 'RECONCILED', reason: `within ${CONTRADICTION_TOLERANCE * 100}%: the two programs differ by frame and noise infusion, not by what they measured` };
  if (a.primaryFor && !b.primaryFor) return { gap, resolution: 'PREFER_A', reason: 'the first program publishes this quantity as its primary measure' };
  if (b.primaryFor && !a.primaryFor) return { gap, resolution: 'PREFER_B', reason: 'the second program publishes this quantity as its primary measure' };
  return { gap, resolution: 'UNRESOLVED', reason: 'neither program is the primary measure of this quantity; both are kept and the range spans them' };
}

/**
 * A map fact a person or research filed about how many buyers of a kind
 * exist, read against a census count of the industries the buyer type is.
 * A count from a published register of the whole population is stronger than
 * an assumption or a secondary estimate; an OBSERVED or VERIFIED figure about
 * a narrower population (one metro, one list) is not contradicted by a
 * national count — that is scope, not disagreement.
 */
export function judgeBuyerCount(existing: { low: number; high: number; status: string }, census: number): { contradicts: boolean; resolution: Resolution; reason: string } {
  const inside = census >= existing.low * (1 - CONTRADICTION_TOLERANCE) && census <= existing.high * (1 + CONTRADICTION_TOLERANCE);
  if (inside) return { contradicts: false, resolution: 'RECONCILED', reason: 'the census count lies inside the filed range' };
  if (existing.status === 'ASSUMPTION' || existing.status === 'ESTIMATE') {
    return { contradicts: true, resolution: 'PREFER_B', reason: `the filed range was ${existing.status.toLowerCase()}; a published count of the whole population replaces it` };
  }
  return { contradicts: true, resolution: 'UNRESOLVED', reason: 'the filed figure was observed and may measure a narrower market; both stand and the planner reads the strongest per market' };
}

/* --------------------------------------------------------------- freshness */

/** How long a dataset's figures stay current: until the publisher's next vintage is due, plus the publisher's lag. */
export const RELEASE_CADENCE_DAYS: Record<string, number> = {
  CBP: 365,
  SUSB: 365,
  NES: 365,
  SEC_XBRL: 120,
};

export function validUntilOf(family: string, acquiredAt: string): string {
  const days = RELEASE_CADENCE_DAYS[family] ?? 365;
  return new Date(Date.parse(acquiredAt) + days * 86_400_000).toISOString();
}
