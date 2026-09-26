/**
 * The Ideas map is behind the same visibility rule as one idea at a time.
 *
 * `GET /api/russell/candidates/:candidateId` has always refused a PRIVATE
 * candidate unless its conversation is readable by the caller
 * (`requireCandidate` -> `conversationIsReadable`). `ideaMapForProject`, which
 * backs the Ideas list and the constellation, applied no such rule: every
 * project member read every other member's private idea titles, statements
 * and derived counts. These tests pin the repair down from both ends — the
 * service, where the filtering actually happens, and the route, where a
 * leaked title in a JSON body is the failure that matters to a person reading
 * the response.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { getDb } from '../server/db/database.ts';
import { russellRouter } from '../server/routes/russell.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { ideaMapForProject } from '../server/services/russell/ideas.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let aliceId = '';
let bobId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;

  const alice = await createUser({
    email: `alice-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Alice',
    password: 'correct horse battery staple',
  });
  aliceId = alice.id;
  const bob = await createUser({
    email: `bob-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Bob',
    password: 'correct horse battery staple',
  });
  bobId = bob.id;

  for (const principalId of [aliceId, bobId]) {
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId,
      role: 'MEMBER',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
  }
});

/** A signed-in member, with a real membership on the project under test. */
function personPrincipal(id: string): Principal {
  return {
    type: 'HUMAN',
    id,
    handle: `${id}@example.test`,
    displayName: id,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses_${id}`,
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: id,
        role: 'MEMBER',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: `req_${id}`,
  } as Principal;
}

/** A PRIVATE conversation and the PRIVATE candidate it produced. */
async function privateIdeaFor(ownerUserId: string, title: string) {
  const conversation = await createConversation({
    ownerUserId,
    title: `${title} thread`,
    projectId,
    visibility: 'PRIVATE',
  });
  const candidate = await createCandidate({
    projectId,
    visibility: 'PRIVATE',
    conversationId: conversation.id,
    title,
    statement: `${title} statement, which is nobody else's business`,
  });
  return { conversation, candidate };
}

async function withRoutes<T>(
  principal: Principal,
  fn: (
    call: (method: string, path: string) => Promise<{ status: number; body: any }>,
  ) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal,
      requestId: newRequestId(),
      method: req.method,
      path: `/api/russell${req.path}`,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api/russell', russellRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: String(error?.message ?? error),
    });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(async (method, path) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/russell${path}`, { method });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* left as text */
      }
      return { status: response.status, body: parsed as any };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('a PRIVATE idea belongs to the conversation it came from', () => {
  it("never appears in another member's map — no node, no edge, no leaked count", async () => {
    const { candidate: bobsIdea } = await privateIdeaFor(bobId, "Bob's private idea");

    const asAlice = await ideaMapForProject({ projectId, viewerUserId: aliceId });
    expect(asAlice).not.toBeNull();

    const node = asAlice!.nodes.find((n) => n.id === `idea:${bobsIdea.id}`);
    expect(node).toBeUndefined();

    const edgeNamingIt = asAlice!.edges.find(
      (edge) => edge.from === `idea:${bobsIdea.id}` || edge.to === `idea:${bobsIdea.id}`,
    );
    expect(edgeNamingIt).toBeUndefined();

    // Not structurally absent only — the title and statement must not be
    // reachable anywhere in the payload a person could read.
    expect(JSON.stringify(asAlice)).not.toContain("Bob's private idea");
    expect(JSON.stringify(asAlice)).not.toContain('nobody else');

    // And it is not hiding inside somebody else's counts either: the site has
    // no ordinary-idea count that could inflate by one for an idea nobody may
    // see, and the map's own node count is exactly the site plus its majors.
    const majors = asAlice!.nodes.filter((n) => n.level === 'MAJOR');
    expect(asAlice!.nodes).toHaveLength(1 + majors.length);
  });

  it("is present, whole, in its owner's own map", async () => {
    const { candidate: bobsIdea } = await privateIdeaFor(bobId, "Bob's own idea");

    const asBob = await ideaMapForProject({ projectId, viewerUserId: bobId });
    const node = asBob!.nodes.find((n) => n.id === `idea:${bobsIdea.id}`);
    expect(node).toBeDefined();
    expect(node!.title).toBe("Bob's own idea");
    expect(node!.purpose).toBe(bobsIdea.statement);
  });
});

describe('the other three cases a viewer’s own map must still show correctly', () => {
  it('shows a SHARED idea whoever owns it', async () => {
    const shared = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'A shared idea',
      statement: 'anybody on the project may read this',
    });
    const asAlice = await ideaMapForProject({ projectId, viewerUserId: aliceId });
    const node = asAlice!.nodes.find((n) => n.id === `idea:${shared.id}`);
    expect(node).toBeDefined();
    expect(node!.title).toBe('A shared idea');
  });

  it('shows a PRIVATE idea whose conversation is itself SHARED', async () => {
    const sharedThread = await createConversation({
      ownerUserId: bobId,
      title: 'A shared thread',
      projectId,
      visibility: 'SHARED',
    });
    const idea = await createCandidate({
      projectId,
      visibility: 'PRIVATE',
      conversationId: sharedThread.id,
      title: 'An idea from a shared thread',
      statement: 'the thread is shared, so any project reader may see this',
    });
    const asAlice = await ideaMapForProject({ projectId, viewerUserId: aliceId });
    const node = asAlice!.nodes.find((n) => n.id === `idea:${idea.id}`);
    expect(node).toBeDefined();
    expect(node!.title).toBe('An idea from a shared thread');
  });

  it("shows the viewer's own PRIVATE idea on their own PRIVATE thread", async () => {
    const { candidate: alicesIdea } = await privateIdeaFor(aliceId, "Alice's own private idea");
    const asAlice = await ideaMapForProject({ projectId, viewerUserId: aliceId });
    const node = asAlice!.nodes.find((n) => n.id === `idea:${alicesIdea.id}`);
    expect(node).toBeDefined();
    expect(node!.title).toBe("Alice's own private idea");
  });
});

describe('a merge into a canonical the viewer cannot read is not silently absorbed', () => {
  it('treats a visible idea folded into an invisible canonical as unfolded', async () => {
    const { candidate: canonical } = await privateIdeaFor(bobId, "Bob's canonical idea");
    // A SHARED idea that was folded into Bob's PRIVATE canonical. The fold
    // itself is a fact this Brain records regardless of who is looking, so
    // the folded candidate's own visibility does not have to match its
    // canonical's — only the *rendering* of the fold does.
    const folded = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'A shared idea later folded away',
      statement: 'this was merged into a private canonical',
    });
    await getDb().run(
      `UPDATE russell_candidates SET state = 'MERGED', canonical_candidate_id = ? WHERE id = ?`,
      [canonical.id, folded.id],
    );

    const asAlice = await ideaMapForProject({ projectId, viewerUserId: aliceId });
    // The canonical does not exist for Alice, and the folded idea is not
    // dangling under a parent that is not on the map either.
    expect(asAlice!.nodes.find((n) => n.id === `idea:${canonical.id}`)).toBeUndefined();
    const foldedNode = asAlice!.nodes.find((n) => n.id === `idea:${folded.id}`);
    expect(foldedNode).toBeDefined();
    expect(foldedNode!.parentId).not.toBe(`idea:${canonical.id}`);
    expect(foldedNode!.decision.canOverride).toBe(true);
    expect(foldedNode!.decision.canSplit).toBe(false);
  });
});

describe('the Ideas route, over HTTP', () => {
  it("never carries another member's private idea title in the response body", async () => {
    await privateIdeaFor(bobId, "Bob's HTTP-visible-only-to-Bob idea");

    await withRoutes(personPrincipal(aliceId), async (call) => {
      const result = await call('GET', `/projects/${projectId}/ideas`);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain(
        "Bob's HTTP-visible-only-to-Bob idea",
      );
    });

    await withRoutes(personPrincipal(bobId), async (call) => {
      const result = await call('GET', `/projects/${projectId}/ideas`);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).toContain("Bob's HTTP-visible-only-to-Bob idea");
    });
  });
});
