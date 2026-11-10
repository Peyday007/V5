/**
 * Sustained commitments, and the permanent places Brain prepares for them.
 *
 * Talking about something often is not wanting to pursue it. A topic earns a
 * hub only when the record shows pursuit, measured on the person's own words:
 * breadth (distinct conversations), continuity (distinct months), statements
 * of commitment and of actual progress, the effort spent, and whether it
 * touches what Brain is working on now. A frequently discussed topic with no
 * commitment or progress is reported as *discussed* and gets nothing.
 *
 * Preparing a hub — a named knowledge area with a draft plan — is internal
 * organization, which the owner authorized. Turning one into a Brain project is
 * the person's decision (an accept), never automatic.
 */
import { getDb } from '../../db/database.ts';
import { createProject, listProjects } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { FILM_FACETS, type FilmFacet } from './classify.ts';
import { recordMemoryEvent } from './events.ts';

export type HubKind = 'MOVIE_SCHOOL' | 'CREATIVE' | 'ENGINEERING' | 'VENTURE' | 'FINANCE' | 'LEARNING' | 'PERSONAL';
export const MOVIE_SCHOOL_KEY = 'movie-school';

export interface CommitmentReading {
  topicId: string;
  topicKey: string;
  label: string;
  conversations: number;
  months: number;
  spanDays: number;
  userPassages: number;
  userWords: number;
  commitmentStatements: number;
  progressStatements: number;
  touchesCurrentWork: string[];
  domain: HubKind;
  verdict: 'PURSUED' | 'DISCUSSED';
  why: string;
}

const TOPICS_EXAMINED = 40;

const DOMAIN_TO_HUB: Record<string, HubKind> = {
  FILM: 'MOVIE_SCHOOL',
  ENGINEERING: 'ENGINEERING',
  BUSINESS: 'VENTURE',
  FINANCE: 'FINANCE',
  CREATIVE: 'CREATIVE',
  LEARNING: 'LEARNING',
  PERSONAL: 'PERSONAL',
};

/** The rule, in one place. Exported for tests. */
export function verdictOf(r: Pick<CommitmentReading, 'conversations' | 'months' | 'commitmentStatements' | 'progressStatements' | 'userPassages'>): 'PURSUED' | 'DISCUSSED' {
  const pursuit = r.commitmentStatements + r.progressStatements;
  return r.conversations >= 5 && r.months >= 2 && pursuit >= 3 && pursuit / Math.max(1, r.userPassages) >= 0.04
    ? 'PURSUED'
    : 'DISCUSSED';
}

export async function readCommitments(ownerId: string): Promise<CommitmentReading[]> {
  const db = getDb();
  const topics = await db.all<{ id: string; topic_key: string; label: string; terms: string; conversation_count: number }>(
    `SELECT id, topic_key, label, terms, conversation_count FROM memory_topics
      WHERE owner_user_id = ? AND state = 'ACTIVE' AND parent_topic_id IS NULL
      ORDER BY conversation_count DESC LIMIT ?`,
    [ownerId, TOPICS_EXAMINED],
  );
  const projects = (await listProjects()).filter((p) => p.status === 'ACTIVE');
  const out: CommitmentReading[] = [];
  for (const topic of topics) {
    const terms = parseJson<string[]>(topic.terms, []).slice(0, 3).map((t) => t.replace(/ /g, '_'));
    if (terms.length === 0) continue;
    const where = terms.map(() => 'p.terms LIKE ?').join(' OR ');
    const rows = await db.all<{ kinds: string; facets: string; text_len: number; said_at: string | null; conversation_id: string }>(
      `SELECT p.kinds, p.facets, LENGTH(p.text) AS text_len, p.said_at, p.conversation_id
         FROM memory_passages p
         JOIN memory_topic_members m ON m.conversation_id = p.conversation_id AND m.topic_id = ?
        WHERE p.owner_user_id = ? AND p.role = 'USER' AND (${where})`,
      [topic.id, ownerId, ...terms.map((t) => `% ${t} %`)],
    );
    const months = new Set(rows.map((r) => r.said_at?.slice(0, 7)).filter(Boolean));
    const dates = rows.map((r) => r.said_at).filter((v): v is string => !!v).sort();
    const spanDays = dates.length > 1 ? Math.round((Date.parse(dates[dates.length - 1]!) - Date.parse(dates[0]!)) / 86_400_000) : 0;
    const commitment = rows.filter((r) => / (COMMITMENT|GOAL|PROJECT|PLAN) /.test(r.kinds)).length;
    const progress = rows.filter((r) => / (PROGRESS|COMPLETION) /.test(r.kinds)).length;
    const domainCounts = new Map<string, number>();
    for (const r of rows) {
      for (const f of r.facets.trim().split(/\s+/)) {
        if (f.startsWith('DOMAIN_')) domainCounts.set(f.slice(7), (domainCounts.get(f.slice(7)) ?? 0) + 1);
      }
    }
    const top = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'LEARNING';
    const words = terms.map((t) => t.replace(/_/g, ' ').toLowerCase());
    const touches = projects
      .filter((p) => words.some((w) => `${p.name} ${p.description ?? ''} ${p.northStar ?? ''}`.toLowerCase().includes(w)))
      .map((p) => p.name)
      .slice(0, 5);
    const reading: CommitmentReading = {
      topicId: topic.id,
      topicKey: topic.topic_key,
      label: topic.label,
      conversations: new Set(rows.map((r) => r.conversation_id)).size,
      months: months.size,
      spanDays,
      userPassages: rows.length,
      userWords: Math.round(rows.reduce((s, r) => s + Number(r.text_len), 0) / 5.5),
      commitmentStatements: commitment,
      progressStatements: progress,
      touchesCurrentWork: touches,
      domain: DOMAIN_TO_HUB[top] ?? 'LEARNING',
      verdict: 'DISCUSSED',
      why: '',
    };
    reading.verdict = verdictOf(reading);
    reading.why =
      reading.verdict === 'PURSUED'
        ? `${reading.conversations} conversations over ${reading.months} months, with ${commitment} statements of intent and ${progress} of progress in your own words.`
        : `Discussed in ${reading.conversations} conversations, but with ${commitment} statements of intent and ${progress} of progress — talked about more than pursued.`;
    out.push(reading);
  }
  return out;
}

function draftPlanFor(reading: CommitmentReading, openIdeas: { title: string; state: string }[]): string {
  const lines = [
    `# ${reading.label}`,
    '',
    `Why this exists: ${reading.why}`,
    reading.touchesCurrentWork.length ? `Connects to current work: ${reading.touchesCurrentWork.join(', ')}.` : 'Not yet connected to a current Brain project.',
    '',
    '## What the history already holds',
    `- ${reading.conversations} conversations, first-to-last span ${reading.spanDays} days.`,
    '',
    '## Open ideas and goals in this area',
    ...(openIdeas.length ? openIdeas.map((i) => `- ${i.title} (${i.state.toLowerCase()})`) : ['- None recorded yet.']),
    '',
    '## Draft next steps (for your review — nothing has been started)',
    '1. Confirm this is still something you want to pursue.',
    '2. Choose the one open idea above that matters most now.',
    '3. Turn it into a concrete plan from the Discoveries page (option B).',
  ];
  return lines.join('\n');
}

/**
 * Propose and prepare hubs for every PURSUED commitment, and Movie School
 * whenever the history holds filmmaking material at all.
 */
export async function refreshHubs(ownerId: string): Promise<{ prepared: number; readings: CommitmentReading[] }> {
  const db = getDb();
  const readings = await readCommitments(ownerId);
  let prepared = 0;
  const at = nowIso();
  for (const reading of readings.filter((r) => r.verdict === 'PURSUED')) {
    const ideas = await db.all<{ title: string; state: string }>(
      `SELECT i.title, i.state FROM memory_ideas i JOIN memory_idea_links l ON l.idea_id = i.id
        WHERE i.owner_user_id = ? AND l.to_kind = 'TOPIC' AND l.to_id = ? AND i.state IN ('UNRESOLVED','PAUSED','ACTIVE')
        ORDER BY i.cue_strength DESC LIMIT 12`,
      [ownerId, reading.topicId],
    );
    const kind: HubKind = reading.domain;
    const key = kind === 'MOVIE_SCHOOL' ? MOVIE_SCHOOL_KEY : reading.topicKey;
    const plan = draftPlanFor(reading, ideas);
    const inserted = await db.run(
      `INSERT INTO memory_hubs (id, owner_user_id, kind, topic_key, title, state, evidence, draft_plan, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, topic_key) DO NOTHING`,
      [newId('mhb'), ownerId, kind, key, kind === 'MOVIE_SCHOOL' ? 'Movie School' : reading.label, toJson(reading), plan, at, at],
    );
    if (Number(inserted.changes) > 0) {
      prepared += 1;
      await recordMemoryEvent(ownerId, 'HUB', key, 'HUB_PREPARED', { kind, conversations: reading.conversations, months: reading.months });
    } else {
      await db.run(
        `UPDATE memory_hubs SET evidence = ?, draft_plan = CASE WHEN state IN ('PROPOSED','PREPARED') THEN ? ELSE draft_plan END, updated_at = ?
          WHERE owner_user_id = ? AND topic_key = ?`,
        [toJson(reading), plan, at, ownerId, key],
      );
    }
  }

  // Movie School is prepared as the first application whenever there is film
  // material at all — it is the foundation, not a claim of commitment.
  const film = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memory_passages WHERE owner_user_id = ? AND facets LIKE '% DOMAIN_FILM %'`,
    [ownerId],
  );
  if (Number(film?.n ?? 0) > 0) {
    const inserted = await db.run(
      `INSERT INTO memory_hubs (id, owner_user_id, kind, topic_key, title, state, evidence, draft_plan, created_at, updated_at)
       VALUES (?, ?, 'MOVIE_SCHOOL', ?, 'Movie School', 'PREPARED', ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, topic_key) DO NOTHING`,
      [
        newId('mhb'), ownerId, MOVIE_SCHOOL_KEY, toJson({ filmPassages: Number(film?.n ?? 0) }),
        'Movie School builds on what your history already holds. See the foundation for what was found.', at, at,
      ],
    );
    if (Number(inserted.changes) > 0) {
      prepared += 1;
      await recordMemoryEvent(ownerId, 'HUB', MOVIE_SCHOOL_KEY, 'HUB_PREPARED', { kind: 'MOVIE_SCHOOL' });
    }
  }
  return { prepared, readings };
}

// ---------------------------------------------------------------------------
// Movie School's foundation
// ---------------------------------------------------------------------------
export interface FilmPassage {
  passageId: string;
  conversationId: string;
  conversationTitle: string;
  role: string;
  saidAt: string | null;
  excerpt: string;
}

export interface MovieSchoolFoundation {
  hub: { id: string; state: string; title: string } | null;
  /** Historical knowledge, by facet, newest first. Read-only history. */
  facets: { facet: FilmFacet; label: string; distinction: string; count: number; examples: FilmPassage[] }[];
  /** Film ideas and projects from the registry, each with its own state. */
  concepts: { id: string; title: string; state: string; firstSeenAt: string | null; lastSeenAt: string | null }[];
  /** Separate from the archive: future learning, practice and assessment. */
  practice: { id: string; kind: string; title: string; body: string; state: string; createdAt: string }[];
  /** What this is not. */
  caveat: string;
  totals: { filmPassages: number; filmConversations: number; yourPassages: number };
}

const FACET_WORDS: Record<FilmFacet, { label: string; distinction: string }> = {
  FILM_OPINION: { label: 'Films you reacted to', distinction: 'Opinions about other people\'s films — your taste, not your projects.' },
  DIRECTING: { label: 'Directing', distinction: 'Discussion of directing craft.' },
  SCREENWRITING: { label: 'Screenwriting & structure', distinction: 'Discussion of scripts, structure and dialogue.' },
  CHARACTER_THEME: { label: 'Character & theme', distinction: 'Discussion of character, arc and theme.' },
  FILM_CONCEPT: { label: 'Film concepts', distinction: 'Ideas for films — concepts, not yet commitments.' },
  CREATIVE_STANDARD: { label: 'Your creative standards', distinction: 'What you said you want your work to be.' },
  EXERCISE: { label: 'Exercises & learning goals', distinction: 'Practice and learning you discussed before.' },
  PROJECT_REVISION: { label: 'Revisions & abandoned directions', distinction: 'Drafts, rewrites and directions you changed.' },
};

export async function movieSchoolFoundation(ownerId: string): Promise<MovieSchoolFoundation> {
  const db = getDb();
  const hub = await db.get<{ id: string; state: string; title: string }>(
    'SELECT id, state, title FROM memory_hubs WHERE owner_user_id = ? AND topic_key = ?',
    [ownerId, MOVIE_SCHOOL_KEY],
  );
  const facets: MovieSchoolFoundation['facets'] = [];
  for (const facet of FILM_FACETS) {
    const count = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_passages WHERE owner_user_id = ? AND facets LIKE ?`,
      [ownerId, `% ${facet} %`],
    );
    // Your own words first: an assistant's lecture is context, not your history.
    const examples = await db.all<{ id: string; conversation_id: string; title: string; role: string; said_at: string | null; text: string }>(
      `SELECT p.id, p.conversation_id, c.title, p.role, p.said_at, p.text
         FROM memory_passages p JOIN memory_conversations c ON c.id = p.conversation_id
        WHERE p.owner_user_id = ? AND p.facets LIKE ?
        ORDER BY CASE WHEN p.role = 'USER' THEN 0 ELSE 1 END, p.said_at DESC
        LIMIT 8`,
      [ownerId, `% ${facet} %`],
    );
    facets.push({
      facet,
      ...FACET_WORDS[facet],
      count: Number(count?.n ?? 0),
      examples: examples.map((e) => ({
        passageId: e.id,
        conversationId: e.conversation_id,
        conversationTitle: e.title,
        role: e.role,
        saidAt: e.said_at,
        excerpt: e.text.length > 400 ? `${e.text.slice(0, 397)}…` : e.text,
      })),
    });
  }
  const concepts = await db.all<{ id: string; title: string; state: string; first_seen_at: string | null; last_seen_at: string | null }>(
    `SELECT id, title, state, first_seen_at, last_seen_at FROM memory_ideas
      WHERE owner_user_id = ? AND (domain = 'FILM' OR (kind = 'CREATIVE' AND (LOWER(title) LIKE '%film%' OR LOWER(title) LIKE '%movie%' OR LOWER(title) LIKE '%script%')))
      ORDER BY last_seen_at DESC LIMIT 50`,
    [ownerId],
  );
  const practice = hub
    ? await db.all<{ id: string; kind: string; title: string; body: string; state: string; created_at: string }>(
        'SELECT id, kind, title, body, state, created_at FROM memory_practice WHERE hub_id = ? ORDER BY created_at DESC',
        [hub.id],
      )
    : [];
  const totals = await db.get<{ n: number; c: number; u: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT conversation_id) AS c, SUM(CASE WHEN role = 'USER' THEN 1 ELSE 0 END) AS u
       FROM memory_passages WHERE owner_user_id = ? AND facets LIKE '% DOMAIN_FILM %'`,
    [ownerId],
  );
  return {
    hub: hub ?? null,
    facets,
    concepts: concepts.map((c) => ({ id: c.id, title: c.title, state: c.state, firstSeenAt: c.first_seen_at, lastSeenAt: c.last_seen_at })),
    practice: practice.map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: p.body, state: p.state, createdAt: p.created_at })),
    caveat:
      'This is what your history discusses. How often something was discussed is not evidence of skill: mastery is shown by the practice and assessments recorded below, which start empty.',
    totals: { filmPassages: Number(totals?.n ?? 0), filmConversations: Number(totals?.c ?? 0), yourPassages: Number(totals?.u ?? 0) },
  };
}

export async function addPractice(input: {
  ownerId: string;
  kind: 'OBJECTIVE' | 'EXERCISE' | 'ASSESSMENT';
  title: string;
  body: string;
  basisIdeaId?: string | null;
}): Promise<{ id: string }> {
  const db = getDb();
  const hub = await db.get<{ id: string }>('SELECT id FROM memory_hubs WHERE owner_user_id = ? AND topic_key = ?', [input.ownerId, MOVIE_SCHOOL_KEY]);
  const at = nowIso();
  let hubId = hub?.id;
  if (!hubId) {
    hubId = newId('mhb');
    await db.run(
      `INSERT INTO memory_hubs (id, owner_user_id, kind, topic_key, title, state, evidence, draft_plan, created_at, updated_at)
       VALUES (?, ?, 'MOVIE_SCHOOL', ?, 'Movie School', 'PREPARED', '{}', '', ?, ?)`,
      [hubId, input.ownerId, MOVIE_SCHOOL_KEY, at, at],
    );
  }
  const id = newId('mpr');
  await db.run(
    `INSERT INTO memory_practice (id, owner_user_id, hub_id, kind, title, body, state, basis_idea_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
    [id, input.ownerId, hubId, input.kind, input.title.slice(0, 300), input.body.slice(0, 4000), input.basisIdeaId ?? null, at, at],
  );
  await recordMemoryEvent(input.ownerId, 'PRACTICE', id, 'PRACTICE_ADDED', { kind: input.kind });
  return { id };
}

/**
 * The person's answer to a prepared hub. Accepting makes it a Brain project —
 * the permanent place work happens — with the draft plan as its charter.
 */
export async function decideHub(input: { ownerId: string; hubId: string; decision: 'ACCEPT' | 'DECLINE' }): Promise<{ state: string; projectId: string | null }> {
  const db = getDb();
  const hub = await db.get<{ id: string; title: string; draft_plan: string; project_id: string | null; state: string }>(
    'SELECT id, title, draft_plan, project_id, state FROM memory_hubs WHERE id = ? AND owner_user_id = ?',
    [input.hubId, input.ownerId],
  );
  if (!hub) throw new Error('No such hub.');
  const at = nowIso();
  if (input.decision === 'DECLINE') {
    await db.run(`UPDATE memory_hubs SET state = 'DECLINED', updated_at = ? WHERE id = ?`, [at, hub.id]);
    await recordMemoryEvent(input.ownerId, 'HUB', hub.id, 'HUB_DECLINED', {});
    return { state: 'DECLINED', projectId: hub.project_id };
  }
  let projectId = hub.project_id;
  if (!projectId) {
    const { freeSlug } = await import('./rediscover.ts');
    const project = await createProject({
      name: hub.title,
      slug: await freeSlug(hub.title),
      description: hub.draft_plan.slice(0, 4000),
      northStar: hub.title,
    });
    projectId = project.id;
    await recordEvent({ projectId, entityType: 'project', entityId: projectId, eventType: 'MEMORY_HUB_ACCEPTED', payload: { hubId: hub.id } });
  }
  await db.run(`UPDATE memory_hubs SET state = 'ACCEPTED', project_id = ?, updated_at = ? WHERE id = ?`, [projectId, at, hub.id]);
  await recordMemoryEvent(input.ownerId, 'HUB', hub.id, 'HUB_ACCEPTED', { projectId });
  return { state: 'ACCEPTED', projectId };
}
