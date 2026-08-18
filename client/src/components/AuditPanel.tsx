/**
 * Audits for one layer: what previous audits concluded, and the form that
 * records the next one.
 *
 * An audit is never stored as prose (invariant 11). Whether the user fills in
 * the fields by hand or pastes the JSON block the audit prompt asks for, what
 * reaches the server is a structured verdict plus typed findings — which is
 * what lets the state engine turn "MORE_RESEARCH" into a concrete next version
 * instead of leaving the user to reread a paragraph.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Audit,
  AuditFindingType,
  AuditVerdict,
  ResearchRun,
} from '../../../server/domain/types.ts';
import { Api, ApiError } from '../lib/api.ts';
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

const FINDING_GROUPS: readonly { type: AuditFindingType; title: string }[] = [
  { type: 'FAILURE', title: 'FAILURES' },
  { type: 'MISSING_DOCUMENT', title: 'MISSING DOCUMENTS' },
  { type: 'REQUIRED_RESEARCH_RUN', title: 'REQUIRED RESEARCH RUNS' },
  { type: 'REQUIRED_PATCH', title: 'REQUIRED PATCHES' },
  { type: 'NEXT_ACTION', title: 'NEXT ACTION' },
];

type Mode = 'STRUCTURED' | 'PASTE';

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** One item per non-empty line: the fastest honest way to type a finding list. */
function lines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function describeRun(run: ResearchRun): string {
  const version = run.targetVersion ? ` ${run.targetVersion}` : '';
  return `${run.runType}${version} · attempt ${run.attemptNumber} · ${run.status}`;
}

export function AuditPanel(props: {
  layerId: string;
  audits: Audit[];
  runs: ResearchRun[];
  onChanged(): void;
}): JSX.Element {
  const { layerId, audits, runs, onChanged } = props;

  const [mode, setMode] = useState<Mode>('STRUCTURED');
  const [runId, setRunId] = useState('');
  const [verdict, setVerdict] = useState<AuditVerdict>('PASS');
  const [summary, setSummary] = useState('');
  const [failures, setFailures] = useState('');
  const [missingDocuments, setMissingDocuments] = useState('');
  const [requiredResearchRuns, setRequiredResearchRuns] = useState('');
  const [requiredPatches, setRequiredPatches] = useState('');
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Switching layers must not carry a half-typed audit onto someone else's run.
  useEffect(() => {
    setMode('STRUCTURED');
    setRunId('');
    setVerdict('PASS');
    setSummary('');
    setFailures('');
    setMissingDocuments('');
    setRequiredResearchRuns('');
    setRequiredPatches('');
    setRawText('');
    setError(null);
    setNotice(null);
  }, [layerId]);

  /** The run an audit is most likely about: the one waiting for a verdict. */
  const preferredRun = useMemo((): ResearchRun | null => {
    return (
      runs.find((run) => run.status === 'AUDIT_REQUIRED') ??
      runs.find((run) => run.status === 'COMPLETE') ??
      runs[0] ??
      null
    );
  }, [runs]);

  const selectedRunId = runs.some((run) => run.id === runId) ? runId : (preferredRun?.id ?? '');

  const submit = useCallback(async (): Promise<void> => {
    if (!selectedRunId) {
      setError('Choose the run this audit is about. An audit is always recorded against an attempt.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> =
        mode === 'PASTE'
          ? { text: rawText }
          : {
              verdict,
              summary: summary.trim(),
              failures: lines(failures),
              missingDocuments: lines(missingDocuments),
              requiredResearchRuns: lines(requiredResearchRuns),
              requiredPatches: lines(requiredPatches),
            };
      await Api.auditRun(selectedRunId, body);
      onChanged();
      setSummary('');
      setFailures('');
      setMissingDocuments('');
      setRequiredResearchRuns('');
      setRequiredPatches('');
      setRawText('');
      setNotice(
        'Audit recorded. The layer status, the next version and any automatic redo follow from it.',
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [
    selectedRunId,
    mode,
    rawText,
    verdict,
    summary,
    failures,
    missingDocuments,
    requiredResearchRuns,
    requiredPatches,
    onChanged,
  ]);

  return (
    <div className="stack">
      <div className="section">
        <div className="section__title">PAST AUDITS ({audits.length})</div>
        {audits.length === 0 ? (
          <div className="empty">
            This layer has never been audited. Record the first audit below, or run an AUDIT prompt
            and paste back the JSON it returns.
          </div>
        ) : (
          audits.map((audit) => (
            <div key={audit.id} className="card">
              <div className="card__title">
                <span className="row">
                  <Badge status={audit.verdict} />
                  <span className="truncate">{audit.summary}</span>
                </span>
                <span className="small muted nowrap">{formatWhen(audit.createdAt)}</span>
              </div>
              <div className="card__meta">
                <span>
                  <b>SOURCE</b> {audit.source}
                </span>
                <span>
                  <b>CONFIDENCE</b> {audit.confidence === null ? '—' : audit.confidence.toFixed(2)}
                </span>
                <span>
                  <b>SYNTHESIS REQUIRED</b> {audit.synthesisRequired ? 'yes' : 'no'}
                </span>
                <span>
                  <b>FREEZE ELIGIBLE</b> {audit.freezeEligible ? 'yes' : 'no'}
                </span>
                <span>
                  <b>NEXT VERSION</b> {audit.nextVersion ?? '—'}
                </span>
                {audit.runId ? (
                  <span>
                    <b>RUN</b> <span className="mono">{audit.runId}</span>
                  </span>
                ) : null}
              </div>
              {audit.nextAction ? (
                <div className="card__body">
                  <span className="muted">NEXT ACTION: </span>
                  <span className="strong">{audit.nextAction}</span>
                </div>
              ) : null}
              {FINDING_GROUPS.map((group) => {
                const findings = audit.findings
                  .filter((finding) => finding.findingType === group.type)
                  .sort((a, b) => a.ordinal - b.ordinal);
                if (findings.length === 0) return null;
                return (
                  <div key={group.type} className="finding-group">
                    <div className="finding-group__title">{group.title}</div>
                    {findings.map((finding) => (
                      <div key={finding.id} className="finding">
                        {finding.content}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="section">
        <div className="section__title">RECORD AN AUDIT</div>

        {runs.length === 0 ? (
          <div className="empty">
            There is no run to audit yet. An audit is always recorded against the attempt it judges,
            so create a run first.
          </div>
        ) : (
          <div className="stack stack--tight">
            <div className="field">
              <label>AUDITED RUN</label>
              <select
                className="select"
                value={selectedRunId}
                onChange={(event) => setRunId(event.target.value)}
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {describeRun(run)} — {run.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="row">
              <button
                type="button"
                className={`btn btn--small ${mode === 'STRUCTURED' ? 'btn--active' : ''}`.trim()}
                onClick={() => setMode('STRUCTURED')}
              >
                FILL IN THE FIELDS
              </button>
              <button
                type="button"
                className={`btn btn--small ${mode === 'PASTE' ? 'btn--active' : ''}`.trim()}
                onClick={() => setMode('PASTE')}
              >
                PASTE MODEL JSON
              </button>
            </div>

            {mode === 'STRUCTURED' ? (
              <>
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
                      value={summary}
                      placeholder="One sentence a future reader can act on."
                      onChange={(event) => setSummary(event.target.value)}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>FAILURES (ONE PER LINE)</label>
                  <textarea
                    className="textarea"
                    value={failures}
                    onChange={(event) => setFailures(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label>MISSING DOCUMENTS (ONE CANONICAL NAME PER LINE)</label>
                  <textarea
                    className="textarea"
                    value={missingDocuments}
                    placeholder="Discovery Logic v1G"
                    onChange={(event) => setMissingDocuments(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label>REQUIRED RESEARCH RUNS (ONE PER LINE)</label>
                  <textarea
                    className="textarea"
                    value={requiredResearchRuns}
                    onChange={(event) => setRequiredResearchRuns(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label>REQUIRED PATCHES (ONE PER LINE)</label>
                  <textarea
                    className="textarea"
                    value={requiredPatches}
                    onChange={(event) => setRequiredPatches(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="field">
                <label>RAW AUDIT JSON FROM THE MODEL</label>
                <textarea
                  className="textarea pre--short"
                  value={rawText}
                  placeholder='{"verdict":"MORE_RESEARCH","summary":"…","failures":[],"missingDocuments":["Discovery Logic v1G"]}'
                  onChange={(event) => setRawText(event.target.value)}
                />
                <div className="small muted">
                  The server parses the JSON block out of whatever you paste. If it cannot find one
                  it says so instead of storing the prose.
                </div>
              </div>
            )}

            {error ? <div className="error">{error}</div> : null}
            {notice ? <div className="notice">{notice}</div> : null}

            <div className="card__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  busy ||
                  !selectedRunId ||
                  (mode === 'PASTE' ? rawText.trim().length === 0 : summary.trim().length === 0)
                }
                onClick={() => void submit()}
              >
                RECORD AUDIT
              </button>
              <span className="small muted">
                A verdict of REDO or MORE_RESEARCH may create the next attempt automatically; the
                audited run is never modified.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
