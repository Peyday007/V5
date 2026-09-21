/**
 * The bounded sales test: the one step in this loop that spends, and the one
 * that this Brain cannot currently perform.
 *
 * ---------------------------------------------------------------------------
 * Preparation is Brain's. Spending is a person's. Neither is silent.
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit: *where access or authority is missing, complete the
 * available preparation and expose the precise blocker*. That sentence is this
 * module's whole shape. Everything Brain can settle from rows — is there a
 * derivable margin, is there a supplier, does the channel forbid it, is there
 * a standing commercial grant, does a capability exist that could actually
 * list and sell — is settled here and written down. The first thing that is
 * missing becomes a named blocker on a row, and the row is the answering
 * transition: §24's rule that a state saying "waiting for a person" which that
 * person cannot resolve is not waiting, it is stuck.
 *
 * ---------------------------------------------------------------------------
 * Three gates, in the order deny-by-default asks them
 * ---------------------------------------------------------------------------
 *
 * **May this happen** before **could this happen** before **should this
 * happen**. `advanceWithinAuthority` settled that order in §30 and it is not
 * re-argued here: asking the capability first would mean discovering that
 * Brain *could* list a product it was never authorized to sell, which is a
 * fact nobody should learn by nearly doing it.
 *
 * ---------------------------------------------------------------------------
 * What this version actually does, said plainly
 * ---------------------------------------------------------------------------
 *
 * `PUBLISH_A_LISTING` and `TAKE_A_PAYMENT` both read `MISSING` on this Brain,
 * because no integration of either kind exists. So in practice every prepared
 * test today ends `BLOCKED` with `NO_CAPABILITY` and the integration named,
 * and that is reported as withheld rather than as done. A run that said it had
 * launched a test would be the one lie this kernel could tell that costs real
 * money.
 */
import { checkCommercialAuthority } from '../cash/authority.ts';
import { readCapability } from '../cash/capabilities.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { openTest, updateTest } from '../../repos/commerce.ts';
import type { Reading } from './reading.ts';
import type { CommerceTest } from '../../domain/types.ts';

const PREPARED = 'COMMERCE_TEST_PREPARED';

/**
 * The action a bounded sales test is, in the vocabulary that already exists.
 *
 * `RUN_PAID_TEST` is `COMMERCIAL_ACTIONS`' own entry for *spend on one bounded
 * test whose purpose is to produce evidence*, which is exactly this. Nothing
 * here adds a commercial action: a second vocabulary would be a second place a
 * grant is interpreted, and the narrower of the two would eventually be the
 * one nobody read.
 */
const ACTION = 'RUN_PAID_TEST';

/**
 * The capabilities a test cannot run without.
 *
 * Both, not either: listing without taking payment produces interest rather
 * than a sale, and the whole point of this step is to measure the thing the
 * estimates only predict. A test that measured interest would hand back an
 * `ATTENTION_EVIDENCE` reading dressed as a measurement, which is the exact
 * confusion the rest of this kernel is built to prevent.
 */
const NEEDED: readonly string[] = Object.freeze(['PUBLISH_A_LISTING', 'TAKE_A_PAYMENT']);

export const BLOCKERS = [
  /** The proposition itself is not ready; nothing about authority is at issue. */
  'NOT_READY',
  /** No standing commercial grant covers spending on a bounded test here. */
  'NO_COMMERCIAL_AUTHORITY',
  /** A grant exists and no capability can actually list or sell. */
  'NO_CAPABILITY',
  /** A person has not said how much may be spent. */
  'NO_CEILING',
] as const;
export type Blocker = (typeof BLOCKERS)[number];

export interface Prepared {
  test: CommerceTest | null;
  /** Null when everything Brain checks passed and a person may authorize. */
  blocker: Blocker | null;
  detail: string;
  /** What each gate answered, so a reader can see which one stopped it. */
  checked: { gate: string; answer: string }[];
}

/**
 * Work out how far a bounded test on this proposition can get, and record it.
 *
 * Idempotent by the partial unique index on a live test, so it is safe to run
 * on every tick: a blocked test whose blocker has not changed is the same row,
 * and the guarded `updateTest` is what moves it when something does. It never
 * spends, never lists, never contacts anybody and creates no commitment.
 */
export async function prepareTest(input: {
  projectId: string;
  reading: Reading;
  /**
   * What a person said may be spent. Absent means nobody has said, which is a
   * blocker rather than a default — Brain choosing a ceiling would be Brain
   * deciding what somebody's money is for.
   */
  ceilingMinor?: number | null;
  authorizedBy?: string | null;
  existing: CommerceTest | null;
}): Promise<Prepared> {
  const checked: Prepared['checked'] = [];
  const { reading } = input;

  /*
   * A settled or abandoned test is not re-prepared.
   *
   * Re-testing a question somebody already answered is a person's decision,
   * and doing it automatically would spend a second ceiling against evidence
   * that already exists.
   */
  if (input.existing && (input.existing.state === 'SETTLED' || input.existing.state === 'ABANDONED')) {
    return {
      test: input.existing,
      blocker: null,
      detail: 'A bounded test on this proposition has already run. Running another is a decision.',
      checked,
    };
  }

  const stopRule = stopRuleFor(reading);

  // Gate 0 — is there anything worth testing.
  const ready = readinessOf(reading);
  checked.push({ gate: 'the proposition itself', answer: ready ?? 'ready' });
  if (ready) {
    return settle({
      ...input,
      state: 'BLOCKED',
      blocker: 'NOT_READY',
      detail: ready,
      stopRule,
      checked,
    });
  }

  // Gate 1 — may this happen. Deny by default, and before anything else.
  const authority = await checkCommercialAuthority({ projectId: input.projectId, action: ACTION });
  checked.push({
    gate: 'the standing commercial grant',
    answer: authority.ok ? `authorizes ${ACTION}` : authority.reason,
  });
  if (!authority.ok) {
    return settle({
      ...input,
      state: 'BLOCKED',
      blocker: 'NO_COMMERCIAL_AUTHORITY',
      detail:
        `Spending on a bounded test is a commercial action, and no standing grant here ` +
        `authorizes ${ACTION}: ${authority.reason}. Granting one is a person's decision in ` +
        'Needs You, at ADMIN on this project.',
      stopRule,
      checked,
    });
  }

  // Gate 2 — could this happen.
  const missing: string[] = [];
  for (const capability of NEEDED) {
    const reading2 = await readCapability(capability);
    checked.push({ gate: capability, answer: reading2.state });
    if (reading2.state !== 'PRESENT') missing.push(capability);
  }
  if (missing.length > 0) {
    return settle({
      ...input,
      state: 'BLOCKED',
      blocker: 'NO_CAPABILITY',
      detail:
        `A grant authorizes the spending and Brain cannot perform it: ${missing.join(' and ')} ` +
        `read${missing.length === 1 ? 's' : ''} as not present, because no integration of that ` +
        'kind is connected to this Brain. Everything up to the moment of listing is prepared ' +
        'and recorded; what is missing is the connection, and it is named on the needs list.',
      stopRule,
      checked,
    });
  }

  // Gate 3 — how much. Never a figure Brain chose.
  const ceiling = input.ceilingMinor ?? null;
  checked.push({
    gate: 'the ceiling',
    answer: ceiling === null ? 'nobody has set one' : `${ceiling} minor units`,
  });
  if (ceiling === null || !input.authorizedBy) {
    return settle({
      ...input,
      state: 'BLOCKED',
      blocker: 'NO_CEILING',
      detail:
        'Everything else clears. What is missing is a person saying how much may be spent on ' +
        'this one test. Brain does not choose that figure, because choosing it would be Brain ' +
        "deciding what somebody's money is for.",
      stopRule,
      checked,
    });
  }

  return settle({
    ...input,
    state: 'AUTHORIZED',
    blocker: null,
    detail:
      `Authorized to spend up to ${ceiling} minor units against ${stopRule} The commitment is ` +
      'made when the spending starts, and nothing is released by a clock.',
    stopRule,
    ceilingMinor: ceiling,
    authorityId: authority.authority?.id ?? null,
    checked,
  });
}

/**
 * What the proposition itself is short of, or null when it is short of
 * nothing.
 *
 * Read from the same derivation the rest of the kernel uses rather than from a
 * second opinion about the same rows. A test is worth running when there is a
 * buyer, a supplier and a derivable margin: without the margin there is no
 * prediction for the test to check, and a test that measures against no
 * prediction produces a number rather than a finding.
 */
function readinessOf(reading: Reading): string | null {
  if (reading.proposition.retiredAt) return 'it is retired';
  if (reading.prohibited.length > 0) {
    return 'the channel publishes that this may not be sold there';
  }
  if (reading.purchases.length === 0) {
    return reading.attention.length > 0
      ? `nothing shows anybody bought it — ${reading.attention.length} reading` +
          `${reading.attention.length === 1 ? '' : 's'} show attention, which is not demand`
      : 'nothing shows anybody bought it';
  }
  if (!reading.proposition.supplier && !reading.supply.some((one) => one.kind === 'SUPPLIER_AVAILABLE')) {
    return 'nobody has established who would supply it';
  }
  const margin = reading.economics.contributionPerUnit;
  if (!margin.known) {
    return `the contribution cannot be derived: ${margin.missing.join(', ')} unknown`;
  }
  if (margin.minor <= 0) {
    return `the derived contribution is ${margin.minor} minor units, so there is nothing to test`;
  }
  return null;
}

/**
 * The stopping rule, stated before anything starts.
 *
 * Derived from the piece's own break-even rather than chosen, so it is a
 * sentence about this proposition instead of a policy. A test with no stopping
 * rule is spending with a story attached, which is why the column is NOT NULL.
 */
function stopRuleFor(reading: Reading): string {
  const margin = reading.economics.contributionPerUnit;
  if (!margin.known) {
    return 'the ceiling, whichever comes first — no break-even is derivable yet.';
  }
  return (
    `the ceiling, or an acquisition cost above ${margin.minor} minor units per order, which is ` +
    `the derived contribution and therefore the point at which each further sale loses money ` +
    `(a ${margin.basis.toLowerCase()} figure, which is what this test exists to replace).`
  );
}

async function settle(input: {
  projectId: string;
  reading: Reading;
  state: 'BLOCKED' | 'AUTHORIZED';
  blocker: Blocker | null;
  detail: string;
  stopRule: string;
  checked: Prepared['checked'];
  existing: CommerceTest | null;
  ceilingMinor?: number | null;
  authorityId?: string | null;
  authorizedBy?: string | null;
}): Promise<Prepared> {
  const propositionId = input.reading.proposition.id;

  if (input.existing) {
    /*
     * Move the live row rather than writing a second one, and only when
     * something has actually changed.
     *
     * A guarded `UPDATE` naming the state it moves from, so two ticks reading
     * one condition produce one move. Unchanged means unchanged: rewriting the
     * same blocker every ten seconds would fill the history with a condition
     * that never moved and bury the moment it did.
     */
    const same =
      input.existing.state === input.state &&
      input.existing.blockerKind === (input.blocker ?? null) &&
      input.existing.blockerDetail === (input.blocker ? input.detail : null);
    if (same) {
      return { test: input.existing, blocker: input.blocker, detail: input.detail, checked: input.checked };
    }
    const moved = await updateTest({
      id: input.existing.id,
      from: input.existing.state,
      to: input.state,
      blockerKind: input.blocker,
      blockerDetail: input.blocker ? input.detail : null,
      authorityId: input.authorityId ?? null,
      authorizedBy: input.authorizedBy ?? null,
    });
    if (!moved) {
      return { test: input.existing, blocker: input.blocker, detail: input.detail, checked: input.checked };
    }
    await note(input.projectId, propositionId, input.state, input.blocker, input.detail);
    return { test: input.existing, blocker: input.blocker, detail: input.detail, checked: input.checked };
  }

  /*
   * An AUTHORIZED row cannot be written without a grant and a person, because
   * the schema refuses it. That CHECK is the mechanism rather than this
   * function's discipline: a future caller that forgot to pass them would fail
   * the insert rather than silently create an authorized spend nobody made.
   */
  const opened = await openTest({
    projectId: input.projectId,
    propositionId,
    state: input.state,
    ceilingMinor: input.ceilingMinor ?? 0,
    authorityId: input.authorityId ?? null,
    blockerKind: input.blocker,
    blockerDetail: input.blocker ? input.detail : null,
    stopRule: input.stopRule,
    authorizedBy: input.authorizedBy ?? null,
  });
  if (opened.created) {
    await note(input.projectId, propositionId, input.state, input.blocker, input.detail);
  }
  return { test: opened.test, blocker: input.blocker, detail: input.detail, checked: input.checked };
}

async function note(
  projectId: string,
  propositionId: string,
  state: string,
  blocker: Blocker | null,
  detail: string,
): Promise<void> {
  const mode = await getCashMode(projectId);
  if (!mode) return;
  await recordCashEvent({
    projectId,
    kind: PREPARED,
    actorRef: 'BRAIN',
    summary:
      blocker === null
        ? 'A bounded sales test is authorized and within its ceiling.'
        : `A bounded sales test is prepared and blocked: ${blocker}.`,
    detail: { propositionId, state, blocker, why: detail },
  });
}
