/**
 * The fifteen things the production audit said were not true, made true.
 *
 * Each `describe` here is one of them, and each one is written against the
 * defect it exists to stop coming back rather than against the happy path:
 * every suite in this file that could pass by asserting a success asserts the
 * refusal instead, because the refusals are what the production run lost.
 *
 * What the audit found, in one paragraph. A sprint was activated and ten
 * discovery buckets opened; every one of their candidates parked on *no
 * standing authority exists for this project*, a sentence stored in a JSON
 * column no surface read. Separately, twenty administrator-started packets ran:
 * six were refused at the planning pass for declaring source types like
 * "company careers page", with a message saying they were not statutes — which
 * that envelope does not require. Four reached a filed report, thirteen of
 * their claims were destroyed by a verification pass that answered `UNSTATED`
 * rather than looking, and all four filed as "Opportunity Research v1" so three
 * were immediately superseded. Zero opportunities were produced, because the
 * bridge from a claim to a piece of work compared the lane id against the
 * literal `demand_signal`, which none of the seventeen lane ids production
 * wrote ever was.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import {
  CASH_DISCOVERY_AUTHORITY_NAME,
  DISCOVERY_CONCURRENCY,
  discoveryAuthority,
  ensureDiscoveryAuthority,
  resumeAuthorityParkedCandidates,
} from '../server/services/cash/discoveryAuthority.ts';
import { listGoals, reserve } from '../server/repos/russellAuthority.ts';
import { ALWAYS_PROHIBITED } from '../server/repos/russellAuthority.ts';
import { liveAuthority } from '../server/repos/cashAuthority.ts';
import { getDb } from '../server/db/database.ts';
import {
  createCandidate,
  getCandidate,
  listCandidates,
  recordJudgment,
} from '../server/repos/russellCandidates.ts';
import { listOrchestrationsByProject } from '../server/repos/research.ts';
import { findTool } from '../server/mcp/tools.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { OPPORTUNITY_SIGNALS } from '../server/domain/opportunitySignals.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { tick } from '../server/services/russell/loop.ts';
import {
  APPROVAL_ENVELOPES,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import { applyGate } from '../server/services/research/gate.ts';
import {
  declaredScopeOf,
  scopeAnswerRefusal,
  parseVerificationPass,
} from '../server/services/research/schema.ts';
import type { ClaimScopeMatch } from '../server/services/research/schema.ts';
import { buildCanonicalName } from '../server/domain/naming.ts';
import { cashEngineCard, derivedEconomics, ENGINE_FIELDS } from '../server/services/cash/engineCard.ts';
import { cashView } from '../server/services/cash/view.ts';
import { cashRoadmap } from '../server/services/cash/roadmap.ts';
import { openRound } from '../server/repos/cashDiscovery.ts';
import { WORK_ITEM_STATES } from '../server/domain/types.ts';
import {
  launchMission,
  renewLiveMissionReservations,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import type {
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  CashCardFact,
  CashOpportunity,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `repair-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function start(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// 1, 2 — starting Cash Mode is the authorization, and it authorizes only reading
// ---------------------------------------------------------------------------

describe('pressing Start is the authorization', () => {
  it('creates the internal discovery authorization exactly once', async () => {
    await start();
    const first = await discoveryAuthority(projectId);
    expect(first).not.toBeNull();
    expect(first!.name).toBe(CASH_DISCOVERY_AUTHORITY_NAME);

    // Activating again, and every tick after it, authorizes once.
    await start();
    await ensureDiscoveryAuthority(projectId);
    await ensureDiscoveryAuthority(projectId);

    const live = (await listGoals(projectId)).filter(
      (goal) => goal.state === 'ACTIVE' && goal.name === CASH_DISCOVERY_AUTHORITY_NAME,
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(first!.id);
  });

  it('grants no commercial authority and permits no external action', async () => {
    await start();
    const grant = await discoveryAuthority(projectId);
    expect(grant).not.toBeNull();

    // Research, and nothing else.
    expect(grant!.allowedWork).toEqual(['RESEARCH']);
    // Every external effect is prohibited on the row itself, not by a rule
    // somebody has to remember.
    for (const prohibition of ALWAYS_PROHIBITED) {
      expect(grant!.prohibitions).toContain(prohibition);
    }
    expect(grant!.prohibitions).toContain('NEW_SPENDING');
    expect(grant!.prohibitions).toContain('PURCHASE');
    expect(grant!.prohibitions).toContain('CONTACT_PERSON');
    expect(grant!.prohibitions).toContain('PUBLISH_EXTERNALLY');
    expect(grant!.maxExternalSpend).toBe(0);

    // And it is not a commercial grant. That is a separate decision a person
    // makes deliberately, and starting a sprint does not make it.
    expect(await liveAuthority(projectId)).toBeNull();
  });

  it('withdraws it when the sprint is archived, and restores it when it comes back', async () => {
    await start();
    await setLifecycle({
      projectId,
      to: 'ARCHIVED',
      actorUserId: userId,
      reason: 'The sprint is over.',
    });
    expect(await discoveryAuthority(projectId)).toBeNull();

    await setLifecycle({
      projectId,
      to: 'ACTIVE',
      actorUserId: userId,
      reason: 'Picking it back up.',
    });
    expect(await discoveryAuthority(projectId)).not.toBeNull();

    // Nothing was destroyed: the withdrawn grant keeps its row and its reason.
    const all = await listGoals(projectId);
    expect(all.filter((goal) => goal.state === 'REVOKED')).toHaveLength(1);
    expect(all.find((goal) => goal.state === 'REVOKED')!.revokedReason).toContain('archived');
  });
});

// ---------------------------------------------------------------------------
// 3 — the ideas that parked for want of it come back, once, without duplication
// ---------------------------------------------------------------------------

describe('ideas parked for want of the grant', () => {
  it('resumes them through the ordinary path and creates no duplicate', async () => {
    // A candidate parked exactly as production's ten were: judged, and stopped
    // on the sentence `standingAuthority()` composes.
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Who is publicly asking to pay for work right now',
      statement: 'Which buyers have published a paid request?',
    });
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason:
        'this depends on no standing authority exists for this project, which is not ready',
      judgment: { blockedBy: 'no standing authority exists for this project' },
      supporting: [],
      contradicting: [],
    });

    // Without a grant, nothing moves.
    expect(await resumeAuthorityParkedCandidates({ projectId })).toEqual([]);

    await start();
    const resumed = await resumeAuthorityParkedCandidates({ projectId });
    expect(resumed.map((one) => one.candidateId)).toEqual([candidate.id]);

    const after = await getCandidate(candidate.id);
    // Back where `unjudged()` will find it — that selector reads `priority IS
    // NULL` — and it is the same row, not a second one.
    expect(after!.state).toBe('CAPTURED');
    expect(after!.priority).toBeNull();
    expect(after!.id).toBe(candidate.id);

    // Running it again resumes nothing: the guard is on the exact state it
    // answers, so a second tick is a no-op rather than a second resumption.
    expect(await resumeAuthorityParkedCandidates({ projectId })).toEqual([]);
  });

  it('leaves an idea parked for any other reason exactly where it is', async () => {
    await start();
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'Something the archive already answered',
      statement: 'A question this project has already researched.',
    });
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'Researched once and it produced no report.',
      judgment: { blockedBy: 'the archive already answers this' },
      supporting: [],
      contradicting: [],
    });

    expect(await resumeAuthorityParkedCandidates({ projectId })).toEqual([]);
    expect((await getCandidate(candidate.id))!.state).toBe('PARKED');
  });
});

// ---------------------------------------------------------------------------
// 4, 5 — the envelope admits market sources and still refuses every effect
// ---------------------------------------------------------------------------

describe('the cash discovery envelope', () => {
  const ENVELOPE = APPROVAL_ENVELOPES['RUSSELL_CASH_DISCOVERY_V1']!;

  function packet(): ResearchOrchestration {
    return {
      id: 'orc_test',
      assignment: ENVELOPE.assignmentTemplate!.replace('{QUESTION}', 'Who is asking to pay?')
        .replace('{JURISDICTION}', 'the market this question names'),
      fixture: false,
      unresolvedGapPolicy: null,
    } as unknown as ResearchOrchestration;
  }

  function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
    return {
      fragmentKey: 'market-signal',
      question: 'Which buyers have published a paid request for work deliverable within weeks?',
      geography: 'United States',
      timeframe: 'Postings open as of today',
      population: 'Individual postings naming a task and a payment',
      definitions: 'A paid request is one posting naming a task and a payment amount.',
      acceptableSourceTypes: ['a marketplace or job board listing'],
      excludedSourceTypes: ['a forecast presented as a current fact'],
      completionCriteria: ['at least one dated published request'],
      minIndependentSources: 1,
      requiredEvidence: [{ id: 'demand_signal', description: 'a published request', necessity: 'REQUIRED' }],
      ...overrides,
    } as unknown as ResearchFragment;
  }

  /*
   * The exact source phrases production was refused for.
   *
   * Every one of these cost a whole plan at the planning pass, and every one is
   * an ordinary published artefact this envelope's own authorization admits.
   */
  const ADMITTED = [
    'company careers page',
    "A platform's own public pricing page",
    'named domain appraisal service report',
    "A business's own careers/hiring page",
    'Small-business capability-statement directories (e.g. SBA Dynamic Small Business Search / DSBS)',
    'state consumer-protection or licensing board complaint record',
    'Google Business review thread',
    'Yelp review thread',
    'government surplus auction platform listing page',
    'public freelance or project marketplace listing page',
    'Official government procurement portal listing',
    'bounty platform public listing',
  ];

  it('admits the market sources it refused six production plans for', () => {
    for (const source of ADMITTED) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ acceptableSourceTypes: [source] })],
      });
      expect(verdict.reasons.join(' '), source).not.toMatch(/does not admit/);
    }
  });

  it('still refuses a source that is not a published artefact', () => {
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: packet(),
      fragments: [fragment({ acceptableSourceTypes: ['a purchased contact list'] })],
    });
    expect(verdict.fits).toBe(false);
    // And the refusal quotes this envelope's own rule rather than a constant
    // about statutes, which is what sent an operator looking for the wrong fix.
    expect(verdict.reasons.join(' ')).toMatch(/this envelope does not admit/);
    expect(verdict.reasons.join(' ')).toMatch(/a published source somebody can open/);
    expect(verdict.reasons.join(' ')).not.toMatch(/primary statute/);
  });

  /*
   * The half that must not move.
   *
   * Each of these is Brain being told to do something to the world, and each
   * is refused whatever the subject matter is.
   */
  const STILL_REFUSED = [
    'Email the buyer to confirm the budget.',
    'Contact the agency and ask what they will pay.',
    'Purchase the dataset and quote the figures.',
    'Place a bid on the surplus lot.',
    'Publish a listing offering the service.',
    'Register with the marketplace to see the full posting.',
    'We will call the supplier to confirm the price.',
  ];

  it('refuses every instruction to act on the world', () => {
    for (const question of STILL_REFUSED) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ question })],
      });
      expect(verdict.fits, question).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(
        /an action on the world rather than reading a published source/,
      );
    }
  });

  /*
   * And the half that was refusing the work it exists to permit.
   *
   * A surplus auction *is* a purchase; a listing explains how to place a bid;
   * a platform's terms say who may contact whom. None of those is Brain acting.
   */
  const READING_ABOUT_A_TRANSACTION = [
    'Which government surplus listings are currently available to purchase, and what does the listing say about the closing time?',
    'Record what the listing says about how to place a bid, quoting the platform.',
    "Establish what the platform's own terms state about a third party contacting the two listers.",
    'Which businesses are hiring for a role that describes the gap?',
    'Which assets are listed for sale at a published price?',
  ];

  it('admits reading about a transaction it may not perform', () => {
    for (const question of READING_ABOUT_A_TRANSACTION) {
      const verdict = planFitsEnvelope({
        envelope: ENVELOPE,
        orchestration: packet(),
        fragments: [fragment({ question })],
      });
      expect(verdict.reasons.join(' '), question).not.toMatch(/an action on the world/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6, 7, 8 — the evidence bar, per lane and per kind
// ---------------------------------------------------------------------------

describe('the evidence bar', () => {
  function claim(overrides: Partial<ResearchClaim> = {}): ResearchClaim {
    return {
      id: `clm_${Math.random().toString(36).slice(2, 10)}`,
      orchestrationId: 'orc_test',
      fragmentId: 'frg_test',
      passId: null,
      passKey: 'TARGETED',
      claim: 'A buyer published a request for parcel research.',
      sourceUrl: 'https://example.test/rfp/1',
      sourceTitle: 'A listing',
      sourcePublisher: 'A marketplace',
      sourceDate: '2026-09-10',
      evidenceExcerpt: 'the listing body',
      evidenceLocator: 'the listing body',
      evidenceLane: 'task_listing',
      opportunitySignal: null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
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
      claimType: 'SOURCED_FACT',
      sourceGroup: 'host:example.test',
      primarySource: true,
      geography: null,
      timeframe: null,
      population: null,
      definition: null,
      requirementIds: [],
      jobId: null,
      contentHash: Math.random().toString(36),
      createdAt: new Date().toISOString(),
      ...overrides,
    } as unknown as ResearchClaim;
  }

  function fragment(overrides: Partial<ResearchFragment> = {}): ResearchFragment {
    return {
      id: 'frg_test',
      geography: 'United States',
      timeframe: null,
      population: null,
      definitions: null,
      minIndependentSources: 1,
      requiredEvidence: [
        { id: 'task_listing', description: 'a published listing', necessity: 'REQUIRED' },
      ],
      ...overrides,
    } as unknown as ResearchFragment;
  }

  const MATCH: ClaimScopeMatch = {
    geography: 'MATCH',
    timeframe: 'MATCH',
    population: 'MATCH',
    definitions: 'MATCH',
  };

  function verify(claims: ResearchClaim[]) {
    return {
      verdicts: new Map(
        claims.map((one) => [one.id, { supportsClaim: true, scopeMatch: MATCH, note: '' }]),
      ),
      sufficiency: 'SUFFICIENT' as const,
      missingLanes: [],
      unresolvedGaps: [],
    };
  }

  it('lets one authoritative listing prove one specific opening', () => {
    const claims = [claim()];
    const gate = applyGate({
      fragment: fragment(),
      claims,
      verification: verify(claims),
    });
    expect(gate.integrity).toBe('PASS');
    expect(gate.sufficiency).toBe('SUFFICIENT');
    expect(gate.coverage[0]!.evidenceKind).toBe('SPECIFIC_INSTANCE');
    expect(gate.coverage[0]!.requiredExamples).toBe(1);
  });

  it('enforces the distinct-example count a fragment declares', () => {
    // The production fragment's own completion criteria asked for three
    // independently-posted listings. The gate accepted one, because the
    // criteria were prose nothing read.
    const declared = fragment({
      requiredEvidence: [
        {
          id: 'task_listing',
          description: 'three separately-posted listings for the same task',
          necessity: 'REQUIRED',
          evidenceKind: 'MARKET_PATTERN',
          minDistinctExamples: 3,
        },
      ],
    });

    const one = [claim()];
    const short = applyGate({ fragment: declared, claims: one, verification: verify(one) });
    expect(short.sufficiency).toBe('INSUFFICIENT');
    expect(short.coverage[0]!.meetsThreshold).toBe(false);
    expect(short.coverage[0]!.requiredExamples).toBe(3);

    // Three postings on ONE board are three distinct examples and one
    // publisher. Both are true and they answer different questions.
    const three = [
      claim({ sourceUrl: 'https://example.test/project/40667257' }),
      claim({ sourceUrl: 'https://example.test/project/40703833' }),
      claim({ sourceUrl: 'https://example.test/project/40706646' }),
    ];
    const met = applyGate({ fragment: declared, claims: three, verification: verify(three) });
    expect(met.coverage[0]!.distinctExamples).toBe(3);
    expect(met.coverage[0]!.independentSources).toBe(1);
    expect(met.coverage[0]!.meetsThreshold).toBe(true);
  });

  it('makes a generalized economics lane need more than one publisher', () => {
    const declared = fragment({
      requiredEvidence: [
        {
          id: 'task_listing',
          description: 'what this kind of work pays across the market',
          necessity: 'REQUIRED',
          evidenceKind: 'GENERALIZED_ECONOMICS',
        },
      ],
    });
    const oneHost = [
      claim({ sourceUrl: 'https://example.test/a' }),
      claim({ sourceUrl: 'https://example.test/b' }),
    ];
    const short = applyGate({ fragment: declared, claims: oneHost, verification: verify(oneHost) });
    expect(short.coverage[0]!.meetsThreshold).toBe(false);
    expect(short.coverage[0]!.requiredIndependentSources).toBe(2);

    const twoHosts = [
      claim({ sourceUrl: 'https://example.test/a', sourceGroup: 'host:example.test' }),
      claim({ sourceUrl: 'https://other.test/b', sourceGroup: 'host:other.test' }),
    ];
    const met = applyGate({ fragment: declared, claims: twoHosts, verification: verify(twoHosts) });
    expect(met.coverage[0]!.meetsThreshold).toBe(true);
  });

  it('refuses a time-sensitive claim that says when nothing', () => {
    // 52 of 82 production claims carried no publication date, against an
    // assignment whose own evidence standard demanded one. Nothing checked.
    const dated = fragment({ timeframe: 'Postings open as of 2026-09-16' });
    const undated = [claim({ sourceDate: null, retrievedAt: null })];
    const gate = applyGate({ fragment: dated, claims: undated, verification: verify(undated) });
    expect(gate.claims[0]!.accepted).toBe(false);
    expect(gate.claims[0]!.failedCondition).toBe('DATED');

    // The retrieval date counts. "This is what the page said when it was read"
    // is an honest observation date, and is often the only one a listing has.
    const observed = [claim({ sourceDate: null, retrievedAt: '2026-09-16' })];
    const fine = applyGate({ fragment: dated, claims: observed, verification: verify(observed) });
    expect(fine.claims[0]!.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9 — a required scope dimension cannot silently become UNSTATED
// ---------------------------------------------------------------------------

describe('the verification contract', () => {
  const DECLARED = declaredScopeOf({
    geography: 'United States',
    timeframe: 'Postings open as of 2026-09-16',
    population: 'Distinct, separately-posted project listings',
    definitions: null,
  });

  it('refuses UNSTATED for a dimension the fragment declares', () => {
    const refusal = scopeAnswerRefusal({
      where: 'verdicts[0]',
      declared: DECLARED,
      scopeMatch: {
        geography: 'MATCH',
        timeframe: 'MATCH',
        population: 'UNSTATED',
        definitions: 'MATCH',
      },
      scopeBasis: { geography: 'US', timeframe: 'open now', population: 'the listings' },
    });
    expect(refusal).toMatch(/UNSTATED, which is no longer an answer/);
  });

  it('refuses a verdict with no basis for a declared dimension', () => {
    const refusal = scopeAnswerRefusal({
      where: 'verdicts[0]',
      declared: DECLARED,
      scopeMatch: {
        geography: 'MATCH',
        timeframe: 'MATCH',
        population: 'MATCH',
        definitions: 'NOT_APPLICABLE',
      },
      scopeBasis: { geography: 'US', timeframe: 'open now' },
    });
    expect(refusal).toMatch(/population_basis" is missing/);
  });

  it('accepts a complete answer, including an honest UNKNOWN', () => {
    expect(
      scopeAnswerRefusal({
        where: 'verdicts[0]',
        declared: DECLARED,
        scopeMatch: {
          geography: 'MATCH',
          timeframe: 'MATCH',
          population: 'UNKNOWN',
          definitions: 'MATCH',
        },
        scopeBasis: {
          geography: 'United States — the posting is New York, NY.',
          timeframe: 'Open as of 2026-09-16 — the posting has no stated close.',
          population: 'The posting does not say whether it is one of a repeated series.',
        },
      }),
    ).toBeNull();
  });

  it('refuses a whole verification pass whose verdict is incomplete', () => {
    const body = JSON.stringify({
      claimVerdicts: [
        {
          claimIndex: 0,
          supportsClaim: true,
          scopeMatch: {
            geography: 'MATCH',
            timeframe: 'MATCH',
            population: 'MATCH',
            definitions: 'MATCH',
          },
          contradictionState: 'UNCHALLENGED',
          note: 'The listing states it directly.',
        },
      ],
      sufficiency: 'SUFFICIENT',
      missingLanes: [],
      unresolvedGaps: [],
      reasoning: 'Everything checked out.',
    });
    const parsed = parseVerificationPass(body, DECLARED);
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13 — the historical rows this repair must not touch
// ---------------------------------------------------------------------------

describe('what the repair must not touch', () => {
  it('leaves a claim written before the signal column existed unpromotable', async () => {
    // Every production claim has `opportunity_signal = NULL`, because the
    // column did not exist when they were written. A claim with no signal is
    // not an opening, so none of them is promoted retroactively — which is the
    // instruction's own rule: existing evidence may be reused as archive
    // evidence and may not become an opportunity merely by existing.
    const { signalledClaims } = await import('../server/repos/research.ts');
    expect(await signalledClaims({ projectId })).toEqual([]);
  });

  it('keeps the canonical name a packet outside a cash project already had', () => {
    // Deal Dispatch files one packet per layer version, so its names must be
    // byte-identical: `launch()` treats one specification as researchable once,
    // and a changed name would relaunch work already done.
    expect(buildCanonicalName('Monetization Logic', 'v1')).toBe('Monetization Logic v1');
    expect(buildCanonicalName('Monetization Logic', 'v1', null)).toBe('Monetization Logic v1');
  });

  it('separates two concurrent packets answering different questions', () => {
    // Four production packets filed as "Opportunity Research v1" and three were
    // immediately marked superseded, because supersession is keyed on the name.
    const first = buildCanonicalName(
      'Opportunity Research',
      'v1',
      'Who is publicly asking to pay for work right now',
    );
    const second = buildCanonicalName(
      'Opportunity Research',
      'v1',
      'Which facts people are visibly paying to obtain',
    );
    expect(first).not.toBe(second);
    expect(first).toContain('Opportunity Research v1');
  });
});

// ---------------------------------------------------------------------------
// 12 — the card separates fact, estimate, assumption and unknown
// ---------------------------------------------------------------------------

describe('the Cash Engine Card', () => {
  function opportunity(overrides: Partial<CashOpportunity> = {}): CashOpportunity {
    return {
      id: 'cop_test',
      projectId,
      title: 'A county published a request for parcel research',
      currency: 'USD',
      payer: null,
      reachableChannel: null,
      buyingSignal: 'A county published a request for parcel research, closing 30 September.',
      signalObservedAt: '2026-09-16',
      offerScope: null,
      acceptanceCondition: null,
      priceCents: null,
      paymentTerms: null,
      fulfillmentOwner: null,
      deliveryMethod: null,
      deadline: null,
      economicsNote: null,
      peakFundingCents: null,
      humanHours: null,
      nextAction: null,
      validationState: 'COMPLETE',
      ...overrides,
    } as unknown as CashOpportunity;
  }

  function fact(overrides: Partial<CashCardFact>): CashCardFact {
    return {
      id: `ccf_${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      opportunityId: 'cop_test',
      kind: 'EVIDENCE',
      value: '',
      claimId: null,
      needId: null,
      basis: null,
      assumptions: null,
      uncertainty: null,
      decidedBy: 'BRAIN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as unknown as CashCardFact;
  }

  it('says of every answer whether it is a fact, an estimate or a person’s', () => {
    const card = cashEngineCard({
      opportunity: opportunity(),
      facts: [
        fact({
          field: 'revenueRange',
          kind: 'EVIDENCE',
          value: 'Comparable parcel-research work is listed at $400–$900.',
          claimId: 'clm_price',
        }),
        fact({
          field: 'requiredCapital',
          kind: 'RECOMMENDATION',
          value: 'At most the direct costs above.',
          basis: 'The published direct costs.',
          assumptions: 'That nothing else has to be bought first.',
          uncertainty: 'A cost that turns up later raises it.',
        }),
        fact({ field: 'offer', kind: 'PERSON', value: 'One parcel report, one county.' }),
      ],
    });

    const by = (key: string) => card.entries.find((one) => one.key === key)!;
    expect(by('revenueRange').kind).toBe('FACT');
    expect(by('revenueRange').claimId).toBe('clm_price');
    expect(by('requiredCapital').kind).toBe('ESTIMATE');
    expect(by('requiredCapital').uncertainty).not.toBeNull();
    expect(by('offer').kind).toBe('DECISION');
    // And what nobody has answered stays unknown rather than becoming a zero.
    expect(by('directCosts').kind).toBe('UNKNOWN');
    expect(by('directCosts').value).toBeNull();
    expect(card.unknowns).toContain('directCosts');
  });

  it('withholds a margin rather than computing one against an unknown cost', () => {
    const card = cashEngineCard({
      opportunity: opportunity(),
      facts: [
        fact({ field: 'revenueRange', kind: 'EVIDENCE', value: '$400–$900', claimId: 'clm_price' }),
      ],
    });
    const margin = derivedEconomics(card).find((one) => one.key === 'margin')!;
    expect(margin.value).toBeNull();
    expect(margin.withheld).toMatch(/direct costs are unknown/);

    const both = cashEngineCard({
      opportunity: opportunity(),
      facts: [
        fact({ field: 'revenueRange', kind: 'EVIDENCE', value: '$400–$900', claimId: 'clm_price' }),
        fact({ field: 'directCosts', kind: 'EVIDENCE', value: '$120 of data fees', claimId: 'clm_cost' }),
      ],
    });
    const computed = derivedEconomics(both).find((one) => one.key === 'margin')!;
    expect(computed.value).not.toBeNull();
    // Every input is named by the claim it came from, so a reader can check the
    // number rather than believe it.
    expect(computed.inputs.map((one) => one.claimId)).toEqual(['clm_price', 'clm_cost']);
    expect(computed.formula).toMatch(/less the published direct costs/);
  });
});

// ---------------------------------------------------------------------------
// 14 — reading the dashboard changes nothing
// ---------------------------------------------------------------------------

describe('the dashboard', () => {
  it('reads and refreshes without mutating any work', async () => {
    await start();
    const { openDiscovery } = await import('../server/services/cash/discovery.ts');
    await openDiscovery({ projectId });

    const { cashView } = await import('../server/services/cash/view.ts');
    const before = await snapshot();
    await cashView({ projectId });
    await cashView({ projectId });
    expect(await snapshot()).toEqual(before);
  });

  it('shows an open round whose candidate is parked as stopped, with the reason', async () => {
    await start();
    const { openDiscovery } = await import('../server/services/cash/discovery.ts');
    const [opened] = await openDiscovery({ projectId });
    expect(opened).toBeDefined();

    await recordJudgment({
      candidateId: opened!.candidateId,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'this depends on something that is not ready',
      judgment: { blockedBy: 'something else' },
      supporting: [],
      contradicting: [],
    });

    const { cashRoadmap } = await import('../server/services/cash/roadmap.ts');
    const map = await cashRoadmap(projectId);
    const round = map.active.find((one) => one.roundId !== undefined)!;
    // The round's own state column still says OPEN. What a person is shown is
    // what is actually happening, which is nothing.
    expect(round.state).toBe('OPEN');
    expect(round.activity).toBe('PARKED');
    expect(round.blocker).toMatch(/not ready/);
    expect(map.whatHappensNext).toMatch(/cannot proceed/);
  });
});

// ---------------------------------------------------------------------------
// 16 — the chain, from a person pressing Start to work a Routine can claim
// ---------------------------------------------------------------------------

describe('pressing Start produces work the fleet can actually take', () => {
  /*
   * The step that had no test, which is why nobody knew it was broken.
   *
   * Every suite that touches this path arranges its own starting state: the
   * integration walk writes its own research grant and builds its orchestration
   * by hand, so capture → judge → compile → envelope → launch → queue was
   * exercised by nothing end to end. That is exactly the stretch where all ten
   * production ideas died, and §24's lesson at a new seam — a test that arranges
   * its own starting state cannot tell a mechanism from a function nothing
   * calls.
   *
   * Nothing is simulated here: no worker, no provider, no network. The tick is
   * the real one, the judgment is the real one, the compiler is the real one
   * and the envelope is the real one. What is asserted is the thing production
   * did not have — a claimable work item.
   */
  it('captures, judges, compiles and queues real research with nothing parked', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });

    // Several passes, because one tick opens one bucket and the judgment,
    // compilation and launch each happen on a later one. Six is the ordinary
    // path rather than a tuned number: it is where the concurrency ceiling
    // stops it, which is the next assertion.
    for (let pass = 0; pass < 6; pass += 1) await tick(`repair-${pass}`);

    const candidates = await listCandidates({ projectId });
    expect(candidates.length).toBeGreaterThan(0);
    // The whole defect, in one assertion: not one idea parked for want of an
    // authorization the person had already given by pressing Start.
    expect(candidates.filter((one) => one.state === 'PARKED')).toEqual([]);
    expect(candidates.some((one) => one.priority === 'WORTH_DOING')).toBe(true);

    // Compiled against the cash envelope rather than the public-records one,
    // which is the Westbrook defect this path would otherwise repeat.
    const packets = await listOrchestrationsByProject(projectId);
    expect(packets.length).toBeGreaterThan(0);
    for (const packet of packets) expect(packet.failureReason).toBeNull();

    /*
     * And the answer production could never reach: work a Routine can claim.
     *
     * A queued RESEARCH_FRAGMENT is the thing at the far end of the chain —
     * an authorized, compiled, envelope-approved question sitting on the
     * durable queue with nothing else needed from anybody.
     */
    const items = await listWorkItems(projectId, { limit: 200 });
    const queued = items.filter(
      (one) => one.workType === 'RESEARCH_FRAGMENT' && one.state === 'QUEUED',
    );
    expect(queued.length).toBeGreaterThan(0);

    // Bounded by the grant's concurrency and by nothing else. It is a real
    // capacity limit rather than an allowance, so it caps what runs at once
    // and never how much may ever run.
    const running = packets.filter((one) => one.status === 'RESEARCHING');
    expect(running.length).toBeLessThanOrEqual(DISCOVERY_CONCURRENCY);

    // Still nothing that could touch the world.
    expect(await liveAuthority(projectId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 23 — a mission waiting on a person must not hold provider capacity
// ---------------------------------------------------------------------------

describe('a parked mission and the concurrency it was holding', () => {
  /*
   * The deadlock production reached, measured from its own rows.
   *
   * `NEEDS_HUMAN` is not a terminal state, so a parked mission's reservation is
   * never settled — and `renewLiveMissionReservations` listed `NEEDS_HUMAN`
   * among the live states, so the hold was renewed every tick and could never
   * age out either. The slot was held for ever by work that was not running.
   *
   * The live sprint: `maxConcurrent` two, three missions — one RUNNING and two
   * parked — and fifty-two ideas queued behind them that could never launch,
   * including the two deep dives the portfolio was waiting on. Nothing was
   * wrong with any of the fifty-two. There was no slot, and there never would
   * be one.
   *
   * Concurrency is real provider capacity (§24), and a mission waiting on a
   * person uses none of it.
   */
  async function heldConcurrency(goalId: string): Promise<number> {
    const row = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_budget_reservations
        WHERE goal_id = ? AND kind = 'MISSION' AND state = 'HELD' AND expires_at > ?`,
      [goalId, new Date().toISOString()],
    );
    return Number(row?.n ?? 0);
  }

  it('stops counting against the ceiling once the mission parks', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    const goal = (await discoveryAuthority(projectId))!;

    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: 'An opening worth qualifying',
      statement: 'A bounded question about one published opening.',
    });
    // The reservation the launch service takes, made here directly: what is
    // under test is what happens to the hold, not how the hold is acquired.
    const held = await reserve({
      goalId: goal.id,
      kind: 'MISSION',
      idempotencyKey: `mission:${candidate.id}`,
    });
    expect(held.ok).toBe(true);

    const { mission } = await launchMission({
      projectId,
      layerId: (await listLayers(projectId))[0]!.id,
      visibility: 'SHARED',
      objective: 'A bounded question about one published opening.',
      whyNow: 'the sprint is active',
      idempotencyKey: `mission:${candidate.id}`,
      candidateId: candidate.id,
      goalId: goal.id,
      reservationId: held.reservation!.id,
    } as never);

    // Running, so it is genuinely using capacity.
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await renewLiveMissionReservations(10);
    expect(await heldConcurrency(goal.id)).toBe(1);

    // Parked on a person. It is not running, and must not hold the slot.
    await transitionMission({
      missionId: mission.id,
      from: 'RUNNING',
      to: 'NEEDS_HUMAN',
      waitingOn: 'a person: the packet stopped at a decision',
    });
    await renewLiveMissionReservations(10);
    expect(await heldConcurrency(goal.id)).toBe(0);

    // The row is kept, not destroyed: still HELD, still on the audit.
    const kept = await getDb().get<{ state: string }>(
      `SELECT state FROM russell_budget_reservations WHERE goal_id = ? AND kind = 'MISSION'`,
      [goal.id],
    );
    expect(kept?.state).toBe('HELD');

    // And answering the park gives the capacity back, so nothing is lost by
    // freeing it: `renewReservation` is guarded on HELD, never on expiry.
    await transitionMission({
      missionId: mission.id,
      from: 'NEEDS_HUMAN',
      to: 'RUNNING',
      waitingOn: null,
    });
    await renewLiveMissionReservations(10);
    expect(await heldConcurrency(goal.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 22 — a diagnostic that invents a number is worse than one that omits it
// ---------------------------------------------------------------------------

describe('the production reader counts states that exist', () => {
  /*
   * `cash-report` counted work items in a bucket called `COMPLETED`. There is
   * no such state: the enum says `SUCCEEDED`. So the live sprint, whose items
   * had succeeded, reported `completed=0` — the single most alarming number
   * that line can print, and not a true one. It was very nearly read as a
   * deadlock.
   *
   * This is the same defect the whole repair is about, in the instrument built
   * to find it: a figure that cannot be true, dressed as a measurement. The
   * remedy is that the buckets come from the enum rather than from strings
   * somebody typed, so they are exhaustive by construction.
   */
  it('names only states the domain declares', async () => {
    const source = await readFile(new URL('../scripts/cash-report.ts', import.meta.url), 'utf8');
    // It reads the vocabulary rather than restating it.
    expect(source).toContain('WORK_ITEM_STATES');
    // And it may never count a state that does not exist.
    expect(source).not.toMatch(/'COMPLETED'/);
    for (const invented of ['COMPLETE', 'DONE', 'FINISHED']) {
      expect(WORK_ITEM_STATES as readonly string[]).not.toContain(invented);
    }
    expect(WORK_ITEM_STATES).toContain('SUCCEEDED');
  });
});

// ---------------------------------------------------------------------------
// 21 — the size of a sprint must not decide whether its own screen works
// ---------------------------------------------------------------------------

describe('reading the roadmap of a sprint that has grown', () => {
  /*
   * Production, at 52 ideas:
   *
   *     EMAXCONNSESSION max clients reached in session mode
   *     — max clients are limited to pool_size: 15
   *       in: SELECT * FROM russell_missions WHERE candidate_id = $1 …
   *       at latestMissionForCandidate … planFor … cashRoadmap
   *
   * `cashRoadmap` read every open round with an unbounded `Promise.all`, and
   * each round costs several queries — so the fan-out was a multiple of however
   * many rounds a sprint happened to have, against a pooler in session mode
   * where every connection is a client. Because the roadmap is part of
   * `cashView`, that is the Cash page failing to load rather than a report
   * failing to print, and it arrives precisely when a sprint starts working.
   *
   * The bound is asserted by driving the real function against many rounds and
   * counting how many reads are in flight at once, because the number is the
   * defect: a version that passes this cannot exhaust a pool that size.
   */
  it('never has more reads in flight than the pool can hold', async () => {
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });

    // Enough open rounds that an unbounded fan-out would exceed the pool.
    for (let round = 0; round < 24; round += 1) {
      const candidate = await createCandidate({
        projectId,
        visibility: 'SHARED',
        title: `Bucket ${round}`,
        statement: `A question for bucket ${round}.`,
      });
      await openRound({
        projectId,
        cashModeId: (await getCashMode(projectId))!.id,
        bucketId: `bucket-${round}`,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        candidateId: candidate.id,
        round: 1,
        question: `A question for bucket ${round}.`,
      } as never);
    }

    const db = getDb();
    let live = 0;
    let peak = 0;
    const realAll = db.all.bind(db);
    (db as unknown as { all: typeof db.all }).all = (async (...args: unknown[]) => {
      live += 1;
      peak = Math.max(peak, live);
      try {
        return await (realAll as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        live -= 1;
      }
    }) as typeof db.all;

    try {
      const map = await cashRoadmap(projectId);
      expect(map.rounds.total).toBe(24);
      // Every round is still described — the bound slows the read, it does not
      // shorten the answer.
      expect(map.active).toHaveLength(24);
    } finally {
      (db as unknown as { all: typeof db.all }).all = realAll;
    }

    // The pooled connection production uses holds 15. Well inside it.
    expect(peak).toBeLessThanOrEqual(12);
  });

  it('keeps each round\'s plan attached to that round', async () => {
    /*
     * Order, not just count. `plans` and `activities` are zipped back against
     * the rounds by index, so a bounded map returning completions in finishing
     * order would attach one round's plan to another round's row — a wrong
     * answer that reads as a working page, which is worse than the crash it
     * replaced.
     */
    await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    for (let round = 0; round < 9; round += 1) {
      const candidate = await createCandidate({
        projectId,
        visibility: 'SHARED',
        title: `Bucket ${round}`,
        statement: `A question for bucket ${round}.`,
      });
      await openRound({
        projectId,
        cashModeId: (await getCashMode(projectId))!.id,
        bucketId: `ordered-${round}`,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        candidateId: candidate.id,
        round: 1,
        question: `A question for bucket ${round}.`,
      } as never);
    }
    const map = await cashRoadmap(projectId);
    for (const round of map.active) {
      // Each row's own bucket, rather than a neighbour's.
      expect(round.bucketId.startsWith('ordered-')).toBe(true);
    }
    expect(new Set(map.active.map((one) => one.bucketId)).size).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 20 — a stricter contract has to reach the callers the suite never runs
// ---------------------------------------------------------------------------

describe('every in-repo caller speaks the current verification contract', () => {
  /*
   * How this was found: the deployed release refused its own hosted
   * verification.
   *
   * Making `*_basis` required is right — twelve of thirteen production
   * rejections were `UNSTATED`, a verdict nobody formed, and the submission is
   * refused now so a worker corrects it instead of the claim dying silently.
   * What was wrong is that the change reached every fixture in `tests/` and not
   * `scripts/verify-hosted.ts`, which is a scripted worker the suite never
   * runs. So the whole suite passed, the image released, and the live Brain
   * refused the packet its own release gate submits:
   *
   *     brain_submit_verification: INVALID_INPUT
   *     "verdicts[0].geography_basis" is missing.
   *
   * The refusal was correct in every respect. The caller was stale, and a real
   * worker would simply have resubmitted — a scripted one cannot.
   *
   * This reads the repository rather than behaviour, because behaviour is
   * exactly what the suite could not see: nothing here executes that script.
   */
  it('supplies a basis wherever it builds a scope verdict', async () => {
    const callers = ['../scripts/verify-hosted.ts'];
    for (const caller of callers) {
      const source = await readFile(new URL(caller, import.meta.url), 'utf8');
      if (!source.includes('brain_submit_verification')) continue;
      for (const dimension of ['geography', 'timeframe', 'population', 'definitions']) {
        // It answers the dimension, so it must say what it judged it against.
        expect(
          source.includes(`${dimension}:`) ? source.includes(`${dimension}_basis:`) : true,
        ).toBe(true);
      }
      // And it may never send the answer the contract withdrew.
      expect(source).not.toMatch(/geography: 'UNSTATED'/);
    }
  });
});

// ---------------------------------------------------------------------------
// 19 — the card is reachable by a reader, which is what "visible" means
// ---------------------------------------------------------------------------

describe('the Cash Engine Card is served', () => {
  /*
   * The defect: `cashEngineCard` was written, tested, and called by nothing.
   *
   * No route, no view and no component ever composed it — so the brief that is
   * the entire point of qualifying an opening could not be read by anybody, and
   * the last transition of the acceptance chain was unreachable while every
   * test of the card itself passed. It is this file's recurring sentence
   * arriving at the end of the pipeline rather than the middle: a mechanism
   * nothing calls is not a mechanism.
   *
   * Asserted through `cashView`, which is what the route returns, rather than
   * by calling the composer again — the question is whether a *reader* gets it.
   */
  it('reaches the view a person actually loads', async () => {
    const mode = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(mode.ok).toBe(true);

    const opening = await createOpportunity({
      projectId,
      cashModeId: (await getCashMode(projectId))!.id,
      ownerUserId: userId,
      title: 'A county published a request for parcel research',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      source: 'RESEARCH',
      currency: 'USD',
      sourceClaimId: 'clm_for_this_opening',
    } as never);

    const view = await cashView({ projectId });
    const card = view.myCurrentWork.engineCards[opening.id];
    expect(card).toBeTruthy();
    expect(card!.opportunityId).toBe(opening.id);

    // Every question a decision turns on is present, and a blank is the task
    // that would answer it rather than a zero.
    for (const key of ENGINE_FIELDS) {
      expect(card!.entries.some((entry) => entry.key === key)).toBe(true);
    }
    const unanswered = card!.entries.find((entry) => entry.value === null)!;
    expect(unanswered.kind).toBe('UNKNOWN');
    expect(unanswered.task.length).toBeGreaterThan(0);

    // And the arithmetic refuses rather than estimating, with its reason.
    const margin = view.myCurrentWork.economics[opening.id]!.find((one) => one.key === 'margin')!;
    expect(margin.value).toBeNull();
    expect(margin.withheld).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 18 — a researched answer reaches the card's own reader, not only its facts
// ---------------------------------------------------------------------------

describe('what the deep dive answers', () => {
  /*
   * `answers.ts` writes the opportunity column *and* the card fact when a
   * need's research settles a field. `applyValidationAnswers` wrote only the
   * fact — so the identical question, answered by the deep dive instead,
   * reached `cash_card_facts` and never reached `evidenceCard`, `readyToTest`
   * or anything else that reads the row.
   *
   * Two writers for one field with only one of them counting is this
   * repository's own recurring defect, and the fix is the one it keeps
   * reaching for: both read the same map rather than keeping a copy each.
   */
  it('writes the opportunity column as well as the fact, from one shared map', async () => {
    const { COLUMN } = await import('../server/services/cash/answers.ts');
    const validation = await import('../server/services/cash/validation.ts');

    // Every lane the deep dive fills resolves either to a real column or to an
    // engine field that deliberately has none. What must not exist is a third
    // answer — a field this believes has a column that the other writer does
    // not agree about.
    const fields = Object.values(validation.FIELD_BY_LANE);
    expect(fields).toContain('payer');
    expect(COLUMN['payer']).toBe('payer');
    // `hours` is an engine field: a card fact and nothing else, by design.
    expect(fields).toContain('hours');
    expect(COLUMN['hours']).toBeUndefined();

    // And the module reads that map rather than restating it, which is the
    // half that stops the two drifting apart later.
    const source = await readFile(
      new URL('../server/services/cash/validation.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/import \{ COLUMN \} from '\.\/answers\.ts'/);
    expect(source).toContain('updateOpportunity(opportunity.id, { [column]: value }');
  });
});

// ---------------------------------------------------------------------------
// 17 — the contract a worker reads has to admit what it asks for
// ---------------------------------------------------------------------------

describe('the submission contract', () => {
  /*
   * The defect this exists for, stated plainly.
   *
   * `brain_submit_claims` told a worker, in its description, to set
   * `opportunity_signal` on a claim that establishes an opening — and the
   * schema beside it declared `additionalProperties: false` without that
   * property. A client honouring the schema drops the field; one honouring the
   * prose sends something the schema forbids. Either way the single column that
   * decides whether any opportunity is ever created could never be filled, and
   * the failure reads exactly like a worker honestly finding no openings.
   *
   * It is the file's own recurring sentence at a new surface: a mechanism
   * nothing can call is not a mechanism. §27 records the same shape one door
   * along — `brain_check_in`'s schema saying its `session_ref` decided nothing
   * while the independence floor decided on it.
   */
  it('declares every input field its own description tells a caller to set', () => {
    const declaredNames = (node: unknown, out = new Set<string>()): Set<string> => {
      if (!node || typeof node !== 'object') return out;
      const shape = node as Record<string, unknown>;
      const properties = shape['properties'];
      if (properties && typeof properties === 'object') {
        for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
          out.add(key);
          declaredNames(child, out);
        }
      }
      if (shape['items']) declaredNames(shape['items'], out);
      return out;
    };

    const tool = findTool('brain_submit_claims')!;
    const declared = declaredNames(tool.inputSchema);
    // Named rather than scanned: this asserts the specific field whose absence
    // was measured, so the test fails on the defect rather than on wording.
    expect(tool.description).toContain('opportunity_signal');
    expect(declared.has('opportunity_signal')).toBe(true);

    const items = (tool.inputSchema as any).properties.claims.items;
    // The half that makes the omission fatal rather than merely untidy.
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.opportunity_signal.enum).toEqual([...OPPORTUNITY_SIGNALS]);
  });

  it('tells a worker about the signal while it is researching, not only at submission', () => {
    /*
     * The other half, and the one a schema check cannot see. A worker reads its
     * assignment before it starts looking; by the time it is filling in a claim
     * it has already decided what it was looking for. So the instruction lives
     * in the discovery profile's own completion criteria, which `assignmentFor`
     * hands over verbatim.
     */
    const profile = profileFor('RUSSELL_CASH_DISCOVERY_V1')!;
    const criteria = profile.completionCriteria('the markets this sprint may look at');
    expect(criteria.some((line) => line.includes('opportunity_signal'))).toBe(true);
    // And it may never read as a bar somebody has to clear to be believed.
    const line = criteria.find((one) => one.includes('opportunity_signal'))!;
    expect(line).toMatch(/lowers\s+no\s+bar/);
  });

  it('leaves the public-records profile alone', () => {
    // The instruction is the cash discovery profile's vocabulary, not a rule
    // every research assignment in the Brain acquires.
    const profile = profileFor('RUSSELL_PUBLIC_RECORDS_V1')!;
    for (const line of profile.completionCriteria('Michigan')) {
      expect(line).not.toContain('opportunity_signal');
    }
  });
});

/** Every row this repair is not allowed to change, as one comparable value. */
async function snapshot(): Promise<Record<string, number>> {
  const db = getDb();
  const out: Record<string, number> = {};
  for (const table of [
    'research_orchestrations',
    'research_fragments',
    'research_claims',
    'research_passes',
    'documents',
    'audits',
    'cash_discovery_rounds',
    'cash_opportunities',
    'russell_candidates',
    'work_items',
  ]) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}
