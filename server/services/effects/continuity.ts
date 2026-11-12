/**
 * What Brain actually knows about each external effect it has attempted
 * (CONT-35, §20, §25, invariants 25-26).
 *
 * Continuity after a partial failure starts with an honest account: what was
 * attempted, what the outside world may have accepted, what is confirmed, and
 * what remains unknown. This module reads that account from the rows the
 * effects engine already writes — `idempotency_operations` and
 * `effect_attempts`, through `server/repos/idempotency.ts` — and adds no
 * table, store or scheduler. It writes nothing: reconciling, resuming and
 * resolving stay with `external.ts`, which owns those transitions.
 *
 * The classes, and the one rule beneath all of them — a timeout, a thrown
 * send or a missing answer is never evidence that an effect did not happen
 * (invariant 26), so none of them can make an entry FAILED:
 *
 * - ATTEMPTED_NOT_SENT: reserved, and no attempt ever reached SENT. Nothing
 *   left Brain, so a retry cannot duplicate anything.
 * - MAY_HAVE_BEEN_ACCEPTED: an attempt reached SENT and no definite outcome
 *   was recorded, while the operation is still RESERVED (its executor is
 *   working on it, or died and its recovery deadline has passed). The
 *   provider may have accepted it; only reconciliation can say. Also any
 *   still-reserved operation whose sent attempts all ended without a definite
 *   refusal on record (a confirmed attempt never settled, or a FAILED one with
 *   no failure category): something left Brain, so it is never "not sent".
 * - CONFIRMED: SUCCEEDED, with the provider's receipt.
 * - UNKNOWN: UNCERTAIN, with the reason recorded when it became so. Waits for
 *   reconciliation or a person; nothing automatic resends it.
 * - FAILED_RECOVERABLE: a definite, retryable refusal — the provider said it
 *   did nothing (for instance DEPENDENCY_UNAVAILABLE). The operation stays
 *   RESERVED and an equivalent request may run it again.
 * - FAILED_EXTERNAL_CONSTRAINT: terminal. The refusal is final for this
 *   effect, and no retry under this key may bypass it.
 */
import { closeDatabase, initDatabase } from '../../db/database.ts';
import { getOperation, listAttempts, listOperations, operationNow } from '../../repos/idempotency.ts';
import type { EffectAttempt, EffectFailureCategory, IdempotencyOperation, OperationState } from '../../domain/types.ts';

export const CONTINUITY_CLASSES = [
  'ATTEMPTED_NOT_SENT',
  'MAY_HAVE_BEEN_ACCEPTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED_RECOVERABLE',
  'FAILED_EXTERNAL_CONSTRAINT',
] as const;
export type ContinuityClass = (typeof CONTINUITY_CLASSES)[number];

export interface ContinuityEntry {
  operationId: string;
  namespace: string;
  correlationId: string | null;
  state: OperationState;
  class: ContinuityClass;
  /** Why the entry is in its class, in words a person can act on. */
  reason: string;
  /** The provider's receipt, for a confirmed effect. */
  receiptRef: string | null;
  failureCategory: EffectFailureCategory | null;
  attempts: number;
  /** Attempts that reached SENT or later: something left Brain on each. */
  sentAttempts: number;
  /**
   * Whether an executor's lease on a still-reserved operation has run out —
   * `EXPIRED` means nobody is working on it and recovery may take it over.
   * Null once the operation has left RESERVED.
   */
  executorLease: 'LIVE' | 'EXPIRED' | null;
  /**
   * Whether sending again could not duplicate an effect. False whenever the
   * outside world may have accepted it and the outcome is not settled, and
   * for anything already settled.
   */
  retrySafe: boolean;
  /** The outside world must be asked (or a person must establish the outcome) before anything else is done. */
  needsReconciliation: boolean;
  updatedAt: string;
}

export interface ContinuityAccount {
  projectId: string;
  at: string;
  entries: ContinuityEntry[];
  totals: Record<ContinuityClass, number>;
  /** Entries whose outcome is not settled and whose effect may exist outside Brain. */
  unsettled: number;
  /** True when the read hit its bound, so older operations are not in this account. */
  truncated: boolean;
}

const READ_LIMIT = 500;

/** An attempt that left Brain (SENT or later) without a definite outcome. */
function sentWithoutOutcome(attempt: EffectAttempt): boolean {
  if (attempt.phase === 'INTENT') return false;
  return attempt.outcome === null || attempt.outcome === 'UNCERTAIN';
}

/**
 * Classify one operation from its own row and its attempt rows. Pure, so
 * the account is exactly a function of what was recorded.
 */
export function classifyOperation(
  operation: IdempotencyOperation,
  attempts: readonly EffectAttempt[],
  now: string = operationNow(),
): Omit<ContinuityEntry, 'operationId' | 'namespace' | 'correlationId' | 'state' | 'failureCategory' | 'updatedAt'> {
  const sent = attempts.filter((a) => a.phase !== 'INTENT');
  const latest = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  const counts = { attempts: attempts.length, sentAttempts: sent.length };
  const settled = { executorLease: null, retrySafe: false, needsReconciliation: false } as const;

  switch (operation.state) {
    case 'SUCCEEDED': {
      const receipt = operation.resultRef ?? [...sent].reverse().find((a) => a.receiptRef)?.receiptRef ?? null;
      return {
        ...counts,
        ...settled,
        class: 'CONFIRMED',
        receiptRef: receipt,
        reason: receipt ? `confirmed by the provider (receipt ${receipt})` : 'recorded as succeeded, and no receipt was recorded with it',
      };
    }
    case 'UNCERTAIN':
      return {
        ...counts,
        class: 'UNKNOWN',
        receiptRef: null,
        executorLease: null,
        retrySafe: false,
        needsReconciliation: true,
        reason: `outcome unknown: ${operation.uncertaintyReason ?? 'no reason was recorded'}; it may have taken effect, so it is reconciled or decided by a person, never resent`,
      };
    case 'FAILED':
      return {
        ...counts,
        ...settled,
        class: 'FAILED_EXTERNAL_CONSTRAINT',
        receiptRef: null,
        reason: `refused for good${operation.failureCategory ? ` (${operation.failureCategory})` : ''}${operation.resultSummary ? `: ${operation.resultSummary}` : ''}; no retry under this key may bypass it`,
      };
    case 'RESERVED': {
      const lease: 'LIVE' | 'EXPIRED' = operation.recoverAfter !== null && operation.recoverAfter > now ? 'LIVE' : 'EXPIRED';
      const pending = sent.filter(sentWithoutOutcome);
      if (pending.length > 0) {
        const last = pending[pending.length - 1]!;
        return {
          ...counts,
          class: 'MAY_HAVE_BEEN_ACCEPTED',
          receiptRef: null,
          executorLease: lease,
          retrySafe: false,
          needsReconciliation: true,
          reason:
            lease === 'LIVE'
              ? `attempt ${last.attemptNumber} was sent and has no answer yet; its executor still holds it`
              : `attempt ${last.attemptNumber} was sent and no outcome was recorded before its executor stopped; the provider may have accepted it`,
        };
      }
      // Every sent attempt ended definitively. A retryable refusal leaves the
      // operation reserved with its category, and the provider said it did nothing.
      if (operation.failureCategory !== null && latest?.outcome === 'FAILED') {
        return {
          ...counts,
          class: 'FAILED_RECOVERABLE',
          receiptRef: null,
          executorLease: lease,
          retrySafe: true,
          needsReconciliation: false,
          reason: `refused, retryably (${operation.failureCategory})${latest.detail ? `: ${latest.detail}` : ''}; the provider did nothing, so an equivalent request may run it again`,
        };
      }
      if (sent.length === 0) {
        return {
          ...counts,
          class: 'ATTEMPTED_NOT_SENT',
          receiptRef: null,
          executorLease: lease,
          retrySafe: true,
          needsReconciliation: false,
          reason: attempts.length === 0 ? 'reserved, and no attempt was started' : 'an attempt was started and nothing was sent',
        };
      }
      // Something left Brain, every sent attempt ended, and no definite refusal is on record:
      // either an attempt was confirmed and the operation was never settled, or it ended
      // FAILED without the category that says the provider did nothing. Neither is "not
      // sent"; the outside world may hold the effect, so it is reconciled, never resent.
      const confirmedAttempt = [...sent].reverse().find((a) => a.outcome === 'SUCCEEDED') ?? null;
      return {
        ...counts,
        class: 'MAY_HAVE_BEEN_ACCEPTED',
        receiptRef: confirmedAttempt?.receiptRef ?? null,
        executorLease: lease,
        retrySafe: false,
        needsReconciliation: true,
        reason: confirmedAttempt
          ? `attempt ${confirmedAttempt.attemptNumber} was confirmed${confirmedAttempt.receiptRef ? ` (receipt ${confirmedAttempt.receiptRef})` : ''} but the operation was never settled; it is reconciled, never resent`
          : `${sent.length} attempt(s) were sent and ended without a definite refusal on record; the provider may have accepted one, so it is reconciled, never resent`,
      };
    }
  }
}

/**
 * The continuity account of one project's external effects: every operation
 * in its class, the totals, and how many are unsettled. Read-only.
 */
export async function effectContinuityAccount(projectId: string): Promise<ContinuityAccount> {
  const now = operationNow();
  const operations = await listOperations(projectId, { limit: READ_LIMIT });
  const entries: ContinuityEntry[] = [];
  for (const operation of operations) {
    const attempts = await listAttempts(operation.id);
    entries.push({
      operationId: operation.id,
      namespace: operation.namespace,
      correlationId: operation.correlationId,
      state: operation.state,
      failureCategory: operation.failureCategory,
      updatedAt: operation.updatedAt,
      ...classifyOperation(operation, attempts, now),
    });
  }
  const totals = Object.fromEntries(CONTINUITY_CLASSES.map((c) => [c, 0])) as Record<ContinuityClass, number>;
  for (const entry of entries) totals[entry.class] += 1;
  return {
    projectId,
    at: now,
    entries,
    totals,
    unsettled: totals.MAY_HAVE_BEEN_ACCEPTED + totals.UNKNOWN,
    truncated: operations.length >= READ_LIMIT,
  };
}

/**
 * What a caller who retried an operation is told about it.
 *
 * The account is only worth keeping if it reaches the moment somebody would
 * act on a wrong belief — sending again. `runIdempotentRequest` (and so every
 * idempotent route) attaches this to its refusal when an earlier attempt is
 * unknown, still running or settled as failed, so the caller learns what Brain
 * knows and what remains uncertain instead of guessing.
 *
 * A caller-safe projection (invariant 30): the class, the class's own
 * sentence, and the counts. Never a receipt, a provider's words, a result
 * summary or a correlation id — those stay in the rows and in the project
 * account, which is read under the project's own authorization.
 */
export interface ContinuityReport {
  class: ContinuityClass;
  /** What Brain has established about the effect. */
  known: string;
  /** What remains uncertain, or null when nothing does. */
  uncertain: string | null;
  attempts: number;
  sentAttempts: number;
  executorLease: 'LIVE' | 'EXPIRED' | null;
  retrySafe: boolean;
  needsReconciliation: boolean;
}

const REPORT_WORDS: Record<ContinuityClass, { known: string; uncertain: string | null }> = {
  ATTEMPTED_NOT_SENT: { known: 'The operation was reserved and nothing was sent to the outside world.', uncertain: null },
  MAY_HAVE_BEEN_ACCEPTED: {
    known: 'At least one attempt was sent to the outside world.',
    uncertain: 'Whether the outside world accepted it is not yet established; it is reconciled before anything is sent again.',
  },
  CONFIRMED: { known: 'The effect is confirmed.', uncertain: null },
  UNKNOWN: {
    known: 'An attempt was made and its outcome was not established.',
    uncertain: 'It may have taken effect. It is reconciled with the outside world or decided by a person, and never resent automatically.',
  },
  FAILED_RECOVERABLE: { known: 'The outside world refused it retryably and did nothing.', uncertain: null },
  FAILED_EXTERNAL_CONSTRAINT: { known: 'It was refused for good; no retry under this key may bypass the refusal.', uncertain: null },
};

/** The caller-safe projection of one classified operation. */
export function continuityReport(entry: Pick<ContinuityEntry, 'class' | 'attempts' | 'sentAttempts' | 'executorLease' | 'retrySafe' | 'needsReconciliation'>): ContinuityReport {
  const words = REPORT_WORDS[entry.class];
  return {
    class: entry.class,
    known: words.known,
    uncertain: words.uncertain,
    attempts: entry.attempts,
    sentAttempts: entry.sentAttempts,
    executorLease: entry.executorLease,
    retrySafe: entry.retrySafe,
    needsReconciliation: entry.needsReconciliation,
  };
}

/**
 * The continuity report of one operation, read from its current rows. Null
 * when the operation is gone. Read-only.
 */
export async function operationContinuity(operationId: string): Promise<ContinuityReport | null> {
  const operation = await getOperation(operationId);
  if (!operation) return null;
  const attempts = await listAttempts(operation.id);
  return continuityReport(classifyOperation(operation, attempts));
}

/* ------------------------------------------------------------------------- */
/* Where a person reads the account                                           */
/* ------------------------------------------------------------------------- */

/**
 * The terminal where an operator reads a project's continuity account before
 * reconciling or resolving anything (S-0486: report accurately what is known
 * and what remains uncertain).
 *
 *   npx tsx server/services/effects/continuity.ts account --project prj_…  [--all] [--json]
 *
 * Invariant 35: an operator's part has no administration page; it is a
 * terminal, and reaching the shell is the authentication. This is the account
 * the RECONCILIATION_REQUIRED refusal in `http.ts` points to. It reads only;
 * resolving stays with `external.ts`. By default it lists the entries a person
 * must act on (unsettled, or retry-safe but not yet retried) with every total;
 * `--all` lists every entry. A receipt is printed for a confirmed effect only
 * under `--all`, and never a payload, a credential or a provider's raw answer:
 * the entry carries none.
 */
export const CONTINUITY_CLI = 'npx tsx server/services/effects/continuity.ts account --project <id>';

/** Entries a person must act on: an effect that may exist outside Brain, or one that may safely run again. */
export function needsAttention(entry: Pick<ContinuityEntry, 'class'>): boolean {
  return entry.class === 'MAY_HAVE_BEEN_ACCEPTED' || entry.class === 'UNKNOWN' || entry.class === 'ATTEMPTED_NOT_SENT' || entry.class === 'FAILED_RECOVERABLE';
}

/** The account in words: totals first, then what is known and what remains uncertain for each listed entry. */
export function describeContinuityAccount(account: ContinuityAccount, options: { all?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`${account.projectId}: ${account.entries.length} external operation(s) at ${account.at}${account.truncated ? ` (the newest ${account.entries.length} only; older operations are not in this account)` : ''}`);
  lines.push(`  ${CONTINUITY_CLASSES.map((c) => `${c} ${account.totals[c]}`).join('  ')}`);
  lines.push(
    account.unsettled > 0
      ? `  ${account.unsettled} unsettled: the outside world may hold these effects; reconcile each before anything is sent again.`
      : '  Nothing unsettled: no effect is in doubt.',
  );
  const listed = options.all ? account.entries : account.entries.filter(needsAttention);
  for (const entry of listed) {
    const words = REPORT_WORDS[entry.class];
    lines.push(`- ${entry.operationId}  ${entry.namespace}  ${entry.state} → ${entry.class}  (${entry.sentAttempts}/${entry.attempts} attempt(s) sent, updated ${entry.updatedAt})`);
    lines.push(`    known: ${words.known}`);
    if (words.uncertain) lines.push(`    uncertain: ${words.uncertain}`);
    lines.push(`    why: ${entry.reason}`);
    lines.push(`    next: ${entry.needsReconciliation ? 'reconcile with the outside world, or have a person establish the outcome; never resend' : entry.retrySafe ? 'an equivalent request may run it again; nothing can be duplicated' : 'nothing; it is settled'}`);
    if (options.all && entry.receiptRef) lines.push(`    receipt: ${entry.receiptRef}`);
  }
  if (!options.all && listed.length === 0 && account.entries.length > 0) lines.push('  No entry needs a person. --all lists every entry.');
  return lines.join('\n');
}

export interface ContinuityCliDeps {
  account?: typeof effectContinuityAccount;
}

const CONTINUITY_USAGE =
  'usage: continuity.ts account --project ID [--all] [--json]\n' +
  '       continuity.ts posture --project ID\n' +
  '       continuity.ts snapshot --project ID\n' +
  '       continuity.ts verify-restore --file PATH [--project ID]\n' +
  '       continuity.ts drill --project ID\n' +
  '       continuity.ts continuation --project ID --namespace NS [--channel C] [--deadline ISO]';

function cliFlag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : argv[at + 1];
  return value && !value.startsWith('--') ? value : null;
}

/** Run one command. Returns the exit code and the text to print; never throws for a usage error. */
export async function runContinuityCommand(argv: readonly string[], deps: ContinuityCliDeps = {}): Promise<{ code: number; out: string }> {
  const [command] = argv;
  const projectId = cliFlag(argv, 'project')?.trim() ?? '';
  if (command === 'continuation') {
    // S-0485 for one commitment: the decision the send path applies, read from the same rows.
    const namespace = cliFlag(argv, 'namespace')?.trim() ?? '';
    if (!projectId || !namespace) return { code: 2, out: CONTINUITY_USAGE };
    const posture = await import('./posture.ts');
    const decision = await posture.decideCommitmentContinuation({
      projectId,
      namespace,
      channel: cliFlag(argv, 'channel'),
      otherAttempt: () => true,
      deadline: cliFlag(argv, 'deadline'),
    });
    return { code: 0, out: JSON.stringify(decision, null, 2) };
  }
  if (command === 'posture' || command === 'snapshot' || command === 'verify-restore' || command === 'drill') {
    // S-0485: the degraded posture and the verified restore of this ledger live in posture.ts.
    const posture = await import('./posture.ts');
    if (command === 'verify-restore') {
      const file = cliFlag(argv, 'file');
      if (!file) return { code: 2, out: CONTINUITY_USAGE };
      const { readFileSync } = await import('node:fs');
      const live = projectId ? await listOperations(projectId, { limit: READ_LIMIT }) : undefined;
      const result = posture.verifyContinuityRestore(readFileSync(file, 'utf8'), live);
      return { code: result.verified ? 0 : 1, out: JSON.stringify(result, null, 2) };
    }
    if (!projectId) return { code: 2, out: CONTINUITY_USAGE };
    if (command === 'posture') return { code: 0, out: JSON.stringify(await posture.continuityPosture(projectId), null, 2) };
    if (command === 'snapshot') return { code: 0, out: JSON.stringify(await posture.continuitySnapshot(projectId)) };
    const drill = await posture.runRestoreDrill(projectId);
    return { code: drill.verified ? 0 : 1, out: JSON.stringify(drill, null, 2) };
  }
  if (command !== 'account' || !projectId) return { code: 2, out: CONTINUITY_USAGE };
  const account = await (deps.account ?? effectContinuityAccount)(projectId);
  if (argv.includes('--json')) return { code: 0, out: JSON.stringify(account, null, 2) };
  return { code: 0, out: describeContinuityAccount(account, { all: argv.includes('--all') }) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  void (async () => {
    await initDatabase();
    try {
      const { code, out } = await runContinuityCommand(process.argv.slice(2));
      (code === 0 ? console.log : console.error)(out);
      process.exitCode = code;
    } finally {
      await closeDatabase();
    }
  })();
}
