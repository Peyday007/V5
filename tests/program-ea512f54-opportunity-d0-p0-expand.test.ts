/**
 * The kernel's entrance stamps origins and can ask about unrepresented roles
 * (OPP-03, COM-13-1, ARCH-01; §8, §24, §92).
 *
 *   E01 — every finding kind maps to an origin from `construction/origins.ts`:
 *         a constraint kind is CONSTRAINT, everything else is WORLD.
 *   E02 — a mapped flow's seed roles with no actor in them become asks, one
 *         per role, as SCAN asks with a role bucket; represented, refused and
 *         reference-pack flows produce none.
 *   E03 — `openAsks` opens such an ask through `createCandidate`, with a
 *         role question, and records it on the round.
 *   E04 — `absorb` still reads no sentence: `file` inspects only the declared
 *         finding, so the origin cannot be anything but a lookup.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { OPPORTUNITY_ORIGINS } from '../server/services/industry/construction/origins.ts';
import { rolesForFlow, type FlowRoles } from '../server/services/industry/construction/roles.ts';
import { assembleEvidence, evidenceFromMap } from '../server/services/industry/construction/service.ts';
import {
  originOfFinding,
  roleBucketId,
  roleIdOfBucket,
  unrepresentedRoleAsks,
} from '../server/services/industry/expand.ts';
import type { IndustryNode } from '../server/domain/types.ts';

function node(id: string, kind: IndustryNode['kind'], name: string, parentId: string | null): IndustryNode {
  return {
    id,
    projectId: 'prj_x',
    parentId,
    kind,
    name,
    description: `${name} described`,
    origin: 'DISCOVERED',
    sourceClaimId: `rcl_${id}`,
    retiredAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  } as IndustryNode;
}

function mappedSets(extra: IndustryNode[] = []): FlowRoles[] {
  const nodes = [
    node('root', 'SECTOR', 'Commercial cleaning', null),
    node('buyer', 'BUYER_TYPE', 'Office managers', 'root'),
    node('tx', 'TRANSACTION_TYPE', 'Monthly cleaning contract', 'buyer'),
    node('op', 'FULFILMENT_SOURCE', 'Independent cleaning crews', 'root'),
    ...extra,
  ];
  const map = evidenceFromMap(nodes, []);
  const evidence = assembleEvidence({ text: 'Commercial cleaning', industry: 'Commercial cleaning', geography: null, map, recorded: [] });
  return evidence.flows.map((flow, i) => rolesForFlow(evidence, flow, i)).filter((set) => set.flow.source.kind === 'MAP');
}

describe('E01: origin of an absorbed finding', () => {
  it('is CONSTRAINT for a constraint and WORLD for every other declared kind', () => {
    expect(originOfFinding('HIDDEN_CONSTRAINT')).toBe('CONSTRAINT');
    for (const kind of ['SUB_INDUSTRY', 'BUYER_TYPE', 'TRANSACTION_TYPE', 'CAPITAL_REQUIREMENT', 'CAPITAL_RESTRUCTURING']) {
      expect(originOfFinding(kind)).toBe('WORLD');
    }
    expect(OPPORTUNITY_ORIGINS).toContain(originOfFinding('HIDDEN_CONSTRAINT'));
    expect(OPPORTUNITY_ORIGINS).toContain(originOfFinding('BUYER_TYPE'));
  });
});

describe('E02: unrepresented roles on a mapped flow', () => {
  it('asks once per role nobody stands in, as a SCAN with a role bucket', () => {
    const sets = mappedSets();
    expect(sets.length).toBeGreaterThan(0);
    const asks = unrepresentedRoleAsks({ nodeId: 'ind_root', subject: 'Commercial cleaning', since: '2026-11-01T00:00:00.000Z', sets });
    expect(asks.length).toBeGreaterThan(0);
    const ids = asks.map((one) => roleIdOfBucket(one.bucketId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const ask of asks) {
      expect(ask.purpose).toBe('SCAN');
      expect(ask.nodeId).toBe('ind_root');
      expect(ask.opportunityId).toBeNull();
      expect(ask.why).toMatch(/No record represents/);
    }
    // A capital arranger is withheld where no gate permits it, so nobody asks about it.
    expect(ids).not.toContain('capital_arranger');
  });

  it('does not ask about a role an actor in the evidence already stands in', () => {
    const plain = unrepresentedRoleAsks({ nodeId: 'n', subject: 's', since: 't', sets: mappedSets() });
    expect(plain.map((one) => roleIdOfBucket(one.bucketId))).toContain('broker_agent');
    // The flow's own endpoint named as a broker represents that role.
    const sets = mappedSets().map((set) => ({
      ...set,
      roles: set.roles.map((role) =>
        role.roleId === 'broker_agent' ? { ...role, sources: [...role.sources, { title: 'actor', url: null, kind: 'MAP' as const, claimId: 'rcl_b' }] } : role,
      ),
    }));
    const asks = unrepresentedRoleAsks({ nodeId: 'n', subject: 's', since: 't', sets });
    expect(asks.map((one) => roleIdOfBucket(one.bucketId))).not.toContain('broker_agent');
  });

  it('ignores flows the map did not record, and roles the record refuses', () => {
    const sets = mappedSets();
    const reference = sets.map((set) => ({ ...set, flow: { ...set.flow, source: { ...set.flow.source, kind: 'REFERENCE' as never } } }));
    expect(unrepresentedRoleAsks({ nodeId: 'n', subject: 's', since: 't', sets: reference })).toHaveLength(0);
    const refused = sets.map((set) => ({
      ...set,
      roles: set.roles.map((role) => ({ ...role, occupiable: { ...role.occupiable, answer: 'NO' as const } })),
    }));
    expect(unrepresentedRoleAsks({ nodeId: 'n', subject: 's', since: 't', sets: refused })).toHaveLength(0);
  });

  it('round-trips the role bucket and leaves mechanism buckets alone', () => {
    expect(roleIdOfBucket(roleBucketId('reseller'))).toBe('reseller');
    expect(roleIdOfBucket('arbitrage')).toBeNull();
    expect(roleIdOfBucket(null)).toBeNull();
  });
});

describe('E03: openAsks opens a role ask through createCandidate', () => {
  let projectId = '';
  let userId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    const user = await createUser({
      email: `expand-roles-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    userId = user.id;
    const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
    expect(outcome.ok).toBe(true);
  });

  it('creates one candidate and one SCAN round per unrepresented role', async () => {
    const { seedSubject } = await import('../server/services/industry/seed.ts');
    const { graphSnapshot } = await import('../server/services/industry/graph.ts');
    const { openAsks } = await import('../server/services/industry/expand.ts');
    const seed = await seedSubject({ projectId, name: 'Commercial cleaning', actorRef: userId });

    const asks = unrepresentedRoleAsks({
      nodeId: seed.node.id,
      subject: 'Commercial cleaning',
      since: new Date().toISOString(),
      sets: mappedSets(),
    }).slice(0, 2);
    expect(asks.length).toBe(2);

    const before = (await listCandidates({ projectId })).length;
    const opened = await openAsks({ projectId, asks, snapshot: await graphSnapshot(projectId) });
    expect(opened).toHaveLength(2);
    expect((await listCandidates({ projectId })).length).toBe(before + 2);
    for (const one of opened) {
      expect(one.purpose).toBe('SCAN');
      expect(roleIdOfBucket(one.bucketId)).not.toBeNull();
      expect(one.question).toMatch(/Commercial cleaning/);
      expect(one.question).toMatch(/legally and contractually/);
    }

    // The same asks again collide on the round key and leave no orphan candidate.
    const again = await openAsks({ projectId, asks, snapshot: await graphSnapshot(projectId) });
    expect(again).toHaveLength(0);
    expect((await listCandidates({ projectId })).length).toBe(before + 2);
  });
});

describe('E04: absorbing stays a lookup', () => {
  it('file() reads only the declared finding and subject, never the sentence', () => {
    const source = readFileSync(new URL('../server/services/industry/expand.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async function file('));
    expect(body).not.toMatch(/claim\.claim\s*\.(match|includes|test|search|toLowerCase)/);
    expect(body).not.toMatch(/\.test\(claim\./);
    expect(body).toMatch(/originOfFinding\(finding\)/);
    expect(source).toMatch(/origins: out\.origins/);
  });
});
