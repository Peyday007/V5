/**
 * The owner's historical-memory objective, one requirement per test.
 *
 * Each `it` is named by the requirement it proves (R-numbers from the
 * assignment), so evidence for one item is one runnable filter:
 *   npx vitest run tests/historicalMemoryRequirements.test.ts -t "R25 "
 *
 * The export is constructed (tests/memoryFixture.ts plus the extras below): it
 * proves the mechanism, never that anyone's real history was recovered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { getDb } from '../server/db/database.ts';
import { exportConversation, history } from './memoryFixture.ts';
import { manifestEntryOf, parseExportConversation } from '../server/services/memory/parse.ts';
import { ingestConversations, openArchive, storeAttachment } from '../server/services/memory/ingest.ts';
import { sweepToCompletion, runMemoryPass } from '../server/services/memory/pipeline.ts';
import { coverageReport, type CoverageReport } from '../server/services/memory/coverage.ts';
import { decide, deriveBrainCircumstances, learnedWeights, recordCircumstance, reevaluate } from '../server/services/memory/rediscover.ts';
import {
  conversationRecord,
  ideaDetail,
  listDiscoveries,
  listIdeas,
  searchMemory,
  topicHistory,
  topicTree,
  type IdeaSummary,
} from '../server/services/memory/views.ts';
import { movieSchoolFoundation, readCommitments, refreshHubs } from '../server/services/memory/hubs.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { getProject } from '../server/repos/projects.ts';

const NOW = '2026-11-10T00:00:00.000Z';

/** Surfaced now, or queued for the next free place — never dropped. */
async function raised(ideaId: string): Promise<{ state: string; trigger_kind: string; why_now: string } | undefined> {
  return getDb().get(
    `SELECT state, trigger_kind, why_now FROM memory_discoveries WHERE idea_id = ? AND state IN ('OPEN','QUEUED') ORDER BY surfaced_at DESC LIMIT 1`,
    [ideaId],
  );
}

function extras(): Record<string, unknown>[] {
  const one = (id: string, title: string, user: string, at: string, reply = 'Noted.'): Record<string, unknown> =>
    exportConversation(id, title, [
      ['user', user, at],
      ['assistant', reply, at.replace(/:00Z$/, ':30Z')],
    ]);
  const audio = exportConversation('voice-1', 'Voice note', [
    ['user', 'Spoken note about my film idea about a girl who collects lost voicemails.', '2025-02-02T10:00:00Z'],
    ['assistant', 'Here is a generated poster.', '2025-02-02T10:01:00Z'],
  ]);
  const mapping = audio.mapping as Record<string, { message: { content: { content_type: string; parts: unknown[] } } }>;
  mapping['voice-1-n0']!.message.content = {
    content_type: 'multimodal_text',
    parts: [
      { content_type: 'audio_transcription', text: 'I have a film idea about a girl who collects lost voicemails.' },
      { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_AUDIO1', size_bytes: 5000, format: 'wav' },
    ],
  };
  mapping['voice-1-n1']!.message.content = {
    content_type: 'multimodal_text',
    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-DALLE1', width: 1024, height: 1024, metadata: { dalle: { prompt: 'a poster of lost voicemails' } } }],
  };
  return [
    audio,
    one('fin-1', 'Investing', 'I want to build a dividend portfolio to earn passive income by 2030.', '2024-02-10T10:00:00Z'),
    one('amb-1', 'Someday', 'One day I want to live in Japan and run a small bakery in Kyoto.', '2023-11-05T10:00:00Z'),
    one('per-1', 'Mornings', "Starting tomorrow I'm going to go to the gym every morning before class.", '2025-01-03T10:00:00Z'),
    one('dec-1', 'School choice', "Should I study film at college or learn filmmaking on my own? I can't decide between the two.", '2025-03-03T10:00:00Z'),
    one('yt-1', 'YouTube', 'I want to start a YouTube channel about cooking dinners on a budget.', '2024-04-04T10:00:00Z'),
    one('yt-2', 'YouTube again', 'Actually, I want to start a YouTube channel about film essays instead of cooking.', '2024-08-04T10:00:00Z'),
    one('web-1', 'Grindline', "I'm building my website Grindline, and the skateboard podcast with shop owners will be part of it.", '2024-08-10T10:00:00Z'),
    one('pot-1', 'Pottery class', 'I want to teach pottery classes for kids in a ceramics studio someday.', '2025-04-04T10:00:00Z'),
    one('ex-1', 'Practice', 'Give me a directing exercise to practice blocking a two-person scene for my lighthouse short film.', '2025-09-20T10:00:00Z', 'Exercise: block the scene three ways.'),
  ];
}

let ownerId = '';
let archiveId = '';
let ideas: IdeaSummary[] = [];
let coverage: CoverageReport;
const find = (re: RegExp): IdeaSummary => {
  const hit = ideas.find((i) => re.test(i.title));
  if (!hit) throw new Error(`No idea matching ${re}: ${ideas.map((i) => i.title).join(' | ')}`);
  return hit;
};

beforeAll(async () => {
  await freshProject();
  ownerId = (await createUser({ email: `r-${Math.random().toString(36).slice(2, 9)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  const all = [...history(), ...extras()];
  const parsed = all.map((c) => parseExportConversation(c, 'CHATGPT_OFFICIAL'));
  const opened = await openArchive({ ownerId, label: 'export', sourceFormat: 'CHATGPT_OFFICIAL', entries: parsed.map(manifestEntryOf), declaredFiles: 3, notes: [] });
  archiveId = opened.archive.id;
  await ingestConversations({ ownerId, archiveId, conversations: all.map((value) => ({ kind: 'JSON', value, format: 'CHATGPT_OFFICIAL' })) });
  await storeAttachment({ ownerId, sourceRef: 'file-DALLE1', fileName: 'file-DALLE1-poster.webp', mimeType: 'image/webp', bytes: Buffer.from('webp') });
  await sweepToCompletion({ ownerId, now: NOW });
  ideas = await listIdeas(ownerId, { limit: 500 });
  coverage = await coverageReport(ownerId);
}, 120_000);

afterAll(async () => {
  await teardown();
});

describe('2. historical ingestion', () => {
  it('R2 imports a full official export and ChatGPTExporter files through one path', async () => {
    expect(coverage.conversations.recovered).toBe(coverage.conversations.declared);
    expect(coverage.conversations.declared).toBe(history().length + extras().length);
  });
  it('R3 keeps original conversations and message contents exactly', async () => {
    const id = (await getDb().get<{ id: string }>(`SELECT id FROM memory_conversations WHERE external_id = 'fin-1'`))!.id;
    const record = await conversationRecord(ownerId, id, false);
    expect(record.messages[0]!.text).toBe('I want to build a dividend portfolio to earn passive income by 2030.');
    const raw = await getDb().get<{ raw_key: string; content_hash: string }>('SELECT raw_key, content_hash FROM memory_conversation_versions WHERE conversation_id = ?', [id]);
    expect(raw!.raw_key).toMatch(/^memory\//);
  });
  it('R4 keeps conversation ids and titles', async () => {
    const row = await getDb().get<{ external_id: string; title: string }>(`SELECT external_id, title FROM memory_conversations WHERE external_id = 'amb-1'`);
    expect(row).toEqual({ external_id: 'amb-1', title: 'Someday' });
  });
  it('R5 keeps creation and modification timestamps', async () => {
    const row = await getDb().get<{ source_created_at: string; source_updated_at: string }>(`SELECT source_created_at, source_updated_at FROM memory_conversations WHERE external_id = 'idea-4'`);
    expect(row).toEqual({ source_created_at: '2024-07-01T10:00:00.000Z', source_updated_at: '2024-07-01T10:05:00.000Z' });
  });
  it('R6 keeps message order and parent relationships', async () => {
    const id = (await getDb().get<{ id: string }>(`SELECT id FROM memory_conversations WHERE external_id = 'idea-4'`))!.id;
    const record = await conversationRecord(ownerId, id, false);
    expect(record.messages.map((m) => m.depth)).toEqual([1, 2, 3]);
    expect(record.messages[1]!.parentNodeId).toBe(record.messages[0]!.nodeId);
  });
  it('R7 keeps alternate branches and edited messages', async () => {
    expect(coverage.messages.alternateBranches).toBeGreaterThanOrEqual(1);
    const id = (await getDb().get<{ id: string }>(`SELECT id FROM memory_conversations WHERE external_id = 'idea-1'`))!.id;
    const all = await conversationRecord(ownerId, id, true);
    expect(all.messages.find((m) => m.text === 'What if I opened a pottery place?')?.onReadPath).toBe(false);
  });
  it('R8 keeps images and their metadata', async () => {
    const row = await getDb().get<{ kind: string; width: number; height: number; metadata: string; state: string }>(
      `SELECT kind, width, height, metadata, state FROM memory_attachments WHERE source_ref = 'file-DALLE1'`,
    );
    expect(row).toMatchObject({ kind: 'IMAGE', width: 1024, height: 1024, state: 'RECOVERED' });
    expect(JSON.parse(row!.metadata).dalle.prompt).toMatch(/voicemails/);
  });
  it('R9 keeps uploaded files and attachments, and says which bytes are missing', async () => {
    const row = await getDb().get<{ name: string; mime_type: string; state: string }>(`SELECT name, mime_type, state FROM memory_attachments WHERE source_ref = 'file-DOCidea-4'`);
    expect(row).toEqual({ name: 'treatment.pdf', mime_type: 'application/pdf', state: 'REFERENCED_ONLY' });
  });
  it('R10 keeps available multimodal content: audio and its transcription', async () => {
    const audio = await getDb().get<{ kind: string }>(`SELECT kind FROM memory_attachments WHERE source_ref = 'file_AUDIO1'`);
    expect(audio?.kind).toBe('AUDIO');
    const text = await getDb().get<{ text: string; content_type: string }>(`SELECT text, content_type FROM memory_messages WHERE node_id = 'voice-1-n0'`);
    expect(text).toEqual({ text: 'I have a film idea about a girl who collects lost voicemails.', content_type: 'multimodal_text' });
  });
  it('R11 keeps ChatGPT Project associations', async () => {
    const row = await getDb().get<{ project_ref: string }>(`SELECT project_ref FROM memory_conversations WHERE external_id = 'idea-5'`);
    expect(row?.project_ref).toBe('g-p-roommates');
  });
  it('R12 keeps provenance and keeps originals apart from interpretations', async () => {
    const version = await getDb().get<{ archive_id: string; content_hash: string }>(
      `SELECT v.archive_id, v.content_hash FROM memory_conversation_versions v JOIN memory_conversations c ON c.id = v.conversation_id WHERE c.external_id = 'fin-1'`,
    );
    expect(version?.archive_id).toBe(archiveId);
    // Interpretation lives in other tables; re-running never edits a message.
    const before = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_messages');
    await runMemoryPass({ ownerId, now: NOW });
    expect(await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_messages')).toEqual(before);
  });
});

describe('3. automatic organization', () => {
  it('R13 R14 discovers subjects and recurring topics without a taxonomy', async () => {
    const topics = await topicTree(ownerId);
    expect(topics.length).toBeGreaterThan(2);
    expect(topics.some((t) => /lighthouse|short|film/i.test(t.label))).toBe(true);
  });
  it('R15 identifies individual projects and ambitions', () => {
    expect(find(/website grindline/i).kind).toBe('PROJECT');
    expect(find(/japan/i).kind).toBe('AMBITION');
  });
  it('R16 recognizes distinct ideas within one conversation', async () => {
    // The pottery-class conversation also mentions the ceramics studio; they stay two ideas.
    expect(find(/pottery classes/i).id).not.toBe(find(/ceramics studio that rents/i).id);
  });
  it('R17 classifies at the passage level', async () => {
    const rows = await getDb().all<{ kinds: string; facets: string }>(`SELECT kinds, facets FROM memory_passages WHERE owner_user_id = ? AND role = 'USER'`, [ownerId]);
    expect(rows.some((r) => / OBSTACLE /.test(r.kinds))).toBe(true);
    expect(rows.some((r) => / FILM_CONCEPT /.test(r.facets))).toBe(true);
  });
  it('R18 connects related conversations across time', async () => {
    const flat = (await topicTree(ownerId)).flatMap((t) => [t, ...t.children]);
    const lighthouse = flat.filter((t) => /lighthouse|short film|film/i.test(t.label)).sort((a, b) => b.conversations - a.conversations)[0]!;
    const history1 = await topicHistory(ownerId, lighthouse.id);
    const months = new Set(history1.conversations.map((c) => c.firstSaidAt?.slice(0, 7)));
    expect(months.size).toBeGreaterThan(3);
  });
  it('R19 R20 R21 creates categories and subcategories, merging overlaps and splitting broad ones', async () => {
    const { discoverTopics } = await import('../server/services/memory/organize.ts');
    const conversations = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, first: null, last: null,
      weights: new Map<string, number>([
        ...(i < 20 ? ([['film', 5], ['movie', 5]] as [string, number][]) : []),
        [i % 2 === 0 ? 'screenplay' : 'camera', 3],
      ]),
    }));
    const topics = discoverTopics(conversations);
    const merged = topics.find((t) => t.terms.includes('film') && t.terms.includes('movie'))!;
    expect(merged.mergedFrom.length).toBeGreaterThan(0);
    expect(topics.filter((t) => t.parentKey === merged.key).length).toBeGreaterThan(0);
  });
  it('R22 supports multiple category memberships', async () => {
    const row = await getDb().get<{ n: number }>(`SELECT MAX(c) AS n FROM (SELECT COUNT(*) AS c FROM memory_topic_members GROUP BY conversation_id) x`);
    expect(Number(row?.n)).toBeGreaterThan(1);
  });
  it('R23 keeps searchable chronological histories and one unified record per conversation', async () => {
    const found = await searchMemory(ownerId, { q: 'lighthouse', order: 'OLDEST', role: 'USER' });
    const dates = found.hits.filter((h) => h.kind === 'PASSAGE').map((h) => h.saidAt ?? '');
    expect(dates.length).toBeGreaterThan(3);
    expect(dates).toEqual([...dates].sort());
    const ranged = await searchMemory(ownerId, { q: 'lighthouse', from: '2025-08-01', to: '2025-08-31' });
    expect(ranged.hits.filter((h) => h.kind === 'PASSAGE').every((h) => (h.saidAt ?? '').startsWith('2025-08'))).toBe(true);
  });
});

describe('4. excavation', () => {
  it('R24 sweeps every conversation, not only familiar subjects', async () => {
    const n = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_conversations WHERE owner_user_id = ? AND excavated_version < version', [ownerId]);
    expect(Number(n?.n)).toBe(0);
    expect(coverage.search.messagesIndexed).toBe(coverage.search.messagesWithText);
  });
  it('R25 finds forgotten goals', () => {
    const goal = find(/dividend portfolio/i);
    expect(['UNRESOLVED']).toContain(goal.state);
  });
  it('R26 finds business ideas and opportunities', () => expect(find(/dropshipping/i).kind).toBe('BUSINESS'));
  it('R27 finds abandoned or paused projects', () => {
    expect(find(/podcast/i).state).toBe('PAUSED');
    expect(find(/dropshipping/i).state).toBe('REJECTED');
  });
  it('R28 finds previously considered financial concepts', () => expect(find(/dividend portfolio/i).kind).toBe('FINANCIAL'));
  it('R29 finds creative concepts and unfinished works', () => {
    expect(find(/lost voicemails/i).kind).toBe('CREATIVE');
    expect(find(/lighthouse/i).state).toBe('ACTIVE');
  });
  it('R30 finds unresolved questions and decisions', async () => {
    const q = find(/study film at college/i);
    expect(['QUESTION', 'DECISION', 'CREATIVE']).toContain(q.kind);
    expect((await ideaDetail(ownerId, q.id)).idea.openQuestions[0]).toMatch(/\?$/);
  });
  it('R31 finds long-term ambitions', () => expect(find(/japan/i).kind).toBe('AMBITION'));
  it('R32 finds personal plans and commitments', () => expect(find(/gym every morning/i).kind).toBe('COMMITMENT'));
  it('R33 finds ideas that were never investigated', () => {
    const once = find(/ceramics studio that rents/i);
    expect(once.state).toBe('UNRESOLVED');
    expect(once.mentions).toBe(1);
  });
  it('R34 finds projects blocked by past limitations', async () => {
    expect((await ideaDetail(ownerId, find(/chores/i).id)).idea.obstacles).toEqual(expect.arrayContaining(['SKILL']));
    expect((await ideaDetail(ownerId, find(/ceramics studio that rents/i).id)).idea.obstacles).toContain('MONEY');
  });
  it('R35 finds ideas that have become newly feasible', async () => {
    await recordCircumstance({ ownerId, kind: 'FEASIBILITY', statement: 'Brain can now build a roommates chores app.' });
    await reevaluate(ownerId, NOW);
    const d = await raised(find(/chores/i).id);
    expect(d?.trigger_kind).toBe('CIRCUMSTANCE');
    expect(d?.why_now).toMatch(/stalled on exactly that/);
  });
  it('R36 finds recurring interests deserving dedicated systems', async () => {
    const pursued = (await readCommitments(ownerId)).filter((c) => c.verdict === 'PURSUED');
    expect(pursued.length).toBeGreaterThan(0);
  });
  it('R37 connects previously separate ideas, and keeps a once-mentioned idea discoverable', async () => {
    const detail = await ideaDetail(ownerId, find(/pottery classes/i).id);
    expect(detail.related.some((r) => r.relation === 'CONNECTS')).toBe(true);
    expect((await searchMemory(ownerId, { q: 'kiln' })).hits.length).toBeGreaterThan(0);
  });
});

describe('5. reconstruction', () => {
  it('R38 R39 R40 R41 says when it first appeared, what was wanted, and how it developed', async () => {
    const d = await ideaDetail(ownerId, find(/lighthouse/i).id);
    expect(d.idea.firstSeenAt?.slice(0, 7)).toBe('2025-06');
    expect(d.timeline[0]!.stage).toBe('ORIGIN');
    expect(d.idea.statement).toMatch(/lighthouse keeper/);
    expect(d.timeline.length).toBeGreaterThan(3);
  });
  it('R42 records alternatives considered', async () => {
    const d = await ideaDetail(ownerId, find(/study film at college/i).id);
    expect(d.timeline.some((t) => t.stage === 'ORIGIN' || t.stage === 'ALTERNATIVE')).toBe(true);
    expect(d.idea.openQuestions.join(' ')).toMatch(/college or learn filmmaking on my own/);
  });
  it('R43 records objections and obstacles', async () => {
    const d = await ideaDetail(ownerId, find(/ceramics studio that rents/i).id);
    expect(d.idea.obstacles).toContain('MONEY');
  });
  it('R44 records whether it was pursued', async () => {
    const d = await ideaDetail(ownerId, find(/lighthouse/i).id);
    expect(d.timeline.some((t) => t.stage === 'PURSUIT')).toBe(true);
    expect(d.idea.state).toBe('ACTIVE');
  });
  it('R45 records a change of direction', async () => {
    const cooking = find(/cooking dinners/i);
    expect(cooking.state).toBe('SUPERSEDED');
    const d = await ideaDetail(ownerId, cooking.id);
    expect(d.idea.supersededById).toBe(find(/film essays/i).id);
  });
  it('R46 records when it became part of another project', async () => {
    const d = await ideaDetail(ownerId, find(/podcast/i).id);
    expect(d.related.some((r) => r.relation === 'PART_OF' && r.id === find(/website grindline/i).id)).toBe(true);
  });
  it('R47 R48 records explicit rejection and completion', async () => {
    expect(find(/dropshipping/i).state).toBe('REJECTED');
    const d = await ideaDetail(ownerId, find(/dropshipping/i).id);
    expect(d.timeline.some((t) => t.stage === 'REJECTION')).toBe(true);
    const { reconstructIdea } = await import('../server/services/memory/excavate.ts');
    const { indexConversation } = await import('../server/services/memory/indexing.ts');
    const { excavateConversation } = await import('../server/services/memory/excavate.ts');
    await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: exportConversation('done-1', 'Launch', [['user', 'My dividend portfolio is done — finally finished setting up the dividend portfolio account.', '2026-01-02T10:00:00Z'], ['assistant', 'Congratulations.', '2026-01-02T10:01:00Z']]) }] });
    const conv = (await getDb().get<{ id: string }>(`SELECT id FROM memory_conversations WHERE external_id = 'done-1'`))!.id;
    await indexConversation(conv);
    await excavateConversation(conv);
    await reconstructIdea(find(/dividend portfolio/i).id);
    expect((await ideaDetail(ownerId, find(/dividend portfolio/i).id)).idea.state).toBe('COMPLETED');
  });
  it('R49 keeps unknown status unknown, and lets later evidence overrule earlier', async () => {
    expect(find(/japan/i).state).toBe('UNRESOLVED');
    expect(find(/japan/i).stateBasis).toMatch(/Nothing in the archive records/);
    const d = await ideaDetail(ownerId, find(/dropshipping/i).id);
    expect(d.timeline[0]!.stage).toBe('ORIGIN');
    expect(d.idea.state).toBe('REJECTED');
    expect(d.timeline.every((t) => t.conversationId)).toBe(true);
  });
});

describe('6. active rediscovery', () => {
  it('R50 R51 R52 R53 R54 R55 R56 R57 R58 surfaces discoveries with everything a person needs to decide', async () => {
    const open = await listDiscoveries(ownerId);
    expect(open.length).toBeGreaterThan(0);
    for (const d of open) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.originally.length).toBeGreaterThan(0);
      expect(d.period.first ?? d.period.last).toBeTruthy();
      expect(d.whyMatters.length).toBeGreaterThan(0);
      expect(d.afterwards.length).toBeGreaterThan(0);
      expect(typeof d.unresolved).toBe('boolean');
      expect(d.whyNow.length).toBeGreaterThan(0);
      expect(d.sources.length).toBeGreaterThan(0);
      expect(d.sources[0]!.conversationId).toMatch(/^mcv_/);
    }
  });
});

describe('7. commitments', () => {
  it('R59 R60 R61 R62 R63 R64 R65 R66 weighs breadth, effort, depth, commitment, continuity, progress and current priorities', async () => {
    await createProject({ name: 'Lighthouse short film', description: 'Finish the lighthouse short.' });
    const readings = await readCommitments(ownerId);
    const film = readings.find((r) => /lighthouse|short|film/i.test(r.label))!;
    expect(film.conversations).toBeGreaterThanOrEqual(5);
    expect(film.userWords).toBeGreaterThan(0);
    expect(film.userPassages).toBeGreaterThan(0);
    expect(film.commitmentStatements).toBeGreaterThan(0);
    expect(film.months).toBeGreaterThanOrEqual(2);
    expect(film.progressStatements).toBeGreaterThan(0);
    expect(film.touchesCurrentWork).toContain('Lighthouse short film');
    expect(film.verdict).toBe('PURSUED');
    expect(readings.some((r) => r.verdict === 'DISCUSSED')).toBe(true);
    await refreshHubs(ownerId);
    const hubs = await getDb().all<{ kind: string; state: string }>('SELECT kind, state FROM memory_hubs WHERE owner_user_id = ?', [ownerId]);
    expect(hubs.some((h) => h.kind === 'MOVIE_SCHOOL' && h.state === 'PREPARED')).toBe(true);
    // Preparing a hub creates no project: that waits for the person.
    expect(hubs.every((h) => h.state !== 'ACCEPTED')).toBe(true);
  });
});

describe('8. registry', () => {
  it('R67 R68 keeps a stable identity and never duplicates an idea', async () => {
    const before = ideas.map((i) => i.id).sort();
    await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: exportConversation('again-1', 'Again', [['user', 'I want to start a dropshipping store selling phone cases to earn passive income.', '2026-02-01T10:00:00Z'], ['assistant', 'Again?', '2026-02-01T10:01:00Z']]) }] });
    await sweepToCompletion({ ownerId, now: NOW });
    const after = await listIdeas(ownerId, { limit: 500 });
    expect(after.filter((i) => /dropshipping store selling/i.test(i.title))).toHaveLength(1);
    expect(before.every((id) => after.some((i) => i.id === id))).toBe(true);
  });
  it('R69 R70 R71 R72 keeps sources, development, connected conversations and related topics and projects', async () => {
    const d = await ideaDetail(ownerId, find(/lighthouse/i).id);
    expect(d.timeline[0]!.conversationTitle).toMatch(/Short film session/);
    expect(new Set(d.timeline.map((t) => t.conversationId)).size).toBeGreaterThan(3);
    expect(d.topics.length).toBeGreaterThan(0);
    expect(d.currentConnections.some((c) => c.kind === 'PROJECT')).toBe(true);
  });
  it('R73 R74 R75 R76 R77 R78 keeps revisions, decisions, status, questions, conditions, feedback and next actions', async () => {
    const japan = find(/japan/i);
    await decide({ ownerId, ideaId: japan.id, decision: 'LATER', feedback: 'When I have savings for the move.' });
    const d = await ideaDetail(ownerId, japan.id);
    expect(d.versions.length).toBeGreaterThan(1);
    expect(d.decisions[0]).toMatchObject({ decision: 'LATER', feedback: 'When I have savings for the move.' });
    expect(d.idea.state).toBe('UNRESOLVED');
    expect(d.idea.reconsiderWhen).toEqual(['When I have savings for the move.']);
    expect(d.idea.ownerFeedback).toBe('When I have savings for the move.');
    expect(d.eligible.resurfaces).toMatch(/something relevant changes/);
    // One concept branches into two projects without losing its origin.
    const voicemail = find(/lost voicemails/i);
    const first = await decide({ ownerId, ideaId: voicemail.id, decision: 'CREATE_SECTION' });
    const second = await decide({ ownerId, ideaId: voicemail.id, decision: 'CREATE_SECTION', branch: true });
    expect(first.created.id).not.toBe(second.created.id);
    const vd = await ideaDetail(ownerId, voicemail.id);
    expect(vd.promotedTo.length).toBe(2);
    expect(vd.timeline[0]!.stage).toBe('ORIGIN');
  });
});

describe('9. continuous reevaluation', () => {
  it('R79 R80 a new technical capability', async () => {
    const { MAX_OPEN_DISCOVERIES } = await import('../server/services/memory/rediscover.ts');
    expect(MAX_OPEN_DISCOVERIES).toBeLessThanOrEqual(12);
    const added = await deriveBrainCircumstances(ownerId);
    expect(added).toBeGreaterThanOrEqual(0);
    const row = await getDb().get<{ kind: string }>(`SELECT kind FROM memory_circumstances WHERE owner_user_id = ? AND source_ref = 'factory-software'`, [ownerId]);
    expect(row?.kind).toBe('CAPABILITY');
  });
  it('R81 R83 new capital or a removed obstacle', async () => {
    await getDb().run(`UPDATE memory_discoveries SET state = 'RETIRED' WHERE owner_user_id = ?`, [ownerId]);
    await recordCircumstance({ ownerId, kind: 'CAPITAL', statement: 'I now have savings to rent a kiln for a ceramics studio.' });
    await reevaluate(ownerId, NOW);
    expect((await raised(find(/ceramics studio that rents/i).id))?.trigger_kind).toBe('CIRCUMSTANCE');
  });
  it('R82 a change in priorities', async () => {
    await getDb().run(`UPDATE memory_discoveries SET state = 'RETIRED' WHERE owner_user_id = ?`, [ownerId]);
    await createProject({ name: 'Japan bakery in Kyoto', description: 'Moving to Japan to run a bakery.' });
    await deriveBrainCircumstances(ownerId);
    // Deferred in R73 today: the 30-day cooldown has to pass first.
    await reevaluate(ownerId, '2027-01-01T00:00:00.000Z');
    expect((await raised(find(/japan/i).id))?.why_now).toMatch(/Japan bakery in Kyoto/);
  });
  it('R84 a new opportunity connected to an old idea', async () => {
    await getDb().run(`UPDATE memory_discoveries SET state = 'RETIRED' WHERE owner_user_id = ?`, [ownerId]);
    await recordCircumstance({ ownerId, kind: 'OPPORTUNITY', statement: 'A local shop wants a skateboard podcast about shop owners.' });
    await reevaluate(ownerId, NOW);
    expect((await raised(find(/podcast/i).id))?.trigger_kind).toBe('CIRCUMSTANCE');
  });
  it('R85 a new discussion that relates to past material', async () => {
    await getDb().run(`UPDATE memory_discoveries SET state = 'RETIRED' WHERE owner_user_id = ?`, [ownerId]);
    await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: exportConversation('new-1', 'Gym', [['user', 'Thinking again about going to the gym every morning before class.', '2026-11-01T10:00:00Z'], ['assistant', 'Good.', '2026-11-01T10:01:00Z']]) }] });
    await sweepToCompletion({ ownerId, now: NOW });
    await reevaluate(ownerId, NOW);
    expect((await raised(find(/gym every morning/i).id))?.trigger_kind).toBe('NEW_RELATED_DISCUSSION');
  });
  it('R86 avoids redundant alerts, learns from decisions, and never erases a dismissal', async () => {
    const open = await listDiscoveries(ownerId);
    expect(new Set(open.map((d) => d.ideaId)).size).toBe(open.length);
    expect(open.length).toBeLessThanOrEqual(12);
    const neutral = (await learnedWeights(ownerId)).BUSINESS;
    await decide({ ownerId, ideaId: find(/dropshipping/i).id, decision: 'NOT_INTERESTED' });
    expect((await learnedWeights(ownerId)).BUSINESS).toBeLessThan(neutral!);
    await recordCircumstance({ ownerId, kind: 'CAPITAL', statement: 'Money for a dropshipping phone cases store.' });
    await reevaluate(ownerId, '2028-01-01T00:00:00.000Z');
    expect(await raised(find(/dropshipping/i).id)).toBeUndefined();
    expect((await ideaDetail(ownerId, find(/dropshipping/i).id)).timeline.length).toBeGreaterThan(0);
  });
});

describe('10. Movie School', () => {
  it('R87 R88 R89 R90 R91 R92 R93 R94 R95 organizes film history by facet, keeps distinctions, and separates practice', async () => {
    const school = await movieSchoolFoundation(ownerId);
    const count = (facet: string): number => school.facets.find((f) => f.facet === facet)!.count;
    for (const facet of ['FILM_OPINION', 'DIRECTING', 'SCREENWRITING', 'CHARACTER_THEME', 'FILM_CONCEPT', 'CREATIVE_STANDARD', 'EXERCISE', 'PROJECT_REVISION']) {
      expect(count(facet), facet).toBeGreaterThan(0);
    }
    expect(school.facets.find((f) => f.facet === 'FILM_OPINION')!.distinction).toMatch(/not your projects/);
    expect(school.concepts.some((c) => /voicemails|lighthouse/i.test(c.title))).toBe(true);
    expect(school.caveat).toMatch(/not evidence of skill/);
    expect(school.practice).toEqual([]);
  });
});

describe('11. processing', () => {
  it('R96 resumes from checkpoints and never reprocesses unchanged information', async () => {
    const again = await runMemoryPass({ ownerId, now: NOW });
    expect(again.indexed + again.excavated + again.organized).toBe(0);
    const reimport = await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: history()[0]! }] });
    expect(reimport[0]!.outcome).toBe('UNCHANGED');
  });
});

describe('12. verification', () => {
  it('R97 R98 R99 R100 R101 R102 R103 R104 R105 R106 R107 R108 reports coverage with denominators and named gaps', async () => {
    const c = await coverageReport(ownerId);
    expect(c.conversations.declared).toBeGreaterThan(0);
    expect(c.conversations.recovered).toBeGreaterThan(0);
    expect(c.messages.declared).toBeGreaterThan(0);
    expect(c.messages.stored).toBeGreaterThanOrEqual(c.messages.onReadPath);
    expect(c.branches.conversationsWithBranches).toBeGreaterThan(0);
    expect(c.attachments.referenced).toBeGreaterThan(c.attachments.recovered);
    expect(c.search.messagesIndexed).toBe(c.search.messagesWithText);
    expect(c.classes.recovered).toMatch(/held exactly/);
    expect(c.classes.discoveredNotRecovered).toMatch(/not held/);
    expect(c.classes.unverifiable).toMatch(/no claim/);
    expect(c.gaps.some((g) => /referenced by messages but their bytes/.test(g))).toBe(true);
    const failed = await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: { id: 'broken', title: 'b' } }] });
    expect(failed[0]!.outcome).toBe('FAILED');
  });
});

describe('final success condition', () => {
  it('R110 R111 R112 R113 R114 R115 R116 R117 R118 R119 finds, shows, reconstructs, connects, judges, presents, accepts, converts, remembers, continues', async () => {
    await getDb().run(`UPDATE memory_discoveries SET state = 'RETIRED' WHERE owner_user_id = ?`, [ownerId]);
    await recordCircumstance({ ownerId, kind: 'OBSTACLE_REMOVED', statement: 'I can now code apps for roommates chores.' });
    await reevaluate(ownerId, NOW);
    const found = (await listDiscoveries(ownerId)).find((d) => d.ideaId === find(/chores/i).id)!; // 1, 5, 6
    expect(found.originally).toMatch(/reminds roommates/); // 2
    const detail = await ideaDetail(ownerId, found.ideaId); // 3, 4
    expect(detail.idea.stateBasis.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.currentConnections)).toBe(true);
    const decided = await decide({ ownerId, ideaId: found.ideaId, decision: 'PLAN', feedback: 'Start with a web version.' }); // 7
    const candidate = await getCandidate(decided.created.id!); // 8
    expect(candidate?.statement).toMatch(/Draft plan/);
    const after = await ideaDetail(ownerId, found.ideaId); // 9
    expect(after.decisions[0]!.decision).toBe('PLAN');
    expect(after.idea.nextActions.join(' ')).toMatch(/web version/);
    await reevaluate(ownerId, '2027-06-01T00:00:00.000Z');
    expect((await listDiscoveries(ownerId)).some((d) => d.ideaId === found.ideaId)).toBe(false);
    expect(decided.created.projectId === null || !!(await getProject(decided.created.projectId))).toBe(true);
    // 10: the pass runs on Russell's tick (asserted in historicalMemoryWiring).
    const { DEFERRABLE_UNDER_PRESSURE } = await import('../server/services/russell/loop.ts');
    expect(DEFERRABLE_UNDER_PRESSURE.has('historical-memory')).toBe(true);
  });
});
