/**
 * Whether a browser routine actually obtained what it promised (ACQ-21-5).
 *
 * `browserWorkflow.ts` reports a run COMPLETED when every step ran and its own
 * `expect` steps held. That says the clicks worked. It does not say the
 * intended state was reached or the intended dataset was obtained: a results
 * page can render with zero rows, a download can be an error page with a 200,
 * an export can be last month's. So a run is judged a second time, against the
 * expectations its capability declares:
 *
 *  - the final page state (an address fragment, text that must be present,
 *    text that must be absent),
 *  - each extracted dataset's shape (present, minimum rows, required fields,
 *    field types),
 *  - each download's presence, minimum size and, when pinned, its sha256,
 *  - freshness: the newest date the data carries must be inside the declared
 *    window.
 *
 * A run whose steps all passed but whose verification fails is not a success,
 * and every failure carries one typed reason so the run row, the retry policy
 * and the review state can act on it without reading prose. A passing
 * verification names every check it ran, so "verified" is never a claim
 * without its checks.
 *
 * Pure: no I/O. The clock is a parameter.
 */
import type { WorkflowRun } from '../browserWorkflow.ts';

export const FAILURE_REASONS = [
  'LOCATOR_MISSING',
  'STATE_MISMATCH',
  'EMPTY_DATASET',
  'STALE',
  'BOUNDARY',
  'TIMEOUT',
  'RATE_LIMITED',
  'UNKNOWN_OUTCOME',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type FieldType = 'string' | 'number' | 'date' | 'boolean';

export interface DatasetExpectation {
  /** The extract step's name. */
  name: string;
  /** Rows the dataset must carry at least (default 1). */
  minRows?: number;
  /** Fields every row must carry, by header or key. */
  requiredFields?: string[];
  /** Expected type of named fields; a value that does not parse as the type fails. */
  fieldTypes?: Record<string, FieldType>;
  /** The field whose newest value is the dataset's as-of date, for freshness. */
  dateField?: string;
}

export interface DownloadExpectation {
  name: string;
  /** Characters the download must carry at least (default 1). */
  minChars?: number;
  /** When pinned, the download must have exactly this content hash. */
  sha256?: string;
  /** Text an error page carries and a real file does not. */
  absentText?: string[];
}

export interface OutcomeExpectation {
  finalState?: { urlIncludes?: string; text?: string[]; absentText?: string[] };
  datasets?: DatasetExpectation[];
  downloads?: DownloadExpectation[];
  /** The newest data must be at most this old. */
  freshness?: { maxAgeHours: number };
}

export interface VerificationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface OutcomeVerification {
  verified: boolean;
  /** The first reason the run failed, or null when verified. */
  failureReason: FailureReason | null;
  /** Every check that was run, passed or not, in order. */
  checks: VerificationCheck[];
  /** The newest date found in the data, ISO, when one was read. */
  asOf: string | null;
}

/** The page text a run ended on, as far as the run carries it. */
export interface FinalPage {
  text?: string;
}

/* ------------------------------------------------------------------------- */
/* Parsing extracted text into rows (pure)                                    */
/* ------------------------------------------------------------------------- */

export type Row = Record<string, string>;

/**
 * Rows from extracted text: a JSON array of objects, delimited lines with a
 * header row (comma, tab or pipe), or one row per non-empty line under a
 * single `value` field. A lone delimited line whose cells include every
 * expected field is a header with no rows under it, not a one-row dataset.
 * Pure.
 */
export function rowsFrom(text: string, expectedFields: readonly string[] = []): Row[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r))
          .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
      }
    } catch {
      // not JSON; read it as lines
    }
  }
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && expectedFields.length > 0) {
    const lone = ['\t', '|', ','].find((d) => lines[0]!.includes(d));
    const cells = lone ? lines[0]!.split(lone).map((c) => c.trim()) : [lines[0]!];
    if (expectedFields.every((f) => cells.includes(f))) return [];
  }
  const delimiter = ['\t', '|', ','].find((d) => lines.length > 1 && lines[0]!.includes(d) && lines.slice(1).every((l) => l.split(d).length === lines[0]!.split(d).length));
  if (delimiter) {
    const header = lines[0]!.split(delimiter).map((h) => h.trim());
    return lines.slice(1).map((l) => {
      const cells = l.split(delimiter).map((c) => c.trim());
      return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    });
  }
  return lines.map((value) => ({ value }));
}

function parsesAs(value: string, type: FieldType): boolean {
  const v = value.trim();
  if (v === '') return false;
  switch (type) {
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(Number(v.replace(/[,\s]/g, '').replace(/^[^\d+-]+/, '')));
    case 'boolean':
      return /^(true|false|yes|no|0|1)$/i.test(v);
    case 'date':
      return Number.isFinite(Date.parse(v));
  }
}

/* ------------------------------------------------------------------------- */
/* Verification                                                               */
/* ------------------------------------------------------------------------- */

/** The typed reason a run that did not complete stopped for. Pure. */
export function reasonForRun(run: Pick<WorkflowRun, 'outcome' | 'boundary' | 'interfaceChanged' | 'detail'>): FailureReason | null {
  if (run.outcome === 'COMPLETED') return null;
  if (run.boundary) return 'BOUNDARY';
  if (run.interfaceChanged) return 'LOCATOR_MISSING';
  const detail = run.detail ?? '';
  if (/\b(429|too many requests|rate[- ]?limit|busy)\b/i.test(detail)) return 'RATE_LIMITED';
  if (/\b(time(d)? ?out|timeout|deadline)\b/i.test(detail)) return 'TIMEOUT';
  if (run.outcome === 'REFUSED' || run.outcome === 'HANDOFF') return 'BOUNDARY';
  return 'UNKNOWN_OUTCOME';
}

/**
 * Verify a run against its capability's declared expectations. A run that did
 * not complete fails with the reason it stopped for; a completed run must pass
 * every declared check. Pure: `now` is the clock.
 */
export function verifyOutcome(
  run: Pick<WorkflowRun, 'outcome' | 'boundary' | 'interfaceChanged' | 'detail' | 'finalUrl' | 'extracted' | 'downloads'>,
  expected: OutcomeExpectation,
  options: { now: Date; finalPage?: FinalPage },
): OutcomeVerification {
  const checks: VerificationCheck[] = [];
  let failureReason: FailureReason | null = null;
  const fail = (reason: FailureReason): void => {
    failureReason ??= reason;
  };
  const add = (check: string, passed: boolean, detail: string, reason: FailureReason): void => {
    checks.push({ check, passed, detail });
    if (!passed) fail(reason);
  };

  const stopped = reasonForRun(run);
  add('run completed its steps', stopped === null, stopped === null ? 'every step ran and its own checks held' : `${run.outcome}: ${run.detail}`, stopped ?? 'UNKNOWN_OUTCOME');
  if (stopped !== null) return { verified: false, failureReason, checks, asOf: null };

  const fs = expected.finalState;
  if (fs?.urlIncludes !== undefined) {
    const ok = typeof run.finalUrl === 'string' && run.finalUrl.includes(fs.urlIncludes);
    add(`final address includes ${JSON.stringify(fs.urlIncludes)}`, ok, ok ? 'it does' : `the run ended at ${run.finalUrl ?? 'no address'}`, 'STATE_MISMATCH');
  }
  const pageText = options.finalPage?.text ?? '';
  for (const t of fs?.text ?? []) {
    const ok = pageText.includes(t);
    add(`final page shows ${JSON.stringify(t)}`, ok, ok ? 'present' : 'absent', 'STATE_MISMATCH');
  }
  for (const t of fs?.absentText ?? []) {
    const ok = !pageText.includes(t);
    add(`final page does not show ${JSON.stringify(t)}`, ok, ok ? 'absent' : 'present', 'STATE_MISMATCH');
  }

  let newest = Number.NaN;
  for (const d of expected.datasets ?? []) {
    const got = run.extracted.find((e) => e.name === d.name);
    if (!got) {
      add(`dataset ${d.name} was extracted`, false, 'no extract of that name in the run', 'EMPTY_DATASET');
      continue;
    }
    const rows = rowsFrom(got.text, d.requiredFields ?? []);
    const min = d.minRows ?? 1;
    add(`dataset ${d.name} has at least ${min} row(s)`, rows.length >= min, `${rows.length} row(s)`, 'EMPTY_DATASET');
    for (const field of d.requiredFields ?? []) {
      const missing = rows.filter((r) => !(field in r) || r[field]!.trim() === '').length;
      add(`dataset ${d.name} carries ${field} on every row`, rows.length > 0 && missing === 0, missing === 0 ? 'every row' : `${missing} row(s) without it`, 'STATE_MISMATCH');
    }
    for (const [field, type] of Object.entries(d.fieldTypes ?? {})) {
      const bad = rows.filter((r) => r[field] !== undefined && r[field]!.trim() !== '' && !parsesAs(r[field]!, type)).length;
      add(`dataset ${d.name} ${field} is ${type}`, bad === 0, bad === 0 ? 'every value parses' : `${bad} value(s) do not parse`, 'STATE_MISMATCH');
    }
    if (d.dateField) {
      const times = rows.map((r) => Date.parse(r[d.dateField!] ?? '')).filter(Number.isFinite);
      if (times.length > 0) {
        const max = Math.max(...times);
        newest = Number.isFinite(newest) ? Math.max(newest, max) : max;
      }
    }
  }

  for (const dl of expected.downloads ?? []) {
    const got = run.downloads.find((x) => x.name === dl.name);
    if (!got) {
      add(`download ${dl.name} was obtained`, false, 'no download of that name in the run', 'EMPTY_DATASET');
      continue;
    }
    const min = dl.minChars ?? 1;
    add(`download ${dl.name} carries at least ${min} character(s)`, got.chars >= min, `${got.chars} character(s)`, 'EMPTY_DATASET');
    if (dl.sha256) add(`download ${dl.name} matches its pinned sha256`, got.sha256 === dl.sha256, got.sha256 === dl.sha256 ? 'it matches' : 'a different file', 'STATE_MISMATCH');
    for (const t of dl.absentText ?? []) {
      const ok = !got.text.includes(t);
      add(`download ${dl.name} does not contain ${JSON.stringify(t)}`, ok, ok ? 'absent' : 'present: the file is an error page', 'STATE_MISMATCH');
    }
  }

  const asOf = Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  if (expected.freshness) {
    const maxMs = expected.freshness.maxAgeHours * 3_600_000;
    if (asOf === null) {
      add(`data is at most ${expected.freshness.maxAgeHours}h old`, false, 'no dated value was found to judge freshness by', 'STALE');
    } else {
      const age = options.now.getTime() - newest;
      add(`data is at most ${expected.freshness.maxAgeHours}h old`, age <= maxMs, `newest value ${asOf} is ${Math.round(age / 3_600_000)}h old`, 'STALE');
    }
  }

  return { verified: failureReason === null, failureReason, checks, asOf };
}
