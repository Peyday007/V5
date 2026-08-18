/**
 * One registered document.
 *
 * The card exists to answer two questions at a glance: is this artifact real,
 * and is it the one the rest of the project should be using? A row whose file
 * has vanished is therefore never shown with an OPEN link — it is shown as an
 * inconsistency, because a database row is not a document (invariants 8 and 9).
 *
 * The edit form is the sanctioned correction path for a mis-inferred import:
 * the server renames and relocates the file so the folder tree keeps matching
 * the database, which is why this never edits anything locally.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Document, DocumentStatus, DocumentType } from '../../../server/domain/types.ts';
import { Api, ApiError, api, copyToClipboard } from '../lib/api.ts';
import { Badge } from './Badge.tsx';

/** Declared here, not imported: the client never pulls a value out of the server. */
const DOCUMENT_TYPES: readonly DocumentType[] = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'CANONICAL',
  'REFERENCE',
];

const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'EXPECTED',
  'MISSING',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'SUPERSEDED',
  'FROZEN',
];

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

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentCard(props: { document: Document; onChanged(): void }): JSX.Element {
  const { document: doc, onChanged } = props;

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'name' | 'failed' | null>(null);
  const [version, setVersion] = useState(doc.version);
  const [documentType, setDocumentType] = useState<DocumentType>(doc.documentType);
  const [status, setStatus] = useState<DocumentStatus>(doc.status);
  const [notes, setNotes] = useState(doc.notes ?? '');

  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  /** Re-seed the form whenever the server hands back a different version of this row. */
  const startEditing = useCallback((): void => {
    setVersion(doc.version);
    setDocumentType(doc.documentType);
    setStatus(doc.status);
    setNotes(doc.notes ?? '');
    setError(null);
    setEditing(true);
  }, [doc]);

  const copyName = useCallback(async (): Promise<void> => {
    const ok = await copyToClipboard(doc.canonicalName);
    setCopied(ok ? 'name' : 'failed');
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(null), 2500);
  }, [doc.canonicalName]);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api<unknown>(`/api/documents/${encodeURIComponent(doc.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: version.trim(),
          documentType,
          status,
          notes: notes.trim() ? notes.trim() : null,
        }),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [doc.id, version, documentType, status, notes, onChanged]);

  const cardClass = `card ${doc.fileMissing ? 'card--bad' : ''} ${doc.status === 'SUPERSEDED' ? 'card--muted' : ''}`;

  return (
    <div className={cardClass.trim()}>
      <div className="card__title">
        <span className="truncate" title={doc.canonicalName}>
          {doc.canonicalName}
        </span>
        <span className="row">
          {doc.isCanonical ? <span className="tag info">CANONICAL</span> : null}
          {doc.frozen ? <span className="tag info">FROZEN</span> : null}
          <Badge status={doc.status} />
        </span>
      </div>

      <div className="card__meta">
        <span>
          <b>VERSION</b> {doc.version}
        </span>
        <span>
          <b>TYPE</b> {doc.documentType}
        </span>
        <span>
          <b>WAVE</b> {doc.wave ?? '—'}
        </span>
        <span>
          <b>SIZE</b> {formatSize(doc.fileSize)}
        </span>
        <span>
          <b>CREATED</b> {formatWhen(doc.createdAt)}
        </span>
        <span>
          <b>IMPORTED</b> {formatWhen(doc.importedAt)}
        </span>
      </div>

      <div className="kv">
        <span className="kv__key">FILENAME</span>
        <span className="kv__value">{doc.filename ?? 'no file registered'}</span>
        <span className="kv__key">PATH</span>
        <span className="kv__value">{doc.filesystemPath ?? '—'}</span>
        <span className="kv__key">CONVERSATION</span>
        <span className="kv__value">{doc.conversationTitle ?? '—'}</span>
        <span className="kv__key">SOURCE RUN</span>
        <span className="kv__value">{doc.sourceRunId ?? 'imported by hand'}</span>
        {doc.supersededByDocumentId ? (
          <>
            <span className="kv__key">SUPERSEDED BY</span>
            <span className="kv__value">{doc.supersededByDocumentId}</span>
          </>
        ) : null}
        {doc.notes ? (
          <>
            <span className="kv__key">NOTES</span>
            <span className="kv__value">{doc.notes}</span>
          </>
        ) : null}
      </div>

      {doc.fileMissing ? (
        <div className="inconsistent">
          INCONSISTENT STATE — this document is registered but its file is not on disk. Run SCAN
          &amp; RECONCILE to re-link or re-import it; until then nothing may depend on it.
        </div>
      ) : null}

      {error ? <div className="error">{error}</div> : null}

      {editing ? (
        <div className="stack stack--tight">
          <div className="row">
            <div className="field">
              <label>VERSION</label>
              <input
                className="input input--narrow"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="v1G"
              />
            </div>
            <div className="field">
              <label>TYPE</label>
              <select
                className="select"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value as DocumentType)}
              >
                {DOCUMENT_TYPES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>STATUS</label>
              <select
                className="select"
                value={status}
                onChange={(event) => setStatus(event.target.value as DocumentStatus)}
              >
                {DOCUMENT_STATUSES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>NOTES</label>
            <textarea
              className="textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Why this correction was needed."
            />
          </div>
          <div className="small muted">
            Changing the version or the layer renames the canonical name and moves the file on disk,
            so the folder tree keeps matching the database.
          </div>
          <div className="card__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
              SAVE CHANGES
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>
              CANCEL
            </button>
          </div>
        </div>
      ) : (
        <div className="card__actions">
          {doc.fileMissing ? (
            <span className="bad small">FILE MISSING — nothing to open</span>
          ) : (
            <a
              className="btn btn--small"
              href={Api.documentFileUrl(doc.id)}
              target="_blank"
              rel="noreferrer"
            >
              OPEN
            </a>
          )}
          <button type="button" className="btn btn--small" onClick={() => void copyName()}>
            {copied === 'name' ? 'COPIED' : copied === 'failed' ? 'COPY FAILED' : 'COPY NAME'}
          </button>
          <button type="button" className="btn btn--small" onClick={startEditing}>
            EDIT
          </button>
        </div>
      )}
    </div>
  );
}
