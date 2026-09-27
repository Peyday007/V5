/**
 * What is already known, read from Brain's own rows before anything is re-proved.
 *
 * Two kinds of property are *derived* rather than recorded, because Brain
 * already writes the evidence for them and a second copy would be the one
 * nobody reconciles:
 *
 *   FACTORY_SURFACE:<routine>:repo:<owner/name>:push | :delivery
 *       from `routine_delivery_proofs` — a REAL_WORK row is a push the forge
 *       confirmed on real Factory work (REAL_PRODUCTION); a PROBE row is the
 *       synthetic probe (SYNTHETIC); CLEARED is a person saying the cause of a
 *       refusal was fixed, which proves nothing (STALE).
 *
 *   FULL_GATE:<sha>:postgres | :sqlite
 *       from the repository's own CI, read through the forge when Brain holds
 *       a forge token: the Postgres suite and Deploy's test job. The reading is
 *       then recorded as a CI row so the next lookup costs nothing.
 *
 * Everything else is whatever `engineering_evidence` holds.
 */
import { getRoutine, getRoutineByRef, listRoutines } from '../../repos/fleet.ts';
import { listDeliveryProofs, normalizeRepository } from '../../repos/deliveryProofs.ts';
import { canonicalRepository, observationsFor, recordEvidence } from '../../repos/engineering.ts';
import {
  readEvidence,
  type EvidenceObservation,
  type EvidenceReading,
} from '../../domain/engineering.ts';
import { parseRemote, readChecks } from '../factory/forge.ts';

/** The CI check names that constitute each backend's full gate. */
export const FULL_GATE_CHECKS: Record<'sqlite' | 'postgres', string> = {
  postgres: 'The whole suite, against Postgres',
  sqlite: 'Typecheck and tests',
};

const SURFACE_KEY = /^FACTORY_SURFACE:([^:]+):repo:([^:]+):(push|delivery)$/;
const GATE_KEY = /^FULL_GATE:([0-9a-f]{7,40}):(sqlite|postgres)$/i;

async function resolveRoutineId(reference: string): Promise<string | null> {
  const byId = await getRoutine(reference);
  if (byId) return byId.id;
  const byRef = await getRoutineByRef(reference);
  if (byRef) return byRef.id;
  const lower = reference.toLowerCase();
  const byName = (await listRoutines()).find((routine) => routine.name.toLowerCase() === lower);
  return byName?.id ?? null;
}

/**
 * Read from `routine_delivery_proofs`, the state the dispatcher already routes
 * on. Two properties, and they are not the same fact:
 *
 *   :push      any settled row — a confirmed push is PROVEN, a refused one is
 *              FAILED, CLEARED says the cause was fixed and proves nothing.
 *   :delivery  a PROVEN row counts only if it carries a pull request. A push
 *              the forge confirmed with no pull request proves the surface can
 *              push; it says nothing about opening one. FAILED and CLEARED
 *              count for both, because a surface that cannot push cannot
 *              deliver and a repaired attachment is unproven for both.
 */
async function surfaceObservations(
  routineReference: string,
  repository: string,
  property: 'push' | 'delivery',
): Promise<EvidenceObservation[]> {
  const routineId = await resolveRoutineId(routineReference);
  if (!routineId) return [];
  const repo = normalizeRepository(repository);
  const proofs = await listDeliveryProofs(routineId);
  return proofs
    .filter((proof) => proof.repository === repo && proof.state !== 'PENDING')
    .filter((proof) => property === 'push' || proof.state !== 'PROVEN' || proof.pullRequest !== null)
    .map((proof) => ({
      status: proof.state === 'PROVEN' ? 'PROVEN' : proof.state === 'FAILED' ? 'FAILED' : 'STALE',
      source: proof.source === 'REAL_WORK' ? 'REAL_PRODUCTION' : 'SYNTHETIC',
      evidenceRef: proof.pullRequest
        ? `routine_delivery_proofs:${proof.id} (bin ${proof.binId}, PR #${proof.pullRequest})`
        : `routine_delivery_proofs:${proof.id} (bin ${proof.binId})`,
      codeSha: proof.headSha,
      configFingerprint: null,
      provenAt: proof.settledAt ?? proof.createdAt,
      validUntil: null,
      invalidationScope: ['routine_repository_attachment', 'github_authorization', 'repository_permission'],
      createdAt: proof.settledAt ?? proof.createdAt,
    }));
}

/**
 * Ask the forge what CI said about one commit, and record it. Null when Brain
 * holds no forge token or the forge would not answer — which is UNKNOWN, never
 * a pass.
 */
async function readGateFromCi(
  repository: string,
  sha: string,
  backend: 'sqlite' | 'postgres',
): Promise<EvidenceObservation | null> {
  const forgeRepo = parseRemote(`https://github.com/${canonicalRepository(repository)}`);
  if (!forgeRepo) return null;
  let reply;
  try {
    reply = await readChecks(forgeRepo, sha);
  } catch {
    return null;
  }
  if (!reply.ok || !reply.body) return null;
  const check = reply.body.checks.find((c) => c.name === FULL_GATE_CHECKS[backend]);
  if (!check || check.status !== 'completed') return null;
  const status = check.conclusion === 'success' ? 'PROVEN' : 'FAILED';
  const ref = `github check "${check.name}" on ${sha}: ${check.conclusion}`;
  await recordEvidence({
    repository,
    propertyKey: `FULL_GATE:${sha}:${backend}`,
    status,
    source: 'CI',
    evidenceRef: ref,
    codeSha: sha,
    recordedByType: 'BRAIN',
    recordedById: 'engineering:ci-reader',
  });
  const now = new Date().toISOString();
  return {
    status,
    source: 'CI',
    evidenceRef: ref,
    codeSha: sha,
    configFingerprint: null,
    provenAt: now,
    validUntil: null,
    invalidationScope: [],
    createdAt: now,
  };
}

export interface EvidenceLookup extends EvidenceReading {
  repository: string;
  propertyKey: string;
  derivedFrom: 'ROWS' | 'DELIVERY_PROOFS' | 'CI' | 'NOTHING';
}

export async function lookupEvidence(input: {
  repository: string;
  propertyKey: string;
  currentFingerprint?: string | null;
  /** Skip the forge. Tests and offline callers. */
  offline?: boolean;
}): Promise<EvidenceLookup> {
  const repository = canonicalRepository(input.repository);
  const stored = await observationsFor(repository, input.propertyKey);
  let derivedFrom: EvidenceLookup['derivedFrom'] = stored.length > 0 ? 'ROWS' : 'NOTHING';
  const observations = [...stored];

  const surface = SURFACE_KEY.exec(input.propertyKey);
  if (surface) {
    const derived = await surfaceObservations(surface[1]!, surface[2]!, surface[3] as 'push' | 'delivery');
    if (derived.length > 0) derivedFrom = 'DELIVERY_PROOFS';
    observations.push(...derived);
  }

  const gate = GATE_KEY.exec(input.propertyKey);
  if (gate && stored.length === 0 && !input.offline) {
    const ci = await readGateFromCi(repository, gate[1]!, gate[2]!.toLowerCase() as 'sqlite' | 'postgres');
    if (ci) {
      derivedFrom = 'CI';
      observations.push(ci);
    }
  }

  // A surface key reads the way `deliveryReadings` does: the newest settled
  // row decides, whatever produced it — including an operator's invalidation
  // of the repository attachment recorded in engineering_evidence.
  const reading = readEvidence(observations, new Date().toISOString(), input.currentFingerprint, {
    newestWins: surface !== null,
  });
  return { ...reading, repository, propertyKey: input.propertyKey, derivedFrom };
}
