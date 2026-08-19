/**
 * Reviewing what Brain made of a project-wide source.
 *
 * A master transcript is not a layer document, so it cannot be reviewed on a
 * layer screen. It spans the whole project: assignments, returned research,
 * audits, decisions, revisions, superseded conclusions and open questions, each
 * belonging somewhere different. This screen is where a person sees what was
 * read, what it was taken to mean, and where each part was proposed to go — and
 * then accepts, redirects or excludes each proposal one at a time.
 *
 * Two rules shape the whole panel. Nothing here is evidence until somebody says
 * so, so every link arrives as PROPOSED with a confidence and a rationale in
 * plain sight. And the file is untrusted text: a passage that reads like an
 * instruction is shown with a warning on it, never acted on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Document, Layer } from '../../../server/domain/types.ts';
import type {
  DocumentSegment,
  IngestionReport,
  IngestionView,
  LinkStatus,
  SegmentLayerLink,
} from '../lib/api.ts';
import { Api, ApiError } from '../lib/api.ts';
import { Badge, Pill } from './Badge.tsx';
import { Modal } from './Modal.tsx';

/** Mirrors the server's per-file cap. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function confidenceTone(confidence: number): 'ok' | 'warn' | 'bad' {
  if (confidence >= 0.7) return 'ok';
  if (confidence >= 0.5) return 'warn';
  return 'bad';
}

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * The counted answer to "what did you actually read?".
 *
 * Spelled out rather than summarised, because the failure this screen exists to
 * correct was a file being stored and reported as understood.
 */
function ReportSummary(props: { report: IngestionReport }): JSX.Element {
  const { report } = props;
  return (
    <div className="stack stack--tight">
      <div className="row">
        <Pill label="CHARACTERS" value={report.characters.toLocaleString()} />
        <Pill label="TOKENS (EST.)" value={report.estimatedTokens.toLocaleString()} />
        <Pill label="BLOCKS" value={report.blocks} />
        <Pill label="CHUNKS" value={report.chunks} />
        <Pill label="SEGMENTS" value={report.segments} />
        <Badge status={report.extractionStatus} />
      </div>
      <div className="row">
        <Pill label="ASSIGNMENTS" value={report.researchAssignments} />
        <Pill label="RETURNED REPORTS" value={report.returnedReports} />
        <Pill label="AUDITS" value={report.audits} />
        <Pill label="DECISIONS" value={report.decisions} />
        <Pill label="REVISIONS" value={report.revisions} />
        <Pill label="SUPERSEDED" value={report.supersededConclusions} />
        <Pill
          label="OPEN GAPS"
          value={report.unresolvedGaps}
          tone={report.unresolvedGaps > 0 ? 'warn' : 'muted'}
        />
        <Pill label="ATTACHMENTS" value={report.attachmentReferences} />
      </div>
      <div className="row">
        <Pill label="PROPOSED" value={report.proposedLinks} />
        <Pill label="ACCEPTED" value={report.acceptedLinks} tone="ok" />
        <Pill label="EXCLUDED" value={report.excludedLinks} />
        <Pill
          label="LOW CONFIDENCE"
          value={`${report.lowConfidenceLinks} links / ${report.lowConfidenceSegments} segments`}
          tone={report.lowConfidenceLinks + report.lowConfidenceSegments > 0 ? 'warn' : 'muted'}
        />
        <span className="muted mono small">read {report.generatedAt}</span>
      </div>

      <div className="row wrap">
        <span className="muted small">LAYERS TOUCHED:</span>
        {report.layersTouched.length === 0 ? (
          <span className="muted">none — nothing in this file matched a layer.</span>
        ) : (
          report.layersTouched.map((entry) => (
            <Pill
              key={entry.layerId}
              label={entry.layerName}
              value={`${entry.segments} seg · ${percent(entry.topConfidence)}`}
              tone={confidenceTone(entry.topConfidence)}
            />
          ))
        )}
      </div>

      {report.suspiciousSegments.length > 0 ? (
        <div className="notice">
          <strong>{report.suspiciousSegments.length} passage(s) read like instructions to an AI.</strong>{' '}
          They are stored as ordinary text and flagged here for review. Nothing inside an imported
          file is ever executed, and none of it changed a layer, an audit or a verdict.
          <ul>
            {report.suspiciousSegments.map((entry) => (
              <li key={entry.segmentIndex} className="mono small">
                #{entry.segmentIndex} {entry.title} — “{entry.matched.join('”, “')}”
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.warnings.length > 0 ? (
        <div className="stack stack--tight">
          {report.warnings.map((warning, index) => (
            <div className="warn small" key={`${index}:${warning.slice(0, 24)}`}>
              {warning}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One proposal, with the three things a reviewer can do about it. */
function LinkRow(props: {
  link: SegmentLayerLink;
  layers: Layer[];
  busy: boolean;
  onDecide(linkId: string, patch: { status: LinkStatus; layerId?: string; version?: string | null }): void;
}): JSX.Element {
  const { link, layers, busy } = props;
  const [layerId, setLayerId] = useState(link.layerId);
  const [version, setVersion] = useState(link.version ?? '');

  // A re-read replaces the proposals; the controls follow the server's copy
  // rather than holding on to a stale edit.
  useEffect(() => {
    setLayerId(link.layerId);
    setVersion(link.version ?? '');
  }, [link.layerId, link.version]);

  const redirected = layerId !== link.layerId || (version || null) !== (link.version ?? null);

  return (
    <div className={`card ${link.status === 'EXCLUDED' ? 'card--muted' : ''}`}>
      <div className="spread">
        <div className="row">
          <Badge status={link.status} />
          <Badge status={link.linkType} />
          <Pill label="CONFIDENCE" value={percent(link.confidence)} tone={confidenceTone(link.confidence)} />
          {link.decidedAt ? <span className="muted mono small">decided {link.decidedAt}</span> : null}
        </div>
      </div>
      <div className="card__body small">{link.rationale}</div>
      <div className="card__actions row wrap">
        <label className="field field--inline">
          <span>LAYER</span>
          <select
            className="select"
            value={layerId}
            disabled={busy}
            onChange={(event) => setLayerId(event.target.value)}
          >
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>VERSION</span>
          <input
            className="input input--narrow"
            value={version}
            placeholder="v1"
            disabled={busy}
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={busy}
          onClick={() =>
            props.onDecide(link.id, {
              status: 'ACCEPTED',
              layerId,
              version: version.trim() === '' ? null : version.trim(),
            })
          }
        >
          {redirected ? 'CHANGE & ACCEPT' : 'ACCEPT'}
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || link.status === 'EXCLUDED'}
          onClick={() => props.onDecide(link.id, { status: 'EXCLUDED' })}
        >
          EXCLUDE
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          disabled={busy || link.status === 'PROPOSED'}
          onClick={() => props.onDecide(link.id, { status: 'PROPOSED' })}
        >
          UNDECIDE
        </button>
      </div>
    </div>
  );
}

/** One passage of the source, with everything proposed for it. */
function SegmentCard(props: {
  segment: DocumentSegment;
  links: SegmentLayerLink[];
  layers: Layer[];
  busy: boolean;
  onDecide(linkId: string, patch: { status: LinkStatus; layerId?: string; version?: string | null }): void;
}): JSX.Element {
  const { segment, links } = props;
  const [open, setOpen] = useState(false);
  const suspicious = segment.warnings.length > 0;

  return (
    <div className={`card ${suspicious ? 'card--bad' : ''}`}>
      <div className="spread">
        <div className="row wrap">
          <span className="mono muted small">#{segment.segmentIndex}</span>
          <Badge status={segment.segmentType} />
          <strong className="truncate">{segment.title}</strong>
        </div>
        <div className="row">
          {segment.speaker ? <span className="muted small">{segment.speaker}</span> : null}
          {segment.timestampText ? (
            <span className="muted mono small">{segment.timestampText}</span>
          ) : null}
          <Pill
            label="TYPE CONF."
            value={percent(segment.confidence)}
            tone={confidenceTone(segment.confidence)}
          />
        </div>
      </div>

      <div className="card__meta muted small">
        blocks {segment.blockStart}–{segment.blockEnd} · characters {segment.charStart}–
        {segment.charEnd} · {segment.rationale}
      </div>

      {segment.warnings.map((warning) => (
        <div className="warn small" key={warning}>
          {warning}
        </div>
      ))}

      <pre className={open ? 'pre' : 'pre pre--short'}>{segment.text}</pre>
      <div className="row">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setOpen(!open)}>
          {open ? 'SHOW LESS' : 'SHOW FULL PASSAGE'}
        </button>
        <span className="muted small">
          {links.length === 0
            ? 'No layer proposed for this passage.'
            : `${links.length} proposed link(s)`}
        </span>
      </div>

      {links.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          layers={props.layers}
          busy={props.busy}
          onDecide={props.onDecide}
        />
      ))}
    </div>
  );
}

export function SourceReview(props: {
  projectId: string | null;
  layers: Layer[];
  open: boolean;
  onClose(): void;
  onChanged(): void;
}): JSX.Element {
  const { projectId, open } = props;
  const [documents, setDocuments] = useState<Document[]>([]);
  const [unfiled, setUnfiled] = useState<{ path: string; detail: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<IngestionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const sources = useMemo(
    () => documents.filter((document) => document.scope !== 'LAYER'),
    [documents],
  );

  const loadDocuments = useCallback(async (): Promise<Document[]> => {
    if (!projectId) return [];
    const response = await Api.projectDocuments(projectId);
    setDocuments(response.documents);
    return response.documents;
  }, [projectId]);

  /** Files sitting in the project folder that were never registered. */
  const loadUnfiled = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const response = await Api.reconcile(projectId);
    setUnfiled(
      response.report.issues
        .filter((issue) => issue.kind === 'UNREGISTERED_FILE' && issue.path)
        .map((issue) => ({ path: issue.path!, detail: issue.detail })),
    );
  }, [projectId]);

  const loadIngestion = useCallback(async (documentId: string): Promise<void> => {
    setSelectedId(documentId);
    setView(await Api.ingestion(documentId));
  }, []);

  useEffect(() => {
    if (!open || !projectId) return;
    setError(null);
    void (async () => {
      setBusy(true);
      try {
        const loaded = await loadDocuments();
        await loadUnfiled();
        const first = loaded.find((document) => document.scope !== 'LAYER');
        if (first) await loadIngestion(first.id);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [open, projectId, loadDocuments, loadUnfiled, loadIngestion]);

  const run = useCallback(
    async (what: () => Promise<string | null>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const message = await what();
        if (message) setNote(message);
        props.onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [props],
  );

  const handleUpload = useCallback(
    (files: File[]): void => {
      if (!projectId || files.length === 0) return;
      const tooBig = files.find((file) => file.size > MAX_FILE_BYTES);
      if (tooBig) {
        setError(`${tooBig.name} is larger than the 50 MB limit.`);
        return;
      }
      void run(async () => {
        const response = await Api.importProjectSource(projectId, files);
        await loadDocuments();
        await loadUnfiled();
        const first = response.results.find((result) => result.import.documentId);
        if (first?.import.documentId) await loadIngestion(first.import.documentId);
        const report = first?.report ?? null;
        return report
          ? `Read ${report.characters.toLocaleString()} characters into ${report.segments} segments; ` +
              `${report.proposedLinks} links proposed across ${report.layersTouched.length} layer(s).`
          : 'Stored, but nothing could be read from it.';
      });
    },
    [projectId, run, loadDocuments, loadUnfiled, loadIngestion],
  );

  const handleReprocess = useCallback(
    (relativePath: string): void => {
      if (!projectId) return;
      void run(async () => {
        const response = await Api.reprocessUnfiled(projectId, relativePath);
        await loadDocuments();
        await loadUnfiled();
        if (response.import.documentId) await loadIngestion(response.import.documentId);
        return response.report
          ? `${relativePath} is now registered and read: ${response.report.segments} segments, ` +
              `${response.report.proposedLinks} proposed links.`
          : `${relativePath} was registered but could not be read.`;
      });
    },
    [projectId, run, loadDocuments, loadUnfiled, loadIngestion],
  );

  const handleReRead = useCallback((): void => {
    if (!selectedId) return;
    void run(async () => {
      const response = await Api.ingest(selectedId, { force: true });
      await loadIngestion(selectedId);
      return `Re-read: ${response.report.segments} segments, ${response.report.proposedLinks} proposals. Decisions were kept.`;
    });
  }, [selectedId, run, loadIngestion]);

  const handleDecide = useCallback(
    (linkId: string, patch: { status: LinkStatus; layerId?: string; version?: string | null }): void => {
      if (!selectedId) return;
      void run(async () => {
        const response = await Api.decideLink(selectedId, linkId, patch);
        setView((current) => (current ? { ...current, links: response.links } : current));
        return null;
      });
    },
    [selectedId, run],
  );

  const linksBySegment = useMemo(() => {
    const map = new Map<string, SegmentLayerLink[]>();
    for (const link of view?.links ?? []) {
      const key = link.segmentId ?? 'document';
      map.set(key, [...(map.get(key) ?? []), link]);
    }
    return map;
  }, [view]);

  const documentLinks = linksBySegment.get('document') ?? [];
  const undecided = (view?.links ?? []).filter((link) => link.status === 'PROPOSED').length;

  return (
    <Modal
      title="PROJECT SOURCES"
      open={open}
      onClose={props.onClose}
      footer={
        <>
          <span className="muted">
            A transcript spans the whole project, so it is filed under none of the layers and linked
            to several. Nothing here counts as evidence for a layer until you accept it.
          </span>
          <button
            type="button"
            className="btn"
            onClick={handleReRead}
            disabled={busy || !selectedId}
          >
            READ AGAIN
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <div className="error spread">
            <span>{error}</span>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setError(null)}>
              DISMISS
            </button>
          </div>
        ) : null}
        {note ? (
          <div className="notice spread">
            <span>{note}</span>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setNote(null)}>
              DISMISS
            </button>
          </div>
        ) : null}

        <div className="section">
          <div className="section__title">ADD A PROJECT-WIDE SOURCE</div>
          <div className="row">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="input"
              disabled={busy || !projectId}
              onChange={(event) => {
                handleUpload([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <span className="muted small">
              A chat transcript, a working log — anything that belongs to the project rather than to
              one layer. It is stored unchanged, read in full, and classified by its contents.
            </span>
          </div>
        </div>

        {unfiled.length > 0 ? (
          <div className="section">
            <div className="section__title">STORED BUT NEVER READ ({unfiled.length})</div>
            <table className="table">
              <thead>
                <tr>
                  <th>FILE</th>
                  <th>DETAIL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unfiled.map((entry) => (
                  <tr key={entry.path}>
                    <td className="mono">{entry.path}</td>
                    <td className="muted small">{entry.detail}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy}
                        onClick={() => handleReprocess(entry.path)}
                      >
                        READ IT
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="section">
          <div className="section__title">SOURCES ({sources.length})</div>
          {sources.length === 0 ? (
            <div className="empty">
              No project-wide source has been imported yet.
            </div>
          ) : (
            <div className="row wrap">
              {sources.map((document) => (
                <button
                  type="button"
                  key={document.id}
                  className={`btn btn--small ${document.id === selectedId ? 'btn--active' : ''}`}
                  disabled={busy}
                  onClick={() => void run(async () => {
                    await loadIngestion(document.id);
                    return null;
                  })}
                >
                  {document.filename ?? document.canonicalName}
                </button>
              ))}
            </div>
          )}
        </div>

        {view ? (
          <div className="stack">
            <div className="section">
              <div className="section__title">WHAT WAS READ</div>
              <div className="row wrap">
                <span className="mono">{view.document.filename ?? view.document.canonicalName}</span>
                <Badge status={view.document.scope ?? 'LAYER'} />
                <Pill
                  label="LAYER FROM"
                  value={view.document.classificationSource ?? 'not classified'}
                  tone={view.document.classificationSource === 'CONTENT' ? 'ok' : 'warn'}
                />
                {view.document.layerId === null ? (
                  <span className="muted small">
                    Filed under no single layer — which is correct for a project-wide source.
                  </span>
                ) : null}
              </div>
              {view.report ? (
                <ReportSummary report={view.report} />
              ) : (
                <div className="empty">
                  This file has not been read yet. READ AGAIN will extract, segment and classify it.
                </div>
              )}
            </div>

            {documentLinks.length > 0 ? (
              <div className="section">
                <div className="section__title">WHOLE-DOCUMENT LINKS</div>
                {documentLinks.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    layers={props.layers}
                    busy={busy}
                    onDecide={handleDecide}
                  />
                ))}
              </div>
            ) : null}

            <div className="section">
              <div className="section__title">
                PASSAGES ({view.segments.length}) · {undecided} PROPOSAL(S) AWAITING A DECISION
              </div>
              {view.segments.length === 0 ? (
                <div className="empty">Nothing was segmented from this file.</div>
              ) : (
                view.segments.map((segment) => (
                  <SegmentCard
                    key={segment.id}
                    segment={segment}
                    links={linksBySegment.get(segment.id) ?? []}
                    layers={props.layers}
                    busy={busy}
                    onDecide={handleDecide}
                  />
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
