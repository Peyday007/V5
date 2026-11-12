/**
 * What a person reads: discoveries, the registry, an idea's history, the
 * original conversation, topics and search. Every read is scoped to the owner
 * in its own statement; an id that is not theirs reads as absent.
 */
import { getDb } from '../../db/database.ts';
import { parseJson } from '../../repos/util.ts';
import { tokens } from './classify.ts';
import { MemoryNotFound } from './ingest.ts';

export interface SourceRef {
  conversationId: string;
  title: string;
  saidAt: string | null;
  passageId?: string;
}

export interface DiscoveryView {
  id: string;
  ideaId: string;
  title: string;
  kind: string;
  originally: string;
  period: { first: string | null; last: string | null };
  whyMatters: string;
  whyNow: string;
  afterwards: string;
  state: string;
  unresolved: boolean;
  ownerIntent: string | null;
  score: number;
  trigger: string;
  surfacedAt: string;
  sources: SourceRef[];
}

export async function listDiscoveries(ownerId: string, state: 'OPEN' | 'DECIDED' = 'OPEN'): Promise<DiscoveryView[]> {
  const db = getDb();
  const rows = await db.all<{
    id: string; idea_id: string; score: number; why_matters: string; why_now: string; trigger_kind: string; surfaced_at: string;
    title: string; kind: string; statement: string; first_seen_at: string | null; last_seen_at: string | null; state: string;
    state_basis: string; owner_intent: string | null;
  }>(
    `SELECT d.id, d.idea_id, d.score, d.why_matters, d.why_now, d.trigger_kind, d.surfaced_at,
            i.title, i.kind, i.statement, i.first_seen_at, i.last_seen_at, i.state, i.state_basis, i.owner_intent
       FROM memory_discoveries d JOIN memory_ideas i ON i.id = d.idea_id
      WHERE d.owner_user_id = ? AND d.state = ?
      ORDER BY ${state === 'OPEN' ? 'd.score DESC' : 'd.decided_at DESC'} LIMIT 50`,
    [ownerId, state],
  );
  const out: DiscoveryView[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      ideaId: r.idea_id,
      title: r.owner_intent ?? r.title,
      kind: r.kind,
      originally: r.statement,
      period: { first: r.first_seen_at, last: r.last_seen_at },
      whyMatters: r.why_matters,
      whyNow: r.why_now,
      afterwards: r.state_basis,
      state: r.state,
      unresolved: r.state === 'UNRESOLVED' || r.state === 'PAUSED',
      ownerIntent: r.owner_intent,
      score: Number(r.score),
      trigger: r.trigger_kind,
      surfacedAt: r.surfaced_at,
      sources: await sourcesOf(r.idea_id, 5),
    });
  }
  return out;
}

async function sourcesOf(ideaId: string, limit: number): Promise<SourceRef[]> {
  const rows = await getDb().all<{ conversation_id: string; title: string; said_at: string | null; passage_id: string }>(
    `SELECT e.conversation_id, c.title, e.said_at, e.passage_id
       FROM memory_idea_evidence e JOIN memory_conversations c ON c.id = e.conversation_id
      WHERE e.idea_id = ? ORDER BY e.direct DESC, e.said_at LIMIT ?`,
    [ideaId, limit],
  );
  return rows.map((r) => ({ conversationId: r.conversation_id, title: r.title, saidAt: r.said_at, passageId: r.passage_id }));
}

export interface IdeaSummary {
  id: string;
  kind: string;
  title: string;
  state: string;
  stateBasis: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  conversations: number;
  mentions: number;
  cueStrength: number;
  ownerIntent: string | null;
  hasOpenDiscovery: boolean;
}

export async function listIdeas(
  ownerId: string,
  filter: { state?: string; kind?: string; q?: string; limit?: number },
): Promise<IdeaSummary[]> {
  const where = ['i.owner_user_id = ?'];
  const params: unknown[] = [ownerId];
  if (filter.state) {
    where.push('i.state = ?');
    params.push(filter.state);
  }
  if (filter.kind) {
    where.push('i.kind = ?');
    params.push(filter.kind);
  }
  if (filter.q && filter.q.trim().length >= 2) {
    where.push(`(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(i.statement) LIKE ? ESCAPE '\\')`);
    const p = like(filter.q);
    params.push(p, p);
  }
  params.push(Math.min(500, filter.limit ?? 200));
  const rows = await getDb().all<{
    id: string; kind: string; title: string; state: string; state_basis: string; first_seen_at: string | null; last_seen_at: string | null;
    conversation_count: number; mention_count: number; cue_strength: number; owner_intent: string | null; open_count: number;
  }>(
    `SELECT i.id, i.kind, i.title, i.state, i.state_basis, i.first_seen_at, i.last_seen_at, i.conversation_count, i.mention_count,
            i.cue_strength, i.owner_intent,
            (SELECT COUNT(*) FROM memory_discoveries d WHERE d.idea_id = i.id AND d.state = 'OPEN') AS open_count
       FROM memory_ideas i WHERE ${where.join(' AND ')}
      ORDER BY i.cue_strength DESC, i.last_seen_at DESC LIMIT ?`,
    params as never[],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.owner_intent ?? r.title,
    state: r.state,
    stateBasis: r.state_basis,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    conversations: Number(r.conversation_count),
    mentions: Number(r.mention_count),
    cueStrength: Number(r.cue_strength),
    ownerIntent: r.owner_intent,
    hasOpenDiscovery: Number(r.open_count) > 0,
  }));
}

export interface IdeaDetail {
  idea: IdeaSummary & {
    statement: string;
    obstacles: string[];
    openQuestions: string[];
    reconsiderWhen: string[];
    nextActions: string[];
    ownerFeedback: string | null;
    version: number;
    projectId: string | null;
    candidateId: string | null;
    supersededById: string | null;
  };
  timeline: { stage: string; saidAt: string | null; excerpt: string; conversationId: string; conversationTitle: string; passageId: string; direct: boolean }[];
  versions: { version: number; reason: string; createdAt: string; snapshot: unknown }[];
  decisions: { decision: string; feedback: string | null; outcomeKind: string | null; outcomeRef: string | null; createdAt: string }[];
  related: { id: string; title: string; relation: string; basis: string; state: string }[];
  topics: { id: string; label: string }[];
  currentConnections: { kind: 'PROJECT' | 'IDEA_IN_BRAIN' | 'KNOWLEDGE'; id: string; title: string; projectId: string | null }[];
  /** Where this idea went in Brain: every project and Russell idea it was promoted into. */
  promotedTo: { kind: string; id: string; basis: string }[];
  /** What can happen next, and when Brain will raise it again. */
  eligible: { actions: string[]; resurfaces: string };
}

export async function ideaDetail(ownerId: string, ideaId: string): Promise<IdeaDetail> {
  const db = getDb();
  const row = await db.get<Record<string, unknown>>('SELECT * FROM memory_ideas WHERE id = ? AND owner_user_id = ?', [ideaId, ownerId]);
  if (!row) throw new MemoryNotFound('No such idea.');
  const summary = (await listIdeas(ownerId, { limit: 500 })).find((i) => i.id === ideaId) ?? {
    id: ideaId, kind: String(row.kind), title: String(row.title), state: String(row.state), stateBasis: String(row.state_basis),
    firstSeenAt: (row.first_seen_at as string | null) ?? null, lastSeenAt: (row.last_seen_at as string | null) ?? null,
    conversations: Number(row.conversation_count), mentions: Number(row.mention_count), cueStrength: Number(row.cue_strength),
    ownerIntent: (row.owner_intent as string | null) ?? null, hasOpenDiscovery: false,
  };
  const timeline = await db.all<{ stage: string; said_at: string | null; excerpt: string; conversation_id: string; title: string; passage_id: string; direct: number }>(
    `SELECT e.stage, e.said_at, e.excerpt, e.conversation_id, c.title, e.passage_id, e.direct
       FROM memory_idea_evidence e JOIN memory_conversations c ON c.id = e.conversation_id
      WHERE e.idea_id = ? ORDER BY e.said_at, e.created_at LIMIT 200`,
    [ideaId],
  );
  const versions = await db.all<{ version: number; reason: string; created_at: string; snapshot: string }>(
    'SELECT version, reason, created_at, snapshot FROM memory_idea_versions WHERE idea_id = ? ORDER BY version DESC',
    [ideaId],
  );
  const decisions = await db.all<{ decision: string; feedback: string | null; outcome_kind: string | null; outcome_ref: string | null; created_at: string }>(
    'SELECT decision, feedback, outcome_kind, outcome_ref, created_at FROM memory_decisions WHERE idea_id = ? ORDER BY created_at DESC',
    [ideaId],
  );
  const related = await db.all<{ id: string; title: string; relation: string; basis: string; state: string }>(
    `SELECT i.id, i.title, l.relation, l.basis, i.state FROM memory_idea_links l JOIN memory_ideas i ON i.id = l.to_id
      WHERE l.idea_id = ? AND l.to_kind = 'IDEA' ORDER BY l.relation, i.last_seen_at DESC LIMIT 30`,
    [ideaId],
  );
  const topics = await db.all<{ id: string; label: string }>(
    `SELECT t.id, t.label FROM memory_idea_links l JOIN memory_topics t ON t.id = l.to_id
      WHERE l.idea_id = ? AND l.to_kind = 'TOPIC' AND t.state = 'ACTIVE' ORDER BY t.conversation_count DESC LIMIT 12`,
    [ideaId],
  );
  return {
    idea: {
      ...summary,
      statement: String(row.statement),
      obstacles: parseJson<string[]>(row.obstacles as string, []),
      openQuestions: parseJson<string[]>(row.open_questions as string, []),
      reconsiderWhen: parseJson<string[]>(row.reconsider_when as string, []),
      nextActions: parseJson<string[]>(row.next_actions as string, []),
      ownerFeedback: (row.owner_feedback as string | null) ?? null,
      version: Number(row.version),
      projectId: (row.project_id as string | null) ?? null,
      candidateId: (row.candidate_id as string | null) ?? null,
      supersededById: (row.superseded_by_id as string | null) ?? null,
    },
    timeline: timeline.map((t) => ({
      stage: t.stage, saidAt: t.said_at, excerpt: t.excerpt, conversationId: t.conversation_id, conversationTitle: t.title,
      passageId: t.passage_id, direct: t.direct === 1,
    })),
    versions: versions.map((v) => ({ version: v.version, reason: v.reason, createdAt: v.created_at, snapshot: parseJson(v.snapshot, {}) })),
    decisions: decisions.map((d) => ({ decision: d.decision, feedback: d.feedback, outcomeKind: d.outcome_kind, outcomeRef: d.outcome_ref, createdAt: d.created_at })),
    related,
    topics,
    currentConnections: await currentConnections(String(row.signature)),
    promotedTo: (await db.all<{ to_kind: string; to_id: string; basis: string }>(
      `SELECT to_kind, to_id, basis FROM memory_idea_links WHERE idea_id = ? AND relation = 'PROMOTED_TO' ORDER BY created_at`,
      [ideaId],
    )).map((l) => ({ kind: l.to_kind, id: l.to_id, basis: l.basis })),
    eligible: eligibleFor(String(row.state), decisions[0]?.decision ?? null),
  };
}

/** The next eligible actions for a record, from its state and the person's last decision. */
export function eligibleFor(state: string, lastDecision: string | null): IdeaDetail['eligible'] {
  if (lastDecision === 'NOT_INTERESTED') {
    return { actions: ['EXPLORE', 'UPDATE_WANT', 'FEEDBACK'], resurfaces: 'Never on its own — you said you are not interested. It stays in the record and you can reopen it here.' };
  }
  if (lastDecision && ['EXPLORE', 'PLAN', 'CREATE_SECTION'].includes(lastDecision)) {
    return { actions: ['PLAN', 'CREATE_SECTION', 'LATER', 'NOT_INTERESTED', 'UPDATE_WANT', 'FEEDBACK'], resurfaces: 'Not as a discovery — it is now work in Brain.' };
  }
  if (lastDecision === 'LATER') {
    return { actions: ['EXPLORE', 'PLAN', 'CREATE_SECTION', 'NOT_INTERESTED', 'UPDATE_WANT', 'FEEDBACK'], resurfaces: 'When something relevant changes — a new conversation about it, or a change in circumstance — and at least 30 days after you deferred it.' };
  }
  if (state === 'COMPLETED' || state === 'REJECTED') {
    return { actions: ['EXPLORE', 'UPDATE_WANT', 'FEEDBACK'], resurfaces: 'Not on its own: the record says it is settled.' };
  }
  return { actions: ['EXPLORE', 'PLAN', 'CREATE_SECTION', 'LATER', 'NOT_INTERESTED', 'UPDATE_WANT', 'FEEDBACK'], resurfaces: 'When it has been quiet and unresolved, or when something relevant changes.' };
}

/**
 * The idea against what Brain holds now: projects, ideas Russell has, and
 * shared knowledge — by the idea's own subject words. Bounded, read-only.
 */
async function currentConnections(signature: string): Promise<IdeaDetail['currentConnections']> {
  const words = signature.split(' ').filter((w) => w.length >= 4);
  const probe = [...words].sort((a, b) => b.length - a.length).slice(0, 3);
  if (probe.length === 0) return [];
  const db = getDb();
  const any = (col: string): string => probe.map(() => `LOWER(${col}) LIKE ?`).join(' OR ');
  const params = probe.map((w) => `%${w}%`);
  // Candidates carry any of the most specific words; a connection needs two of
  // the idea's words (or its only one).
  const enough = (text: string): boolean => {
    const lower = text.toLowerCase();
    return words.filter((w) => lower.includes(w)).length >= Math.min(2, words.length);
  };
  const out: IdeaDetail['currentConnections'] = [];
  for (const p of await db.all<{ id: string; name: string; description: string | null }>(
    `SELECT id, name, description FROM projects WHERE status = 'ACTIVE' AND (${any(`name || ' ' || COALESCE(description, '')`)}) LIMIT 20`,
    params,
  )) if (enough(`${p.name} ${p.description ?? ''}`) && out.length < 5) out.push({ kind: 'PROJECT', id: p.id, title: p.name, projectId: p.id });
  for (const c of await db.all<{ id: string; title: string; statement: string; project_id: string | null }>(
    `SELECT id, title, statement, project_id FROM russell_candidates WHERE ${any(`title || ' ' || statement`)} ORDER BY updated_at DESC LIMIT 20`,
    params,
  )) if (enough(`${c.title} ${c.statement}`)) out.push({ kind: 'IDEA_IN_BRAIN', id: c.id, title: c.title, projectId: c.project_id });
  for (const k of await db.all<{ id: string; statement: string; project_id: string }>(
    `SELECT id, statement, project_id FROM russell_knowledge WHERE superseded_by_id IS NULL AND (${any('statement')}) ORDER BY updated_at DESC LIMIT 20`,
    params,
  )) if (enough(k.statement)) out.push({ kind: 'KNOWLEDGE', id: k.id, title: k.statement.slice(0, 200), projectId: k.project_id });
  return out.slice(0, 15);
}

export interface ConversationRecord {
  conversation: {
    id: string; source: string; externalId: string; title: string; createdAt: string | null; updatedAt: string | null;
    projectRef: string | null; projectName: string | null; version: number; contentHash: string; nodes: number; messages: number;
    branchPoints: number; alternates: number; attachments: number;
  };
  messages: {
    id: string; nodeId: string; parentNodeId: string | null; depth: number; siblingIndex: number; siblingCount: number;
    onReadPath: boolean; role: string; authorName: string | null; contentType: string; text: string; saidAt: string | null;
    modelSlug: string | null; hidden: boolean; superseded: boolean;
    attachments: { id: string; kind: string; name: string | null; mimeType: string | null; state: string; width: number | null; height: number | null }[];
  }[];
  versions: { version: number; contentHash: string; importedAt: string; archiveId: string | null; rawBytes: number }[];
  topics: { id: string; label: string }[];
}

export async function conversationRecord(ownerId: string, conversationId: string, withBranches: boolean): Promise<ConversationRecord> {
  const db = getDb();
  const c = await db.get<Record<string, unknown>>(
    'SELECT * FROM memory_conversations WHERE id = ? AND owner_user_id = ?',
    [conversationId, ownerId],
  );
  if (!c) throw new MemoryNotFound('No such conversation.');
  const messages = await db.all<Record<string, unknown>>(
    `SELECT * FROM memory_messages WHERE conversation_id = ? ${withBranches ? '' : 'AND on_current_path = 1 AND superseded_in_version IS NULL'}
      ORDER BY depth, sibling_index, first_version`,
    [conversationId],
  );
  const attachments = await db.all<{ id: string; message_id: string; kind: string; name: string | null; mime_type: string | null; state: string; width: number | null; height: number | null }>(
    'SELECT id, message_id, kind, name, mime_type, state, width, height FROM memory_attachments WHERE conversation_id = ?',
    [conversationId],
  );
  const byMessage = new Map<string, typeof attachments>();
  for (const a of attachments) byMessage.set(a.message_id, [...(byMessage.get(a.message_id) ?? []), a]);
  const versions = await db.all<{ version: number; content_hash: string; imported_at: string; archive_id: string | null; raw_bytes: number }>(
    'SELECT version, content_hash, imported_at, archive_id, raw_bytes FROM memory_conversation_versions WHERE conversation_id = ? ORDER BY version DESC',
    [conversationId],
  );
  const topics = await db.all<{ id: string; label: string }>(
    `SELECT t.id, t.label FROM memory_topic_members m JOIN memory_topics t ON t.id = m.topic_id
      WHERE m.conversation_id = ? AND t.state = 'ACTIVE' ORDER BY t.conversation_count DESC`,
    [conversationId],
  );
  return {
    conversation: {
      id: String(c.id), source: String(c.source), externalId: String(c.external_id), title: String(c.title),
      createdAt: (c.source_created_at as string | null) ?? null, updatedAt: (c.source_updated_at as string | null) ?? null,
      projectRef: (c.project_ref as string | null) ?? null, projectName: (c.project_name as string | null) ?? null,
      version: Number(c.version), contentHash: String(c.content_hash), nodes: Number(c.node_count), messages: Number(c.message_count),
      branchPoints: Number(c.branch_point_count), alternates: Number(c.alternate_message_count), attachments: Number(c.attachment_count),
    },
    messages: messages.map((m) => ({
      id: String(m.id), nodeId: String(m.node_id), parentNodeId: (m.parent_node_id as string | null) ?? null, depth: Number(m.depth),
      siblingIndex: Number(m.sibling_index), siblingCount: Number(m.sibling_count), onReadPath: Number(m.on_current_path) === 1,
      role: String(m.role), authorName: (m.author_name as string | null) ?? null, contentType: String(m.content_type), text: String(m.text),
      saidAt: (m.said_at as string | null) ?? null, modelSlug: (m.model_slug as string | null) ?? null, hidden: Number(m.hidden) === 1,
      superseded: m.superseded_in_version !== null && m.superseded_in_version !== undefined,
      attachments: (byMessage.get(String(m.id)) ?? []).map((a) => ({
        id: a.id, kind: a.kind, name: a.name, mimeType: a.mime_type, state: a.state, width: a.width, height: a.height,
      })),
    })),
    versions: versions.map((v) => ({ version: v.version, contentHash: v.content_hash, importedAt: v.imported_at, archiveId: v.archive_id, rawBytes: Number(v.raw_bytes) })),
    topics,
  };
}

export async function attachmentObject(ownerId: string, attachmentId: string): Promise<{ key: string; mimeType: string; name: string }> {
  const row = await getDb().get<{ storage_key: string | null; mime_type: string | null; name: string | null; state: string }>(
    'SELECT storage_key, mime_type, name, state FROM memory_attachments WHERE id = ? AND owner_user_id = ?',
    [attachmentId, ownerId],
  );
  if (!row || row.state !== 'RECOVERED' || !row.storage_key) throw new MemoryNotFound('No such attachment.');
  return { key: row.storage_key, mimeType: row.mime_type ?? 'application/octet-stream', name: row.name ?? 'attachment' };
}

export interface TopicNode {
  id: string;
  label: string;
  conversations: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  children: TopicNode[];
}

export async function topicTree(ownerId: string): Promise<TopicNode[]> {
  const rows = await getDb().all<{ id: string; label: string; conversation_count: number; first_seen_at: string | null; last_seen_at: string | null; parent_topic_id: string | null }>(
    `SELECT id, label, conversation_count, first_seen_at, last_seen_at, parent_topic_id FROM memory_topics
      WHERE owner_user_id = ? AND state = 'ACTIVE' ORDER BY conversation_count DESC LIMIT 400`,
    [ownerId],
  );
  const nodes = new Map(rows.map((r) => [r.id, { id: r.id, label: r.label, conversations: Number(r.conversation_count), firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, children: [] as TopicNode[] }]));
  const roots: TopicNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    const parent = r.parent_topic_id ? nodes.get(r.parent_topic_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface TopicHistory {
  topic: { id: string; label: string; terms: string[]; parentId: string | null; conversations: number };
  /** The topic's passages, oldest first: its chronological history. */
  history: { passageId: string; conversationId: string; conversationTitle: string; role: string; saidAt: string | null; excerpt: string; kinds: string[] }[];
  conversations: { id: string; title: string; firstSaidAt: string | null }[];
  ideas: { id: string; title: string; state: string }[];
  children: { id: string; label: string; conversations: number }[];
}

export async function topicHistory(ownerId: string, topicId: string, role: 'USER' | 'ALL' = 'USER'): Promise<TopicHistory> {
  const db = getDb();
  const topic = await db.get<{ id: string; label: string; terms: string; parent_topic_id: string | null; conversation_count: number }>(
    'SELECT id, label, terms, parent_topic_id, conversation_count FROM memory_topics WHERE id = ? AND owner_user_id = ?',
    [topicId, ownerId],
  );
  if (!topic) throw new MemoryNotFound('No such topic.');
  const terms = parseJson<string[]>(topic.terms, []).slice(0, 4).map((t) => t.replace(/ /g, '_'));
  const history = terms.length
    ? await db.all<{ id: string; conversation_id: string; title: string; role: string; said_at: string | null; text: string; kinds: string }>(
        `SELECT p.id, p.conversation_id, c.title, p.role, p.said_at, p.text, p.kinds
           FROM memory_passages p
           JOIN memory_topic_members m ON m.conversation_id = p.conversation_id AND m.topic_id = ?
           JOIN memory_conversations c ON c.id = p.conversation_id
          WHERE p.owner_user_id = ? ${role === 'USER' ? "AND p.role = 'USER'" : ''} AND (${terms.map(() => 'p.terms LIKE ?').join(' OR ')})
          ORDER BY p.said_at LIMIT 300`,
        [topicId, ownerId, ...terms.map((t) => `% ${t} %`)],
      )
    : [];
  const conversations = await db.all<{ id: string; title: string; first_said_at: string | null }>(
    `SELECT c.id, c.title, c.first_said_at FROM memory_topic_members m JOIN memory_conversations c ON c.id = m.conversation_id
      WHERE m.topic_id = ? ORDER BY c.first_said_at LIMIT 200`,
    [topicId],
  );
  const ideas = await db.all<{ id: string; title: string; state: string }>(
    `SELECT i.id, i.title, i.state FROM memory_idea_links l JOIN memory_ideas i ON i.id = l.idea_id
      WHERE l.to_kind = 'TOPIC' AND l.to_id = ? AND i.owner_user_id = ? ORDER BY i.cue_strength DESC LIMIT 50`,
    [topicId, ownerId],
  );
  const children = await db.all<{ id: string; label: string; conversation_count: number }>(
    `SELECT id, label, conversation_count FROM memory_topics WHERE parent_topic_id = ? AND state = 'ACTIVE' ORDER BY conversation_count DESC`,
    [topicId],
  );
  return {
    topic: { id: topic.id, label: topic.label, terms: parseJson<string[]>(topic.terms, []), parentId: topic.parent_topic_id, conversations: Number(topic.conversation_count) },
    history: history.map((h) => ({
      passageId: h.id, conversationId: h.conversation_id, conversationTitle: h.title, role: h.role, saidAt: h.said_at,
      excerpt: h.text.length > 500 ? `${h.text.slice(0, 497)}…` : h.text, kinds: h.kinds.trim() ? h.kinds.trim().split(/\s+/) : [],
    })),
    conversations: conversations.map((c) => ({ id: c.id, title: c.title, firstSaidAt: c.first_said_at })),
    ideas,
    children: children.map((c) => ({ id: c.id, label: c.label, conversations: Number(c.conversation_count) })),
  };
}

function like(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`).toLowerCase()}%`;
}

export interface MemorySearchHit {
  kind: 'PASSAGE' | 'IDEA' | 'TOPIC' | 'CONVERSATION';
  id: string;
  title: string;
  excerpt: string;
  saidAt: string | null;
  conversationId: string | null;
  role: string | null;
}

/**
 * Search the whole history: passages, ideas, topics and conversation titles,
 * optionally bounded by date and speaker, ordered by when it was said.
 */
export async function searchMemory(
  ownerId: string,
  input: { q: string; from?: string | null; to?: string | null; role?: 'USER' | 'ASSISTANT' | null; order?: 'NEWEST' | 'OLDEST'; limit?: number },
): Promise<{ hits: MemorySearchHit[]; truncated: boolean }> {
  const q = input.q.trim();
  if (q.length < 2) return { hits: [], truncated: false };
  const db = getDb();
  const limit = Math.min(200, input.limit ?? 60);
  const words = tokens(q);
  const order = input.order === 'OLDEST' ? 'ASC' : 'DESC';
  const where = ['p.owner_user_id = ?'];
  const params: unknown[] = [ownerId];
  // Every word must appear (in any order); a quoted phrase-like query also matches literally.
  if (words.length > 0) {
    for (const w of words.slice(0, 6)) {
      where.push(`LOWER(p.text) LIKE ? ESCAPE '\\'`);
      params.push(like(w));
    }
  } else {
    where.push(`LOWER(p.text) LIKE ? ESCAPE '\\'`);
    params.push(like(q));
  }
  if (input.from) {
    where.push('p.said_at >= ?');
    params.push(input.from);
  }
  if (input.to) {
    where.push('p.said_at <= ?');
    params.push(input.to);
  }
  if (input.role) {
    where.push('p.role = ?');
    params.push(input.role);
  }
  params.push(limit + 1);
  const passages = await db.all<{ id: string; conversation_id: string; title: string; text: string; said_at: string | null; role: string }>(
    `SELECT p.id, p.conversation_id, c.title, p.text, p.said_at, p.role
       FROM memory_passages p JOIN memory_conversations c ON c.id = p.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.said_at ${order} LIMIT ?`,
    params as never[],
  );
  const truncated = passages.length > limit;
  const hits: MemorySearchHit[] = [];
  const pattern = like(q);
  for (const i of await db.all<{ id: string; title: string; statement: string; last_seen_at: string | null }>(
    `SELECT id, title, statement, last_seen_at FROM memory_ideas
      WHERE owner_user_id = ? AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(statement) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(owner_intent, '')) LIKE ? ESCAPE '\\')
      ORDER BY last_seen_at DESC LIMIT 20`,
    [ownerId, pattern, pattern, pattern],
  )) hits.push({ kind: 'IDEA', id: i.id, title: i.title, excerpt: i.statement.slice(0, 300), saidAt: i.last_seen_at, conversationId: null, role: null });
  for (const t of await db.all<{ id: string; label: string; last_seen_at: string | null; conversation_count: number }>(
    `SELECT id, label, last_seen_at, conversation_count FROM memory_topics WHERE owner_user_id = ? AND state = 'ACTIVE' AND LOWER(label) LIKE ? ESCAPE '\\' LIMIT 10`,
    [ownerId, pattern],
  )) hits.push({ kind: 'TOPIC', id: t.id, title: t.label, excerpt: `${t.conversation_count} conversations`, saidAt: t.last_seen_at, conversationId: null, role: null });
  for (const c of await db.all<{ id: string; title: string; last_said_at: string | null }>(
    `SELECT id, title, last_said_at FROM memory_conversations WHERE owner_user_id = ? AND LOWER(title) LIKE ? ESCAPE '\\' ORDER BY last_said_at DESC LIMIT 20`,
    [ownerId, pattern],
  )) hits.push({ kind: 'CONVERSATION', id: c.id, title: c.title, excerpt: '', saidAt: c.last_said_at, conversationId: c.id, role: null });
  for (const p of passages.slice(0, limit)) {
    hits.push({
      kind: 'PASSAGE', id: p.id, title: p.title, excerpt: p.text.length > 400 ? `${p.text.slice(0, 397)}…` : p.text,
      saidAt: p.said_at, conversationId: p.conversation_id, role: p.role,
    });
  }
  return { hits, truncated };
}

export interface HubView {
  id: string;
  kind: string;
  title: string;
  state: string;
  evidence: unknown;
  draftPlan: string;
  projectId: string | null;
  updatedAt: string;
}

export async function listHubs(ownerId: string): Promise<HubView[]> {
  const rows = await getDb().all<{ id: string; kind: string; title: string; state: string; evidence: string; draft_plan: string; project_id: string | null; updated_at: string }>(
    'SELECT id, kind, title, state, evidence, draft_plan, project_id, updated_at FROM memory_hubs WHERE owner_user_id = ? ORDER BY updated_at DESC',
    [ownerId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, state: r.state, evidence: parseJson(r.evidence, {}), draftPlan: r.draft_plan, projectId: r.project_id, updatedAt: r.updated_at }));
}
