/**
 * Answering a gap that is waiting on a person.
 *
 * `REQUIRES_PERSON_AUTHORITY` is the one gap kind no amount of building
 * closes: the requirement names permission, authority, approval, consent, a
 * credential or spending, and `gaps.ts` routes it to a person *whatever*
 * machinery matched it. `readiness` then refuses the packet while any such gap
 * is open, which is correct — and for as long as this module did not exist it
 * was also the defect this repository keeps having to correct, because
 * `judgeGap` and `setGapState` were reachable from tests and from nothing else.
 *
 * **A state that says "waiting for a person" which that person cannot resolve
 * is not waiting; it is stuck.** §24 writes that sentence at four altitudes and
 * §27 at a fifth. This is the sixth, and it landed on the one decision the
 * whole packet stops at — so the escalation now has its answering transition,
 * and the transition is guarded rather than absent.
 *
 * Four properties are what make it an answer rather than a way around the gate.
 *
 * **It answers only a gap that is actually waiting on a person.** A command
 * that could reclassify any gap would let whoever reaches it turn a
 * `MUST_BE_RESEARCHED` into `EXISTS_AND_LIVE` and skip the research — model
 * prose as state, one door along, with a person's name on it. The guard is on
 * the kind *in the statement that makes the change*, so a gap reclassified
 * between the read and the write is not answered by this call.
 *
 * **It cannot invent the authority.** What it records is that somebody with
 * standing said yes or no; it grants nothing, widens no envelope, writes no
 * membership and touches no credential. The authorizations this Brain actually
 * enforces — `approvalEnvelope`, `checkAuthority`, `decideProjectAccess`,
 * `decideRepository` — are untouched and still decide every effect downstream.
 * Answering a gap makes a packet *compilable*; approving the objective and
 * approving the release stay person-only decisions on the Build surface.
 *
 * **The answer is attributed, and attribution is not authentication.** §23 drew
 * that column pair for exactly this shape: `answered_by_id` is whose authority
 * it carries, resolved against `users` rather than trusted, and the channel is
 * whatever got the call in. Reaching the shell is what authenticated it, so the
 * channel defaults to the weaker, unverifiable value — unknown lineage failing
 * closed, at a column.
 *
 * **Nothing is destroyed.** The gap keeps its row, its aspect, its requirement
 * and its evidence; what moves is its state and the sentence saying why. A
 * refusal is `WAIVED` with the refusal recorded, which is a different fact from
 * a grant and must never read the same — the packet then correctly stays short
 * of whatever that requirement was load-bearing for.
 */
import { getDb } from '../../db/database.ts';
import { nowIso } from '../../repos/util.ts';
import { getUserByEmail, recordIdentityEvent } from '../../repos/identity.ts';
import type { PacketGap } from './packet.ts';
import { listGaps } from './packet.ts';

/** How the call reached Brain. Never inferred from the call itself. */
export type AuthorityChannel = 'SHELL' | 'BROWSER';

export interface AuthorityAnswer {
  gapId: string;
  /** GRANTED closes the gap; REFUSED waives it and says so. */
  answer: 'GRANTED' | 'REFUSED';
  /** The person's own words. Stored verbatim; never composed by Brain. */
  statement: string;
  /** Resolved against `users`; this is attribution, not authentication. */
  answeredByEmail: string;
  /** Defaults to the weaker value, because Brain cannot check a channel. */
  channel?: AuthorityChannel;
  /** Whatever the caller claimed about itself, read back as reported. */
  executedByRef?: string | null;
}

export interface AuthorityOutcome {
  answered: boolean;
  gap: PacketGap | null;
  reason: string;
}

/**
 * Record a person's answer to one gap.
 *
 * Idempotent by effect rather than by a flag: a gap already closed is no longer
 * `REQUIRES_PERSON_AUTHORITY` *and* no longer OPEN, so the guarded UPDATE
 * matches nothing and the call reports what the first one produced. §27's rule
 * — idempotency means the effect is present after either call, not that the
 * second call does nothing.
 */
export async function answerAuthorityGap(input: AuthorityAnswer): Promise<AuthorityOutcome> {
  const statement = input.statement.trim();
  if (statement.length === 0) {
    throw new Error(
      'An authority answer must say what was decided. A gap closed with no statement records ' +
        'that somebody pressed something, which answers nothing a year later.',
    );
  }

  /*
   * An enabled Brain administrator, resolved against `users`.
   *
   * The level is the one every other decision about what Brain may do already
   * carries — `decideProjectAccess` at ADMIN for a membership grant, a standing
   * authority, a connected site. Resolving it establishes that such a person
   * exists and may authorize this, and nothing whatever about who typed the
   * command; that is what `authorityChannel` is for, and why it defaults to the
   * weaker, unverifiable value.
   */
  const person = await getUserByEmail(input.answeredByEmail);
  if (!person || person.disabled || !person.isBrainAdmin) {
    throw new Error(
      'That email resolves to no enabled administrator of this Brain. The answer carries ' +
        'somebody\u2019s authority over what Brain may do, so the somebody has to be a row here ' +
        'rather than a name on a command line.',
    );
  }

  const rows = await getDb().all<{ id: string; packet_id: string; state: string; kind: string }>(
    `SELECT id, packet_id, state, kind FROM realization_gaps WHERE id = ?`,
    [input.gapId] as never[],
  );
  const existing = rows[0];
  if (!existing) {
    return { answered: false, gap: null, reason: `No gap with id ${input.gapId}.` };
  }

  const channel: AuthorityChannel = input.channel ?? 'SHELL';
  const state = input.answer === 'GRANTED' ? 'CLOSED' : 'WAIVED';
  const reason =
    input.answer === 'GRANTED'
      ? `Authorized by ${person.email} via ${channel}: ${statement}`
      : `Refused by ${person.email} via ${channel}: ${statement}`;

  /*
   * The guard carries the whole proof, in one statement. `kind` is the
   * condition that matters: this may only ever answer a gap that is waiting on
   * a person, so a gap something else reclassified in the meantime matches
   * nothing rather than being answered against a question it no longer asks.
   */
  const result = await getDb().run(
    `UPDATE realization_gaps
        SET state = ?, state_reason = ?, derived_by = 'PERSON', updated_at = ?
      WHERE id = ? AND kind = 'REQUIRES_PERSON_AUTHORITY' AND state IN ('OPEN', 'ASSIGNED')`,
    [state, reason, nowIso(), input.gapId] as never[],
  );

  const after = (await listGaps(existing.packet_id)).find((gap) => gap.id === input.gapId) ?? null;

  if (result.changes === 0) {
    return {
      answered: false,
      gap: after,
      reason:
        existing.kind !== 'REQUIRES_PERSON_AUTHORITY'
          ? `That gap is ${existing.kind}, which is not a question for a person. This answers ` +
            'gaps waiting on an authority and nothing else — a caller that could reclassify any ' +
            'gap could skip the research one.'
          : `That gap is already ${existing.state}: ${after?.stateReason ?? 'no reason recorded'}.`,
    };
  }

  /*
   * Append-only, with no foreign key, for `identity_events`' own reason: an
   * audit row a cascade can delete is not an audit row. The statement is
   * recorded because what was authorized is the thing somebody will want to
   * read back; the denial-category rule does not apply, since nothing here is
   * a refused credential.
   */
  await recordIdentityEvent({
    actorType: 'HUMAN',
    actorId: person.id,
    action: 'CAPABILITY_AUTHORITY_ANSWERED',
    targetType: 'REALIZATION_GAP',
    targetId: input.gapId,
    result: 'SUCCESS',
    metadata: {
      packetId: existing.packet_id,
      answer: input.answer,
      statement,
      authorityChannel: channel,
      executedByRef: input.executedByRef ?? null,
    },
  });

  return { answered: true, gap: after, reason };
}

/** Every gap on a packet that is waiting on a person, so a reader can see what is outstanding. */
export async function gapsAwaitingAPerson(packetId: string): Promise<PacketGap[]> {
  return listGaps(packetId, {
    states: ['OPEN', 'ASSIGNED'],
    kinds: ['REQUIRES_PERSON_AUTHORITY'],
  });
}
