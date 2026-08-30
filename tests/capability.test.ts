/**
 * The acceptance contract for the capability restoration.
 *
 * Step 9's packet passed every mechanical test it had and still produced a
 * New-York-only interim answer to a five-state question. The tests it passed
 * were about the state machine reaching a terminal state; nothing asserted
 * that the research was allowed to be any good. These are the ones that do.
 *
 * Each maps to a clause of the agreed correction contract, and each was proven
 * by inversion — the fix removed, the test failed — before being kept. Where a
 * fix is enforced in two places, both are exercised, because the fault this
 * whole step kept finding is a rule enforced where one path runs and absent
 * from the path the worker actually takes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  Requirement,
} from '../server/domain/types.ts';
import { freshProject, type TestProject } from './helpers.ts';
import { applyGate } from '../server/services/research/gate.ts';
import { outcomeFor, repairable } from '../server/services/research/outcome.ts';
import {
  dependencyKeys,
  parseDependencies,
  serializeDependencies,
} from '../server/domain/dependencies.ts';
import { typeDependencies } from '../server/services/reconcile/plan.ts';
import {
  RESEARCH_METHOD,
  RESEARCH_METHOD_SUMMARY,
  RESEARCH_METHOD_VERSION,
} from '../server/services/research/method.ts';
import { SERVER_INSTRUCTIONS } from '../server/mcp/protocol.ts';
import {
  evaluateCapability,
  type CapabilityInput,
} from '../server/services/research/capabilityCheck.ts';
import { findTool } from '../server/mcp/tools.ts';
import { readFileSync } from 'node:fs';

let project: TestProject;
beforeEach(async () => {
  project = await freshProject();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
  return {
    id: `clm_${Math.random().toString(36).slice(2, 10)}`,
    orchestrationId: 'orc_test',
    fragmentId: 'frg_test',
    passId: null,
    passKey: 'BROAD_SCAN',
    claim: 'Section 442-d requires a licence for a success fee.',
    claimType: 'SOURCED_FACT',
    sourceUrl: 'https://www.nysenate.gov/legislation/laws/RPP/442-D',
    sourceTitle: 'NY Real Property Law § 442-d',
    sourcePublisher: 'New York State Senate',
    sourceDate: '2026-01-01',
    evidenceExcerpt: 'No person shall bring an action…',
    evidenceLocator: '§ 442-d',
    evidenceLane: 'statute',
    retrievedAt: '2026-01-05',
    confidence: 0.9,
    contradictionState: 'UNCHALLENGED',
    retrievalState: 'RETRIEVED',
    contradictionNote: null,
    validationState: 'SOURCED',
    validationDetail: null,
    sourced: true,
    derived: false,
    derivedFrom: [],
    accepted: false,
    rejectionReason: null,
    scopeMatch: null,
    sourceGroup: null,
    primarySource: true,
    geography: null,
    timeframe: null,
    population: null,
    definition: null,
    requirementIds: [],
    jobId: null,
    reconciliation: null,
    reconciledClaimId: null,
    contradictionKind: null,
    reconciliationDetail: null,
    contentHash: 'hash',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
  return {
    id: 'frg_test',
    orchestrationId: 'orc_test',
    projectId: 'prj_test',
    layerId: 'lyr_test',
    fragmentIndex: 0,
    fragmentKey: 'ny-trigger',
    question: 'Does New York require a licence?',
    geography: null,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: ['statute'],
    acceptableSourceTypes: ['statute'],
    excludedSourceTypes: [],
    completionCriteria: ['one section'],
    dependsOn: [],
    minIndependentSources: 1,
    nextRetryAt: null,
    status: 'RUNNING',
    attempt: 1,
    parentFragmentId: null,
    repairReason: null,
    repairStrategy: null,
    integrityVerdict: null,
    sufficiencyVerdict: null,
    verdictDetail: null,
    blockedReason: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requirementIds: [],
    evidenceLane: 'statute',
    whyItMatters: null,
    missingEvidence: null,
    whyExistingInsufficient: null,
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: [],
    preferredSourceTypes: [],
    prohibitedEvidence: [],
    requiredComparisons: [],
    requiredCalculations: [],
    contradictionTargets: [],
    failureConditions: [],
    uncertaintyTolerance: null,
    priority: 5,
    estimatedEffort: null,
    maxRepairs: 2,
    splitFromId: null,
    repairPlan: null,
    cancelledReason: null,
    ...overrides,
  };
}

function verdictsFor(
  claims: ResearchClaim[],
): Parameters<typeof applyGate>[0]['verification'] {
  return {
    verdicts: new Map(
      claims.map((entry) => [
        entry.id,
        {
          supportsClaim: true,
          scopeMatch: {
            geography: 'MATCH' as const,
            timeframe: 'MATCH' as const,
            population: 'MATCH' as const,
            definitions: 'MATCH' as const,
          },
          note: '',
        },
      ]),
    ),
    sufficiency: 'SUFFICIENT' as const,
    missingLanes: [],
    unresolvedGaps: [],
  };
}

function orchestration(
  overrides: Partial<ResearchOrchestration> = {},
): ResearchOrchestration {
  return { unresolvedGapPolicy: null, ...overrides } as ResearchOrchestration;
}

// ---------------------------------------------------------------------------
// 1. Evidence sufficiency is decided by what is being claimed
// ---------------------------------------------------------------------------

describe('what counts as enough evidence', () => {
  /**
   * The decisive one.
   *
   * Three fragments of the live packet recorded integrity PASS with a directly
   * quoted statute, and were failed for resting on one publisher — because the
   * planner had declared 2 before it could know that a statutory question is
   * answered by a statute. §14: one directly inspected primary source settles a
   * statutory fact.
   */
  it('accepts one authoritative primary source for a statutory fact', () => {
    const claims = [claim({ id: 'a', accepted: false })];
    const result = applyGate({
      fragment: fragment({ minIndependentSources: 1 }),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.integrity).toBe('PASS');
    expect(result.sufficiency).toBe('SUFFICIENT');
    expect(result.independentSources).toBe(1);
    expect(result.acceptedClaims).toBe(1);
  });

  /** And the other half: a self-report is not settled by repeating itself. */
  it('still requires corroboration for a claim whose own standard demands it', () => {
    const claims = [
      claim({ id: 'a', claimType: 'SELF_REPORT', sourceUrl: 'https://vendor.example/a' }),
      claim({ id: 'b', claimType: 'SELF_REPORT', sourceUrl: 'https://vendor.example/b' }),
    ];
    const result = applyGate({
      fragment: fragment({ minIndependentSources: 1 }),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.acceptedClaims).toBe(0);
    expect(result.integrity).toBe('FAIL');
  });

  /**
   * The assignment's own bar still binds. An earlier version of this fix took
   * the claim-type floor *alone*, which silently discarded a declaration §12
   * says the gate is applied against.
   */
  it('honours a fragment that deliberately asks for more than its claims would', () => {
    const claims = [
      claim({ id: 'a', sourceUrl: 'https://one.example/a' }),
      claim({ id: 'b', sourceUrl: 'https://one.example/b' }),
    ];
    const result = applyGate({
      fragment: fragment({ minIndependentSources: 2 }),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.independentSources).toBe(1);
    expect(result.sufficiency).toBe('INSUFFICIENT');
    expect(result.reasons.join(' ')).toMatch(/independent source/i);
  });
});

// ---------------------------------------------------------------------------
// 2. A source nobody could read is not a rejected claim
// ---------------------------------------------------------------------------

describe('unresolved retrieval', () => {
  /**
   * A blocked source and a false claim are different facts, and counting the
   * first as the second makes a fragment look like bad research when it was
   * actually a paywall. It also drove the rejection rate over the threshold
   * that fails a whole fragment.
   */
  it('is reported, and excluded from the rejection rate', () => {
    const claims = [
      claim({ id: 'good' }),
      claim({ id: 'blocked', retrievalState: 'PAYWALLED', sourceUrl: 'https://paywalled.example/x' }),
      claim({ id: 'gone', retrievalState: 'NOT_REACHABLE', sourceUrl: 'https://dead.example/y' }),
    ];
    const result = applyGate({
      fragment: fragment(),
      claims,
      verification: verdictsFor(claims),
    });

    expect(result.unresolvedRetrieval.map((entry) => entry.claimId).sort()).toEqual([
      'blocked',
      'gone',
    ]);
    // Neither accepted nor rejected: the gate has no verdict on evidence
    // nobody could open.
    expect(result.acceptedClaims).toBe(1);
    expect(result.rejectedClaims).toBe(0);
    expect(result.integrity).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// 3. Dependencies say how much they block
// ---------------------------------------------------------------------------

describe('typed dependencies', () => {
  it('reads a bare key as HARD, so no stored row changes meaning', () => {
    expect(parseDependencies('["trigger"]')).toEqual([{ key: 'trigger', kind: 'HARD' }]);
    expect(parseDependencies(serializeDependencies([{ key: 'a', kind: 'CONDITIONAL' }]))).toEqual([
      { key: 'a', kind: 'CONDITIONAL' },
    ]);
    expect(dependencyKeys([{ key: 'a', kind: 'SEQUENCING' }])).toEqual(['a']);
  });

  /**
   * The planner emits the kinds, rather than a verification script
   * manufacturing them. A definition really does block — you cannot research
   * the penalty for breaching a rule whose terms are undecided — but the
   * penalty for acting without a licence can be researched conditionally while
   * the licence trigger is still open, which is exactly the pair the live
   * packet cancelled.
   */
  it('are decided by the planner from the requirement graph', () => {
    const siblings = [
      { requirementKey: 'defn', kind: 'DEFINITION' },
      { requirementKey: 'trigger', kind: 'RESEARCH' },
    ] as Requirement[];

    expect(typeDependencies([{ key: 'defn', kind: 'HARD' }], siblings)).toEqual([
      { key: 'defn', kind: 'HARD' },
    ]);
    expect(typeDependencies([{ key: 'trigger', kind: 'HARD' }], siblings)).toEqual([
      { key: 'trigger', kind: 'CONDITIONAL' },
    ]);
    // A key naming nothing in this plan stays HARD: unknown is not permission.
    expect(typeDependencies([{ key: 'elsewhere', kind: 'HARD' }], siblings)).toEqual([
      { key: 'elsewhere', kind: 'HARD' },
    ]);
    // A kind the worker chose itself is kept.
    expect(typeDependencies([{ key: 'defn', kind: 'SEQUENCING' }], siblings)).toEqual([
      { key: 'defn', kind: 'SEQUENCING' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Workflow terminality is not research outcome
// ---------------------------------------------------------------------------

describe('what a verdict means for the packet', () => {
  it('advances only on a verdict that actually advanced', () => {
    const fragments = [fragment({ status: 'ACCEPTED' })];
    expect(outcomeFor({ verdict: 'PASS', orchestration: orchestration(), fragments })).toBe(
      'COMPLETE',
    );
  });

  /**
   * The bug this exists for: `brain_submit_audit` set COMPLETE for any
   * validated verdict, so a packet whose own judge said MORE_RESEARCH read as
   * an answer.
   */
  it('repairs rather than completing when the judge asked for more and an attempt is left', () => {
    const fragments = [fragment({ status: 'BLOCKED', attempt: 1, maxRepairs: 2 })];
    expect(
      outcomeFor({ verdict: 'MORE_RESEARCH', orchestration: orchestration(), fragments }),
    ).toBe('AWAITING_REPAIR');
    expect(repairable(fragments)).toHaveLength(1);
  });

  it('files short only where a person authorized filing short', () => {
    const fragments = [fragment({ status: 'BLOCKED', attempt: 3, maxRepairs: 2 })];
    expect(repairable(fragments)).toHaveLength(0);

    expect(
      outcomeFor({
        verdict: 'MORE_RESEARCH',
        orchestration: orchestration({ unresolvedGapPolicy: 'RECORD_GAPS' }),
        fragments,
      }),
    ).toBe('COMPLETE_WITH_GAPS');

    // Without that authorization, narrowing the goal is not the Brain's to do.
    expect(
      outcomeFor({ verdict: 'MORE_RESEARCH', orchestration: orchestration(), fragments }),
    ).toBe('NEEDS_HUMAN');
  });
});

// ---------------------------------------------------------------------------
// 5. The method reaches the worker at runtime
// ---------------------------------------------------------------------------

describe('the research method', () => {
  /**
   * Storing guidance in the repository is not delivering it.
   *
   * There are exactly three runtime paths into a connected Cowork worker, and
   * two of them are Brain's to control: the server instructions both eras
   * emit, and a tool the worker can call. This asserts the first carries the
   * method and the second returns it, because a contract the worker cannot
   * read is a document, not a mechanism.
   */
  it('is carried by the server instructions both MCP eras emit', () => {
    expect(SERVER_INSTRUCTIONS).toContain(RESEARCH_METHOD_SUMMARY);
    expect(RESEARCH_METHOD_SUMMARY.length).toBeGreaterThan(200);
  });

  it('is available in full from a tool, so the worker can read it before working', async () => {
    const tool = findTool('brain_research_method');
    expect(tool).toBeTruthy();
    const outcome = await tool!.run({}, {
      principal: { type: 'WORKER', id: 'wrk_test' },
    } as never);
    expect(outcome.value['version']).toBe(RESEARCH_METHOD_VERSION);
    expect(outcome.value['method']).toBe(RESEARCH_METHOD);
  });

  /**
   * The contract the operator reads and the text the worker receives must be
   * the same contract. They are separate files, so nothing but a test keeps
   * them from drifting into two different sets of instructions.
   */
  it('says the same thing in the worker contract as in the constant', () => {
    const doc = readFileSync('docs/workers/WORKER-CONTRACT.md', 'utf8');
    expect(doc).toContain(RESEARCH_METHOD_VERSION);
    const sections = RESEARCH_METHOD.split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.slice(3).trim());
    expect(sections.length).toBeGreaterThanOrEqual(7);
    for (const section of sections) expect(doc).toContain(section);
  });
});

// ---------------------------------------------------------------------------
// 6. The acceptance instrument itself
// ---------------------------------------------------------------------------

describe('the capability check', () => {
  /**
   * The instrument has to discriminate, or the production proof is a
   * formatting exercise.
   *
   * So it is run twice over the same shape of packet: once as the first live
   * one actually was, and once as a corrected one should be. Anything that
   * passes both is not measuring the correction.
   */
  function input(over: Partial<CapabilityInput> = {}): CapabilityInput {
    const good = claim({ id: 'clm_aaaaaaaaaaaaaaaaaaaa', accepted: true, fragmentId: 'f1' });
    return {
      orchestration: {
        id: 'orc_x',
        projectId: 'prj_x',
        status: 'COMPLETE',
        documentId: 'doc_x',
        completedAt: new Date().toISOString(),
      } as ResearchOrchestration,
      fragments: [fragment({ id: 'f1', fragmentKey: 'ny', status: 'ACCEPTED' })],
      attempts: [fragment({ id: 'f1', fragmentKey: 'ny', status: 'ACCEPTED' })],
      claims: [good],
      citable: [good],
      accepted: [good],
      coverage: new Map(),
      requirements: [],
      requirementCoverage: [],
      items: [],
      documentText: `The answer, citing ${good.id}.`,
      ...over,
    };
  }

  const failing = (clauses: ReturnType<typeof evaluateCapability>): string[] =>
    clauses.filter((clause) => !clause.ok).map((clause) => clause.id);

  it('passes a packet that shows every corrected behaviour', () => {
    expect(failing(evaluateCapability(input()))).toEqual([]);
  });

  /**
   * The regression, as it actually was: a fragment that recorded integrity
   * PASS, was blocked for coverage, and had its accepted claim discarded.
   */
  it('fails a packet that discarded accepted evidence with its fragment', () => {
    const orphan = claim({ id: 'clm_bbbbbbbbbbbbbbbbbbbb', accepted: true, fragmentId: 'f2' });
    const clauses = evaluateCapability(
      input({
        fragments: [
          fragment({ id: 'f1', fragmentKey: 'ny', status: 'ACCEPTED' }),
          fragment({
            id: 'f2',
            fragmentKey: 'tx',
            status: 'BLOCKED',
            attempt: 2,
            maxRepairs: 2,
            integrityVerdict: 'PASS',
          }),
        ],
        claims: [claim({ id: 'clm_aaaaaaaaaaaaaaaaaaaa', accepted: true, fragmentId: 'f1' }), orphan],
        // Discarded: the claim is accepted and not citable.
        citable: [claim({ id: 'clm_aaaaaaaaaaaaaaaaaaaa', accepted: true, fragmentId: 'f1' })],
        accepted: [claim({ id: 'clm_aaaaaaaaaaaaaaaaaaaa', accepted: true, fragmentId: 'f1' })],
      }),
    );
    expect(failing(clauses)).toContain('P1');
  });

  it('fails a packet that abandoned a fragment with repair budget left', () => {
    const clauses = evaluateCapability(
      input({
        fragments: [
          fragment({ id: 'f1', fragmentKey: 'ny', status: 'ACCEPTED' }),
          fragment({
            id: 'f2',
            fragmentKey: 'tx',
            status: 'BLOCKED',
            attempt: 1,
            maxRepairs: 2,
            blockedReason: 'The statute site refuses automated retrieval.',
          }),
        ],
      }),
    );
    expect(failing(clauses)).toContain('P2');
  });

  it('fails a packet that stranded a conditional dependent', () => {
    const clauses = evaluateCapability(
      input({
        fragments: [
          fragment({ id: 'f1', fragmentKey: 'trigger', status: 'BLOCKED', attempt: 2, maxRepairs: 2 }),
          fragment({
            id: 'f2',
            fragmentKey: 'penalty',
            status: 'BLOCKED',
            attempt: 2,
            maxRepairs: 2,
            dependsOn: [{ key: 'trigger', kind: 'CONDITIONAL' }],
            blockedReason: 'Its dependency trigger never produced accepted evidence.',
          }),
        ],
      }),
    );
    expect(failing(clauses)).toContain('P3');
  });

  it('fails a packet that blamed the research for an unreadable source', () => {
    const clauses = evaluateCapability(
      input({
        claims: [
          claim({ id: 'clm_aaaaaaaaaaaaaaaaaaaa', accepted: true, fragmentId: 'f1' }),
          claim({
            id: 'clm_cccccccccccccccccccc',
            retrievalState: 'PAYWALLED',
            accepted: false,
            rejectionReason: 'The source does not support the claim.',
          }),
        ],
      }),
    );
    expect(failing(clauses)).toContain('P4');
  });

  it('fails a packet left non-terminal, or with work still queued', () => {
    expect(
      failing(
        evaluateCapability(input({ orchestration: { id: 'orc_x', projectId: 'prj_x', status: 'AWAITING_REPAIR', documentId: 'doc_x' } as ResearchOrchestration })),
      ),
    ).toContain('P5');
    expect(
      failing(
        evaluateCapability(
          input({ items: [{ state: 'QUEUED', orchestrationId: 'orc_x' } as never] }),
        ),
      ),
    ).toContain('P5b');
  });

  it('fails a report citing a claim the packet cannot resolve', () => {
    const clauses = evaluateCapability(
      input({ documentText: 'The answer, citing clm_dddddddddddddddddddd.' }),
    );
    expect(failing(clauses)).toContain('P6b');
  });

  /**
   * The failure the first live packet actually shows, and which the
   * conditional-dependent clause misses.
   *
   * It passed that clause *vacuously*: it had no conditional dependency,
   * because every dependency was HARD — and three fragments were cancelled
   * behind them, which is the defect itself.
   */
  it('fails a packet that cancelled a dependent behind its dependency', () => {
    const clauses = evaluateCapability(
      input({
        fragments: [
          fragment({ id: 'f1', fragmentKey: 'trigger', status: 'BLOCKED', attempt: 2, maxRepairs: 2 }),
          fragment({
            id: 'f2',
            fragmentKey: 'penalty',
            status: 'CANCELLED',
            dependsOn: [{ key: 'trigger', kind: 'HARD' }],
          }),
        ],
      }),
    );
    // P3 does not catch it — there is no conditional dependency to strand —
    // and it is reported as not exercised rather than as a pass.
    const p3 = clauses.find((clause) => clause.id === 'P3')!;
    expect(p3.ok).toBe(true);
    expect(p3.vacuous).toBe(true);
    // P3c does.
    expect(failing(clauses)).toContain('P3c');
  });

  /**
   * A clause the packet gave nothing to judge has not passed.
   *
   * Printing it as PASS is how an instrument flatters the thing it measures,
   * and it is the reason the run above read 11/14 when three of the eleven
   * were questions nobody had asked.
   */
  it('marks a clause nothing exercised as not exercised, rather than passed', () => {
    const clauses = evaluateCapability(input());
    const byId = new Map(clauses.map((clause) => [clause.id, clause]));
    // No blocked fragments, no conditional dependencies, no unread sources.
    for (const id of ['P1', 'P3', 'P4']) {
      expect(byId.get(id)!.ok).toBe(true);
      expect(byId.get(id)!.vacuous).toBe(true);
    }
    // And a clause the packet did exercise is a real pass.
    expect(byId.get('P5')!.vacuous).toBe(false);
  });

  it('fails a declared gap with no reason on it', () => {
    const clauses = evaluateCapability(
      input({
        requirements: [{ necessity: 'MANDATORY' } as Requirement],
        requirementCoverage: [{ status: 'NOT_REQUIRED', userOverride: null } as never],
      }),
    );
    expect(failing(clauses)).toContain('P7b');
  });
});
