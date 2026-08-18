/**
 * Import: the first thing a real user does.
 *
 * The opening session is "I have a folder of PDFs from months of research and no
 * idea what state the project is in", so dragging that whole folder onto one
 * large drop zone is the primary path and everything else is secondary. Every
 * file is stored first and classified second (invariant 8: existing on disk is
 * not the same as registered), and when the inference is not confident enough
 * the file is kept under `_unfiled` and shown with its plain-language reasons
 * plus inline controls, so the user corrects a guess instead of repeating work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { DocumentType, ImportResult, Layer } from '../../../server/domain/types.ts';
import { Api, ApiError } from '../lib/api.ts';
import { Pill } from './Badge.tsx';
import { Modal } from './Modal.tsx';

/** Mirrors the server's multer limit; the client chunks rather than 413s. */
const MAX_FILES_PER_REQUEST = 20;
/** Mirrors the server's per-file cap, checked here so one huge file cannot fail a batch. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Guard against a pathological drop of a deeply nested tree. */
const MAX_DIRECTORY_DEPTH = 8;

const DOCUMENT_TYPE_OPTIONS: readonly DocumentType[] = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'CANONICAL',
  'REFERENCE',
];

interface Draft {
  layerId: string;
  version: string;
  documentType: DocumentType;
}

interface RejectedFile {
  filename: string;
  reason: string;
}

interface Outcome {
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** macOS drops `.DS_Store` into every folder; it is never a research document. */
function keepFile(file: File): boolean {
  return !file.name.startsWith('.');
}

function outcomeFor(result: ImportResult): Outcome {
  if (result.duplicateOfDocumentId) return { label: 'ALREADY REGISTERED', tone: 'muted' };
  if (result.registered) return { label: 'REGISTERED', tone: 'ok' };
  if (result.requiresConfirmation) return { label: 'NEEDS CONFIRMATION', tone: 'warn' };
  if (result.storedPath) return { label: 'STORED, NOT REGISTERED', tone: 'warn' };
  return { label: 'NOT STORED', tone: 'bad' };
}

function confidenceTone(confidence: number): 'ok' | 'warn' | 'bad' {
  if (confidence >= 0.8) return 'ok';
  if (confidence >= 0.5) return 'warn';
  return 'bad';
}

/**
 * Grab the dropped entries synchronously: the browser neuters
 * `DataTransferItemList` the moment the drop handler returns, so directories
 * have to be captured before any `await`.
 */
function collectEntries(transfer: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  const items = transfer.items;
  if (!items) return entries;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (batch) => resolve(batch),
      () => resolve([]),
    );
  });
}

function readFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/** Walk a dropped directory tree so a folder of PDFs behaves like a multi-select. */
async function expandEntry(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH) return;
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    if (file && keepFile(file)) out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // readEntries returns at most 100 children per call; loop until it is empty.
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) await expandEntry(child, out, depth + 1);
  }
}

async function expandEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) await expandEntry(entry, files, 0);
  return files;
}

export function ImportPanel(props: {
  projectId: string | null;
  layers: Layer[];
  open: boolean;
  onClose(): void;
  onChanged(): void;
}): JSX.Element {
  const { projectId, layers, open, onChanged } = props;

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchLayerId, setBatchLayerId] = useState('');
  const [batchVersion, setBatchVersion] = useState('');
  const [batchType, setBatchType] = useState('');

  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const orderedLayers = useMemo(
    () => [...layers].sort((a, b) => a.orderIndex - b.orderIndex),
    [layers],
  );

  // `webkitdirectory` is not in React's attribute types; set it on the element.
  useEffect(() => {
    if (!open) return;
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, [open]);

  useEffect(() => {
    if (!open) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }, [open]);

  const summary = useMemo(() => {
    let registered = 0;
    let needsConfirmation = 0;
    let duplicates = 0;
    for (const result of results) {
      if (result.duplicateOfDocumentId) duplicates += 1;
      else if (result.registered) registered += 1;
      else if (result.requiresConfirmation) needsConfirmation += 1;
    }
    return { registered, needsConfirmation, duplicates, total: results.length };
  }, [results]);

  /**
   * Upload in chunks the server will accept, appending results as they land so a
   * large folder shows progress instead of a frozen dialog.
   */
  const upload = useCallback(
    async (incoming: File[]): Promise<void> => {
      if (!projectId) {
        setError('No project is loaded, so there is nowhere to import into.');
        return;
      }
      const files = incoming.filter(keepFile);
      if (files.length === 0) return;

      const tooBig = files.filter((file) => file.size > MAX_FILE_BYTES);
      const accepted = files.filter((file) => file.size <= MAX_FILE_BYTES);
      if (tooBig.length > 0) {
        setRejected((prev) => [
          ...prev,
          ...tooBig.map((file) => ({
            filename: file.name,
            reason: `${formatBytes(file.size)} exceeds the ${formatBytes(MAX_FILE_BYTES)} upload limit.`,
          })),
        ]);
      }
      if (accepted.length === 0) return;

      const meta: { layerId?: string; version?: string; documentType?: string } = {};
      if (batchLayerId) meta.layerId = batchLayerId;
      if (batchVersion.trim()) meta.version = batchVersion.trim();
      if (batchType) meta.documentType = batchType;

      setBusy(true);
      setError(null);
      setProgress({ done: 0, total: accepted.length });
      try {
        for (let index = 0; index < accepted.length; index += MAX_FILES_PER_REQUEST) {
          const chunk = accepted.slice(index, index + MAX_FILES_PER_REQUEST);
          const response = await Api.importFiles(projectId, chunk, meta);
          setResults((prev) => [...prev, ...response.results]);
          setDrafts((prev) => {
            const next = { ...prev };
            for (const result of response.results) {
              const path = result.storedPath;
              if (!path || !result.requiresConfirmation || next[path]) continue;
              next[path] = {
                layerId: result.inference.layerId ?? '',
                version: result.inference.version ?? '',
                documentType: result.inference.documentType ?? 'REFERENCE',
              };
            }
            return next;
          });
          setProgress({ done: index + chunk.length, total: accepted.length });
        }
        // Import changes layer state, dependencies and the next action.
        onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [projectId, batchLayerId, batchVersion, batchType, onChanged],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      const transfer = event.dataTransfer;
      if (!transfer) return;
      const entries = collectEntries(transfer);
      const plain = Array.from(transfer.files ?? []);
      void (async () => {
        const files = entries.length > 0 ? await expandEntries(entries) : plain;
        await upload(files);
      })();
    },
    [upload],
  );

  const handleDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const confirmResult = useCallback(
    async (result: ImportResult): Promise<void> => {
      const path = result.storedPath;
      if (!projectId || !path) return;
      const draft = drafts[path];
      if (!draft || !draft.layerId) {
        setError(`Choose a layer for ${result.filename} before confirming.`);
        return;
      }
      if (!draft.version.trim()) {
        setError(`Enter a version for ${result.filename} (for example v1B) before confirming.`);
        return;
      }
      setConfirming(path);
      setError(null);
      try {
        const response = await Api.resolveImport(projectId, {
          relativePath: path,
          layerId: draft.layerId,
          version: draft.version.trim(),
          documentType: draft.documentType,
        });
        setResults((prev) =>
          prev.map((entry) => (entry.storedPath === path ? response.result : entry)),
        );
        onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setConfirming(null);
      }
    },
    [projectId, drafts, onChanged],
  );

  const updateDraft = useCallback((path: string, patch: Partial<Draft>): void => {
    setDrafts((prev) => {
      const current = prev[path] ?? { layerId: '', version: '', documentType: 'REFERENCE' as DocumentType };
      return { ...prev, [path]: { ...current, ...patch } };
    });
  }, []);

  const clearResults = useCallback((): void => {
    setResults([]);
    setRejected([]);
    setDrafts({});
    setProgress(null);
    setError(null);
  }, []);

  const disabled = !projectId || busy;

  return (
    <Modal
      title="IMPORT DOCUMENTS"
      open={open}
      onClose={props.onClose}
      footer={
        <>
          <span className="muted">
            Originals are always kept. A file is only a document once it is registered, so anything
            below marked NEEDS CONFIRMATION is still waiting on you.
          </span>
          <span className="row">
            <button
              type="button"
              className="btn"
              onClick={clearResults}
              disabled={busy || results.length + rejected.length === 0}
            >
              CLEAR RESULTS
            </button>
            <button type="button" className="btn btn--primary" onClick={props.onClose} disabled={busy}>
              DONE
            </button>
          </span>
        </>
      }
    >
      {/* The whole dialog accepts the drop, so a near-miss never navigates the
          browser away to the raw PDF and loses the session. */}
      <div
        className="stack"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className={`dropzone${dragging ? ' dropzone--over' : ''}${disabled ? ' dropzone--disabled' : ''}`}
          role="button"
          tabIndex={0}
          aria-disabled={disabled}
          onClick={() => {
            if (!disabled) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <strong>{dragging ? 'RELEASE TO IMPORT' : 'DROP PDFs HERE'}</strong>
          <span className="dropzone__hint">
            Drag a whole folder of existing reports in at once. Every file is stored first, then its
            layer, version and document type are inferred from the filename — you only confirm the
            ones the platform is not sure about.
          </span>
          <span className="dropzone__hint">
            Or click to choose files. Up to {MAX_FILES_PER_REQUEST} files are sent per request and
            each file may be up to {formatBytes(MAX_FILE_BYTES)}.
          </span>
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            CHOOSE FILES
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => folderInputRef.current?.click()}
          >
            CHOOSE FOLDER
          </button>
          {busy && progress ? (
            <span className="mono warn">
              importing {progress.done} / {progress.total}…
            </span>
          ) : null}
          {!projectId ? <span className="bad">No project is loaded.</span> : null}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void upload(files);
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void upload(files);
          }}
        />

        <fieldset>
          <legend>OPTIONAL — FORCE METADATA FOR THIS BATCH</legend>
          <div className="row">
            <div className="field">
              <label htmlFor="import-batch-layer">LAYER</label>
              <select
                id="import-batch-layer"
                value={batchLayerId}
                disabled={busy}
                onChange={(event) => setBatchLayerId(event.target.value)}
              >
                <option value="">infer from filename</option>
                {orderedLayers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="import-batch-version">VERSION</label>
              <input
                id="import-batch-version"
                className="input--narrow"
                value={batchVersion}
                placeholder="infer"
                disabled={busy}
                onChange={(event) => setBatchVersion(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="import-batch-type">DOCUMENT TYPE</label>
              <select
                id="import-batch-type"
                value={batchType}
                disabled={busy}
                onChange={(event) => setBatchType(event.target.value)}
              >
                <option value="">infer from filename</option>
                {DOCUMENT_TYPE_OPTIONS.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <span className="small muted grow">
              Leave these on &quot;infer&quot; for a mixed folder. Set them only when you are
              importing several files that all belong to the same layer.
            </span>
          </div>
        </fieldset>

        {error ? (
          <div className="error spread">
            <span>{error}</span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setError(null)}
            >
              DISMISS
            </button>
          </div>
        ) : null}

        {rejected.length > 0 ? (
          <div className="notice">
            <strong className="bad">Not uploaded:</strong>
            <ul className="list-reset">
              {rejected.map((entry) => (
                <li className="finding" key={entry.filename}>
                  <span className="mono">{entry.filename}</span> — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {results.length > 0 ? (
          <div className="row">
            <Pill label="FILES" value={summary.total} />
            <Pill
              label="REGISTERED"
              value={summary.registered}
              tone={summary.registered ? 'ok' : 'muted'}
            />
            <Pill
              label="TO CONFIRM"
              value={summary.needsConfirmation}
              tone={summary.needsConfirmation ? 'warn' : 'ok'}
            />
            <Pill label="DUPLICATES" value={summary.duplicates} />
          </div>
        ) : null}

        {results.length === 0 && !busy ? (
          <div className="empty">
            Nothing imported yet. Drop the folder you have been keeping your reports in — the
            platform will tell you what it recognised and what it needs help with.
          </div>
        ) : null}

        {results.map((result, index) => {
          const outcome = outcomeFor(result);
          const inference = result.inference;
          const path = result.storedPath;
          const draft = path ? drafts[path] : undefined;
          const percent = Math.round(inference.confidence * 100);
          return (
            <div
              className={`card${result.requiresConfirmation ? ' card--bad' : ''}`}
              key={`${path ?? result.filename}:${index}`}
            >
              <div className="card__title">
                <span className="mono truncate" title={result.filename}>
                  {result.filename}
                </span>
                <span className={outcome.tone}>{outcome.label}</span>
              </div>

              <div className="card__body">{result.message}</div>

              <div className="kv">
                <span className="kv__key">LAYER</span>
                <span className="kv__value">{inference.layerName ?? 'unknown'}</span>
                <span className="kv__key">VERSION</span>
                <span className="kv__value">{inference.version ?? 'unknown'}</span>
                <span className="kv__key">TYPE</span>
                <span className="kv__value">{inference.documentType ?? 'unknown'}</span>
                <span className="kv__key">CANONICAL</span>
                <span className="kv__value">{inference.canonicalName ?? '—'}</span>
                <span className="kv__key">CONFIDENCE</span>
                <span className={`kv__value ${confidenceTone(inference.confidence)}`}>
                  {percent}%
                </span>
                <span className="kv__key">STORED AT</span>
                <span className="kv__value">{path ?? 'not stored'}</span>
                {result.duplicateOfDocumentId ? (
                  <>
                    <span className="kv__key">DUPLICATE OF</span>
                    <span className="kv__value">{result.duplicateOfDocumentId}</span>
                  </>
                ) : null}
              </div>

              {inference.reasons.length > 0 ? (
                <div className="finding-group">
                  <span className="finding-group__title">WHY</span>
                  <ul className="list-reset">
                    {inference.reasons.map((reason, reasonIndex) => (
                      <li className="finding" key={`${reasonIndex}:${reason}`}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.requiresConfirmation && path ? (
                <div className="row">
                  <div className="field">
                    <label htmlFor={`layer-${index}`}>LAYER</label>
                    <select
                      id={`layer-${index}`}
                      value={draft?.layerId ?? ''}
                      disabled={confirming === path || busy}
                      onChange={(event) => updateDraft(path, { layerId: event.target.value })}
                    >
                      <option value="">choose a layer…</option>
                      {orderedLayers.map((layer) => (
                        <option key={layer.id} value={layer.id}>
                          {layer.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`version-${index}`}>VERSION</label>
                    <input
                      id={`version-${index}`}
                      className="input--narrow"
                      value={draft?.version ?? ''}
                      placeholder="v1B"
                      disabled={confirming === path || busy}
                      onChange={(event) => updateDraft(path, { version: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`type-${index}`}>TYPE</label>
                    <select
                      id={`type-${index}`}
                      value={draft?.documentType ?? 'REFERENCE'}
                      disabled={confirming === path || busy}
                      onChange={(event) =>
                        updateDraft(path, { documentType: event.target.value as DocumentType })
                      }
                    >
                      {DOCUMENT_TYPE_OPTIONS.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={confirming === path || busy}
                    onClick={() => void confirmResult(result)}
                  >
                    {confirming === path ? 'CONFIRMING…' : 'CONFIRM'}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
