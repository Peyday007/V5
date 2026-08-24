/**
 * Where the run actually is, from what is persisted.
 *
 * Everything on this snapshot is read from the database at the moment it is
 * asked for. Nothing is accumulated in the browser and nothing is estimated:
 * a progress bar that counts what it hoped would happen is worse than no
 * progress bar, because the one question the user is asking — "is this working,
 * and on what?" — is exactly the one it answers wrongly.
 *
 * A refresh, a reconnect, a restarted server: all of them land on the same
 * snapshot, because the snapshot is the state rather than a story about it.
 */
import type { ContradictionKind, ResearchJob } from '../../domain/types.ts';
import { getAudit } from '../../repos/audits.ts';
import {
  currentFragments,
  getOrchestration,
  listClaims,
  listFragments,
} from '../../repos/research.ts';
import { contractFor, listCoverage, listRequirements } from '../../repos/reconciliation.ts';
import { getConnection, listJobs, openQuotaPause } from '../../repos/jobs.ts';
import { antigravityStatus } from '../../providers/antigravity/runtime.ts';

export interface ResearchProgressSnapshot {
  orchestrationId: string;
  assignment: { title: string; text: string; status: string; currentPass: string | null };
  boundary: { present: boolean; status: string | null; ambiguities: number };
  requirements: { total: number; mandatory: number; byCoverage: Record<string, number> };
  existingEvidence: { claimsRelied: number; requirementsCovered: number; documentsCited: number };
  gaps: { open: number; kinds: Record<string, number> };
  fragments: {
    planned: number;
    queued: number;
    running: number;
    accepted: number;
    repairing: number;
    blocked: number;
    unresolved: number;
    cancelled: number;
    total: number;
  };
  jobs: {
    queued: number;
    running: number;
    complete: number;
    failed: number;
    /** The job in flight, with the fragments riding in it. */
    active: { id: string; rationale: string; jobKind: string; fragmentKeys: string[] } | null;
  };
  evidence: {
    sourcesInspected: number;
    acceptedClaims: number;
    rejectedClaims: number;
    contradictions: number;
    contradictionKinds: Record<string, number>;
    repairAttempts: number;
  };
  quota: { state: string; detail: string; paused: boolean; pauseDetail: string | null };
  connection: { installed: boolean; authenticated: boolean; automationReady: boolean; verifiedRunAt: string | null };
  synthesis: { ready: boolean; reason: string };
  audit: { id: string | null; verdict: string | null; status: string };
  disposition: string;
}

function count<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/** Everything the progress panel shows, derived from persisted state only. */
export async function progressSnapshot(orchestrationId: string): Promise<ResearchProgressSnapshot | null> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) return null;

  const contract = await contractFor(orchestrationId);
  const requirements = await listRequirements(orchestrationId);
  const coverage = await listCoverage(orchestrationId);
  const fragments = await currentFragments(orchestrationId);
  const attempts = await listFragments(orchestrationId);
  const claims = await listClaims(orchestrationId);
  const jobs = await listJobs(orchestrationId);
  const pause = await openQuotaPause(orchestrationId);
  const connection = await getConnection(orchestration.provider);
  const probe = antigravityStatus().status;

  const active = jobs.find((job) => job.status === 'RUNNING') ?? null;
  const accepted = claims.filter((claim) => claim.accepted);
  const rejected = claims.filter((claim) => !claim.accepted);
  const contradictions = claims.filter(
    (claim) => claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED',
  );

  const sourceGroups = new Set<string>();
  for (const claim of claims) {
    if (claim.sourceGroup) sourceGroups.add(claim.sourceGroup);
    else if (claim.sourceUrl) sourceGroups.add(claim.sourceUrl);
  }

  const byStatus = count(fragments.map((fragment) => fragment.status));
  const gapKinds = count(
    coverage
      .filter((entry) => entry.needsResearch && entry.gapType)
      .map((entry) => entry.gapType as string),
  );

  const audit = orchestration.auditId ? await getAudit(orchestration.auditId) : null;
  const settled = fragments.filter((fragment) =>
    ['ACCEPTED', 'REJECTED', 'CANCELLED', 'NEEDS_HUMAN'].includes(fragment.status),
  );
  const synthesisReady =
    fragments.length > 0 &&
    settled.length === fragments.length &&
    fragments.some((fragment) => fragment.status === 'ACCEPTED');

  return {
    orchestrationId,
    assignment: {
      title: orchestration.title,
      text: orchestration.assignment,
      status: orchestration.status,
      currentPass: orchestration.currentPass,
    },
    boundary: {
      present: contract !== null,
      status: contract?.status ?? null,
      ambiguities: contract?.ambiguities.length ?? 0,
    },
    requirements: {
      total: requirements.length,
      mandatory: requirements.filter((entry) => entry.necessity === 'MANDATORY').length,
      byCoverage: count(coverage.map((entry) => entry.status)),
    },
    existingEvidence: {
      claimsRelied: new Set(coverage.flatMap((entry) => entry.claimIds)).size,
      requirementsCovered: coverage.filter(
        (entry) => entry.status === 'SATISFIED' || entry.status === 'PARTIALLY_SATISFIED',
      ).length,
      documentsCited: new Set(coverage.flatMap((entry) => entry.documentIds)).size,
    },
    gaps: {
      open: coverage.filter((entry) => entry.needsResearch).length,
      kinds: gapKinds,
    },
    fragments: {
      planned: byStatus['PLANNED'] ?? 0,
      queued: byStatus['QUEUED'] ?? 0,
      running: byStatus['RUNNING'] ?? 0,
      accepted: byStatus['ACCEPTED'] ?? 0,
      // A fragment on its second attempt is being repaired, whatever it is doing
      // this second.
      repairing: fragments.filter((fragment) => fragment.attempt > 1 && fragment.status !== 'ACCEPTED')
        .length,
      blocked: byStatus['BLOCKED'] ?? 0,
      unresolved: (byStatus['REJECTED'] ?? 0) + (byStatus['NEEDS_HUMAN'] ?? 0),
      cancelled: byStatus['CANCELLED'] ?? 0,
      total: fragments.length,
    },
    jobs: {
      queued: jobs.filter((job) => job.status === 'QUEUED').length,
      running: jobs.filter((job) => job.status === 'RUNNING').length,
      complete: jobs.filter((job) => job.status === 'COMPLETE').length,
      failed: jobs.filter((job) => job.status === 'FAILED').length,
      active: active ? describeJob(active, attempts) : null,
    },
    evidence: {
      sourcesInspected: sourceGroups.size,
      acceptedClaims: accepted.length,
      rejectedClaims: rejected.length,
      contradictions: contradictions.length,
      contradictionKinds: count(
        claims
          .map((claim) => claim.contradictionKind)
          .filter((kind): kind is ContradictionKind => kind !== null),
      ),
      // Every attempt beyond the first, across every fragment.
      repairAttempts: attempts.filter((fragment) => fragment.attempt > 1).length,
    },
    quota: {
      state: connection?.quotaState ?? 'unknown',
      detail: pause?.detail ?? 'The allowance has not stopped this run.',
      paused: orchestration.status === 'PAUSED_QUOTA' || pause !== null,
      pauseDetail: pause?.detail ?? null,
    },
    connection: {
      installed: probe.installed,
      authenticated: probe.authenticated,
      automationReady: probe.automationReady,
      verifiedRunAt: connection?.verifiedRunAt ?? null,
    },
    synthesis: {
      ready: synthesisReady,
      reason: synthesisReady
        ? 'Every fragment has settled and at least one cleared its gate.'
        : fragments.length === 0
          ? 'Nothing has been planned yet.'
          : `${fragments.length - settled.length} fragment(s) are still open.`,
    },
    audit: {
      id: orchestration.auditId,
      verdict: orchestration.verdict,
      status: audit ? 'RECORDED' : orchestration.status === 'AUDITING' ? 'RUNNING' : 'NOT_STARTED',
    },
    disposition: disposition(orchestration.status, orchestration.verdict),
  };
}

function describeJob(
  job: ResearchJob,
  attempts: { id: string; fragmentKey: string }[],
): { id: string; rationale: string; jobKind: string; fragmentKeys: string[] } {
  const byId = new Map(attempts.map((fragment) => [fragment.id, fragment.fragmentKey]));
  return {
    id: job.id,
    rationale: job.rationale,
    jobKind: job.jobKind,
    fragmentKeys: job.fragmentIds.map((id) => byId.get(id) ?? id),
  };
}

/** Where this run ended up, in one sentence, whatever that turned out to be. */
function disposition(status: string, verdict: string | null): string {
  switch (status) {
    case 'COMPLETE':
      return verdict
        ? `Finished. The report was filed and the audit returned ${verdict}.`
        : 'Finished. The report was filed.';
    case 'AWAITING_APPROVAL':
      return 'Planned, and waiting for you to approve it. Nothing has been spent.';
    case 'PAUSED_QUOTA':
      return 'Paused because the allowance ran out. Everything done is kept and everything queued is still queued.';
    case 'NEEDS_HUMAN':
      return 'Stopped and asking for a person: the evidence did not reach the bar this assignment needs.';
    case 'CANCELLED':
      return 'Cancelled. Nothing further was recorded.';
    case 'INTERRUPTED':
      return 'Interrupted by a restart. Completed work is kept; resume to continue from there.';
    case 'FAILED':
      return 'Failed. Nothing was filed.';
    default:
      return 'Running.';
  }
}
