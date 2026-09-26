/**
 * What a work order, a candidate and a set of terms must say before Brain
 * will hold them — validated here, once, for every door that writes one.
 *
 * Every refusal is a sentence a person can act on, and every one refuses the
 * whole write rather than dropping a field. §27 records why: a silently
 * dropped field is the one outcome a caller cannot recover from, because it
 * is reported as success.
 */
import { FOUNDATION_DIMENSIONS } from '../identity/foundation.ts';
import {
  ACCEPTANCE_CHECKS,
  COMPETENCE_BASES,
  RATE_BASES,
  type AcceptanceCondition,
  type CompetenceEvidence,
  type EngagementTerms,
  type RateBasis,
} from '../../domain/types.ts';

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export function stringList(value: unknown, field: string, options: { min?: number } = {}): Checked<string[]> {
  if (value === undefined || value === null) {
    return (options.min ?? 0) > 0
      ? { ok: false, reason: `${field} must list at least ${options.min} item(s).` }
      : { ok: true, value: [] };
  }
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be a list of sentences.` };
  const items = value.map(text).filter(Boolean);
  if (items.length !== value.length) {
    return { ok: false, reason: `${field} holds an empty or non-text entry; every entry must say something.` };
  }
  if (items.length < (options.min ?? 0)) {
    return { ok: false, reason: `${field} must list at least ${options.min} item(s).` };
  }
  return { ok: true, value: items };
}

/**
 * The standard a result is accepted against.
 *
 * Never empty: an order with no acceptance conditions is an order whose result
 * can only be accepted on somebody's say-so, which is the thing this whole path
 * exists to replace. Keys are unique because a review names the condition it
 * judged, and two conditions under one key would let one verdict stand for two.
 */
export function acceptanceConditions(value: unknown): Checked<AcceptanceCondition[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      reason:
        'Say how the result will be accepted: at least one condition, each with a key, a ' +
        'statement and how it is checked. Without one, "done" would mean whatever somebody says.',
    };
  }
  const out: AcceptanceCondition[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const key = text(entry['key']);
    const statement = text(entry['statement']);
    const check = text(entry['check']) || 'PERSON_REVIEW';
    if (!key || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(key)) {
      return { ok: false, reason: `acceptance[${index}].key must be a short identifier.` };
    }
    if (keys.has(key)) return { ok: false, reason: `acceptance key "${key}" appears twice.` };
    keys.add(key);
    if (!statement) return { ok: false, reason: `acceptance[${index}] must state the condition.` };
    if (!(ACCEPTANCE_CHECKS as readonly string[]).includes(check)) {
      return { ok: false, reason: `acceptance[${index}].check must be one of ${ACCEPTANCE_CHECKS.join(', ')}.` };
    }
    const condition: AcceptanceCondition = {
      key,
      statement,
      check: check as AcceptanceCondition['check'],
    };
    if (check === 'ACCOUNT_FOUNDATION') {
      const userId = text(entry['userId']);
      const dimension = text(entry['dimension']);
      if (!userId || !dimension) {
        return {
          ok: false,
          reason: `acceptance[${index}] is checked against an account's foundation, so it must name the userId and the dimension.`,
        };
      }
      if (!(FOUNDATION_DIMENSIONS as readonly string[]).includes(dimension)) {
        // A dimension the foundation does not read would never be MET, and the
        // order would wait for ever on a word nobody checks.
        return {
          ok: false,
          reason: `acceptance[${index}].dimension must be one of ${FOUNDATION_DIMENSIONS.join(', ')}.`,
        };
      }
      condition.userId = userId;
      condition.dimension = dimension;
    }
    out.push(condition);
  }
  return { ok: true, value: out };
}

export function competenceEvidence(value: unknown): Checked<CompetenceEvidence[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'competence must be a list.' };
  const out: CompetenceEvidence[] = [];
  for (const [index, raw] of value.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const statement = text(entry['statement']);
    const basis = text(entry['basis']);
    if (!statement) return { ok: false, reason: `competence[${index}] must say what it shows.` };
    if (!(COMPETENCE_BASES as readonly string[]).includes(basis)) {
      return {
        ok: false,
        reason:
          `competence[${index}].basis must be one of ${COMPETENCE_BASES.join(', ')}. A skill somebody ` +
          'says they have is CLAIMED_BY_CANDIDATE, which is recorded and never counted as proof.',
      };
    }
    const ref = text(entry['ref']) || null;
    if (basis !== 'CLAIMED_BY_CANDIDATE' && !ref) {
      return {
        ok: false,
        reason: `competence[${index}] is ${basis}, so it must name what a reader can check it against (ref).`,
      };
    }
    out.push({ statement, basis: basis as CompetenceEvidence['basis'], ref });
  }
  return { ok: true, value: out };
}

export function rateBasis(value: unknown): RateBasis | null {
  const candidate = text(value);
  return (RATE_BASES as readonly string[]).includes(candidate) ? (candidate as RateBasis) : null;
}

/**
 * Terms complete enough to put in front of a person for a decision.
 *
 * Every field the brief names is required, and "none" must be said rather than
 * left out: an engagement whose access list is empty because nobody thought
 * about access looks identical to one that needs none, and only the second is
 * safe to approve.
 */
export function engagementTerms(value: unknown): Checked<EngagementTerms> {
  const entry = (value ?? {}) as Record<string, unknown>;
  const scope = text(entry['scope']);
  if (!scope) return { ok: false, reason: 'The terms must state the scope of the work.' };
  const deliverables = stringList(entry['deliverables'], 'deliverables', { min: 1 });
  if (!deliverables.ok) return deliverables;

  const scheduleRaw = entry['schedule'];
  if (!Array.isArray(scheduleRaw) || scheduleRaw.length === 0) {
    return { ok: false, reason: 'The terms must give a schedule: at least one milestone, with its due date or null.' };
  }
  const schedule: EngagementTerms['schedule'] = [];
  for (const [index, raw] of scheduleRaw.entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const milestone = text(item['milestone']);
    const due = text(item['due']) || null;
    if (!milestone) return { ok: false, reason: `schedule[${index}] must name the milestone.` };
    if (due && Number.isNaN(Date.parse(due))) return { ok: false, reason: `schedule[${index}].due is not a date.` };
    schedule.push({ milestone, due });
  }

  const cents = entry['compensationCents'];
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
    return {
      ok: false,
      reason:
        'compensationCents must be a whole, non-negative number of minor units. Work at no charge is 0, ' +
        'stated — never an absent figure read as free.',
    };
  }
  const currency = text(entry['currency']).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: 'currency must be a three-letter code.' };
  const compensationBasis = text(entry['compensationBasis']);
  if (!compensationBasis) {
    return { ok: false, reason: 'Say where the figure comes from: the candidate\'s quote, a published rate, or no charge.' };
  }
  const access = stringList(entry['access'], 'access');
  if (!access.ok) return access;
  if (!Array.isArray(entry['access'])) {
    return { ok: false, reason: 'access must be stated, as an empty list where the work needs none.' };
  }
  const confidentiality = text(entry['confidentiality']);
  const ownership = text(entry['ownership']);
  if (!confidentiality) return { ok: false, reason: 'State the confidentiality terms, or say none apply.' };
  if (!ownership) return { ok: false, reason: 'State who owns the result, or say it is not applicable.' };

  return {
    ok: true,
    value: {
      scope,
      deliverables: deliverables.value,
      schedule,
      compensationCents: cents,
      currency,
      rateBasis: rateBasis(entry['rateBasis']),
      compensationBasis,
      access: access.value,
      confidentiality,
      ownership,
    },
  };
}

export function money(cents: number, currency: string): string {
  if (cents === 0) return 'no charge';
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
