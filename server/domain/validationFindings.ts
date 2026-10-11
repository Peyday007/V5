/**
 * What a deep dive's claim establishes about whether one opening can be taken.
 *
 * The seventh claim axis, beside `opportunity_signal`, `structural_finding`,
 * `labor_finding`, `capability_finding`, `deal_finding` and `puzzle_finding`, and
 * it answers a question none of them does: about *this* opening, who pays, how a
 * supplier reaches them, and whether anything rules it out.
 *
 * Before it existed the answer was read from the lane a claim was filed in, and
 * that is how three production defects arose with every row healthy:
 *
 *   - A payer-lane claim saying nobody publishes a payer was written onto the
 *     card as the payer, so a raw market observation read as having one.
 *   - A disqualifier-lane claim could be either a disqualifier found or a
 *     documented absence of one, and the card counted both as "answered" — so a
 *     closed RFP sat one field from QUALIFIED with its own card saying the
 *     deadline had passed.
 *   - The contact-route lane established how to reach the buyer and answered
 *     only whether a phone call was needed, so `access` stayed blank on openings
 *     whose route was on the card.
 *
 * So the worker that read the source declares which of these a claim is, from a
 * closed set, and Brain reads the declaration rather than the sentence. Three
 * pairs keep a finding apart from its absence, because the two have opposite
 * consequences and an absence is not evidence of the opposite either:
 *
 *   - `NO_PAYER_FOUND` is never a payer, and it never proves there is none — the
 *     payer field stays unknown.
 *   - `NO_DISQUALIFIER_FOUND` answers the disqualifier question; a disqualifier
 *     established stops the opening; neither, which is the ordinary case for an
 *     unasked question, is *unresolved* and qualifies nothing.
 *   - `NO_BUYER_ROUTE_FOUND` leaves access unknown.
 */

export const VALIDATION_FINDINGS = [
  'PAYER_ESTABLISHED',
  'NO_PAYER_FOUND',
  'BUYER_ROUTE_ESTABLISHED',
  'NO_BUYER_ROUTE_FOUND',
  'DISQUALIFIED_CLOSED',
  'DISQUALIFIED_SUPPLIER_EXCLUDED',
  'DISQUALIFIED_REQUIREMENT_UNMET',
  'NO_DISQUALIFIER_FOUND',
  'RESPONSE_DEADLINE',
] as const;

export type ValidationFinding = (typeof VALIDATION_FINDINGS)[number];

export function isValidationFinding(value: unknown): value is ValidationFinding {
  return typeof value === 'string' && (VALIDATION_FINDINGS as readonly string[]).includes(value);
}

/** What each value means, in the words a worker reads in the tool schema. */
export const VALIDATION_FINDING_GUIDE: Readonly<Record<ValidationFinding, string>> = Object.freeze({
  PAYER_ESTABLISHED:
    'the source names the organisation or role that would actually pay for this opening',
  NO_PAYER_FOUND:
    'a documented search found no published payer for this opening (submit as NEGATIVE_EXISTENCE ' +
    'naming where you looked); it is not a payer, and it does not prove there is none',
  BUYER_ROUTE_ESTABLISHED:
    'the source publishes the route a supplier uses to reach this buyer — a portal, an email ' +
    'address, a form, a bid submission or a phone number',
  NO_BUYER_ROUTE_FOUND:
    'a documented search found no published route to this buyer (submit as NEGATIVE_EXISTENCE)',
  DISQUALIFIED_CLOSED:
    'the source states this request is closed, awarded, cancelled, withdrawn or past its deadline',
  DISQUALIFIED_SUPPLIER_EXCLUDED:
    'the source states a restriction that excludes a supplier like this one (a set-aside, a ' +
    'residency, a pre-qualified list, a licence it does not hold)',
  DISQUALIFIED_REQUIREMENT_UNMET:
    'the source states a requirement that cannot be met here (a bond, an insurance level, ' +
    'equipment or a certification the opening demands outright)',
  NO_DISQUALIFIER_FOUND:
    'a documented search of the request and its terms found nothing that rules this opening out ' +
    '(submit as NEGATIVE_EXISTENCE naming what you read)',
  RESPONSE_DEADLINE:
    'the source publishes the date responses close; give it in validation_date as YYYY-MM-DD. ' +
    'Brain compares it to its own clock, so a past date stops the opening and a future one is ' +
    'how early it is checked',
});

/** The three positive disqualifiers. */
export const DISQUALIFYING_FINDINGS: ReadonlySet<ValidationFinding> = new Set([
  'DISQUALIFIED_CLOSED',
  'DISQUALIFIED_SUPPLIER_EXCLUDED',
  'DISQUALIFIED_REQUIREMENT_UNMET',
]);

/** Findings that are documented absences: they must be submitted as NEGATIVE_EXISTENCE. */
export const ABSENCE_FINDINGS: ReadonlySet<ValidationFinding> = new Set([
  'NO_PAYER_FOUND',
  'NO_BUYER_ROUTE_FOUND',
  'NO_DISQUALIFIER_FOUND',
]);

export type ValidationFindingCheck =
  | { ok: true; value: { finding: ValidationFinding | null; date: string | null } }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The one rule both submission doors call.
 *
 * Every failure refuses the whole submission rather than dropping the field,
 * because a dropped declaration is reported as success and is the one outcome a
 * worker cannot recover from.
 */
export function validateValidationFinding(input: {
  where: string;
  finding: unknown;
  date: unknown;
  claimType: string;
}): ValidationFindingCheck {
  const { where } = input;
  const finding = input.finding === undefined || input.finding === null || input.finding === '' ? null : input.finding;
  const date = input.date === undefined || input.date === null || input.date === '' ? null : input.date;
  if (finding === null) {
    if (date !== null) {
      return { ok: false, error: `${where}: validation_date is given only with validation_finding RESPONSE_DEADLINE.` };
    }
    return { ok: true, value: { finding: null, date: null } };
  }
  if (!isValidationFinding(finding)) {
    return {
      ok: false,
      error: `${where}: validation_finding must be one of ${VALIDATION_FINDINGS.join(', ')}, or omitted.`,
    };
  }
  const absence = ABSENCE_FINDINGS.has(finding);
  if (absence && input.claimType !== 'NEGATIVE_EXISTENCE') {
    return {
      ok: false,
      error:
        `${where}: validation_finding ${finding} is a documented absence, so the claim must be ` +
        'claim_type NEGATIVE_EXISTENCE naming where you looked.',
    };
  }
  if (!absence && input.claimType === 'NEGATIVE_EXISTENCE') {
    return {
      ok: false,
      error:
        `${where}: a NEGATIVE_EXISTENCE claim cannot establish ${finding}. An absence is ` +
        'declared with the matching NO_… finding, never as the thing that was not found.',
    };
  }
  if (finding === 'RESPONSE_DEADLINE') {
    if (typeof date !== 'string' || !ISO_DATE.test(date) || Number.isNaN(Date.parse(date.slice(0, 10)))) {
      return {
        ok: false,
        error: `${where}: RESPONSE_DEADLINE needs validation_date as the published closing date, YYYY-MM-DD.`,
      };
    }
    return { ok: true, value: { finding, date: date.slice(0, 10) } };
  }
  if (date !== null) {
    return { ok: false, error: `${where}: validation_date is given only with validation_finding RESPONSE_DEADLINE.` };
  }
  return { ok: true, value: { finding, date: null } };
}

/**
 * Whether a published closing date has passed, by Brain's clock.
 *
 * A date with no time closes at the end of that day, UTC — the generous end,
 * because stopping an opening on the morning its responses are still due would be
 * a false disqualification.
 */
export function deadlinePassed(date: string, now: number): boolean {
  const end = Date.parse(`${date.slice(0, 10)}T23:59:59.999Z`);
  return Number.isFinite(end) && end < now;
}
