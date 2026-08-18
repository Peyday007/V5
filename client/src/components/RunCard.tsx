/**
 * One research run: one attempt, with the exact prompt it was issued with.
 *
 * Two things drive the design. First, the prompt and the attachment list stored
 * on the run are the product — no credentials are wired up, so COPY PROMPT and
 * COPY REQUIRED ATTACHMENT LIST are how work leaves the platform, and they copy
 * what was persisted rather than anything re-derived here (invariant 10).
 *
 * Second, failed attempts are evidence. A failed run keeps its prompt, packet
 * and failure reason, and this card offers it no action that would overwrite or
 * hide any of that — the way forward from a failure is REDO, which creates a
 * new child attempt and leaves the old one intact (invariant 5).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditVerdict, ResearchRun, RunStatus } from '../../../server/domain/types.ts';
import type { RunDetailResponse } from '../lib/api.ts';
import { Api, ApiError, copyToClipboard } from '../lib/api.ts';
import { Badge } from './Badge.tsx';

/** Declared here, not imported: the client never pulls a value out of the server. */
const AUDIT_VERDICTS: readonly AuditVerdict[] = [
  'PASS',
  'KEEP',
  'PATCH',
  'REDO',
  'MISSING_DEPENDENCY',
  'MORE_RESEARCH',
  'READY_FOR_SYNTHESIS',
  'READY_TO_FREEZE',
  'BLOCKED',
];

const NOT_STARTED: ReadonlySet<RunStatus> = new Set<RunStatus>(['PLANNED', 'READY', 'BLOCKED']);
const IN_FLIGHT: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'PLANNED',
  'READY',
  'BLOCKED',
  'RUNNING',
]);
const AUDITABLE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'RUNNING',
  'COMPLETE',
  'AUDIT_REQUIRED',
  'REDO_REQUIRED',
  'APPROVED',
]);

type Panel = 'NONE' | 'COMPLETE' | 'FAIL' | 'AUDIT' | 'REDO';

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function RunCard(props: { run: ResearchRun; onChanged(): void }): JSX.Element {
  const { run, onChanged } = props;

  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [panel, setPanel] = useState<Panel>('NONE');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [resultText, setResultText] = useState('');
  const [registerDocument, setRegisterDocument] = useState(true);
  const [registerVersion, setRegisterVersion] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [failureReason, setFailureReason] = useState('');
  const [redoReason, setRedoReason] = useState('');
  const [verdict, setVerdict] = useState<AuditVerdict>('PASS');
  const [auditSummary, setAuditSummary] = useState('');
  const [auditText, setAuditText] = useState('');

  const aliveRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  /** The run row alone cannot say whether its packet is still complete, or what
   *  the audit made of it — those are derived, so they are read from the server. */
  const loadDetail = useCallback(async (): Promise<void> => {
    try {
      const next = await Api.run(run.id);
      if (aliveRef.current) setDetail(next);
    } catch {
      // The card is still fully usable from the run row itself; the extra
      // context is a bonus, not a precondition.
      if (aliveRef.current) setDetail(null);
    }
  }, [run.id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, run.updatedAt]);

  const perform = useCallback(
    async (action: () => Promise<unknown>, message: string): Promise<void> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        await loadDetail();
        onChanged();
        if (aliveRef.current) {
          setPanel('NONE');
          setNotice(message);
        }
      } catch (err) {
        if (aliveRef.current) setError(describeError(err));
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [loadDetail, onChanged],
  );

  const copy = useCallback(async (key: string, text: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? key : `${key}:failed`);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 2500);
  }, []);

  const copyLabel = (key: string, idle: string): string => {
    if (copied === key) return 'COPIED';
    if (copied === `${key}:failed`) return 'COPY FAILED';
    return idle;
  };

  const completeRun = useCallback((): void => {
    const text = resultText.trim();
    const chosen = file;
    void perform(async () => {
      if (chosen) {
        // The uploaded artifact registers the document under the platform's own
        // filename and finishes the run in one step.
        await Api.uploadRunResult(run.id, chosen);
        if (text) await Api.completeRun(run.id, { resultText: text, register: false });
        return;
      }
      const register = registerDocument
        ? registerVersion.trim()
          ? { version: registerVersion.trim() }
          : {}
        : false;
      await Api.completeRun(run.id, text ? { resultText: text, register } : { register });
    }, chosen ? 'Result file registered and the run marked complete.' : 'Run marked complete.');
    setFile(null);
    setResultText('');
    setRegisterVersion('');
  }, [perform, run.id, resultText, file, registerDocument, registerVersion]);

  const latestAudit = detail?.audits[0] ?? null;
  const lineage = detail?.lineage ?? [];
  const dependencies = detail?.dependencies ?? null;
  const failed = run.status === 'FAILED';
  const canStart = NOT_STARTED.has(run.status);
  const canFinish = IN_FLIGHT.has(run.status);
  const canAudit = AUDITABLE.has(run.status);
  const hasLineage = run.attemptNumber > 1 || Boolean(run.parentRunId) || Boolean(run.redoReason);

  return (
    <div className={`card ${failed ? 'card--bad' : ''}`.trim()}>
      <div className="card__title">
        <span className="truncate">
          {run.runType} {run.targetVersion ?? ''} · ATTEMPT {run.attemptNumber}
        </span>
        <Badge status={run.status} />
      </div>

      <div className="card__meta">
        <span>
          <b>RUN</b> <span className="mono">{run.id}</span>
        </span>
        <span>
          <b>PROVIDER</b> {run.provider ?? 'manual (copy/paste)'}
        </span>
        <span>
          <b>MODEL</b> {run.model ?? '—'}
        </span>
        <span>
          <b>CREATED</b> {formatWhen(run.createdAt)}
        </span>
        {run.startedAt ? (
          <span>
            <b>STARTED</b> {formatWhen(run.startedAt)}
          </span>
        ) : null}
        {run.completedAt ? (
          <span>
            <b>COMPLETED</b> {formatWhen(run.completedAt)}
          </span>
        ) : null}
        {run.failedAt ? (
          <span>
            <b>FAILED</b> {formatWhen(run.failedAt)}
          </span>
        ) : null}
      </div>

      <div className="kv">
        <span className="kv__key">CONVERSATION TITLE</span>
        <span className="kv__value">{run.expectedConversationTitle ?? '—'}</span>
        <span className="kv__key">FILENAME</span>
        <span className="kv__value">{run.expectedFilename ?? '—'}</span>
        <span className="kv__key">REQUIRED ATTACHMENTS</span>
        <span className="kv__value">
          {run.requiredAttachments.length > 0 ? run.requiredAttachments.join(' · ') : 'none'}
        </span>
        {run.targetDocumentId ? (
          <>
            <span className="kv__key">TARGET DOCUMENT</span>
            <span className="kv__value">{run.targetDocumentId}</span>
          </>
        ) : null}
      </div>

      {hasLineage ? (
        <div className="notice small">
          <span className="strong">REDO LINEAGE:</span> attempt {run.attemptNumber}
          {run.parentRunId ? (
            <>
              {' · parent run '}
              <span className="mono">{run.parentRunId}</span>
            </>
          ) : null}
          {run.redoReason ? <> · reason: {run.redoReason}</> : null}
          {lineage.length > 1 ? (
            <div className="row small muted">
              {lineage.map((attempt) => (
                <span
                  key={attempt.id}
                  className="tag"
                  title={`${attempt.id} — ${attempt.status}`}
                >
                  #{attempt.attemptNumber} {attempt.runType} {attempt.status}
                  {attempt.id === run.id ? ' ←' : ''}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {run.dependencyOverride ? (
        <div className="inconsistent small">
          DEPENDENCY OVERRIDE — this run was created with an incomplete source packet.{' '}
          {run.dependencyOverrideReason ?? 'No reason was recorded.'}
        </div>
      ) : null}

      {failed ? (
        <div className="stack stack--tight">
          <div className="bad">FAILED: {run.failureReason ?? 'no reason recorded'}</div>
          <div className="small muted">
            This attempt is kept exactly as it was — prompt, packet and failure reason — because a
            redo must be able to show what went wrong. Use REDO to create the next attempt.
          </div>
        </div>
      ) : null}

      {dependencies ? (
        <div className="row small">
          <span
            className={
              dependencies.ready ? 'checklist__summary--ready' : 'checklist__summary--blocked'
            }
          >
            PACKET {dependencies.summary}
          </span>
          {dependencies.blocked ? (
            <span className="blocked-flag">
              RUN BLOCKED — MISSING: {dependencies.missing.join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {latestAudit ? (
        <div className="row small">
          <Badge status={latestAudit.verdict} />
          <span className="muted">{latestAudit.summary}</span>
        </div>
      ) : null}

      {run.resultText ? (
        <details>
          <summary className="small muted">RESULT TEXT</summary>
          <pre className="pre pre--short">{run.resultText}</pre>
        </details>
      ) : null}

      {run.prompt ? (
        <details>
          <summary className="small muted">PERSISTED PROMPT</summary>
          <pre className="pre pre--short">{run.prompt}</pre>
        </details>
      ) : null}

      {notice ? <div className="notice small">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="card__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!run.prompt}
          title={run.prompt ? 'Copy the exact prompt stored with this run' : 'This run has no prompt stored'}
          onClick={() => void copy(`prompt:${run.id}`, run.prompt ?? '')}
        >
          {copyLabel(`prompt:${run.id}`, 'COPY PROMPT')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={run.requiredAttachments.length === 0}
          onClick={() => void copy(`attachments:${run.id}`, run.requiredAttachments.join('\n'))}
        >
          {copyLabel(`attachments:${run.id}`, 'COPY REQUIRED ATTACHMENT LIST')}
        </button>

        {!failed && canStart ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void perform(() => Api.startRun(run.id), 'Run started.')}
          >
            START
          </button>
        ) : null}
        {!failed && canFinish ? (
          <button
            type="button"
            className={`btn ${panel === 'COMPLETE' ? 'btn--active' : ''}`.trim()}
            disabled={busy}
            onClick={() => setPanel(panel === 'COMPLETE' ? 'NONE' : 'COMPLETE')}
          >
            COMPLETE
          </button>
        ) : null}
        {!failed && canFinish ? (
          <button
            type="button"
            className={`btn ${panel === 'FAIL' ? 'btn--active' : ''}`.trim()}
            disabled={busy}
            onClick={() => setPanel(panel === 'FAIL' ? 'NONE' : 'FAIL')}
          >
            FAIL
          </button>
        ) : null}
        {!failed && canAudit ? (
          <button
            type="button"
            className={`btn ${panel === 'AUDIT' ? 'btn--active' : ''}`.trim()}
            disabled={busy}
            onClick={() => setPanel(panel === 'AUDIT' ? 'NONE' : 'AUDIT')}
          >
            AUDIT
          </button>
        ) : null}
        <button
          type="button"
          className={`btn ${panel === 'REDO' ? 'btn--active' : ''}`.trim()}
          disabled={busy}
          title="Create a new attempt. The current attempt is never modified or deleted."
          onClick={() => setPanel(panel === 'REDO' ? 'NONE' : 'REDO')}
        >
          REDO
        </button>
      </div>

      {panel === 'COMPLETE' ? (
        <div className="stack stack--tight">
          <div className="field">
            <label>RESULT TEXT (OPTIONAL)</label>
            <textarea
              className="textarea"
              value={resultText}
              placeholder="Paste the model's report here to store it as this run's document."
              onChange={(event) => setResultText(event.target.value)}
            />
          </div>
          <div className="field">
            <label>RETURNED FILE (OPTIONAL)</label>
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          {file ? (
            <div className="small muted">
              {file.name} will be stored under the platform's own filename ({run.expectedFilename ??
                'derived from the layer and version'}) and registered as this run's document.
            </div>
          ) : (
            <>
              <div className="field field--inline">
                <input
                  id={`register-${run.id}`}
                  type="checkbox"
                  checked={registerDocument}
                  onChange={(event) => setRegisterDocument(event.target.checked)}
                />
                <label htmlFor={`register-${run.id}`}>REGISTER THIS RUN&apos;S DOCUMENT</label>
                <input
                  className="input input--narrow"
                  value={registerVersion}
                  placeholder={run.targetVersion ?? 'version'}
                  onChange={(event) => setRegisterVersion(event.target.value)}
                />
              </div>
              <div className="small muted">
                With result text the document is stored as a real file; without it the document is
                registered as EXPECTED so the layer can name exactly what it is waiting for.
              </div>
            </>
          )}
          <div className="card__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={completeRun}>
              RECORD COMPLETION
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPanel('NONE')}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'FAIL' ? (
        <div className="stack stack--tight">
          <div className="field">
            <label>WHY DID THIS ATTEMPT FAIL?</label>
            <textarea
              className="textarea"
              value={failureReason}
              placeholder="The model ignored the source packet and rewrote the foundation document."
              onChange={(event) => setFailureReason(event.target.value)}
            />
          </div>
          <div className="small muted">
            Nothing is deleted: the prompt, the packet and any partial result stay on the run.
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy || failureReason.trim().length === 0}
              onClick={() => {
                const reason = failureReason.trim();
                setFailureReason('');
                void perform(() => Api.failRun(run.id, reason), 'Attempt recorded as failed.');
              }}
            >
              MARK FAILED
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPanel('NONE')}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'AUDIT' ? (
        <div className="stack stack--tight">
          <div className="row">
            <div className="field">
              <label>VERDICT</label>
              <select
                className="select"
                value={verdict}
                onChange={(event) => setVerdict(event.target.value as AuditVerdict)}
              >
                {AUDIT_VERDICTS.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label>SUMMARY</label>
              <input
                className="input"
                value={auditSummary}
                placeholder="One sentence: what the audit concluded."
                onChange={(event) => setAuditSummary(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label>OR PASTE THE AUDIT JSON THE PROMPT ASKED FOR</label>
            <textarea
              className="textarea"
              value={auditText}
              placeholder='{"verdict":"MORE_RESEARCH","summary":"…","missingDocuments":["…"]}'
              onChange={(event) => setAuditText(event.target.value)}
            />
          </div>
          <div className="small muted">
            The AUDITS tab records full findings. Either way the result is stored structured, never
            as prose alone.
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                const text = auditText.trim();
                const summary = auditSummary.trim();
                const body: Record<string, unknown> = text
                  ? { text, ...(summary ? { summary } : {}) }
                  : { verdict, summary };
                setAuditText('');
                setAuditSummary('');
                void perform(() => Api.auditRun(run.id, body), 'Audit recorded against this run.');
              }}
            >
              RECORD AUDIT
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPanel('NONE')}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'REDO' ? (
        <div className="stack stack--tight">
          <div className="field">
            <label>WHY IS THIS BEING REDONE?</label>
            <textarea
              className="textarea"
              value={redoReason}
              placeholder="Attempt 1 duplicated the foundation layer instead of expanding it."
              onChange={(event) => setRedoReason(event.target.value)}
            />
          </div>
          <div className="small muted">
            A redo is a new attempt with the same target and the same source packet, carrying this
            attempt&apos;s audit forward. This run stays exactly as it is.
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || redoReason.trim().length === 0}
              onClick={() => {
                const reason = redoReason.trim();
                setRedoReason('');
                void perform(
                  () => Api.redoRun(run.id, reason),
                  'Redo run created. The previous attempt is preserved.',
                );
              }}
            >
              CREATE REDO RUN
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPanel('NONE')}>
              CANCEL
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
