/**
 * The cross-border industrial dealflow kernel: both sides of a transaction,
 * and everything hard that lives between them.
 *
 * ---------------------------------------------------------------------------
 * What this pins, and why each one is a property rather than an example
 * ---------------------------------------------------------------------------
 *
 * **The map holds no list of equipment.** The seed is an example of a pattern,
 * not the taxonomy, so the first assertion reads the repository — the same
 * thing `operatorConsoleRemoved` does, for the same reason: what must not
 * exist is not something a behavioural test can see.
 *
 * **A finding is declared, never read out of prose.** The same repair
 * `opportunity_signal` and `structural_finding` already made, one axis along,
 * so the tests that matter are the **refusals** rather than the acceptances.
 *
 * **The five compliance layers do not collapse, and an absence of rows is not
 * a clearance.** This is the one place in the kernel where being confidently
 * wrong means equipment gets built for a market it cannot enter, so both
 * halves are pinned: a layer nobody researched reads NOT_ESTABLISHED, and only
 * a documented search reads NONE_REQUIRED.
 *
 * **A total past an unknown is withheld.** A landed cost missing its duty line
 * is wrong in the direction that makes a deal look worth doing, which is the
 * shape of error nobody checks.
 *
 * **Transaction value is not our capital.** §13's whole distinction, and the
 * view is asserted to report no revenue figure at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate, setLifecycle, launchableUnderCashMode } from '../server/services/cash/lifecycle.ts';
import {
  listCosts,
  listDealRounds,
  listDeals,
  listParties,
  listRequirements,
  listStructureEvidence,
  linkOpportunity,
  recordObservation,
} from '../server/repos/dealflow.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { validateDealFinding, equipmentKey } from '../server/domain/dealflow.ts';
import { envelopeFor, layerReading, nextLayerToResearch } from '../server/services/dealflow/compliance.ts';
import { landedEconomics } from '../server/services/dealflow/economics.ts';
import { commercialPath, structureOptions, STRUCTURE_PROFILE } from '../server/services/dealflow/structures.ts';
import { lessonsFrom, PATTERN_FLOOR } from '../server/services/dealflow/lessons.ts';
import { dealflowSnapshot } from '../server/services/dealflow/graph.ts';
import { runDealflowKernel, planFrom, readAll } from '../server/services/dealflow/kernel.ts';
import { seedParty, observe } from '../server/services/dealflow/seed.ts';
import { dealflowView } from '../server/services/dealflow/view.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { recordFurtherAction } from '../server/services/cash/actions.ts';
import { COMMERCIAL_STRUCTURES, COMPLIANCE_LAYERS, DEAL_STAGES } from '../server/domain/types.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import type { DealFinding, DealRequirement, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `deal-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
}

interface DeclaredClaim {
  claim: string;
  finding: DealFinding;
  subject: string;
  equipment?: string | null;
  jurisdiction?: string | null;
  value?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  publisher?: string;
  date?: string;
  accepted?: boolean;
}

/**
 * A finished mission for one kernel round, carrying declared findings.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the filing reads: a fixture that handed it findings
 * directly would pass against a filing that read prose.
 */
async function answeredRound(input: {
  candidateId: string;
  claims: DeclaredClaim[];
}): Promise<{ orchestrationId: string; missionId: string }> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a dealflow round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a dealflow round',
    assignment: 'who is on each side, and what the transaction involves',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the markets the sprint may look at',
      requiredEvidence: [
        { id: 'buyer_need', description: 'who needs it', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['an organisation’s own website'],
      excludedSourceTypes: ['an organisation named as a likely buyer'],
      completionCriteria: ['every organisation declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'dealflow-parties',
      question: 'Who is on each side?',
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

  const inserted = await insertClaims(
    input.claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: 'https://example.test/source',
      sourceTitle: 'A published source',
      sourcePublisher: one.publisher ?? 'A ministry of transport',
      sourceDate: one.date ?? '2026-08-01',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the page body',
      evidenceLane: 'buyer_need',
      dealFinding: one.finding,
      dealSubject: one.subject,
      dealEquipment: one.equipment ?? null,
      dealJurisdiction: one.jurisdiction ?? null,
      dealValue: one.value ?? null,
      dealAmountCents: one.amountCents ?? null,
      dealCurrency: one.currency ?? null,
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}|${one.value ?? ''}`,
    })),
  );
  for (const [index, claim] of inserted.entries()) {
    await decideClaim(claim.id, { accepted: input.claims[index]!.accepted ?? true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a dealflow round',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  return { orchestrationId: orchestration.id, missionId: mission.id };
}

/**
 * The same round, finished.
 *
 * Split from `answeredRound` because the *gap* between a round's claims being
 * gated and its mission reaching DONE is the arrangement one test needs and
 * every other one does not care about — and it is exactly where a `found`
 * counted from creations rather than from what the round established goes
 * wrong.
 */
async function finishedRound(input: {
  candidateId: string;
  claims: DeclaredClaim[];
}): Promise<string> {
  const { orchestrationId, missionId } = await answeredRound(input);
  await transitionMission({ missionId, from: 'RUNNING', to: 'DONE' });
  return orchestrationId;
}

/** The candidate a round of this purpose is asking, if one is open. */
async function candidateFor(purpose: string): Promise<string | null> {
  const rounds = await listDealRounds(projectId);
  const round = rounds.find((one) => one.purpose === purpose && one.state === 'OPEN');
  return round?.candidateId ?? null;
}

function requirement(input: {
  layer: (typeof COMPLIANCE_LAYERS)[number];
  posture: DealRequirement['posture'];
  destination?: string;
  equipmentClass?: string;
}): DealRequirement {
  const equipmentClass = input.equipmentClass ?? 'fuel tank trailers';
  return {
    id: `drq_${Math.random().toString(36).slice(2, 10)}`,
    projectId,
    destination: input.destination ?? 'Zambia',
    equipmentClass,
    equipmentKey: equipmentKey(equipmentClass),
    layer: input.layer,
    posture: input.posture,
    statement: 'something the market demands',
    authority: 'a ministry',
    effectiveDate: '2026-01-01',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe('the seed is an example, not the taxonomy', () => {
  /**
   * The assertion the whole kernel rests on, and it reads the repository
   * rather than behaviour.
   *
   * The operator's brief is explicit: tankers are the first example from which
   * the kernel should learn the broader structure, and do not hard-code them
   * as the business. A list of equipment classes anywhere in the kernel would
   * answer the question the kernel exists to ask, and would be wrong about
   * every class the trade has taken up since somebody typed it.
   *
   * The rule is that **no code** names a class — not that the word may never
   * appear. Comments in this repository carry concrete examples on purpose,
   * and the seed *question* names tankers deliberately, because a question
   * that gave no example would not describe the pattern the operator actually
   * has. So the check strips comments and reads what is left: a constant, a
   * string literal, a comparison or a branch on any of these words fails, and
   * a sentence explaining why the layers matter does not.
   *
   * That is a narrowing rather than a removed check — §27's rule that a
   * tolerance matching everything is not a tolerance. What it still catches is
   * exactly the thing that must not exist: executable code that knows what a
   * tanker is.
   */
  it('holds no list of equipment classes anywhere in the kernel', () => {
    const suspects = [
      'server/services/dealflow/allocate.ts',
      'server/services/dealflow/compliance.ts',
      'server/services/dealflow/economics.ts',
      'server/services/dealflow/expand.ts',
      'server/services/dealflow/graph.ts',
      'server/services/dealflow/kernel.ts',
      'server/services/dealflow/maturity.ts',
      'server/services/dealflow/promote.ts',
      'server/services/dealflow/structures.ts',
      'server/services/dealflow/view.ts',
      'server/repos/dealflow.ts',
      'server/domain/dealflow.ts',
    ];
    /*
     * Words that would mean a class had been hard-coded. Matched
     * case-insensitively across the whole file, so a constant, a comparison or
     * a branch on any of them fails.
     */
    const classes = [
      'tanker',
      'trailer',
      'flatbed',
      'lowboy',
      'excavator',
      'bulldozer',
      'crusher',
      'conveyor',
      'generator',
    ];
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    for (const path of suspects) {
      const code = stripComments(
        readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
      ).toLowerCase();
      for (const word of classes) {
        expect(`${path}:${word}:${code.includes(word)}`).toBe(`${path}:${word}:false`);
      }
    }
  });
});

/**
 * The backstop that exists is the one that has to run where production runs.
 *
 * `deal_amount_cents` is refused negative by `validateDealFinding` at both
 * doors, and the column carries `CHECK (… >= 0)` as the backstop behind them.
 * The SQLite chain had it and the Postgres chain did not — so the one guard
 * that would have caught a path around the validators was absent on the
 * backend the deployed Brain actually runs. §3's rule that a schema change is
 * not done until both chains have it, at a constraint rather than a column,
 * and the drift was invisible to every SQLite run.
 *
 * Driven against the database rather than read out of the migration text,
 * because a test that greps a `.sql` file passes whenever the string is
 * present and says nothing about whether the constraint is installed.
 */
/**
 * An operator report is read *beside* a running app, and both halves of that
 * sentence are requirements on the script rather than on the reader.
 *
 * The dealflow kernel's only production reading is `cash-report.sh`, and on
 * 2026-09-21 it printed the whole sprint and then died on its last query —
 * `SELECT * FROM deal_observations` — with
 * `EMAXCONNSESSION ... pool_size: 15`. The Supabase pooler has a shared
 * fifteen-client limit, the app holds clients while it works, and this script
 * carried no pool setting at all, so it took the adapter's default of ten. A
 * reading nobody can take while the thing it reads is working is not a
 * reading, which is the defect this repository keeps correcting at columns and
 * at state machines and had not yet corrected at a shell script.
 *
 * `labor-report.sh` already carried both lines and its comments already gave
 * both reasons. That is what makes this a **rule** rather than one fix: a rule
 * one of five readers obeys is worse than none, because the next report is
 * written by copying whichever one the author opened.
 *
 * Read out of the repository rather than driven, for
 * `operatorConsoleRemoved`'s reason: what must be true of every file of a kind
 * is not something a behavioural test can see.
 */
/**
 * Every line of the operator surface resolves to a row.
 *
 * The production reading printed a live question and a market's verdict and
 * neither could be looked up: a question with no round id is a sentence, and
 * "five unresearched" says how many are missing without saying *which* — which
 * is the one thing the five layers not collapsing exists to tell you, since
 * they have different remedies.
 */
describe('the operator surface names the rows it is reading', () => {
  it('gives every live question its round id and the idea it is', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidate = await candidateFor('SEED_EQUIPMENT');
    expect(candidate).not.toBe(null);

    const view = await dealflowView(projectId);
    expect(view.live.length).toBeGreaterThan(0);
    for (const question of view.live) {
      expect(question.id).toMatch(/^drd_/);
      expect(question.candidateId).toBe(candidate);
    }
  });

  it('names all five layers with their own readings, not a count of the missing ones', async () => {
    await activated();
    await runDealflowKernel(projectId);
    await finishedRound({
      candidateId: (await candidateFor('SEED_EQUIPMENT'))!,
      claims: [
        {
          claim: 'A mine in Zambia published a need for fuel tank trailers.',
          finding: 'BUYER_NEED',
          subject: 'A Zambian mining operator',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
        },
      ],
    });
    await runDealflowKernel(projectId);

    const view = await dealflowView(projectId);
    const market = view.markets.find((one) => one.destination === 'Zambia');
    expect(market).toBeDefined();
    const envelope = market!.envelopes[0]!;
    // Every one of the five, each with its own reading — and the unresearched
    // ones say NOT_ESTABLISHED rather than being absent, because an absence of
    // rows reading as a clearance is what this whole envelope exists to refuse.
    expect(envelope.layers.map((one) => one.layer)).toEqual([...COMPLIANCE_LAYERS]);
    expect(envelope.layers.every((one) => one.reading === 'NOT_ESTABLISHED')).toBe(true);
    expect(envelope.unestablished).toBe(COMPLIANCE_LAYERS.length);
  });
});

describe('a report read beside a running app', () => {
  const reports = readdirSync('scripts')
    .filter((name) => name.endsWith('-report.sh'))
    .sort();

  it('has reports to check at all, so an empty glob cannot pass silently', () => {
    expect(reports.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of reports) {
    it(`${name} takes the smallest footprint it can on a shared pooler limit`, () => {
      const body = readFileSync(`scripts/${name}`, 'utf8');
      expect(body).toMatch(/export BRAIN_DATABASE_POOL_SIZE=/);
    });

    it(`${name} says which container it came out of`, () => {
      const body = readFileSync(`scripts/${name}`, 'utf8');
      // The deployment system's label is a claim about what it asked for. This
      // is a reading of what is actually serving.
      expect(body).toMatch(/SERVING_REVISION \$\{BRAIN_REVISION/);
    });

    /*
     * And a report with no door is a reading nobody can take.
     *
     * The two rules above are about a script that runs. This one is about
     * whether anything can run it: the rows that matter are the deployed
     * Brain's, `npm run report:*` needs a checkout and a database, and a
     * script committed without a workflow is reachable only from a machine
     * nobody has. §45's sentence — *a reading nobody can take is not a
     * reading* — asked of the door rather than of the connection count.
     *
     * Found by shipping one. `puzzle-report.sh` was correct, carried both
     * lines above, and had no workflow at all; the whole suite passed, because
     * every rule that existed was about the file rather than about reaching
     * it.
     */
    it(`${name} is reachable from a workflow, which checks it finished`, () => {
      const callers = readdirSync('.github/workflows')
        .filter((file) => file.endsWith('.yml'))
        .map((file) => ({ file, body: readFileSync(`.github/workflows/${file}`, 'utf8') }))
        .filter((one) => one.body.includes(`scripts/${name}`));

      expect(callers.map((one) => one.file).length).toBeGreaterThan(0);

      /*
       * And every one of them verifies the terminal marker, because
       * `flyctl ssh console` exits 0 whether the script finished or a restart
       * cut the session off part way — so without the check, a truncated
       * report and a complete one are the same green tick.
       */
      const marker = `${name.replace(/\.sh$/, '').toUpperCase()}: OK`;
      for (const caller of callers) {
        expect(caller.body).toContain(marker);
      }

      // And the script it calls actually prints what they look for.
      const printer = readFileSync(`scripts/${name.replace(/\.sh$/, '.ts')}`, 'utf8');
      expect(printer).toContain(marker);
    });
  }
});

/**
 * The same rule one file along, and the one place it was measured twice.
 *
 * `manufacturing.sh` is not a `*-report.sh`, so the rule above never reached
 * it — and it is the script an operator runs to ask the kernel what it would
 * do next, which is exactly the command somebody reaches for while production
 * is busy. On 2026-09-21 the identical `show` was run through two doors within
 * one minute of each other, against one image: through `closeout-report.yml`,
 * which sets `BRAIN_DATABASE_POOL_SIZE=1` at the call site, it printed the
 * whole ladder; through `manufacturing.yml`, which set nothing, it took the
 * adapter's default of ten against a shared fifteen-client pooler and died
 * with `(EMAXCONNSESSION) ... limited to pool_size: 15` on
 * `SELECT * FROM manufacturing_rounds`.
 *
 * Both halves are asserted, because they answer different failures: the script
 * carries the rule for a terminal and for every future door, and the workflow
 * carries it for an image whose copy of the script predates the line — which
 * is the case an operator command exists for, since the app that needs driving
 * is the one already running.
 *
 * **An earlier version of this ended by declining to widen it.** Fourteen of
 * the seventeen scripts under `scripts/` carried no pool setting at all, and
 * the argument was that widening the guard would refuse those files rather
 * than fix them, and that each belongs to the workstream that owns it. The
 * first half is true of widening the guard *alone*; the second is the "it is
 * somebody else's" that this repository has been burned by often enough to
 * have a sentence for. So the files were fixed and the guard widened with
 * them, in the describe below.
 */
describe('the manufacturing operator surface is readable beside a running app', () => {
  it('takes one pooler client from the script, so a terminal and every door inherit it', () => {
    const body = readFileSync('scripts/manufacturing.sh', 'utf8');
    expect(body).toMatch(/export BRAIN_DATABASE_POOL_SIZE="\$\{BRAIN_DATABASE_POOL_SIZE:-1\}"/);
  });

  it('asks for it at the call site too, so the fix does not wait for a deploy', () => {
    const body = readFileSync('.github/workflows/manufacturing.yml', 'utf8');
    // The setting has to reach the command rather than merely appear in the
    // file: a comment naming the variable would satisfy a bare substring.
    expect(body).toMatch(/-C "env BRAIN_DATABASE_POOL_SIZE=1 \$remote"/);
  });
});

/**
 * And the same rule over **every** operator wrapper, rather than over the ones
 * whose filename happens to end in `-report.sh`.
 *
 * A rule one of seventeen readers obeys is not a rule, and the shape of the
 * failure is settled: the reading dies with `EMAXCONNSESSION` at whichever
 * statement happened to be running, which is to say exactly when somebody
 * wants it. Measured twice — `cash-report.sh` on the dealflow kernel's only
 * production reading, and `manufacturing show` through two doors within one
 * minute against one image.
 *
 * One client is safe for all of them because every script here is
 * **sequential**: none of `admin`, `fleet`, `step10`, `capability`, `design`,
 * `closeout-verify`, `chain-watch`, `authorize-gap-policy`,
 * `verify-research-capability` or `manufacturing` fans out over the database,
 * and a statement inside a transaction goes to that transaction's own pinned
 * client rather than back to the pool (§34). The default form leaves a caller
 * that genuinely needs more able to say so.
 *
 * **`verify-hosted.sh` is the one exception and it is a declared one.** That
 * harness really does fan out — §27 records 383 callers queued behind it — and
 * `verify-hosted.ts` sets its own ceiling of 2 in-process with the reasoning
 * written beside it. A wrapper default would win over that line and silence a
 * deliberate decision, so it is named here rather than pattern-matched, and a
 * second exception is a visible edit to this file.
 */
describe('every operator wrapper is readable beside a running app', () => {
  const EXEMPT = new Set(['verify-hosted.sh']);
  const wrappers = readdirSync('scripts')
    .filter((name) => name.endsWith('.sh'))
    .sort();

  it('has wrappers to check at all, so an empty glob cannot pass silently', () => {
    expect(wrappers.length).toBeGreaterThanOrEqual(15);
  });

  it('gives every one of them a pooler ceiling, bar the one that declares its own', () => {
    const missing = wrappers
      .filter((name) => !EXEMPT.has(name))
      .filter((name) => !/BRAIN_DATABASE_POOL_SIZE/.test(readFileSync(`scripts/${name}`, 'utf8')));
    expect(missing).toEqual([]);
  });

  it('and that ceiling is one, because every one of them is sequential', () => {
    // Presence alone let `factory.sh` default to two for weeks beside a rule
    // saying one, and on 2026-09-23 its reads failed four times running on a
    // pooler timeout while the one-client goals read beside it succeeded.
    const wrongCeiling = wrappers
      .filter((name) => !EXEMPT.has(name))
      .filter(
        (name) =>
          !readFileSync(`scripts/${name}`, 'utf8').includes(
            'export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"',
          ),
      );
    expect(wrongCeiling).toEqual([]);
  });

  it('leaves the harness that fans out to set its own, in its own file', () => {
    // Asserted as an absence *and* as a presence: the exemption is only honest
    // while the thing it exempts really does declare a ceiling somewhere.
    expect(readFileSync('scripts/verify-hosted.sh', 'utf8')).not.toContain(
      'BRAIN_DATABASE_POOL_SIZE',
    );
    expect(readFileSync('scripts/verify-hosted.ts', 'utf8')).toContain(
      "process.env['BRAIN_DATABASE_POOL_SIZE'] = '2'",
    );
  });
});

describe('a figure that cannot be negative is refused by both backends', () => {
  it('refuses a negative deal_amount_cents at the column, on whichever backend is running', async () => {
    const run = await createRun({
      projectId,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'a cost line',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title: 'a cost line',
      assignment: 'what a line of the landed cost is',
      provider: 'WORKER',
      autoApprove: false,
    });
    const [claim] = await insertClaims([
      {
        orchestrationId: orchestration.id,
        fragmentId: null,
        passId: null,
        passKey: 'BROAD_SCAN' as const,
        claim: 'The published import duty on fuel tank trailers into Zambia is 25 per cent.',
        sourceUrl: 'https://example.test/tariff',
        sourceTitle: 'The tariff schedule',
        sourcePublisher: 'A revenue authority',
        sourceDate: '2026-08-01',
        evidenceExcerpt: 'the duty line',
        evidenceLocator: 'the page body',
        evidenceLane: 'official_source',
        dealFinding: 'COST_COMPONENT' as const,
        dealSubject: 'import duty on fuel tank trailers',
        dealEquipment: 'fuel tank trailers',
        dealJurisdiction: 'Zambia',
        dealValue: 'IMPORT_DUTY',
        dealAmountCents: 5_700_00,
        dealCurrency: 'USD',
        retrievedAt: '2026-09-12',
        confidence: 0.8,
        validationState: 'SOURCED' as const,
        validationDetail: null,
        sourced: true,
        claimType: 'SOURCED_FACT' as const,
        contentHash: 'duty|zambia|IMPORT_DUTY',
      },
    ]);

    await expect(
      getDb().run('UPDATE research_claims SET deal_amount_cents = ? WHERE id = ?', [
        -1,
        claim!.id,
      ]),
    ).rejects.toThrow();

    // And the figure it was given is exactly what came back, so the refusal
    // above is the constraint rather than a write that silently did nothing.
    const after = await getDb().get<{ deal_amount_cents: number }>(
      'SELECT deal_amount_cents FROM research_claims WHERE id = ?',
      [claim!.id],
    );
    expect(Number(after!.deal_amount_cents)).toBe(5_700_00);
  });
});

describe('a finding is declared, never read out of prose', () => {
  it('refuses a finding outside the closed set', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'BUYER_INTEREST',
      subject: 'A mine',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: null,
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a party finding that names no equipment class', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'BUYER_NEED',
      subject: 'A mine',
      equipmentClass: null,
      jurisdiction: 'Zambia',
      value: null,
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('deal_equipment');
  });

  it('refuses a requirement that names no market', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'COMPLIANCE_REQUIREMENT',
      subject: 'Type approval',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: null,
      value: 'MARKET_APPROVAL',
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('deal_jurisdiction');
  });

  it('refuses a requirement whose layer is not one of the five', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'COMPLIANCE_REQUIREMENT',
      subject: 'Type approval',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: 'SAFETY',
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(false);
  });

  /**
   * §14's rule, enforced at the door rather than at absorb time.
   *
   * A claim that something does not exist is established by a documented
   * search of the places it would be, or not at all — and this is the one
   * finding in the kernel that asserts an absence. Refusing it here means the
   * worker is told while it still has the attempt to spend.
   */
  it('refuses a documented absence that does not say where it looked', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'REQUIREMENT_ABSENCE',
      subject: 'no factory certification demanded',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: 'FACTORY_CERTIFICATION',
      amountCents: null,
      currency: null,
      searchedRepositories: [],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('searched_repositories');
  });

  it('accepts a documented absence that names where it looked', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'REQUIREMENT_ABSENCE',
      subject: 'no factory certification demanded',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: 'FACTORY_CERTIFICATION',
      amountCents: null,
      currency: null,
      searchedRepositories: ['the standards bureau register', 'the transport authority rules'],
    });
    expect(result.ok).toBe(true);
  });

  /**
   * A cost line with no figure could only ever make the landed cost look
   * complete while contributing nothing to it — the opposite of
   * `structural_amount_cents`, where a blank is a real finding.
   */
  it('refuses a cost component with no figure, and one with no currency', () => {
    const noFigure = validateDealFinding({
      where: 'claims[0]',
      finding: 'COST_COMPONENT',
      subject: 'per unit',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: 'IMPORT_DUTY',
      amountCents: null,
      currency: 'USD',
    });
    expect(noFigure.ok).toBe(false);

    const noCurrency = validateDealFinding({
      where: 'claims[0]',
      finding: 'COST_COMPONENT',
      subject: 'per unit',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: 'IMPORT_DUTY',
      amountCents: 1_000_00,
      currency: null,
    });
    expect(noCurrency.ok).toBe(false);
    expect(noCurrency.ok === false && noCurrency.error).toContain('deal_currency');
  });

  it('refuses a figure on a finding that carries none', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: 'BUYER_NEED',
      subject: 'A mine',
      equipmentClass: 'fuel tank trailers',
      jurisdiction: 'Zambia',
      value: null,
      amountCents: 500_00,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a companion field with no finding at all', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: null,
      subject: 'A mine',
      equipmentClass: null,
      jurisdiction: null,
      value: null,
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a claim that declares nothing, which is most claims', () => {
    const result = validateDealFinding({
      where: 'claims[0]',
      finding: null,
      subject: null,
      equipmentClass: null,
      jurisdiction: null,
      value: null,
      amountCents: null,
      currency: null,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.finding).toBe(null);
  });

  /**
   * One rule, two doors. A second copy of it is how the MCP tool and the
   * provider path come to disagree about what a valid declaration is, which
   * this repository has had to record five times.
   */
  it('is the same validator on both submission doors', () => {
    const mcp = readFileSync(new URL('../server/mcp/researchTools.ts', import.meta.url), 'utf8');
    const provider = readFileSync(
      new URL('../server/services/research/schema.ts', import.meta.url),
      'utf8',
    );
    expect(mcp).toContain('validateDealFinding(');
    expect(provider).toContain('validateDealFinding(');
  });

  /**
   * §33's defect, which cost production every opportunity it could have
   * created: a field named in a tool's prose and left out of its schema is a
   * field `additionalProperties: false` makes unfillable, and the failure
   * reads exactly like a worker honestly finding nothing.
   */
  it('declares every dealflow field in the tool schema rather than only describing it', () => {
    const mcp = readFileSync(new URL('../server/mcp/researchTools.ts', import.meta.url), 'utf8');
    for (const field of [
      'deal_finding',
      'deal_subject',
      'deal_equipment',
      'deal_jurisdiction',
      'deal_value',
      'deal_amount_cents',
      'deal_currency',
    ]) {
      expect(`${field}:${mcp.includes(`${field}: {`)}`).toBe(`${field}:true`);
    }
  });
});

describe('the compliance layers do not collapse', () => {
  /**
   * The single most expensive mistake available in this trade, pinned.
   *
   * No rows is not no requirements. A layer nobody has researched and a layer
   * somebody searched and found empty are opposite facts with opposite
   * consequences, and the absence of rows says only the first.
   */
  it('reads a layer with no rows as unresearched rather than clear', () => {
    const view = layerReading('MARKET_APPROVAL', []);
    expect(view.reading).toBe('NOT_ESTABLISHED');
    expect(view.remedy).not.toBe(null);
  });

  it('reads a documented absence as an answer, and only a documented one', () => {
    const view = layerReading('FACTORY_CERTIFICATION', [
      requirement({ layer: 'FACTORY_CERTIFICATION', posture: 'NONE_FOUND' }),
    ]);
    expect(view.reading).toBe('NONE_REQUIRED');
    expect(view.remedy).toBe(null);
  });

  /**
   * ISO 9001 at a factory does not make a trailer registrable. The whole point
   * of keeping the layers apart is that one layer's answer never satisfies
   * another's.
   */
  it('does not let one layer answer another', () => {
    const rows = [
      requirement({ layer: 'FACTORY_CERTIFICATION', posture: 'NONE_FOUND' }),
      requirement({ layer: 'PRODUCT_CERTIFICATION', posture: 'REQUIRED' }),
    ];
    const envelope = envelopeFor({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      requirements: rows,
    });
    expect(envelope.verdict).toBe('INCOMPLETE');
    expect(envelope.unestablished).toContain('MARKET_APPROVAL');
    expect(envelope.unestablished).toContain('BUYER_ACCEPTANCE');
    expect(envelope.unestablished).toContain('IMPORT_BARRIER');
  });

  it('is blocked by a prohibition whatever else is answered', () => {
    const rows = COMPLIANCE_LAYERS.map((one) =>
      requirement({ layer: one, posture: one === 'IMPORT_BARRIER' ? 'PROHIBITED' : 'NONE_FOUND' }),
    );
    const envelope = envelopeFor({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      requirements: rows,
    });
    expect(envelope.verdict).toBe('BLOCKED');
    expect(nextLayerToResearch(envelope)).toBe(null);
  });

  it('is established only once every one of the five is answered', () => {
    const rows = COMPLIANCE_LAYERS.map((one) =>
      requirement({ layer: one, posture: 'NONE_FOUND' }),
    );
    const envelope = envelopeFor({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      requirements: rows,
    });
    expect(envelope.verdict).toBe('ESTABLISHED');
    expect(envelope.unestablished).toEqual([]);
  });

  /**
   * A requirement is about (class, destination). The same approval applies to
   * every unit of that class entering that market, so binding it to one deal
   * would make Brain research it again for the next — §13's waste at the most
   * expensive question in the trade. The other half of that is that a
   * requirement for *another* market must not answer this one.
   */
  it('does not carry a requirement across markets', () => {
    const envelope = envelopeFor({
      equipmentClass: 'fuel tank trailers',
      destination: 'Kenya',
      requirements: COMPLIANCE_LAYERS.map((one) =>
        requirement({ layer: one, posture: 'NONE_FOUND', destination: 'Zambia' }),
      ),
    });
    expect(envelope.verdict).toBe('INCOMPLETE');
    expect(envelope.unestablished.length).toBe(COMPLIANCE_LAYERS.length);
  });
});

describe('a total past an unknown is withheld', () => {
  const cost = (
    component: string,
    amountCents: number,
    extra: { currency?: string; basis?: string; destination?: string | null } = {},
  ) => ({
    id: `dcs_${Math.random().toString(36).slice(2, 10)}`,
    projectId,
    equipmentClass: 'fuel tank trailers',
    equipmentKey: equipmentKey('fuel tank trailers'),
    originCountry: null,
    destination: extra.destination === undefined ? 'Zambia' : extra.destination,
    component: component as never,
    amountCents,
    currency: extra.currency ?? 'USD',
    basis: extra.basis ?? 'one unit',
    sourceClaimId: `clm_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const allFive = () => [
    cost('FACTORY_PRICE', 30_000_00),
    cost('OCEAN_FREIGHT', 4_000_00),
    cost('IMPORT_DUTY', 5_700_00),
    cost('CUSTOMS_CLEARANCE', 800_00),
    cost('INLAND_DESTINATION', 1_200_00),
  ];

  it('withholds the landed cost when a load-bearing line is missing', () => {
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: allFive().filter((one) => one.component !== ('IMPORT_DUTY' as never)),
    });
    expect(reading.landedCents).toBe(null);
    expect(reading.withheld).toContain('MISSING_LOAD_BEARING');
    expect(reading.missing).toContain('IMPORT_DUTY');
  });

  /**
   * A published zero is a figure, and reading it as an absence is the unknown
   * taken as the *unfavourable* assumption — which is the rarer direction and
   * no less wrong. A duty-free tariff line is exactly the fact that makes one
   * of these deals work, and it is published as zero rather than as silence.
   * `missing` was a truthiness test, so a zero duty read as *nobody has looked
   * at the duty* and the landed cost was withheld with every line established.
   */
  it('treats a published zero as a figure rather than as a line nobody found', () => {
    const rows = allFive();
    rows[2] = cost('IMPORT_DUTY', 0);
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: rows,
    });
    expect(reading.missing).not.toContain('IMPORT_DUTY');
    expect(reading.withheld).toEqual([]);
    expect(reading.landedCents).toBe(36_000_00);
  });

  it('sums it when every load-bearing line has a figure on one basis', () => {
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: allFive(),
    });
    expect(reading.landedCents).toBe(41_700_00);
    expect(reading.withheld).toEqual([]);
  });

  /**
   * Converting between currencies would put a rate nobody published inside a
   * number presented as published arithmetic.
   */
  it('withholds it when the figures are in two currencies', () => {
    const rows = allFive();
    rows[1] = cost('OCEAN_FREIGHT', 3_600_00, { currency: 'EUR' });
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: rows,
    });
    expect(reading.landedCents).toBe(null);
    expect(reading.withheld).toContain('MIXED_CURRENCY');
  });

  /**
   * Reconciling a per-container rate with a per-unit price needs a load plan
   * Brain does not have, and assuming one would be inventing it.
   */
  it('withholds it when the figures are on two bases', () => {
    const rows = allFive();
    rows[1] = cost('OCEAN_FREIGHT', 4_000_00, { basis: 'one 40ft container' });
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: rows,
    });
    expect(reading.landedCents).toBe(null);
    expect(reading.withheld).toContain('MIXED_BASIS');
  });

  /**
   * The saving is the most persuasive number in the deal, so it is the one
   * most worth refusing to invent.
   */
  it('withholds the saving when the buyer alternative is unknown', () => {
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: allFive(),
    });
    expect(reading.landedCents).not.toBe(null);
    expect(reading.buyerAlternativeCents).toBe(null);
    expect(reading.savingCents).toBe(null);
  });

  it('states the saving only when both halves are comparable figures', () => {
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Zambia',
      costs: [...allFive(), cost('BUYER_ALTERNATIVE', 52_000_00)],
    });
    expect(reading.savingCents).toBe(10_300_00);
  });

  /**
   * A factory price has no destination, so a row with none applies to every
   * lane out of that class — which is what the nullable column is for.
   */
  it('reads a figure with no destination against every lane', () => {
    const reading = landedEconomics({
      equipmentClass: 'fuel tank trailers',
      destination: 'Kenya',
      costs: [
        cost('FACTORY_PRICE', 30_000_00, { destination: null }),
        cost('OCEAN_FREIGHT', 4_000_00, { destination: 'Kenya' }),
        cost('IMPORT_DUTY', 5_700_00, { destination: 'Kenya' }),
        cost('CUSTOMS_CLEARANCE', 800_00, { destination: 'Kenya' }),
        cost('INLAND_DESTINATION', 1_200_00, { destination: 'Kenya' }),
      ],
    });
    expect(reading.landedCents).toBe(41_700_00);
  });
});

describe('a stage is read from a row, or it is not reported', () => {
  /**
   * The branch that could never fire, pinned so it cannot come back.
   *
   * The first version of `ACTION_STAGE` keyed on `SEND_QUOTE`,
   * `NEGOTIATE_TERMS` and `SIGN_AGREEMENT` — plausible names for things this
   * trade does, and not actions any commercial grant can authorize, so not one
   * of them could ever have been recorded. Keying it on the real vocabulary is
   * the fix; asserting the keys *are* that vocabulary is what stops the next
   * plausible-sounding name being added.
   */
  it('keys every action-derived stage on an action a grant can actually authorize', () => {
    const source = readFileSync(
      new URL('../server/services/dealflow/maturity.ts', import.meta.url),
      'utf8',
    );
    const entries = [...source.matchAll(/\{ action: '([A-Z_]+)', stage: '([A-Z_]+)' \}/g)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, action] of entries) {
      expect(`${action}:${(COMMERCIAL_ACTIONS as readonly string[]).includes(action!)}`).toBe(
        `${action}:true`,
      );
    }
  });

  /**
   * `NEGOTIATING` is a real stage of this trade, the brief names it, and Brain
   * holds no row that establishes it — there is no commercial action for
   * negotiating. So it stays in the vocabulary and is never derived, and
   * inferring it from a quote having gone out would be a status more precise
   * than the evidence.
   */
  it('never derives a stage no row can establish', () => {
    const source = readFileSync(
      new URL('../server/services/dealflow/maturity.ts', import.meta.url),
      'utf8',
    );
    const derived = [...source.matchAll(/stage: '([A-Z_]+)'/g)].map((one) => one[1]);
    expect(derived).not.toContain('NEGOTIATING');
    // And it is still a stage, so a reader can see it is a gap in what Brain
    // can observe rather than one somebody forgot.
    expect(DEAL_STAGES).toContain('NEGOTIATING');
  });

  /**
   * `readFurtherAction` (server/services/cash/actions.ts) is what lets a
   * QUOTE_AND_INVOICE be recorded on a piece already EXECUTING, and this
   * proves the stage that action feeds actually reads the row it produced —
   * over a real deal, its opportunity and the actions on it, rather than the
   * source-text properties above.
   */
  it('reads a deal as QUOTING once its opportunity records QUOTE_AND_INVOICE', async () => {
    await activated();
    await runDealflowKernel(projectId);
    await finishedRound({
      candidateId: (await candidateFor('SEED_EQUIPMENT'))!,
      claims: [
        {
          claim: 'A published fleet expansion.',
          finding: 'BUYER_NEED',
          subject: 'Kabwe Mining',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
        },
        {
          claim: 'A published export capability.',
          finding: 'SUPPLIER_CAPABILITY',
          subject: 'Shandong Heavy Vehicles',
          equipment: 'fuel tank trailers',
          jurisdiction: 'China',
        },
      ],
    });
    await runDealflowKernel(projectId);
    const deals = await listDeals(projectId);
    expect(deals.length).toBe(1);
    const deal = deals[0]!;

    // A qualified opportunity, built and linked to the deal exactly as
    // `promoteReadyDeals` would, without waiting for the deal to reach
    // OUTREACH_READY on its own — the thing under test is whether the stage
    // reads the recorded actions, not how the deal got its opportunity.
    const mode = await getCashMode(projectId);
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: `${deal.equipmentClass} for Kabwe Mining`,
      mechanism: 'SUPPLY_DEMAND_MISMATCH',
      currency: mode!.currency,
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error('unreachable');
    const opportunityId = captured.value.id;
    expect(await linkOpportunity({ dealId: deal.id, opportunityId })).toBe(true);

    const filled = await fillCard({
      opportunityId,
      actorRef: userId,
      patch: {
        payer: 'Kabwe Mining, which published the fleet expansion',
        reachableChannel: 'The procurement office replied on Tuesday',
        buyingSignal: 'Published a fleet expansion',
        signalObservedAt: '2026-09-15T09:00:00.000Z',
        offerScope: 'One shipment of fuel tank trailers',
        acceptanceCondition: 'A signed purchase order arrives',
        priceCents: 250_000_00,
        deliveryMethod: 'Freight from the supplier to the buyer',
        fulfillmentOwner: 'Shandong Heavy Vehicles',
        peakFundingCents: 0,
      },
    });
    expect(filled.ok).toBe(true);
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      await recordCardFact({
        projectId,
        opportunityId,
        field,
        kind: 'PERSON',
        value: `The owner's own answer to ${field}.`,
        decidedBy: userId,
      });
    }
    expect((await markReady({ opportunityId, actorRef: userId })).ok).toBe(true);

    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 10_000_000,
      maxPerActionCents: 5_000_000,
      maxConcurrent: 3,
      currency: mode!.currency,
    });

    const started = await beginExecution({
      opportunityId,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Reached the procurement office.',
        requestKey: actionKey(opportunityId, 'CONTACT_BUYER', 'first'),
      },
    });
    expect(started.ok).toBe(true);

    const quoted = await recordFurtherAction({
      opportunityId,
      actorRef: userId,
      action: 'QUOTE_AND_INVOICE',
      performedBy: 'PERSON',
      detail: 'Sent the quote and invoice.',
      requestKey: actionKey(opportunityId, 'QUOTE_AND_INVOICE', 'first'),
    });
    expect(quoted.ok).toBe(true);

    const snapshot = await dealflowSnapshot(projectId);
    const readings = await readAll(snapshot);
    const reading = readings.find((one) => one.deal.id === deal.id);
    expect(reading?.stage).toBe('QUOTING');
    expect(reading?.because).toContain('QUOTE_AND_INVOICE');
  });
});

describe('transaction value is not our capital', () => {
  it('answers what every structure requires of us, for all thirteen', () => {
    for (const structure of COMMERCIAL_STRUCTURES) {
      expect(STRUCTURE_PROFILE[structure].capitalClass).toBeTruthy();
    }
  });

  /**
   * The brief's §13 in one assertion: a quarter-million-dollar transaction is
   * not a quarter-million dollars of ours unless the structure makes it so,
   * and most of them do not.
   */
  it('reports the lightest attested structure rather than the transaction size', () => {
    const evidence = [
      {
        id: 'dse_1',
        projectId,
        equipmentClass: 'fuel tank trailers',
        equipmentKey: equipmentKey('fuel tank trailers'),
        structure: 'REFERRAL_COMMISSION' as const,
        statement: 'manufacturers publish agent terms',
        rateNote: 'three to five per cent',
        sourceClaimId: 'clm_1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'dse_2',
        projectId,
        equipmentClass: 'fuel tank trailers',
        equipmentKey: equipmentKey('fuel tank trailers'),
        structure: 'TRADING_COMPANY_MARKUP' as const,
        statement: 'trading houses buy and resell',
        rateNote: null,
        sourceClaimId: 'clm_2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const path = commercialPath(
      structureOptions({ equipmentClass: 'fuel tank trailers', evidence }),
    );
    expect(path.established).toBe(true);
    expect(path.lightestCapitalClass).toBe('NONE');
  });

  it('offers every structure, not only the attested ones', () => {
    const options = structureOptions({ equipmentClass: 'fuel tank trailers', evidence: [] });
    expect(options.length).toBe(COMMERCIAL_STRUCTURES.length);
    expect(options.every((one) => one.attested === false)).toBe(true);
  });

  /**
   * A source saying "three to five per cent" is not a rate Brain may turn into
   * a number and multiply by a transaction value: that converts somebody
   * else's range into our revenue and presents it as arithmetic.
   */
  it('keeps a published rate as the source’s own words', () => {
    const options = structureOptions({
      equipmentClass: 'fuel tank trailers',
      evidence: [
        {
          id: 'dse_1',
          projectId,
          equipmentClass: 'fuel tank trailers',
          equipmentKey: equipmentKey('fuel tank trailers'),
          structure: 'BROKER_COMMISSION' as const,
          statement: 'brokers take a commission',
          rateNote: 'typically 3-5%',
          sourceClaimId: 'clm_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const broker = options.find((one) => one.profile.structure === 'BROKER_COMMISSION');
    expect(broker?.rateNotes).toEqual(['typically 3-5%']);
  });
});

describe('a lesson is derived, never stored', () => {
  it('reports one observation as an anecdote and never hides it', () => {
    const lessons = lessonsFrom([
      {
        id: 'dob_1',
        projectId,
        dealId: null,
        kind: 'CERTIFICATION_SURPRISE',
        jurisdiction: 'Zambia',
        equipmentKey: equipmentKey('fuel tank trailers'),
        statement: 'an inspection certificate nobody had researched',
        recordedBy: userId,
        sourceClaimId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(lessons.length).toBe(1);
    expect(lessons[0]!.isPattern).toBe(false);
    expect(lessons[0]!.says).toContain('Observed once');
  });

  it('calls it a pattern only once the sample reaches the floor', () => {
    const rows = Array.from({ length: PATTERN_FLOOR }, (_, index) => ({
      id: `dob_${index}`,
      projectId,
      dealId: null,
      kind: 'BUYER_IGNORED' as const,
      jurisdiction: 'Zambia',
      equipmentKey: equipmentKey('fuel tank trailers'),
      statement: 'no reply to a cold approach',
      recordedBy: userId,
      sourceClaimId: null,
      createdAt: new Date(Date.now() + index).toISOString(),
    }));
    const lessons = lessonsFrom(rows);
    expect(lessons[0]!.isPattern).toBe(true);
    expect(lessons[0]!.byPerson).toBe(PATTERN_FLOOR);
  });

  /**
   * Four of Brain's own derivations about one deal are one observation four
   * times over. Presenting them as a sample of four would be the
   * arithmetic-on-a-fiction §23 corrected once already.
   */
  it('does not count Brain’s own derivations toward the sample', () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: `dob_${index}`,
      projectId,
      dealId: null,
      kind: 'FALSE_SIGNAL' as const,
      jurisdiction: null,
      equipmentKey: null,
      statement: 'the tender had already closed',
      recordedBy: 'BRAIN',
      sourceClaimId: null,
      createdAt: new Date(Date.now() + index).toISOString(),
    }));
    const lessons = lessonsFrom(rows);
    expect(lessons[0]!.isPattern).toBe(false);
    expect(lessons[0]!.byPerson).toBe(0);
    expect(lessons[0]!.byBrain).toBe(4);
  });

  /**
   * A lesson about one class into one market is not evidence about another.
   * A grouping that blurred them would produce the confident wrong
   * generalization this module exists to refuse.
   */
  it('never groups two scopes into one lesson', () => {
    const lessons = lessonsFrom([
      {
        id: 'dob_1',
        projectId,
        dealId: null,
        kind: 'BUYER_IGNORED',
        jurisdiction: 'Zambia',
        equipmentKey: 'fuel tank trailers',
        statement: 'no reply',
        recordedBy: userId,
        sourceClaimId: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'dob_2',
        projectId,
        dealId: null,
        kind: 'BUYER_IGNORED',
        jurisdiction: 'Kenya',
        equipmentKey: 'dump trailers',
        statement: 'no reply',
        recordedBy: userId,
        sourceClaimId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(lessons.length).toBe(2);
    expect(lessons.every((one) => one.isPattern === false)).toBe(true);
  });
});

describe('the kernel opens the one question it can, and no more', () => {
  it('asks nothing at all without a sprint', async () => {
    const pass = await runDealflowKernel(projectId);
    expect(pass.opened).toEqual([]);
    expect(await listDealRounds(projectId)).toEqual([]);
  });

  it('opens the seed question first, because there is no class to ask about', async () => {
    await activated();
    const pass = await runDealflowKernel(projectId);
    expect(pass.opened.length).toBe(1);
    expect(pass.opened[0]!.purpose).toBe('SEED_EQUIPMENT');
    expect(pass.opened[0]!.why).toContain('No class of equipment is on the map');
  });

  /**
   * Two ticks both deciding correctly produce one round: the arbiter is the
   * unique index rather than a check-then-write, which is what makes the
   * allocator safe to be a pure function.
   */
  it('opens one round however many times it runs', async () => {
    await activated();
    await runDealflowKernel(projectId);
    await runDealflowKernel(projectId);
    const rounds = await listDealRounds(projectId);
    expect(rounds.filter((one) => one.purpose === 'SEED_EQUIPMENT').length).toBe(1);
  });

  it('refuses to open anything once the sprint is winding down', async () => {
    await activated();
    await setLifecycle({
      projectId,
      actorUserId: userId,
      to: 'WINDING_DOWN',
      reason: 'the sprint is ending',
    });
    const pass = await runDealflowKernel(projectId);
    expect(pass.opened).toEqual([]);
    expect(pass.declined.length).toBeGreaterThan(0);
  });

  /**
   * Winding down ends *new discovery* and never a customer's obligation. A
   * dealflow round is new discovery for the industry kernel's exact reason: it
   * starts a fresh research packet to learn something the sprint does not
   * know.
   */
  it('classifies a dealflow candidate as discovery work for the wind-down guard', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = await candidateFor('SEED_EQUIPMENT');
    expect(candidateId).not.toBe(null);

    await setLifecycle({
      projectId,
      actorUserId: userId,
      to: 'WINDING_DOWN',
      reason: 'the sprint is ending',
    });
    const mode = await (await import('../server/repos/cashMode.ts')).getCashMode(projectId);
    expect(await launchableUnderCashMode({ mode, candidateId: candidateId! })).toBe(false);
  });
});

describe('what comes back is filed by lookup, and refused otherwise', () => {
  async function seededBothSides(): Promise<void> {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = await candidateFor('SEED_EQUIPMENT');
    await finishedRound({
      candidateId: candidateId!,
      claims: [
        {
          claim: 'A mining operator published a fleet expansion requiring road tankers.',
          finding: 'BUYER_NEED',
          subject: 'Kabwe Mining',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
        },
        {
          claim: 'A manufacturer publishes export capability for this class.',
          finding: 'SUPPLIER_CAPABILITY',
          subject: 'Shandong Heavy Vehicles',
          equipment: 'fuel tank trailers',
          jurisdiction: 'China',
        },
      ],
    });
    await runDealflowKernel(projectId);
  }

  it('files both sides and pairs them', async () => {
    await seededBothSides();
    const parties = await listParties(projectId);
    expect(parties.map((one) => one.kind).sort()).toEqual(['BUYER', 'SUPPLIER']);
    const deals = await listDeals(projectId);
    expect(deals.length).toBe(1);
    expect(deals[0]!.equipmentClass).toBe('fuel tank trailers');
  });

  it('carries the jurisdiction from the column rather than the prose', async () => {
    await seededBothSides();
    const buyer = (await listParties(projectId)).find((one) => one.kind === 'BUYER');
    expect(buyer?.country).toBe('Zambia');
  });

  it('settles the round and records what it produced', async () => {
    await seededBothSides();
    const round = (await listDealRounds(projectId)).find(
      (one) => one.purpose === 'SEED_EQUIPMENT',
    );
    expect(round?.state).toBe('SETTLED');
    expect(round?.found).toBe(2);
  });

  /**
   * §38's recorded defect, which is reachable here and is not repeated.
   *
   * A round's claims are filed on the pass they are gated, and the round only
   * settles on the pass its mission reaches DONE — routinely a later one. If
   * `found` counted what *that* pass created it would record nought for a
   * round that had produced everything it produced, and `BARREN_ROUNDS` of
   * those retires the question that was working best.
   *
   * So the mission is deliberately left RUNNING across one whole pass here,
   * which is the arrangement that makes the two numbers differ.
   */
  it('records what the round established, not what the settling pass wrote', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = (await candidateFor('SEED_EQUIPMENT'))!;

    const { orchestrationId, missionId } = await answeredRound({
      candidateId,
      claims: [
        {
          claim: 'A published fleet expansion.',
          finding: 'BUYER_NEED',
          subject: 'Kabwe Mining',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
        },
        {
          claim: 'A published export capability.',
          finding: 'SUPPLIER_CAPABILITY',
          subject: 'Shandong Heavy Vehicles',
          equipment: 'fuel tank trailers',
          jurisdiction: 'China',
        },
      ],
    });
    expect(orchestrationId).toBeTruthy();

    // Pass one: the claims are gated and filed, and the round stays open
    // because the mission has not finished.
    const first = await runDealflowKernel(projectId);
    expect(first.filed.parties.length).toBe(2);
    expect(
      (await listDealRounds(projectId)).find((one) => one.purpose === 'SEED_EQUIPMENT')?.state,
    ).toBe('OPEN');

    // The mission finishes, and the next pass settles the round having
    // created nothing new.
    await transitionMission({ missionId, from: 'RUNNING', to: 'DONE' });
    const second = await runDealflowKernel(projectId);
    expect(second.filed.parties.length).toBe(0);

    const round = (await listDealRounds(projectId)).find(
      (one) => one.purpose === 'SEED_EQUIPMENT',
    );
    expect(round?.state).toBe('SETTLED');
    // Two, not nought. The round established both parties, whichever pass
    // happened to write the rows.
    expect(round?.found).toBe(2);
  });

  /**
   * A claim that failed the gate is not a weaker fact about the trade; it is
   * not a fact about the trade.
   */
  it('files nothing from a claim the gate rejected', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = await candidateFor('SEED_EQUIPMENT');
    await finishedRound({
      candidateId: candidateId!,
      claims: [
        {
          claim: 'A plausible buyer nobody published anything about.',
          finding: 'BUYER_NEED',
          subject: 'Imagined Mining',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
          accepted: false,
        },
      ],
    });
    await runDealflowKernel(projectId);
    expect(await listParties(projectId)).toEqual([]);
  });

  it('files a requirement, a cost line and a precedent into their own tables', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = await candidateFor('SEED_EQUIPMENT');
    await finishedRound({
      candidateId: candidateId!,
      claims: [
        {
          claim: 'Road tankers require type approval before registration.',
          finding: 'COMPLIANCE_REQUIREMENT',
          subject: 'Type approval',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
          value: 'MARKET_APPROVAL',
        },
        {
          claim: 'The duty rate on this heading is 19 per cent.',
          finding: 'COST_COMPONENT',
          subject: 'one unit',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
          value: 'IMPORT_DUTY',
          amountCents: 5_700_00,
          currency: 'USD',
        },
        {
          claim: 'Manufacturers publish agent commission terms for export sales.',
          finding: 'COMMERCIAL_PRECEDENT',
          subject: 'three to five per cent',
          equipment: 'fuel tank trailers',
          value: 'REFERRAL_COMMISSION',
        },
      ],
    });
    await runDealflowKernel(projectId);

    const requirements = await listRequirements(projectId);
    expect(requirements.length).toBe(1);
    expect(requirements[0]!.layer).toBe('MARKET_APPROVAL');
    expect(requirements[0]!.posture).toBe('REQUIRED');

    const costs = await listCosts(projectId);
    expect(costs.length).toBe(1);
    expect(costs[0]!.currency).toBe('USD');
    expect(costs[0]!.basis).toBe('one unit');

    const structures = await listStructureEvidence(projectId);
    expect(structures.length).toBe(1);
    expect(structures[0]!.rateNote).toBe('three to five per cent');
  });

  /**
   * A decision maker belongs to the organisation the round was asked about.
   * Arriving on a round that names none, there is nothing to attach it to —
   * and attaching it to the nearest plausible party would be Brain deciding
   * what a fact was about.
   */
  it('refuses a decision maker with no organisation to attach it to', async () => {
    await activated();
    await runDealflowKernel(projectId);
    const candidateId = await candidateFor('SEED_EQUIPMENT');
    await finishedRound({
      candidateId: candidateId!,
      claims: [
        {
          claim: 'Procurement is run by a central purchasing office.',
          finding: 'DECISION_MAKER',
          subject: 'Kabwe Mining',
        },
      ],
    });
    const pass = await runDealflowKernel(projectId);
    expect(pass.filed.decisionMakers).toEqual([]);
    expect(pass.filed.refused.length).toBe(1);
    expect(pass.filed.refused[0]!.why).toContain('names no organisation');
  });
});

describe('the ladder climbs on evidence and stops on an unknown', () => {
  async function bothSides(): Promise<Awaited<ReturnType<typeof runDealflowKernel>>> {
    await activated();
    await runDealflowKernel(projectId);
    await finishedRound({
      candidateId: (await candidateFor('SEED_EQUIPMENT'))!,
      claims: [
        {
          claim: 'A published fleet expansion.',
          finding: 'BUYER_NEED',
          subject: 'Kabwe Mining',
          equipment: 'fuel tank trailers',
          jurisdiction: 'Zambia',
        },
        {
          claim: 'A published export capability.',
          finding: 'SUPPLIER_CAPABILITY',
          subject: 'Shandong Heavy Vehicles',
          equipment: 'fuel tank trailers',
          jurisdiction: 'China',
        },
      ],
    });
    return runDealflowKernel(projectId);
  }

  it('stops at hypothesis while nothing says what the equipment costs', async () => {
    await bothSides();
    const snapshot = await dealflowSnapshot(projectId);
    const readings = await readAll(snapshot);
    expect(readings.length).toBe(1);
    expect(readings[0]!.stage).toBe('HYPOTHESIS');
    expect(readings[0]!.nextAction).toContain('price');
  });

  /**
   * Finishing a deal outranks starting another one. §38 records making the
   * opposite mistake and correcting it: the research that found the opening
   * has already been paid for.
   */
  it('asks the question that advances the deal before widening the map', async () => {
    const pass = await bothSides();
    expect(pass.paired.length).toBe(1);
    expect(pass.opened.length).toBe(1);
    expect(pass.opened[0]!.purpose).toBe('LANDED_COST');
    expect(pass.opened[0]!.why).toContain('rests on a number nobody has');
  });

  /**
   * One live question per class, so a class cannot monopolise the slots.
   *
   * Asserted as the *refusal* rather than as a count, because the refusal is
   * what carries the reason a reader would need.
   */
  it('declines a second question about a class while one is live', async () => {
    await bothSides();
    const snapshot = await dealflowSnapshot(projectId);
    const plan = planFrom(snapshot, await readAll(snapshot));
    expect(plan.asks).toEqual([]);
    expect(plan.declined.some((one) => one.why.includes('already live'))).toBe(true);
  });

  /**
   * §5's rule, at a pairing: a party that is no longer worth pursuing keeps
   * its row, because deleting it would make the same organisation arrive again
   * on the next round as a fresh discovery.
   */
  it('keeps a retired party and its deals', async () => {
    await bothSides();
    const buyer = (await listParties(projectId)).find((one) => one.kind === 'BUYER');
    const { retire } = await import('../server/services/dealflow/seed.ts');
    await retire({
      projectId,
      actorRef: userId,
      partyId: buyer!.id,
      reason: 'they bought elsewhere',
    });
    const after = await listParties(projectId);
    expect(after.length).toBe(2);
    expect(after.find((one) => one.id === buyer!.id)?.retiredAt).not.toBe(null);
    expect((await listDeals(projectId)).length).toBe(1);
  });
});

describe('a person names a counterparty, and Brain never does', () => {
  /**
   * `deal_parties.origin` is SEED or DISCOVERED, and a CHECK requires every
   * DISCOVERED row to carry its claim. So there is no code path by which Brain
   * could write a SEED party — §22's split at the table that decides who the
   * market is.
   */
  it('writes SEED only from a person, and DISCOVERED only with a claim', async () => {
    await activated();
    const { party } = await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'A mine the operator knows',
      country: 'Zambia',
      equipmentClass: 'fuel tank trailers',
    });
    expect(party.origin).toBe('SEED');
    expect(party.sourceClaimId).toBe(null);

    const expand = readFileSync(
      new URL('../server/services/dealflow/expand.ts', import.meta.url),
      'utf8',
    );
    expect(expand).toContain("origin: 'DISCOVERED'");
    expect(expand.includes("origin: 'SEED'")).toBe(false);
  });

  it('seeding spends nothing and starts nothing', async () => {
    await activated();
    const before = await listDealRounds(projectId);
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'SUPPLIER',
      name: 'A manufacturer the operator knows',
      country: 'China',
      equipmentClass: 'fuel tank trailers',
    });
    expect((await listDealRounds(projectId)).length).toBe(before.length);
  });

  it('is idempotent by identity rather than by a read', async () => {
    await activated();
    const first = await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'Kabwe Mining',
      equipmentClass: 'fuel tank trailers',
    });
    const second = await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'Kabwe Mining',
      equipmentClass: 'fuel tank trailers',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.party.id).toBe(first.party.id);
  });
});

describe('the operator surface reports facts and refuses figures it cannot have', () => {
  it('reports no revenue figure at all, and says why', async () => {
    await activated();
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'Kabwe Mining',
      country: 'Zambia',
      equipmentClass: 'fuel tank trailers',
    });
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'SUPPLIER',
      name: 'Shandong Heavy Vehicles',
      country: 'China',
      equipmentClass: 'fuel tank trailers',
    });
    await runDealflowKernel(projectId);

    const view = await dealflowView(projectId);
    expect(view.deals.length).toBe(1);
    expect(view.deals[0]!.ourRevenueCents).toBe(null);
    expect(view.deals[0]!.ourRevenueNote).toContain('does not state what we would earn');
  });

  it('names what is established and what is outstanding rather than scoring it', async () => {
    await activated();
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'Kabwe Mining',
      country: 'Zambia',
      equipmentClass: 'fuel tank trailers',
    });
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'SUPPLIER',
      name: 'Shandong Heavy Vehicles',
      country: 'China',
      equipmentClass: 'fuel tank trailers',
    });
    await runDealflowKernel(projectId);

    const view = await dealflowView(projectId);
    const deal = view.deals[0]!;
    expect(deal.established.length).toBeGreaterThan(0);
    expect(deal.outstanding.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('"score"');
    expect(JSON.stringify(view)).not.toContain('"probability"');
  });

  /**
   * The brief asks for expected time to cash, and this is the honest form of
   * it: the attested structure's own payment schedule, in words. Brain holds
   * no lead time, no sailing schedule and no payment term for this deal, so a
   * figure would be composed from nothing — and it would be the most quoted
   * number on the screen.
   */
  it('says when the money would arrive in words, and never as a figure', async () => {
    await activated();
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'BUYER',
      name: 'Kabwe Mining',
      country: 'Zambia',
      equipmentClass: 'fuel tank trailers',
    });
    await seedParty({
      projectId,
      actorRef: userId,
      kind: 'SUPPLIER',
      name: 'Shandong Heavy Vehicles',
      country: 'China',
      equipmentClass: 'fuel tank trailers',
    });
    await runDealflowKernel(projectId);

    // Nothing attested yet, so there is no schedule to report.
    let view = await dealflowView(projectId);
    expect(view.deals[0]!.paidWhen).toBe(null);

    const source = readFileSync(
      new URL('../server/services/dealflow/structures.ts', import.meta.url),
      'utf8',
    );
    // Every schedule is a sentence from the profile table. A digit in one
    // would be a figure nobody sourced, at the number a reader most wants.
    const schedules = [...source.matchAll(/paidWhen:\s*\n?\s*((?:'[^']*'\s*\+?\s*)+)/g)];
    expect(schedules.length).toBe(COMMERCIAL_STRUCTURES.length);
    for (const [, text] of schedules) {
      expect(`${/\d/.test(text!)}`).toBe('false');
    }
    view = await dealflowView(projectId);
    expect(typeof view.deals[0]!.capitalNote).toBe('string');
  });

  it('says what it would ask next and creates nothing by being read', async () => {
    await activated();
    const before = await listDealRounds(projectId);
    const view = await dealflowView(projectId);
    expect(view.next.length).toBeGreaterThan(0);
    expect(view.next[0]!.why).toBeTruthy();
    expect((await listDealRounds(projectId)).length).toBe(before.length);
  });

  it('records an observation without gating anything', async () => {
    await activated();
    await observe({
      projectId,
      actorRef: userId,
      kind: 'CERTIFICATION_SURPRISE',
      jurisdiction: 'Zambia',
      equipmentClass: 'fuel tank trailers',
      statement: 'an inspection certificate nobody had researched',
    });
    const view = await dealflowView(projectId);
    expect(view.lessons.length).toBe(1);
    expect(view.counts.observations).toBe(1);
  });
});

describe('the envelopes authorize reading and nothing else', () => {
  it('has a compiler profile for each, so neither is refused at the planning pass', () => {
    for (const id of ['RUSSELL_DEALFLOW_PARTIES_V1', 'RUSSELL_DEALFLOW_TERMS_V1']) {
      expect(getApprovalEnvelope(id)).not.toBe(null);
      expect(profileFor(id)).not.toBe(null);
    }
  });

  /**
   * Neither widens anything. Both take their source classes and their
   * forbidden actions verbatim from the discovery envelope, so nothing about
   * this kernel authorizes an effect the sprint's own grant did not already
   * authorize — which is nothing at all beyond reading.
   */
  it('takes its permissions verbatim from the discovery envelope', () => {
    const discovery = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1')!;
    for (const id of ['RUSSELL_DEALFLOW_PARTIES_V1', 'RUSSELL_DEALFLOW_TERMS_V1']) {
      const mine = getApprovalEnvelope(id)!;
      expect(mine.allowedSourceTypes).toBe(discovery.allowedSourceTypes);
      expect(mine.forbiddenActions).toBe(discovery.forbiddenActions);
    }
  });

  it('forbids every effect on the world in its own assignment', () => {
    for (const id of ['RUSSELL_DEALFLOW_PARTIES_V1', 'RUSSELL_DEALFLOW_TERMS_V1']) {
      const template = getApprovalEnvelope(id)!.assignmentTemplate ?? '';
      for (const phrase of ['contacting any person', 'quoting', 'making any commitment']) {
        expect(`${id}:${template.includes(phrase)}`).toBe(`${id}:true`);
      }
    }
  });
});

describe('promotion hands the deal to machinery that already exists', () => {
  it('creates no second lifecycle in this kernel', () => {
    const promote = readFileSync(
      new URL('../server/services/dealflow/promote.ts', import.meta.url),
      'utf8',
    );
    // Pursuit is Cash Mode's. A state machine here would be the redundant
    // engine the brief forbids, and the weaker of the two would win.
    expect(promote).toContain('createOpportunity');
    expect(promote).toContain('linkOpportunity');
  });

  /**
   * §13's distinction at the one column where collapsing it would be
   * invisible: a cash card's `price` means what *we* are paid, so writing the
   * landed cost there would put the largest number in the deal into the field
   * that decides what Brain thinks we earn.
   */
  it('never writes the transaction value into the card’s price', async () => {
    const promote = readFileSync(
      new URL('../server/services/dealflow/promote.ts', import.meta.url),
      'utf8',
    );
    expect(promote.includes('price_cents:')).toBe(false);
    expect(await getOpportunity('cop_absent')).toBe(null);
  });
});
