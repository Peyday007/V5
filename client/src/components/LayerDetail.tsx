/**
 * The centre pane: one layer, and everything the user does to it.
 *
 * After every action this pane re-reads `/api/layers/:id` instead of patching
 * what is already on screen. The server recomputes layer status, dependencies
 * and the plan on each mutation, so a locally patched copy would be a second
 * opinion about state — and the user must never have to wonder which one is
 * true (invariant 7).
 *
 * The execution block at the top is deliberately the loudest thing here. The
 * platform ships with no API credentials wired up, so copying the persisted
 * prompt and its attachment list *is* how research actually gets run.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  DependencyCheckResult,
  Document,
  Layer,
  ProjectEvent,
  ResearchRun,
  RunStatus,
} from '../../../server/domain/types.ts';
import type { LayerDetailResponse } from '../lib/api.ts';
import { Api, ApiError, copyToClipboard } from '../lib/api.ts';
import { Badge, Pill } from './Badge.tsx';
import { Modal } from './Modal.tsx';
import { AuditPanel } from './AuditPanel.tsx';
import { DocumentCard } from './DocumentCard.tsx';
import { PromptPanel } from './PromptPanel.tsx';
import { RunCard } from './RunCard.tsx';

const TABS = ['DOCUMENTS', 'RUNS', 'AUDITS', 'DEPENDENCIES', 'HISTORY', 'PROMPT'] as const;
type Tab = (typeof TABS)[number];

/** A run in one of these states is still the thing the user is meant to run. */
const OPEN_RUN_STATUSES = new Set<RunStatus>([
  'RUNNING',
  'READY',
  'PLANNED',
  'BLOCKED',
  'REDO_REQUIRED',
  'AUDIT_REQUIRED',
]);

/** Documents that could serve as a layer's canonical artifact (invariant 6). */
function freezeCandidatesOf(documents: Document[]): Document[] {
  return documents.filter(
    (document) =>
      !document.fileMissing && (document.status === 'COMPLETE' || document.status === 'FROZEN'),
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A 409 from the synthesis endpoint carries the full check result as its detail. */
function asDependencyCheckResult(detail: unknown): DependencyCheckResult | null {
  if (!detail || typeof detail !== 'object') return null;
  const candidate = detail as Partial<DependencyCheckResult>;
  if (!Array.isArray(candidate.items)) return null;
  if (typeof candidate.summary !== 'string') return null;
  return candidate as DependencyCheckResult;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** `Discovery Logic v1G` belongs to the layer whose name it starts with. */
function layerForCanonicalName(canonicalName: string, layers: Layer[]): Layer | null {
  const haystack = canonicalName.trim().toLowerCase();
  let best: Layer | null = null;
  for (const layer of layers) {
    const needle = layer.name.trim().toLowerCase();
    if (!needle || !haystack.startsWith(needle)) continue;
    if (!best || layer.name.length > best.name.length) best = layer;
  }
  return best;
}

function summarisePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || value === '') continue;
    let rendered: string;
    if (Array.isArray(value)) rendered = value.map((entry) => String(entry)).join(', ');
    else if (typeof value === 'object') rendered = JSON.stringify(value);
    else rendered = String(value);
    if (!rendered) continue;
    parts.push(`${key}=${rendered}`);
  }
  const line = parts.join(' · ');
  return line.length > 220 ? `${line.slice(0, 219)}…` : line;
}

/**
 * The spec's dependency checklist: one tick or cross per required document, the
 * `7 / 7 READY` summary, and a red RUN BLOCKED line naming what is missing.
 * A missing document usually belongs to another layer, so its name doubles as a
 * jump to the layer that has to produce it.
 */
function DependencyChecklist(props: {
  result: DependencyCheckResult;
  layers: Layer[];
  onSelectLayer(layerId: string): void;
  /** The layer already on screen — jumping to it would be a no-op. */
  currentLayerId: string | null;
}): JSX.Element {
  const { result, layers, onSelectLayer, currentLayerId } = props;
  if (result.items.length === 0) {
    return (
      <div className="empty">
        This layer needs no attachments right now. Nothing is blocking a run.
      </div>
    );
  }
  return (
    <div className="stack stack--tight">
      <ul className="checklist">
        {result.items.map((item) => {
          const owner = layerForCanonicalName(item.canonicalName, layers);
          return (
            <li
              key={`${item.canonicalName}:${item.dependencyType}`}
              className={`checklist__item ${item.present ? 'checklist__item--ok' : 'checklist__item--bad'}`}
            >
              <span className="checklist__mark">{item.present ? '✓' : '✗'}</span>
              <span className="checklist__name grow">{item.canonicalName}</span>
              <span className="tag">{item.dependencyType.replace(/_/g, ' ')}</span>
              {item.required ? null : <span className="tag">OPTIONAL</span>}
              {item.fileMissing ? (
                <span className="inconsistent" title="Registered in the database but the file is gone from disk">
                  FILE MISSING
                </span>
              ) : (
                <span className="small muted">{item.status ?? 'NOT REGISTERED'}</span>
              )}
              {!item.present && owner && owner.id !== currentLayerId ? (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  onClick={() => onSelectLayer(owner.id)}
                >
                  GO TO {owner.name.toUpperCase()}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div
        className={`checklist__summary ${result.ready ? 'checklist__summary--ready' : 'checklist__summary--blocked'}`}
      >
        {result.summary || `${result.presentCount} / ${result.requiredCount} READY`}
      </div>

      {result.blocked ? (
        <div className="blocked-flag">RUN BLOCKED — MISSING: {result.missing.join(', ')}</div>
      ) : null}

      {result.inconsistent.length > 0 ? (
        <div className="inconsistent">
          INCONSISTENT STATE — registered but not on disk: {result.inconsistent.join(', ')}. Run SCAN
          &amp; RECONCILE.
        </div>
      ) : null}
    </div>
  );
}

export function LayerDetail(props: {
  layerId: string | null;
  layers: Layer[];
  onChanged(): void;
  onSelectLayer(id: string): void;
  /** Bumped by a global refresh: re-fetch, but do not remount and lose UI state. */
  reloadKey?: number;
}): JSX.Element {
  const { layerId, layers, onChanged, onSelectLayer, reloadKey } = props;

  const [detail, setDetail] = useState<LayerDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('DOCUMENTS');
  const [expectedInput, setExpectedInput] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [freezeDocumentId, setFreezeDocumentId] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [blocked, setBlocked] = useState<{ message: string; result: DependencyCheckResult } | null>(
    null,
  );
  const [overrideReason, setOverrideReason] = useState('');

  const expectedFieldId = useId();
  const requestRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const load = useCallback(async (id: string): Promise<void> => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    setLoading(true);
    try {
      const next = await Api.layer(id);
      if (requestRef.current !== ticket) return;
      setDetail(next);
      setExpectedInput(next.layer.expectedVersions.join(', '));
      setError(null);
    } catch (err) {
      if (requestRef.current !== ticket) return;
      setError(describeError(err));
    } finally {
      if (requestRef.current === ticket) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!layerId) {
      requestRef.current += 1;
      setDetail(null);
      return;
    }
    setNotice(null);
    void load(layerId);
  }, [layerId, load]);

  const reload = useCallback(async (): Promise<void> => {
    if (layerId) await load(layerId);
  }, [layerId, load]);

  // A refresh elsewhere in the app re-fetches this pane's data. It deliberately
  // does NOT remount: remounting threw away the open tab and any half-typed
  // audit or prompt, and every chat message triggers a refresh.
  const lastReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (lastReloadKey.current === reloadKey) return;
    lastReloadKey.current = reloadKey;
    void reload();
  }, [reloadKey, reload]);

  /** Every mutation ends the same way: re-read this layer, then the whole screen. */
  const perform = useCallback(
    async (action: () => Promise<unknown>, message: string): Promise<void> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        await reload();
        onChanged();
        setNotice(message);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [reload, onChanged],
  );

  const childChanged = useCallback((): void => {
    void reload().then(() => onChanged());
  }, [reload, onChanged]);

  const copy = useCallback(async (key: string, text: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? key : `${key}:failed`);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 2500);
  }, []);

  const copyLabel = useCallback(
    (key: string, idle: string): string => {
      if (copied === key) return 'COPIED';
      if (copied === `${key}:failed`) return 'COPY FAILED';
      return idle;
    },
    [copied],
  );

  const documents = detail?.documents ?? [];
  const runs = detail?.runs ?? [];

  /** The run whose persisted prompt the user is meant to be executing now. */
  // The EXECUTE card is a call to action, so it must only ever show a run there
  // is still something to do with. Falling back to the newest run with a prompt
  // put it on screen for COMPLETE and FAILED runs, next to an ACTIVE RUNS 0 pill.
  const activeRun = useMemo(
    (): ResearchRun | null =>
      runs.find((run) => OPEN_RUN_STATUSES.has(run.status) && Boolean(run.prompt)) ?? null,
    [runs],
  );

  const freezeCandidates = useMemo(() => freezeCandidatesOf(documents), [documents]);

  const submitSynthesis = useCallback(
    async (override: boolean, reason: string): Promise<void> => {
      if (!layerId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await Api.synthesis(layerId, override ? { override: true, overrideReason: reason } : {});
        setBlocked(null);
        setOverrideReason('');
        await reload();
        onChanged();
        setTab('RUNS');
        setNotice(
          override
            ? 'Synthesis created with an explicit dependency override. The override and its reason are recorded on the run.'
            : 'Synthesis run created. Its exact prompt and attachment list are persisted on the run — open RUNS to copy them.',
        );
      } catch (err) {
        const result = err instanceof ApiError && err.status === 409 ? asDependencyCheckResult(err.detail) : null;
        if (result) {
          setBlocked({ message: describeError(err), result });
        } else {
          setError(describeError(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [layerId, reload, onChanged],
  );

  const saveExpectations = useCallback((): void => {
    if (!layerId) return;
    const versions = expectedInput
      .split(/[,\s]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    void perform(
      () => Api.patchLayer(layerId, { expectedVersions: versions }),
      versions.length > 0
        ? `Expected versions set to ${versions.join(', ')}.`
        : 'Expected versions cleared.',
    );
  }, [layerId, expectedInput, perform]);

  if (!layerId) {
    return <div className="empty">Select a layer on the left to see its workflow.</div>;
  }

  if (!detail) {
    return loading ? (
      <div className="empty">Loading layer…</div>
    ) : (
      <div className="stack">
        <div className="error">{error ?? 'This layer could not be loaded.'}</div>
        <button type="button" className="btn" onClick={() => void reload()}>
          RETRY
        </button>
      </div>
    );
  }

  const { layer, state, dependencies, audits, events } = detail;
  const frozen = state.frozen || layer.status === 'FROZEN';
  const canFreeze = !frozen && freezeCandidates.length > 0;

  return (
    <div className="stack">
      <div className="spread">
        <div className="col">
          <div className="row">
            <h2>{layer.name}</h2>
            <Badge status={state.status} title={state.reason} />
            {layer.statusSource === 'MANUAL' ? (
              <span className="tag" title={layer.manualStatusReason ?? 'Status pinned by hand'}>
                PINNED
              </span>
            ) : null}
            {layer.parked ? <span className="tag">PARKED</span> : null}
          </div>
          <div className="small muted">{state.reason}</div>
        </div>
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setTab('PROMPT')}
            disabled={busy}
          >
            GENERATE PROMPT
          </button>
          <button type="button" className="btn" onClick={() => setTab('AUDITS')} disabled={busy}>
            AUDIT
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void submitSynthesis(false, '')}
            disabled={busy || frozen}
            title="Create the canonical synthesis run for this layer"
          >
            CREATE SYNTHESIS
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFreezeDocumentId(layer.canonicalDocumentId ?? '');
              setFreezeOpen(true);
            }}
            disabled={busy || !canFreeze}
            title={
              frozen
                ? 'This layer is already frozen.'
                : canFreeze
                  ? 'Freeze this layer on one canonical artifact'
                  : 'No canonical artifact exists yet: a layer is never frozen on a promise (invariant 6).'
            }
          >
            FREEZE
          </button>
          {frozen ? (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setReopenOpen(true)}
              disabled={busy}
            >
              REOPEN
            </button>
          ) : null}
        </div>
      </div>

      <div className="row">
        <Pill
          label="DOCS"
          value={`${state.documentsComplete} / ${state.documentsExpected}`}
          tone={
            state.documentsExpected > 0 && state.documentsComplete >= state.documentsExpected
              ? 'ok'
              : 'warn'
          }
        />
        <Pill label="VERSION" value={state.currentVersion ?? '—'} />
        <Pill label="NEXT VERSION" value={state.nextVersion ?? '—'} />
        <Pill
          label="MISSING DEPS"
          value={state.missingDependencies.length}
          tone={state.missingDependencies.length > 0 ? 'bad' : 'ok'}
        />
        <Pill
          label="ACTIVE RUNS"
          value={state.activeRunIds.length}
          tone={state.activeRunIds.length > 0 ? 'warn' : 'muted'}
        />
        <Pill label="AUDIT" value={state.latestAuditVerdict ?? 'none'} />
        {state.inconsistentDocuments.length > 0 ? (
          <Pill label="INCONSISTENT" value={state.inconsistentDocuments.length} tone="bad" />
        ) : null}
      </div>

      <div className="notice">
        <span className="muted">NEXT ACTION: </span>
        <span className="strong">{state.nextAction}</span>
      </div>

      {activeRun ? (
        <div className="card card--active">
          <div className="card__title">
            <span>
              EXECUTE: {activeRun.runType} {activeRun.targetVersion ?? ''}
            </span>
            <Badge status={activeRun.status} />
          </div>
          <div className="kv">
            <span className="kv__key">CONVERSATION TITLE</span>
            <span className="kv__value">{activeRun.expectedConversationTitle ?? '—'}</span>
            <span className="kv__key">FILENAME</span>
            <span className="kv__value">{activeRun.expectedFilename ?? '—'}</span>
            <span className="kv__key">ATTACHMENTS</span>
            <span className="kv__value">
              {activeRun.requiredAttachments.length > 0
                ? activeRun.requiredAttachments.join(' · ')
                : 'none'}
            </span>
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!activeRun.prompt}
              onClick={() => void copy('layer-prompt', activeRun.prompt ?? '')}
            >
              {copyLabel('layer-prompt', 'COPY PROMPT')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={activeRun.requiredAttachments.length === 0}
              onClick={() => void copy('layer-attachments', activeRun.requiredAttachments.join('\n'))}
            >
              {copyLabel('layer-attachments', 'COPY REQUIRED ATTACHMENT LIST')}
            </button>
          </div>
          <div className="small muted">
            This copies the exact prompt persisted with the run, not a re-derived one. No provider
            credentials are wired up: paste it into your research model, attach the listed documents,
            and bring the report back with IMPORT DOCUMENT or COMPLETE.
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="notice spread">
          <span>{notice}</span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setNotice(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="error spread">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setError(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            className={`tab ${tab === entry ? 'tab--active' : ''}`}
            onClick={() => setTab(entry)}
          >
            {entry}
            {entry === 'DOCUMENTS' ? ` (${documents.length})` : null}
            {entry === 'RUNS' ? ` (${runs.length})` : null}
            {entry === 'AUDITS' ? ` (${audits.length})` : null}
            {entry === 'DEPENDENCIES' && dependencies.missing.length > 0
              ? ` (${dependencies.missing.length} MISSING)`
              : null}
          </button>
        ))}
      </div>

      {tab === 'DOCUMENTS' ? (
        <div className="stack">
          <div className="row">
            <div className="field grow">
              <label htmlFor={expectedFieldId}>EXPECTED VERSIONS (COMMA SEPARATED)</label>
              <input
                id={expectedFieldId}
                className="input"
                value={expectedInput}
                placeholder="v1, v1B, v1C, v3.1"
                onChange={(event) => setExpectedInput(event.target.value)}
              />
            </div>
            <button type="button" className="btn" onClick={saveExpectations} disabled={busy}>
              SAVE EXPECTED
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="Set the expectation to the versions that actually exist for this layer"
              onClick={() =>
                void perform(
                  () => Api.deriveExpectations(layer.id),
                  'Expected versions derived from the documents on file.',
                )
              }
            >
              DERIVE FROM DOCUMENTS
            </button>
          </div>

          {state.missingVersions.length > 0 ? (
            <div className="small warn">
              MISSING VERSIONS: {state.missingVersions.join(', ')}
            </div>
          ) : null}

          {documents.length === 0 ? (
            <div className="empty">
              No documents are registered for this layer yet. Use IMPORT DOCUMENT in the top bar, or
              complete a run with its returned file.
            </div>
          ) : (
            documents.map((document) => (
              <DocumentCard key={document.id} document={document} onChanged={childChanged} />
            ))
          )}
        </div>
      ) : null}

      {tab === 'RUNS' ? (
        <div className="stack">
          {runs.length === 0 ? (
            <div className="empty">
              No research runs yet. Open the PROMPT tab to compile one — the run stores the exact
              prompt and attachment list it was created with.
            </div>
          ) : (
            runs.map((run) => <RunCard key={run.id} run={run} onChanged={childChanged} />)
          )}
        </div>
      ) : null}

      {tab === 'AUDITS' ? (
        <AuditPanel layerId={layer.id} audits={audits} runs={runs} onChanged={childChanged} />
      ) : null}

      {tab === 'DEPENDENCIES' ? (
        <div className="stack">
          <div className="small muted">
            The source packet this layer is waiting on. A document counts as present only when it is
            registered, finished, and its file is still on disk.
          </div>
          <DependencyChecklist
            result={dependencies}
            layers={layers}
            onSelectLayer={onSelectLayer}
            currentLayerId={layerId}
          />
        </div>
      ) : null}

      {tab === 'HISTORY' ? (
        <HistoryTable events={events} />
      ) : null}

      {tab === 'PROMPT' ? <PromptPanel layerId={layer.id} onChanged={childChanged} /> : null}

      <Modal
        title="FREEZE LAYER"
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        footer={
          <>
            <span className="muted">
              Freezing supersedes the layer's earlier research. Nothing is deleted — superseded
              documents stay as provenance.
            </span>
            <div className="row">
              <button type="button" className="btn" onClick={() => setFreezeOpen(false)}>
                CANCEL
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => {
                  setFreezeOpen(false);
                  void perform(
                    () => Api.freeze(layer.id, freezeDocumentId || undefined),
                    `${layer.name} is frozen on its canonical artifact.`,
                  );
                }}
              >
                CONFIRM FREEZE
              </button>
            </div>
          </>
        }
      >
        <div className="stack">
          <p>
            Freeze <span className="strong">{layer.name}</span> on one canonical artifact. After
            this, other layers may depend on it and it stops accepting new research until it is
            reopened.
          </p>
          <div className="field">
            <label>CANONICAL ARTIFACT</label>
            <select
              className="select"
              value={freezeDocumentId}
              onChange={(event) => setFreezeDocumentId(event.target.value)}
            >
              <option value="">Use this layer's canonical synthesis document</option>
              {freezeCandidates.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.canonicalName} — {document.documentType} / {document.status}
                </option>
              ))}
            </select>
          </div>
          <div className="small muted">
            Leaving the default asks the server to freeze on the synthesis version. If that document
            does not exist the freeze is refused and names the document it expected, rather than
            freezing on something else.
          </div>
        </div>
      </Modal>

      <Modal
        title="REOPEN LAYER"
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        footer={
          <>
            <span className="muted">The reason is recorded in this layer's history.</span>
            <div className="row">
              <button type="button" className="btn" onClick={() => setReopenOpen(false)}>
                CANCEL
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy || reopenReason.trim().length === 0}
                onClick={() => {
                  const reason = reopenReason.trim();
                  setReopenOpen(false);
                  setReopenReason('');
                  void perform(
                    () => Api.reopen(layer.id, reason),
                    `${layer.name} reopened: ${reason}`,
                  );
                }}
              >
                REOPEN LAYER
              </button>
            </div>
          </>
        }
      >
        <div className="field">
          <label>WHY IS THIS LAYER BEING REOPENED?</label>
          <textarea
            className="textarea"
            value={reopenReason}
            placeholder="New source material invalidates section 4 of the canonical document."
            onChange={(event) => setReopenReason(event.target.value)}
          />
        </div>
      </Modal>

      <Modal
        title="SYNTHESIS BLOCKED — MISSING DEPENDENCIES"
        open={blocked !== null}
        onClose={() => {
          setBlocked(null);
          setOverrideReason('');
        }}
        footer={
          <>
            <span className="muted">
              Invariant 4: no synthesis with missing dependencies unless you override it on purpose.
            </span>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setBlocked(null);
                  setOverrideReason('');
                }}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy || overrideReason.trim().length === 0}
                onClick={() => void submitSynthesis(true, overrideReason.trim())}
              >
                OVERRIDE AND CREATE ANYWAY
              </button>
            </div>
          </>
        }
      >
        {blocked ? (
          <div className="stack">
            <div className="error">{blocked.message}</div>
            <div className="section__title">MISSING DOCUMENTS</div>
            {blocked.result.missing.length > 0 ? (
              <ul className="checklist">
                {blocked.result.missing.map((name) => (
                  <li key={name} className="checklist__item checklist__item--bad">
                    <span className="checklist__mark">✗</span>
                    <span className="checklist__name">{name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">The server did not name a missing document.</div>
            )}
            <div className="section__title">SOURCE PACKET</div>
            <DependencyChecklist
              result={blocked.result}
              layers={layers}
              currentLayerId={layerId}
              onSelectLayer={(id) => {
                setBlocked(null);
                setOverrideReason('');
                onSelectLayer(id);
              }}
            />
            <div className="field">
              <label>WHY OVERRIDE? (REQUIRED, RECORDED ON THE RUN)</label>
              <textarea
                className="textarea"
                value={overrideReason}
                placeholder="The missing expansion is out of scope for this wave; the synthesis will state the gap explicitly."
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/** The layer's own event log — the answer to "how did this layer get here?". */
function HistoryTable(props: { events: ProjectEvent[] }): JSX.Element {
  const events = [...props.events].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (events.length === 0) {
    return <div className="empty">Nothing has happened to this layer yet.</div>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>WHEN</th>
            <th>EVENT</th>
            <th>ENTITY</th>
            <th>DETAIL</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="nowrap mono">{formatWhen(event.createdAt)}</td>
              <td className="nowrap">{event.eventType.replace(/_/g, ' ')}</td>
              <td className="nowrap muted">{event.entityType}</td>
              <td className="small muted wrap">{summarisePayload(event.payload)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
