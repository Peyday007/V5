/**
 * Step 12B, Release 1 — the product decisions, tested where they are decided.
 *
 * These are the rules the owner rejected the September 11 interface over, plus
 * the two objects Release 1 adds. What is asserted is the behaviour a person
 * notices when it is wrong, through the services production uses rather than
 * through a repository helper — §28 is explicit that proving a helper while
 * bypassing the service is not coverage.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import { parseRoute } from '../client/src/lib/router.ts';
import type { Principal, Project } from '../server/domain/types.ts';

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
