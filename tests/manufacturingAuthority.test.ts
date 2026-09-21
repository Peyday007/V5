/**
 * What the manufacturing kernel may never do, asserted as absences.
 *
 * ---------------------------------------------------------------------------
 * Why these are tests rather than sentences in a comment
 * ---------------------------------------------------------------------------
 *
 * Three decisions in this kernel belong to a person and to nobody else:
 * starting a programme, moving its lifecycle, and recording that this company
 * holds a capability. A fourth boundary is narrower and newer: identifying an
 * acquisition candidate is research, and **every effect that follows from one
 * is not** — no approach, no valuation, no offer, no diligence commitment, no
 * purchase.
 *
 * A boundary that exists only because nobody has written the function yet is
 * not a boundary; it is an omission waiting to be filled by whoever is nearest.
 * So this suite asserts the absences directly: it reads the repository for
 * routes and columns that must not exist, drives every write as a worker
 * principal to watch it be refused **by type**, and checks that no research
 * path anywhere can reach the one column research must never write.
 *
 * `operatorConsoleRemoved` is the precedent and the reason the source is read
 * rather than only the behaviour: what must not exist is not something a
 * behavioural test can see.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import {
  programmeAuthority,
  startProgramme,
} from '../server/services/manufacturing/program.ts';
import { ALWAYS_PROHIBITED } from '../server/repos/russellAuthority.ts';
import {
  declareHeld,
  reopenDecision,
  resolveDecision,
  seedCategory,
  setAsideAcquisition,
} from '../server/services/manufacturing/declare.ts';
import {
  ensureProgrammeDecision,
  getProgram,
  listAcquisitionCandidates,
  listProgrammeDecisions,
  recordAcquisitionCandidate,
} from '../server/repos/manufacturing.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { decideProjectAccess } from '../server/services/identity/policy.ts';
import type { Principal } from '../server/domain/types.ts';
import { insertClaims, decideClaim, createOrchestration, createFragments, currentFragments, updateFragment } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';

const OBJECTIVE =
  'Build a general-purpose machinery company, starting from powered equipment and working ' +
  'toward whatever the evidence says is reachable next.';

let fixture: TestProject;
let projectId: string;
let userId: string;
let layerId: string;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Discovery Logic')).id;
  const user = await createUser({
    email: `authority-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

const SOURCE = (file: string) => readFileSync(file, 'utf8');

const KERNEL_FILES = [
  'server/domain/manufacturing.ts',
  'server/repos/manufacturing.ts',
  'server/routes/manufacturing.ts',
  'server/services/manufacturing/allocate.ts',
  'server/services/manufacturing/capital.ts',
  'server/services/manufacturing/decisions.ts',
  'server/services/manufacturing/declare.ts',
  'server/services/manufacturing/directive.ts',
  'server/services/manufacturing/expand.ts',
  'server/services/manufacturing/kernel.ts',
  'server/services/manufacturing/ladder.ts',
  'server/services/manufacturing/priority.ts',
  'server/services/manufacturing/program.ts',
  'server/services/manufacturing/questions.ts',
  'server/services/manufacturing/readiness.ts',
  'server/services/manufacturing/view.ts',
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------

describe('identifying an acquisition is not acquiring one', () => {
  /**
   * The schema is the mechanism, not the prose.
   *
   * There is no column on `acquisition_candidates` that an approach, a
   * valuation Brain produced, a term, a price or a commitment could be written
   * into — so a later change that wanted to record one would have to add a
   * column, which is a migration somebody reviews. That is a far stronger
   * guarantee than a rule in a comment, and this is what asserts it.
   */
  it('has no column an offer, a valuation or a commitment could go in', () => {
    const migration = SOURCE('server/db/migrations/081_manufacturing_capital_and_intent.sql');
    const table = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS acquisition_candidates'),
    );
    const body = table.slice(0, table.indexOf(');'));
    for (const forbidden of [
      'valuation',
      'price',
      'offer',
      'bid',
      'terms',
      'approach',
      'contacted',
      'diligence',
      'committed',
      'signed',
      'amount',
      'multiple',
      'pursued',
    ]) {
      expect(body.toLowerCase(), `acquisition_candidates has a "${forbidden}" column`).not.toMatch(
        new RegExp(`^\\s*\\w*${forbidden}\\w*\\s+(text|integer|real|numeric)`, 'im'),
      );
    }
  });

  /** And no route that performs one, which the routes file is read for. */
  it('exposes exactly one verb on a candidate, and it is setting one aside', () => {
    const routes = withoutComments(SOURCE('server/routes/manufacturing.ts'));
    const acquisitionRoutes = [...routes.matchAll(/manufacturingRouter\.(get|post|patch|put|delete)\(\s*'([^']*acquisitions[^']*)'/g)];
    expect(acquisitionRoutes).toHaveLength(1);
    expect(acquisitionRoutes[0]![1]).toBe('patch');
    expect(routes).toContain('setAsideAcquisition');
    // Nothing anywhere in the kernel names an effect on a firm.
    for (const file of KERNEL_FILES) {
      const source = withoutComments(SOURCE(file));
      for (const forbidden of ['sendOffer', 'contactFirm', 'valueCandidate', 'pursueCandidate']) {
        expect(source, `${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('keeps a candidate and its evidence when a person says no', async () => {
    const started = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    expect(started.ok).toBe(true);
    const program = await getProgram(projectId);
    const seeded = await seedCategory({
      projectId,
      name: 'Commercial pressure washers',
      actorRef: userId,
    });
    const categoryId = (seeded as { category: { id: string } }).category.id;

    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'an acquisition round',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'an acquisition round',
      assignment: 'who holds what this requires',
      provider: 'WORKER',
      autoApprove: false,
    });
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId,
        layerId,
        geography: 'the markets the programme may look at',
        requiredEvidence: [
          { id: 'candidate', description: 'who holds what', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['a regulator’s register of approval holders'],
        excludedSourceTypes: ['a valuation the researcher produced'],
        completionCriteria: ['every firm supported by a quoted source'],
        minIndependentSources: 1,
        maxRepairs: 2,
        fragmentIndex: 0,
        fragmentKey: 'machine-acquisition',
        question: 'Who holds this?',
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, {
      status: 'ACCEPTED',
      completedAt: new Date().toISOString(),
      blockedReason: null,
    });
    const [claim] = await insertClaims([
      {
        orchestrationId: orchestration.id,
        fragmentId: fragment!.id,
        passId: null,
        passKey: 'BROAD_SCAN',
        claim: 'The register lists Ardent Pumps as an approval holder for this class.',
        sourceUrl: 'https://example.test/register/holders',
        sourceTitle: 'A register of approval holders',
        sourcePublisher: 'A regulator',
        sourceDate: '2026-05-01',
        evidenceExcerpt: 'Ardent Pumps, approval 44812.',
        evidenceLocator: 'row 218',
        evidenceLane: 'candidate',
        retrievedAt: '2026-05-02',
        confidence: 0.9,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        claimType: 'SOURCED_FACT',
        contentHash: 'ardent|acquisition',
      },
    ]);
    await decideClaim(claim!.id, { accepted: true });

    const candidate = await recordAcquisitionCandidate({
      programId: program!.id,
      categoryId,
      capabilityId: null,
      name: 'Ardent Pumps',
      contribution: 'CERTIFICATION_OR_APPROVAL',
      statement: 'The register lists it as an approval holder for this class.',
      sourceClaimId: claim!.id,
    });
    expect(candidate).toBeTruthy();

    const aside = await setAsideAcquisition({
      projectId,
      candidateId: candidate!.id,
      reason: 'Too far from what we are trying to build.',
      actorRef: userId,
    });
    expect('error' in aside).toBe(false);

    const rows = await listAcquisitionCandidates(program!.id);
    expect(rows).toHaveLength(1);
    // Kept whole, because deleting it would let the same firm arrive next
    // round as a fresh discovery, spending the allowance on a settled answer.
    expect(rows[0]!.name).toBe('Ardent Pumps');
    expect(rows[0]!.statement).toContain('approval holder');
    expect(rows[0]!.sourceClaimId).toBe(claim!.id);
    expect(rows[0]!.setAsideReason).toBe('Too far from what we are trying to build.');

    // And a second answer does not overwrite the first.
    const again = await setAsideAcquisition({
      projectId,
      candidateId: candidate!.id,
      reason: 'A different reason.',
      actorRef: userId,
    });
    expect('error' in again).toBe(false);
    expect((await listAcquisitionCandidates(program!.id))[0]!.setAsideReason).toBe(
      'Too far from what we are trying to build.',
    );

    // The surface carries it, set aside, rather than dropping it.
    const view = await programmeView(projectId);
    expect(view!.acquisitions).toHaveLength(1);
    expect(view!.acquisitions[0]!.candidate.setAsideAt).not.toBeNull();
    expect(view!.counts.acquisitionCandidatesSetAside).toBe(1);
  }, 60000);

  it('refuses a candidate set aside with no reason', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const outcome = await setAsideAcquisition({
      projectId,
      candidateId: 'macq_nothing',
      reason: '   ',
      actorRef: userId,
    });
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expect(outcome.error).toContain('records why');
  });
});

describe('the master brand is not named, and not forgotten', () => {
  it('raises the question as OPEN and proposes no answer', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const view = await programmeView(projectId);
    const brand = view!.openQuestions.find((one) => one.topic === 'MASTER_BRAND_ARCHITECTURE');
    expect(brand, 'the brand question is raised').toBeTruthy();
    expect(brand!.state).toBe('OPEN');
    expect(brand!.resolution).toBeNull();

    // It carries the criteria, what it depends on, and its reconsideration
    // trigger — all derived, and none of them a name.
    expect(brand!.criteria.length).toBeGreaterThanOrEqual(3);
    expect(brand!.dependencies.length).toBeGreaterThanOrEqual(2);
    expect(brand!.trigger).toContain('first actually entered');
    expect(brand!.because).toContain('correct state rather than a gap');
  }, 60000);

  /**
   * Nothing anywhere proposes, generates or exemplifies a name.
   *
   * Read from the source, because a behavioural test cannot see a shortlist
   * that has not been triggered yet — and because the failure mode of getting
   * this wrong is a screen that looks helpful and has quietly made the one
   * decision the directive reserves.
   */
  it('has no code anywhere that suggests a brand name', () => {
    const files = [
      ...KERNEL_FILES,
      'client/src/russell/Machines.tsx',
    ];
    for (const file of files) {
      const source = withoutComments(SOURCE(file));
      for (const forbidden of [
        'suggestName',
        'proposeName',
        'candidateNames',
        'brandCandidates',
        'generateBrand',
      ]) {
        expect(source, `${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('records a person’s own words and lets them be unchosen', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const program = await getProgram(projectId);
    await ensureProgrammeDecision({
      programId: program!.id,
      topic: 'MASTER_BRAND_ARCHITECTURE',
    });

    const resolved = await resolveDecision({
      projectId,
      topic: 'MASTER_BRAND_ARCHITECTURE',
      resolution: 'We are calling it Meridian, with no division names fixed.',
      actorRef: userId,
    });
    expect('error' in resolved).toBe(false);
    if (!('error' in resolved)) {
      expect(resolved.state).toBe('RESOLVED');
      // Exactly as typed. Nothing validates, derives or improves it.
      expect(resolved.resolution).toBe('We are calling it Meridian, with no division names fixed.');
    }

    // The answering transition, because the directive's own caution — do not
    // lock names prematurely — is a reason a name chosen early may need
    // unchoosing.
    const reopened = await reopenDecision({
      projectId,
      topic: 'MASTER_BRAND_ARCHITECTURE',
      reason: 'It reads as a pump company.',
      actorRef: userId,
    });
    expect('error' in reopened).toBe(false);
    if (!('error' in reopened)) {
      expect(reopened.state).toBe('OPEN');
      // Cleared rather than kept: a question reading OPEN while still carrying
      // an answer is the status contradicting the control beside it.
      expect(reopened.resolution).toBeNull();
    }

    const rows = await listProgrammeDecisions(program!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('OPEN');
  }, 60000);

  it('refuses an empty answer, saying what an answer is', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const outcome = await resolveDecision({
      projectId,
      topic: 'MASTER_BRAND_ARCHITECTURE',
      resolution: '  ',
      actorRef: userId,
    });
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expect(outcome.error).toContain('the words you would say');
  });
});

describe('a machine is refused at every manufacturing write, by type', () => {
  /**
   * A worker principal is refused by level *and* by type, and this asserts the
   * level half from the policy module the routes actually call.
   *
   * The type half is `requirePerson` in `routes/manufacturing.ts`, which
   * refuses a worker at the reads as well — two independent guards, because a
   * guard on one entrance is not a guard.
   */
  it('gives a worker no route to any of them, however its membership is set', async () => {
    const worker = await createWorker({
      name: `machine-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'HUMAN',
      createdById: userId,
    });
    // The widest membership and the widest scopes a worker can be given. They
    // change nothing: ADMIN is refused by principal *type*, before a
    // membership or a scope is consulted at all.
    const membership = await grantMembership({
      projectId,
      principalType: 'WORKER',
      principalId: worker.id,
      role: 'OWNER',
      scopes: ['project:read', 'research:write', 'claims:write'],
      grantedByType: 'HUMAN',
      grantedById: userId,
    });

    const machine: Principal = {
      type: 'WORKER',
      id: worker.id,
      handle: worker.name,
      displayName: worker.name,
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cred_test',
      authMethod: 'WORKER_BEARER',
      memberships: [membership],
      requestId: 'req_test',
    };

    expect(decideProjectAccess(machine, projectId, 'ADMIN').allowed).toBe(false);
    // And a project administrator, who is a person, is allowed — so the
    // refusal above is about being a machine rather than about the fixture
    // having no access at all.
    const person = await createUser({
      email: `member-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'A project administrator',
      password: 'correct horse battery staple',
      isBrainAdmin: false,
    });
    const personMembership = await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: person.id,
      role: 'ADMIN',
      grantedByType: 'HUMAN',
      grantedById: userId,
    });
    expect(
      decideProjectAccess(
        {
          type: 'HUMAN',
          id: person.id,
          handle: person.email,
          displayName: person.displayName,
          isBrainAdmin: false,
          mustChangePassword: false,
          credentialId: 'ses_test',
          authMethod: 'SESSION_COOKIE',
          memberships: [personMembership],
          requestId: 'req_test',
        },
        projectId,
        'ADMIN',
      ).allowed,
    ).toBe(true);
  }, 60000);

  it('puts every manufacturing write at ADMIN, in one policy module', () => {
    const policy = SOURCE('server/services/identity/policy.ts');
    expect(policy).toMatch(
      /\{ pattern: \/\^\\\/api\\\/projects\\\/\[\^\/\]\+\\\/manufacturing\/, method: 'POST', level: 'ADMIN' \}/,
    );
    expect(policy).toMatch(
      /\{ pattern: \/\^\\\/api\\\/projects\\\/\[\^\/\]\+\\\/manufacturing\/, method: 'PATCH', level: 'ADMIN' \}/,
    );
    // And there is no second place that decides it.
    for (const file of KERNEL_FILES) {
      const source = withoutComments(SOURCE(file));
      expect(source, `${file} decides authorization of its own`).not.toMatch(
        /function\s+\w*(authorize|canAccess|hasPermission)\w*\s*\(/i,
      );
    }
  });

  it('calls requirePerson on every manufacturing route, including the reads', () => {
    const routes = SOURCE('server/routes/manufacturing.ts');
    const handlers = [...routes.matchAll(/manufacturingRouter\.\w+\(/g)];
    const guards = [...routes.matchAll(/requirePerson\(\)/g)];
    expect(handlers.length).toBeGreaterThan(0);
    expect(guards.length).toBe(handlers.length);
  });
});

describe('research may never establish what this company can do', () => {
  /**
   * The rule the whole kernel rests on, asserted as an absence in the code
   * rather than as behaviour.
   *
   * `expand.ts` is what files research findings. It must not import the
   * function that marks a capability held, must have no parameter for it, and
   * no value of `capability_finding` may route to it.
   */
  it('gives the absorption no path to held_at', () => {
    /*
     * Comment-stripped, deliberately.
     *
     * `expand.ts` *names* `declareCapabilityHeld` twice in its own prose, both
     * times to say that it does not import it — which is history worth keeping
     * rather than a mention to be hunted down. What must not exist is the
     * import and the call, which is what the stripped source is read for.
     */
    const absorb = withoutComments(SOURCE('server/services/manufacturing/expand.ts'));
    expect(absorb).not.toContain('declareCapabilityHeld');
    expect(absorb).not.toContain('held_at');
    /*
     * *Reading* a holding is fine and necessary — the acquisition question
     * names the capabilities this company does not hold, which is a filter on
     * `heldAt`. What must not exist is a **write**: a property assignment
     * carrying it, in any of its three spellings.
     */
    for (const field of ['heldAt', 'heldBy', 'heldEvidence', 'heldNote']) {
      expect(absorb, `expand.ts assigns ${field}`).not.toMatch(
        new RegExp(`${field}\\s*:`),
      );
    }
    expect(absorb).toMatch(/heldAt === null/);

    // And the one function that writes it takes an actor and an evidence kind,
    // so a caller with neither cannot reach it.
    const repo = SOURCE('server/repos/manufacturing.ts');
    const writer = repo.slice(repo.indexOf('export async function declareCapabilityHeld'));
    expect(writer.slice(0, 600)).toMatch(/heldBy|actor/i);
  });

  it('has no capability finding that creates a holding', () => {
    const domain = SOURCE('server/domain/manufacturing.ts');
    const creates = domain.slice(domain.indexOf('const CREATES'), domain.indexOf('});', domain.indexOf('const CREATES')));
    expect(creates).not.toMatch(/HELD|HOLDING/i);
    // Every target is one of the five tables research may write.
    const targets = [...creates.matchAll(/table: '([A-Z_]+)'/g)].map((one) => one[1]);
    expect(new Set(targets)).toEqual(
      new Set(['CATEGORY', 'CAPABILITY', 'EVIDENCE', 'CAPITAL', 'ACQUISITION']),
    );
  });

  it('refuses a held declaration with no note saying how it came to be true', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const outcome = await declareHeld({
      projectId,
      name: 'small engine integration',
      note: '   ',
      actorRef: userId,
    });
    expect('error' in outcome).toBe(true);
  });
});

describe('nothing in this kernel builds, buys, tools or enters anything', () => {
  it('has no route, service or repository function that performs one', () => {
    const files = [...KERNEL_FILES, 'client/src/russell/Machines.tsx'];
    const forbidden = [
      'enterCategory',
      'beginProduction',
      'startManufacturing',
      'placeOrder',
      'purchaseTooling',
      'commitCapital',
      'spend',
    ];
    for (const file of files) {
      const source = withoutComments(SOURCE(file));
      for (const name of forbidden) {
        expect(
          source.includes(`function ${name}`) || source.includes(`${name}(`),
          `${file} names ${name}`,
        ).toBe(false);
      }
    }
  });

  /**
   * And the grant a programme writes cannot permit one.
   *
   * Asserted three ways, weakest last. The **row** a real start produces
   * carries zero external spend and every always-prohibited action. The
   * **repository** writes that zero as a literal in the INSERT and takes no
   * argument for it, so there is nothing a caller could pass — which is a
   * stronger guarantee than nobody passing one. And this module names the
   * research work type and nothing else.
   */
  it('writes a grant that authorizes reading published sources and nothing else', async () => {
    const started = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    expect(started.ok).toBe(true);

    const goal = await programmeAuthority(projectId);
    expect(goal, 'starting a programme is what authorizes its research').toBeTruthy();
    expect(goal!.maxExternalSpend).toBe(0);
    expect(goal!.allowedWork).toEqual(['RESEARCH']);
    for (const prohibited of ALWAYS_PROHIBITED) {
      expect(goal!.prohibitions, `${prohibited} is not prohibited`).toContain(prohibited);
    }

    // There is no argument for it, so the literal cannot be overridden.
    const repo = SOURCE('server/repos/russellAuthority.ts');
    expect(repo).not.toMatch(/maxExternalSpend\??:\s*number/);
    const program = SOURCE('server/services/manufacturing/program.ts');
    expect(program).toMatch(/allowedWork:\s*\[RESEARCH_WORK\]/);
    expect(program).toMatch(/const RESEARCH_WORK = 'RESEARCH'/);
  }, 60000);
});
