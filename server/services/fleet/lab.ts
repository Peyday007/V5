/**
 * The Capability Lab.
 *
 * §15 is the largest single section of Step 12B, and the honest way to build it
 * is to be exact about which of its eight modes can run *now* and which cannot,
 * rather than to implement eight shapes and let the difference be discovered in
 * production.
 *
 * **The split, and why it is where it is.**
 *
 * `HEALTH_CHECK` runs for real and costs nothing. It reads the fleet's own
 * rows and answers the questions §15.1 lists — is the account reachable, does
 * the Routine have a secret, is a worker bound, is an independent audit
 * possible, what capacity is usable — and every answer is a row rather than a
 * probe. A health check that fired a worker to find out whether it works would
 * spend the allowance to learn something the rows already say.
 *
 * The ledger modes — calibration and fleet/provider analysis — report from
 * `bin_events`, which is the only measurement Brain has that it did not
 * manufacture. They carry the ledger's own evidence class: a duration Brain
 * timed is `MEASURED`, a refusal a provider issued is `PROVIDER_ENFORCED`, and
 * a ceiling nobody has observed is `UNKNOWN` and stays `UNKNOWN`.
 *
 * The pressure modes — push-to-failure, layout tournament, one-Routine fit,
 * quality-under-pressure, recovery drills — *spend real capacity on real
 * surfaces*. They are declared here with their full envelope and are **refused
 * to start** without a grant that names the ceiling, the duration, the stop
 * conditions and the cleanup. That refusal is the feature: §15.1's own rule is
 * that pressure increases only inside a predeclared safe envelope, and a lab
 * that ran them on a default would be defeating the control it exists to
 * honour.
 *
 * **Nothing here can contaminate anything.** Every experiment names an isolated
 * scope, and no code path in this file writes a claim, a document or a
 * knowledge row. `simulated` is a required literal on any projected result, so
 * a projection can never be read back as a measurement — the same structural
 * label `services/dispatch/simulate.ts` already carries.
 */
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { getProject } from '../../repos/projects.ts';
import { listAccounts, listRoutines, setPolicy, currentPolicy } from '../../repos/fleet.ts';
import { workloadProfile } from '../dispatch/profiles.ts';
import { fleetView, usability, type Evidence } from './view.ts';
import {
  MAX_CONCURRENCY,
  MAX_ITEMS_PER_RUN,
  NoLabClaimant,
  PROVIDER_UNTESTED,
  deadlineForRung,
  drain,
  evidenceFor,
  knee,
  labClaimants,
  ladder,
  runRecoveryDrill,
  throughput,
  type DrainRound,
} from './labRunners.ts';
import { AUDIT_SEPARATION_MINIMUM } from '../research/auditEligibility.ts';

/**
 * What a rollback restores when the canary displaced nothing at all.
 *
 * Named rather than inlined, because it is a real decision: an experiment
 * applied over an empty policy history has no prior value to return to, and the
 * honest restoration is the fleet's own conservative default rather than the
 * canary's number wearing the word "rolled back".
 */
export const DEFAULT_TARGET_WITH_NO_PRIOR_POLICY = 1;

/** The eight modes §15.1 names. */
export const LAB_MODES = [
  'HEALTH_CHECK',
  'CALIBRATION',
  'PUSH_TO_FAILURE',
  'LAYOUT_TOURNAMENT',
  'ONE_ROUTINE_FIT',
  'QUALITY_UNDER_PRESSURE',
  'FLEET_PROVIDER',
  'RECOVERY_DRILL',
] as const;
export type LabMode = (typeof LAB_MODES)[number];

export const MODE_LABELS: Record<LabMode, string> = {
  HEALTH_CHECK: 'Health check',
  CALIBRATION: 'Calibration run',
  PUSH_TO_FAILURE: 'Push to failure',
  LAYOUT_TOURNAMENT: 'Work-layout tournament',
  ONE_ROUTINE_FIT: 'One-Routine fit',
  QUALITY_UNDER_PRESSURE: 'Quality under pressure',
  FLEET_PROVIDER: 'Fleet and provider',
  RECOVERY_DRILL: 'Failure and recovery drill',
};

/**
 * Which modes spend real capacity on real surfaces.
 *
 * A constant rather than a flag on the row, for §24's reason: nobody supplies
 * the limits their own work is judged against. Moving a mode out of this set is
 * a code change somebody reviews.
 */
export const PRESSURE_MODES: readonly LabMode[] = [
  'PUSH_TO_FAILURE',
  'LAYOUT_TOURNAMENT',
  'ONE_ROUTINE_FIT',
  'QUALITY_UNDER_PRESSURE',
  'RECOVERY_DRILL',
];

/** The envelope a pressure test must declare before it may start (§15.2). */
export interface TestEnvelope {
  /** The highest pressure this test may reach. Never exceeded, never widened. */
  ceiling: number;
  /** How long it may run, in minutes. */
  durationMinutes: number;
  /** What ends it early. At least one, because a test with none cannot stop. */
  stopConditions: string[];
  /** What happens to what it created. */
  cleanup: string;
  /** How to undo any policy it applied. */
  rollback: string;
  /** Which workload this is about, so a result is not read about another. */
  workloadClass: string;
  /** Whether it uses synthetic, replayed, copied or real-canary work. */
  workKind: 'SYNTHETIC' | 'REPLAY' | 'COPY' | 'REAL_CANARY';
}

export interface LabExperiment {
  id: string;
  projectId: string;
  mode: LabMode;
  title: string;
  envelope: TestEnvelope;
  manifest: Record<string, unknown>;
  state: 'DECLARED' | 'REFUSED' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
  refusalReason: string | null;
  result: LabResult | null;
  simulated: boolean;
  actor: string;
  staleReason: string | null;
  appliedPolicyId: string | null;
  /**
   * The policy this experiment's canary displaced, recorded when it applied.
   *
   * Null means it displaced nothing, which is a different fact from not
   * knowing: rolling back then restores no target, because no target is what
   * was there.
   */
  displacedPolicyId: string | null;
  displacedTarget: number | null;
  appliedAt: string | null;
  rolledBackAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** The thirteen things §15.4 requires of every result. */
export interface LabResult {
  whatWasTested: string;
  whatHappened: string;
  degradationBegan: { value: string; evidence: Evidence };
  bottleneck: { value: string; evidence: Evidence };
  recommendedSetting: { value: string; evidence: Evidence };
  higherSetting: { value: string; tradeoff: string; evidence: Evidence } | null;
  configurationChanges: { key: string; from: string; to: string }[];
  effectOnBacklog: string;
  confidence: { sampleSize: number; note: string };
  untested: string[];
  /**
   * The highest point actually reached, and whether anything failed there.
   *
   * §15.4's rule in one field: testing through 500 without failure is "tested
   * safely through 500", never "maximum 500", so the two facts are separate
   * and a reader cannot collapse them.
   */
  highestTested: { value: number | null; anythingFailed: boolean };
  /** Findings a person can act on, each in one sentence. */
  findings: string[];
}

interface Row {
  id: string;
  project_id: string;
  mode: string;
  title: string;
  envelope: string;
  manifest: string;
  state: string;
  refusal_reason: string | null;
  result: string | null;
  simulated: number;
  actor: string;
  stale_reason: string | null;
  applied_policy_id: string | null;
  displaced_policy_id: string | null;
  displaced_target: number | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

function map(row: Row): LabExperiment {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode as LabMode,
    title: row.title,
    envelope: parseJson<TestEnvelope>(row.envelope, {
      ceiling: 0,
      durationMinutes: 0,
      stopConditions: [],
      cleanup: '',
      rollback: '',
      workloadClass: 'UNKNOWN',
      workKind: 'SYNTHETIC',
    }),
    manifest: parseJson<Record<string, unknown>>(row.manifest, {}),
    state: row.state as LabExperiment['state'],
    refusalReason: row.refusal_reason,
    result: row.result ? parseJson<LabResult | null>(row.result, null) : null,
    simulated: row.simulated === 1,
    actor: row.actor,
    staleReason: row.stale_reason,
    appliedPolicyId: row.applied_policy_id,
    displacedPolicyId: row.displaced_policy_id,
    displacedTarget: row.displaced_target,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * Whether a declared envelope is usable.
 *
 * Pure, so the rules are testable without a database — and they are rules
 * rather than validation: a test with no stop condition cannot stop, and one
 * with no ceiling is not bounded however carefully its prose describes itself.
 */
export function checkEnvelope(
  mode: LabMode,
  envelope: TestEnvelope,
): { ok: true } | { ok: false; reason: string } {
  if (!PRESSURE_MODES.includes(mode)) return { ok: true };
  if (!Number.isFinite(envelope.ceiling) || envelope.ceiling <= 0) {
    return { ok: false, reason: 'A pressure test must declare a ceiling above zero.' };
  }
  if (!Number.isFinite(envelope.durationMinutes) || envelope.durationMinutes <= 0) {
    return { ok: false, reason: 'A pressure test must declare how long it may run.' };
  }
  if (envelope.stopConditions.length === 0) {
    return {
      ok: false,
      reason: 'A pressure test must declare at least one stop condition; one with none cannot stop.',
    };
  }
  if (envelope.cleanup.trim().length === 0) {
    return { ok: false, reason: 'A pressure test must say what happens to what it creates.' };
  }
  if (envelope.rollback.trim().length === 0) {
    return { ok: false, reason: 'A pressure test must say how to undo what it applies.' };
  }
  if (envelope.workKind === 'REAL_CANARY') {
    return {
      ok: false,
      reason:
        'Real work may be used as a canary only after synthetic and replay tests have passed. Declare a synthetic run first.',
    };
  }
  return { ok: true };
}

/**
 * Declare an experiment.
 *
 * Declaring is not running. A pressure mode with an incomplete envelope is
 * stored as `REFUSED` with the reason rather than rejected outright, because
 * the refusal is worth keeping: it is evidence of what was asked for and why it
 * was not allowed, which a thrown error would lose.
 */
export async function declareExperiment(input: {
  projectId: string;
  mode: LabMode;
  title: string;
  envelope: TestEnvelope;
  manifest?: Record<string, unknown>;
  actor: string;
}): Promise<LabExperiment> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error('No project with that id.');

  /*
   * The isolation rule, enforced rather than described.
   *
   * §15.2 requires every test to be unable to contaminate real documents or
   * knowledge, and the mechanism this codebase already has for that is a
   * TECHNICAL scope — which ordinary totals, maps, briefings and lists already
   * exclude by provenance. A pressure test declared against a live project is
   * refused by name.
   */
  const isolated = project.purpose === 'TECHNICAL';
  const envelopeCheck = checkEnvelope(input.mode, input.envelope);
  const refusal =
    !isolated && PRESSURE_MODES.includes(input.mode)
      ? 'A pressure test must run in an isolated testing scope, not in a live project.'
      : envelopeCheck.ok
        ? null
        : envelopeCheck.reason;

  const id = newId('cex');
  const now = nowIso();
  await getDb().run(
    `INSERT INTO capability_experiments
       (id, project_id, mode, title, envelope, manifest, state, refusal_reason,
        simulated, actor, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
    [
      id,
      input.projectId,
      input.mode,
      input.title,
      toJson(input.envelope),
      toJson(input.manifest ?? {}),
      refusal ? 'REFUSED' : 'DECLARED',
      refusal,
      input.actor,
      now,
      now,
    ],
  );
  return (await getExperiment(id))!;
}

export async function getExperiment(id: string): Promise<LabExperiment | null> {
  const row = await getDb().get<Row>('SELECT * FROM capability_experiments WHERE id = ?', [id]);
  return row ? map(row) : null;
}

export async function listExperiments(projectId?: string | null): Promise<LabExperiment[]> {
  const rows = projectId
    ? await getDb().all<Row>(
        'SELECT * FROM capability_experiments WHERE project_id = ? ORDER BY created_at DESC LIMIT 200',
        [projectId],
      )
    : await getDb().all<Row>(
        'SELECT * FROM capability_experiments ORDER BY created_at DESC LIMIT 200',
        [],
      );
  return rows.map(map);
}

/* ==========================================================================
 * Health check — real, and free
 * ========================================================================== */

export interface HealthFinding {
  check: string;
  /** OK | ATTENTION | BROKEN | UNKNOWN — four, because they differ in remedy. */
  verdict: 'OK' | 'ATTENTION' | 'BROKEN' | 'UNKNOWN';
  /** Plain and actionable (§15.1), naming what to do rather than what failed. */
  detail: string;
}

/**
 * Everything §15.1 asks a health check to check, from rows.
 *
 * Nothing here fires a worker. Every answer comes from what Brain already
 * recorded, which is both cheaper and more truthful: whether a Routine has a
 * secret is a fact about a row, and discovering it by spending a fire would
 * tell you the same thing later and for money.
 */
export async function runHealthCheck(projectId: string | null): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const [accounts, routines, view] = await Promise.all([
    listAccounts(),
    listRoutines(),
    fleetView({ includeTechnical: true, projectId }),
  ]);
  const now = nowIso();

  findings.push(
    accounts.length === 0
      ? {
          check: 'Accounts registered',
          verdict: 'BROKEN',
          detail: 'No account is registered, so nothing can be fired. Register one with `npm run fleet`.',
        }
      : {
          check: 'Accounts registered',
          verdict: 'OK',
          detail: `${accounts.length} registered, ${accounts.filter((a) => a.state === 'ENABLED').length} healthy.`,
        },
  );

  if (routines.length === 0) {
    findings.push({
      check: 'Surfaces registered',
      verdict: 'BROKEN',
      detail: 'No Routine is registered. An account without a Routine is capacity Brain cannot reach.',
    });
  } else {
    const byAccount = new Map(accounts.map((account) => [account.id, account]));
    for (const routine of routines) {
      const { usable, reason } = usability(routine, byAccount.get(routine.accountId), now);
      findings.push({
        check: `Surface: ${routine.name}`,
        verdict: usable ? 'OK' : routine.state === 'QUARANTINED' ? 'ATTENTION' : 'BROKEN',
        detail: usable ? 'Registered, healthy, and ready to be fired.' : (reason ?? 'Not usable.'),
      });
    }
  }

  /*
   * Worker identity, and what it can and cannot tell us.
   *
   * A Routine with no bound worker is not broken — the binding is *observed*
   * when a session arrives (§23) — so this is `UNKNOWN` rather than a failure.
   * Reporting it as broken would send somebody to fix a row that is supposed
   * to fill itself in.
   */
  const unbound = routines.filter((routine) => routine.workerId === null);
  findings.push(
    unbound.length === 0
      ? { check: 'Worker identity', verdict: 'OK', detail: 'Every surface is bound to a worker.' }
      : {
          check: 'Worker identity',
          verdict: 'UNKNOWN',
          detail: `${unbound.length} surface${unbound.length === 1 ? '' : 's'} not yet bound. A binding is observed when a session arrives, so this resolves itself on the first fire.`,
        },
  );

  /*
   * Audit independence readiness.
   *
   * The floor is three distinct authenticated sessions, and §23 is explicit
   * that no count of accounts, workers or Routines appears in it. So this
   * reports whether a *surface* exists at all — which is what genuinely
   * prevents an audit — and never claims a tier from topology.
   */
  const usableSurfaces = view.usable.value ?? 0;
  findings.push(
    usableSurfaces === 0
      ? {
          check: 'Audit independence',
          verdict: 'BROKEN',
          detail:
            'There is no healthy surface, so no audit can run at all. This is an operational fact with an operational remedy — it is not a missing account.',
        }
      : {
          check: 'Audit independence',
          verdict: 'OK',
          detail: `The floor is a distinct authenticated session for each of the ${Object.keys(AUDIT_SEPARATION_MINIMUM).length} audit pairings. One healthy surface activated that many times satisfies it; no particular account or Routine count is required.`,
        },
  );

  findings.push({
    check: 'Usable capacity',
    verdict: usableSurfaces > 0 ? 'OK' : 'BROKEN',
    detail: `${usableSurfaces} surface${usableSurfaces === 1 ? '' : 's'} could be fired right now. ${view.bottleneckExplanation}`,
  });

  findings.push(
    view.backlog.needsHuman === 0
      ? { check: 'Stranded work', verdict: 'OK', detail: 'Nothing is parked waiting for a person.' }
      : {
          check: 'Stranded work',
          verdict: 'ATTENTION',
          detail: `${view.backlog.needsHuman} piece${view.backlog.needsHuman === 1 ? '' : 's'} of work stopped for a decision. Each one has an answering transition in Needs You.`,
        },
  );

  return findings;
}

/* ==========================================================================
 * Running an experiment
 * ========================================================================== */

/**
 * Run one experiment, or refuse it in words.
 *
 * The refusal is not an error path. §15.1 requires pressure to increase only
 * inside a predeclared envelope and provider authority, and this is where that
 * is honoured: a pressure mode with no grant is recorded as refused, with the
 * reason, and nothing is spent. Calling it again changes nothing, because the
 * condition is about the grant rather than about the attempt.
 */
export async function runExperiment(input: {
  id: string;
  /**
   * Whether a person has authorized real pressure on real surfaces.
   *
   * Supplied by the route from an authenticated decision, never read from the
   * experiment's own row: an experiment that carried its own authorization
   * would be supplying the limits it is judged against.
   */
  pressureAuthorized: boolean;
}): Promise<LabExperiment> {
  const experiment = await getExperiment(input.id);
  if (!experiment) throw new Error('No experiment with that id.');
  if (experiment.state === 'REFUSED') return experiment;
  if (experiment.state !== 'DECLARED') return experiment;

  const now = nowIso();

  if (PRESSURE_MODES.includes(experiment.mode) && !input.pressureAuthorized) {
    await settle(experiment.id, {
      state: 'REFUSED',
      refusalReason:
        'This test puts real pressure on real surfaces. It needs a person to authorize the ceiling, the duration and the stop conditions before anything runs.',
      at: now,
    });
    return (await getExperiment(experiment.id))!;
  }

  await getDb().run(
    `UPDATE capability_experiments SET state = 'RUNNING', started_at = ?, updated_at = ?
      WHERE id = ? AND state = 'DECLARED'`,
    [now, now, experiment.id],
  );

  if (experiment.mode === 'HEALTH_CHECK') {
    const findings = await runHealthCheck(experiment.projectId);
    const broken = findings.filter((finding) => finding.verdict === 'BROKEN');
    const attention = findings.filter((finding) => finding.verdict === 'ATTENTION');
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested: 'Whether the fleet is reachable, authorized and able to run an audit.',
        whatHappened: `${findings.length} checks: ${broken.length} broken, ${attention.length} needing attention.`,
        degradationBegan: { value: 'Not applicable to a health check.', evidence: 'UNKNOWN' },
        bottleneck: {
          value: broken[0]?.check ?? 'Nothing broken.',
          evidence: 'MEASURED',
        },
        recommendedSetting: {
          value: broken.length === 0 ? 'No change needed.' : broken[0]!.detail,
          evidence: 'MEASURED',
        },
        higherSetting: null,
        configurationChanges: [],
        effectOnBacklog:
          broken.length === 0
            ? 'Nothing here is holding the backlog up.'
            : 'Work cannot be dispatched until the broken checks are fixed.',
        confidence: { sampleSize: findings.length, note: 'Every answer is a row Brain wrote.' },
        untested: [
          'Whether a fired worker actually arrives — that needs a real activation.',
          'How much one surface can hold — that is a calibration run.',
        ],
        highestTested: { value: null, anythingFailed: broken.length > 0 },
        findings: findings.map((finding) => `${finding.check}: ${finding.detail}`),
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  if (experiment.mode === 'CALIBRATION' || experiment.mode === 'FLEET_PROVIDER') {
    const profile = await workloadProfile({ projectId: experiment.projectId });
    const view = await fleetView({ includeTechnical: true, projectId: experiment.projectId });
    /*
     * Read from the ledger, and labelled with what the ledger knows.
     *
     * The distinction §15.4 insists on, applied literally: a throughput Brain
     * timed is MEASURED, a refusal the provider issued is PROVIDER_ENFORCED,
     * and a ceiling nobody has reached is UNKNOWN — which means this mode can
     * legitimately produce a result whose most important field is "we have not
     * found the limit". That is a finding, not a failure.
     */
    const evidence: Evidence =
      profile.activations === 0
        ? 'UNKNOWN'
        : profile.providerRefusals > 0
          ? 'PROVIDER_ENFORCED'
          : 'MEASURED';
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested: 'What the fleet has actually done, from the dispatch ledger.',
        whatHappened: `${profile.activations} activations, ${profile.binsCompleted} bins completed, ${profile.providerRefusals} provider refusals.`,
        degradationBegan: {
          value:
            profile.providerRefusals > 0
              ? 'At the point the provider began refusing fires.'
              : 'No degradation has been observed.',
          evidence,
        },
        bottleneck: { value: profile.bottleneck, evidence: profile.evidence as Evidence },
        recommendedSetting: {
          value:
            view.policy.target === null
              ? 'No target is set; the dispatcher default is in force.'
              : `Keep the target at ${view.policy.target} until a pressure test says otherwise.`,
          evidence: profile.activations === 0 ? 'UNKNOWN' : 'INFERRED',
        },
        higherSetting:
          profile.providerRefusals === 0 && profile.activations > 0
            ? {
                value: 'A higher target has not been refused, so it may be available.',
                tradeoff:
                  'Untested headroom is not demonstrated capacity — raising it without a push-to-failure test is a guess.',
                evidence: 'UNKNOWN',
              }
            : null,
        configurationChanges: [],
        effectOnBacklog: view.bottleneckExplanation,
        confidence: {
          sampleSize: profile.activations,
          note:
            profile.activations === 0
              ? 'Nothing has been dispatched, so there is nothing to measure. This is not a zero.'
              : 'Counted from bin_events, which is the only measurement Brain did not manufacture.',
        },
        untested: profile.unknowns,
        highestTested: {
          value: profile.activations === 0 ? null : profile.activations,
          anythingFailed: profile.providerRefusals > 0,
        },
        findings: [
          profile.activations === 0
            ? 'No activation has been recorded, so no capacity claim can be made at all.'
            : `Tested safely through ${profile.activations} recorded activations. That is a lower bound on capacity, not a maximum.`,
        ],
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  /*
   * The five pressure modes, run for real against Brain's own concurrency
   * machinery.
   *
   * An earlier version of this file settled all five as REFUSED with "declared
   * but not implemented", on the reasoning that running them means putting real
   * pressure on real surfaces and Brain cannot do that without spending the
   * subscription. **The correction is recorded rather than quietly applied.**
   * The reasoning was half right — Brain must not fire Routines to find a number
   * — and the half that was wrong turned a declared capability into a permanent
   * refusal that no authorization could open, which is the "waiting for a person
   * who cannot resolve it" defect §24 names, at a lab.
   *
   * What was missed is that the surface is not the only thing under pressure.
   * Claiming, leasing, fencing, contention, recovery and backlog shape are
   * `repos/workQueue.ts`, which runs in this process against this database and
   * costs nothing external. `labRunners.ts` drives it with synthetic work in the
   * isolated TECHNICAL scope the declaration already requires, and every result
   * carries `PROVIDER_UNTESTED` — because what a real Cowork surface holds is
   * the one thing here that spends money, and it is a person's to authorize.
   */
  const started = Date.now();
  const rungs = ladder(experiment.envelope.ceiling);

  /*
   * A pressure run needs somewhere legitimate to hold a lease.
   *
   * `work_leases.worker_id` is a foreign key to a real worker, which is §19's
   * "ownership is proved against a principal" expressed as a constraint. With
   * no registered claimant in the isolated scope the run is **refused with the
   * remedy named** rather than attempted — and the remedy is a person's, on a
   * terminal, because creating an identity to make a lab test pass is what §22
   * forbids. This is an answering transition, not a dead end: registering one
   * and running the test again is all it takes.
   */
  const claimants = await labClaimants(experiment.projectId);
  if (claimants.length === 0) {
    await settle(experiment.id, {
      state: 'REFUSED',
      at: nowIso(),
      refusalReason: new NoLabClaimant(experiment.projectId).message,
    });
    return (await getExperiment(experiment.id))!;
  }

  if (experiment.mode === 'PUSH_TO_FAILURE' || experiment.mode === 'ONE_ROUTINE_FIT') {
    const perRung = deadlineForRung(experiment.envelope.durationMinutes, rungs.length);
    const walk = experiment.mode === 'ONE_ROUTINE_FIT' ? [rungs[rungs.length - 1]!] : rungs;
    const rounds: DrainRound[] = [];
    for (const concurrency of walk) {
      rounds.push(
        await drain({
          experimentId: experiment.id,
          projectId: experiment.projectId,
          concurrency,
          items: Math.min(MAX_ITEMS_PER_RUN, Math.max(concurrency * 4, 20)),
          deadlineMs: perRung,
        }),
      );
      if (Date.now() - started > experiment.envelope.durationMinutes * 60_000) break;
    }
    const stopped = knee(rounds);
    const top = rounds[rounds.length - 1] ?? null;
    const anythingFailed = rounds.some(
      (round) => round.refusedCompletions > 0 || round.leftOver > 0,
    );
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested:
          experiment.mode === 'ONE_ROUTINE_FIT'
            ? 'How much one claimant-equivalent lane holds, measured against the real queue.'
            : 'How many concurrent claimants the queue admits before contention stops paying.',
        whatHappened: rounds
          .map(
            (round) =>
              `${round.concurrency} claimant(s): ${round.completed}/${round.items} completed in ${round.elapsedMs}ms, ${round.lostRaces} lost races`,
          )
          .join('; '),
        degradationBegan: {
          value: stopped
            ? `${stopped.concurrency} concurrent claimants. ${stopped.reason}`
            : 'Nothing completed, so no degradation point exists to report.',
          evidence: evidenceFor(rounds),
        },
        bottleneck: {
          value:
            top && top.lostRaces > top.claimed
              ? 'Claim contention: most claim calls lost their compare-and-swap rather than doing work.'
              : 'The backlog drained without contention dominating.',
          evidence: evidenceFor(rounds),
        },
        recommendedSetting: {
          value: stopped
            ? `Run ${stopped.concurrency} concurrent claimants for this workload.`
            : 'Not enough completed to recommend a setting.',
          evidence: evidenceFor(rounds),
        },
        higherSetting:
          stopped && top && top.concurrency > stopped.concurrency
            ? {
                value: `${top.concurrency} was reached without a refusal.`,
                tradeoff:
                  'Above the knee the extra claimants mostly lose races, so throughput stops improving while contention keeps rising.',
                evidence: evidenceFor(rounds),
              }
            : null,
        configurationChanges: [],
        effectOnBacklog: `${rounds.reduce((sum, round) => sum + round.completed, 0)} synthetic items were drained end to end. No real work was touched.`,
        confidence: {
          sampleSize: rounds.reduce((sum, round) => sum + round.completed, 0),
          note: 'Every number is a real claim, lease and completion against the deployed queue code.',
        },
        untested: [
          PROVIDER_UNTESTED,
          'Whether a real research or audit workload behaves like a synthetic echo at this concurrency.',
        ],
        highestTested: { value: top?.concurrency ?? null, anythingFailed },
        findings: [
          top
            ? `Tested safely through ${top.concurrency} concurrent claimants. That is a lower bound on Brain's own machinery, not a maximum and not a statement about any provider.`
            : 'No rung completed, so nothing is established.',
          `${rounds.reduce((sum, round) => sum + round.refusedCompletions, 0)} completion(s) were refused by the queue's ownership proof.`,
        ],
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  if (experiment.mode === 'LAYOUT_TOURNAMENT') {
    /*
     * Two materially different layouts over the *same* work.
     *
     * The items are identical; what differs is how the backlog is shaped and
     * how many a claimant may take at once. That is what makes the comparison
     * mean anything: a tournament between two different workloads would be
     * measuring the workloads.
     */
    const concurrency = Math.max(2, Math.min(8, Math.floor(experiment.envelope.ceiling)));
    const perLayout = deadlineForRung(experiment.envelope.durationMinutes, 2);
    const flat = await drain({
      experimentId: experiment.id,
      projectId: experiment.projectId,
      concurrency,
      items: 60,
      batch: 1,
      deadlineMs: perLayout,
      priorityShape: 'FLAT',
    });
    const batched = await drain({
      experimentId: experiment.id,
      projectId: experiment.projectId,
      concurrency,
      items: 60,
      batch: 5,
      deadlineMs: perLayout,
      priorityShape: 'STAGGERED',
    });
    const flatRate = throughput(flat);
    const batchedRate = throughput(batched);
    const winner =
      flatRate === null || batchedRate === null
        ? null
        : batchedRate > flatRate
          ? 'batched'
          : 'one-at-a-time';
    const margin =
      flatRate !== null && batchedRate !== null && flatRate > 0
        ? Math.round(((batchedRate - flatRate) / flatRate) * 100)
        : null;
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested:
          'Two materially different work layouts over the same backlog: one item per claim with a flat priority, against five per claim with a staggered one.',
        whatHappened: `one-at-a-time ${flat.completed}/${flat.items} in ${flat.elapsedMs}ms; batched ${batched.completed}/${batched.items} in ${batched.elapsedMs}ms.`,
        degradationBegan: {
          value: 'Not applicable: both layouts ran at one concurrency.',
          evidence: 'UNKNOWN',
        },
        bottleneck: {
          value:
            flat.lostRaces > batched.lostRaces
              ? 'One item per claim spends more of each claimant on losing races.'
              : 'Batching did not reduce contention here.',
          evidence: evidenceFor([flat, batched]),
        },
        recommendedSetting: {
          value:
            winner === null
              ? 'Neither layout completed enough to recommend one.'
              : `Prefer the ${winner} layout at ${concurrency} claimants${margin === null ? '' : ` (${Math.abs(margin)}% ${margin >= 0 ? 'faster' : 'slower'} than the alternative)`}.`,
          evidence: evidenceFor([flat, batched]),
        },
        higherSetting: null,
        configurationChanges: [],
        effectOnBacklog: `${flat.completed + batched.completed} synthetic items drained across both layouts.`,
        confidence: {
          sampleSize: flat.completed + batched.completed,
          note: 'Both layouts drained identical work through the same code path; only the shape differed.',
        },
        untested: [
          PROVIDER_UNTESTED,
          'Whether the same ordering holds for work whose per-item cost is dominated by a provider rather than by the queue.',
        ],
        highestTested: {
          value: concurrency,
          anythingFailed: flat.refusedCompletions + batched.refusedCompletions > 0,
        },
        findings: [
          winner === null
            ? 'No defensible recommendation: not enough completed.'
            : `The ${winner} layout won on measured throughput at this concurrency.`,
          'This compares layouts, not capacity. It says nothing about how many surfaces the fleet has.',
        ],
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  if (experiment.mode === 'QUALITY_UNDER_PRESSURE') {
    /*
     * Quality measured separately from throughput, which is the whole point.
     *
     * §15.4 requires degradation to be a different reading from speed, so this
     * drains the same backlog twice — once quietly, once at the declared
     * ceiling — and compares the *failure* signals rather than the rate.
     */
    const low = await drain({
      experimentId: experiment.id,
      projectId: experiment.projectId,
      concurrency: 1,
      items: 40,
      deadlineMs: deadlineForRung(experiment.envelope.durationMinutes, 2),
    });
    const high = await drain({
      experimentId: experiment.id,
      projectId: experiment.projectId,
      concurrency: Math.max(2, Math.min(MAX_CONCURRENCY, Math.floor(experiment.envelope.ceiling))),
      items: 40,
      deadlineMs: deadlineForRung(experiment.envelope.durationMinutes, 2),
    });
    const lowLossRate = low.claimed === 0 ? null : low.lostRaces / (low.lostRaces + low.claimed);
    const highLossRate =
      high.claimed === 0 ? null : high.lostRaces / (high.lostRaces + high.claimed);
    const degraded =
      lowLossRate !== null && highLossRate !== null && highLossRate > lowLossRate + 0.1;
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested:
          'Whether quality signals worsen under concurrency, read separately from how fast the backlog drained.',
        whatHappened: `quiet: ${low.completed} completed, ${low.refusedCompletions} refused, ${low.lostRaces} lost races. Pressed: ${high.completed} completed, ${high.refusedCompletions} refused, ${high.lostRaces} lost races.`,
        degradationBegan: {
          value: degraded
            ? `Between 1 and ${high.concurrency} claimants: the share of claim calls that lost a race rose from ${Math.round((lowLossRate ?? 0) * 100)}% to ${Math.round((highLossRate ?? 0) * 100)}%.`
            : 'No quality degradation was observed between the quiet and pressed runs.',
          evidence: evidenceFor([low, high]),
        },
        bottleneck: {
          value: degraded
            ? 'Contention on the claim, not completion: the work still succeeded, the claimants just competed for it.'
            : 'Neither run showed a quality signal worth acting on.',
          evidence: evidenceFor([low, high]),
        },
        recommendedSetting: {
          value: degraded
            ? `Stay below ${high.concurrency} claimants for this workload unless throughput matters more than wasted claims.`
            : `Quality held to ${high.concurrency} claimants.`,
          evidence: evidenceFor([low, high]),
        },
        higherSetting: null,
        configurationChanges: [],
        effectOnBacklog: `${low.completed + high.completed} synthetic items drained. Nothing real was touched.`,
        confidence: {
          sampleSize: low.completed + high.completed,
          note: 'Quality here means refused completions and lost claims — queue-level facts, not a judgement about research output.',
        },
        untested: [
          PROVIDER_UNTESTED,
          'Whether the *content* quality of real research degrades under concurrency. Nothing in this lab reads a claim or an audit, so it cannot say.',
        ],
        highestTested: {
          value: high.concurrency,
          anythingFailed: low.refusedCompletions + high.refusedCompletions > 0,
        },
        findings: [
          degraded
            ? 'Quality degraded before throughput did, which is the reading this mode exists to produce.'
            : 'No degradation found inside the declared ceiling. That is a bound, not an absence of one.',
          'Research quality under pressure is explicitly not measured here and is named in the untested list.',
        ],
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  if (experiment.mode === 'RECOVERY_DRILL') {
    const drill = await runRecoveryDrill({
      experimentId: experiment.id,
      projectId: experiment.projectId,
    });
    const allHeld = drill.leaseTakenOver && drill.lateCompletionFenced && drill.cancellationFenced;
    await settle(experiment.id, {
      state: 'COMPLETE',
      at: nowIso(),
      result: {
        whatWasTested:
          'A worker abandoning a lease mid-flight: whether the work comes back, whether the dead owner is fenced, and whether cancellation wins.',
        whatHappened: `lease taken over: ${drill.leaseTakenOver}; late completion fenced: ${drill.lateCompletionFenced}${drill.lateCompletionRejection ? ` (${drill.lateCompletionRejection})` : ''}; completion after cancellation fenced: ${drill.cancellationFenced}. Waited ${drill.waitedMs}ms for the lease to expire.`,
        degradationBegan: {
          value: 'Not applicable to a recovery drill.',
          evidence: 'UNKNOWN',
        },
        bottleneck: {
          value: allHeld
            ? 'Nothing: recovery is automatic and does not depend on any process staying alive.'
            : 'A recovery guarantee did not hold and must be investigated before anything is dispatched.',
          evidence: 'MEASURED',
        },
        recommendedSetting: {
          value: allHeld
            ? 'No change. An expired lease is claimable work and a late write cannot land.'
            : 'Do not raise concurrency until the failing guarantee is understood.',
          evidence: 'MEASURED',
        },
        higherSetting: null,
        configurationChanges: [],
        effectOnBacklog: 'One synthetic item, cancelled at the end of the drill.',
        confidence: {
          sampleSize: 1,
          note: 'A real lease was allowed to expire rather than edited, so the recovery is the deployed behaviour.',
        },
        untested: [
          PROVIDER_UNTESTED,
          'Whether a Cowork session that dies mid-bin is noticed as quickly as a queue lease expiring.',
          ...(drill.crossIdentity
            ? []
            : ['Takeover by a *different* worker identity: only one is registered in this scope.']),
        ],
        highestTested: { value: 1, anythingFailed: !allHeld },
        findings: [
          drill.leaseTakenOver
            ? drill.crossIdentity
              ? 'An abandoned lease was claimed by a different worker identity, with no sweeper involved.'
              : 'An abandoned lease became claimable again and was reclaimed. Only one claimant identity is registered in this scope, so cross-identity takeover is NOT established by this run.'
            : 'The abandoned lease was NOT reclaimed — this is a failure, recorded as one.',
          drill.lateCompletionFenced
            ? `The dead owner's completion matched nothing (${drill.lateCompletionRejection}).`
            : 'The dead owner was able to complete after its lease expired — this is a failure, recorded as one.',
          drill.cancellationFenced
            ? 'A completion after cancellation matched nothing, so cancellation wins.'
            : 'Cancellation did not fence the live owner — this is a failure, recorded as one.',
        ],
      },
    });
    return (await getExperiment(experiment.id))!;
  }

  /*
   * A mode with no runner at all.
   *
   * Unreachable while `LAB_MODES` and the branches above agree, and kept
   * because the alternative is a mode falling through to `RUNNING` for ever.
   * It names the mode rather than describing a category, so adding one without
   * a runner produces a sentence somebody can act on.
   */
  await settle(experiment.id, {
    state: 'REFUSED',
    at: nowIso(),
    refusalReason: `${MODE_LABELS[experiment.mode]} has no runner in this build. Nothing was run and nothing was spent.`,
  });
  return (await getExperiment(experiment.id))!;
}

async function settle(
  id: string,
  input: {
    state: LabExperiment['state'];
    at: string;
    result?: LabResult;
    refusalReason?: string;
  },
): Promise<void> {
  await getDb().run(
    `UPDATE capability_experiments
        SET state = ?, result = ?, refusal_reason = ?, ended_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      input.state,
      input.result ? toJson(input.result) : null,
      input.refusalReason ?? null,
      input.at,
      input.at,
      id,
    ],
  );
}

/* ==========================================================================
 * Applying a finding
 * ========================================================================== */

/**
 * Turn a result into policy, reversibly.
 *
 * The change is an INSERT into `fleet_policy`, which is already versioned,
 * attributed and reasoned — so applying a finding needs no deployment and the
 * previous value is still there to revert to. The experiment records which
 * policy version it produced, so a rollback has a row as its target rather than
 * somebody's memory of what the number used to be.
 */
export async function applyFinding(input: {
  experimentId: string;
  target: number;
  actor: string;
  reason: string;
}): Promise<LabExperiment> {
  const experiment = await getExperiment(input.experimentId);
  if (!experiment) throw new Error('No experiment with that id.');
  if (experiment.state !== 'COMPLETE') {
    throw new Error('Only a completed experiment can be applied.');
  }
  /*
   * What is being displaced, read *before* the canary replaces it.
   *
   * This is the whole fix. Reading it afterwards — "the newest policy that is
   * not this one" — answers a different question, and the two answers differ in
   * both directions: over an empty history it finds nothing and falls back to
   * the canary itself, and after any later policy it finds that one instead.
   */
  const displaced = await currentPolicy('FLEET', null);

  const policy = await setPolicy({
    scope: 'FLEET',
    target: input.target,
    actor: input.actor,
    reason: `${input.reason} (from ${MODE_LABELS[experiment.mode]}: ${experiment.title})`,
  });
  const now = nowIso();
  await getDb().run(
    `UPDATE capability_experiments
        SET applied_policy_id = ?, displaced_policy_id = ?, displaced_target = ?,
            applied_at = ?, rolled_back_at = NULL, updated_at = ?
      WHERE id = ?`,
    [policy.id, displaced?.id ?? null, displaced?.target ?? null, now, now, input.experimentId],
  );
  return (await getExperiment(input.experimentId))!;
}

/**
 * Undo one, by writing the previous value forward.
 *
 * Not a delete: the applied version stays in the history, and the revert is a
 * new version carrying its own reason. "What was this before, and who changed
 * it back" must both stay answerable, which a destructive undo would lose.
 */
export async function rollbackFinding(input: {
  experimentId: string;
  actor: string;
  reason: string;
}): Promise<LabExperiment> {
  const experiment = await getExperiment(input.experimentId);
  if (!experiment) throw new Error('No experiment with that id.');
  if (!experiment.appliedPolicyId) {
    throw new Error('That experiment has not been applied, so there is nothing to roll back.');
  }
  /*
   * The named prior policy, read from the row rather than searched for.
   *
   * An experiment that displaced nothing rolls back to nothing — and "nothing"
   * has to mean something concrete, so it is the dispatcher's own default
   * rather than whatever the canary happened to set. Restoring the canary's
   * value and calling it a rollback is the defect this replaced.
   */
  const target = experiment.displacedTarget;
  await setPolicy({
    scope: 'FLEET',
    target: target ?? DEFAULT_TARGET_WITH_NO_PRIOR_POLICY,
    actor: input.actor,
    reason:
      target === null
        ? `Rolled back to no prior policy (the dispatcher default): ${input.reason}`
        : `Rolled back to the target this canary displaced (${target}): ${input.reason}`,
  });
  const now = nowIso();
  await getDb().run(
    `UPDATE capability_experiments SET rolled_back_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, input.experimentId],
  );
  return (await getExperiment(input.experimentId))!;
}

/* ==========================================================================
 * Staleness
 * ========================================================================== */

/**
 * Whether a result still describes the thing it was measured on (§15.7).
 *
 * The manifest recorded what was true when the test ran; this compares it to
 * what is true now. A difference makes the conclusion stale rather than wrong —
 * it was a fact about a different configuration — so the remedy is a retest,
 * which is what the reason says.
 */
export function stalenessOf(
  manifest: Record<string, unknown>,
  current: Record<string, unknown>,
): string | null {
  const watched = ['model', 'routineVersion', 'provider', 'accountPlan', 'workloadClass'];
  const changed = watched.filter(
    (key) => manifest[key] !== undefined && manifest[key] !== current[key],
  );
  if (changed.length === 0) return null;
  return `Measured under different conditions: ${changed.join(', ')} has changed since. Retest before relying on it.`;
}
