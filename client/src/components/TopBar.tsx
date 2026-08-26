/**
 * The always-visible header: which project, which wave, how much is frozen, and
 * the four global actions.
 *
 * The counts are rendered from the plan the server just derived rather than from
 * anything the UI accumulated, so the header can never disagree with the panes
 * below it (invariant 7).
 */
import type { PlannerResult, Project } from '../../../server/domain/types.ts';
import type { HealthResponse, SessionUser } from '../lib/api.ts';
import { Badge, Pill } from './Badge.tsx';
import { ResearchStatus } from './ResearchStatus.tsx';

/** Display order for the status roll-up; worst news first. */
const STATUS_ORDER: readonly string[] = [
  'BLOCKED',
  'MORE_RESEARCH_REQUIRED',
  'AUDITING',
  'AUDIT_READY',
  'RESEARCHING',
  'SYNTHESIS_RUNNING',
  'SYNTHESIS_READY',
  'INCOMPLETE',
  'REOPENED',
  'NOT_STARTED',
  'PARKED',
  'FROZEN',
];

function countByStatus(plan: PlannerResult | null): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const layer of plan?.layers ?? []) {
    counts.set(layer.status, (counts.get(layer.status) ?? 0) + 1);
  }
  const ordered: { status: string; count: number }[] = [];
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count) {
      ordered.push({ status, count });
      counts.delete(status);
    }
  }
  for (const [status, count] of counts) ordered.push({ status, count });
  return ordered;
}

/**
 * The build facts only.
 *
 * Whether research automation works is no longer squeezed in here as
 * `providers: mock` — a true statement nobody could act on. It has its own chip
 * that says what to do about it.
 */
function healthLine(health: HealthResponse | null): string {
  if (!health) return 'server unreachable';
  return `schema v${health.schemaVersion} · ${health.driver}`;
}

export function TopBar(props: {
  project: Project | null;
  plan: PlannerResult | null;
  health: HealthResponse | null;
  /** Who is signed in. The header is the only place this is shown. */
  user: SessionUser | null;
  onSignOut(): void;
  onImport(): void;
  onSources(): void;
  onWhatNext(): void;
  onReconcile(): void;
  onSettings(): void;
  onRefresh(): void;
  busy: boolean;
}): JSX.Element {
  const { project, plan, health, user, busy } = props;
  const statuses = countByStatus(plan);
  const total = plan?.layers.length ?? 0;
  const frozen = plan?.layers.filter((layer) => layer.status === 'FROZEN').length ?? 0;
  const wave = project?.currentWave ?? plan?.wave ?? 0;
  const disabled = busy || !project;

  return (
    <header className="topbar">
      <div className="topbar__identity">
        <div className="topbar__title">
          PROJECT: <strong>{project?.name ?? 'none loaded'}</strong>
        </div>
        <div className="topbar__meta muted mono" title={health?.databasePath ?? ''}>
          {healthLine(health)}
        </div>
        <ResearchStatus />
      </div>

      <div className="topbar__status row">
        <Pill label="WAVE" value={wave} />
        <Pill
          label="OVERALL"
          value={`${frozen} frozen / ${total} layers`}
          tone={total > 0 && frozen === total ? 'ok' : 'muted'}
        />
        {statuses.map((entry) => (
          <span className="topbar__count" key={entry.status}>
            <Badge status={entry.status} />
            <span className="mono">{entry.count}</span>
          </span>
        ))}
      </div>

      <div className="topbar__actions row">
        <button type="button" className="btn btn--primary" onClick={props.onImport} disabled={disabled}>
          IMPORT DOCUMENT
        </button>
        <button type="button" className="btn" onClick={props.onSources} disabled={disabled}>
          PROJECT SOURCES
        </button>
        <button type="button" className="btn btn--primary" onClick={props.onWhatNext} disabled={disabled}>
          WHAT NEXT?
        </button>
        <button type="button" className="btn" onClick={props.onReconcile} disabled={disabled}>
          SCAN &amp; RECONCILE
        </button>
        <button type="button" className="btn" onClick={props.onSettings} disabled={busy}>
          SETTINGS
        </button>
        {user ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={props.onSignOut}
            title={`${user.email}${user.isBrainAdmin ? ' · Brain administrator' : ''}`}
          >
            SIGN OUT {user.displayName.toUpperCase()}
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={props.onRefresh} disabled={busy}>
          REFRESH
        </button>
      </div>
    </header>
  );
}
