/**
 * A person's recorded decision about what the product looks like.
 *
 * ---------------------------------------------------------------------------
 * What makes this evidence rather than a formality
 * ---------------------------------------------------------------------------
 *
 * §24's design gate wants a recorded visual, mobile and interaction approval.
 * It has been recorded until now in a markdown table whose top row still reads
 * `— pending —`: a fine place to note that a decision happened and a useless
 * place to check it from, because nothing can read it, nothing binds it to the
 * code it describes, and the person editing it is usually the one citing it.
 *
 * Three properties do the work here, and the acceptance reporter checks all
 * three rather than checking that a row exists:
 *
 *  1. **Bound to a revision and to a render-set digest.** An approval is of a
 *     specific thing somebody looked at. Change the tree or change the renders
 *     and it no longer describes what they saw — so a reader must say the
 *     approval is stale, never carry it forward. §23's reservation-bound-to-the-
 *     bytes shape at a smaller scale.
 *  2. **The approver comes from the authenticated principal.** Never from a
 *     field, so nothing a caller sends can make this an approval by somebody
 *     else (§17).
 *  3. **Append-only.** Withdrawing is a new row, so "approved, then withdrawn"
 *     stays readable instead of one state overwriting another (§5).
 *
 * And one thing it deliberately cannot do: **nothing in `scripts/` writes it.**
 * The acceptance reporter evaluates approvals and has no code path that creates
 * one, because a reporter that could record the approval it is waiting for would
 * be approving its own work — the same reason `independenceEvidence.ts`
 * re-checks the guard it is evidence for.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';

export const DESIGN_DECISIONS = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type DesignDecision = (typeof DESIGN_DECISIONS)[number];

export interface DesignApproval {
  id: string;
  revision: string;
  renderSetDigest: string;
  renderCount: number;
  manifestPath: string;
  decision: DesignDecision;
  approvedByUserId: string;
  note: string | null;
  createdAt: string;
}

interface DesignApprovalRow {
  id: string;
  revision: string;
  render_set_digest: string;
  render_count: number;
  manifest_path: string;
  decision: string;
  approved_by_user_id: string;
  note: string | null;
  created_at: string;
}

const COLUMNS =
  'id, revision, render_set_digest, render_count, manifest_path, decision, ' +
  'approved_by_user_id, note, created_at';

function toView(row: DesignApprovalRow): DesignApproval {
  return {
    id: row.id,
    revision: row.revision,
    renderSetDigest: row.render_set_digest,
    renderCount: row.render_count,
    manifestPath: row.manifest_path,
    decision: row.decision as DesignDecision,
    approvedByUserId: row.approved_by_user_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

/**
 * The digest of a render set.
 *
 * Content-addressed over the bytes of every render plus its declared width and
 * screen, sorted, so the same set always digests the same and a set with one
 * image replaced digests differently. **Not** over the manifest's text: a
 * manifest is prose somebody wrote about the renders, and an approval must be
 * bound to the pictures rather than to the description of them.
 */
export function digestRenderSet(
  renders: { path: string; width: number; screen: string; bytes: Buffer }[],
): { digest: string; count: number } {
  const hash = createHash('sha256');
  const ordered = [...renders].sort((a, b) =>
    `${a.screen}|${a.width}|${a.path}`.localeCompare(`${b.screen}|${b.width}|${b.path}`),
  );
  for (const render of ordered) {
    hash.update(`${render.screen}|${render.width}|${render.path}|`);
    hash.update(createHash('sha256').update(render.bytes).digest('hex'));
    hash.update('\n');
  }
  return { digest: hash.digest('hex'), count: ordered.length };
}

export interface RecordDesignDecisionInput {
  revision: string;
  renderSetDigest: string;
  renderCount: number;
  manifestPath: string;
  decision: DesignDecision;
  /** Resolved from the authenticated principal by the caller. Never a body field. */
  approvedByUserId: string;
  note: string | null;
}

export async function recordDesignDecision(
  input: RecordDesignDecisionInput,
): Promise<DesignApproval> {
  const id = `dsg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const createdAt = new Date().toISOString();
  await getDb().run(
    `INSERT INTO design_approvals (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.revision,
      input.renderSetDigest,
      input.renderCount,
      input.manifestPath,
      input.decision,
      input.approvedByUserId,
      input.note,
      createdAt,
    ],
  );
  return (await getDesignApproval(id))!;
}

export async function getDesignApproval(id: string): Promise<DesignApproval | null> {
  const row = await getDb().get<DesignApprovalRow>(
    `SELECT ${COLUMNS} FROM design_approvals WHERE id = ?`,
    [id],
  );
  return row ? toView(row) : null;
}

/**
 * Every decision recorded for one revision, newest first.
 *
 * Ordered by `created_at` with `id` as the tiebreak, because an `ORDER BY` must
 * be sayable in both dialects and a tiebreak on `rowid` is the easiest way to
 * write one that is not — `dialect.ts` rewrites it to `seq`, which this table
 * does not have on Postgres.
 */
export async function decisionsForRevision(revision: string): Promise<DesignApproval[]> {
  const rows = await getDb().all<DesignApprovalRow>(
    `SELECT ${COLUMNS} FROM design_approvals WHERE revision = ? ORDER BY created_at DESC, id DESC`,
    [revision],
  );
  return rows.map(toView);
}

/**
 * The standing decision for one revision and one render set, or null.
 *
 * "Standing" is the newest row for that pair, whatever it says — so a
 * `WITHDRAWN` row after an `APPROVED` one means there is no approval, and the
 * caller sees the withdrawal rather than the approval underneath it. That is the
 * whole reason the table is append-only: the history is the point, and the
 * current answer is derived from it rather than stored.
 */
export async function standingDecision(
  revision: string,
  renderSetDigest: string,
): Promise<DesignApproval | null> {
  const row = await getDb().get<DesignApprovalRow>(
    `SELECT ${COLUMNS} FROM design_approvals
      WHERE revision = ? AND render_set_digest = ?
      ORDER BY created_at DESC, id DESC`,
    [revision, renderSetDigest],
  );
  return row ? toView(row) : null;
}
