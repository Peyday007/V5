/**
 * The answering transition for a source whose reading failed.
 *
 * `FAILED` was terminal and nothing could leave it. That is fine while the only
 * way to reach it is a worker that genuinely could not read the document — and
 * it is not fine at all when Brain's own extraction contract is what refused
 * the reading, which is exactly what happened on the first real production run:
 * the manifest told the worker a connection carries `kind`, `faculty` and an
 * optional `note`, `validateConnections` accepts none of those three, and all
 * fifteen candidates were rejected for obeying the instruction they were given.
 * The blueprint went to `FAILED`, correctly, and then there was no way back —
 * not by re-registering, because `registerSource` dedupes on the content hash
 * and answers `created: false` for the same bytes, and not by waiting, because
 * `advanceSources` only dispatches a `REGISTERED` source.
 *
 * So this is §24's sentence at a new altitude, and in its worst form: a state
 * that says a person must act, which no action that person could take would
 * answer. **Every escalation must have an answering transition, and that
 * transition must be guarded rather than absent.**
 *
 * Four properties are what make it a remedy rather than a way around the gate.
 *
 * It **destroys nothing**. The document keeps its bytes and its hash, the
 * source keeps its id, version and lineage, the spent bin keeps its row and its
 * attempts, and every candidate keeps its own row. What moves is one column.
 *
 * It **preserves the refusals it is reopening**, in an append-only event,
 * *before* the swap. `putCandidate` is an upsert on `(source_id, slug)` — which
 * is right, because re-submitting after a correction is the common case — so a
 * second reading overwrites the first one's `rejection_reason` in place. Left
 * alone, fixing the contract would erase the evidence that the contract was
 * ever wrong. That is the one thing this repository refuses more consistently
 * than any other.
 *
 * It is a **compare-and-swap naming the state it came from**, so two ticks, two
 * administrators or a retry after a lost response produce one reopening. The
 * loser is an ordinary outcome, and the call still reports the effect is
 * present — idempotency means the effect is there after either call, not that
 * the second call does nothing.
 *
 * And it **grants nothing**. It does not promote a faculty, move a dimension,
 * widen a contract, or decide that the refused candidates were right. It buys
 * one more reading, which the same validator then judges on the same terms.
 */
import { getDb } from '../../db/database.ts';
import {
  advanceSource,
  getSource,
  listCandidates,
  type CapabilitySource,
} from '../../repos/faculties.ts';
import { recordEvent } from '../../repos/events.ts';
import { getUserByEmail } from '../../repos/identity.ts';

/** How the call reached Brain. Brain cannot check one, so it defaults weaker. */
export type ReopenChannel = 'SHELL' | 'BROWSER';

export interface ReopenRequest {
  sourceId: string;
  /** Why it is being read again. Stored verbatim; never composed by Brain. */
  reason: string;
  /** Resolved against `users`. Attribution, not authentication. */
  requestedByEmail: string;
  channel?: ReopenChannel;
}

export interface ReopenOutcome {
  reopened: boolean;
  source: CapabilitySource | null;
  /** How many candidate refusals were carried onto the project's history. */
  preserved: number;
  reason: string;
}

export async function reopenFailedSource(input: ReopenRequest): Promise<ReopenOutcome> {
  const why = input.reason.trim();
  if (why.length === 0) {
    throw new Error(
      'A reopening must say why. A source read twice with no reason recorded is a second ' +
        'activation nobody can account for a month later.',
    );
  }

  /*
   * An enabled Brain administrator, resolved against `users`.
   *
   * The same level and the same argument as `answerAuthorityGap`: reopening
   * spends a real fire against a real subscription, so it is a decision rather
   * than a read. Resolving the row establishes that such a person exists and
   * may authorize this, and nothing at all about who typed the command — which
   * is what `channel` is for, and why it defaults to the weaker value Brain
   * cannot verify.
   */
  const person = await getUserByEmail(input.requestedByEmail);
  if (!person || person.disabled || !person.isBrainAdmin) {
    throw new Error(
      'That email resolves to no enabled administrator of this Brain. Reopening a source ' +
        'spends an activation, so the somebody who asked for it has to be a row here rather ' +
        'than a name on a command line.',
    );
  }

  const before = await getSource(input.sourceId);
  if (!before) {
    return {
      reopened: false,
      source: null,
      preserved: 0,
      reason: `No capability source with id ${input.sourceId}.`,
    };
  }

  /*
   * Only a failed source. Named rather than reported as the nearest available
   * refusal, because the three other states send an operator three different
   * ways: `REGISTERED` is already waiting for the tick, `EXTRACTING` and
   * `AUDITING` have a live bin that reopening would strand, and `READY` has
   * nothing wrong with it.
   */
  if (before.ingestState !== 'FAILED') {
    return {
      reopened: false,
      source: before,
      preserved: 0,
      reason:
        `That source is ${before.ingestState}, not FAILED. This puts a failed reading back to ` +
        'be read again and refuses everything else: a source already waiting will be dispatched ' +
        'by the next tick, one mid-read holds a live bin that this would strand, and one that ' +
        'succeeded has nothing to answer.',
    };
  }

  /*
   * The refusals, carried before the swap rather than after it.
   *
   * After the swap the tick may already have dispatched a new bin, and the
   * first submission overwrites these rows. This is the only moment they are
   * both complete and still the reading that failed.
   */
  const candidates = await listCandidates({ sourceId: before.id });
  const refusals = candidates.map((candidate) => ({
    candidateId: candidate.id,
    slug: candidate.slug,
    canonicalName: candidate.canonicalName,
    state: candidate.state,
    binId: candidate.binId,
    rejectionReason: candidate.rejectionReason,
  }));

  const channel: ReopenChannel = input.channel ?? 'SHELL';
  const detail =
    `Reopened by ${person.email} via ${channel}: ${why} ` +
    `(previous reading: bin ${before.binId ?? 'none'}, ${refusals.length} candidate(s), ` +
    `detail: ${before.ingestDetail ?? 'none recorded'})`;

  const swapped = await advanceSource({
    id: before.id,
    from: 'FAILED',
    to: 'REGISTERED',
    detail,
  });

  if (!swapped) {
    const now = await getSource(before.id);
    return {
      reopened: false,
      source: now,
      preserved: 0,
      reason:
        `Another reopening won: the source is ${now?.ingestState ?? 'gone'} rather than FAILED. ` +
        'The effect is present either way, so there is nothing left to do.',
    };
  }

  await recordEvent({
    projectId: before.projectId,
    layerId: null,
    entityType: 'DOCUMENT',
    entityId: before.documentId,
    eventType: 'CAPABILITY_SOURCE_REOPENED',
    payload: {
      sourceId: before.id,
      kind: before.kind,
      version: before.version,
      contentHash: before.contentHash,
      previousBinId: before.binId,
      previousDetail: before.ingestDetail,
      requestedById: person.id,
      requestedByEmail: person.email,
      authorityChannel: channel,
      reason: why,
      refusals,
    },
  });

  const after = await getSource(before.id);
  return {
    reopened: true,
    source: after,
    preserved: refusals.length,
    reason:
      `Put back to REGISTERED. ${refusals.length} candidate refusal(s) are on the project's ` +
      'history, because the next reading overwrites them in place. The tick dispatches a new ' +
      'extraction bin; nothing about the document, the source lineage or the spent bin moved.',
  };
}

/** Every failed source, for an operator deciding whether to reopen one. */
export async function failedSources(): Promise<CapabilitySource[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM capability_sources WHERE ingest_state = 'FAILED' ORDER BY updated_at DESC`,
    [] as never[],
  );
  const out: CapabilitySource[] = [];
  for (const row of rows) {
    const source = await getSource(String(row.id));
    if (source) out.push(source);
  }
  return out;
}
