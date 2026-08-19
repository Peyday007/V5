/**
 * The dynamic audit control and its result (section 22).
 *
 * Deliberately plain. What the user needs at a glance is three lines — the
 * verdict, how many research runs remain, and the one thing to do next. Everything
 * that produced those three lines is available behind collapsed sections, because
 * a verdict you cannot interrogate is not worth trusting.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuditGap } from '../../../server/domain/types.ts';
import {
  Api,
  auditStreamPaths,
  streamAudit,
  type AuditStreamEvent,
  type DynamicAuditResponse,
  type PacketManifestView,
} from '../lib/api.ts';

export type AuditTargetKind = 'document' | 'run' | 'packet';

interface Progress {
  index: number;
  total: number;
  label: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classifications the profile says may keep a layer open. */
const RESEARCH_GAPS = new Set(['FOUNDATIONAL_GAP', 'TARGETED_RESEARCH_GAP']);

function GapList(props: { gaps: AuditGap[] }): JSX.Element | null {
  if (props.gaps.length === 0) return null;
  return (
    <ul className="checklist">
      {props.gaps.map((gap) => (
        <li key={gap.id}>
          <span className={RESEARCH_GAPS.has(gap.classification) ? 'badge badge--blocked' : 'badge badge--not_started'}>
            {gap.classification}
          </span>{' '}
          <strong>{gap.title}</strong>
          {gap.owningLayerName ? <span className="small muted"> → {gap.owningLayerName}</span> : null}
          {gap.detail ? <div className="small muted">{gap.detail}</div> : null}
          {gap.researchQuestion ? (
            <div className="small">
              <span className="muted">Question: </span>
              {gap.researchQuestion}
            </div>
          ) : null}
          {gap.justification ? <div className="small muted">Why this class: {gap.justification}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function Section(props: { title: string; count?: number; children: React.ReactNode }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  return (
    <div className="stack stack--tight">
      <button type="button" className="btn btn--small btn--ghost" onClick={() => setOpen((value) => !value)}>
        {open ? '▾' : '▸'} {props.title}
        {props.count === undefined ? '' : ` (${props.count})`}
      </button>
      {open ? <div className="card">{props.children}</div> : null}
    </div>
  );
}

export function DynamicAuditPanel(props: {
  kind: AuditTargetKind;
  targetId: string;
  label: string;
  onChanged(): void;
}): JSX.Element {
  const { kind, targetId, label, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<DynamicAuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PacketManifestView | null>(null);

  // For a packet, show what would be read BEFORE anything runs: being told at the
  // end that the verdict was impossible all along is the worst version of this.
  useEffect(() => {
    if (kind !== 'packet') return;
    let cancelled = false;
    void Api.packetManifest(targetId)
      .then((value) => {
        if (!cancelled) setManifest(value);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, targetId, result]);

  const run = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ index: 0, total: 3, label: 'Building context' });
    const path =
      kind === 'packet'
        ? auditStreamPaths.packet(targetId)
        : kind === 'run'
          ? auditStreamPaths.run(targetId)
          : auditStreamPaths.document(targetId);
    try {
      await streamAudit(path, (event: AuditStreamEvent) => {
        if (event.type === 'progress') {
          setProgress({ index: event.index, total: event.total, label: event.label });
        } else if (event.type === 'result') {
          setResult(event.result);
          setProgress(null);
          onChanged();
        } else {
          // A failed audit changed nothing; say so rather than implying a verdict.
          setError(event.error);
          setProgress(null);
        }
      });
    } catch (err) {
      setError(describeError(err));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }, [kind, targetId, onChanged]);

  const headline = result?.headline;
  const gaps = result?.audit.gaps ?? [];
  const researchGaps = gaps.filter((gap) => RESEARCH_GAPS.has(gap.classification));
  const otherGaps = gaps.filter((gap) => !RESEARCH_GAPS.has(gap.classification));
  const handoffs = result?.audit.findings.filter((f) => f.findingType === 'OTHER_LAYER_HANDOFF') ?? [];
  const attacks = result?.adversarial.attacks ?? [];

  return (
    <div className="stack">
      {kind === 'packet' && manifest ? (
        <div className={manifest.auditable ? 'card' : 'error'}>
          <div className="small">
            <strong>PACKET MANIFEST</strong> — {manifest.manifest.documents.length} document(s),{' '}
            {manifest.manifest.totalPages} page(s),{' '}
            {manifest.manifest.totalCharacters.toLocaleString()} characters.
          </div>
          <ul className="checklist small">
            {manifest.manifest.documents.map((entry) => (
              <li key={entry.documentId ?? entry.canonicalName}>
                {entry.unavailableReason ? '✗' : '✓'} {entry.canonicalName}
                <span className="muted">
                  {' '}
                  · {entry.extractionStatus}
                  {entry.pages ? ` · ${entry.pages}p` : ''}
                  {entry.pagesOcr > 0 ? ` · ${entry.pagesOcr} OCR` : ''}
                  {entry.truncated ? ' · truncated' : ''}
                </span>
                {entry.unavailableReason ? (
                  <div className="small muted">{entry.unavailableReason}</div>
                ) : null}
              </li>
            ))}
          </ul>
          {!manifest.auditable ? (
            <div className="small">
              <strong>This packet cannot be audited yet.</strong> Every document has to be readable
              first — reprocess or replace the ones marked above.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="row">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={busy || (kind === 'packet' && manifest !== null && !manifest.auditable)}
        >
          {busy ? 'AUDITING…' : label}
        </button>
        {progress ? (
          <span className="small muted">
            {progress.index > 0 ? `Pass ${progress.index}/${progress.total} — ` : ''}
            {progress.label}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="error">
          <strong>AUDIT FAILED — nothing was changed.</strong>
          <div className="small">{error}</div>
        </div>
      ) : null}

      {headline ? (
        <div className="card">
          <div className="audit-headline">
            <div className="audit-headline__verdict">{headline.verdict.replace(/_/g, ' ')}</div>
            <div className="audit-headline__meta">More DRs: {headline.moreResearchRuns}</div>
            <div className="audit-headline__next">
              <span className="muted">Next: </span>
              {headline.nextAction}
            </div>
          </div>
          <p className="small">{headline.summary}</p>

          {researchGaps.length > 0 ? (
            <Section title="FOUNDATIONAL / TARGETED GAPS" count={researchGaps.length}>
              <GapList gaps={researchGaps} />
            </Section>
          ) : null}

          {result && result.audit.findings.filter((f) => f.findingType === 'REQUIRED_PATCH').length > 0 ? (
            <Section
              title="PATCHES"
              count={result.audit.findings.filter((f) => f.findingType === 'REQUIRED_PATCH').length}
            >
              <ul className="checklist">
                {result.audit.findings
                  .filter((f) => f.findingType === 'REQUIRED_PATCH')
                  .map((finding) => (
                    <li key={finding.id}>{finding.content}</li>
                  ))}
              </ul>
            </Section>
          ) : null}

          {handoffs.length > 0 ? (
            <Section title="OTHER-LAYER HANDOFFS" count={handoffs.length}>
              <ul className="checklist">
                {handoffs.map((finding) => (
                  <li key={finding.id}>{finding.content}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          {otherGaps.length > 0 ? (
            <Section title="NON-BLOCKING CLASSIFICATIONS" count={otherGaps.length}>
              <GapList gaps={otherGaps} />
            </Section>
          ) : null}

          {attacks.length > 0 ? (
            <Section title="ADVERSARIAL FINDINGS" count={attacks.length}>
              <ul className="checklist">
                {attacks.map((attack, index) => (
                  <li key={index}>
                    <span className={attack.material ? 'badge badge--blocked' : 'badge badge--not_started'}>
                      {attack.material ? 'VALID' : 'NOT MATERIAL'}
                    </span>{' '}
                    {attack.attack}
                    {attack.reasoning ? <div className="small muted">{attack.reasoning}</div> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {result?.researchCandidates.length ? (
            <Section title="PROPOSED RESEARCH RUNS" count={result.researchCandidates.length}>
              <p className="small muted">
                These are proposals, not runs. Create them from the PROMPT tab when you agree.
              </p>
              <ul className="checklist">
                {result.researchCandidates.map((candidate, index) => (
                  <li key={index}>
                    <strong>{candidate.title}</strong>
                    <div className="small">{candidate.researchQuestion}</div>
                    {candidate.expectedContribution ? (
                      <div className="small muted">Expected: {candidate.expectedContribution}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {result ? (
            <Section title="DETAILED REASONING">
              <div className="small">
                <div>
                  <span className="muted">Assignment satisfied: </span>
                  {result.primary.assignmentSatisfied}
                </div>
                {result.primary.requirementFindings.length > 0 ? (
                  <>
                    <div className="muted">Requirement findings</div>
                    <ul className="checklist">
                      {result.primary.requirementFindings.map((entry, i) => (
                        <li key={i}>{entry}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {result.primary.structuralFindings.length > 0 ? (
                  <>
                    <div className="muted">Structural findings</div>
                    <ul className="checklist">
                      {result.primary.structuralFindings.map((entry, i) => (
                        <li key={i}>{entry}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {result.primary.boundaryFindings.length > 0 ? (
                  <>
                    <div className="muted">Boundary findings</div>
                    <ul className="checklist">
                      {result.primary.boundaryFindings.map((entry, i) => (
                        <li key={i}>{entry}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {result.primary.consistencyFindings.length > 0 ? (
                  <>
                    <div className="muted">Consistency findings</div>
                    <ul className="checklist">
                      {result.primary.consistencyFindings.map((entry, i) => (
                        <li key={i}>
                          <span className="mono">{entry.relation}</span> {entry.detail}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {result.primary.notes ? <p className="muted">{result.primary.notes}</p> : null}
              </div>
            </Section>
          ) : null}

          {result ? (
            <Section title="RAW AI RESPONSES" count={result.passes.length}>
              {result.passes.map((pass) => (
                <div key={pass.id} className="stack stack--tight">
                  <div className="small muted">
                    {pass.passKey} · {pass.provider ?? 'unknown'} · {pass.durationMs ?? '?'}ms ·{' '}
                    {pass.ok ? 'ok' : `failed: ${pass.error ?? 'unknown error'}`}
                  </div>
                  <pre className="pre">{pass.rawResponse ?? '(no response)'}</pre>
                </div>
              ))}
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
