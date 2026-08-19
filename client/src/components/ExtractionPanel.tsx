/**
 * What Brain has actually managed to read (section 17).
 *
 * The point of this panel is to answer, before any audit runs: did you read every
 * page, which pages needed OCR or failed, and was anything truncated? Ugly and
 * functional by design.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Api, type ExtractedTextView, type ExtractionView } from '../lib/api.ts';

/** Extraction states that are still moving, and therefore worth polling. */
const IN_PROGRESS = new Set(['QUEUED', 'EXTRACTING', 'OCR', 'INDEXING']);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusTone(status: string): string {
  if (status === 'READY') return 'ok';
  if (status === 'READY_WITH_WARNINGS') return 'warn';
  if (status === 'BLOCKED' || status === 'FAILED' || status === 'INTERRUPTED') return 'bad';
  return 'muted';
}

export function ExtractionPanel(props: { documentId: string; onChanged?: () => void }): JSX.Element {
  const { documentId, onChanged } = props;
  const [view, setView] = useState<ExtractionView | null>(null);
  const [text, setText] = useState<ExtractedTextView | null>(null);
  const [showText, setShowText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await Api.extraction(documentId));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [documentId]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);

  // Extraction runs in the background, so the panel follows it rather than
  // showing a stale QUEUED until the user refreshes.
  useEffect(() => {
    const status = view?.document.extractionStatus ?? '';
    if (!IN_PROGRESS.has(status)) return;
    timer.current = window.setTimeout(() => void load(), 1_200);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [view, load]);

  const reprocess = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await Api.reprocess(documentId));
      setText(null);
      onChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [documentId, onChanged]);

  const viewText = useCallback(async (): Promise<void> => {
    if (showText) {
      setShowText(false);
      return;
    }
    setBusy(true);
    try {
      setText(await Api.extractedText(documentId));
      setShowText(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [documentId, showText]);

  const quality = view?.quality ?? null;
  const status = view?.document.extractionStatus ?? 'QUEUED';
  const working = IN_PROGRESS.has(status);

  return (
    <div className="stack stack--tight">
      <div className="row">
        <span className={`badge badge--${statusTone(status)}`}>
          {status.replace(/_/g, ' ')}
          {working ? '…' : ''}
        </span>
        {quality ? (
          <span className="small mono">
            {quality.pagesReadable}/{quality.pagesExpected} pages ·{' '}
            {Math.round(quality.coverageRatio * 100)}% coverage ·{' '}
            {quality.characterCount.toLocaleString()} chars
            {quality.pagesOcr > 0 ? ` · ${quality.pagesOcr} OCR` : ''}
            {quality.pagesFailed.length > 0 ? ` · failed ${quality.pagesFailed.join(', ')}` : ''}
          </span>
        ) : null}
        <button type="button" className="btn btn--small" onClick={() => void reprocess()} disabled={busy || working}>
          REPROCESS
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void viewText()}
          disabled={busy || !quality || quality.characterCount === 0}
        >
          {showText ? 'HIDE EXTRACTED TEXT' : 'VIEW EXTRACTED TEXT'}
        </button>
        <a
          className="btn btn--small"
          href={Api.documentFileUrl(documentId)}
          target="_blank"
          rel="noreferrer"
        >
          VIEW ORIGINAL
        </a>
      </div>

      {quality?.blockedReason ? (
        <div className="error">
          <strong>BLOCKED — this document cannot be audited.</strong>
          <div className="small">{quality.blockedReason}</div>
        </div>
      ) : null}

      {quality && quality.warnings.length > 0 ? (
        <ul className="checklist small">
          {quality.warnings.map((warning, index) => (
            <li key={index} className="muted">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {view && !view.ocr.available && quality && quality.pagesOcr === 0 && quality.pagesFailed.length > 0 ? (
        <div className="small muted">{view.ocr.reason}</div>
      ) : null}

      {error ? <div className="error small">{error}</div> : null}

      {showText && text ? (
        <div className="card">
          <div className="small muted">
            Exactly the text the auditor reads, page by page. Page headers and footers are kept
            but marked, and nothing here replaces the original.
          </div>
          <pre className="pre">
            {text.pages
              .map(
                (page) =>
                  `--- page ${page.pageNumber} ---\n` +
                  page.blocks
                    .map((block) => `[${block.blockType}${block.method === 'OCR' ? '/OCR' : ''}] ${block.text}`)
                    .join('\n'),
              )
              .join('\n\n')}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
