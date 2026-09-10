/**
 * What an idea is *about*, read from rows rather than from its own prose.
 *
 * ---------------------------------------------------------------------------
 * The boundary this exists to hold
 * ---------------------------------------------------------------------------
 *
 * A Russell candidate is a sentence. Everything the compiler knew about the
 * thing that sentence refers to, it knew by reading the sentence — and for an
 * idea somebody typed, that is all there is. But an idea raised from a
 * connected site's record is *about a row*, and that row carries structured
 * facts the sentence only paraphrases: which organisation, which pipeline
 * stage, and — the one that matters here — where it actually is.
 *
 * So this is the seam between "the project" (which the compiler already had)
 * and "the subject" (which it did not). It answers one question today —
 * jurisdiction — because that is the one a compiled specification asserts. It
 * is the right shape for the next one.
 *
 * ---------------------------------------------------------------------------
 * Three rules
 * ---------------------------------------------------------------------------
 *
 * **A row outranks prose.** The site's `state` column means a state. The
 * sentence derived from it is a paraphrase, and a paraphrase that dropped the
 * jurisdiction is exactly how this defect happened.
 *
 * **Unknown is an answer.** A candidate with no structured subject, or a
 * subject whose location Brain cannot read, returns `null` — never a default,
 * never the project's, never the envelope's. Deciding what to do with not
 * knowing is the compiler's, and it has to be able to tell that it does not
 * know.
 *
 * **Nothing here decides what is allowed.** Whether a jurisdiction may be
 * researched is the approval envelope's, in code, where nobody supplies the
 * limits their own work is judged against (§16). This only reports what is
 * true of the subject.
 */
import { getExternalRecordByCandidate } from '../../repos/externalRecords.ts';
import { properName, stateFromField, stateFromPlace } from '../../domain/jurisdiction.ts';
import type { RussellCandidate } from '../../domain/types.ts';

/** Which row said so. A default is not a finding, and neither is a guess. */
export type JurisdictionSource = 'RECORD_STATE' | 'RECORD_LOCATION';

export interface SubjectContext {
  /**
   * Where the subject is, when a row says so. `null` means Brain does not know,
   * which is a different fact from "it has none".
   */
  jurisdiction: { value: string; from: JurisdictionSource } | null;
  /**
   * Which record this idea is about, for the reason and the audit. Read by
   * nothing that takes a decision.
   */
  origin: { system: string; recordType: string; recordId: string } | null;
}

const NOTHING: SubjectContext = Object.freeze({ jurisdiction: null, origin: null });

/**
 * The structured subject behind one idea, or nothing.
 *
 * One lookup, on an indexed column, and it returns `NOTHING` for every
 * candidate that is not about a connected record — which is most of them. It
 * writes nothing and is safe on a read path.
 */
export async function subjectContextFor(
  candidate: Pick<RussellCandidate, 'id'>,
): Promise<SubjectContext> {
  const record = await getExternalRecordByCandidate(candidate.id);
  if (!record) return NOTHING;

  const origin = {
    system: record.sourceSystem,
    recordType: record.sourceRecordType,
    recordId: record.sourceRecordId,
  };

  /*
   * The column that means a state, then the one that contains a place.
   *
   * In that order because they answer with different confidence: `state` is a
   * field whose whole meaning is a jurisdiction, and `location` is free text a
   * person typed that usually ends in one. Where they disagree the column
   * wins, and the source is recorded either way so the difference is visible
   * rather than implied.
   */
  const fromState = stateFromField(record.attributes['state']);
  if (fromState) {
    return { jurisdiction: { value: properName(fromState), from: 'RECORD_STATE' }, origin };
  }

  const fromLocation = stateFromPlace(record.attributes['location']);
  if (fromLocation) {
    return { jurisdiction: { value: properName(fromLocation), from: 'RECORD_LOCATION' }, origin };
  }

  return { jurisdiction: null, origin };
}

/** Plain words for where a jurisdiction came from, for a refusal a person reads. */
export function describeSource(from: JurisdictionSource): string {
  return from === 'RECORD_STATE'
    ? 'the record itself says so'
    : 'the record gives that as its location';
}
