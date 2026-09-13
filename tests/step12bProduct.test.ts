/**
 * Step 12B, Release 1 — the product decisions, tested where they are decided.
 *
 * These are the rules the owner rejected the September 11 interface over, plus
 * the two objects Release 1 adds. What is asserted is the behaviour a person
 * notices when it is wrong, through the services production uses rather than
 * through a repository helper — §28 is explicit that proving a helper while
 * bypassing the service is not coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { addMessage, createConversation } from '../server/repos/russellConversations.ts';
import {
  ensureCollection,
  fileConversation,
  listCollections,
  setConversationClosed,
} from '../server/repos/russellCollections.ts';
import { getConversation } from '../server/repos/russellConversations.ts';
import {
  collectionNameFor,
  collectionsFor,
  orderThreads,
  organize,
  standingOf,
  type RankedThread,
} from '../server/services/russell/collections.ts';
import { describe as describeProgress, progressOf, type Milestone } from '../server/services/russell/progress.ts';
import { projectProgress } from '../server/services/russell/progress.ts';
import { pulseOf, stateOf } from '../server/services/russell/home.ts';
import {
  classify,
  couldBecomeWork,
  frontierFor,
  refreshFrontier,
} from '../server/services/russell/frontier.ts';
import {
  dismissFrontierItem,
  listFrontier,
  observeFrontierItem,
} from '../server/repos/russellFrontier.ts';
import { search } from '../server/services/russell/search.ts';
import { explainSlowness, fleetView, meaningOfGap, usability } from '../server/services/fleet/view.ts';
import {
  MAX_CONCURRENCY,
  evidenceFor,
  knee,
  ladder,
} from '../server/services/fleet/labRunners.ts';
import { openInquiry, validateLensReply } from '../server/services/russell/inquiry.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import {
  DEFAULT_TARGET_WITH_NO_PRIOR_POLICY,
  applyFinding,
  checkEnvelope,
  declareExperiment,
  rollbackFinding,
  runExperiment,
  stalenessOf,
} from '../server/services/fleet/lab.ts';
import { currentPolicy, policyHistory, setPolicy } from '../server/repos/fleet.ts';
import { listLayers, updateLayer } from '../server/repos/layers.ts';
import { briefing } from '../server/services/russell/projections.ts';
import { compileHat } from '../server/services/conversation/contextHat.ts';
import { ideaMapForProject } from '../server/services/russell/ideas.ts';
import {
  activeWorkProgress,
  buildProgress,
  milestoneStateOfLayer,
} from '../server/services/russell/progress.ts';
import { capture } from '../server/services/russell/judgment.ts';
import {
  getCandidate,
  listCandidates,
  listMergeHistory,
  splitCandidate,
} from '../server/repos/russellCandidates.ts';
import { createProject } from '../server/repos/projects.ts';
import { mapFor, outlineOf } from '../server/services/russell/maps.ts';
import { decideBrainAdmin, decideProjectAccess } from '../server/services/identity/policy.ts';
import {
  checkPreference,
  isPreferenceKey,
  preferencesFor,
  setPreference,
} from '../server/services/russell/preferences.ts';
import {
  noteFor,
  whyThisMatters,
  worthSurfacing,
} from '../server/services/russell/whyThisMatters.ts';
import { parseRoute } from '../client/src/lib/router.ts';
import type { Principal, Project } from '../server/domain/types.ts';
import { RESEARCH_JUSTIFYING_GAPS } from '../server/domain/types.ts';

let project: Project;
let userId: string;

beforeEach(async () => {
  const fresh = await freshProject();
  project = fresh.project;
  const user = await createUser({
    email: `person-${Date.now()}@test.local`,
    displayName: 'A person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/* ==========================================================================
 * The rejected sentence
 * ========================================================================== */

describe('nothing settled yet does not read as nothing accomplished', () => {
  const eight = (done: number, working: number): Milestone[] =>
    Array.from({ length: 8 }, (_, index) => ({
      key: `m${index}`,
      title: `foundation ${index}`,
      done: index < done,
      detail: null,
      state:
        index < done
          ? ('DONE' as const)
          : index < done + working
            ? ('WORKING' as const)
            : ('OPEN' as const),
    }));

  it('never puts a bare nought-of-eight in front of a project that is working', () => {
    const progress = progressOf({
      milestones: eight(0, 3),
      closed: true,
      started: true,
      blockedBy: [],
      noun: 'Deal Dispatch',
      denominator: 'foundations',
    });
    expect(progress.headline).not.toMatch(/\b0 of 8\b/);
    expect(progress.headline).toMatch(/3 of 8 foundations under way/);
    // The fact itself is not softened — nothing has been settled and it says so.
    expect(progress.headline).toMatch(/nothing settled yet/);
  });

  it('still says plainly when nothing is settled and nothing is happening', () => {
    const progress = progressOf({
      milestones: eight(0, 0),
      closed: true,
      started: true,
      blockedBy: [],
      noun: 'Deal Dispatch',
      denominator: 'foundations',
    });
    expect(progress.headline).toMatch(/nothing settled yet, across 8 foundations/);
    expect(progress.headline).not.toMatch(/under way/);
  });

  it('names the denominator, because eight is not a quantity until you know eight of what', () => {
    const progress = progressOf({
      milestones: eight(3, 2),
      closed: true,
      started: true,
      blockedBy: [],
      noun: 'x',
      denominator: 'foundations',
    });
    expect(progress.headline).toMatch(/3 of 8 foundations settled/);
    expect(progress.denominator).toBe('foundations');
  });

  it('invents no percentage at any point on the scale', () => {
    for (const done of [0, 1, 4, 7, 8]) {
      const progress = progressOf({
        milestones: eight(done, 0),
        closed: true,
        started: true,
        blockedBy: [],
        noun: 'x',
        denominator: 'foundations',
      });
      expect(progress.headline).not.toMatch(/%/);
    }
  });

  it('reports blocked rather than a fraction, however much is settled', () => {
    const progress = progressOf({
      milestones: eight(7, 0),
      closed: true,
      started: true,
      blockedBy: ['a document nobody can read'],
      noun: 'x',
      denominator: 'foundations',
    });
    expect(progress.stage).toBe('BLOCKED');
    expect(progress.headline).toMatch(/a document nobody can read/);
    expect(progress.headline).not.toMatch(/ of /);
  });

  it('gives a real project its foundations in plain words, never the internal key', async () => {
    const progress = await projectProgress({
      projectId: project.id,
      projectName: project.name,
    });
    const titles = progress.milestones.map((milestone) => milestone.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).not.toContain('Monetization Logic');
    expect(titles).toContain('How the money works');
    // Every milestone carries its own state, so the strip can show a shape
    // rather than one number.
    for (const milestone of progress.milestones) {
      expect(['DONE', 'WORKING', 'BLOCKED', 'OPEN']).toContain(milestone.state);
    }
  });

  it('describes an open-ended set without implying a finish line', () => {
    const sentence = describeProgress(
      {
        stage: 'FORMING',
        completed: [],
        missing: [],
        ratio: null,
        denominator: 'missions',
        blockedBy: [],
        milestones: [],
      },
      'this work',
    );
    expect(sentence).not.toMatch(/ of /);
  });
});

/* ==========================================================================
 * Collections
 * ========================================================================== */

describe('conversations are organized, and a person always wins', () => {
  it('files a project thread under the project and a private one under Personal', () => {
    expect(collectionNameFor({ projectName: 'Deal Dispatch', visibility: 'PRIVATE' })).toEqual({
      name: 'Deal Dispatch',
      kind: 'PROJECT',
    });
    expect(collectionNameFor({ projectName: null, visibility: 'PRIVATE' })).toEqual({
      name: 'Personal',
      kind: 'PERSONAL',
    });
    expect(collectionNameFor({ projectName: null, visibility: 'SHARED' })).toEqual({
      name: 'Unfiled',
      kind: 'CATEGORY',
    });
  });

  it('organizes without inventing a category, and does it once however often it runs', async () => {
    await createConversation({ ownerUserId: userId, title: 'About the money', projectId: project.id });
    await createConversation({ ownerUserId: userId, title: 'A private note', projectId: null });

    await organize(userId);
    await organize(userId);
    await organize(userId);

    const collections = await listCollections(userId);
    expect(collections.map((collection) => collection.name).sort()).toEqual([
      'Deal Dispatch',
      'Personal',
    ]);
  });

  it('never moves a thread a person filed by hand', async () => {
    const thread = await createConversation({
      ownerUserId: userId,
      title: 'About the money',
      projectId: project.id,
    });
    const mine = await ensureCollection({
      ownerUserId: userId,
      name: 'My own heading',
      kind: 'CATEGORY',
      source: 'USER',
    });
    const moved = await fileConversation({
      conversationId: thread.id,
      ownerUserId: userId,
      collectionId: mine.id,
      actor: 'USER',
    });
    expect(moved).toBe(true);

    await organize(userId);

    const after = await getConversation(thread.id);
    expect(after?.collectionId).toBe(mine.id);
    expect(after?.collectionSource).toBe('USER');
  });

  it('refuses to file somebody else’s thread, whoever asks', async () => {
    const other = await createUser({
      email: `other-${Date.now()}@test.local`,
      displayName: 'Someone else',
      password: 'correct horse battery staple',
    });
    const theirs = await createConversation({
      ownerUserId: other.id,
      title: 'Their thread',
      projectId: null,
    });
    const mine = await ensureCollection({
      ownerUserId: userId,
      name: 'Mine',
      kind: 'CATEGORY',
    });
    const moved = await fileConversation({
      conversationId: theirs.id,
      ownerUserId: userId,
      collectionId: mine.id,
      actor: 'USER',
    });
    // The owner check is in the statement, so this is refused rather than
    // filtered afterwards by a caller that might forget.
    expect(moved).toBe(false);
  });

  it('ranks by meaning, not by recency', () => {
    const base: Omit<RankedThread, 'id' | 'standing' | 'standingLabel' | 'updatedAt'> = {
      title: 't',
      reason: '',
      projectId: null,
      visibility: 'PRIVATE',
      closedAt: null,
      collectionId: null,
      filedBy: 'AUTOMATIC',
    };
    const ordered = orderThreads([
      { ...base, id: 'recent', standing: 'ACTIVE', standingLabel: 'Active', updatedAt: '2026-09-12T00:00:00.000Z' },
      { ...base, id: 'old-major', standing: 'MAJOR_UNFINISHED', standingLabel: 'Major, unfinished', updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...base, id: 'finished', standing: 'FINISHED', standingLabel: 'Finished', updatedAt: '2026-09-13T00:00:00.000Z' },
    ]);
    expect(ordered.map((thread) => thread.id)).toEqual(['old-major', 'recent', 'finished']);
  });

  it('treats a person saying "finished" as the fact it is, over every derivation', () => {
    const closed = standingOf({
      closedAt: '2026-09-12T00:00:00.000Z',
      awaitingAnswer: true,
      liveMissions: 3,
      major: true,
      decisionsWaiting: 2,
    });
    expect(closed.standing).toBe('FINISHED');
  });

  it('calls a thread unfinished for each of the three real reasons, and active otherwise', () => {
    expect(
      standingOf({ closedAt: null, awaitingAnswer: true, liveMissions: 0, major: false, decisionsWaiting: 0 })
        .standing,
    ).toBe('UNFINISHED');
    expect(
      standingOf({ closedAt: null, awaitingAnswer: false, liveMissions: 1, major: false, decisionsWaiting: 0 })
        .standing,
    ).toBe('UNFINISHED');
    expect(
      standingOf({ closedAt: null, awaitingAnswer: false, liveMissions: 0, major: false, decisionsWaiting: 1 })
        .standing,
    ).toBe('UNFINISHED');
    expect(
      standingOf({ closedAt: null, awaitingAnswer: false, liveMissions: 0, major: false, decisionsWaiting: 0 })
        .standing,
    ).toBe('ACTIVE');
    // Major only counts when something is also outstanding: a big thread that
    // is finished belongs at the bottom with the rest of the finished ones.
    expect(
      standingOf({ closedAt: null, awaitingAnswer: false, liveMissions: 0, major: true, decisionsWaiting: 0 })
        .standing,
    ).toBe('ACTIVE');
  });

  it('reads a thread with an unanswered question as unfinished, end to end', async () => {
    const thread = await createConversation({
      ownerUserId: userId,
      title: 'About the money',
      projectId: project.id,
    });
    await addMessage({
      conversationId: thread.id,
      role: 'USER',
      authorUserId: userId,
      content: 'What do the margins actually look like?',
      status: 'COMPLETE',
    });

    const views = await collectionsFor({
      ownerUserId: userId,
      projectId: project.id,
      projectName: project.name,
    });
    const found = views
      .flatMap((view) => view.threads)
      .find((entry) => entry.id === thread.id);
    expect(found?.standing).toBe('UNFINISHED');
    expect(found?.standingLabel).toBe('Unfinished');
    expect(found?.reason).toMatch(/not answered/i);
  });

  it('shows a closed thread as finished, and lets a person reopen it', async () => {
    const thread = await createConversation({
      ownerUserId: userId,
      title: 'Done with this',
      projectId: project.id,
    });
    await setConversationClosed({ conversationId: thread.id, ownerUserId: userId, closed: true });
    let views = await collectionsFor({
      ownerUserId: userId,
      projectId: project.id,
      projectName: project.name,
    });
    expect(views.flatMap((view) => view.threads).find((t) => t.id === thread.id)?.standing).toBe(
      'FINISHED',
    );

    await setConversationClosed({ conversationId: thread.id, ownerUserId: userId, closed: false });
    views = await collectionsFor({
      ownerUserId: userId,
      projectId: project.id,
      projectName: project.name,
    });
    expect(views.flatMap((view) => view.threads).find((t) => t.id === thread.id)?.standing).not.toBe(
      'FINISHED',
    );
  });

  it('offers no filler starter when there is nothing true to suggest', async () => {
    await createConversation({ ownerUserId: userId, title: 'A thread', projectId: project.id });
    const views = await collectionsFor({
      ownerUserId: userId,
      projectId: project.id,
      projectName: project.name,
    });
    for (const view of views) {
      for (const starter of view.starters) {
        // Every starter names something, and none of them is the generic
        // prompt §7 rules out.
        expect(starter.text).not.toMatch(/what would you like/i);
        expect(starter.from).toBeTruthy();
      }
    }
  });

  it('shows one person nothing of another person’s threads', async () => {
    const other = await createUser({
      email: `other2-${Date.now()}@test.local`,
      displayName: 'Someone else',
      password: 'correct horse battery staple',
    });
    await createConversation({
      ownerUserId: other.id,
      title: 'Their private thinking',
      projectId: project.id,
    });
    await createConversation({ ownerUserId: userId, title: 'Mine', projectId: project.id });

    const views = await collectionsFor({
      ownerUserId: userId,
      projectId: project.id,
      projectName: project.name,
    });
    const titles = views.flatMap((view) => view.threads).map((thread) => thread.title);
    expect(titles).toContain('Mine');
    expect(titles).not.toContain('Their private thinking');
  });
});

/* ==========================================================================
 * The home projection
 * ========================================================================== */

describe('Russell’s own state, and the one live line', () => {
  it('says nothing at all when there is nothing true to say', () => {
    expect(pulseOf({ running: [], probing: [], unjudged: [], gaps: [] })).toBeNull();
  });

  it('names what is running before anything else', () => {
    const line = pulseOf({
      running: [{ objective: 'Establish how county recording fees work' } as never],
      probing: [{ title: 'A cheaper idea' } as never],
      unjudged: [],
      gaps: ['something else'],
    });
    expect(line).toMatch(/^establish how county recording fees work/);
  });

  it('falls back through probe, unjudged idea and recorded gap, in that order', () => {
    expect(pulseOf({ running: [], probing: [{ title: 'A probe subject' } as never], unjudged: [], gaps: [] }))
      .toMatch(/a probe subject/);
    expect(pulseOf({ running: [], probing: [], unjudged: [{ title: 'An idea' } as never], gaps: [] }))
      .toMatch(/an idea/);
    expect(pulseOf({ running: [], probing: [], unjudged: [], gaps: ['A written-down gap'] }))
      .toMatch(/a written-down gap/);
  });

  it('reports paused, stopped and broken as three different things', () => {
    expect(
      stateOf({ cycleState: 'PAUSED', cycleError: null, power: 'READY', working: 0, decisionsWaiting: 0 })
        .state,
    ).toBe('PAUSED');
    expect(
      stateOf({ cycleState: 'STOPPED', cycleError: null, power: 'READY', working: 0, decisionsWaiting: 0 })
        .state,
    ).toBe('DEGRADED');
    expect(
      stateOf({ cycleState: 'RUNNING', cycleError: 'it threw', power: 'READY', working: 0, decisionsWaiting: 0 })
        .state,
    ).toBe('DEGRADED');
  });

  it('never reports itself healthy while its own loop is throwing', () => {
    const verdict = stateOf({
      cycleState: 'RUNNING',
      cycleError: 'the last tick failed',
      power: 'READY',
      working: 4,
      decisionsWaiting: 0,
    });
    // Four things running is not evidence of health when the loop that starts
    // them is failing.
    expect(verdict.state).toBe('DEGRADED');
    expect(verdict.reason).toMatch(/the last tick failed/);
  });

  it('says limited when there is nowhere for work to run', () => {
    expect(
      stateOf({ cycleState: 'RUNNING', cycleError: null, power: 'NONE', working: 0, decisionsWaiting: 0 })
        .state,
    ).toBe('LIMITED');
  });

  it('says waiting — not live — when a decision is what is holding things up', () => {
    expect(
      stateOf({ cycleState: 'RUNNING', cycleError: null, power: 'READY', working: 0, decisionsWaiting: 2 })
        .state,
    ).toBe('WAITING');
  });
});

/* ==========================================================================
 * The Discovery Frontier
 * ========================================================================== */

describe('the frontier reads a project’s edges from its own rows', () => {
  const knowledge = (
    kind: string,
    statement: string,
    confidence = 'SUPPORTED',
  ): {
    id: string;
    kind: string;
    statement: string;
    detail: string | null;
    confidence: string;
    visibility: 'PRIVATE' | 'SHARED';
  } => ({
    id: `k-${statement.slice(0, 8)}`,
    kind,
    statement,
    detail: null,
    confidence,
    visibility: 'SHARED',
  });

  /*
   * The two regions a reader most needs kept apart, and a whole class of gap
   * was in the wrong one.
   *
   * `classify` compared `gap.classification === 'FOUNDATIONAL'`, which is not a
   * member of `GAP_CLASSIFICATIONS` — the vocabulary has `FOUNDATIONAL_GAP` —
   * so the branch was unreachable and every judge-classified gap was recorded as
   * WEAK_GROUND, "believed on evidence that would not survive much scrutiny",
   * when a foundational gap is precisely OPEN_QUESTION, "known to be
   * unanswered".
   *
   * The set was wrong as well as the spelling: the domain says **two**
   * classifications may keep a layer open, and `RESEARCH_JUSTIFYING_GAPS` has
   * held both since the audit engine was written. Asserted against that
   * constant rather than against a list here, so a classification added to it
   * reaches this reading without anybody remembering to update a test.
   */
  it('files a gap that may keep research open as an open question, not as thin belief', () => {
    const items = classify({
      knowledge: [],
      candidates: [],
      layers: [],
      gaps: [
        {
          id: 'gap-foundational',
          title: 'Nobody has established how the fee is set',
          detail: 'The layer cannot be relied on until this is answered.',
          classification: 'FOUNDATIONAL_GAP',
        },
        {
          id: 'gap-targeted',
          title: 'One bounded unknown needs a focused run',
          detail: 'Architecture is sound; this is a single question.',
          classification: 'TARGETED_RESEARCH_GAP',
        },
        {
          id: 'gap-patch',
          title: 'The summary overclaims one county',
          detail: 'Evidence already suffices; correct it in synthesis.',
          classification: 'PATCH',
        },
      ],
    });

    const region = (id: string): string | undefined =>
      items.find((item) => item.sourceId === id)?.region;

    // Both classifications the domain says may keep a layer open.
    for (const classification of RESEARCH_JUSTIFYING_GAPS) {
      const id = classification === 'FOUNDATIONAL_GAP' ? 'gap-foundational' : 'gap-targeted';
      expect(region(id)).toBe('OPEN_QUESTION');
    }
    // And one it does not: still weak ground, because it describes something
    // believed that the audit was not satisfied by.
    expect(region('gap-patch')).toBe('WEAK_GROUND');
  });

  it('separates what is believed well from what is believed thinly', () => {
    const items = classify({
      knowledge: [
        knowledge('CONCLUSION', 'Recording fees are set per instrument', 'ESTABLISHED'),
        knowledge('CONCLUSION', 'Most counties accept e-recording', 'UNCERTAIN'),
      ],
      layers: [],
      gaps: [],
      candidates: [],
    });
    expect(items.find((item) => item.subject.startsWith('Recording fees'))?.region).toBe(
      'SOLID_GROUND',
    );
    expect(items.find((item) => item.subject.startsWith('Most counties'))?.region).toBe(
      'WEAK_GROUND',
    );
  });

  it('does not confuse something believed on thin evidence with something unanswered', () => {
    const items = classify({
      knowledge: [
        knowledge('ASSUMPTION', 'Volume scales with population', 'UNCERTAIN'),
        knowledge('UNKNOWN', 'Whether fee schedules are published centrally'),
      ],
      layers: [],
      gaps: [],
      candidates: [],
    });
    // The project believes the first and does not believe the second. A
    // frontier that showed them the same way could not tell a person what
    // needs shoring up from what needs answering.
    expect(items[0]?.region).toBe('WEAK_GROUND');
    expect(items[1]?.region).toBe('OPEN_QUESTION');
  });

  it('reads a declared region nobody has started as unexamined, in plain words', () => {
    const items = classify({
      knowledge: [],
      layers: [
        { id: 'l1', name: 'Monetization Logic', status: 'NOT_STARTED' },
        { id: 'l2', name: 'World Model', status: 'FROZEN' },
      ],
      gaps: [],
      candidates: [],
    });
    const unexamined = items.filter((item) => item.region === 'UNEXAMINED');
    expect(unexamined).toHaveLength(1);
    expect(unexamined[0]?.subject).toBe('How the money works');
    expect(unexamined[0]?.sourceKind).toBe('LAYER');
  });

  it('counts only ideas Russell had itself as new paths', () => {
    const items = classify({
      knowledge: [],
      layers: [],
      gaps: [],
      candidates: [
        {
          id: 'c1',
          title: 'A second business model in rejected leads',
          statement: 'Rejected leads may cluster',
          conversationId: null,
          state: 'CAPTURED',
          visibility: 'SHARED',
        },
        {
          id: 'c2',
          title: 'Something a person asked for',
          statement: 'Please look at this',
          conversationId: 'rcv_1',
          state: 'CAPTURED',
          visibility: 'SHARED',
        },
      ],
    });
    const paths = items.filter((item) => item.region === 'NEW_PATH');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.sourceId).toBe('c1');
  });

  it('never invents a finding: every item names the row it came from', () => {
    const items = classify({
      knowledge: [knowledge('CONTRADICTION', 'Two sources disagree about the fee')],
      layers: [{ id: 'l1', name: 'Taxonomy', status: 'NOT_STARTED' }],
      gaps: [{ id: 'g1', title: 'No primary source for the fee', detail: null, classification: 'FOUNDATIONAL' }],
      candidates: [],
    });
    for (const item of items) {
      expect(item.sourceKind).toBeTruthy();
      expect(item.sourceId).toBeTruthy();
    }
  });

  it('puts the judgment questions rather than answering them', async () => {
    const view = await frontierFor({ projectId: project.id, projectName: project.name });
    // Every asked lens is a question, and none of them comes back with an
    // answer attached — a discovery engine that filled these in would be
    // manufacturing insight.
    expect(view.openLenses.length).toBeGreaterThan(0);
    for (const lens of view.openLenses) {
      expect(lens.question.endsWith('?')).toBe(true);
    }
  });

  it('is a reading of now: it refreshes, and reports what it produced', async () => {
    const first = await refreshFrontier(project.id);
    expect(first.observed).toBeGreaterThan(0);
    // Every declared layer that nobody has started is on the frontier.
    expect(first.byRegion.UNEXAMINED).toBeGreaterThan(0);

    const again = await refreshFrontier(project.id);
    // Idempotent: the same pass twice observes the same items and resolves none.
    expect(again.observed).toBe(first.observed);
    expect(again.resolved).toBe(0);
  });

  it('resolves an area that stops being true rather than deleting it', async () => {
    await observeFrontierItem({
      projectId: project.id,
      region: 'OPEN_QUESTION',
      subject: 'Something that will stop being true',
      sourceKind: 'KNOWLEDGE',
      sourceId: 'k-gone',
    });
    // A pass that does not observe it resolves it — and it is still readable,
    // because a delete would make a dark spot look like progress.
    await refreshFrontier(project.id);
    const all = await listFrontier({ projectId: project.id, includeResolved: true });
    const gone = all.find((item) => item.subject === 'Something that will stop being true');
    expect(gone).toBeTruthy();
    expect(gone?.resolvedAt).not.toBeNull();

    const live = await listFrontier({ projectId: project.id });
    expect(live.find((item) => item.subject === 'Something that will stop being true')).toBeUndefined();
  });

  it('remembers when an area first appeared, across re-readings', async () => {
    await refreshFrontier(project.id);
    const before = (await listFrontier({ projectId: project.id }))[0];
    expect(before).toBeTruthy();
    await refreshFrontier(project.id);
    const after = (await listFrontier({ projectId: project.id })).find(
      (item) => item.id === before!.id,
    );
    // "This has been open since March" has to stay answerable.
    expect(after?.firstSeenAt).toBe(before!.firstSeenAt);
  });

  it('lets a person say an area is deliberately not required, with a reason, reversibly', async () => {
    await refreshFrontier(project.id);
    const item = (await listFrontier({ projectId: project.id })).find(
      (entry) => entry.region === 'UNEXAMINED',
    );
    expect(item).toBeTruthy();

    const marked = await dismissFrontierItem({
      id: item!.id,
      projectId: project.id,
      userId,
      reason: 'Out of scope for this business',
      dismissed: true,
    });
    expect(marked).toBe(true);

    const after = (await listFrontier({ projectId: project.id })).find((e) => e.id === item!.id);
    // Still on the frontier, and now carrying the decision. Hiding it would
    // recreate the silent dark spot the dismissal exists to make explicit.
    expect(after?.dismissedAt).not.toBeNull();
    expect(after?.dismissedReason).toBe('Out of scope for this business');
    expect(after?.dismissedByUserId).toBe(userId);

    await dismissFrontierItem({
      id: item!.id,
      projectId: project.id,
      userId,
      reason: 'It is required after all',
      dismissed: false,
    });
    const back = (await listFrontier({ projectId: project.id })).find((e) => e.id === item!.id);
    expect(back?.dismissedAt).toBeNull();
  });

  it('refuses to dismiss an item belonging to another project', async () => {
    await refreshFrontier(project.id);
    const item = (await listFrontier({ projectId: project.id }))[0];
    const refused = await dismissFrontierItem({
      id: item!.id,
      projectId: 'prj_somebody_else',
      userId,
      reason: 'should not work',
      dismissed: true,
    });
    expect(refused).toBe(false);
  });

  it('says which regions could justify a look, and forms no opinion about value', async () => {
    await refreshFrontier(project.id);
    const items = await listFrontier({ projectId: project.id });
    for (const item of items) {
      const could = couldBecomeWork(item);
      if (item.region === 'SOLID_GROUND' || item.region === 'NEW_PATH') expect(could).toBe(false);
      if (item.region === 'UNEXAMINED') expect(could).toBe(true);
    }
  });
});

/* ==========================================================================
 * Search
 * ========================================================================== */

describe('search is scoped before it runs, never filtered after', () => {
  let person: Principal;
  let outsider: Principal;

  /**
   * A person, built the way `authenticate.ts` builds one.
   *
   * Memberships are the whole point of the scoping tests below, so they are
   * real rather than stubbed: the outsider has none, which is what makes
   * "nothing found" and "nothing you can see" indistinguishable.
   */
  function personWith(id: string, projectIds: string[]): Principal {
    return {
      type: 'HUMAN',
      id,
      handle: `${id}@test.local`,
      displayName: 'A person',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: `ses-${id}`,
      authMethod: 'SESSION_COOKIE',
      memberships: projectIds.map((projectId) => ({
        projectId,
        role: 'OWNER',
        scopes: [],
        active: true,
      })) as unknown as Principal['memberships'],
      requestId: 'test-request',
    };
  }

  beforeEach(() => {
    person = personWith(userId, [project.id]);
    outsider = personWith('usr_outsider', []);
  });

  it('returns nothing for a one-character query rather than a page of noise', async () => {
    const result = await search({ principal: person, query: 'a' });
    expect(result.hits).toHaveLength(0);
    expect(result.scopedProjects).toBe(0);
  });

  it('finds a person’s own conversation by title', async () => {
    await createConversation({
      ownerUserId: userId,
      title: 'County recording fees',
      projectId: project.id,
    });
    const result = await search({ principal: person, query: 'recording' });
    const titles = result.hits.map((hit) => hit.title);
    expect(titles).toContain('County recording fees');
  });

  it('never returns another person’s private conversation, whatever their project rights', async () => {
    const other = await createUser({
      email: `s-other-${Date.now()}@test.local`,
      displayName: 'Someone else',
      password: 'correct horse battery staple',
    });
    await createConversation({
      ownerUserId: other.id,
      title: 'A secret about recording',
      projectId: project.id,
    });
    const result = await search({ principal: person, query: 'secret' });
    expect(result.hits.map((hit) => hit.title)).not.toContain('A secret about recording');
  });

  it('shows a caller with no readable project the same answer as a genuine miss', async () => {
    await createConversation({
      ownerUserId: userId,
      title: 'County recording fees',
      projectId: project.id,
    });
    const result = await search({ principal: outsider, query: 'recording' });
    // No hits, and no count that would reveal how many projects exist.
    expect(result.hits).toHaveLength(0);
    expect(result.scopedProjects).toBe(0);
  });

  it('returns nothing at all for an unauthenticated caller', async () => {
    const result = await search({ principal: null, query: 'recording' });
    expect(result.hits).toHaveLength(0);
  });

  it('treats a wildcard as text rather than as a pattern', async () => {
    await createConversation({ ownerUserId: userId, title: 'Ordinary title', projectId: project.id });
    const result = await search({ principal: person, query: '%%' });
    // `%%` matching everything would be the classic injection-by-metacharacter;
    // it searches for two per-cent signs, and finds none.
    expect(result.hits).toHaveLength(0);
  });

  it('ranks a title match above a body match', async () => {
    await createConversation({
      ownerUserId: userId,
      title: 'Margins',
      projectId: project.id,
    });
    await createConversation({
      ownerUserId: userId,
      title: 'Something else entirely',
      projectId: project.id,
    });
    const result = await search({ principal: person, query: 'margins' });
    expect(result.hits[0]?.title).toBe('Margins');
  });

  it('hands back a real address for every hit', async () => {
    await createConversation({ ownerUserId: userId, title: 'Recording fees', projectId: project.id });
    const result = await search({ principal: person, query: 'recording' });
    for (const hit of result.hits) {
      expect(hit.href.startsWith('/')).toBe(true);
      expect(parseRoute(hit.href).name).not.toBe('NOT_FOUND');
    }
  });
});

/* ==========================================================================
 * Fleet and the Capability Lab
 * ========================================================================== */

describe('the fleet reports three different numbers, and never rounds one up', () => {
  it('separates a configured target from a usable surface from an observed throughput', async () => {
    const view = await fleetView({ includeTechnical: true });
    // Three readings, three evidence classes. A throughput nobody has observed
    // must read UNKNOWN rather than become a confident zero.
    expect(view.provisioned.evidence).toBeTruthy();
    expect(view.usable.evidence).toBe('MEASURED');
    expect(['MEASURED', 'UNKNOWN', 'PROVIDER_ENFORCED']).toContain(view.measured.evidence);
    expect(view.provisioned.explanation).not.toBe(view.usable.explanation);
  });

  it('says the backlog does not fit only when it knows, and otherwise says nothing', async () => {
    const view = await fleetView({ includeTechnical: true });
    // With no surface registered the answer is a definite no — a fact, not a
    // projection. It is never a confident yes without a measurement.
    expect(view.fits === false || view.fits === null || view.fits === true).toBe(true);
    if (view.usable.value === 0) expect(view.fits).toBe(false);
  });

  it('withholds raw identifiers from a caller not entitled to them', async () => {
    const open = await fleetView({ includeTechnical: true });
    const closed = await fleetView({ includeTechnical: false });
    for (const surface of closed.surfaces) {
      // Null is "you are not told", which is different from "there is none".
      expect(surface.workerId).toBeNull();
    }
    expect(closed.surfaces.length).toBe(open.surfaces.length);
  });

  it('names each reason a surface cannot be fired separately', () => {
    const base = {
      id: 'fr_1',
      accountId: 'fa_1',
      name: 'V1',
      routineRef: 'trig_x',
      state: 'ENABLED',
      capabilities: [],
      tokenSecretName: 'SECRET',
      tokenDigest: 'abc',
      workerId: null,
      fireGeneration: 1,
      consecutiveFailures: 0,
      consecutiveNoShows: 0,
      retryAt: null,
    } as never;
    const account = { id: 'fa_1', name: 'primary', state: 'ENABLED' } as never;
    const now = '2026-09-12T00:00:00.000Z';

    expect(usability(base, undefined, now).reason).toMatch(/account is not registered/i);
    expect(usability({ ...(base as object), tokenSecretName: null } as never, account, now).reason).toMatch(
      /deployment secret/i,
    );
    expect(usability({ ...(base as object), state: 'QUARANTINED' } as never, account, now).reason).toMatch(
      /held back/i,
    );
    expect(
      usability({ ...(base as object), retryAt: '2026-09-13T00:00:00.000Z' } as never, account, now)
        .reason,
    ).toMatch(/refusal/i);
    // A healthy one has no reason at all, because there is nothing to say.
    expect(usability(base, account, now)).toEqual({ usable: true, reason: null, recorded: null });
  });

  it('carries the reason the dispatcher recorded, beside the category rather than instead of it', () => {
    const base = {
      id: 'fr_1',
      accountId: 'fa_1',
      name: 'V1',
      routineRef: 'trig_x',
      state: 'QUARANTINED',
      stateReason:
        'The provider refused a fire with AUTH: 401 Token is not authorized for this routine.',
      capabilities: [],
      tokenSecretName: 'SECRET',
      tokenDigest: 'abc',
      workerId: null,
      fireGeneration: 1,
      consecutiveFailures: 0,
      consecutiveNoShows: 0,
      retryAt: null,
    } as never;
    const account = { id: 'fa_1', name: 'primary', state: 'ENABLED' } as never;
    const now = '2026-09-12T00:00:00.000Z';

    const held = usability(base, account, now);
    // The category is what a person is owed and does not change.
    expect(held.reason).toMatch(/held back/i);
    // The evidence is what an operator needs, and it is the provider's words.
    expect(held.recorded).toMatch(/401 Token is not authorized/);

    // A healthy surface's last recorded reason is history, not a condition.
    expect(usability({ ...(base as object), state: 'ENABLED' } as never, account, now).recorded).toBeNull();

    // An empty reason is the same answer as none: a blank string must never
    // reach a reader as though something had been recorded.
    expect(usability({ ...(base as object), stateReason: '   ' } as never, account, now).recorded).toBeNull();
  });

  it('treats the recorded refusal as technical detail, like every other raw value', async () => {
    const open = await fleetView({ includeTechnical: true });
    const closed = await fleetView({ includeTechnical: false });
    for (const surface of closed.surfaces) {
      expect(surface.recordedReason).toBeNull();
    }
    // The plain sentence is not withheld — it is what a person is owed.
    expect(closed.surfaces.map((surface) => surface.reason)).toEqual(
      open.surfaces.map((surface) => surface.reason),
    );
  });

  it('explains a gap from the events either side of it, never from elapsed time', () => {
    expect(meaningOfGap('BIN_READY', 'DISPATCH_INTENT')).toMatch(/dispatcher to notice/i);
    expect(meaningOfGap('DISPATCH_SENT', 'BIN_ASSIGNED')).toMatch(/fired worker to arrive/i);
    expect(meaningOfGap('BIN_ASSIGNMENT_REFUSED', 'BIN_ASSIGNED')).toMatch(/not eligible/i);
    // Two events with no known relationship get an honest non-answer rather
    // than a plausible one.
    expect(meaningOfGap('BIN_HEARTBEAT', 'BIN_CHECKPOINT')).toMatch(/does not attribute/i);
  });

  it('says what it could not determine rather than filling the hole', async () => {
    const explanation = await explainSlowness('bin_that_does_not_exist');
    expect(explanation.steps).toHaveLength(0);
    expect(explanation.largestGap).toBeNull();
    expect(explanation.unknowns.length).toBeGreaterThan(0);
  });
});

describe('the Capability Lab is bounded before it runs', () => {
  it('refuses a pressure test with no ceiling, no duration or no stop condition', () => {
    const complete = {
      ceiling: 5,
      durationMinutes: 10,
      stopConditions: ['a provider refusal'],
      cleanup: 'delete the synthetic bins',
      rollback: 'revert the policy version',
      workloadClass: 'RESEARCH',
      workKind: 'SYNTHETIC' as const,
    };
    expect(checkEnvelope('PUSH_TO_FAILURE', complete).ok).toBe(true);
    expect(checkEnvelope('PUSH_TO_FAILURE', { ...complete, ceiling: 0 }).ok).toBe(false);
    expect(checkEnvelope('PUSH_TO_FAILURE', { ...complete, durationMinutes: 0 }).ok).toBe(false);
    expect(checkEnvelope('PUSH_TO_FAILURE', { ...complete, stopConditions: [] }).ok).toBe(false);
    expect(checkEnvelope('PUSH_TO_FAILURE', { ...complete, cleanup: '' }).ok).toBe(false);
    expect(checkEnvelope('PUSH_TO_FAILURE', { ...complete, rollback: '' }).ok).toBe(false);
  });

  it('refuses real work as a first canary, and says why', () => {
    const verdict = checkEnvelope('PUSH_TO_FAILURE', {
      ceiling: 5,
      durationMinutes: 10,
      stopConditions: ['a provider refusal'],
      cleanup: 'nothing to clean',
      rollback: 'nothing to revert',
      workloadClass: 'RESEARCH',
      workKind: 'REAL_CANARY',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/synthetic and replay tests have passed/i);
  });

  it('does not hold a health check to a pressure envelope', () => {
    expect(
      checkEnvelope('HEALTH_CHECK', {
        ceiling: 0,
        durationMinutes: 0,
        stopConditions: [],
        cleanup: '',
        rollback: '',
        workloadClass: 'NONE',
        workKind: 'SYNTHETIC',
      }).ok,
    ).toBe(true);
  });

  it('refuses a pressure test declared against a live project, and keeps the refusal', async () => {
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'PUSH_TO_FAILURE',
      title: 'How far can this go?',
      envelope: {
        ceiling: 5,
        durationMinutes: 10,
        stopConditions: ['a provider refusal'],
        cleanup: 'delete the synthetic bins',
        rollback: 'revert the policy version',
        workloadClass: 'RESEARCH',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    // Stored as refused rather than thrown away: what was asked for and why it
    // was not allowed is worth as much as a result.
    expect(declared.state).toBe('REFUSED');
    expect(declared.refusalReason).toMatch(/isolated testing scope/i);
  });

  it('runs a health check for real, spends nothing, and is plain about it', async () => {
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'HEALTH_CHECK',
      title: 'Is the fleet reachable?',
      envelope: {
        ceiling: 0,
        durationMinutes: 0,
        stopConditions: [],
        cleanup: 'Nothing is created.',
        rollback: 'Nothing is applied.',
        workloadClass: 'NONE',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    expect(declared.state).toBe('DECLARED');

    const ran = await runExperiment({ id: declared.id, pressureAuthorized: false });
    expect(ran.state).toBe('COMPLETE');
    expect(ran.result).toBeTruthy();
    // With no fleet registered it says so plainly rather than reporting health.
    expect(ran.result!.findings.join(' ')).toMatch(/No account is registered|registered/i);
    // And it is explicit about what a free check cannot tell you.
    expect(ran.result!.untested.join(' ')).toMatch(/real activation/i);
  });

  it('refuses to run a pressure test without a person authorizing it', async () => {
    const technical = await createProject({
      name: 'Capability Lab scope',
      slug: `lab-${Date.now()}`,
      purpose: 'TECHNICAL',
    });
    const declared = await declareExperiment({
      projectId: technical.id,
      mode: 'PUSH_TO_FAILURE',
      title: 'How far can this go?',
      envelope: {
        ceiling: 5,
        durationMinutes: 10,
        stopConditions: ['a provider refusal'],
        cleanup: 'delete the synthetic bins',
        rollback: 'revert the policy version',
        workloadClass: 'RESEARCH',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    expect(declared.state).toBe('DECLARED');

    const refused = await runExperiment({ id: declared.id, pressureAuthorized: false });
    expect(refused.state).toBe('REFUSED');
    expect(refused.refusalReason).toMatch(/needs a person to authorize/i);

    // Asking again changes nothing: the condition is about the grant, not the
    // attempt, so this is not a retry loop.
    const again = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(again.state).toBe('REFUSED');
  });

  it('never invents numbers for a pressure mode it could not run', async () => {
    /*
     * This test used to assert the words "declared but not implemented", which
     * was the right assertion while five of the eight modes had no runner. They
     * have runners now, so the assertion moved to the property that actually
     * matters and was never about implementation: **a mode that did not run
     * produces no result at all.**
     *
     * The condition exercised here is a real one — an isolated scope with no
     * worker holding `queue:claim`, so there is nothing that can legitimately
     * hold a lease — and the point is that the refusal names a remedy rather
     * than returning plausible figures.
     */
    const technical = await createProject({
      name: 'Capability Lab scope two',
      slug: `lab2-${Date.now()}`,
      purpose: 'TECHNICAL',
    });
    const declared = await declareExperiment({
      projectId: technical.id,
      mode: 'RECOVERY_DRILL',
      title: 'What happens when a worker disappears?',
      envelope: {
        ceiling: 3,
        durationMinutes: 5,
        stopConditions: ['detection takes longer than a minute'],
        cleanup: 'release the synthetic leases',
        rollback: 'nothing is applied',
        workloadClass: 'RESEARCH',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('REFUSED');
    expect(ran.refusalReason).toMatch(/queue:claim/);
    expect(ran.result).toBeNull();
  });

  it('marks a conclusion stale when the conditions it was measured under change', () => {
    expect(stalenessOf({ model: 'a', workloadClass: 'RESEARCH' }, { model: 'a', workloadClass: 'RESEARCH' })).toBeNull();
    const stale = stalenessOf({ model: 'a' }, { model: 'b' });
    expect(stale).toMatch(/model/);
    expect(stale).toMatch(/Retest/);
  });

  it('applies a finding as a new policy version and rolls it back forward', async () => {
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'CALIBRATION',
      title: 'What has the fleet done?',
      envelope: {
        ceiling: 0,
        durationMinutes: 0,
        stopConditions: [],
        cleanup: 'Nothing is created.',
        rollback: 'Revert the policy version.',
        workloadClass: 'RESEARCH',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: false });
    expect(ran.state).toBe('COMPLETE');

    const applied = await applyFinding({
      experimentId: ran.id,
      target: 4,
      actor: 'A person',
      reason: 'The ledger shows headroom',
    });
    expect(applied.appliedPolicyId).toBeTruthy();
    expect((await currentPolicy('FLEET', null))?.target).toBe(4);

    const back = await rollbackFinding({
      experimentId: ran.id,
      actor: 'A person',
      reason: 'It was too high',
    });
    expect(back.rolledBackAt).toBeTruthy();
    // Rolled back by writing forward: the applied version is still in the
    // history, and the revert carries its own reason.
    const history = await policyHistory('FLEET', null, 10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]?.reason).toMatch(/Rolled back/);
  });
});

/* ==========================================================================
 * Maps
 * ========================================================================== */

describe('a map draws only relationships that are recorded', () => {
  it('builds the system map from foundations the project actually declares', async () => {
    const view = await mapFor({
      type: 'SYSTEM',
      projectId: project.id,
      projectName: project.name,
    });
    expect(view.nodes.some((node) => node.kind === 'PROJECT')).toBe(true);
    expect(view.nodes.some((node) => node.kind === 'FOUNDATION')).toBe(true);
    // Plain names, never the internal key.
    expect(view.nodes.map((node) => node.label)).not.toContain('Monetization Logic');
    // Every edge joins two nodes that exist.
    const ids = new Set(view.nodes.map((node) => node.id));
    for (const edge of view.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it('says the money-flow map has nothing to draw rather than drawing plausible arrows', async () => {
    const view = await mapFor({
      type: 'MONEY_FLOW',
      projectId: project.id,
      projectName: project.name,
    });
    // The honest output: Brain holds no money for this project, so the map
    // reports that instead of inventing a financial model.
    expect(view.emptyReason).toMatch(/no money|nothing here to draw/i);
    expect(view.edges).toHaveLength(0);
  });

  it('says why every empty map is empty', async () => {
    for (const type of ['SYSTEM', 'WORKFLOW', 'KNOWLEDGE', 'DECISIONS', 'TIMELINE', 'MONEY_FLOW'] as const) {
      const view = await mapFor({ type, projectId: project.id, projectName: project.name });
      // A blank canvas with no sentence is the same failure as an empty list
      // that does not say whether it is loading, forbidden or genuinely empty.
      if (view.nodes.length === 0) expect(view.emptyReason).toBeTruthy();
    }
  });

  it('hands back an outline that is the same graph, not a second derivation', async () => {
    const view = await mapFor({
      type: 'SYSTEM',
      projectId: project.id,
      projectName: project.name,
    });
    expect(view.outline.length).toBe(view.nodes.length);
    const outlineIds = new Set(view.outline.map((row) => row.id));
    for (const node of view.nodes) expect(outlineIds.has(node.id)).toBe(true);
    // The root sits at depth zero, and children below it.
    expect(view.outline[0]?.depth).toBe(0);
  });

  it('survives a cycle in a recorded graph rather than looping for ever', () => {
    const outline = outlineOf(
      [
        { id: 'a', label: 'A', kind: 'X', state: null, detail: null, sourceId: 'a', at: null },
        { id: 'b', label: 'B', kind: 'X', state: null, detail: null, sourceId: 'b', at: null },
      ],
      [
        { from: 'a', to: 'b', kind: 'K', label: null },
        { from: 'b', to: 'a', kind: 'K', label: null },
      ],
    );
    // A contradiction can genuinely point both ways, so the guard is on having
    // seen the node rather than on depth — and both nodes still appear.
    expect(outline).toHaveLength(2);
  });
});

/* ==========================================================================
 * Preferences, and the line around them
 * ========================================================================== */

describe('a preference may never change a fact', () => {
  it('refuses a key that is not a declared preference', () => {
    expect(isPreferenceKey('depth')).toBe(true);
    // The keys somebody would reach for if this were a place to weaken a rule.
    expect(isPreferenceKey('evidenceFloor')).toBe(false);
    expect(isPreferenceKey('auditSeparation')).toBe(false);
    expect(isPreferenceKey('maxSpend')).toBe(false);
  });

  it('holds every declared key to its declared shape', () => {
    expect(checkPreference('depth', 'TECHNICAL').ok).toBe(true);
    expect(checkPreference('depth', 'ANYTHING').ok).toBe(false);
    expect(checkPreference('showPulse', true).ok).toBe(true);
    expect(checkPreference('showPulse', 'yes').ok).toBe(false);
  });

  it('gives every account a usable default with nothing stored', async () => {
    const preferences = await preferencesFor(userId);
    expect(preferences.depth).toBe('NORMAL');
    expect(preferences.showPulse).toBe(true);
    // Nobody has to be configured by an owner for the product to work.
    expect(Object.keys(preferences).length).toBeGreaterThan(0);
  });

  it('stores and reads back one person’s choice, and only theirs', async () => {
    const other = await createUser({
      email: `pref-${Date.now()}@test.local`,
      displayName: 'Someone else',
      password: 'correct horse battery staple',
    });
    await setPreference({ userId, key: 'depth', value: 'TECHNICAL' });
    expect((await preferencesFor(userId)).depth).toBe('TECHNICAL');
    // Nobody else's screen moved.
    expect((await preferencesFor(other.id)).depth).toBe('NORMAL');
  });

  it('is idempotent, so setting the same value twice is not two rows', async () => {
    await setPreference({ userId, key: 'depth', value: 'INTERESTED' });
    await setPreference({ userId, key: 'depth', value: 'INTERESTED' });
    expect((await preferencesFor(userId)).depth).toBe('INTERESTED');
  });
});

/* ==========================================================================
 * Why this matters
 * ========================================================================== */

describe('why this matters is grounded, quiet, and absent when there is nothing', () => {
  it('says nothing at all about a project where nothing has happened', async () => {
    const view = await whyThisMatters({ projectId: project.id, projectName: project.name });
    // An encouraging screen over an empty project is what makes a person stop
    // believing the rest of the product.
    expect(worthSurfacing(view)).toBe(false);
  });

  it('needs two milestones, or one and an ambition, before it surfaces', () => {
    const milestone = { kind: 'LAYER_SETTLED', what: 'How the market works', at: '2026-09-01T00:00:00.000Z', sourceId: 'l1' };
    expect(
      worthSurfacing({ ambition: null, milestones: [milestone], connection: null, note: null }),
    ).toBe(false);
    expect(
      worthSurfacing({ ambition: 'To find deals worth doing.', milestones: [milestone], connection: null, note: null }),
    ).toBe(true);
    expect(
      worthSurfacing({
        ambition: null,
        milestones: [milestone, { ...milestone, sourceId: 'l2' }],
        connection: null,
        note: null,
      }),
    ).toBe(true);
  });

  it('writes a note only from something countable, and otherwise none', () => {
    expect(noteFor({ milestones: [], ambition: null, workingNow: 0 })).toBeNull();
    const note = noteFor({
      milestones: [
        { kind: 'LAYER_SETTLED', what: 'How the market works', at: 'x', sourceId: 'a' },
        { kind: 'LAYER_SETTLED', what: 'How the money works', at: 'y', sourceId: 'b' },
      ],
      ambition: null,
      workingNow: 0,
    });
    expect(note).toMatch(/How the market works/);
    expect(note).toMatch(/How the money works/);
  });

  it('has no streak, badge, point, confetti or generic encouragement in it', () => {
    const notes = [
      noteFor({
        milestones: [
          { kind: 'LAYER_SETTLED', what: 'A', at: 'x', sourceId: 'a' },
          { kind: 'LAYER_SETTLED', what: 'B', at: 'y', sourceId: 'b' },
        ],
        ambition: null,
        workingNow: 0,
      }),
      noteFor({
        milestones: [
          { kind: 'REPORT_FILED', what: 'A', at: 'x', sourceId: 'a' },
          { kind: 'REPORT_FILED', what: 'B', at: 'y', sourceId: 'b' },
        ],
        ambition: null,
        workingNow: 0,
      }),
      noteFor({
        milestones: [
          { kind: 'EDGE_CLOSED', what: 'A', at: 'x', sourceId: 'a' },
          { kind: 'EDGE_CLOSED', what: 'B', at: 'y', sourceId: 'b' },
        ],
        ambition: 'To find deals worth doing.',
        workingNow: 0,
      }),
    ].filter((note): note is string => note !== null);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).not.toMatch(/streak|badge|points?\b|congratulations|great job|keep it up|🎉/i);
    }
  });
});

/* ==========================================================================
 * Collaboration — the capability matrix, tested rather than described
 * ========================================================================== */

describe('Owner, Member, Viewer and machine roles have a concrete matrix', () => {
  function human(role: string | null, projectId: string, isBrainAdmin = false): Principal {
    return {
      type: 'HUMAN',
      id: `usr_${role ?? 'none'}`,
      handle: 'a@b.test',
      displayName: 'A person',
      isBrainAdmin,
      mustChangePassword: false,
      credentialId: 'ses_1',
      authMethod: 'SESSION_COOKIE',
      memberships: role
        ? ([{ projectId, role, scopes: [], active: true }] as unknown as Principal['memberships'])
        : [],
      requestId: 'test',
    };
  }

  function worker(projectId: string, scopes: string[]): Principal {
    return {
      type: 'WORKER',
      id: 'wrk_1',
      handle: 'worker',
      displayName: 'A worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cred_1',
      authMethod: 'WORKER_BEARER',
      memberships: [
        { projectId, role: null, scopes, active: true },
      ] as unknown as Principal['memberships'],
      requestId: 'test',
    };
  }

  it('lets a viewer read and nothing else', () => {
    const viewer = human('VIEWER', project.id);
    expect(decideProjectAccess(viewer, project.id, 'READ').allowed).toBe(true);
    // A viewer reads only permitted content and cannot direct work.
    expect(decideProjectAccess(viewer, project.id, 'WRITE').allowed).toBe(false);
    expect(decideProjectAccess(viewer, project.id, 'ADMIN').allowed).toBe(false);
  });

  it('lets a member work but not administer', () => {
    const member = human('MEMBER', project.id);
    expect(decideProjectAccess(member, project.id, 'READ').allowed).toBe(true);
    expect(decideProjectAccess(member, project.id, 'WRITE').allowed).toBe(true);
    // Membership is not blanket authority to administer workers or change
    // who may do what.
    expect(decideProjectAccess(member, project.id, 'ADMIN').allowed).toBe(false);
  });

  it('lets an owner administer', () => {
    const owner = human('OWNER', project.id);
    for (const level of ['READ', 'WRITE', 'ADMIN'] as const) {
      expect(decideProjectAccess(owner, project.id, level).allowed).toBe(true);
    }
  });

  it('refuses somebody with no membership at all, at every level', () => {
    const stranger = human(null, project.id);
    for (const level of ['READ', 'WRITE', 'ADMIN'] as const) {
      const decision = decideProjectAccess(stranger, project.id, level);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('NOT_A_MEMBER');
    }
  });

  it('never lets a machine administer a project, however it is configured', () => {
    // Every scope there is, and it still cannot administer: project
    // administration is changing who may do what, and a machine credential
    // that could widen its own access is one whose theft is unbounded.
    const powerful = worker(project.id, ['project:read', 'project:write', 'external:sync']);
    expect(decideProjectAccess(powerful, project.id, 'READ').allowed).toBe(true);
    expect(decideProjectAccess(powerful, project.id, 'ADMIN').allowed).toBe(false);
    expect(decideProjectAccess(powerful, project.id, 'ADMIN').reason).toBe('INSUFFICIENT_ROLE');
  });

  it('refuses a machine write that did not name the scope it needs', () => {
    const machine = worker(project.id, ['project:read']);
    // Membership says which project; scopes say what. An unnamed write is
    // refused rather than waved through on the strength of membership.
    expect(decideProjectAccess(machine, project.id, 'WRITE').reason).toBe('MISSING_SCOPE');
  });

  it('refuses everybody with no credentials at all', () => {
    const decision = decideProjectAccess(null, project.id, 'READ');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NO_CREDENTIALS');
  });

  it('never lets a machine be a Brain administrator', () => {
    expect(decideBrainAdmin(worker(project.id, ['project:read'])).allowed).toBe(false);
    expect(decideBrainAdmin(human('OWNER', project.id, true)).allowed).toBe(true);
    expect(decideBrainAdmin(human('OWNER', project.id, false)).allowed).toBe(false);
  });
});

/* ==========================================================================
 * The asked lenses, given an execution path
 * ========================================================================== */

describe('a discovery lens only a reader can answer', () => {
  it('refuses to hand a derived lens to a worker', async () => {
    const { project } = await freshProject();
    const refused = await openInquiry({
      projectId: project.id,
      projectName: project.name,
      lens: 'CONTRADICTION',
      openedBy: 'u_test',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Named, not generic: the reason a person reads must say why this
      // particular question is not one to ask a model.
      expect(refused.reason).toMatch(/answered from the project's own rows/i);
    }
  });

  it('opens one inquiry per lens rather than racing two', async () => {
    const { project } = await freshProject();
    const first = await openInquiry({
      projectId: project.id,
      projectName: project.name,
      lens: 'ADJACENT_POSSIBILITY',
      openedBy: 'u_test',
    });
    const second = await openInquiry({
      projectId: project.id,
      projectName: project.name,
      lens: 'ADJACENT_POSSIBILITY',
      openedBy: 'u_test',
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.inquiry.id).toBe(first.inquiry.id);
  });

  it('discards a finding whose citations do not resolve to this project', () => {
    const context = {
      knowledgeIds: new Set(['rk_real']),
      layerIds: new Set<string>(),
      frontierIds: new Set<string>(),
      held: [] as string[],
    };
    const checked = validateLensReply(
      {
        findings: [
          {
            subject: 'Invented',
            statement: 'Something the project never recorded anywhere at all.',
            rationale: 'Because it sounded plausible.',
            references: [{ kind: 'KNOWLEDGE', id: 'rk_made_up' }],
          },
        ],
      },
      context,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.result.findings).toHaveLength(0);
      expect(checked.result.discarded).toBe(1);
      expect(checked.result.reasons[0]).toMatch(/is not a row this project holds/);
    }
  });

  it('discards a finding that restates something already held', () => {
    const held = 'Assessment rolls are published annually by each county treasurer.';
    const checked = validateLensReply(
      {
        findings: [
          {
            subject: 'Rolls',
            // A rewording, not a new idea.
            statement: 'Each county treasurer publishes assessment rolls annually.',
            rationale: 'Reworded.',
            references: [{ kind: 'KNOWLEDGE', id: 'rk_real' }],
          },
        ],
      },
      { knowledgeIds: new Set(['rk_real']), layerIds: new Set(), frontierIds: new Set(), held: [held] },
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.result.findings).toHaveLength(0);
      expect(checked.result.reasons[0]).toMatch(/restates something the project already holds/);
    }
  });

  it('refuses the whole reply for an unknown field rather than ignoring it', () => {
    const checked = validateLensReply(
      { findings: [], extra: 'something nobody declared' },
      { knowledgeIds: new Set(), layerIds: new Set(), frontierIds: new Set(), held: [] },
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/unknown field/);
  });

  it('accepts an empty answer as an answer', () => {
    const checked = validateLensReply(
      { findings: [] },
      { knowledgeIds: new Set(), layerIds: new Set(), frontierIds: new Set(), held: [] },
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.result.findings).toHaveLength(0);
      expect(checked.result.discarded).toBe(0);
    }
  });
});

/* ==========================================================================
 * The Capability Lab's pressure runners
 * ========================================================================== */

describe('the pressure runners measure Brain rather than a provider', () => {
  it('walks a ladder bounded by the declared ceiling', () => {
    expect(ladder(8)).toEqual([1, 2, 4, 8]);
    expect(ladder(1)).toEqual([1]);
    // A ceiling above the code's own limit is clamped rather than honoured.
    expect(ladder(10_000)[ladder(10_000).length - 1]).toBe(MAX_CONCURRENCY);
  });

  it('reports the knee as the last rung that improved, never as a maximum', () => {
    const rounds = [
      { concurrency: 1, items: 10, claimed: 10, lostRaces: 0, completed: 10, refusedCompletions: 0, elapsedMs: 1000, leftOver: 0 },
      { concurrency: 2, items: 10, claimed: 10, lostRaces: 0, completed: 10, refusedCompletions: 0, elapsedMs: 500, leftOver: 0 },
      { concurrency: 4, items: 10, claimed: 10, lostRaces: 8, completed: 10, refusedCompletions: 0, elapsedMs: 500, leftOver: 0 },
    ];
    const found = knee(rounds);
    expect(found?.concurrency).toBe(2);
    expect(found?.reason).toMatch(/did not improve throughput/);
  });

  it('calls an empty run unknown rather than zero', () => {
    const empty = [
      { concurrency: 1, items: 5, claimed: 0, lostRaces: 1, completed: 0, refusedCompletions: 0, elapsedMs: 10, leftOver: 5 },
    ];
    expect(evidenceFor(empty)).toBe('UNKNOWN');
  });

  it('never labels a queue measurement as a provider fact', () => {
    const done = [
      { concurrency: 1, items: 5, claimed: 5, lostRaces: 0, completed: 5, refusedCompletions: 0, elapsedMs: 10, leftOver: 0 },
    ];
    // MEASURED or UNKNOWN are the only two answers. PROVIDER_ENFORCED would be
    // a claim about a surface this runner never touched.
    expect(['MEASURED', 'UNKNOWN']).toContain(evidenceFor(done));
  });

  it('refuses a pressure run with no registered claimant, naming the remedy', async () => {
    const { project } = await freshProject();
    // A TECHNICAL scope so the declaration is not refused for isolation, and no
    // worker holding queue:claim in it, which is the condition under test.
    await getDb().run('UPDATE projects SET purpose = ? WHERE id = ?', ['TECHNICAL', project.id]);
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'RECOVERY_DRILL',
      title: 'drill with nowhere to hold a lease',
      envelope: {
        ceiling: 2,
        durationMinutes: 1,
        stopConditions: ['the drill finishes'],
        cleanup: 'cancel the synthetic item',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'u_test',
    });
    expect(declared.state).toBe('DECLARED');
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('REFUSED');
    expect(ran.refusalReason).toMatch(/npm run admin/);
    // And it did not pretend to have numbers.
    expect(ran.result).toBeNull();
  });

  it('still refuses a pressure mode that no person authorized', async () => {
    const { project } = await freshProject();
    await getDb().run('UPDATE projects SET purpose = ? WHERE id = ?', ['TECHNICAL', project.id]);
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'PUSH_TO_FAILURE',
      title: 'unauthorized',
      envelope: {
        ceiling: 4,
        durationMinutes: 1,
        stopConditions: ['a rung fails'],
        cleanup: 'cancel what is left',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'u_test',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: false });
    expect(ran.state).toBe('REFUSED');
    expect(ran.refusalReason).toMatch(/needs a person to authorize/i);
  });
});

/* ==========================================================================
 * The pressure runners, actually run
 * ========================================================================== */

/**
 * An isolated scope with somewhere legitimate to hold a lease.
 *
 * The worker and the membership are made here rather than by the lab, which is
 * the whole point of `NoLabClaimant`: registering an identity is a person's
 * decision, and a test standing in for that person is doing so explicitly.
 */
async function labScope(name: string): Promise<{ projectId: string; workerIds: string[] }> {
  const project = await createProject({
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
    purpose: 'TECHNICAL',
  });
  const workerIds: string[] = [];
  for (const suffix of ['a', 'b']) {
    const worker = await createWorker({
      name: `lab-claimant-${suffix}-${Date.now()}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      scopes: ['queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    workerIds.push(worker.id);
  }
  return { projectId: project.id, workerIds };
}

describe('a pressure test that actually runs', () => {
  it('drains a real backlog through the real queue and reports what it reached', async () => {
    const scope = await labScope('Push scope');
    const declared = await declareExperiment({
      projectId: scope.projectId,
      mode: 'PUSH_TO_FAILURE',
      title: 'How many claimants before contention stops paying?',
      envelope: {
        ceiling: 4,
        durationMinutes: 1,
        stopConditions: ['a rung leaves work undrained'],
        cleanup: 'cancel anything a rung did not finish',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });

    expect(ran.state).toBe('COMPLETE');
    expect(ran.result).not.toBeNull();
    // Real work really drained: this is a measurement, not a projection.
    expect(ran.result!.confidence.sampleSize).toBeGreaterThan(0);
    expect(ran.result!.highestTested.value).toBeGreaterThan(0);
    // And it is a lower bound on Brain's machinery, said in those words.
    expect(ran.result!.findings.join(' ')).toMatch(/lower bound/i);
    // The one thing it cannot know is named every time.
    expect(ran.result!.untested.join(' ')).toMatch(/real Cowork surface/i);
    // A queue measurement is never dressed as a provider fact.
    expect(ran.result!.bottleneck.evidence).not.toBe('PROVIDER_ENFORCED');
  }, 60_000);

  it('compares two materially different layouts over identical work', async () => {
    const scope = await labScope('Tournament scope');
    const declared = await declareExperiment({
      projectId: scope.projectId,
      mode: 'LAYOUT_TOURNAMENT',
      title: 'One at a time against batched',
      envelope: {
        ceiling: 4,
        durationMinutes: 1,
        stopConditions: ['both layouts have drained or the clock ran out'],
        cleanup: 'cancel anything left',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('COMPLETE');
    expect(ran.result!.whatHappened).toMatch(/one-at-a-time .* batched/);
    // A defensible recommendation names a layout and a concurrency.
    expect(ran.result!.recommendedSetting.value).toMatch(/layout|recommend/i);
    expect(ran.result!.findings.join(' ')).toMatch(/says nothing about how many surfaces/i);
  }, 60_000);

  it('measures quality separately from throughput', async () => {
    const scope = await labScope('Quality scope');
    const declared = await declareExperiment({
      projectId: scope.projectId,
      mode: 'QUALITY_UNDER_PRESSURE',
      title: 'Does quality go before speed?',
      envelope: {
        ceiling: 4,
        durationMinutes: 1,
        stopConditions: ['both runs have finished'],
        cleanup: 'cancel anything left',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('COMPLETE');
    expect(ran.result!.whatHappened).toMatch(/quiet:/);
    expect(ran.result!.whatHappened).toMatch(/Pressed:/);
    // Content quality is explicitly outside what this can see, and says so.
    expect(ran.result!.untested.join(' ')).toMatch(/content.*quality/i);
  }, 60_000);

  it('proves recovery by letting a real lease expire, not by editing one', async () => {
    const scope = await labScope('Drill scope');
    const declared = await declareExperiment({
      projectId: scope.projectId,
      mode: 'RECOVERY_DRILL',
      title: 'A worker disappears mid-lease',
      envelope: {
        ceiling: 1,
        durationMinutes: 1,
        stopConditions: ['the drill finishes'],
        cleanup: 'cancel the synthetic item',
        rollback: 'nothing is applied',
        workloadClass: 'SYNTHETIC',
        workKind: 'SYNTHETIC',
      },
      actor: 'A person',
    });
    const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
    expect(ran.state).toBe('COMPLETE');

    const said = ran.result!.whatHappened;
    expect(said).toMatch(/lease taken over: true/);
    expect(said).toMatch(/late completion fenced: true/);
    expect(said).toMatch(/completion after cancellation fenced: true/);
    // Two identities were registered, so the stronger claim is the true one.
    expect(ran.result!.findings.join(' ')).toMatch(/different worker identity/i);
    expect(ran.result!.highestTested.anythingFailed).toBe(false);
  }, 60_000);
});

/* ==========================================================================
 * The reporter must not be a mutation
 * ========================================================================== */

/*
 * `initDatabase` honours `dbPath` **only in local mode** — it reads the
 * configured provider first — so a script that opens a scratch database by path
 * alone gets the real one whenever the environment says postgres. The Step 12B
 * reporter registers a project, four foundations, two people, a hundred
 * candidates, a lens inquiry and eight Capability Lab experiments, and it runs
 * *inside the container*, where the provider is postgres and the cloud
 * credential is present. Its own header says everything it exercises runs in a
 * temporary database; against the deployed Brain that would have been false.
 *
 * Found by running it twice against a Postgres test database — the second run
 * collided on a candidate id the first had written — and before the production
 * workflow had ever been dispatched, so nothing real was touched.
 *
 * Asserted on the source because that is where the decision is. A test that
 * opened a Postgres database to prove it would need one, and the property being
 * pinned is "this script states its provider", which is readable.
 */
/* ==========================================================================
 * Deduplication by meaning
 *
 * `russell_candidate_merges.method` has carried `'SEMANTIC'` in its CHECK
 * constraint since migration 027, and for a long time nothing wrote one. These
 * drive the path production takes — `capture`, with the claim a worker would
 * have made — because §24 is explicit that the claim decides nothing on its
 * own: the scope, the chain and the floor are all checked against rows, and all
 * three are reachable without a worker.
 * ========================================================================== */

const CANONICAL_QUESTION =
  'Establish how long after a deed is recorded it becomes available electronically in ' +
  'Michigan county register offices, before a title search can rely on it.';
const REWORDED_QUESTION =
  'How long does it take for a recorded deed to become electronically available in the ' +
  'county register offices of Michigan?';

describe('an idea is folded into another only when the server agrees it is the same one', () => {
  it('merges a genuine rewording, and records that meaning decided it', async () => {
    const first = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
    });
    const second = await capture({
      title: 'How quickly a recorded deed appears online',
      statement: REWORDED_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: first.candidate?.id ?? null,
    });

    expect(second.merged).toBe(true);
    // The canonical comes back, not the row that folded into it.
    expect(second.candidate?.id).toBe(first.candidate?.id);

    const history = await listMergeHistory(first.candidate!.id);
    const merge = history.find((row) => row.action === 'MERGE');
    expect(merge?.method).toBe('SEMANTIC');
    // The score is in the reason, so a merge can be argued with rather than
    // only believed.
    expect(merge?.reason).toMatch(/subject overlap/);
  });

  it('refuses two ideas that share their subject but not their question', async () => {
    const first = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
    });
    const second = await capture({
      title: 'Ranking the register offices',
      statement:
        'Decide whether the Michigan county register offices should be ranked by staffing ' +
        'levels, opening hours, budget, telephone response times, walk-in volume, parking ' +
        'and signage before any outreach campaign begins.',
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: first.candidate?.id ?? null,
    });

    expect(second.merged).toBe(false);
    expect(second.reason).toMatch(/overlap/);
    // Refused is not lost: the idea it was captured from is still its own row.
    expect(second.candidate?.id).not.toBe(first.candidate?.id);
    expect(second.candidate?.state).toBe('CAPTURED');
  });

  it('refuses one word in common, before the ratio is even reached', async () => {
    const first = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
    });
    const second = await capture({
      title: 'Billing order on the pricing page',
      statement: 'Decide whether the pricing page should show annual billing before monthly billing.',
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: first.candidate?.id ?? null,
    });
    expect(second.merged).toBe(false);
    expect(second.reason).toMatch(/subject word/);
  });

  it('will not reach into another project, or into a row already folded away', async () => {
    const elsewhere = await createProject({
      name: 'Another project entirely',
      slug: `elsewhere-${Date.now()}`,
      purpose: 'PROJECT',
    });
    // The *same* question over there, so the refusal below is attributable to
    // the scope and to nothing else.
    const foreign = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: elsewhere.id,
      visibility: 'SHARED',
    });
    const here = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
    });
    const folded = await capture({
      title: 'How quickly a recorded deed appears online',
      statement: REWORDED_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: here.candidate?.id ?? null,
    });
    expect(folded.merged).toBe(true);
    const foldedRow = (await listCandidates({ projectId: project.id, limit: 50 })).find(
      (row) => row.state === 'MERGED',
    );
    expect(foldedRow).toBeTruthy();

    const crossScope = await capture({
      title: 'When a recorded deed appears online',
      statement:
        'When does a recorded deed become electronically available in a Michigan county ' +
        'register office?',
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: foreign.candidate?.id ?? null,
    });
    const intoMerged = await capture({
      title: 'Electronic publication after recording',
      statement:
        'After a deed is recorded in Michigan, how long until the county register office ' +
        'publishes it electronically?',
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: foldedRow!.id,
    });

    expect(crossScope.merged).toBe(false);
    expect(intoMerged.merged).toBe(false);
    /*
     * And in the same words. "You may not merge into that" and "there is
     * nothing there to merge into" are invariant 23's pair: a reason that
     * separated them would confirm a candidate exists in a scope the asker
     * cannot read.
     */
    expect(crossScope.reason).toBe(intoMerged.reason);
  });

  it('lets a person undo a merge, keeping both the merge and the split', async () => {
    const first = await capture({
      title: 'Electronic availability of a recorded deed',
      statement: CANONICAL_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
    });
    await capture({
      title: 'How quickly a recorded deed appears online',
      statement: REWORDED_QUESTION,
      projectId: project.id,
      visibility: 'SHARED',
      duplicateOf: first.candidate?.id ?? null,
    });
    const foldedRow = (await listCandidates({ projectId: project.id, limit: 50 })).find(
      (row) => row.state === 'MERGED',
    );

    expect(await splitCandidate({ candidateId: foldedRow!.id, reason: 'Two questions after all.' })).toBe(true);
    const after = await getCandidate(foldedRow!.id);
    expect(after?.state).toBe('CAPTURED');
    expect(after?.canonicalCandidateId).toBeNull();
    // The idea it had been folded into is untouched by the undo.
    expect((await getCandidate(first.candidate!.id))?.state).toBe('CAPTURED');

    const history = await listMergeHistory(foldedRow!.id);
    expect(history.map((row) => row.action)).toEqual(['MERGE', 'SPLIT']);
  });
});

/* ==========================================================================
 * One projection, every surface
 * ========================================================================== */

describe('one projection answers every surface that reads it', () => {
  it('gives the briefing, the conversation hat and the constellation one answer', async () => {
    /*
     * Three different states, because an empty project makes every reading
     * trivially equal — and a check that cannot fail proves nothing about the
     * surfaces that could disagree.
     */
    const layers = await listLayers(project.id);
    expect(layers.length).toBeGreaterThan(2);
    await updateLayer(layers[0]!.id, { status: 'FROZEN', statusSource: 'DERIVED' });
    await updateLayer(layers[1]!.id, { status: 'RESEARCHING', statusSource: 'DERIVED' });
    await updateLayer(layers[2]!.id, { status: 'BLOCKED', statusSource: 'DERIVED' });

    const direct = await projectProgress({ projectId: project.id, projectName: project.name });
    const brief = await briefing({ projectId: project.id, projectName: project.name });
    expect(brief.progress).toEqual(direct);

    /*
     * The hat embeds the sentence rather than the object, so what matters is
     * that the sentence *is* the projection's own — a hat that reworded it
     * would be a second opinion arriving where nobody could see it.
     */
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'About this project',
      projectId: project.id,
      visibility: 'SHARED',
    });
    const hat = await compileHat({
      conversationId: conversation.id,
      projectId: project.id,
      projectName: project.name,
      ownerUserId: userId,
    });
    const state = hat.parts.find((part) => part.section === 'PROJECT_STATE');
    expect(state?.text).toContain(direct.headline);

    /*
     * The constellation builds its own Progress per node out of a layer's
     * declared versions, so what is compared is the thing both must agree
     * about — each foundation's milestone state — rather than two fractions
     * over different denominators.
     */
    const map = await ideaMapForProject({
      projectId: project.id,
      viewerUserId: userId,
      includePrivate: false,
    });
    const majors = (map?.nodes ?? []).filter((node) => node.level === 'MAJOR');
    expect(majors.length).toBe(direct.milestones.length);
    const byLayer = new Map(direct.milestones.map((milestone) => [milestone.key, milestone]));
    for (const node of majors) {
      const milestone = byLayer.get(node.links.layerId ?? '');
      expect(milestone).toBeTruthy();
      expect(milestoneStateOfLayer(node.state as never)).toBe(milestone!.state);
    }
    const blocked = majors.find((node) => node.links.layerId === layers[2]!.id);
    expect(blocked?.progress.stage).toBe('BLOCKED');
  });

  it('keeps the three numbers on the progress route from being read as one', async () => {
    const direct = await projectProgress({ projectId: project.id, projectName: project.name });
    const work = await activeWorkProgress(project.id);
    const build = buildProgress();
    // Work's milestone set is not closed, so it reports no fraction at all.
    expect(work.ratio).toBeNull();
    const denominators = [direct.denominator, work.denominator, build.denominator];
    expect(new Set(denominators).size).toBe(denominators.length);
    for (const headline of [direct.headline, work.headline, build.headline]) {
      expect(headline).not.toMatch(/\d+\s*%/);
    }
  });
});

/* ==========================================================================
 * The canary, in the direction that was silently broken
 * ========================================================================== */

describe('a canary rolls back to what it displaced, never to its own number', () => {
  const canaryEnvelope = {
    ceiling: 4,
    durationMinutes: 1,
    stopConditions: ['the ceiling is reached'],
    cleanup: 'Nothing is created.',
    rollback: 'The displaced policy version is written forward again.',
    workloadClass: 'RESEARCH',
    workKind: 'REAL_CANARY' as const,
  };

  it('allows real work as a canary for a reading that spends nothing', async () => {
    const declared = await declareExperiment({
      projectId: project.id,
      mode: 'CALIBRATION',
      title: 'A ledger reading, applied as a canary',
      envelope: canaryEnvelope,
      actor: 'A person',
    });
    // The refusal in `checkEnvelope` is about pressure on a real surface, not
    // about the words REAL_CANARY: a reading of rows applies no pressure.
    expect(declared.state).toBe('DECLARED');
    expect(declared.refusalReason).toBeNull();
  });

  it('records the displaced target before it is replaced, and restores it', async () => {
    const prior = await setPolicy({
      scope: 'FLEET',
      target: 3,
      actor: 'A person',
      reason: 'The target a person set before any canary',
    });
    const ran = await runExperiment({
      id: (
        await declareExperiment({
          projectId: project.id,
          mode: 'CALIBRATION',
          title: 'What has the fleet done?',
          envelope: canaryEnvelope,
          actor: 'A person',
        })
      ).id,
      pressureAuthorized: false,
    });
    expect(ran.state).toBe('COMPLETE');

    const applied = await applyFinding({
      experimentId: ran.id,
      target: 11,
      actor: 'A person',
      reason: 'Canary',
    });
    /*
     * The whole of the fix this pins: read *before* the write. Afterwards,
     * "the newest policy that is not this one" answers a different question and
     * is wrong in both directions — over an empty history it finds nothing and
     * falls back to the canary itself.
     */
    expect(applied.displacedPolicyId).toBe(prior.id);
    expect(applied.displacedTarget).toBe(3);
    expect(applied.displacedTarget).not.toBe(11);
    expect((await currentPolicy('FLEET', null))?.target).toBe(11);

    const back = await rollbackFinding({
      experimentId: ran.id,
      actor: 'A person',
      reason: 'Canary complete',
    });
    expect(back.rolledBackAt).toBeTruthy();
    const now = await currentPolicy('FLEET', null);
    expect(now?.target).toBe(3);
    expect(now?.reason).toMatch(/displaced \(3\)/);
    // Written forward, not deleted: the canary's own version is still there.
    const history = await policyHistory('FLEET', null, 10);
    expect(history.some((row) => row.target === 11)).toBe(true);
  });

  it('says it displaced nothing rather than reporting a number', async () => {
    const ran = await runExperiment({
      id: (
        await declareExperiment({
          projectId: project.id,
          mode: 'CALIBRATION',
          title: 'What has the fleet done?',
          envelope: canaryEnvelope,
          actor: 'A person',
        })
      ).id,
      pressureAuthorized: false,
    });
    expect(await currentPolicy('FLEET', null)).toBeNull();
    const applied = await applyFinding({
      experimentId: ran.id,
      target: 9,
      actor: 'A person',
      reason: 'Canary',
    });
    expect(applied.displacedPolicyId).toBeNull();
    expect(applied.displacedTarget).toBeNull();

    await rollbackFinding({ experimentId: ran.id, actor: 'A person', reason: 'Canary complete' });
    const now = await currentPolicy('FLEET', null);
    expect(now?.target).toBe(DEFAULT_TARGET_WITH_NO_PRIOR_POLICY);
    expect(now?.target).not.toBe(9);
    expect(now?.reason).toMatch(/no prior policy/);
  });
});

describe('the acceptance reporter writes to a scratch database, never the configured one', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'step12b-acceptance.ts'),
    'utf8',
  );

  it('names sqlite explicitly wherever it opens the database it writes to', () => {
    // Every `initDatabase` that is followed by writes carries a config naming
    // the provider. The operational read is the one call that must see the real
    // Brain, and it takes no options at all.
    const calls = [...source.matchAll(/initDatabase\(([\s\S]*?)\);/g)].map((match) => match[1] ?? '');
    expect(calls.length).toBeGreaterThan(1);
    const writing = calls.filter((call) => call.includes('dbPath'));
    expect(writing.length).toBeGreaterThan(0);
    for (const call of writing) {
      expect(call).toContain("provider: 'sqlite'");
    }
  });

  /*
   * Asserted on the source, like the two above, and for the same reason: what
   * is being pinned is a decision about how the reporter is written. It is not
   * evidence for any verdict — the verdicts come from what the run does, which
   * is the whole point of the script. What this stops is a later edit quietly
   * turning an exercised scenario back into a described one.
   */
  it('drives C, D, M and Q through the services rather than describing them', () => {
    // C: the merge is made, refused and undone through the production path.
    expect(source).toContain("from '../server/services/russell/judgment.ts'");
    expect(source).toContain('splitCandidate');
    // D: the frontier is read back from rows, never inserted into directly.
    expect(source).toContain('frontierFor');
    expect(source).toContain('recordKnowledge');
    expect(source).toContain('createAudit');
    expect(source).not.toMatch(/INSERT INTO russell_frontier/i);
    // M: every reader of the one projection, including the two that could
    // genuinely disagree with it.
    expect(source).toContain('compileHat');
    expect(source).toContain('ideaMapForProject');
    expect(source).toContain('activeWorkProgress');
    // Q: the canary cycle, both ways round.
    expect(source).toContain('applyFinding');
    expect(source).toContain('rollbackFinding');
    expect(source).toContain('DEFAULT_TARGET_WITH_NO_PRIOR_POLICY');
  });

  /*
   * The chain gate, pinned on the two things that make it evidence rather than
   * a description: that it drives the real services, and that it fabricates
   * nothing to get there.
   *
   * The second half is the one worth a test. The owner's rejection was that a
   * tick summary is not a chain, and the obvious way to make the chain "pass"
   * is to write the packet's terminal status, a document row and an audit row
   * by hand — which would be a report of invented citations (§12) and a verdict
   * nobody reached (§8), wearing an acceptance gate's clothes. So the reporter
   * is refused those tools by absence: it never imports them.
   */
  it('drives R through the services and writes no research, document or verdict', () => {
    // The chain, through the entrances production uses.
    expect(source).toContain("from '../server/services/russell/launch.ts'");
    expect(source).toContain("from '../server/services/russell/loop.ts'");
    expect(source).toContain('answerHumanRequest');
    expect(source).toContain('NEEDS_HUMAN_CHOICES');
    expect(source).toContain('reserve');

    /*
     * And the tools that could fabricate a finished packet, none of which it
     * has. `createAudit` is deliberately not in this list: gate D uses it to
     * build a frontier snapshot, which is a reading about classification rather
     * than a claim that a packet was judged. What must never appear is a way to
     * mint evidence for the chain.
     */
    const imported = [...source.matchAll(/^import[\s\S]*?from '[^']+';$/gm)]
      .map((match) => match[0])
      .join('\n');
    for (const forbidden of [
      'updateOrchestration',
      'recordFragmentClaims',
      'gateFragment',
      'createDocument',
      'storeFile',
      'registerRunArtifact',
      'recordAuditPasses',
      'authorizeUnresolvedGaps',
    ]) {
      // Neither imported nor called. Named in prose is fine and is the point:
      // the reporter has to be able to say what it did not do and why.
      expect(imported, `the reporter must not import ${forbidden}`).not.toContain(forbidden);
      expect(source, `the reporter must not call ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\s*\\(`),
      );
    }

    // The guard that stops it is executed rather than described.
    expect(source).toContain('fileResearchPacket');
    expect(source).toContain('cleared its fragment evidence gate');

    // And what it could not drive is named with what would close it, rather
    // than left as an absence a reader has to infer.
    expect(source).toContain("needs: 'A REAL WORKER'");
    expect(source).toContain("needs: 'THE OWNER'");
  });

  /*
   * A check that ran and did not hold must never read as one nobody ran.
   *
   * That is a property of the reporter rather than of any run: the union has to
   * carry the verdict, the summary has to count it, and the failing scenarios
   * have to be named on their own line — otherwise a reader tells a defect from
   * a backlog by counting.
   */
  it('has a verdict for an executed check that failed, and counts it', () => {
    expect(source).toMatch(/type Verdict =[^;]*'FAIL'/);
    expect(source).toContain('{ PASS: 0, PARTIAL: 0, BLOCKED: 0, FAIL: 0, NOT_RUN: 0 }');
    expect(source).toContain('counts.FAIL');
    expect(source).toContain('SCENARIO(S) FAILED');
  });

  /*
   * The store is pinned the way the database is, and for the identical reason.
   *
   * Nothing in the reporter files a document today. "Safe because nobody calls
   * the other function" is the kind of guarantee this repository refuses
   * everywhere else, and a reporter that could reach a real bucket would be a
   * mutation rather than a reading.
   */
  it('names the local store explicitly, so no run can reach a real bucket', () => {
    expect(source).toContain('initStorage');
    expect(source).toMatch(/initStorage\([\s\S]*?provider: 'local'/);
    expect(source).toMatch(/initStorage\([\s\S]*?root: dataDir/);
  });

  it('takes its operational reading before it opens anything it writes to', () => {
    // Order matters: the real Brain is read and closed, and only then is the
    // scratch database opened. Reversed, the read would see the scratch one.
    const read = source.indexOf('readOperationalFleet()');
    const write = source.indexOf("provider: 'sqlite'");
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read).toBeLessThan(write);
    expect(source).toContain('await closeDatabase()');
  });
});

/**
 * The reporter runs where the production database is, which is inside the
 * deployed image — and `.dockerignore` deliberately excludes `tests`, `docs`,
 * `*.md` and `client/src` from that image, because an image is copied, pushed
 * to a registry and pulled by machines nobody controls.
 *
 * So several of its rows are facts about the repository that a production run
 * genuinely cannot see. Two ways that can go wrong, and this pins both:
 *
 *  - **It can crash.** Gate K read `client/src` with an unguarded
 *    `readdirSync`, which throws where the image carries only `client/dist`.
 *    The whole report would have died there rather than printing the eleven
 *    rows it had already established, and the workflow would have said only
 *    "the reporter never ran".
 *  - **It can lie by omission.** An absent `docs/evidence` is not evidence of
 *    absence; it is this run being unable to look. A row that reported it as a
 *    finding would read as a regression to anybody who did not know which
 *    environment produced the reading.
 */
describe('the acceptance reporter, read where the image cannot see the repository', () => {
  const source = fs.readFileSync(
    path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'step12b-acceptance.ts'),
    'utf8',
  );
  const ignore = fs.readFileSync(
    path.join(fileURLToPath(new URL('..', import.meta.url)), '.dockerignore'),
    'utf8',
  );

  it('still knows which paths the image leaves out', () => {
    // If one of these stops being excluded the rows below can simply read it,
    // and this suite should be the thing that says so.
    for (const excluded of ['tests', 'docs', 'client/dist']) {
      expect(ignore.split('\n').map((line) => line.trim()), excluded).toContain(excluded);
    }
  });

  it('reads no directory without first asking whether it is there', () => {
    for (const [, before] of source.matchAll(/([\s\S]{0,400})fs\s*\n?\s*\.?readdirSync/g)) {
      expect(before, 'an unguarded readdirSync is how gate K crashed in the container').toMatch(
        /existsSync/,
      );
    }
  });

  it('names the half it could not see rather than reporting an absence', () => {
    expect(source).toContain('const REPO_VISIBLE =');
    expect(source).toContain('NOT_FROM_A_CHECKOUT');
    // Printed before the rows, not buried in the ones it affects.
    expect(source).toMatch(/repository facts \(H, J, K, O\)/);
    // Every row that depends on an excluded path must consult it.
    const rows = source.slice(source.indexOf("/* -- H."));
    for (const gate of ['H', 'J', 'K', 'O']) {
      const start = rows.indexOf(`/* -- ${gate}.`);
      expect(start, `gate ${gate} is not where this test expects it`).toBeGreaterThan(-1);
      const end = rows.indexOf('/* --', start + 6);
      const body = end === -1 ? rows.slice(start) : rows.slice(start, end);
      expect(body, `gate ${gate} does not say when it could not look`).toMatch(
        /REPO_VISIBLE|NOT_FROM_A_CHECKOUT|clientHasOperator === null/,
      );
    }
  });
});
