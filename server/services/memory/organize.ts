/**
 * Organization that the material decides.
 *
 * No taxonomy is declared anywhere. Topics are the subject terms the archive
 * itself repeats across conversations, weighted by how distinctive they are
 * (a word in every conversation is not a subject). Then the structure adapts:
 *
 *   * two topics covering nearly the same conversations are **merged**, and the
 *     merge is an event with both sides named;
 *   * a topic grown too broad to be useful is **split** into subtopics drawn
 *     from the terms that divide its own conversations;
 *   * a conversation belongs to **every** topic it bears on — membership is
 *     many-to-many, and the conversation itself stays one unified record.
 *
 * Identity is stable: a topic's key is its sorted term set, so re-organizing an
 * unchanged archive produces the same topics, and a topic that stops appearing
 * is retired rather than deleted.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { recordMemoryEvent } from './events.ts';

const TOPICS_PER_CONVERSATION = 6;
const MERGE_JACCARD = 0.6;
const MAX_CANDIDATE_TOPICS = 600;
const CHILDREN_PER_SPLIT = 6;

interface ConversationTerms {
  id: string;
  first: string | null;
  last: string | null;
  weights: Map<string, number>;
}

interface DraftTopic {
  key: string;
  terms: string[];
  label: string;
  members: Set<string>;
  parentKey: string | null;
  mergedFrom: string[];
}

export function labelOf(terms: readonly string[]): string {
  const pretty = (t: string): string => {
    const words = t.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  return terms.slice(0, 2).map(pretty).join(' · ');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}

/** The pure part: conversations' term weights in, topics out. Exported for tests. */
export function discoverTopics(conversations: ConversationTerms[]): DraftTopic[] {
  const n = conversations.length;
  if (n === 0) return [];
  const df = new Map<string, number>();
  for (const c of conversations) for (const term of c.weights.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const minDf = n < 4 ? 1 : 2;
  // A term in nearly every conversation describes the archive, not a subject
  // in it. Generous on purpose: a person whose history is mostly film must
  // still get a film topic.
  const maxDf = Math.max(3, Math.floor(n * 0.8));
  const idf = (term: string): number => Math.log(1 + n / (df.get(term) ?? 1));

  const members = new Map<string, Set<string>>();
  for (const c of conversations) {
    const ranked = [...c.weights.entries()]
      .filter(([term]) => {
        const d = df.get(term) ?? 0;
        return d >= minDf && (d <= maxDf || n < 4);
      })
      .map(([term, weight]) => [term, weight * idf(term) * (term.includes(' ') ? 1.3 : 1)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOPICS_PER_CONVERSATION);
    for (const [term] of ranked) {
      const set = members.get(term) ?? new Set<string>();
      set.add(c.id);
      members.set(term, set);
    }
  }

  let drafts: DraftTopic[] = [...members.entries()]
    .filter(([, set]) => set.size >= minDf)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, MAX_CANDIDATE_TOPICS)
    .map(([term, set]) => ({
      key: term,
      terms: [term],
      label: labelOf([term]),
      members: new Set(set),
      parentKey: null,
      mergedFrom: [],
    }));

  // Merge overlapping categories, larger absorbing smaller.
  const merged: DraftTopic[] = [];
  for (const draft of drafts) {
    const host = merged.find((m) => jaccard(m.members, draft.members) >= MERGE_JACCARD);
    if (host) {
      // The host's own earlier single-term identity is absorbed too.
      if (host.mergedFrom.length === 0) host.mergedFrom.push(host.key);
      host.terms.push(...draft.terms);
      for (const id of draft.members) host.members.add(id);
      host.mergedFrom.push(draft.key);
      continue;
    }
    merged.push(draft);
  }
  for (const topic of merged) {
    // Prefer a two-word term as the name: it is the more specific subject.
    topic.terms.sort((a, b) => Number(b.includes(' ')) - Number(a.includes(' ')));
    topic.key = [...topic.terms].sort().join('+');
    topic.label = labelOf(topic.terms);
  }
  drafts = merged;

  // Split categories that became too broad to navigate.
  const broad = Math.max(12, Math.floor(n * 0.25));
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const children: DraftTopic[] = [];
  for (const topic of drafts) {
    if (topic.members.size <= broad) continue;
    const inside = new Map<string, Set<string>>();
    for (const id of topic.members) {
      for (const term of byId.get(id)?.weights.keys() ?? []) {
        if (topic.terms.includes(term)) continue;
        const set = inside.get(term) ?? new Set<string>();
        set.add(id);
        inside.set(term, set);
      }
    }
    const candidates = [...inside.entries()]
      .filter(([, set]) => set.size >= 3 && set.size <= topic.members.size * 0.6)
      .sort((a, b) => b[1].size - a[1].size);
    const chosen: [string, Set<string>][] = [];
    for (const candidate of candidates) {
      if (chosen.length >= CHILDREN_PER_SPLIT) break;
      if (chosen.some(([, set]) => jaccard(set, candidate[1]) >= 0.5)) continue;
      chosen.push(candidate);
    }
    for (const [term, set] of chosen) {
      children.push({
        key: `${topic.key}>${term}`,
        terms: [term],
        label: labelOf([term]),
        members: set,
        parentKey: topic.key,
        mergedFrom: [],
      });
    }
  }
  return [...drafts, ...children];
}

interface TopicRow {
  id: string;
  topic_key: string;
  state: string;
  parent_topic_id: string | null;
}

export interface OrganizeReport {
  conversations: number;
  topics: number;
  created: number;
  retired: number;
  merges: number;
  splits: number;
}

export async function organizeOwner(ownerId: string): Promise<OrganizeReport> {
  const db = getDb();
  const rows = await db.all<{ id: string; terms: string; first_said_at: string | null; last_said_at: string | null }>(
    'SELECT id, terms, first_said_at, last_said_at FROM memory_conversations WHERE owner_user_id = ? AND indexed_version > 0',
    [ownerId],
  );
  const conversations: ConversationTerms[] = rows.map((r) => ({
    id: r.id,
    first: r.first_said_at,
    last: r.last_said_at,
    weights: new Map(parseJson<[string, number][]>(r.terms, [])),
  }));
  const drafts = discoverTopics(conversations);
  const when = new Map(conversations.map((c) => [c.id, { first: c.first, last: c.last }]));

  const existing = await db.all<TopicRow>(
    'SELECT id, topic_key, state, parent_topic_id FROM memory_topics WHERE owner_user_id = ?',
    [ownerId],
  );
  const byKey = new Map(existing.map((t) => [t.topic_key, t]));
  const at = nowIso();
  const report: OrganizeReport = { conversations: conversations.length, topics: drafts.length, created: 0, retired: 0, merges: 0, splits: 0 };
  const idOfKey = new Map<string, string>();

  await db.transaction(async () => {
    // Parents before children, so a child can name its parent's id.
    for (const draft of [...drafts].sort((a, b) => Number(!!a.parentKey) - Number(!!b.parentKey))) {
      const dates = [...draft.members].map((id) => when.get(id));
      const firsts = dates.map((d) => d?.first).filter((v): v is string => !!v).sort();
      const lasts = dates.map((d) => d?.last).filter((v): v is string => !!v).sort();
      const prior = byKey.get(draft.key);
      const parentId = draft.parentKey ? idOfKey.get(draft.parentKey) ?? null : null;
      let id = prior?.id;
      if (!id) {
        id = newId('mtp');
        report.created += 1;
        await db.run(
          `INSERT INTO memory_topics (id, owner_user_id, topic_key, label, terms, parent_topic_id, state,
             conversation_count, passage_count, first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 0, ?, ?, ?, ?)`,
          [id, ownerId, draft.key, draft.label, toJson(draft.terms), parentId, draft.members.size, firsts[0] ?? null, lasts[lasts.length - 1] ?? null, at, at],
        );
        await recordMemoryEvent(ownerId, 'TOPIC', id, draft.parentKey ? 'TOPIC_SPLIT_CHILD' : 'TOPIC_CREATED', {
          conversations: draft.members.size,
          parentTopicId: parentId,
        });
        if (draft.parentKey) report.splits += 1;
      } else {
        await db.run(
          `UPDATE memory_topics SET label = ?, terms = ?, parent_topic_id = ?, state = 'ACTIVE', merged_into_id = NULL,
             conversation_count = ?, first_seen_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
          [draft.label, toJson(draft.terms), parentId, draft.members.size, firsts[0] ?? null, lasts[lasts.length - 1] ?? null, at, id],
        );
      }
      idOfKey.set(draft.key, id);

      // Topics that this one absorbed: earlier single-term topics become MERGED.
      for (const absorbed of draft.mergedFrom) {
        const old = byKey.get(absorbed);
        if (old && old.id !== id && old.state === 'ACTIVE') {
          await db.run(`UPDATE memory_topics SET state = 'MERGED', merged_into_id = ?, updated_at = ? WHERE id = ?`, [id, at, old.id]);
          await recordMemoryEvent(ownerId, 'TOPIC', old.id, 'TOPIC_MERGED', { into: id });
          report.merges += 1;
          idOfKey.set(absorbed, id);
        }
      }

      await db.run('DELETE FROM memory_topic_members WHERE topic_id = ?', [id]);
      const memberRows = [...draft.members].map((conversationId) => [id, conversationId, null, 1, when.get(conversationId)?.first ?? null]);
      for (let i = 0; i < memberRows.length; i += 80) {
        const chunk = memberRows.slice(i, i + 80);
        await db.run(
          `INSERT INTO memory_topic_members (topic_id, conversation_id, passage_id, score, said_at)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}
           ON CONFLICT (topic_id, conversation_id) DO NOTHING`,
          chunk.flat() as never[],
        );
      }
    }

    const live = new Set(drafts.map((d) => d.key));
    for (const topic of existing) {
      if (topic.state === 'ACTIVE' && !live.has(topic.topic_key) && !idOfKey.has(topic.topic_key)) {
        await db.run(`UPDATE memory_topics SET state = 'RETIRED', updated_at = ? WHERE id = ?`, [at, topic.id]);
        await db.run('DELETE FROM memory_topic_members WHERE topic_id = ?', [topic.id]);
        await recordMemoryEvent(ownerId, 'TOPIC', topic.id, 'TOPIC_RETIRED', {});
        report.retired += 1;
      }
    }
  });
  return report;
}
