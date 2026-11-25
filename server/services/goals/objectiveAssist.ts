/**
 * A second reading of an objective's words, by a model, where the pattern
 * reader (`readObjective`) left a gap (§92, G-2).
 *
 * `readObjective` stays the reader: pure, synchronous, deterministic. It is
 * asked first, and only when it leaves one of three gaps is a model asked:
 *
 *   * a money figure it could not place ("a figure the reader could not place");
 *   * no amount (kind OTHER) while the words hold a figure with a currency;
 *   * a cash objective with no deadline it could read.
 *
 * The model's answer is a proposal, never a reading. Each field is accepted
 * only where the words themselves bear it out — every number appears in them,
 * a deadline's phrase is quoted from them, a resource or place is a substring
 * of them — and only into a field the reader left empty. A limit or deadline
 * the words do not state is never invented (invariant 39): a vague "a few
 * hours" has no figure to cite, so it is refused. Which fields came from the
 * model, and which it proposed and were refused, is recorded on the reading
 * (`assisted`) and so on the goal's opening event.
 *
 * No model configured, no answer, or no usable JSON: the reader's own reading
 * stands unchanged.
 */
import type { ChatFn, Message } from '../cheap/modelBench.ts';
import { assumedLittleCapital, statedFigures, statesMonthlyRate, type ObjectiveReading } from '../industry/construction/intent.ts';

/** A model to ask, as the operator's chain names it. */
export interface ObjectiveInterpreter {
  chat: ChatFn;
  label: string;
}

/** How long one second reading may take: goal creation is a person waiting. */
export const OBJECTIVE_ASSIST_TIMEOUT_MS = 30_000;

const UNPLACED = /: a figure the reader could not place$/;
const DAY = 86_400_000;

/** Why the reader's reading needs a second one, or null when it does not. */
export function assistReason(reading: ObjectiveReading, opts: { dueAtGiven?: boolean } = {}): string | null {
  if (reading.unread.some((u) => UNPLACED.test(u))) return 'a money figure was left unplaced';
  if (reading.kind === 'OTHER' && statedFigures(reading.text).some((f) => f.currency !== null)) return 'no amount was read while the words name money';
  if (reading.kind === 'CASH' && reading.deadline === null && !opts.dueAtGiven) return 'no deadline was read';
  return null;
}

export function objectivePrompt(text: string, now: Date): Message[] {
  return [
    {
      role: 'system',
      content:
        'You read one person\'s money goal and return exactly one JSON object, nothing else. Copy figures and phrases from the text; never compute, guess or fill in a value the text does not state. Use null for anything not stated.',
    },
    {
      role: 'user',
      content: [
        `Today is ${now.toISOString().slice(0, 10)}.`,
        'Return JSON with these keys:',
        '  kind: "CASH" if the person wants to bring in an amount of money, else "OTHER"',
        '  amount: the money to bring in, as a plain number exactly as written (5000 for "$5k"), or null',
        '  currency: "USD", "EUR" or "GBP" as the text marks it, or null',
        '  monthly: true if the amount is per month (a recurring monthly income), else false',
        '  deadline: the date the money is wanted by, as YYYY-MM-DD, or null if no time is stated',
        '  deadlinePhrase: the exact words of the text that state that time, copied verbatim, or null',
        '  capitalCeiling: the money the person has or will put in, as written, or null',
        '  hoursPerWeek: hours a week the person can give, only if a number is written, else null',
        '  resources: things the person says they have (equipment, free time), each copied verbatim, or []',
        '  location: a place the text names, copied verbatim, or null',
        '',
        `Text: """${text}"""`,
      ].join('\n'),
    },
  ];
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*\d[\d,]*(?:\.\d+)?\s*$/.test(v) ? Number(v.replace(/,/g, '')) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A deadline phrase must say a time; "asap" or "soon" is not one (the reader names those unread). */
const TIME_WORD = /\b(?:day|days|week|weeks|weekend|month|months|year|years|quarter|tomorrow|tonight|now|today|end|mid|early|late|spring|summer|fall|autumn|winter|christmas|xmas|thanksgiving|halloween|new year|valentine|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})/i;

/**
 * Merge a model's proposal into the reader's reading, accepting only what the
 * words bear out and only into fields the reader left empty. Pure.
 */
export function applyAssist(reading: ObjectiveReading, proposal: Record<string, unknown> | null, now: Date, model: string): ObjectiveReading {
  if (!proposal) return reading;
  const text = reading.text;
  const words = norm(text);
  const figures = statedFigures(text);
  const timesStated = (n: number) => figures.filter((f) => Math.abs(f.value - n) < 0.005).length;
  const fields: string[] = [];
  const rejected: string[] = [];
  const out: ObjectiveReading = { ...reading, unread: [...reading.unread], resources: [...reading.resources] };
  const placed: number[] = [];

  // The amount, its currency and its cadence: only where the reader read none.
  const amount = num(proposal['amount']);
  if (out.amount === null && amount !== null && amount > 0 && proposal['kind'] !== 'OTHER') {
    const usedAsCapital = out.capitalCeiling !== null && Math.abs(out.capitalCeiling - amount) < 0.005 && timesStated(amount) < 2;
    if (timesStated(amount) > 0 && !usedAsCapital) {
      out.amount = amount;
      out.kind = 'CASH';
      out.metric = /\b(?:profit|net|netting|contribution)\b/i.test(text) ? 'CONTRIBUTION' : 'SETTLED_CASH';
      placed.push(amount);
      fields.push('amount');
      if (proposal['monthly'] === true) {
        if (statesMonthlyRate(text)) {
          out.recurring = 'MONTHLY';
          fields.push('monthly');
        } else rejected.push('monthly: the words state no per-month figure');
      }
    } else rejected.push(`amount ${amount}: ${usedAsCapital ? 'already read as the capital' : 'not a figure the words state'}`);
  } else if (amount !== null && out.amount === null) rejected.push(`amount ${amount}: not a positive amount to bring in`);
  if (out.kind === 'CASH' && out.currency === null) {
    const currency = str(proposal['currency'])?.toUpperCase() ?? null;
    if (currency && figures.some((f) => f.currency === currency)) {
      out.currency = currency;
      fields.push('currency');
    } else if (currency) rejected.push(`currency ${currency}: not one the words name`);
  }

  // The deadline: a date, with the words that state it quoted from the text.
  const deadline = str(proposal['deadline']);
  if (out.deadline === null && deadline) {
    const phrase = str(proposal['deadlinePhrase']);
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(deadline);
    const at = day ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59)) : null;
    if (!phrase || !words.includes(norm(phrase))) rejected.push(`deadline ${deadline}: its phrase is not in the words`);
    else if (!TIME_WORD.test(phrase)) rejected.push(`deadline ${deadline}: "${phrase}" states no time`);
    else if (!at || Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() || at.getTime() > now.getTime() + 3 * 366 * DAY) rejected.push(`deadline ${deadline}: not a date ahead within three years`);
    else {
      out.deadline = at.toISOString();
      out.deadlineHours = Math.round((at.getTime() - now.getTime()) / 3_600_000);
      out.windowDays = null;
      fields.push('deadline');
      out.unread = out.unread.filter((u) => u !== 'deadline: none stated' && !u.startsWith(`"${phrase}"`));
    }
  }

  // Limits: only figures the words state, never a vague word made into a number.
  const capital = num(proposal['capitalCeiling']);
  if (out.capitalCeiling === null && capital !== null) {
    const isAmount = out.amount !== null && Math.abs(out.amount - capital) < 0.005 && timesStated(capital) < 2;
    if (capital >= 0 && timesStated(capital) > 0 && !isAmount) {
      out.capitalCeiling = capital;
      out.capitalAssumed = null;
      placed.push(capital);
      fields.push('capitalCeiling');
    } else rejected.push(`capitalCeiling ${capital}: ${isAmount ? 'already read as the amount' : 'not a figure the words state'}`);
  }
  const hours = num(proposal['hoursPerWeek']);
  if (out.hoursPerWeek === null && out.hoursCeiling === null && hours !== null) {
    if (hours > 0 && hours <= 168 && timesStated(hours) > 0 && /\b(?:hours?|hrs?)\b/i.test(text)) {
      out.hoursPerWeek = hours;
      if (out.deadline) out.hoursCeiling = Math.round((hours * (Date.parse(out.deadline) - now.getTime())) / (7 * DAY));
      fields.push('hoursPerWeek');
    } else rejected.push(`hoursPerWeek ${hours}: not a figure of hours the words state`);
  }

  // Resources and a place: verbatim substrings only.
  const resources = Array.isArray(proposal['resources']) ? proposal['resources'].map(str).filter((r): r is string => !!r) : [];
  let tookResource = false;
  for (const r of resources) {
    if (!words.includes(norm(r))) rejected.push(`resource "${r}": not in the words`);
    else if (!out.resources.some((o) => norm(o).includes(norm(r)) || norm(r).includes(norm(o)))) {
      out.resources.push(r);
      tookResource = true;
    }
  }
  if (tookResource) fields.push('resources');
  const location = str(proposal['location']);
  if (location && (out.location ?? null) === null) {
    if (words.includes(norm(location))) {
      out.location = location;
      fields.push('location');
    } else rejected.push(`location "${location}": not in the words`);
  }

  // What the reader could not place and the second reading placed is no longer unread.
  out.unread = out.unread.filter((u) => {
    const m = /^"(.+)": a figure the reader could not place$/.exec(u);
    if (!m) return true;
    const value = statedFigures(m[1]!)[0]?.value;
    return value === undefined || !placed.some((p) => Math.abs(p - value) < 0.005);
  });
  if (out.kind === 'CASH' && reading.kind === 'OTHER') {
    if (!out.currency) out.unread.push(`currency: "${out.amount}" names no currency`);
    if (!out.deadline) out.unread.push('deadline: none stated');
    if (out.capitalCeiling === null && out.amount !== null) out.capitalAssumed = assumedLittleCapital(text, out.amount);
  }
  if (fields.length === 0 && rejected.length === 0) return reading;
  return { ...out, assisted: { model, fields, rejected } };
}

/**
 * Ask the model for a second reading where the reader left a gap, and merge
 * what the words bear out. Never throws; with no interpreter, or no usable
 * answer, the reader's reading is returned as it was.
 */
export async function assistObjective(
  reading: ObjectiveReading,
  now: Date,
  interpreter: ObjectiveInterpreter | null,
  opts: { dueAtGiven?: boolean } = {},
): Promise<ObjectiveReading> {
  if (!interpreter || !assistReason(reading, opts)) return reading;
  try {
    const { firstJson } = await import('../cheap/modelBench.ts');
    const answer = await interpreter.chat(objectivePrompt(reading.text, now), undefined, 800);
    if (answer.error) return reading;
    return applyAssist(reading, firstJson(answer.content), now, interpreter.label);
  } catch {
    return reading;
  }
}

/** The operator's first model (`modelsFor`), or null when none is configured. */
export async function operatorInterpreter(env: NodeJS.ProcessEnv = process.env): Promise<ObjectiveInterpreter | null> {
  try {
    const { modelsFor } = await import('../operator/run.ts');
    const { chatFor } = await import('../cheap/modelBench.ts');
    const model = (await modelsFor(env))[0];
    if (!model) return null;
    return { label: model.label, chat: chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, fetch, OBJECTIVE_ASSIST_TIMEOUT_MS) };
  } catch {
    return null;
  }
}
