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
import { AUDIT_SEPARATION_MINIMUM } from '../research/auditEligibility.ts';

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
   * The remaining modes are declared and not implemented, and say so.
   *
   * This is the one place a half-built capability could quietly look finished,
   * so it does the opposite: the experiment settles as REFUSED with the exact
   * reason, which is that running it means putting real pressure on real
   * surfaces and Brain has no way to do that without spending the
   * subscription. A stub that returned plausible numbers would be the worst
   * thing this lab could produce.
   */
  await settle(experiment.id, {
    state: 'REFUSED',
    at: nowIso(),
    refusalReason: `${MODE_LABELS[experiment.mode]} puts real pressure on real surfaces and is declared but not implemented in this version. Nothing was run and nothing was spent.`,
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
  const policy = await setPolicy({
    scope: 'FLEET',
    target: input.target,
    actor: input.actor,
    reason: `${input.reason} (from ${MODE_LABELS[experiment.mode]}: ${experiment.title})`,
  });
  const now = nowIso();
  await getDb().run(
    `UPDATE capability_experiments
        SET applied_policy_id = ?, applied_at = ?, rolled_back_at = NULL, updated_at = ?
      WHERE id = ?`,
    [policy.id, now, now, input.experimentId],
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
  const before = await getDb().get<{ target: number }>(
    `SELECT target FROM fleet_policy
      WHERE scope = 'FLEET' AND scope_id IS NULL AND id <> ?
      ORDER BY version DESC LIMIT 1`,
    [experiment.appliedPolicyId],
  );
  const current = await currentPolicy('FLEET', null);
  await setPolicy({
    scope: 'FLEET',
    target: before?.target ?? current?.target ?? 1,
    actor: input.actor,
    reason: `Rolled back: ${input.reason}`,
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
