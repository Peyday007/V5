/**
 * Offering a source again after Brain's own contract refused every reading.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * `advanceSources` walks `REGISTERED → EXTRACTING → PROPOSED → AUDITING` and
 * never looks at `FAILED`, `registerSource` is idempotent by
 * `(content_hash, kind)` so re-registering the same bytes returns the failed
 * row unchanged, and `recoverExtraction` only puts back an assignment whose bin
 * has vanished. So a source that reached `FAILED` had **no way back at all**.
 *
 * That was tolerable while `FAILED` meant *the document is not evidence*. It
 * stopped being tolerable the moment a source failed for a defect in Brain:
 * the extraction bin's manifest named three connection fields
 * `CONNECTION_KEYS` has never held, a fired Cowork session followed it exactly,
 * and all fifteen definitions were refused whole. The blueprint was fine, the
 * worker was fine, the validator was fine — and the source was terminal. **A
 * state that says "this cannot proceed" which nobody can resolve is not a
 * verdict; it is stuck**, which is §24's sentence arriving at the one state
 * Brain's own wrong instruction puts a source into.
 *
 * ---------------------------------------------------------------------------
 * What makes it a recovery rather than a way around the gate
 * ---------------------------------------------------------------------------
 *
 * **It refuses the failure it is not for, by name.** `surfaceRecovery` is the
 * precedent: a fragment blocked by the surface may be recovered and one blocked
 * by its own evidence may not, and the refusal says which. Here the division is
 * the same — a source whose *extraction run* is not readable failed because of
 * the bytes, and re-offering it would hand out a bin, spend a fire and fail
 * again on the next tick, for ever. Only a source Brain can actually read is
 * offered again.
 *
 * **It is a person's reading, on a terminal.** Deciding that Brain's own
 * contract was the defect is not something Brain can derive: it cannot tell a
 * manifest it has since corrected from one it has not. Deriving it from the
 * running revision was the tempting alternative and is refused — a document
 * that is genuinely unreadable by this kernel would then be re-offered on every
 * deploy, spending an activation each time to rediscover the same refusal.
 * Reaching the shell is the authentication (§26) and `--admin` is the
 * attribution, resolved against `users` rather than trusted.
 *
 * **It destroys nothing.** Every rejected candidate keeps its row and its
 * reason, the spent bin keeps its row and its attempts, and the document keeps
 * its bytes and its hash. A re-read *replaces* a candidate per
 * `(source_id, slug)`, which `putCandidate` already does because re-submitting
 * after a correction is the common case — so the corrected reading lands over
 * the refused one and the refusal stays readable until it does.
 *
 * **It is one guarded statement.** `FAILED` is a condition of the `UPDATE`, so
 * two callers produce one re-offer and the loser is an ordinary outcome.
 */
import { getUserByEmail, recordIdentityEvent } from '../../repos/identity.ts';
import { advanceSource, getSource } from '../../repos/faculties.ts';
import { getCurrentExtractionRun } from '../../repos/extraction.ts';
import type { CapabilitySource } from '../../repos/faculties.ts';

/** How the call reached Brain. Never inferred from the call itself. */
export type ReofferChannel = 'SHELL' | 'BROWSER';

export interface ReofferOutcome {
  reoffered: boolean;
  source: CapabilitySource | null;
  reason: string;
}

export async function reofferSource(input: {
  sourceId: string;
  /** The person's own words about why this failure was Brain's. Stored verbatim. */
  reason: string;
  /** Resolved against `users`; this is attribution, not authentication. */
  requestedByEmail: string;
  /** Defaults to the weaker value, because Brain cannot check a channel. */
  channel?: ReofferChannel;
  /** Whatever the caller claimed about itself, read back as reported. */
  executedByRef?: string | null;
}): Promise<ReofferOutcome> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error(
      'A re-offer must say why this failure was Brain’s rather than the document’s. One with no ' +
        'reason records that somebody pressed something, which answers nothing a year later.',
    );
  }

  const person = await getUserByEmail(input.requestedByEmail);
  if (!person || person.disabled || !person.isBrainAdmin) {
    throw new Error(
      'That email resolves to no enabled administrator of this Brain. Re-offering a source ' +
        'spends a fire and asks a worker to read a document again, so the somebody has to be a ' +
        'row here rather than a name on a command line.',
    );
  }

  const source = await getSource(input.sourceId);
  if (!source) {
    return { reoffered: false, source: null, reason: `No source with id ${input.sourceId}.` };
  }
  if (source.ingestState !== 'FAILED') {
    return {
      reoffered: false,
      source,
      reason:
        `That source is ${source.ingestState}, not FAILED. This offers again a source whose ` +
        'reading Brain itself refused; anything else is already on its way through.',
    };
  }

  /*
   * The division `surfaceRecovery` draws, at a document.
   *
   * A source whose extraction never reached a usable state failed because of
   * its own bytes, and no correction to a manifest changes that. Re-offering it
   * would create a bin, spend an activation and fail identically on the next
   * tick — a loop that looks like progress.
   */
  const run = await getCurrentExtractionRun(source.documentId);
  const readable = run?.status === 'READY' || run?.status === 'READY_WITH_WARNINGS';
  if (!readable) {
    return {
      reoffered: false,
      source,
      reason:
        `That source's extraction is ${run?.status ?? 'missing'}, so it is not evidence and no ` +
        'reading of it could have succeeded. This recovery is for a failure in Brain’s own ' +
        'contract; a document Brain cannot read is a different condition with a different ' +
        'remedy — reprocess or replace it.',
    };
  }

  const moved = await advanceSource({
    id: source.id,
    from: 'FAILED',
    to: 'REGISTERED',
    detail: `Offered again by ${person.email} via ${input.channel ?? 'SHELL'}: ${reason}`,
  });
  const after = await getSource(source.id);
  if (!moved) {
    return {
      reoffered: false,
      source: after,
      reason: `That source is already ${after?.ingestState ?? 'gone'}; somebody offered it first.`,
    };
  }

  /*
   * Append-only, with no foreign key, for `identity_events`' own reason: an
   * audit row a cascade can delete is not an audit row.
   */
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: person.id,
    action: 'CAPABILITY_SOURCE_REOFFERED',
    targetType: 'CAPABILITY_SOURCE',
    targetId: source.id,
    projectId: source.projectId,
    result: 'SUCCESS',
    metadata: {
      reason,
      previousBinId: source.binId,
      previousDetail: source.ingestDetail,
      authorityChannel: input.channel ?? 'SHELL',
      executedByRef: input.executedByRef ?? null,
    },
  });

  return {
    reoffered: true,
    source: after,
    reason:
      `Offered again. The next tick dispatches a new extraction bin; every refused candidate ` +
      'keeps its row and its reason until a corrected reading replaces it.',
  };
}
