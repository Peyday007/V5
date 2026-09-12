/**
 * The rows behind an asked discovery lens.
 *
 * A repository rather than a second copy of the query inside a service,
 * because two readers need the same answer and they sit on opposite sides of a
 * module cycle: `services/russell/inquiry.ts` owns the lens lifecycle and
 * imports `LENSES` from `frontier.ts`, while `frontier.ts` has to re-observe
 * what a person accepted or the next pass would resolve it away. Importing one
 * service from the other closes that loop; both importing this does not.
 *
 * It is deliberately narrow: the shape below is what the frontier pass needs to
 * re-observe an accepted finding, and nothing more. The full inquiry — its
 * validation, its discards, its refusals — stays in the service that owns it.
 */
import { getDb } from '../db/database.ts';
import { parseJson } from './util.ts';
import type { RussellVisibility } from '../domain/types.ts';

/** Just enough of an accepted finding to put it back on the frontier. */
export interface AcceptedLensFinding {
  inquiryId: string;
  lens: string;
  visibility: RussellVisibility;
  subject: string;
  statement: string;
}

/**
 * Every finding a person has accepted in this project.
 *
 * Read from the decision rows rather than from a flag on the finding, because
 * the decision is the append-only fact: accepting one is a row naming who and
 * when, and a boolean somewhere else would be a second place for the same
 * truth to be wrong.
 */
export async function listAcceptedLensFindings(
  projectId: string,
): Promise<AcceptedLensFinding[]> {
  const rows = await getDb().all<{
    inquiry_id: string;
    finding_index: number;
    lens: string;
    visibility: string;
    findings: string;
  }>(
    `SELECT d.inquiry_id, d.finding_index, i.lens, i.visibility, i.findings
       FROM russell_lens_decisions d
       JOIN russell_lens_inquiries i ON i.id = d.inquiry_id
      WHERE i.project_id = ? AND d.decision = 'ACCEPTED'
      ORDER BY d.decided_at`,
    [projectId],
  );

  const out: AcceptedLensFinding[] = [];
  for (const row of rows) {
    const list = parseJson<{ subject?: unknown; statement?: unknown }[]>(row.findings, []);
    const finding = list[row.finding_index];
    // A decision whose finding is no longer at that index is skipped rather
    // than guessed at. The stored array is immutable in practice, so this is a
    // defensive branch — but guessing would put a *different* finding on the
    // frontier under somebody's acceptance, which is worse than losing one.
    if (!finding || typeof finding.subject !== 'string' || typeof finding.statement !== 'string') {
      continue;
    }
    out.push({
      inquiryId: row.inquiry_id,
      lens: row.lens,
      visibility: row.visibility as RussellVisibility,
      subject: finding.subject,
      statement: finding.statement,
    });
  }
  return out;
}
