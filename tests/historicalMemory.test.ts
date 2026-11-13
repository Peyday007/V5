/**
 * Historical memory, end to end, on a constructed export.
 *
 * The fixture is built here, in the shape ChatGPT's own export uses, so the
 * mechanism can be proved: every node of a branched tree kept, a re-export
 * versioned rather than overwritten, attachments counted against their bytes,
 * topics discovered rather than declared, a once-mentioned idea kept beside a
 * frequent one, a state read from the last thing the record says, and a
 * decision that reaches Russell's own pipeline. It proves the machinery and
 * nothing about anybody's real history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import {
  contentHashOf,
  manifestEntryOf,
  matchArchiveFile,
  parseArchive,
  parseExportConversation,
  parseExporterMarkdown,
} from '../server/services/memory/parse.ts';
import { readPassage, segment } from '../server/services/memory/classify.ts';
import { ingestConversations, openArchive, storeAttachment } from '../server/services/memory/ingest.ts';
import { runMemoryPass, sweepToCompletion } from '../server/services/memory/pipeline.ts';
import { coverageReport } from '../server/services/memory/coverage.ts';
import { discoverTopics } from '../server/services/memory/organize.ts';
import { sameIdea, signatureOf } from '../server/services/memory/excavate.ts';
import { decide, recordCircumstance, reevaluate, scoreIdea } from '../server/services/memory/rediscover.ts';
import { conversationRecord, ideaDetail, listDiscoveries, listIdeas, searchMemory, topicHistory, topicTree } from '../server/services/memory/views.ts';
import { movieSchoolFoundation, readCommitments, verdictOf } from '../server/services/memory/hubs.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';

const NOW = '2026-11-10T00:00:00.000Z';

import { exportConversation, history } from './memoryFixture.ts';

let ownerId = '';
let otherId = '';

beforeEach(async () => {
  await freshProject();
  ownerId = (await createUser({ email: `m-${Math.random().toString(36).slice(2, 9)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  otherId = (await createUser({ email: `o-${Math.random().toString(36).slice(2, 9)}@example.test`, displayName: 'Other', password: 'correct horse battery staple' })).id;
});

afterEach(async () => {
  await teardown();
});

async function importHistory(conversations = history()): Promise<string> {
  const parsed = conversations.map((c) => parseExportConversation(c, 'CHATGPT_OFFICIAL'));
  const opened = await openArchive({
    ownerId,
    label: 'test export',
    sourceFormat: 'CHATGPT_OFFICIAL',
    entries: parsed.map(manifestEntryOf),
    declaredFiles: 1,
    notes: [],
  });
  expect(opened.pending.length).toBe(conversations.length);
  const results = await ingestConversations({
    ownerId,
    archiveId: opened.archive.id,
    conversations: conversations.map((value) => ({ kind: 'JSON', value, format: 'CHATGPT_OFFICIAL' })),
  });
  expect(results.every((r) => r.outcome === 'CREATED')).toBe(true);
  return opened.archive.id;
}

describe('reading an export', () => {
  it('keeps every node of a branched tree, its read path, times, projects and attachments', () => {
    const raw = history().find((c) => c.id === 'idea-1')!;
    const parsed = parseExportConversation(raw, 'CHATGPT_OFFICIAL');
    expect(parsed.externalId).toBe('idea-1');
    expect(parsed.createdAt).toBe('2024-03-02T01:00:00.000Z');
    expect(parsed.branchPointCount).toBe(1);
    const alternate = parsed.nodes.find((n) => n.text === 'What if I opened a pottery place?')!;
    expect(alternate.onCurrentPath).toBe(false);
    expect(alternate.siblingCount).toBe(2);
    const read = parsed.nodes.filter((n) => n.onCurrentPath).map((n) => n.role);
    expect(read).toEqual(['USER', 'ASSISTANT']);
    expect(parsed.nodes.find((n) => n.nodeId === 'idea-1-n0')!.attachments[0]).toMatchObject({ kind: 'IMAGE', sourceRef: 'file-IMGidea-1', width: 64 });
    const app = parseExportConversation(history().find((c) => c.id === 'idea-5')!, 'CHATGPT_OFFICIAL');
    expect(app.projectRef).toBe('g-p-roommates');
  });

  it('reads ChatGPTExporter Markdown without inventing ids, branches or times', () => {
    const md = parseExporterMarkdown('# Lighthouse\n\n#### You:\nI want to direct.\n\n#### ChatGPT:\nGreat.\n', 'lighthouse.md')!;
    expect(md.title).toBe('Lighthouse');
    expect(md.nodes.map((n) => n.role)).toEqual(['USER', 'ASSISTANT']);
    expect(md.nodes[0]!.saidAt).toBeNull();
    expect(md.notes.join(' ')).toMatch(/no node ids/);
  });

  it('reads a whole archive, matches files by export id, and reports what it could not read', () => {
    const archive = parseArchive(
      [
        { name: 'conversations.json', text: JSON.stringify(history().slice(0, 3)) },
        { name: 'user.json', text: '{"id":"u"}' },
        { name: 'broken.json', text: '{nope' },
      ],
      ['file-IMGidea-1-photo.png'],
    );
    expect(archive.conversations).toHaveLength(3);
    expect(archive.format).toBe('CHATGPT_OFFICIAL');
    expect(archive.unreadable.map((u) => u.name)).toEqual(['broken.json']);
    expect(matchArchiveFile('file-IMGidea-1', archive.binaryFiles)).toBe('file-IMGidea-1-photo.png');
    expect(contentHashOf('a')).not.toBe(contentHashOf('b'));
  });
});

describe('classification', () => {
  it('reads intentions from the person and only facets from the assistant', () => {
    expect(readPassage("I'm going to shoot my short film in June.", 'USER').kinds).toEqual(expect.arrayContaining(['COMMITMENT', 'CREATIVE']));
    expect(readPassage("I'm going to shoot my short film in June.", 'ASSISTANT').kinds).toEqual([]);
    expect(readPassage('I want to know what the capital of Australia is.', 'USER').kinds).not.toContain('GOAL');
    expect(readPassage('I loved the long takes in that film.', 'ASSISTANT').facets).toContain('FILM_OPINION');
    expect(segment('a\n\nb'.repeat(1)).length).toBe(1);
  });

  it('matches one idea across rewordings and keeps distinct ideas apart', () => {
    const a = signatureOf('I want to open a ceramics studio that rents kiln time.');
    const b = signatureOf('The ceramics studio renting kiln time to beginners.');
    const c = signatureOf('I want to start a dropshipping store selling phone cases.');
    expect(sameIdea(a, b)).toBe(true);
    expect(sameIdea(a, c)).toBe(false);
  });
});

describe('ingestion and coverage', () => {
  it('stores, resumes, versions and counts with real denominators', async () => {
    const archiveId = await importHistory();
    // Re-opening the same archive resumes it: nothing is pending.
    const reopened = await openArchive({
      ownerId,
      label: 'again',
      sourceFormat: 'CHATGPT_OFFICIAL',
      entries: history().map((c) => manifestEntryOf(parseExportConversation(c, 'CHATGPT_OFFICIAL'))),
      declaredFiles: 1,
      notes: [],
    });
    expect(reopened.archive.id).toBe(archiveId);
    expect(reopened.pending).toEqual([]);

    // A re-export where one answer changed: a new version, the old text kept.
    const changed = history();
    const target = changed.find((c) => c.id === 'idea-2')!;
    const node = (target.mapping as Record<string, { message: { content: { parts: string[] } } | null }>)['idea-2-n1']!;
    node.message!.content.parts = ['Here is how dropshipping works, revised.'];
    const out = await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: target }] });
    expect(out[0]).toMatchObject({ outcome: 'VERSIONED', version: 2 });
    const superseded = await getDb().all<{ text: string; superseded_in_version: number | null }>(
      `SELECT text, superseded_in_version FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
        WHERE c.external_id = 'idea-2' AND m.node_id = 'idea-2-n1' ORDER BY m.first_version`,
    );
    expect(superseded).toEqual([
      { text: 'Here is how dropshipping works.', superseded_in_version: 2 },
      { text: 'Here is how dropshipping works, revised.', superseded_in_version: null },
    ]);

    // A malformed conversation is a recorded failure, not a silent skip.
    const failed = await ingestConversations({ ownerId, archiveId, conversations: [{ kind: 'JSON', value: { id: 'bad-1', title: 'x' } }] });
    expect(failed[0]!.outcome).toBe('FAILED');

    // One attachment's bytes arrive; the other stays a named gap.
    const stored = await storeAttachment({ ownerId, sourceRef: 'file-IMGidea-1', fileName: 'file-IMGidea-1-photo.png', mimeType: 'image/png', bytes: Buffer.from('png-bytes') });
    expect(stored).toEqual({ matched: 1, state: 'RECOVERED' });

    const coverage = await coverageReport(ownerId);
    expect(coverage.conversations.recovered).toBe(12);
    expect(coverage.conversations.declared).toBe(12);
    expect(coverage.conversations.failed).toBe(0);
    expect(coverage.branches.conversationsWithBranches).toBe(1);
    expect(coverage.messages.alternateBranches).toBe(1);
    expect(coverage.messages.supersededVersions).toBe(1);
    expect(coverage.attachments).toMatchObject({ referenced: 2, recovered: 1, referencedOnly: 1 });
    expect(coverage.gaps.join(' ')).toMatch(/unverifiable/);

    // Another person sees none of it.
    expect((await coverageReport(otherId)).conversations.total).toBe(0);
  });
});

describe('organization, excavation and rediscovery', () => {
  it('finds, reconstructs, surfaces, and acts on the person\'s decisions', async () => {
    await importHistory();
    await sweepToCompletion({ ownerId, now: NOW });

    // Searchable, chronological.
    const found = await searchMemory(ownerId, { q: 'kiln', order: 'OLDEST' });
    expect(found.hits.some((h) => h.kind === 'PASSAGE' && h.excerpt.includes('ceramics studio'))).toBe(true);

    // Topics discovered from the material, with multiple membership.
    const topics = await topicTree(ownerId);
    const lighthouse = topics.find((t) => /lighthouse|short film/i.test(t.label));
    expect(lighthouse).toBeTruthy();
    const history1 = await topicHistory(ownerId, lighthouse!.id);
    expect(history1.history.length).toBeGreaterThan(2);
    const sorted = [...history1.history.map((h) => h.saidAt ?? '')].sort();
    expect(history1.history.map((h) => h.saidAt ?? '')).toEqual(sorted);
    const memberships = await getDb().get<{ n: number }>(
      `SELECT MAX(c) AS n FROM (SELECT COUNT(*) AS c FROM memory_topic_members GROUP BY conversation_id) x`,
    );
    expect(Number(memberships?.n)).toBeGreaterThan(1);

    // A once-mentioned idea is in the registry beside a frequent one.
    const ideas = await listIdeas(ownerId, {});
    const ceramics = ideas.find((i) => /ceramics/i.test(i.title))!;
    expect(ceramics).toBeTruthy();
    expect(ceramics.conversations).toBe(1);
    expect(ideas.some((i) => /capital of australia/i.test(i.title))).toBe(false);

    // States read from the last thing the record says; silence is UNRESOLVED.
    const byTitle = (re: RegExp): (typeof ideas)[number] | undefined => ideas.find((i) => re.test(i.title));
    expect(byTitle(/dropshipping/i)?.state).toBe('REJECTED');
    expect(byTitle(/podcast/i)?.state).toBe('PAUSED');
    expect(ceramics.state).toBe('UNRESOLVED');
    const detail = await ideaDetail(ownerId, ceramics.id);
    expect(detail.timeline[0]!.stage).toBe('ORIGIN');
    expect(detail.timeline[0]!.conversationTitle).toBe('Random late night thought');
    expect(detail.idea.obstacles).toContain('MONEY');

    // A sustained commitment is recognised; frequent talk alone is not.
    const commitments = await readCommitments(ownerId);
    expect(commitments.some((c) => c.verdict === 'PURSUED')).toBe(true);
    expect(verdictOf({ conversations: 30, months: 6, commitmentStatements: 0, progressStatements: 0, userPassages: 60 })).toBe('DISCUSSED');
    const school = await movieSchoolFoundation(ownerId);
    expect(school.hub?.title).toBe('Movie School');
    expect(school.facets.find((f) => f.facet === 'FILM_OPINION')!.count).toBeGreaterThan(0);
    expect(school.practice).toEqual([]);

    // Proactively surfaced, with sources, capped.
    const open = await listDiscoveries(ownerId);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThanOrEqual(12);
    const ceramicsDiscovery = open.find((d) => d.ideaId === ceramics.id)!;
    expect(ceramicsDiscovery.sources[0]!.title).toBe('Random late night thought');
    expect(ceramicsDiscovery.whyNow).toMatch(/never says what became of it/);
    expect(open.some((d) => d.state === 'REJECTED')).toBe(false);

    // A: explore → a Russell idea, linked back; never resurfaced as a discovery.
    const explored = await decide({ ownerId, ideaId: ceramics.id, decision: 'EXPLORE', feedback: 'Look at shared studios first.' });
    expect(explored.created.kind).toBe('CANDIDATE');
    const candidate = await getCandidate(explored.created.id!);
    expect(candidate?.statement).toMatch(/ceramics studio/);
    expect((await ideaDetail(ownerId, ceramics.id)).decisions[0]!.decision).toBe('EXPLORE');

    // E: not interested — kept, never resurfaced, even with a new trigger.
    const app = byTitle(/roommates|chores/i)!;
    await decide({ ownerId, ideaId: app.id, decision: 'NOT_INTERESTED' });
    await recordCircumstance({ ownerId, kind: 'CAPABILITY', statement: 'Brain can now build apps for chores and roommates.' });
    await reevaluate(ownerId, '2027-06-01T00:00:00.000Z');
    expect((await listDiscoveries(ownerId)).some((d) => d.ideaId === app.id)).toBe(false);
    expect((await ideaDetail(ownerId, app.id)).idea.state).toBe('REJECTED');

    // F: update what I want — versioned, earlier versions kept.
    const film = ideas.find((i) => /lighthouse/i.test(i.title))!;
    await decide({ ownerId, ideaId: film.id, decision: 'UPDATE_WANT', wantedNow: 'Finish the lighthouse short and submit it to festivals.' });
    const filmDetail = await ideaDetail(ownerId, film.id);
    expect(filmDetail.idea.ownerIntent).toMatch(/festivals/);
    expect(filmDetail.versions.length).toBeGreaterThan(1);

    // Another person reads none of it.
    await expect(ideaDetail(otherId, ceramics.id)).rejects.toThrow();
    const record = await conversationRecord(ownerId, ceramicsDiscovery.sources[0]!.conversationId, true);
    expect(record.messages.some((m) => !m.onReadPath)).toBe(true);
    await expect(conversationRecord(otherId, record.conversation.id, true)).rejects.toThrow();
  });

  it('brings a deferred idea back when circumstances change, not before', async () => {
    await importHistory();
    await sweepToCompletion({ ownerId, now: NOW });
    const app = (await listIdeas(ownerId, {})).find((i) => /roommates|chores/i.test(i.title))!;
    await decide({ ownerId, ideaId: app.id, decision: 'LATER', feedback: 'When I can build software.' });
    await reevaluate(ownerId, '2027-01-01T00:00:00.000Z');
    expect((await listDiscoveries(ownerId)).some((d) => d.ideaId === app.id)).toBe(false);
    await recordCircumstance({ ownerId, kind: 'CAPABILITY', statement: 'I can now get an app for roommates chores built.' });
    await reevaluate(ownerId, '2027-01-01T00:00:00.000Z');
    const back = (await listDiscoveries(ownerId)).find((d) => d.ideaId === app.id);
    expect(back?.trigger).toBe('CIRCUMSTANCE');
  });

  it('is resumable: a pass with nothing due does nothing', async () => {
    await importHistory();
    await sweepToCompletion({ ownerId, now: NOW });
    const again = await runMemoryPass({ ownerId, now: NOW });
    expect(again.indexed + again.excavated + again.reconstructed + again.organized).toBe(0);
  });
});

describe('pure parts', () => {
  it('merges overlapping topics and splits broad ones', () => {
    const conversations = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      first: null,
      last: null,
      weights: new Map<string, number>([
        ...(i < 20 ? ([['film', 5], ['movie', 5]] as [string, number][]) : []),
        [i % 2 === 0 ? 'screenplay' : 'camera', 3],
        [`unique${i}`, 1],
      ]),
    }));
    const topics = discoverTopics(conversations);
    const merged = topics.find((t) => t.terms.includes('film') && t.terms.includes('movie'));
    expect(merged).toBeTruthy();
    expect(topics.some((t) => t.parentKey === merged!.key)).toBe(true);
  });

  it('does not let frequency alone outrank a plainly stated want', () => {
    const once = scoreIdea({ kind: 'AMBITION', state: 'UNRESOLVED', cue_strength: 0.9, conversation_count: 1, user_words: 40, last_seen_at: '2024-01-01T00:00:00Z' }, NOW, {}, 0);
    const often = scoreIdea({ kind: 'INTEREST', state: 'UNRESOLVED', cue_strength: 0.1, conversation_count: 120, user_words: 4000, last_seen_at: '2024-01-01T00:00:00Z' }, NOW, {}, 0);
    expect(once).toBeGreaterThan(often);
  });
});
