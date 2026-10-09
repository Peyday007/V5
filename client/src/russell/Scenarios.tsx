/**
 * Scenario modelling, as a person uses it.
 *
 * Build a model (or start from the demonstration), review every variable and
 * where it came from, set the strategies, run up to 50,000 evaluations, and
 * read what came back: outcome ranges, downside, break-evens, the inputs that
 * move the answer, the trade-offs between strategies, and the exact inputs
 * behind each bad case.
 *
 * Three things this screen must never do:
 *
 *   * **Show simulated money as money.** Every figure is labelled simulated,
 *     and an illustrative model says so on every result. Nothing here is
 *     revenue earned or income expected.
 *   * **Call coverage a probability.** A sweep over assumed ranges reports what
 *     share of the *tested conditions* had an outcome; only a run the server
 *     marks `probabilistic` may say "estimated probability".
 *   * **Declare a winner of its own.** The comparison shows what dominates what,
 *     the trade-offs among the rest, and — only when a person picks an objective
 *     — the order under it. Every sentence of verdict is the server's.
 */
import { useCallback, useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';
import type {
  Distribution,
  RunOptions,
  ScenarioModelDefinition,
  ScenarioResult,
  StrategyResult,
  SummaryStatistic,
  VariableProvenance,
} from '../../../server/domain/scenario.ts';

interface ModelSummary { id: string; title: string; illustrative: boolean; updatedAt: string; variables: number; strategies: number }
interface IndexView { models: ModelSummary[]; limits: { maxEvaluations: number }; provenances: VariableProvenance[] }
interface DemoView { definition: ScenarioModelDefinition; options: RunOptions; result: ScenarioResult }
interface RunSummary {
  id: string; label: string | null; seed: number; evaluations: number; configHash: string; state: string; reading: string;
  resultDigest: string | null; failure: string | null; elapsedMs: number | null; startedAt: string; result: ScenarioResult | null;
}
interface ModelView { model: { id: string; title: string; definition: ScenarioModelDefinition; illustrative: boolean; definitionHash: string }; runs: RunSummary[] }

const PROVENANCE_WORDS: Record<VariableProvenance, string> = {
  EVIDENCE: 'Evidence',
  HISTORICAL: 'Historical',
  ASSUMPTION: 'Assumption',
  HYPOTHETICAL: 'Hypothetical',
  UNKNOWN: 'Unknown',
};

/** A refusal's problem list, or its message. */
function problemsOf(error: unknown): string[] {
  if (error instanceof ApiError) {
    const detail = error.detail as { problems?: unknown } | null | undefined;
    if (detail && Array.isArray(detail.problems)) return detail.problems.map(String);
    return [error.message];
  }
  return [error instanceof Error ? error.message : String(error)];
}

function money(cents: number | null | undefined, currency: string): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });
}

function num(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function ScenariosView({ projectId }: { projectId: string | null }) {
  const [selected, setSelected] = useState<string>('DEMO');
  const index = useAsync(
    async () => (projectId ? await api<IndexView>(`/api/projects/${projectId}/scenarios`) : null),
    [projectId],
  );
  if (!projectId) return <p className="rs-empty">Open a project to model scenarios in it.</p>;
  if (index.error) return <p className="rs-empty">{index.error.message}</p>;
  const view = index.data;

  return (
    <div className="rs-stack rs-scenarios">
      <section className="rs-card rs-scenarios-header">
        <h2>Scenarios</h2>
        <p>
          Model a decision: the variables that bear on it and where each came from, the strategies you control, and
          the arithmetic that turns them into money, time and labour. Brain evaluates up to{' '}
          {(view?.limits.maxEvaluations ?? 50000).toLocaleString('en-US')} scenarios per run, compares strategies on
          the same scenarios, and shows what drives the result.
        </p>
        <p className="rs-hint">
          Every figure here is a simulation from stated assumptions. None of it is revenue earned, expected or
          guaranteed, and nothing here acts on the world.
        </p>
        <label className="rs-field-label" htmlFor="rs-scenario-model">Model</label>
        <select id="rs-scenario-model" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="DEMO">Demonstration — illustrative, read-only</option>
          {(view?.models ?? []).map((m) => (
            <option key={m.id} value={m.id}>{m.title}{m.illustrative ? ' (illustrative)' : ''}</option>
          ))}
        </select>
        <NewModel projectId={projectId} onCreated={(id) => { index.reload(); setSelected(id); }} />
      </section>
      {selected === 'DEMO'
        ? <Demonstration projectId={projectId} onCopied={(id) => { index.reload(); setSelected(id); }} />
        : <SavedModel key={selected} projectId={projectId} modelId={selected} />}
    </div>
  );
}

function NewModel({ projectId, onCreated }: { projectId: string; onCreated(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const create = useCallback((body: unknown) => {
    setProblems([]);
    void api<{ model: { id: string } }>(`/api/projects/${projectId}/scenarios`, { method: 'POST', body: JSON.stringify(body) }).then(
      (answer) => { setOpen(false); onCreated(answer.model.id); },
      (error: unknown) => setProblems(problemsOf(error)),
    );
  }, [projectId, onCreated]);
  return (
    <div className="rs-scenarios-actions">
      <button type="button" className="rs-button" onClick={() => create({ fromDemonstration: true })}>
        Save an editable copy of the demonstration
      </button>
      <button type="button" className="rs-button-quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        New model from a definition
      </button>
      {open ? (
        <div>
          <label className="rs-field-label" htmlFor="rs-scenario-new">Model definition (JSON)</label>
          <textarea id="rs-scenario-new" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="rs-button" onClick={() => {
            try { create({ definition: JSON.parse(text) }); } catch { setProblems(['That is not valid JSON.']); }
          }}>Create model</button>
        </div>
      ) : null}
      <Problems problems={problems} />
    </div>
  );
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="rs-scenarios-problems" role="alert">
      {problems.map((p) => <li key={p}>{p}</li>)}
    </ul>
  );
}

function Demonstration({ projectId, onCopied }: { projectId: string; onCopied(id: string): void }) {
  const demo = useAsync(async () => await api<DemoView>(`/api/projects/${projectId}/scenarios/demonstration`), [projectId]);
  if (demo.error) return <p className="rs-empty">{demo.error.message}</p>;
  if (!demo.data) return <p className="rs-empty">Running the demonstration model…</p>;
  return (
    <>
      <section className="rs-card">
        <h3>{demo.data.definition.title}</h3>
        <p>{demo.data.definition.description}</p>
        <p className="rs-hint">
          Read-only. Every input is illustrative — an assumption, a hypothetical or an unknown — so nothing about this
          model describes a real market. Save an editable copy to change it.
        </p>
        <button type="button" className="rs-button-quiet" onClick={() => {
          void api<{ model: { id: string } }>(`/api/projects/${projectId}/scenarios`, { method: 'POST', body: JSON.stringify({ fromDemonstration: true }) })
            .then((answer) => onCopied(answer.model.id));
        }}>Save an editable copy</button>
      </section>
      <Assumptions definition={demo.data.definition} editable={false} onChange={() => undefined} />
      <ResultView result={demo.data.result} definition={demo.data.definition} />
    </>
  );
}

function SavedModel({ projectId, modelId }: { projectId: string; modelId: string }) {
  const model = useAsync(async () => await api<ModelView>(`/api/projects/${projectId}/scenarios/${modelId}`), [projectId, modelId]);
  const [draft, setDraft] = useState<ScenarioModelDefinition | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const definition = draft ?? model.data?.model.definition ?? null;

  const save = useCallback(() => {
    if (!draft) return;
    setProblems([]);
    void api(`/api/projects/${projectId}/scenarios/${modelId}`, { method: 'PATCH', body: JSON.stringify({ definition: draft }) }).then(
      () => { setDraft(null); model.reload(); },
      (error: unknown) => setProblems(problemsOf(error)),
    );
  }, [draft, projectId, modelId, model]);

  const run = useCallback((options: RunOptions, label: string) => {
    setRunning(true);
    setProblems([]);
    void api<{ run: RunSummary }>(`/api/projects/${projectId}/scenarios/${modelId}/runs`, { method: 'POST', body: JSON.stringify({ options, label: label || undefined }) }).then(
      (answer) => { setRunning(false); setRunId(answer.run.id); model.reload(); },
      (error: unknown) => { setRunning(false); setProblems(problemsOf(error)); },
    );
  }, [projectId, modelId, model]);

  if (model.error) return <p className="rs-empty">{model.error.message}</p>;
  if (!model.data || !definition) return <p className="rs-empty">Reading the model…</p>;
  return (
    <>
      <section className="rs-card">
        <h3>{definition.title}</h3>
        {definition.description ? <p>{definition.description}</p> : null}
        {definition.illustrative ? <p className="rs-hint">This model is marked illustrative: its figures are examples, not data.</p> : null}
        {draft ? (
          <div className="rs-scenarios-actions">
            <button type="button" className="rs-button" onClick={save}>Save changes</button>
            <button type="button" className="rs-button-quiet" onClick={() => { setDraft(null); setProblems([]); }}>Discard changes</button>
          </div>
        ) : null}
        <Problems problems={problems} />
      </section>
      <Assumptions definition={definition} editable onChange={setDraft} />
      <Strategies definition={definition} onChange={setDraft} />
      <JsonEditor definition={definition} onChange={setDraft} />
      <RunPanel definition={definition} disabled={running || draft !== null} running={running} onRun={run} dirty={draft !== null} />
      <RunsList projectId={projectId} modelId={modelId} runs={model.data.runs} selected={runId} onSelect={setRunId} />
      {runId ? <RunResult projectId={projectId} modelId={modelId} runId={runId} /> : null}
    </>
  );
}

function describeSpec(v: ScenarioModelDefinition['variables'][number]): string {
  const s = v.spec;
  switch (s.kind) {
    case 'FIXED': return `${s.value} ${v.unit}`.trim();
    case 'RANGE': return `${s.min} to ${s.max} ${v.unit}`.trim();
    case 'TRIANGULAR': return `triangular ${s.min} / ${s.mode} / ${s.max} ${v.unit}`.trim();
    case 'NORMAL': return `normal ${s.mean} ± ${s.sd}, within ${s.min}–${s.max} ${v.unit}`.trim();
    case 'EMPIRICAL': return `${s.values.length} observations`;
    case 'CHOICE': return s.options.map((o) => o.label + (o.weight !== undefined ? ` (${o.weight})` : '')).join(' · ');
    default: return '';
  }
}

function Assumptions({ definition, editable, onChange }: { definition: ScenarioModelDefinition; editable: boolean; onChange(next: ScenarioModelDefinition): void }) {
  const edit = (key: string, field: 'value' | 'min' | 'max', raw: string): void => {
    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) return;
    onChange({
      ...definition,
      variables: definition.variables.map((v) => (v.key === key ? { ...v, spec: { ...v.spec, [field]: value } as typeof v.spec } : v)),
    });
  };
  return (
    <section className="rs-card rs-scenarios-assumptions">
      <h3>Variables and where each came from</h3>
      <p className="rs-hint">
        Evidence and historical inputs may carry a probability distribution. Assumptions, hypotheticals and unknowns
        are ranges that are swept, so their outcomes are coverage of the tested conditions, not probabilities.
      </p>
      <div className="rs-table-wrap">
        <table>
          <thead><tr><th scope="col">Variable</th><th scope="col">Basis</th><th scope="col">Kind</th><th scope="col">Value or range</th><th scope="col">Note</th></tr></thead>
          <tbody>
            {definition.variables.map((v) => (
              <tr key={v.key}>
                <th scope="row">{v.label}<br /><code>{v.key}</code></th>
                <td><span className={`rs-scenarios-prov rs-scenarios-prov-${v.provenance.toLowerCase()}`}>{PROVENANCE_WORDS[v.provenance]}</span></td>
                <td>{v.controllable ? 'Decision' : v.spec.kind === 'FIXED' ? 'Fixed' : 'Uncertain'}</td>
                <td>
                  {editable && !v.controllable && (v.spec.kind === 'FIXED' || v.spec.kind === 'RANGE') ? (
                    v.spec.kind === 'FIXED' ? (
                      <input aria-label={`${v.label} value`} type="number" defaultValue={v.spec.value} onBlur={(e) => edit(v.key, 'value', e.target.value)} />
                    ) : (
                      <span className="rs-scenarios-range">
                        <input aria-label={`${v.label} minimum`} type="number" defaultValue={v.spec.min} onBlur={(e) => edit(v.key, 'min', e.target.value)} />
                        <span>to</span>
                        <input aria-label={`${v.label} maximum`} type="number" defaultValue={v.spec.max} onBlur={(e) => edit(v.key, 'max', e.target.value)} />
                        <span>{v.unit}</span>
                      </span>
                    )
                  ) : describeSpec(v)}
                  {v.activeWhen ? <p className="rs-hint">Applies only when {v.activeWhen.variable} is {v.activeWhen.in.join(' or ')}.</p> : null}
                  {(v.responses ?? []).map((r) => (
                    <p className="rs-hint" key={r.to}>Responds to {r.to}: × ({r.to} ÷ {r.reference})^{r.elasticity} — {PROVENANCE_WORDS[r.provenance].toLowerCase()}.</p>
                  ))}
                </td>
                <td>
                  {v.note ?? ''}
                  {(v.sources ?? []).map((s) => <p className="rs-hint" key={s.ref}>Source: {s.kind} {s.ref}</p>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(definition.correlations ?? []).length > 0 ? (
        <ul className="rs-scenarios-list">
          {(definition.correlations ?? []).map((c) => (
            <li key={`${c.a}-${c.b}`}>{c.a} and {c.b} move together (rank correlation {c.rho}) — {PROVENANCE_WORDS[c.provenance].toLowerCase()}{c.note ? `: ${c.note}` : ''}</li>
          ))}
        </ul>
      ) : null}
      {(definition.constraints ?? []).length > 0 ? (
        <p className="rs-hint">Constraints: {(definition.constraints ?? []).map((c) => c.label).join('; ')}. A scenario that breaks one is counted as infeasible, never hidden.</p>
      ) : null}
    </section>
  );
}

function Strategies({ definition, onChange }: { definition: ScenarioModelDefinition; onChange(next: ScenarioModelDefinition): void }) {
  const controllable = definition.variables.filter((v) => v.controllable);
  const set = (strategy: string, key: string, value: number | string): void => {
    onChange({ ...definition, strategies: definition.strategies.map((s) => (s.key === strategy ? { ...s, set: { ...s.set, [key]: value } } : s)) });
  };
  return (
    <section className="rs-card">
      <h3>Strategies</h3>
      <p className="rs-hint">Each strategy sets the decisions you control. Every strategy is evaluated against the same scenarios.</p>
      <div className="rs-table-wrap">
        <table>
          <thead><tr><th scope="col">Strategy</th>{controllable.map((v) => <th scope="col" key={v.key}>{v.label}</th>)}</tr></thead>
          <tbody>
            {definition.strategies.map((s) => (
              <tr key={s.key}>
                <th scope="row">{s.label}</th>
                {controllable.map((v) => (
                  <td key={v.key}>
                    {v.spec.kind === 'CHOICE' ? (
                      <select aria-label={`${s.label}: ${v.label}`} value={String(s.set[v.key] ?? '')} onChange={(e) => set(s.key, v.key, e.target.value)}>
                        {v.spec.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input aria-label={`${s.label}: ${v.label}`} type="number" defaultValue={Number(s.set[v.key] ?? (v.spec.kind === 'FIXED' ? v.spec.value : 0))}
                        onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(s.key, v.key, n); }} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JsonEditor({ definition, onChange }: { definition: ScenarioModelDefinition; onChange(next: ScenarioModelDefinition): void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="rs-card">
      <summary>Edit the whole definition (JSON) — derived quantities, money lines, metrics, constraints</summary>
      <textarea aria-label="Model definition JSON" rows={16} value={text ?? JSON.stringify(definition, null, 2)} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="rs-button-quiet" onClick={() => {
        try { onChange(JSON.parse(text ?? '') as ScenarioModelDefinition); setError(null); setText(null); } catch { setError('That is not valid JSON.'); }
      }}>Use this definition</button>
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}

function RunPanel({ definition, disabled, running, dirty, onRun }: { definition: ScenarioModelDefinition; disabled: boolean; running: boolean; dirty: boolean; onRun(options: RunOptions, label: string): void }) {
  const [evaluations, setEvaluations] = useState(50000);
  const [seed, setSeed] = useState(20261008);
  const [basis, setBasis] = useState<'AUTO' | 'SWEEP' | 'MONTE_CARLO'>('AUTO');
  const [stressVar, setStressVar] = useState('');
  const [stressBy, setStressBy] = useState(2);
  const [objectiveMetric, setObjectiveMetric] = useState('');
  const [statistic, setStatistic] = useState<SummaryStatistic>('P10');
  const [label, setLabel] = useState('');
  const numeric = definition.variables.filter((v) => v.spec.kind !== 'CHOICE');
  const metrics = ['contribution', ...(definition.metrics ?? []).map((m) => m.key)];
  const submit = (): void => {
    const options: RunOptions = { seed, evaluations };
    if (basis !== 'AUTO') options.basis = basis;
    if (stressVar) options.overrides = { [stressVar]: { multiply: stressBy } };
    if (objectiveMetric) {
      const better = objectiveMetric === 'contribution' ? 'HIGHER' : (definition.metrics ?? []).find((m) => m.key === objectiveMetric)?.better ?? 'HIGHER';
      options.objective = { metric: objectiveMetric, statistic, direction: better === 'HIGHER' ? 'MAX' : 'MIN' };
    }
    onRun(options, label);
  };
  return (
    <section className="rs-card rs-scenarios-run">
      <h3>Run</h3>
      <div className="rs-scenarios-form">
        <label>Evaluations <input type="number" min={1} max={50000} value={evaluations} onChange={(e) => setEvaluations(Number(e.target.value))} /></label>
        <label>Seed <input type="number" min={0} value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>
        <label>Basis
          <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
            <option value="AUTO">Decided by the inputs</option>
            <option value="SWEEP">Sweep the ranges</option>
            <option value="MONTE_CARLO">Monte Carlo (sourced distributions only)</option>
          </select>
        </label>
        <label>Stress test
          <select value={stressVar} onChange={(e) => setStressVar(e.target.value)}>
            <option value="">None</option>
            {numeric.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
        </label>
        {stressVar ? <label>Multiply by <input type="number" step="0.1" value={stressBy} onChange={(e) => setStressBy(Number(e.target.value))} /></label> : null}
        <label>Rank by an objective you choose
          <select value={objectiveMetric} onChange={(e) => setObjectiveMetric(e.target.value)}>
            <option value="">No objective — show trade-offs only</option>
            {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {objectiveMetric ? (
          <label>Statistic
            <select value={statistic} onChange={(e) => setStatistic(e.target.value as SummaryStatistic)}>
              {(['P10', 'P50', 'P90', 'MEAN', 'MIN', 'MAX'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        ) : null}
        <label>Label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" /></label>
      </div>
      <button type="button" className="rs-button" disabled={disabled} onClick={submit}>{running ? 'Running…' : 'Run scenarios'}</button>
      {dirty ? <p className="rs-hint">Save or discard your changes first, so the run records the definition it evaluated.</p> : null}
    </section>
  );
}

function RunsList({ projectId, modelId, runs, selected, onSelect }: { projectId: string; modelId: string; runs: RunSummary[]; selected: string | null; onSelect(id: string): void }) {
  const [reproduced, setReproduced] = useState<Record<string, string>>({});
  if (runs.length === 0) return <section className="rs-card"><h3>Runs</h3><p className="rs-empty">No runs yet.</p></section>;
  return (
    <section className="rs-card">
      <h3>Runs</h3>
      <ul className="rs-scenarios-list">
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" className="rs-button-quiet" aria-pressed={selected === r.id} onClick={() => onSelect(r.id)}>
              {r.label ?? new Date(r.startedAt).toLocaleString()} — {r.reading.toLowerCase()}, {r.evaluations.toLocaleString('en-US')} evaluations, seed {r.seed}
              {r.elapsedMs !== null ? `, ${r.elapsedMs} ms` : ''}
            </button>
            {r.failure ? <p className="rs-hint">{r.failure}</p> : null}
            {r.state === 'COMPLETE' ? (
              <button type="button" className="rs-button-quiet" onClick={() => {
                void api<{ reproduction: { reproduced: boolean } }>(`/api/projects/${projectId}/scenarios/${modelId}/runs/${r.id}/reproduce`, { method: 'POST' })
                  .then((a) => setReproduced((m) => ({ ...m, [r.id]: a.reproduction.reproduced ? 'Reproduced exactly.' : 'Did not reproduce.' })));
              }}>Re-run and compare</button>
            ) : null}
            {reproduced[r.id] ? <span className="rs-hint"> {reproduced[r.id]}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunResult({ projectId, modelId, runId }: { projectId: string; modelId: string; runId: string }) {
  const run = useAsync(async () => await api<{ run: RunSummary & { config: { definition: ScenarioModelDefinition } } }>(`/api/projects/${projectId}/scenarios/${modelId}/runs/${runId}`), [projectId, modelId, runId]);
  if (run.error) return <p className="rs-empty">{run.error.message}</p>;
  if (!run.data) return <p className="rs-empty">Reading the run…</p>;
  if (!run.data.run.result) return <p className="rs-empty">This run has no result: {run.data.run.failure ?? run.data.run.reading.toLowerCase()}.</p>;
  return <ResultView result={run.data.run.result} definition={run.data.run.config.definition} />;
}

// ---------------------------------------------------------------------------
// Reading a result
// ---------------------------------------------------------------------------

export function ResultView({ result, definition }: { result: ScenarioResult; definition: ScenarioModelDefinition }) {
  const [focus, setFocus] = useState(result.strategies[0]?.key ?? '');
  const share = result.probabilistic ? 'estimated probability' : 'of tested scenarios';
  const cur = result.currency;
  const metricFor = (role: string): { key: string; label: string; unit: string } | undefined => (definition.metrics ?? []).find((m) => m.role === role);
  const exposure = metricFor('CAPITAL_EXPOSURE');
  const days = metricFor('DAYS_TO_CASH');
  const labor = metricFor('LABOR_HOURS');
  const label = (key: string): string => result.strategies.find((s) => s.key === key)?.label ?? key;
  const focused = result.strategies.find((s) => s.key === focus) ?? result.strategies[0];

  return (
    <>
      <section className="rs-card rs-scenarios-result" aria-label="Simulation result">
        <h3>Result — simulated{definition.illustrative ? ', illustrative inputs' : ''}</h3>
        <p className="rs-scenarios-basis">{result.basisNote}</p>
        <p className="rs-hint">
          {result.evaluations.toLocaleString('en-US')} evaluations: {result.scenarios.toLocaleString('en-US')} scenarios ×{' '}
          {result.strategies.length} strategies, {result.distinctScenarios.toLocaleString('en-US')} distinct scenarios, seed {result.seed},{' '}
          {result.elapsedMs} ms. Horizon: {result.horizon}. Configuration <code>{result.configHash.slice(0, 12)}</code>.
        </p>
        <div className="rs-table-wrap">
          <table>
            <caption>Contribution ({cur}, simulated) and the costs of getting it — percentages are {share}</caption>
            <thead>
              <tr>
                <th scope="col">Strategy</th><th scope="col">P10</th><th scope="col">Typical (P50)</th><th scope="col">P90</th>
                <th scope="col">Worst-10% mean</th><th scope="col">Loss</th><th scope="col">Acceptable</th><th scope="col">Best in scenario</th>
                <th scope="col">Regret P90</th>
                {exposure ? <th scope="col">{exposure.label} P50 / P90</th> : null}
                {days ? <th scope="col">{days.label} P50</th> : null}
                {labor ? <th scope="col">{labor.label} P50</th> : null}
                <th scope="col">Infeasible</th>
              </tr>
            </thead>
            <tbody>
              {result.strategies.map((s) => (
                <tr key={s.key}>
                  <th scope="row">{s.label}</th>
                  <td>{money(s.contribution?.p10, cur)}</td>
                  <td>{money(s.contribution?.p50, cur)}</td>
                  <td>{money(s.contribution?.p90, cur)}</td>
                  <td>{money(s.contribution?.tail10, cur)}</td>
                  <td>{pct(s.lossShare)}</td>
                  <td>{pct(s.acceptableShare)}</td>
                  <td>{pct(s.winShare)}</td>
                  <td>{money(s.regret.p90Cents, cur)}</td>
                  {exposure ? <td>{num(s.metrics[exposure.key]?.p50, 0)} / {num(s.metrics[exposure.key]?.p90, 0)}</td> : null}
                  {days ? <td>{num(s.metrics[days.key]?.p50)}</td> : null}
                  {labor ? <td>{num(s.metrics[labor.key]?.p50, 0)}</td> : null}
                  <td>{s.infeasible.toLocaleString('en-US')}{s.invalid > 0 ? ` (+${s.invalid} invalid)` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rs-card">
        <h3>Trade-offs</h3>
        <p className="rs-hint">Compared on: {result.dominanceCriteria.join('; ')}. No weights are applied; Brain does not declare a single best strategy.</p>
        {result.dominance.length === 0 ? <p>No strategy is dominated: each is better than every other on at least one criterion.</p> : (
          <ul className="rs-scenarios-list">
            {result.dominance.map((d) => <li key={`${d.dominated}-${d.by}`}><strong>{label(d.dominated)}</strong> is dominated by {label(d.by)} — no better on any criterion, worse on at least one.</li>)}
          </ul>
        )}
        <ul className="rs-scenarios-list">
          {result.tradeOffs.map((t) => (
            <li key={`${t.a}-${t.b}`}><strong>{label(t.a)}</strong> is better on {t.aBetterOn.join(', ')}; <strong>{label(t.b)}</strong> is better on {t.bBetterOn.join(', ')}.</li>
          ))}
        </ul>
        {result.ranking ? (
          <div>
            <h4>Under your objective: {result.ranking.objective.direction === 'MAX' ? 'maximise' : 'minimise'} {result.ranking.objective.metric} {result.ranking.objective.statistic}</h4>
            <ol>{result.ranking.order.map((o) => <li key={o.strategy}>{label(o.strategy)} — {o.value.toLocaleString('en-US', { maximumFractionDigits: 1 })}</li>)}</ol>
            {result.ranking.excluded.map((e) => <p className="rs-hint" key={e.strategy}>{label(e.strategy)} excluded: {e.reason}</p>)}
          </div>
        ) : null}
      </section>

      <section className="rs-card">
        <h3>Outcome distribution — {result.probabilistic ? 'estimated' : 'coverage of the tested ranges'}</h3>
        {result.strategies.map((s) => <Histogram key={s.key} strategy={s} currency={cur} />)}
      </section>

      <section className="rs-card">
        <h3>What drives the result</h3>
        <label className="rs-field-label" htmlFor="rs-scenario-focus">Strategy</label>
        <select id="rs-scenario-focus" value={focus} onChange={(e) => setFocus(e.target.value)}>
          {result.strategies.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <p className="rs-hint">
          Baseline contribution {money(result.sensitivity.baselineCents[focus], cur)} with every input at its baseline (range midpoint, distribution
          mode or mean, first option). Each bar moves one input across its range with the others held there.
        </p>
        <div className="rs-table-wrap">
          <table>
            <caption>One-at-a-time swings</caption>
            <thead><tr><th scope="col">Input</th><th scope="col">Basis</th><th scope="col">Low end</th><th scope="col">High end</th><th scope="col">Swing</th><th scope="col">Must hold?</th></tr></thead>
            <tbody>
              {(result.sensitivity.tornado[focus] ?? []).map((b) => (
                <tr key={b.variable}>
                  <th scope="row">{b.label}</th>
                  <td>{PROVENANCE_WORDS[b.provenance]}</td>
                  <td>{b.lowLabel ?? num(b.lowValue, 3)} → {money(b.lowCents, cur)}</td>
                  <td>{b.highLabel ?? num(b.highValue, 3)} → {money(b.highCents, cur)}</td>
                  <td>{money(b.swingCents, cur)}</td>
                  <td>{b.mustHold ? 'Yes — its adverse end turns contribution negative' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h4>What the outcome tracked across all scenarios (rank correlation)</h4>
        <ul className="rs-scenarios-list">
          {(result.sensitivity.rankCorrelation[focus] ?? []).slice(0, 6).map((r) => <li key={r.variable}>{r.label}: {r.rho > 0 ? '+' : ''}{r.rho}</li>)}
        </ul>
        <h4>Break-even thresholds (baseline)</h4>
        <ul className="rs-scenarios-list">
          {result.sensitivity.breakEvens.filter((b) => b.strategy === focus).map((b) => (
            <li key={b.variable}>{b.label}: {b.value === null ? b.note : `${num(b.value, 3)} — ${b.note}`}</li>
          ))}
        </ul>
        <h4>What if one input doubled</h4>
        <ul className="rs-scenarios-list">
          {result.sensitivity.stress.filter((s) => s.strategy === focus).map((s) => (
            <li key={s.variable}>{s.label} doubled: {money(s.baselineCents, cur)} → {money(s.doubledCents, cur)}{s.outsideTestedRange ? ' (outside the tested range)' : ''}</li>
          ))}
        </ul>
      </section>

      <section className="rs-card">
        <h3>What to find out next</h3>
        <p className="rs-hint">Inputs that are assumptions, hypotheticals or unknowns, those that would change which strategy does best first.</p>
        <ol>
          {result.sensitivity.investigate.slice(0, 6).map((i) => (
            <li key={i.variable}><strong>{i.label}</strong> ({PROVENANCE_WORDS[i.provenance].toLowerCase()}) — {i.why}</li>
          ))}
        </ol>
      </section>

      {focused ? <Downside strategy={focused} currency={cur} /> : null}

      <section className="rs-card">
        <h3>Limitations</h3>
        <ul className="rs-scenarios-list">{result.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="rs-hint">
          Inputs: {Object.entries(result.provenance).filter(([, n]) => n > 0).map(([p, n]) => `${n} ${PROVENANCE_WORDS[p as VariableProvenance].toLowerCase()}`).join(', ')}.
        </p>
      </section>
    </>
  );
}

function Histogram({ strategy, currency }: { strategy: StrategyResult; currency: string }) {
  const { edges, counts } = strategy.histogram;
  const max = Math.max(1, ...counts);
  const summary = useMemo(() => describeDistribution(strategy.contribution, currency), [strategy.contribution, currency]);
  if (counts.length === 0) return <p className="rs-hint">{strategy.label}: no feasible scenario.</p>;
  return (
    <figure className="rs-scenarios-hist">
      <figcaption>{strategy.label}: {summary}</figcaption>
      <svg viewBox={`0 0 ${counts.length * 10} 40`} role="img" aria-label={`${strategy.label} contribution histogram: ${summary}`} preserveAspectRatio="none">
        {counts.map((c, i) => {
          const h = (c / max) * 38;
          const crossesZero = (edges[i] ?? 0) < 0;
          return <rect key={i} x={i * 10 + 1} y={40 - h} width={8} height={h} className={crossesZero ? 'rs-scenarios-bar-loss' : 'rs-scenarios-bar'} />;
        })}
      </svg>
      <p className="rs-hint">{money(edges[0], currency)} to {money(edges[edges.length - 1], currency)}; bars below zero are losses.</p>
    </figure>
  );
}

function describeDistribution(d: Distribution | null, currency: string): string {
  if (!d) return 'no feasible scenario';
  return `P10 ${money(d.p10, currency)}, P50 ${money(d.p50, currency)}, P90 ${money(d.p90, currency)}`;
}

function Downside({ strategy, currency }: { strategy: StrategyResult; currency: string }) {
  return (
    <section className="rs-card">
      <h3>Worst cases for {strategy.label}, with the exact inputs behind each</h3>
      {strategy.downside.map((d) => (
        <details key={d.scenario}>
          <summary>Scenario {d.scenario}: {money(d.contributionCents, currency)}{d.infeasible.length > 0 ? ` — infeasible: ${d.infeasible.join(', ')}` : ''}</summary>
          <ul className="rs-scenarios-list">
            {Object.entries(d.inputs).map(([k, v]) => <li key={k}><code>{k}</code> = {typeof v === 'number' ? num(v, 4) : v}</li>)}
          </ul>
        </details>
      ))}
    </section>
  );
}
