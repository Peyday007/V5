/**
 * Watching a research assignment work.
 *
 * The thing a person needs from this screen is not a spinner. It is an answer to
 * "what is it actually doing, and can I believe the result" — so the panel is
 * built around the fragments: how many were planned, which are queued, running,
 * accepted, blocked or rejected, how much evidence each one has, how many
 * repairs it took, and which claims were thrown away and why.
 *
 * Synthesis readiness is stated rather than implied, because the whole design
 * rests on it: a report is written from accepted fragments only, and a fragment
 * nobody could evidence contributes nothing rather than something weak.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Layer } from '../../../server/domain/types.ts';
import type {
  GateResult,
  ResearchClaim,
  ResearchFragment,
  ResearchReadiness,
  ResearchView,
} from '../lib/api.ts';
import { Api, ApiError } from '../lib/api.ts';
import { Badge, Pill } from './Badge.tsx';

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Statuses in the order a reader wants them: worst news first. */
const FRAGMENT_ORDER = [
  'RUNNING',
  'VALIDATING',
  'QUEUED',
  'PLANNED',
  'BLOCKED',
  'REJECTED',
  'NEEDS_HUMAN',
  'CANCELLED',
  'ACCEPTED',
];

function coverageOf(fragment: ResearchFragment): GateResult | null {
  return (fragment.verdictDetail as GateResult | null) ?? null;
}

function toneFor(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'ACCEPTED') return 'ok';
  if (status === 'REJECTED' || status === 'NEEDS_HUMAN') return 'bad';
  if (status === 'BLOCKED') return 'warn';
  return 'muted';
}

/** One fragment: its brief, its coverage, its repairs and its rejected claims. */
function FragmentCard(props: {
  fragment: ResearchFragment;
  attempts: ResearchFragment[];
  claims: ResearchClaim[];
}): JSX.Element {
  const { fragment, attempts, claims } = props;
  const [open, setOpen] = useState(false);
  const gate = coverageOf(fragment);
  const accepted = claims.filter((claim) => claim.accepted);
  const rejected = claims.filter((claim) => !claim.accepted);

  return (
    <div className={`card ${fragment.status === 'REJECTED' ? 'card--bad' : ''}`}>
      <div className="spread">
        <div className="row wrap">
          <span className="mono muted small">#{fragment.fragmentIndex + 1}</span>
          <Badge status={fragment.status} />
          <strong>{fragment.fragmentKey}</strong>
          {attempts.length > 1 ? (
            <Pill label="ATTEMPTS" value={attempts.length} tone="warn" />
          ) : null}
        </div>
        <div className="row">
          {fragment.integrityVerdict ? (
            <Pill
              label="INTEGRITY"
              value={fragment.integrityVerdict}
              tone={fragment.integrityVerdict === 'PASS' ? 'ok' : 'bad'}
            />
          ) : null}
          {fragment.sufficiencyVerdict ? (
            <Pill
              label="SUFFICIENCY"
              value={fragment.sufficiencyVerdict}
              tone={fragment.sufficiencyVerdict === 'SUFFICIENT' ? 'ok' : 'warn'}
            />
          ) : null}
          <Pill label="CLAIMS" value={`${accepted.length} kept / ${rejected.length} rejected`} />
        </div>
      </div>

      <div className="card__body">{fragment.question}</div>

      <div className="card__meta muted small">
        {[
          fragment.geography,
          fragment.timeframe,
          fragment.population,
          `≥ ${fragment.minIndependentSources} independent sources`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>

      {gate && gate.coverage.length > 0 ? (
        <div className="row wrap">
          {gate.coverage.map((lane) => (
            <Pill
              key={lane.lane}
              label={lane.lane}
              value={`${lane.independentSources} src / ${lane.acceptedClaims} claims`}
              tone={lane.meetsThreshold ? 'ok' : 'warn'}
            />
          ))}
        </div>
      ) : null}

      {fragment.blockedReason ? <div className="warn small">{fragment.blockedReason}</div> : null}
      {fragment.repairStrategy ? (
        <div className="muted small">
          <strong>Repair {fragment.attempt}:</strong> {fragment.repairStrategy}
        </div>
      ) : null}

      <div className="row">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setOpen(!open)}>
          {open ? 'HIDE EVIDENCE' : `SHOW EVIDENCE (${claims.length})`}
        </button>
        {gate && gate.unresolvedGaps.length > 0 ? (
          <span className="muted small">{gate.unresolvedGaps.length} unresolved gap(s)</span>
        ) : null}
      </div>

      {open ? (
        <div className="stack stack--tight">
          {claims.length === 0 ? (
            <div className="empty">This attempt produced no claims.</div>
          ) : (
            claims.map((claim) => (
              <div key={claim.id} className={`card ${claim.accepted ? '' : 'card--muted'}`}>
                <div className="row wrap">
                  <Badge status={claim.accepted ? 'ACCEPTED' : 'EXCLUDED'} />
                  <span className="mono small muted">{claim.id}</span>
                  {claim.derived ? <Pill label="DERIVED" value={claim.derivedFrom.length} /> : null}
                  {claim.contradictionState !== 'UNCHALLENGED' ? (
                    <Badge status={claim.contradictionState} />
                  ) : null}
                </div>
                <div className="card__body small">{claim.claim}</div>
                {claim.sourceUrl ? (
                  <div className="muted small">
                    <a href={claim.sourceUrl} target="_blank" rel="noreferrer" className="mono">
                      {claim.sourceUrl}
                    </a>
                    {claim.sourcePublisher ? ` — ${claim.sourcePublisher}` : ''}
                    {claim.sourceDate ? ` (${claim.sourceDate})` : ''}
                  </div>
                ) : (
                  <div className="warn small">No source URL, so this is not evidence.</div>
                )}
                {claim.evidenceExcerpt ? (
                  <pre className="pre pre--short">
                    “{claim.evidenceExcerpt}”{claim.evidenceLocator ? ` — ${claim.evidenceLocator}` : ''}
                  </pre>
                ) : null}
                {claim.rejectionReason ? (
                  <div className="bad small">{claim.rejectionReason}</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ResearchPanel(props: {
  layer: Layer;
  onChanged(): void;
}): JSX.Element {
  const { layer } = props;
  const [readiness, setReadiness] = useState<ResearchReadiness | null>(null);
  const [view, setView] = useState<ResearchView | null>(null);
  const [assignment, setAssignment] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  /** Follow one job live. The server sends the whole state with each step. */
  const watch = useCallback(
    (orchestrationId: string) => {
      closeStream();
      const source = new EventSource(`/api/research/${encodeURIComponent(orchestrationId)}/stream`);
      source.addEventListener('state', (event) => {
        setView(JSON.parse((event as MessageEvent<string>).data) as ResearchView);
      });
      source.addEventListener('progress', (event) => {
        const progress = JSON.parse((event as MessageEvent<string>).data) as { message: string };
        setMessage(progress.message);
      });
      source.onerror = () => {
        // The stream ends when the job does; the last state is already rendered.
        closeStream();
      };
      streamRef.current = source;
    },
    [closeStream],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ready, jobs] = await Promise.all([
          Api.researchReadiness(),
          Api.layerResearch(layer.id),
        ]);
        if (cancelled) return;
        setReadiness(ready);
        const latest = jobs.orchestrations[0];
        if (latest) {
          setView(await Api.research(latest.id));
          if (!['COMPLETE', 'CANCELLED', 'FAILED'].includes(latest.status)) watch(latest.id);
        } else {
          setView(null);
        }
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [layer.id, watch, closeStream]);

  const start = useCallback(async () => {
    if (assignment.trim().length === 0) {
      setError('Describe what this research has to establish.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await Api.startResearch(layer.id, {
        assignment: assignment.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setView(started);
      setAssignment('');
      watch(started.orchestration.id);
      props.onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [assignment, title, layer.id, watch, props]);

  const act = useCallback(
    async (what: () => Promise<ResearchView>) => {
      setBusy(true);
      setError(null);
      try {
        const next = await what();
        setView(next);
        props.onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [props],
  );

  const worker = readiness?.worker;
  const workerReady = Boolean(worker?.installed && worker?.authenticated && worker?.automationReady);
  const orchestration = view?.orchestration ?? null;
  const fragments = view?.fragments ?? [];
  const sorted = [...fragments].sort(
    (a, b) => FRAGMENT_ORDER.indexOf(a.status) - FRAGMENT_ORDER.indexOf(b.status),
  );
  const active =
    orchestration !== null &&
    !['COMPLETE', 'CANCELLED', 'FAILED', 'NEEDS_HUMAN', 'INTERRUPTED'].includes(orchestration.status);

  return (
    <div className="section">
      <div className="section__title">STAGED RESEARCH</div>

      {error ? (
        <div className="error spread">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setError(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      {/* Two readiness answers, never merged into one optimistic light. */}
      <div className="row wrap">
        <Pill label="ENGINE" value="ready" tone="ok" />
        <Pill
          label="WORKER"
          value={workerReady ? (worker?.version ?? 'ready') : 'not ready'}
          tone={workerReady ? 'ok' : 'warn'}
        />
        {readiness ? (
          <Pill label="QUEUE" value={readiness.orchestration.queueDepth} />
        ) : null}
      </div>
      {worker && !workerReady ? <div className="warn small">{worker.message}</div> : null}

      {orchestration === null ? (
        <div className="stack stack--tight">
          <label className="field">
            <span>TITLE (optional)</span>
            <input
              className="input"
              value={title}
              placeholder={`${layer.name} research`}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>WHAT MUST THIS ESTABLISH?</span>
            <textarea
              className="textarea"
              value={assignment}
              placeholder="The question this layer needs answered, and the boundaries that matter."
              onChange={(event) => setAssignment(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void start()}
              disabled={busy}
            >
              START RESEARCH
            </button>
            <span className="muted small">
              Brain decomposes this into bounded fragments, researches each one separately, and
              only synthesizes from the fragments whose evidence holds up.
            </span>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="spread">
            <div className="row wrap">
              <Badge status={orchestration.status} />
              <strong>{orchestration.title}</strong>
              {orchestration.currentPass ? <Badge status={orchestration.currentPass} /> : null}
              {view?.running ? <span className="muted small">running…</span> : null}
            </div>
            <div className="row">
              {active ? (
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  disabled={busy}
                  onClick={() => void act(() => Api.cancelResearch(orchestration.id))}
                >
                  CANCEL
                </button>
              ) : null}
              {['INTERRUPTED', 'AWAITING_REPAIR', 'NEEDS_HUMAN', 'FAILED'].includes(
                orchestration.status,
              ) ? (
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const next = await Api.resumeResearch(orchestration.id);
                      watch(orchestration.id);
                      return next;
                    })
                  }
                >
                  RESUME
                </button>
              ) : null}
            </div>
          </div>

          {message ? <div className="notice small">{message}</div> : null}

          <div className="row wrap">
            <Pill label="FRAGMENTS PLANNED" value={fragments.length} />
            {FRAGMENT_ORDER.filter((status) => (view?.fragmentsByStatus[status] ?? 0) > 0).map(
              (status) => (
                <Pill
                  key={status}
                  label={status}
                  value={view?.fragmentsByStatus[status] ?? 0}
                  tone={toneFor(status)}
                />
              ),
            )}
            <Pill
              label="REPAIRS"
              value={(view?.attempts.length ?? 0) - fragments.length}
              tone={(view?.attempts.length ?? 0) > fragments.length ? 'warn' : 'muted'}
            />
          </div>

          <div className="row wrap">
            <Pill label="CLAIMS" value={view?.ledger.total ?? 0} />
            <Pill label="SOURCED" value={view?.ledger.sourced ?? 0} tone="ok" />
            <Pill
              label="UNSOURCED"
              value={view?.ledger.unsourced ?? 0}
              tone={(view?.ledger.unsourced ?? 0) > 0 ? 'warn' : 'muted'}
            />
            <Pill label="DISTINCT SOURCES" value={view?.ledger.distinctSources ?? 0} />
            {(view?.ledger.contested ?? 0) + (view?.ledger.refuted ?? 0) > 0 ? (
              <Pill
                label="CONTESTED / REFUTED"
                value={`${view?.ledger.contested ?? 0} / ${view?.ledger.refuted ?? 0}`}
                tone="warn"
              />
            ) : null}
            <Pill
              label="SYNTHESIS"
              value={view?.synthesisReady ? 'ready' : 'not ready'}
              tone={view?.synthesisReady ? 'ok' : 'muted'}
            />
          </div>

          {orchestration.failureReason ? (
            <div className="warn small">{orchestration.failureReason}</div>
          ) : null}
          {orchestration.cancelReason ? (
            <div className="muted small">Cancelled: {orchestration.cancelReason}</div>
          ) : null}

          {view?.document ? (
            <div className="notice">
              Filed as <strong>{view.document.canonicalName}</strong>
              {view.audit ? (
                <>
                  {' '}
                  · audit verdict <Badge status={view.audit.verdict} />
                </>
              ) : (
                ' · not yet audited'
              )}
            </div>
          ) : null}

          <div className="stack stack--tight">
            {sorted.map((fragment) => (
              <FragmentCard
                key={fragment.id}
                fragment={fragment}
                attempts={(view?.attempts ?? []).filter(
                  (attempt) => attempt.fragmentKey === fragment.fragmentKey,
                )}
                claims={(view?.claims ?? []).filter((claim) => claim.fragmentId === fragment.id)}
              />
            ))}
          </div>

          <details>
            <summary className="muted small">
              Passes ({view?.passes.length ?? 0}) — every prompt and reply, in order
            </summary>
            <table className="table">
              <thead>
                <tr>
                  <th>PASS</th>
                  <th>FRAGMENT</th>
                  <th>STATUS</th>
                  <th>MS</th>
                  <th>DETAIL</th>
                </tr>
              </thead>
              <tbody>
                {(view?.passes ?? []).map((pass) => (
                  <tr key={pass.id}>
                    <td className="nowrap">
                      <Badge status={pass.passKey} />
                    </td>
                    <td className="mono small">{pass.fragmentId ?? '—'}</td>
                    <td>
                      <Badge status={pass.status} />
                    </td>
                    <td className="mono small">{pass.durationMs ?? ''}</td>
                    <td className="small">{pass.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
