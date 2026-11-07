/**
 * What the operator wants, read from their own words (§92).
 *
 * The reading is by matching, never by a model deciding what somebody meant —
 * the discipline `operatingModel.ts` and `cash/exclusions.ts` keep. Each thing
 * read is recorded as a requirement with its kind:
 *
 *   * HARD — the operator cannot do otherwise (money they do not have; the
 *     standing rule that the owner does no physical work);
 *   * PREFERENCE — what they would like (speed, scale, control, a sequence).
 *
 * A preference is never treated as an absolute requirement. Where two pull
 * against each other — quick cash against a capital-heavy durable company —
 * the conflict is named with the way it can be reconciled (in sequence, in
 * parallel, or by a different operating structure), and the strategy search is
 * what decides whether it actually can be.
 *
 * Overrides are how a person replans: a changed capital range, urgency, risk
 * tolerance, desired control or ambition replaces what the words said, and the
 * whole construction is derived again from it.
 */
import { CONTROL_TARGETS, type ControlTarget } from '../../../domain/construction.ts';

export type Urgency = 'IMMEDIATE' | 'SOON' | 'PATIENT';
export type RiskTolerance = 'LOW' | 'MEDIUM' | 'HIGH';
export type CapitalAppetite = 'LIGHT' | 'HEAVY';
export type SequenceStep = 'BROKER' | 'SUBCONTRACT' | 'FULFILMENT' | 'ASSETS' | 'RECRUIT' | 'COORDINATE';

export interface IntentRequirement {
  id: string;
  statement: string;
  kind: 'HARD' | 'PREFERENCE';
  from: 'OPERATOR' | 'STANDING_RULE' | 'OVERRIDE';
}

export interface IntentConflict {
  between: [string, string];
  why: string;
  reconcile: 'SEQUENCE' | 'PARALLEL' | 'STRUCTURE';
}

export interface OperatorIntent {
  text: string;
  /** The industry phrase as the operator wrote it, e.g. "last-mile logistics". */
  industry: string | null;
  geography: string | null;
  /** Dollars. Null when the words name no amount. */
  capital: { low: number; high: number } | null;
  urgency: Urgency | null;
  /** The day by which the first collected dollar is wanted, derived from urgency. */
  firstCashWithinDays: number | null;
  durable: boolean;
  scale: 'LARGE' | 'MODEST' | null;
  control: ControlTarget[];
  riskTolerance: RiskTolerance | null;
  capitalAppetite: CapitalAppetite | null;
  sequence: SequenceStep[];
  /** What the operator says they already have. */
  assets: string[];
  /** The operator said, in their own words, that they will not do the physical work. */
  statedNoPhysicalWork: boolean;
  requirements: IntentRequirement[];
  conflicts: IntentConflict[];
}

export interface IntentOverrides {
  capital?: { low: number; high: number };
  urgency?: Urgency;
  riskTolerance?: RiskTolerance;
  control?: ControlTarget[];
  scale?: 'LARGE' | 'MODEST';
  capitalAppetite?: CapitalAppetite;
  durable?: boolean;
  industry?: string;
  geography?: string;
}

const URGENCY_DAYS: Record<Urgency, number> = { IMMEDIATE: 30, SOON: 90, PATIENT: 365 };

function amount(raw: string, suffix: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''));
  const s = (suffix ?? '').toLowerCase();
  if (s === 'k' || s === 'thousand') return n * 1_000;
  if (s === 'm' || s === 'million' || s === 'mm') return n * 1_000_000;
  return n;
}

const MONEY = String.raw`\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|mm|thousand|million)?\b`;

/** Every amount of money the words name, ranges kept together. */
export function readCapital(text: string): { low: number; high: number } | null {
  const range = new RegExp(`${MONEY}\\s*(?:-|–|—|to|and)\\s*${MONEY}(?:\\s*(?:dollars|usd))?`, 'i');
  const r = range.exec(text);
  const moneyish = (m: RegExpExecArray, a: number) =>
    /\$/.test(m[0]) || /\b(k|m|thousand|million)\b/i.test(m[0]) || /dollars|usd/i.test(text.slice(m.index, m.index + m[0].length + 9)) || a >= 1_000;
  if (r) {
    // "10k-30k" or "$10,000-$30,000": a suffix on the second side applies to a bare first side.
    const hi = amount(r[3]!, r[4]);
    const lo = amount(r[1]!, r[2] ?? r[4]);
    if (moneyish(r, hi) && hi > 0) return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
  }
  const single = new RegExp(MONEY, 'gi');
  for (let m = single.exec(text); m; m = single.exec(text)) {
    const a = amount(m[1]!, m[2]);
    const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
    if (moneyish(m, a) && /\$|have|available|capital|budget|invest|dollars|usd|save|savings/i.test(near) && a >= 100) return { low: a, high: a };
  }
  return null;
}

/** The industry phrase: what follows "enter", "start", "get into", "build a … company". */
export function readIndustry(text: string): string | null {
  const m =
    /\b(?:enter|entering|get into|getting into|break into|start in|go into|start an?|build an?|launch an?)\s+(?:the\s+)?([a-z][a-z\- ]{2,60}?)(?=\s+(?:in|around|across|near|business|company|industry|market|space|sector|and|with|,|\.|$)|[,.]|$)/i.exec(text);
  if (!m) return null;
  const phrase = m[1]!.trim().replace(/\s+(?:business|company|industry|market|space|sector)$/i, '');
  if (/^(?:revenue|cash|money|capital|significant|large|durable)/i.test(phrase)) return null;
  return phrase || null;
}

export function readGeography(text: string): string | null {
  const m = /\bin\s+((?:Metro\s+|Greater\s+|Downtown\s+)?[A-Z][A-Za-z.]+(?:[\s-][A-Z][A-Za-z.]+){0,3})/.exec(text);
  return m ? m[1]!.trim().replace(/\.+$/, '') : null;
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/** Read the operator's words, then apply a person's overrides. Pure. */
export function interpretIntent(text: string, overrides: IntentOverrides = {}): OperatorIntent {
  const t = text.replace(/\s+/g, ' ').trim();
  const requirements: IntentRequirement[] = [];
  const conflicts: IntentConflict[] = [];

  const industry = overrides.industry ?? readIndustry(t);
  const geography = overrides.geography ?? readGeography(t);
  const capital = overrides.capital ?? readCapital(t);

  let urgency: Urgency | null = null;
  if (has(t, /\b(immediate(?:ly)?|right away|this (?:week|month)|asap|quick(?:ly)?|fast|rapid(?:ly)?|soon as possible|generating revenue quickly|cash flow now)\b/i)) urgency = 'IMMEDIATE';
  else if (has(t, /\b(soon|within (?:a|one|two|three|\d+) (?:month|months|quarter))\b/i)) urgency = 'SOON';
  else if (has(t, /\b(no rush|patient|long[- ]term only|over (?:several|many) years)\b/i)) urgency = 'PATIENT';
  if (overrides.urgency) urgency = overrides.urgency;

  const durable = overrides.durable ?? has(t, /\b(eventually|durable|enterprise|significant|large|big|major|long[- ]term|build toward|empire|scale)\b/i);
  let scale: 'LARGE' | 'MODEST' | null = has(t, /\b(large|significant|big|major|durable enterprise|empire|national)\b/i) ? 'LARGE' : has(t, /\b(small|side|lifestyle|modest)\b/i) ? 'MODEST' : null;
  if (overrides.scale) scale = overrides.scale;

  const control = new Set<ControlTarget>();
  if (has(t, /\b(bottleneck|chokepoint|valuable parts|control (?:over|of) (?:valuable|key|the)|own the valuable)\b/i)) control.add('CHOKEPOINTS');
  if (has(t, /\bcontrol(?:ling)? (?:the )?fulfil+ment|own (?:the )?fulfil+ment|operate (?:our|my) own\b/i)) control.add('FULFILMENT');
  if (has(t, /\b(own|control)\w* (?:the )?(?:customers?|demand|accounts|relationships)\b/i)) control.add('DEMAND');
  if (has(t, /\b(own|control)\w* (?:the )?(?:supply|capacity|drivers|network)\b/i)) control.add('SUPPLY');
  if (has(t, /\bcapital[- ]heavy|own (?:the )?(?:assets|fleet|equipment|trucks|vans|warehouses?)\b/i)) control.add('ASSETS');
  if (has(t, /\bcontracts?\b/i) && has(t, /\b(control|own|hold)\b/i)) control.add('CONTRACTS');
  if (control.size === 0 && has(t, /\bcontrol\b/i)) control.add('CHOKEPOINTS');
  const controlList = overrides.control ? [...new Set(overrides.control.filter((c) => (CONTROL_TARGETS as readonly string[]).includes(c)))] : [...control];

  let capitalAppetite: CapitalAppetite | null = has(t, /\bcapital[- ]heavy|asset[- ]heavy|own the (?:assets|fleet)\b/i) ? 'HEAVY' : has(t, /\b(capital[- ]light|asset[- ]light|lean|without (?:much|big) (?:capital|investment))\b/i) ? 'LIGHT' : null;
  if (overrides.capitalAppetite) capitalAppetite = overrides.capitalAppetite;

  let riskTolerance: RiskTolerance | null = has(t, /\b(low risk|safe|can'?t afford to lose|conservative|minimi[sz]e risk)\b/i) ? 'LOW' : has(t, /\b(aggressive|high risk|bet big|all in)\b/i) ? 'HIGH' : null;
  if (overrides.riskTolerance) riskTolerance = overrides.riskTolerance;

  const sequence: SequenceStep[] = [];
  const seq = /\b(?:begin|start)\w* (?:with|by|as) ([^.;]+?),? (?:then|and then|before|later|gradually|eventually)\b([^.;]*)/i.exec(t);
  if (seq) {
    const step = (s: string): SequenceStep | null =>
      /broker/i.test(s) ? 'BROKER' : /subcontract/i.test(s) ? 'SUBCONTRACT' : /recruit/i.test(s) ? 'RECRUIT' : /coordinat|dispatch/i.test(s) ? 'COORDINATE' : /fulfil+ment|operat|deliver/i.test(s) ? 'FULFILMENT' : /asset|fleet|own/i.test(s) ? 'ASSETS' : null;
    for (const part of [seq[1]!, seq[2]!]) {
      const s = step(part);
      if (s && !sequence.includes(s)) sequence.push(s);
    }
  }

  const assets: string[] = [];
  for (const m of t.matchAll(/\bI (?:have|own|already have) (?:an? |two |three |\d+ )?((?!\$|\d)[a-z][a-z \-]{2,40}?)(?=[,.;]| and | but |$)/gi)) {
    const a = m[1]!.trim();
    if (!/\b(dollars|money|capital|budget)\b/i.test(a)) assets.push(a);
  }

  const statedNoPhysicalWork = has(t, /\bwithout (?:me )?personally\b|\bnot (?:personally|myself)\b|\bI (?:don'?t|do not|won'?t|will not) (?:want to )?(?:drive|deliver|do (?:the )?(?:physical|deliveries|work))|\bno physical work\b|\bwithout (?:making|doing) (?:the )?deliveries\b/i);

  // The requirements, each with its kind.
  if (capital) {
    requirements.push({
      id: 'capital',
      statement: capital.low === capital.high ? `At most $${capital.high.toLocaleString('en-US')} of the operator's money is committed.` : `Between $${capital.low.toLocaleString('en-US')} and $${capital.high.toLocaleString('en-US')} is available; only the lower figure is certain, and nothing above the upper is committed.`,
      kind: 'HARD',
      from: overrides.capital ? 'OVERRIDE' : 'OPERATOR',
    });
  }
  requirements.push({
    id: 'no_physical_work',
    statement: statedNoPhysicalWork
      ? 'The operator does no physical work (stated, and Brain’s standing rule): independent operators or employees managed by a hired manager do it.'
      : 'Brain’s standing rule: the owner does no physical work; independent operators or employees managed by a hired manager do it.',
    kind: 'HARD',
    from: statedNoPhysicalWork ? 'OPERATOR' : 'STANDING_RULE',
  });
  if (urgency) requirements.push({ id: 'urgency', statement: `First collected cash within about ${URGENCY_DAYS[urgency]} days.`, kind: 'PREFERENCE', from: overrides.urgency ? 'OVERRIDE' : 'OPERATOR' });
  if (durable || scale === 'LARGE') requirements.push({ id: 'durable', statement: 'Build toward a significant, durable company rather than a one-off income.', kind: 'PREFERENCE', from: overrides.durable !== undefined || overrides.scale ? 'OVERRIDE' : 'OPERATOR' });
  if (controlList.length) requirements.push({ id: 'control', statement: `Control over: ${controlList.join(', ').toLowerCase()}.`, kind: 'PREFERENCE', from: overrides.control ? 'OVERRIDE' : 'OPERATOR' });
  if (capitalAppetite) requirements.push({ id: 'capital_appetite', statement: capitalAppetite === 'HEAVY' ? 'Willing to own capital-heavy assets.' : 'Prefers to stay capital-light.', kind: 'PREFERENCE', from: overrides.capitalAppetite ? 'OVERRIDE' : 'OPERATOR' });
  if (riskTolerance) requirements.push({ id: 'risk', statement: `Risk tolerance ${riskTolerance.toLowerCase()}.`, kind: 'PREFERENCE', from: overrides.riskTolerance ? 'OVERRIDE' : 'OPERATOR' });
  if (sequence.length) requirements.push({ id: 'sequence', statement: `Preferred order: ${sequence.join(' → ').toLowerCase()}.`, kind: 'PREFERENCE', from: 'OPERATOR' });

  // Conflicts, and how each could be reconciled.
  const has_ = (id: string) => requirements.some((r) => r.id === id);
  if (urgency === 'IMMEDIATE' && (has_('durable') || controlList.length > 0)) {
    conflicts.push({ between: ['urgency', has_('durable') ? 'durable' : 'control'], why: 'the business that collects cash fastest is rarely the one that holds valuable control', reconcile: 'SEQUENCE' });
  }
  if (capitalAppetite === 'HEAVY' && capital && capital.high < 100_000) {
    conflicts.push({ between: ['capital_appetite', 'capital'], why: `owning heavy assets on $${capital.high.toLocaleString('en-US')} leaves little for working capital and reserves`, reconcile: 'STRUCTURE' });
  }
  if (capitalAppetite === 'HEAVY' && urgency === 'IMMEDIATE') {
    conflicts.push({ between: ['capital_appetite', 'urgency'], why: 'acquiring and insuring assets delays the first collected dollar', reconcile: 'PARALLEL' });
  }
  if (riskTolerance === 'LOW' && controlList.includes('ASSETS')) {
    conflicts.push({ between: ['risk', 'control'], why: 'owned assets put the operator’s money at risk before buyers commit', reconcile: 'SEQUENCE' });
  }

  return {
    text: t,
    industry,
    geography,
    capital,
    urgency,
    firstCashWithinDays: urgency ? URGENCY_DAYS[urgency] : null,
    durable,
    scale,
    control: controlList,
    riskTolerance,
    capitalAppetite,
    sequence,
    assets,
    statedNoPhysicalWork,
    requirements,
    conflicts,
  };
}
