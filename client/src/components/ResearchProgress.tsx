/**
 * Where the run is, from what the server has actually persisted.
 *
 * Every number here came out of the database when the panel last heard from the
 * server. Nothing is accumulated in the browser and nothing is estimated,
 * because the question this panel answers — "is this working, and on what?" — is
 * exactly the one an optimistic progress bar answers wrongly.
 */
import type { ResearchProgressSnapshot } from '../lib/api.ts';
import { Pill } from './Badge.tsx';

function entries(record: Record<string, number>): { key: string; value: number }[] {
  return Object.entries(record)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, value }));
}

export function ResearchProgress(props: { progress: ResearchProgressSnapshot }): JSX.Element {
  const { progress } = props;

  return (
    <div className="research-progress">
      <div className="notice small">{progress.disposition}</div>

      <div className="row wrap">
        <Pill
          label="BOUNDARY"
          value={progress.boundary.present ? (progress.boundary.status ?? 'drafted') : 'not set'}
          tone={progress.boundary.present ? 'ok' : 'warn'}
        />
        {progress.boundary.ambiguities > 0 ? (
          <Pill label="UNSETTLED SCOPE" value={progress.boundary.ambiguities} tone="warn" />
        ) : null}
        <Pill label="REQUIREMENTS" value={progress.requirements.total} />
        <Pill label="MANDATORY" value={progress.requirements.mandatory} />
        <Pill
          label="ALREADY EVIDENCED"
          value={progress.existingEvidence.requirementsCovered}
          tone={progress.existingEvidence.requirementsCovered > 0 ? 'ok' : 'muted'}
        />
        <Pill
          label="OPEN GAPS"
          value={progress.gaps.open}
          tone={progress.gaps.open > 0 ? 'warn' : 'ok'}
        />
      </div>

      {entries(progress.requirements.byCoverage).length > 0 ? (
        <div className="row wrap small muted">
          {entries(progress.requirements.byCoverage).map((entry) => (
            <span key={entry.key} className="mono">
              {entry.key.toLowerCase().replace(/_/g, ' ')}: {entry.value}
            </span>
          ))}
        </div>
      ) : null}

      <div className="row wrap">
        <Pill label="FRAGMENTS" value={progress.fragments.total} />
        <Pill label="QUEUED" value={progress.fragments.queued} />
        <Pill label="RUNNING" value={progress.fragments.running} tone="warn" />
        <Pill label="ACCEPTED" value={progress.fragments.accepted} tone="ok" />
        <Pill
          label="REPAIRING"
          value={progress.fragments.repairing}
          tone={progress.fragments.repairing > 0 ? 'warn' : 'muted'}
        />
        <Pill
          label="BLOCKED"
          value={progress.fragments.blocked}
          tone={progress.fragments.blocked > 0 ? 'bad' : 'muted'}
        />
        <Pill
          label="UNRESOLVED"
          value={progress.fragments.unresolved}
          tone={progress.fragments.unresolved > 0 ? 'bad' : 'muted'}
        />
        {progress.fragments.cancelled > 0 ? (
          <Pill label="CANCELLED" value={progress.fragments.cancelled} />
        ) : null}
      </div>

      <div className="row wrap">
        <Pill label="JOBS QUEUED" value={progress.jobs.queued} />
        <Pill label="JOBS DONE" value={progress.jobs.complete} tone="ok" />
        {progress.jobs.failed > 0 ? (
          <Pill label="JOBS FAILED" value={progress.jobs.failed} tone="bad" />
        ) : null}
        <Pill label="SOURCES INSPECTED" value={progress.evidence.sourcesInspected} />
        <Pill label="CLAIMS ACCEPTED" value={progress.evidence.acceptedClaims} tone="ok" />
        <Pill
          label="CLAIMS REJECTED"
          value={progress.evidence.rejectedClaims}
          tone={progress.evidence.rejectedClaims > 0 ? 'warn' : 'muted'}
        />
        {progress.evidence.contradictions > 0 ? (
          <Pill label="CONTRADICTIONS" value={progress.evidence.contradictions} tone="warn" />
        ) : null}
        {progress.evidence.repairAttempts > 0 ? (
          <Pill label="REPAIR ATTEMPTS" value={progress.evidence.repairAttempts} />
        ) : null}
      </div>

      {progress.jobs.active ? (
        <div className="small">
          <strong>Running now:</strong> {progress.jobs.active.fragmentKeys.join(', ')}
          <div className="muted">{progress.jobs.active.rationale}</div>
        </div>
      ) : null}

      {entries(progress.evidence.contradictionKinds).length > 0 ? (
        <div className="small muted">
          Disagreements found:{' '}
          {entries(progress.evidence.contradictionKinds)
            .map((entry) => `${entry.key.toLowerCase().replace(/_/g, ' ')} (${entry.value})`)
            .join(', ')}
        </div>
      ) : null}

      <div className="row wrap">
        <Pill
          label="ALLOWANCE"
          value={progress.quota.paused ? 'paused' : progress.quota.state}
          tone={progress.quota.paused ? 'bad' : 'muted'}
        />
        <Pill
          label="WORKER"
          value={
            progress.connection.verifiedRunAt
              ? 'verified'
              : progress.connection.automationReady
                ? 'connected'
                : 'not ready'
          }
          tone={progress.connection.verifiedRunAt ? 'ok' : 'warn'}
        />
        <Pill
          label="SYNTHESIS"
          value={progress.synthesis.ready ? 'ready' : 'not ready'}
          tone={progress.synthesis.ready ? 'ok' : 'muted'}
        />
        <Pill
          label="AUDIT"
          value={progress.audit.verdict ?? progress.audit.status.toLowerCase().replace(/_/g, ' ')}
          tone={progress.audit.verdict === 'PASS' ? 'ok' : 'muted'}
        />
      </div>

      {progress.quota.pauseDetail ? (
        <div className="warn small">{progress.quota.pauseDetail}</div>
      ) : null}
      {!progress.synthesis.ready ? (
        <div className="small muted">{progress.synthesis.reason}</div>
      ) : null}
    </div>
  );
}
