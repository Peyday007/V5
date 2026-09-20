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

  const everyCandidate = await listCandidates({ sourceId: before.id });
  const unpromoted = everyCandidate.filter((one) => one.state !== 'PROMOTED');

  /*
   * A failed reading, or a partial one that left something a re-read could win.
   *
   * The first version accepted `FAILED` alone, and said of everything else that
   * "one that succeeded has nothing to answer". That is true of a source whose
   * every candidate was promoted and **false of a partial success**, which is
   * what production produced the first time the whole chain ran: eleven
   * definitions promoted, one refused by the audit, and three rejected at
   * validation — among them Research Intelligence, section 5.1, for a quote the
   * worker had not copied exactly. `settleAudit` writes `PROMOTED` whenever one
   * definition made it, so the door shut on the other four permanently. Nothing
   * dispatches a `PROMOTED` source, `registerSource` dedupes on the content hash
   * so the same bytes can never be registered again, and this refused it by
   * name.
   *
   * **A partially successful reading is not an answer for the parts it
   * failed**, and a state nothing can move is stuck rather than finished —
   * §24's sentence arriving inside the very transition written to answer it.
   *
   * It is still narrow. A `PROMOTED` source with nothing left unpromoted is
   * refused, because there is genuinely nothing to win and a re-read would
   * spend two activations restating what is already canonical. `REGISTERED` is
   * already waiting for the tick, and `EXTRACTING` and `AUDITING` hold a live
   * bin this would strand.
   *
   * Re-reading cannot lose a faculty. `promoteCandidate` updates the `faculties`
   * row it finds by slug rather than inserting a second one, and nothing here
   * deletes one — so a worse second reading leaves every canonical definition
   * exactly as it was, and a better one restates it. What moves is the candidate
   * row, which is what `putCandidate`'s upsert is for.
   */
  const partial = before.ingestState === 'PROMOTED' && unpromoted.length > 0;
  if (before.ingestState !== 'FAILED' && !partial) {
    return {
      reopened: false,
      source: before,
      preserved: 0,
      reason:
        `That source is ${before.ingestState}` +
        (before.ingestState === 'PROMOTED'
          ? ' and every candidate it produced was promoted, so there is nothing a second ' +
            'reading could win. Reopening would spend two activations restating what is ' +
            'already canonical.'
          : ', which is neither a failed reading nor a partial one. A source already waiting ' +
            'will be dispatched by the next tick, and one mid-read holds a live bin that this ' +
            'would strand.'),
    };
  }

  /*
   * The refusals, carried before the swap rather than after it.
   *
   * After the swap the tick may already have dispatched a new bin, and the
   * first submission overwrites these rows. This is the only moment they are
   * both complete and still the reading that failed.
   */
  const candidates = everyCandidate;
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
    `Reopened by ${person.email} via ${channel} from ${before.ingestState}: ${why} ` +
    `(previous reading: bin ${before.binId ?? 'none'}, ${refusals.length} candidate(s), ` +
    `${unpromoted.length} of them not promoted, ` +
    `detail: ${before.ingestDetail ?? 'none recorded'})`;

  const swapped = await advanceSource({
    id: before.id,
    from: before.ingestState,
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
        `Another reopening won: the source is ${now?.ingestState ?? 'gone'} rather than ` +
        `${before.ingestState}. The effect is present either way, so there is nothing left ` +
        'to do.',
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
      previousState: before.ingestState,
      previousBinId: before.binId,
      previousDetail: before.ingestDetail,
      unpromotedCandidates: unpromoted.length,
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

/**
 * Every source a second reading could still win something from.
 *
 * Failed ones, and **partially promoted ones**, because a reader who cannot
 * find the second kind cannot reopen it — and the refusal this function feeds
 * is the only place an operator learns the state exists at all. Listing only
 * `FAILED` would have left the production case invisible: a blueprint reading
 * `PROMOTED`, eleven faculties canonical, and four sections with no way back.
 *
 * `unpromoted` is the count that decides it, so the caller prints the reason
 * rather than inferring it from the state.
 */
export async function reopenableSources(): Promise<
  { source: CapabilitySource; unpromoted: number }[]
> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM capability_sources
      WHERE ingest_state IN ('FAILED', 'PROMOTED')
      ORDER BY updated_at DESC`,
    [] as never[],
  );
  const out: { source: CapabilitySource; unpromoted: number }[] = [];
  for (const row of rows) {
    const source = await getSource(String(row.id));
    if (!source) continue;
    const candidates = await listCandidates({ sourceId: source.id });
    const unpromoted = candidates.filter((one) => one.state !== 'PROMOTED').length;
    // A promoted source with nothing left is finished, not reopenable.
    if (source.ingestState === 'PROMOTED' && unpromoted === 0) continue;
    out.push({ source, unpromoted });
  }
  return out;
}
