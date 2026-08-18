/**
 * The right pane: the Master Planner.
 *
 * The product exists to answer one question — WHAT SHOULD I DO NEXT? — so the
 * single derived sentence at the top is the loudest thing on the screen and
 * everything else is supporting evidence. The buckets underneath are the same
 * plan broken into NOW / NEXT / LATER / BLOCKED, and a blocked item always names
 * the documents it is waiting for, because "Missing: Discovery Logic v1G" is the
 * fact the user acts on. Nothing here is computed in the browser: the plan is
 * rendered exactly as the server derived it from SQLite and the filesystem.
 */
import { useCallback, useState } from 'react';
import type { PlannerBucket, PlannerItem, PlannerResult } from '../../../server/domain/types.ts';
import { Api, ApiError } from '../lib/api.ts';
import { Badge, Pill } from './Badge.tsx';
import { ChatPanel } from './ChatPanel.tsx';

const BUCKETS: readonly { bucket: PlannerBucket; label: string; blurb: string }[] = [
  { bucket: 'NOW', label: 'NOW', blurb: 'Actionable this session.' },
  { bucket: 'NEXT', label: 'NEXT', blurb: 'Queued behind the work above.' },
  { bucket: 'LATER', label: 'LATER', blurb: 'Parked, frozen or far off.' },
  { bucket: 'BLOCKED', label: 'BLOCKED', blurb: 'Waiting on a missing document.' },
];

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function itemsFor(plan: PlannerResult, bucket: PlannerBucket): PlannerItem[] {
  switch (bucket) {
    case 'NOW':
      return plan.now;
    case 'NEXT':
      return plan.next;
    case 'LATER':
      return plan.later;
    case 'BLOCKED':
      return plan.blocked;
    default:
      return [];
  }
}

/** `RUN_SYNTHESIS` -> `RUN SYNTHESIS`; the action type is shown, not guessed at. */
function actionLabel(item: PlannerItem): string {
  return item.actionType.replace(/_/g, ' ');
}

function PlannerItemRow(props: {
  item: PlannerItem;
  bucket: PlannerBucket;
  onSelectLayer(layerId: string): void;
}): JSX.Element {
  const { item, bucket } = props;
  const modifier = bucket.toLowerCase();
  return (
    <button
      type="button"
      className={`planner-item planner-item--${modifier}`}
      onClick={() => props.onSelectLayer(item.layerId)}
      title={`${item.layerName} — priority ${item.priority}`}
    >
      <span className="planner-item__title">{item.title}</span>
      {item.detail ? <span className="planner-item__detail">{item.detail}</span> : null}
      {item.missing.length > 0 ? (
        <span className="planner-item__detail bad" title={item.missing.join('\n')}>
          Missing: {item.missing.join(', ')}
        </span>
      ) : null}
      <span className="row small">
        <Badge status={item.status} />
        <span className="mono muted truncate">{item.layerName}</span>
        {item.targetVersion ? <span className="tag">{item.targetVersion}</span> : null}
        <span className="mono muted right">{actionLabel(item)}</span>
      </span>
    </button>
  );
}

export function PlannerPane(props: {
  plan: PlannerResult | null;
  onSelectLayer(layerId: string): void;
  projectId: string | null;
  onChanged(): void;
}): JSX.Element {
  const { plan, projectId, onChanged, onSelectLayer } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * RE-DERIVE forces the server to re-read the filesystem and recompute every
   * layer. It exists because the user may have moved a file behind the app's
   * back, and the answer above must never be a cached one.
   */
  const handleRecompute = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await Api.recompute(projectId);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [projectId, onChanged]);

  const nextBest = plan?.nextBestAction ?? null;
  const nextBestText =
    plan?.nextBestActionText?.trim() ||
    (plan ? 'Nothing is actionable: every layer is frozen or parked.' : 'No plan has been derived yet.');

  return (
    <div className="planner">
      <div className="next-best-action">
        <span className="next-best-action__label">NEXT BEST ACTION</span>
        <span className="next-best-action__text">{nextBestText}</span>
        {nextBest ? (
          <>
            {nextBest.detail ? (
              <span className="next-best-action__detail">{nextBest.detail}</span>
            ) : null}
            {nextBest.missing.length > 0 ? (
              <span className="next-best-action__detail bad">
                Missing: {nextBest.missing.join(', ')}
              </span>
            ) : null}
            <div className="row">
              <Badge status={nextBest.status} />
              <span className="mono muted truncate">{nextBest.layerName}</span>
              {nextBest.targetVersion ? <span className="tag">{nextBest.targetVersion}</span> : null}
              <span className="mono muted">{actionLabel(nextBest)}</span>
              <button
                type="button"
                className="btn btn--primary btn--small right"
                onClick={() => onSelectLayer(nextBest.layerId)}
              >
                OPEN {nextBest.layerName.toUpperCase()}
              </button>
            </div>
          </>
        ) : (
          <span className="next-best-action__detail">
            {plan
              ? 'Every layer is frozen, parked or waiting on work that is already running.'
              : 'Load a project to see the derived plan.'}
          </span>
        )}
      </div>

      {error ? (
        <div className="error spread">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setError(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      {plan ? (
        <>
          <div className="row">
            <Pill label="NOW" value={plan.now.length} tone={plan.now.length ? 'ok' : 'muted'} />
            <Pill label="NEXT" value={plan.next.length} />
            <Pill label="LATER" value={plan.later.length} />
            <Pill
              label="BLOCKED"
              value={plan.blocked.length}
              tone={plan.blocked.length ? 'bad' : 'ok'}
            />
            <button
              type="button"
              className="btn btn--small right"
              onClick={() => void handleRecompute()}
              disabled={busy || !projectId}
              title="Re-read the filesystem, re-resolve dependencies and recompute every layer."
            >
              {busy ? 'DERIVING…' : 'RE-DERIVE'}
            </button>
          </div>

          {BUCKETS.map(({ bucket, label, blurb }) => {
            const items = itemsFor(plan, bucket);
            if (items.length === 0 && bucket !== 'NOW') return null;
            return (
              <div className="planner-bucket" key={bucket}>
                <div className="planner-bucket__title">
                  <span>{label}</span>
                  <span className="mono">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div className="empty">Nothing is actionable right now.</div>
                ) : (
                  items.map((item) => (
                    <PlannerItemRow
                      key={`${bucket}:${item.layerId}:${item.actionType}:${item.targetVersion ?? ''}`}
                      item={item}
                      bucket={bucket}
                      onSelectLayer={onSelectLayer}
                    />
                  ))
                )}
                <span className="small muted">{blurb}</span>
              </div>
            );
          })}

          <div className="small muted mono" title={plan.generatedAt}>
            derived {plan.generatedAt} · wave {plan.wave} · {plan.layers.length} layers
          </div>
        </>
      ) : (
        <div className="empty">The planner has nothing to show until a project is loaded.</div>
      )}

      <div className="divider" />

      <ChatPanel projectId={projectId} onChanged={onChanged} />
    </div>
  );
}
