/**
 * Search, across everything one person is allowed to see.
 *
 * §22 asks for one search over conversations, ideas, missions, conclusions,
 * numbers, decisions, assumptions, unknowns, contradictions, sources, documents
 * and connected sites. The whole difficulty is the last clause of that sentence
 * — *one person* — and it is why this is a service rather than a query.
 *
 * **Scope is decided before the search runs, never filtered afterwards.** The
 * projects a caller may read come from `decideProjectAccess` over the
 * authenticated principal, and every query is bounded to that set. A search
 * that fetched broadly and removed rows at the end is one forgotten filter away
 * from being a disclosure, and the *count* alone is information: "no results"
 * and "results you cannot see" must be indistinguishable, which they are here
 * because the rows were never fetched.
 *
 * **A private conversation is the owner's, whatever their project rights.**
 * Read access to a project does not extend to somebody's private thinking (§7),
 * so conversations are scoped by owner and not by project.
 *
 * **Matching is deterministic and boring.** Case-insensitive substring over
 * the fields that carry meaning, ranked by where the match landed rather than
 * by a score nobody can explain. This is not a relevance engine, and pretending
 * otherwise would invite the kind of ranking a person cannot argue with.
 */
import { getDb } from '../../db/database.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { listProjects } from '../../repos/projects.ts';
import type { Principal } from '../../domain/types.ts';

/** What a hit is. Each one resolves to a row a person can open. */
export const SEARCH_KINDS = [
  'CONVERSATION',
  'IDEA',
  'MISSION',
  'KNOWLEDGE',
  'DOCUMENT',
  'FRONTIER',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  CONVERSATION: 'Conversation',
  IDEA: 'Idea',
  MISSION: 'Work',
  KNOWLEDGE: 'Something Russell knows',
  DOCUMENT: 'Document',
  FRONTIER: 'On the frontier',
};

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  /** The matching text, or the row's own subtitle. Never composed. */
  detail: string | null;
  projectId: string | null;
  /** What a person would click. A real address in this application. */
  href: string;
  updatedAt: string | null;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /**
   * How many projects the search actually covered.
   *
   * Shown so an empty result can be read correctly: nothing found across four
   * projects is a different fact from nothing found because you can see none.
   */
  scopedProjects: number;
  truncated: boolean;
}

/** One saved view — a query plus the filters that make it worth keeping. */
export const SAVED_VIEWS = [
  {
    key: 'UNFINISHED_MAJOR',
    label: 'Unfinished major conversations',
    kinds: ['CONVERSATION'] as SearchKind[],
  },
  { key: 'BLOCKED_WORK', label: 'Blocked high-priority work', kinds: ['MISSION'] as SearchKind[] },
  { key: 'RECENT_DISCOVERIES', label: 'Recent discoveries', kinds: ['IDEA'] as SearchKind[] },
  { key: 'WEAK_KNOWLEDGE', label: 'Weak knowledge', kinds: ['FRONTIER'] as SearchKind[] },
  {
    key: 'UNRESOLVED_CONTRADICTIONS',
    label: 'Unresolved contradictions',
    kinds: ['KNOWLEDGE'] as SearchKind[],
  },
] as const;

const MAX_PER_KIND = 20;

/**
 * The projects this caller may read, decided by the policy module.
 *
 * Not a query with a membership join: the decision belongs to
 * `services/identity/policy.ts` and nowhere else, so search cannot become a
 * second place where access is worked out — which is how a second, weaker
 * security model appears.
 */
async function readableProjectIds(principal: Principal | null): Promise<string[]> {
  if (!principal) return [];
  const all = await listProjects();
  return all
    .filter((project) => decideProjectAccess(principal, project.id, 'READ').allowed)
    .map((project) => project.id);
}

function like(term: string): string {
  // The three LIKE metacharacters, neutralised. A query containing `%` should
  // search for a per-cent sign rather than matching everything.
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`).toLowerCase()}%`;
}

/**
 * Search, as one person.
 *
 * Every branch is bounded to `projectIds` in the statement. Conversations are
 * bounded to the owner instead, because a shared project does not make somebody
 * else's private thread readable.
 */
export async function search(input: {
  principal: Principal | null;
  query: string;
  kinds?: SearchKind[];
  limit?: number;
}): Promise<SearchResult> {
  const query = input.query.trim();
  const wanted = new Set<SearchKind>(input.kinds ?? SEARCH_KINDS);
  const limit = Math.min(MAX_PER_KIND, Math.max(1, input.limit ?? MAX_PER_KIND));

  if (query.length < 2) {
    // One character matches everything and tells nobody anything. Refusing is
    // more useful than a page of noise, and it is not an error.
    return { query, hits: [], scopedProjects: 0, truncated: false };
  }

  const projectIds = await readableProjectIds(input.principal);
  const isPerson = input.principal?.type === 'HUMAN';
  if (projectIds.length === 0 && !isPerson) {
    return { query, hits: [], scopedProjects: 0, truncated: false };
  }

  const db = getDb();
  const pattern = like(query);
  const hits: SearchHit[] = [];
  let truncated = false;

  const inProjects = projectIds.map(() => '?').join(',');

  if (wanted.has('CONVERSATION') && isPerson) {
    const rows = await db.all<{ id: string; title: string; project_id: string | null; updated_at: string }>(
      `SELECT id, title, project_id, updated_at
         FROM russell_conversations
        WHERE owner_user_id = ? AND LOWER(title) LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      [input.principal!.id, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'CONVERSATION',
        id: row.id,
        title: row.title,
        detail: null,
        projectId: row.project_id,
        href: `/conversation/${row.id}`,
        updatedAt: row.updated_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  if (projectIds.length === 0) {
    return { query, hits, scopedProjects: 0, truncated };
  }

  if (wanted.has('IDEA')) {
    const rows = await db.all<{
      id: string;
      title: string;
      statement: string;
      project_id: string;
      updated_at: string;
    }>(
      `SELECT id, title, statement, project_id, updated_at
         FROM russell_candidates
        WHERE project_id IN (${inProjects})
          AND visibility = 'SHARED'
          AND (LOWER(title) LIKE ? OR LOWER(statement) LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
      [...projectIds, pattern, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'IDEA',
        id: row.id,
        title: row.title,
        detail: row.statement,
        projectId: row.project_id,
        href: '/projects',
        updatedAt: row.updated_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  if (wanted.has('MISSION')) {
    const rows = await db.all<{
      id: string;
      objective: string;
      why_now: string;
      project_id: string;
      updated_at: string;
    }>(
      `SELECT id, objective, why_now, project_id, updated_at
         FROM russell_missions
        WHERE project_id IN (${inProjects})
          AND visibility = 'SHARED'
          AND (LOWER(objective) LIKE ? OR LOWER(why_now) LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
      [...projectIds, pattern, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'MISSION',
        id: row.id,
        title: row.objective,
        detail: row.why_now,
        projectId: row.project_id,
        href: '/work',
        updatedAt: row.updated_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  if (wanted.has('KNOWLEDGE')) {
    const rows = await db.all<{
      id: string;
      statement: string;
      detail: string | null;
      kind: string;
      project_id: string;
      updated_at: string;
    }>(
      `SELECT id, statement, detail, kind, project_id, updated_at
         FROM russell_knowledge
        WHERE project_id IN (${inProjects})
          AND visibility = 'SHARED'
          AND superseded_by_id IS NULL
          AND (LOWER(statement) LIKE ? OR LOWER(COALESCE(detail, '')) LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ?`,
      [...projectIds, pattern, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'KNOWLEDGE',
        id: row.id,
        title: row.statement,
        detail: row.detail,
        projectId: row.project_id,
        href: '/knowledge',
        updatedAt: row.updated_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  if (wanted.has('DOCUMENT')) {
    const rows = await db.all<{
      id: string;
      canonical_name: string;
      project_id: string;
      updated_at: string;
    }>(
      `SELECT id, canonical_name, project_id, updated_at
         FROM documents
        WHERE project_id IN (${inProjects})
          AND LOWER(canonical_name) LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      [...projectIds, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'DOCUMENT',
        id: row.id,
        title: row.canonical_name,
        detail: null,
        projectId: row.project_id,
        href: '/knowledge',
        updatedAt: row.updated_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  if (wanted.has('FRONTIER')) {
    const rows = await db.all<{
      id: string;
      subject: string;
      detail: string | null;
      region: string;
      project_id: string;
      last_seen_at: string;
    }>(
      `SELECT id, subject, detail, region, project_id, last_seen_at
         FROM russell_frontier
        WHERE project_id IN (${inProjects})
          AND visibility = 'SHARED'
          AND resolved_at IS NULL
          AND (LOWER(subject) LIKE ? OR LOWER(COALESCE(detail, '')) LIKE ?)
        ORDER BY last_seen_at DESC
        LIMIT ?`,
      [...projectIds, pattern, pattern, limit],
    );
    for (const row of rows) {
      hits.push({
        kind: 'FRONTIER',
        id: row.id,
        title: row.subject,
        detail: row.detail,
        projectId: row.project_id,
        href: '/projects',
        updatedAt: row.last_seen_at,
      });
    }
    if (rows.length === limit) truncated = true;
  }

  /*
   * Rank by where the match landed, then by recency.
   *
   * A title match beats a body match, because somebody searching for a name is
   * usually looking for the thing with that name. Beyond that it is the most
   * recently touched first — which is explainable, which a relevance score
   * would not be.
   */
  const lowered = query.toLowerCase();
  hits.sort((left, right) => {
    const leftTitle = left.title.toLowerCase().includes(lowered) ? 0 : 1;
    const rightTitle = right.title.toLowerCase().includes(lowered) ? 0 : 1;
    if (leftTitle !== rightTitle) return leftTitle - rightTitle;
    return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
  });

  return { query, hits, scopedProjects: projectIds.length, truncated };
}
