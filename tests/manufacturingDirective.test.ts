/**
 * The directive is read, and its words reach the worker.
 *
 * ---------------------------------------------------------------------------
 * What this suite exists to catch, said precisely
 * ---------------------------------------------------------------------------
 *
 * `manufacturingBlueprint.test.ts` proves the file is in the image and that a
 * path and a sha-256 can be recorded against it. That is **integrity**, and it
 * is the whole of what a hash can say: the bytes have not changed.
 *
 * It says nothing about whether one word of the directive ever reached a
 * worker. Before `services/manufacturing/directive.ts` existed, the answer was
 * *none of them* — the file was copied into the image, hashed, recorded on the
 * programme row, and never opened. An assignment carried the objective a
 * person typed at start and nothing else, and every row about it read healthy.
 *
 * So the test that matters is this one, and its shape is chosen to fail in
 * exactly that case: it drives a programme to an **opened work item** and
 * reads the assignment text a worker would actually be handed, then asserts
 * the directive's own sentences are in it. Delete the calls in `questions.ts`
 * and every other manufacturing suite still passes; this one fails naming the
 * sentence that stopped arriving.
 *
 * ---------------------------------------------------------------------------
 * And the screen that says so
 * ---------------------------------------------------------------------------
 *
 * *Hashed* and *operative* being two facts is only useful if a person can see
 * which one holds, so the view reports them separately and that is asserted
 * here too — including the case nothing else exercises, where a programme
 * names a directive nobody can open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import {
  corePrincipleBrief,
  compoundingBrief,
  dimension,
  readDirective,
  searchSpread,
  type Directive,
} from '../server/services/manufacturing/directive.ts';
import {
  DEFAULT_DIRECTIVE_PATH,
  startProgramme,
} from '../server/services/manufacturing/program.ts';
import { runManufacturingKernel } from '../server/services/manufacturing/kernel.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import {
  closeManufacturingRound,
  getProgram,
  listManufacturingRounds,
  recordCategoryEvidence,
} from '../server/repos/manufacturing.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';

const OBJECTIVE =
  'Build a general-purpose machinery company, starting from powered equipment and working ' +
  'toward whatever the evidence says is reachable next.';

let fixture: TestProject;
let projectId: string;
let userId: string;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `directive-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
});

/**
 * A real accepted claim for the anchor's demand evidence.
 *
 * `category_evidence.source_claim_id` is a foreign key, and that is the point
 * of the column rather than a formality: a finding with no claim behind it is
 * one nobody can trace to a source. So the fixture writes one through the real
 * repositories instead of inventing an id.
 */
async function anchorClaim(): Promise<string> {
  const layer = await fixture.layerByName('Discovery Logic');
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'the anchor demand round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'the anchor demand round',
    assignment: 'who is buying',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the programme may look at',
      requiredEvidence: [{ id: 'buying', description: 'who buys', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a trade association statistic'],
      excludedSourceTypes: ['a market-size estimate'],
      completionCriteria: ['every observation carries its date'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'machine-demand',
      question: 'Who is buying?',
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
      claim: 'The association reported 41,800 units shipped in the year to June.',
      sourceUrl: 'https://example.test/trade-body/shipments',
      sourceTitle: 'A trade body statistic',
      sourcePublisher: 'A trade association',
      sourceDate: '2026-07-01',
      evidenceExcerpt: '41,800 units.',
      evidenceLocator: 'the table body',
      evidenceLane: 'buying',
      capabilityFinding: 'DEMAND_EVIDENCE',
      capabilitySubject: 'UNIT_SHIPMENTS',
      capabilityObservedOn: '2026-06-30',
      retrievedAt: '2026-07-02',
      confidence: 0.9,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT',
      contentHash: 'anchor|demand',
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

async function directive(): Promise<Directive> {
  const read = await readDirective(DEFAULT_DIRECTIVE_PATH);
  expect(read.ok, read.ok ? '' : read.reason).toBe(true);
  if (!read.ok) throw new Error(read.reason);
  return read.directive;
}

/**
 * The text a worker would actually be handed for the opening question.
 *
 * Read from the **candidate's statement**, which is the row `compose` wrote
 * and the row the compiler turns into a fragment. A fixture that called
 * `bootstrapQuestion` directly would prove the function composes a string and
 * nothing about whether anything calls it — which is the *mechanism nothing
 * calls* this repository has had to correct six times.
 */
async function openingAssignment(): Promise<string> {
  await runManufacturingKernel(projectId);
  const program = await getProgram(projectId);
  expect(program).toBeTruthy();
  const rounds = await listManufacturingRounds(program!.id);
  const bootstrap = rounds.find((one) => one.purpose === 'BOOTSTRAP');
  expect(bootstrap, 'the kernel opened its opening question').toBeTruthy();
  const candidates = await listCandidates({ projectId });
  const asked = candidates.find((one) => one.id === bootstrap!.candidateId);
  expect(asked, 'the round resolves to the idea it asked').toBeTruthy();
  return asked!.statement;
}

// ---------------------------------------------------------------------------

describe('the directive is parsed, not just hashed', () => {
  it('reads every section the kernel depends on out of the committed file', async () => {
    const read = await directive();

    // The eight steps, whole. Wrapped continuation lines are joined back on:
    // a line-wise read cut two of them mid-clause and reported success, which
    // is the one failure §27 records as unrecoverable.
    expect(read.corePrinciple.length).toBeGreaterThanOrEqual(8);
    expect(read.corePrinciple).toContain('Identify and understand existing demand.');
    expect(read.corePrinciple.some((one) => one.endsWith('strategic advantage.'))).toBe(true);
    for (const step of read.corePrinciple) {
      expect(step.endsWith(','), `"${step}" was cut at a line break`).toBe(false);
    }

    expect(read.pullStatement).toContain('pull manufacturing forward');
    expect(read.compounding.length).toBeGreaterThanOrEqual(7);
    expect(read.evaluation.map((one) => one.name)).toEqual([
      'DEMAND',
      'ECONOMICS',
      'ENTRY',
      'DISTRIBUTION',
      'STRATEGIC VALUE',
    ]);
    // The one the whole capital dimension exists to serve.
    expect(dimension(read, 'ENTRY')).toContain('required capital');
    expect(read.integrationTests).toContain('strategic capability');
    expect(read.brandConstraint).toContain('ONE master brand');
  });

  it('computes the digest from the bytes it opened, never from a caller', async () => {
    const read = await directive();
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(DEFAULT_DIRECTIVE_PATH, 'utf8');
    expect(read.sha256).toBe(createHash('sha256').update(bytes, 'utf8').digest('hex'));
  });

  it('refuses a path outside blueprints/, and one that climbs', async () => {
    for (const bad of ['docs/CLOUD.md', '../etc/passwd', 'blueprints/../CLAUDE.md', '']) {
      const read = await readDirective(bad);
      expect(read.ok, `${bad} was accepted`).toBe(false);
    }
  });

  it('refuses a file that is not a directive rather than returning half of one', async () => {
    // A real file, in the right directory, with none of the sections. A parse
    // that returned empty lists would produce questions that read almost
    // right, which is the silent half of the defect this module exists for.
    const read = await readDirective('blueprints/Brain_Intelligence_Map.md');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/CORE PRINCIPLE|section/);
  });
});

describe('the directive reaches the assignment a worker is handed', () => {
  /**
   * The load-bearing test of this file.
   *
   * It walks to a real opened round and reads the statement that became the
   * work, so it fails if `questions.ts` stops carrying the brief while the
   * programme row keeps its path and its digest — which is precisely the
   * failure a hash cannot detect.
   */
  it('carries the directive words into the opening question', async () => {
    const read = await directive();
    expect(
      (await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE })).ok,
    ).toBe(true);

    const assignment = await openingAssignment();

    // The directive's own refusal of its own sequencing, verbatim.
    expect(assignment).toContain(read.sequencingRefusal);
    // And its example scales, as seeds rather than as an order.
    for (const band of read.bands) {
      expect(
        assignment.toLowerCase(),
        `the ${band.name} scale is not in the assignment`,
      ).toContain(band.name.toLowerCase());
    }
    // Said in as many words, so a worker cannot read the spread as a ladder.
    expect(assignment).toContain('Do not treat them as an order');
    // And the objective the person wrote, which was always there.
    expect(assignment).toContain(OBJECTIVE);
  }, 60000);

  it('carries the core principle and both market dimensions into the demand question', async () => {
    const read = await directive();
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await runManufacturingKernel(projectId);

    const program = await getProgram(projectId);
    const demand = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'DEMAND',
    );
    expect(demand).toBeTruthy();
    const asked = (await listCandidates({ projectId })).find(
      (one) => one.id === demand!.candidateId,
    );
    expect(asked).toBeTruthy();

    expect(asked!.statement).toContain(corePrincipleBrief(read));
    expect(asked!.statement).toContain(dimension(read, 'DEMAND'));
    expect(asked!.statement).toContain(dimension(read, 'DISTRIBUTION'));
  }, 60000);

  /**
   * A programme that names a directive nobody can read is visible, not silent.
   *
   * The row keeps its path, the assignment says out loud that it went out
   * without the brief, and the surface reports it. The alternative — a
   * question that quietly reads almost right — is the state this whole module
   * exists to make impossible.
   */
  it('says so in the assignment when the directive cannot be read', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    // Point the row at a file that is not there. Done in SQL because no route,
    // service or command can write this column: `startProgramme` refuses to
    // start at all when it cannot read and parse the file, which is what makes
    // this state unreachable through any entrance a person uses.
    await getDb().run('UPDATE manufacturing_programs SET blueprint_path = ? WHERE project_id = ?', [
      'blueprints/does-not-exist.md',
      projectId,
    ]);

    const assignment = await openingAssignment();
    expect(assignment).toContain('The programme directive could not be read');
    expect(assignment).toContain(OBJECTIVE);

    const view = await programmeView(projectId);
    expect(view!.directive.reaching).toBe(false);
    expect(view!.directive.path).toBe('blueprints/does-not-exist.md');
    // And no digest, because nothing was opened to hash.
    expect(view!.directive.sha256).toBeNull();
    expect(view!.directive.why).toMatch(/not readable|not copied|no directive/i);
    expect(view!.directive.bands).toEqual([]);
  }, 60000);

  it('refuses to start a programme whose directive cannot be read', async () => {
    const outcome = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
      directivePath: 'blueprints/not-a-real-file.md',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('could not be read');
      // The reasoning, said to the person who has to fix it.
      expect(outcome.reason).toContain('says nothing about whether one word of it reached');
    }
    // And nothing was written: a refused start leaves no programme behind.
    expect(await getProgram(projectId)).toBeNull();
  });

  it('records the path and the digest the server computed', async () => {
    const read = await directive();
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const program = await getProgram(projectId);
    expect(program!.blueprintPath).toBe(DEFAULT_DIRECTIVE_PATH);
    expect(program!.blueprintSha256).toBe(read.sha256);

    const view = await programmeView(projectId);
    expect(view!.directive.reaching).toBe(true);
    expect(view!.directive.sha256).toBe(read.sha256);
    expect(view!.directive.why).toBeNull();
  });
});

describe('the pyramid is a search prior and never an order', () => {
  /**
   * The bands and the refusal are one string, so there is no call anywhere
   * that could print a ladder.
   *
   * This is the structural half of *nonbinding*: a caller that could take the
   * levels without the sentence saying they are not a sequence is one edit
   * away from encoding the one thing the directive says not to encode.
   */
  it('returns the levels only together with the refusal of sequencing', async () => {
    const read = await directive();
    const spread = searchSpread(read);
    expect(spread).toContain(read.sequencingRefusal);
    for (const band of read.bands) {
      expect(spread.toLowerCase()).toContain(band.name.toLowerCase());
    }
    // Said in words a worker reads, rather than only in a comment.
    expect(spread).toContain('Do not treat them as an order');
    expect(spread).toContain('not to say which scale to start at');
  });

  /**
   * No level reaches a row, a verdict, an ordering or a rank.
   *
   * Read from the *payload* rather than from the source, because the source
   * test in `manufacturingKernel` already refuses a hard-coded category list
   * and this is the complementary question: now that the levels are parsed at
   * runtime, do any of them end up somewhere that decides something?
   */
  it('puts no level into the ladder, the frontier or any verdict', async () => {
    const read = await directive();
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await runManufacturingKernel(projectId);

    const view = await programmeView(projectId);
    expect(view).toBeTruthy();

    // The categories on the ladder came from a person and from gated claims,
    // and not one of them is a band the parser produced.
    const bandNames = read.bands.map((one) => one.name.toLowerCase());
    for (const reading of view!.ladder) {
      for (const part of reading.path) {
        expect(bandNames, `${part} arrived from the directive`).not.toContain(part.toLowerCase());
      }
    }
    // The ranking carries no factor about a level, and no entry mentions one.
    for (const entry of view!.frontier) {
      for (const factor of entry.factors) {
        expect(factor.factor.toLowerCase()).not.toMatch(/level|pyramid|band|tier/);
      }
    }
    // The bands exist on the payload in exactly one place — the directive
    // block — and that place carries the refusal with them.
    expect(view!.directive.bands.length).toBe(read.bands.length);
    expect(view!.directive.sequencingRefusal).toBe(read.sequencingRefusal);
  }, 60000);

  /**
   * Starting from one anchor does not trap discovery inside its own subtree.
   *
   * Every ordinary rule asks about a category already on the ladder, and MAP
   * attaches what it finds *underneath* the category it asked about — so with
   * one seeded anchor and nothing else, the kernel would recurse inside that
   * anchor for ever with every row reading healthy. The opening question names
   * sources rather than categories, so asking it again is the one thing that
   * can reach outside.
   */
  it('re-asks the sources once the ladder is concentrated under one anchor', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    const seeded = await seedCategory({
      projectId,
      name: 'Commercial pressure washers',
      actorRef: userId,
    });
    const categoryId = (seeded as { category: { id: string } }).category.id;
    const program = await getProgram(projectId);

    /*
     * Build the concentrated state through the real rows.
     *
     * Two facts have to hold together, and both are load-bearing: every live
     * category descends from one root, and that root's subtree has actually
     * established something. Without the second this would fire on a ladder
     * that is narrow because nothing has happened yet, where the remedy is to
     * research what is there rather than to look wider.
     */
    await runManufacturingKernel(projectId);
    const opened = (await listManufacturingRounds(program!.id)).find(
      (one) => one.purpose === 'BOOTSTRAP',
    );
    expect(opened).toBeTruthy();
    expect(await closeManufacturingRound({ id: opened!.id, to: 'HARVESTED', found: 1 })).toBe(
      true,
    );

    const filed = await recordCategoryEvidence({
      programId: program!.id,
      categoryId,
      kind: 'DEMAND_EVIDENCE',
      subject: 'UNIT_SHIPMENTS',
      statement: 'The association reported 41,800 units shipped in the year to June.',
      observedOn: '2026-06-30',
      sourceClaimId: await anchorClaim(),
    });
    expect(filed).toBeTruthy();

    // Only the clock is moved by hand, and only backwards: the cool-off is a
    // comparison against `harvested_at`, and waiting one out in real time
    // would make this test take a day.
    await getDb().run(
      `UPDATE manufacturing_rounds SET harvested_at = ? WHERE id = ?`,
      ['2020-01-01T00:00:00.000Z', opened!.id],
    );

    const view = await programmeView(projectId);
    const bootstrapAgain = view!.plan.asks.find((one) => one.purpose === 'BOOTSTRAP');
    const declinedBootstrap = view!.plan.declined.find((one) =>
      one.subject.includes('outside the ladder'),
    );
    // Either it is being asked, or a slot is the only thing stopping it — both
    // mean the escape exists and is reachable. What must never happen is that
    // it is absent from the plan entirely.
    expect(
      bootstrapAgain ?? declinedBootstrap,
      'nothing in the plan reaches outside the anchor',
    ).toBeTruthy();
    const why = (bootstrapAgain ?? declinedBootstrap)!.why;
    expect(typeof why).toBe('string');
    if (bootstrapAgain) {
      expect(bootstrapAgain.why).toContain('Commercial pressure washers');
      expect(bootstrapAgain.why).toContain('no question about this anchor could ever produce');
    }
  }, 60000);
});

describe('every brief this module renders passes the envelope screen', () => {
  /**
   * A planning-time screen refused six correctly-shaped plans in production
   * before a source was read (§33), and the directive is full of imperatives
   * aimed at the company — *"Observe what customers actually purchase"*,
   * *"purchase frequency"* — that read to it as instructions to go and buy
   * something.
   *
   * `directive.ts` quotes each excerpt behind an adjacent governor, which is
   * true as well as convenient. The 40-character governor window makes the
   * spacing load-bearing, so it is **asserted rather than reasoned about**:
   * this runs every rendered brief through the real screen with the real
   * envelope pattern, and fails naming the phrase if the directive's wording
   * ever drifts past it.
   */
  it('reads as description rather than as an instruction to act', async () => {
    const read = await directive();
    const briefs: [string, string][] = [
      ['the core principle', corePrincipleBrief(read)],
      ['the compounding questions', compoundingBrief(read)],
      ['the scale spread', searchSpread(read)],
      ['the integration test', `The directive says: ${read.integrationTests}`],
    ];
    for (const one of read.evaluation) {
      briefs.push([`the ${one.name} dimension`, dimension(read, one.name)!]);
    }

    const envelopes = [
      'RUSSELL_MACHINE_LADDER_V1',
      'RUSSELL_MACHINE_DEMAND_V1',
      'RUSSELL_MACHINE_CAPABILITY_V1',
      'RUSSELL_MACHINE_CAPITAL_V1',
      'RUSSELL_MACHINE_ACQUISITION_V1',
    ];
    for (const id of envelopes) {
      const envelope = APPROVAL_ENVELOPES[id];
      expect(envelope, `${id} is not a registered envelope`).toBeTruthy();
      for (const [name, text] of briefs) {
        const matches = ownActionMatches(text, envelope!.forbiddenActions);
        expect(
          matches.length,
          matches.length === 0
            ? ''
            : `${name} reads as Brain's own action to ${id}: "${matches[0]!.phrase}" in ` +
              `"${matches[0]!.clause}"`,
        ).toBe(0);
      }
    }
  });
});


/**
 * An open round says how far it has actually got.
 *
 * `manufacturing_rounds.state` says a question was asked and not settled. It
 * says nothing about whether a mission launched, whether a worker holds a
 * lease right now, or whether the whole thing stopped days ago — and a round
 * open for three days and one being worked this minute are the same row.
 *
 * §24's `pending.ts` records the cost of leaving that unread: a state written
 * before anything happened stays reassuring however long the wait and whatever
 * goes wrong. The case that matters is the one that must never read as
 * patience.
 */
describe('an open round reports what is actually happening to it', () => {
  it('separates a round nothing has launched from one a worker is on', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    await runManufacturingKernel(projectId);

    const view = await programmeView(projectId);
    expect(view!.open.length).toBeGreaterThan(0);
    // Every open round has a reading, and none of them is missing.
    expect(view!.progress.map((one) => one.roundId).sort()).toEqual(
      view!.open.map((one) => one.id).sort(),
    );

    const opening = view!.progress[0]!;
    // Nothing has launched yet, and it says exactly that rather than "running".
    expect(opening.progress).toBe('NOT_LAUNCHED');
    expect(opening.because).toContain('no mission has launched for it yet');
    expect(opening.items).toEqual({ total: 0, leased: 0, queued: 0, finished: 0 });
  }, 60000);

  it('reports a settled round not at all, because it is not open', async () => {
    await startProgramme({ projectId, ownerUserId: userId, actorUserId: userId, objective: OBJECTIVE });
    await runManufacturingKernel(projectId);
    const program = await getProgram(projectId);
    const opened = (await listManufacturingRounds(program!.id))[0]!;
    await closeManufacturingRound({ id: opened.id, to: 'HARVESTED', found: 0 });

    const view = await programmeView(projectId);
    expect(view!.open).toEqual([]);
    expect(view!.progress).toEqual([]);
    // And the settled round is still on the history, barren and not hidden: a
    // market Brain looked at and found nothing in is a reading of that market.
    const settled = view!.history.find((one) => one.id === opened.id)!;
    expect(settled.barren).toBe(true);
    expect(settled.found).toBe(0);
  }, 60000);
});
