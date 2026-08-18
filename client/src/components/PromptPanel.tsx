/**
 * The prompt workbench for a layer.
 *
 * This is the MVP's execution path. No provider credentials are wired up, so
 * the way research happens is: compile the prompt here, copy it, copy the
 * attachment list, paste both into a research model, bring the report back.
 * The two copy buttons are therefore the loudest controls on the panel, and
 * they copy the compiled text verbatim — never a summary of it.
 *
 * Previewing persists nothing; CREATE RUN is what writes the exact prompt and
 * its attachment list onto a run so the request is recoverable later
 * (invariant 10).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CompiledPrompt,
  DependencyCheckResult,
  LayerStatus,
  RunType,
} from '../../../server/domain/types.ts';
import { Api, ApiError, copyToClipboard } from '../lib/api.ts';

/** The run types a human starts by hand; REDO is created from the run it replaces. */
const RUN_TYPES: readonly RunType[] = ['FOUNDATION', 'EXPANSION', 'SYNTHESIS', 'AUDIT', 'PATCH'];

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Seed the selector from the layer's derived status rather than from whatever
 * was chosen last time: the panel should open on the run the project actually
 * needs next.
 */
function defaultRunType(status: LayerStatus): RunType {
  switch (status) {
    case 'NOT_STARTED':
      return 'FOUNDATION';
    case 'SYNTHESIS_READY':
    case 'SYNTHESIS_RUNNING':
      return 'SYNTHESIS';
    case 'AUDIT_READY':
    case 'AUDITING':
      return 'AUDIT';
    default:
      return 'EXPANSION';
  }
}

function createdRunId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const run = (payload as { run?: unknown }).run;
  if (!run || typeof run !== 'object') return null;
  const id = (run as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

export function PromptPanel(props: { layerId: string; onChanged(): void }): JSX.Element {
  const { layerId, onChanged } = props;

  const [runType, setRunType] = useState<RunType>('EXPANSION');
  const [targetVersion, setTargetVersion] = useState('');
  const [compiled, setCompiled] = useState<CompiledPrompt | null>(null);
  const [dependencies, setDependencies] = useState<DependencyCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const runTypeFieldId = useId();
  const versionFieldId = useId();
  const requestRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const generate = useCallback(
    async (type: RunType, version: string): Promise<void> => {
      const ticket = requestRef.current + 1;
      requestRef.current = ticket;
      setLoading(true);
      setError(null);
      try {
        const preview = await Api.promptPreview(layerId, type, version.trim() || undefined);
        if (requestRef.current !== ticket) return;
        setCompiled(preview.compiled);
        setDependencies(preview.dependencies);
      } catch (err) {
        if (requestRef.current !== ticket) return;
        setCompiled(null);
        setDependencies(null);
        setError(describeError(err));
      } finally {
        if (requestRef.current === ticket) setLoading(false);
      }
    },
    [layerId],
  );

  // Opening the tab should already show a usable prompt: the panel asks the
  // server what this layer needs next and compiles that.
  useEffect(() => {
    let cancelled = false;
    const seed = async (): Promise<void> => {
      let type: RunType = 'EXPANSION';
      let version = '';
      try {
        const detail = await Api.layer(layerId);
        type = defaultRunType(detail.state.status);
        version = detail.state.nextVersion ?? '';
      } catch {
        // The defaults are good enough to compile something the user can adjust.
      }
      if (cancelled) return;
      setRunType(type);
      setTargetVersion(version);
      await generate(type, version);
    };
    void seed();
    return () => {
      cancelled = true;
    };
  }, [layerId, generate]);

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

  const createRun = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const version = targetVersion.trim();
      const created = await Api.createRun(layerId, {
        runType,
        ...(version ? { targetVersion: version } : {}),
      });
      const id = createdRunId(created);
      onChanged();
      setNotice(
        `Run created${id ? ` (${id})` : ''}. Its exact prompt and attachment list are now stored on the run — open the RUNS tab to copy them.`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [layerId, runType, targetVersion, onChanged]);

  return (
    <div className="stack">
      <div className="row">
        <div className="field">
          <label htmlFor={runTypeFieldId}>RUN TYPE</label>
          <select
            id={runTypeFieldId}
            className="select"
            value={runType}
            onChange={(event) => {
              const next = event.target.value as RunType;
              setRunType(next);
              setNotice(null);
              void generate(next, targetVersion);
            }}
          >
            {RUN_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={versionFieldId}>TARGET VERSION (OPTIONAL)</label>
          <input
            id={versionFieldId}
            className="input input--narrow"
            value={targetVersion}
            placeholder="v1G"
            onChange={(event) => setTargetVersion(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={loading}
          onClick={() => {
            setNotice(null);
            void generate(runType, targetVersion);
          }}
        >
          {loading ? 'COMPILING…' : 'GENERATE PROMPT'}
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {compiled ? (
        <>
          <div className="card card--active">
            <div className="card__title">
              <span>COPY AND RUN</span>
              <span className="tag">{compiled.targetVersion}</span>
            </div>
            <div className="card__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void copy('prompt', compiled.prompt)}
              >
                {copyLabel('prompt', 'COPY PROMPT')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={compiled.requiredAttachments.length === 0}
                onClick={() => void copy('attachments', compiled.requiredAttachments.join('\n'))}
              >
                {copyLabel('attachments', 'COPY REQUIRED ATTACHMENT LIST')}
              </button>
            </div>
            <div className="kv">
              <span className="kv__key">TARGET DOCUMENT</span>
              <span className="kv__value">{compiled.targetCanonicalName}</span>
              <span className="kv__key">CONVERSATION TITLE</span>
              <span className="kv__value">{compiled.expectedConversationTitle}</span>
              <span className="kv__key">FILENAME</span>
              <span className="kv__value">{compiled.expectedFilename}</span>
            </div>
            <div className="small muted">
              Name the conversation and the returned file exactly as above — that is how the import
              step recognises the document without you having to explain it.
            </div>
          </div>

          <div className="section">
            <div className="section__title">REQUIRED ATTACHMENTS</div>
            {dependencies && dependencies.items.length > 0 ? (
              <div className="stack stack--tight">
                <ul className="checklist">
                  {dependencies.items.map((item) => (
                    <li
                      key={`${item.canonicalName}:${item.dependencyType}`}
                      className={`checklist__item ${item.present ? 'checklist__item--ok' : 'checklist__item--bad'}`}
                    >
                      <span className="checklist__mark">{item.present ? '✓' : '✗'}</span>
                      <span className="checklist__name grow">{item.canonicalName}</span>
                      {item.required ? null : <span className="tag">OPTIONAL</span>}
                      {item.fileMissing ? (
                        <span className="inconsistent">FILE MISSING</span>
                      ) : (
                        <span className="small muted">{item.status ?? 'NOT REGISTERED'}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div
                  className={`checklist__summary ${dependencies.ready ? 'checklist__summary--ready' : 'checklist__summary--blocked'}`}
                >
                  {dependencies.summary ||
                    `${dependencies.presentCount} / ${dependencies.requiredCount} READY`}
                </div>
                {dependencies.blocked ? (
                  <div className="blocked-flag">
                    RUN BLOCKED — MISSING: {dependencies.missing.join(', ')}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="empty">This run requires no attachments.</div>
            )}
          </div>

          <div className="section">
            <div className="section__title">COMPILED PROMPT</div>
            <div className="row">
              {compiled.sections.map((section) => (
                <span key={section.key} className="tag">
                  {section.heading}
                </span>
              ))}
            </div>
            <pre className="pre pre--tall">{compiled.prompt}</pre>
            <details>
              <summary className="small muted">SECTION BY SECTION</summary>
              <div className="stack stack--tight">
                {compiled.sections.map((section) => (
                  <div key={section.key}>
                    <div className="section__title">{section.heading}</div>
                    <pre className="pre pre--short">{section.body}</pre>
                  </div>
                ))}
              </div>
            </details>
          </div>

          <div className="card__actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void createRun()}>
              CREATE RUN
            </button>
            <span className="small muted">
              This preview persists nothing. CREATE RUN stores this exact prompt, its attachment
              list and the expected filenames on a run, so what was asked for stays recoverable.
            </span>
          </div>
        </>
      ) : loading ? (
        <div className="empty">Compiling the prompt…</div>
      ) : (
        <div className="empty">
          No prompt compiled yet. Choose a run type and press GENERATE PROMPT.
        </div>
      )}
    </div>
  );
}
