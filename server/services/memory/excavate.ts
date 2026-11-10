/**
 * Excavation: the registry of ideas, goals and projects, dug out of the
 * person's own words, and the reconstruction of what happened to each.
 *
 * Two rules shape everything here.
 *
 * **Frequency is not importance.** Every passage in which the person states an
 * intention seeds or joins an idea, however rarely it was said. A once-mentioned
 * idea is a full registry row with its source, and its weight in rediscovery
 * comes from how plainly it was wanted (`cue_strength`), not from a count.
 *
 * **Silence is not abandonment.** An idea's state is the last thing the record
 * actually says about it — pursued, paused, given up, finished, replaced — and
 * an idea the record says nothing further about is UNRESOLVED, never "dropped".
 * A later statement overrides an earlier one; the earlier one stays in the
 * evidence and in the idea's versions. And a decision the person makes in Brain
 * outranks anything inferred from the archive.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { cueSentence, tokens, type PassageKind } from './classify.ts';
import { recordMemoryEvent } from './events.ts';

export const IDEA_KINDS = [
  'GOAL', 'BUSINESS', 'FINANCIAL', 'CREATIVE', 'PROJECT', 'QUESTION', 'DECISION', 'AMBITION', 'PLAN', 'COMMITMENT', 'INTEREST',
] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];
export type IdeaState = 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'REJECTED' | 'SUPERSEDED' | 'UNRESOLVED';
export type EvidenceStage =
  | 'ORIGIN' | 'DEVELOPMENT' | 'ALTERNATIVE' | 'OBSTACLE' | 'PURSUIT' | 'DIRECTION_CHANGE' | 'PAUSE' | 'REJECTION' | 'COMPLETION' | 'MENTION';

/** Words a statement of intent is made of, rather than what it is about. */
const INTENT_WORDS = new Set(
  'build create write launch open plan plans planning goal goals dream dreams someday hope hoping become start starting ' +
    'eventually decided decide deciding committed commit serious trying try aim aiming intend wanna gonna really definitely ' +
    'finally actually also maybe should could would just own whole life always wanted thinking idea concept project app ' +
    'business company money make made doing done next first step steps lot little bit big huge kind sort'.split(/\s+/),
);

/** The subject words of an intention, in the order said. Exported for tests. */
export function signatureOf(sentence: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of tokens(sentence)) {
    if (INTENT_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 6) break;
  }
  return out;
}

/** Whether two signatures name the same idea. */
export function sameIdea(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  const union = new Set([...a, ...b]).size;
  if (shared >= 3) return true;
  if (Math.min(a.length, b.length) <= 2) return shared >= Math.min(a.length, b.length) && shared >= 1 && shared / union >= 0.5;
  return shared / union >= 0.5;
}

export function kindOfMention(kinds: readonly PassageKind[], text: string): IdeaKind {
  const has = (k: PassageKind): boolean => kinds.includes(k);
  if (has('BUSINESS')) return 'BUSINESS';
  if (has('FINANCIAL')) return 'FINANCIAL';
  if (has('CREATIVE') && (has('IDEA') || has('PROJECT') || has('GOAL'))) return 'CREATIVE';
  if (has('PROJECT')) return 'PROJECT';
  if (has('GOAL')) {
    return /\b(?:someday|one day|dream|always wanted|eventually|long[- ]term|my whole life|for years)\b/i.test(text) ? 'AMBITION' : 'GOAL';
  }
  if (has('COMMITMENT')) return 'COMMITMENT';
  if (has('PLAN')) return 'PLAN';
  if (has('DECISION')) return 'DECISION';
  if (has('QUESTION')) return 'QUESTION';
  return 'INTEREST';
}

export function stageOf(kinds: readonly string[]): EvidenceStage {
  if (kinds.includes('REJECTION')) return 'REJECTION';
  if (kinds.includes('COMPLETION')) return 'COMPLETION';
  if (kinds.includes('PAUSE')) return 'PAUSE';
  if (kinds.includes('DIRECTION_CHANGE')) return 'DIRECTION_CHANGE';
  if (kinds.includes('OBSTACLE')) return 'OBSTACLE';
  if (kinds.includes('PROGRESS')) return 'PURSUIT';
  if (kinds.includes('DECISION') || kinds.includes('QUESTION')) return 'ALTERNATIVE';
  if (kinds.some((k) => ['GOAL', 'IDEA', 'PROJECT', 'PLAN', 'COMMITMENT'].includes(k))) return 'DEVELOPMENT';
  return 'MENTION';
}

function kindsOf(padded: string): string[] {
  return padded.trim() ? padded.trim().split(/\s+/) : [];
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 600 ? `${flat.slice(0, 597)}…` : flat;
}

const SEEDING = ['GOAL', 'IDEA', 'PROJECT', 'COMMITMENT', 'PLAN', 'DECISION', 'QUESTION'];

interface IdeaIndexEntry {
  id: string;
  signature: string[];
}

async function loadIdeaIndex(ownerId: string): Promise<IdeaIndexEntry[]> {
  const rows = await getDb().all<{ id: string; signature: string }>(
    'SELECT id, signature FROM memory_ideas WHERE owner_user_id = ?',
    [ownerId],
  );
  return rows.map((r) => ({ id: r.id, signature: r.signature.split(' ').filter(Boolean) }));
}

interface PassageRow {
  id: string;
  conversation_id: string;
  text: string;
  said_at: string | null;
  kinds: string;
  facets: string;
  role: string;
}

/**
 * Read one conversation's own statements of intent into the registry.
 *
 * Each statement either joins the idea it repeats or founds a new one. Distinct
 * ideas inside one conversation stay distinct, because they are matched by
 * what they are about rather than by where they were said.
 */
export async function excavateConversation(conversationId: string, index?: IdeaIndexEntry[]): Promise<{ ideasTouched: string[]; created: number }> {
  const db = getDb();
  const conversation = await db.get<{ owner_user_id: string; indexed_version: number }>(
    'SELECT owner_user_id, indexed_version FROM memory_conversations WHERE id = ?',
    [conversationId],
  );
  if (!conversation) return { ideasTouched: [], created: 0 };
  const ownerId = conversation.owner_user_id;
  const ideas = index ?? (await loadIdeaIndex(ownerId));
  const passages = await db.all<PassageRow>(
    `SELECT id, conversation_id, text, said_at, kinds, facets, role FROM memory_passages
      WHERE conversation_id = ? AND role = 'USER' ORDER BY said_at, seq`,
    [conversationId],
  );
  const touched = new Set<string>();
  let created = 0;
  const at = nowIso();
  for (const passage of passages) {
    const kinds = kindsOf(passage.kinds);
    if (!kinds.some((k) => SEEDING.includes(k))) continue;
    const sentence = cueSentence(passage.text);
    const signature = signatureOf(sentence);
    if (signature.length === 0) continue;
    let idea = ideas.find((i) => sameIdea(i.signature, signature));
    if (!idea) {
      const id = newId('mid');
      const kind = kindOfMention(kinds as PassageKind[], passage.text);
      const sigKey = [...signature].sort().join(' ');
      const domains = kindsOf(passage.facets).filter((f) => f.startsWith('DOMAIN_')).map((f) => f.slice(7));
      const inserted = await db.run(
        `INSERT INTO memory_ideas (id, owner_user_id, kind, title, statement, signature, domain, state, state_basis,
           first_seen_at, last_seen_at, conversation_count, mention_count, user_words, cue_strength, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UNRESOLVED', ?, ?, ?, 1, 1, ?, 0, ?, ?)
         ON CONFLICT (owner_user_id, signature) DO NOTHING`,
        [
          id, ownerId, kind, sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence, excerpt(passage.text),
          sigKey, domains[0] ?? null, 'No outcome has been recorded yet.', passage.said_at, passage.said_at,
          passage.text.split(/\s+/).length, at, at,
        ],
      );
      if (Number(inserted.changes) === 0) {
        const existing = await db.get<{ id: string }>('SELECT id FROM memory_ideas WHERE owner_user_id = ? AND signature = ?', [ownerId, sigKey]);
        if (!existing) continue;
        idea = { id: existing.id, signature };
      } else {
        idea = { id, signature };
        ideas.push(idea);
        created += 1;
        await db.run(
          `INSERT INTO memory_idea_versions (idea_id, version, snapshot, reason, created_at) VALUES (?, 1, ?, ?, ?)`,
          [id, toJson({ kind, title: sentence, state: 'UNRESOLVED' }), 'First found in the archive.', at],
        );
        await recordMemoryEvent(ownerId, 'IDEA', id, 'IDEA_FOUND', { conversationId, kind });
      }
    }
    await db.run(
      `INSERT INTO memory_idea_evidence (idea_id, passage_id, conversation_id, stage, said_at, excerpt, direct, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (idea_id, passage_id) DO NOTHING`,
      [idea.id, passage.id, passage.conversation_id, stageOf(kinds), passage.said_at, excerpt(passage.text), at],
    );
    touched.add(idea.id);
  }
  if (touched.size > 0) {
    await db.run(
      `UPDATE memory_ideas SET evidence_changed_at = ? WHERE id IN (${[...touched].map(() => '?').join(',')})`,
      [at, ...touched],
    );
  }
  await db.run('UPDATE memory_conversations SET excavated_version = indexed_version WHERE id = ?', [conversationId]);
  return { ideasTouched: [...touched], created };
}

export async function conversationsToExcavate(ownerId: string | null, limit: number): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM memory_conversations
      WHERE ${ownerId ? 'owner_user_id = ? AND' : ''} excavated_version < indexed_version
      ORDER BY last_said_at DESC LIMIT ?`,
    ownerId ? [ownerId, limit] : [limit],
  );
  return rows.map((r) => r.id);
}

export { loadIdeaIndex };

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------
interface IdeaRow {
  id: string;
  owner_user_id: string;
  kind: IdeaKind;
  title: string;
  signature: string;
  state: IdeaState;
  state_basis: string;
  owner_state: IdeaState | null;
  superseded_by_id: string | null;
  version: number;
  conversation_count: number;
  mention_count: number;
}

interface EvidenceRow {
  passage_id: string;
  conversation_id: string;
  stage: EvidenceStage;
  said_at: string | null;
  direct: number;
  excerpt: string;
  text: string;
  kinds: string;
  facets: string;
}

const MAX_RELATED = 200;

/**
 * Reconstruct one idea's history from the whole archive and derive its state.
 *
 * Related discussion is found by its subject words in the person's own
 * passages across every conversation, so the history includes the later talk
 * that never repeated the original sentence.
 */
export async function reconstructIdea(ideaId: string): Promise<{ changed: boolean }> {
  const db = getDb();
  const idea = await db.get<IdeaRow>('SELECT * FROM memory_ideas WHERE id = ?', [ideaId]);
  if (!idea) return { changed: false };
  const signature = idea.signature.split(' ').filter(Boolean);
  const at = nowIso();

  // Candidates carry at least one of the three most specific words (longest
  // first: a cheap proxy for rarity that needs no archive-wide statistics);
  // the filter below then requires two shared words.
  const probe = [...signature].sort((a, b) => b.length - a.length).slice(0, 3);
  if (probe.length > 0) {
    const related = await db.all<{ id: string; conversation_id: string; text: string; said_at: string | null; kinds: string }>(
      `SELECT id, conversation_id, text, said_at, kinds FROM memory_passages
        WHERE owner_user_id = ? AND role = 'USER'
          AND (${probe.map(() => 'terms LIKE ?').join(' OR ')})
        ORDER BY said_at LIMIT ?`,
      [idea.owner_user_id, ...probe.map((t) => `% ${t} %`), MAX_RELATED],
    );
    for (const passage of related) {
      const words = new Set(tokens(passage.text));
      const shared = signature.filter((t) => words.has(t)).length;
      if (shared < Math.min(2, signature.length)) continue;
      await db.run(
        `INSERT INTO memory_idea_evidence (idea_id, passage_id, conversation_id, stage, said_at, excerpt, direct, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (idea_id, passage_id) DO NOTHING`,
        [idea.id, passage.id, passage.conversation_id, stageOf(kindsOf(passage.kinds)), passage.said_at, excerpt(passage.text), at],
      );
    }
  }

  const evidence = await db.all<EvidenceRow>(
    `SELECT e.passage_id, e.conversation_id, e.stage, e.said_at, e.direct, e.excerpt, p.text, p.kinds, p.facets
       FROM memory_idea_evidence e JOIN memory_passages p ON p.id = e.passage_id
      WHERE e.idea_id = ?
      ORDER BY e.said_at, e.created_at`,
    [idea.id],
  );
  if (evidence.length === 0) return { changed: false };

  // The earliest piece is the origin; it keeps its own kind in `kinds`.
  const origin = evidence[0]!;
  if (origin.stage !== 'ORIGIN') {
    await db.run(`UPDATE memory_idea_evidence SET stage = 'ORIGIN' WHERE idea_id = ? AND passage_id = ?`, [idea.id, origin.passage_id]);
    await db.run(`UPDATE memory_idea_evidence SET stage = ? WHERE idea_id = ? AND stage = 'ORIGIN' AND passage_id <> ?`, [
      'DEVELOPMENT', idea.id, origin.passage_id,
    ]);
  }

  // Derived state: the last thing the record says.
  let state: IdeaState = 'UNRESOLVED';
  let basis = 'Nothing in the archive records what happened to this after it was raised.';
  let statePassage: string | null = null;
  let supersededBy: string | null = null;
  for (const piece of evidence.slice(1)) {
    const stage = stageOf(kindsOf(piece.kinds));
    const when = piece.said_at?.slice(0, 10) ?? 'an unknown date';
    if (stage === 'REJECTION') {
      state = 'REJECTED';
      basis = `On ${when} you said you were giving this up.`;
      statePassage = piece.passage_id;
    } else if (stage === 'COMPLETION') {
      state = 'COMPLETED';
      basis = `On ${when} you said this was done.`;
      statePassage = piece.passage_id;
    } else if (stage === 'PAUSE') {
      state = 'PAUSED';
      basis = `On ${when} you put this on hold.`;
      statePassage = piece.passage_id;
    } else if (stage === 'PURSUIT') {
      state = 'ACTIVE';
      basis = `On ${when} you described working on it; nothing later says otherwise.`;
      statePassage = piece.passage_id;
    } else if (stage === 'DIRECTION_CHANGE') {
      const successor = await db.get<{ id: string }>(
        `SELECT e.idea_id AS id FROM memory_idea_evidence e
          WHERE e.passage_id = ? AND e.idea_id <> ? AND e.direct = 1 LIMIT 1`,
        [piece.passage_id, idea.id],
      );
      if (successor) {
        state = 'SUPERSEDED';
        basis = `On ${when} you changed direction to a different idea.`;
        statePassage = piece.passage_id;
        supersededBy = successor.id;
      }
    }
  }
  // The origin passage itself can carry an outcome ("I launched my store").
  if (evidence.length === 1) {
    const stage = stageOf(kindsOf(origin.kinds));
    if (stage === 'PURSUIT') {
      state = 'ACTIVE';
      basis = `When you raised it (${origin.said_at?.slice(0, 10) ?? 'unknown date'}) you were already working on it.`;
      statePassage = origin.passage_id;
    }
  }
  // A decision made in Brain is the person's current word and outranks the archive.
  if (idea.owner_state) {
    state = idea.owner_state;
    basis = 'You decided this in Brain; the archive is kept as history.';
  }

  const obstacles = new Set<string>();
  const questions: string[] = [];
  for (const piece of evidence) {
    for (const facet of kindsOf(piece.facets)) if (facet.startsWith('OBSTACLE_')) obstacles.add(facet.slice(9));
    if (/\?/.test(piece.text) && kindsOf(piece.kinds).some((k) => k === 'QUESTION' || k === 'DECISION')) {
      const q = piece.text.replace(/\s+/g, ' ').split(/(?<=\?)/).find((s) => s.includes('?'))?.trim();
      if (q && questions.length < 5 && !questions.includes(q)) questions.push(q.length > 240 ? `${q.slice(0, 237)}…` : q);
    }
  }
  const conversations = new Set(evidence.map((e) => e.conversation_id)).size;
  const direct = evidence.filter((e) => e.direct === 1);
  const said = evidence.map((e) => e.said_at).filter((v): v is string => !!v).sort();
  const userWords = direct.reduce((sum, e) => sum + e.text.split(/\s+/).length, 0);
  // How plainly it was wanted: the strongest single statement, not the sum.
  const strength = Math.max(...direct.map((e) => cueStrengthOf(kindsOf(e.kinds), e.text)), 0);

  const changed = state !== idea.state || conversations !== idea.conversation_count || direct.length !== idea.mention_count;
  const version = changed ? idea.version + 1 : idea.version;
  await db.run(
    `UPDATE memory_ideas SET state = ?, state_basis = ?, state_passage_id = ?, superseded_by_id = ?,
       first_seen_at = ?, last_seen_at = ?, conversation_count = ?, mention_count = ?, user_words = ?,
       cue_strength = ?, obstacles = ?, open_questions = ?, version = ?, reconstructed_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      state, basis, statePassage, supersededBy ?? idea.superseded_by_id, said[0] ?? null, said[said.length - 1] ?? null,
      conversations, direct.length, userWords, strength, toJson([...obstacles]), toJson(questions), version, at, at, idea.id,
    ],
  );
  if (changed) {
    await db.run(
      `INSERT INTO memory_idea_versions (idea_id, version, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (idea_id, version) DO NOTHING`,
      [
        idea.id, version,
        toJson({ state, basis, conversations, mentions: direct.length, previousState: idea.state }),
        state !== idea.state ? `State moved from ${idea.state} to ${state}.` : 'New related discussion was found.',
        at,
      ],
    );
    if (state !== idea.state) {
      await recordMemoryEvent(idea.owner_user_id, 'IDEA', idea.id, 'IDEA_STATE_DERIVED', { from: idea.state, to: state });
    }
  }
  if (supersededBy) {
    await linkIdeas(idea.id, 'IDEA', supersededBy, 'BRANCHED_INTO', 'A direction change in the archive led here.');
  }
  return { changed };
}

function cueStrengthOf(kinds: string[], text: string): number {
  let s = 0;
  if (kinds.includes('COMMITMENT')) s += 0.35;
  if (kinds.includes('GOAL')) s += 0.3;
  if (kinds.includes('PROJECT')) s += 0.25;
  if (kinds.includes('IDEA')) s += 0.2;
  if (kinds.includes('PLAN')) s += 0.15;
  if (kinds.includes('PROGRESS')) s += 0.2;
  if (kinds.includes('DECISION')) s += 0.1;
  if (/\b(?:my dream|always wanted|for years|my whole life|really want|seriously)\b/i.test(text)) s += 0.2;
  return Math.min(1, s);
}

export async function linkIdeas(
  ideaId: string,
  toKind: 'IDEA' | 'TOPIC' | 'PROJECT' | 'CANDIDATE' | 'HUB',
  toId: string,
  relation: 'RELATED' | 'CONNECTS' | 'BRANCHED_INTO' | 'PART_OF' | 'SUPERSEDES' | 'IN_TOPIC' | 'PROMOTED_TO',
  basis: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO memory_idea_links (idea_id, to_kind, to_id, relation, basis, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (idea_id, to_kind, to_id, relation) DO NOTHING`,
    [ideaId, toKind, toId, relation, basis, nowIso()],
  );
}

/** Ideas whose evidence moved since their history was last reconstructed. */
export async function ideasToReconstruct(ownerId: string | null, limit: number): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM memory_ideas
      WHERE ${ownerId ? 'owner_user_id = ? AND' : ''}
            (reconstructed_at IS NULL OR (evidence_changed_at IS NOT NULL AND evidence_changed_at > reconstructed_at))
      ORDER BY cue_strength DESC, last_seen_at DESC LIMIT ?`,
    ownerId ? [ownerId, limit] : [limit],
  );
  return rows.map((r) => r.id);
}

/**
 * Connect ideas to topics and to each other.
 *
 * CONNECTS is the interesting one: two ideas about the same subject that were
 * never raised in the same conversation — a link the person may never have made.
 */
export async function linkOwnerIdeas(ownerId: string): Promise<{ links: number }> {
  const db = getDb();
  const ideas = await db.all<{ id: string; signature: string }>(
    `SELECT id, signature FROM memory_ideas WHERE owner_user_id = ?`,
    [ownerId],
  );
  const topics = await db.all<{ id: string; terms: string }>(
    `SELECT id, terms FROM memory_topics WHERE owner_user_id = ? AND state = 'ACTIVE'`,
    [ownerId],
  );
  const convs = new Map<string, Set<string>>();
  for (const row of await db.all<{ idea_id: string; conversation_id: string }>(
    `SELECT DISTINCT e.idea_id, e.conversation_id FROM memory_idea_evidence e JOIN memory_ideas i ON i.id = e.idea_id
      WHERE i.owner_user_id = ?`,
    [ownerId],
  )) {
    convs.set(row.idea_id, (convs.get(row.idea_id) ?? new Set()).add(row.conversation_id));
  }
  const existing = new Set(
    (await db.all<{ idea_id: string; to_kind: string; to_id: string; relation: string }>(
      `SELECT l.idea_id, l.to_kind, l.to_id, l.relation FROM memory_idea_links l JOIN memory_ideas i ON i.id = l.idea_id
        WHERE i.owner_user_id = ?`,
      [ownerId],
    )).map((l) => `${l.idea_id}|${l.to_kind}|${l.to_id}|${l.relation}`),
  );
  let links = 0;
  const add = async (
    ideaId: string,
    toKind: 'IDEA' | 'TOPIC',
    toId: string,
    relation: 'IN_TOPIC' | 'RELATED' | 'CONNECTS',
    basis: string,
  ): Promise<void> => {
    const key = `${ideaId}|${toKind}|${toId}|${relation}`;
    if (existing.has(key)) return;
    existing.add(key);
    await linkIdeas(ideaId, toKind, toId, relation, basis);
    links += 1;
  };
  const sigs = ideas.map((i) => ({ id: i.id, words: new Set(i.signature.split(' ').filter(Boolean)) }));
  const topicsByWord = new Map<string, string[]>();
  for (const topic of topics) {
    for (const word of new Set(parseJson<string[]>(topic.terms, []).flatMap((t) => t.split(' ')))) {
      topicsByWord.set(word, [...(topicsByWord.get(word) ?? []), topic.id]);
    }
  }
  const ideasByWord = new Map<string, string[]>();
  for (const idea of sigs) {
    for (const word of idea.words) ideasByWord.set(word, [...(ideasByWord.get(word) ?? []), idea.id]);
  }
  for (const idea of sigs) {
    const inTopics = new Set<string>();
    const sharedWith = new Map<string, number>();
    for (const word of idea.words) {
      for (const topicId of topicsByWord.get(word) ?? []) inTopics.add(topicId);
      for (const other of ideasByWord.get(word) ?? []) {
        if (other !== idea.id) sharedWith.set(other, (sharedWith.get(other) ?? 0) + 1);
      }
    }
    for (const topicId of inTopics) await add(idea.id, 'TOPIC', topicId, 'IN_TOPIC', "Shares the topic's subject words.");
    for (const [other, shared] of sharedWith) {
      if (shared < 2) continue;
      const ca = convs.get(idea.id) ?? new Set<string>();
      const cb = convs.get(other) ?? new Set<string>();
      const together = [...ca].some((c) => cb.has(c));
      await add(
        idea.id,
        'IDEA',
        other,
        together ? 'RELATED' : 'CONNECTS',
        together
          ? 'Raised together and about the same subject.'
          : 'About the same subject, but never raised in the same conversation.',
      );
    }
  }
  return { links };
}
