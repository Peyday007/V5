/**
 * The Fleet, and the Capability Lab beside it.
 *
 * §14's question is one sentence — how much usable Brain power exists right
 * now, where is it going, and what should change — and this answers it in that
 * order, with the three capacity numbers kept apart because they are not each
 * other: a target somebody configured, a capacity the surfaces can serve, and a
 * throughput Brain has observed.
 *
 * Every number carries how well grounded it is. A ceiling nobody has reached
 * reads "not measured" and stays that way, because §15.4's rule is that
 * "tested safely through 500" must never be readable as "maximum 500".
 *
 * Raw identifiers are technical detail and arrive only for a caller entitled to
 * them — decided on the server, so this renders what it was given rather than
 * hiding what it was not supposed to receive.
 */
import { useState } from 'react';
import { RussellApi } from '../lib/russellApi.ts';
import type { FleetReading, LabExperiment, LabMode } from '../lib/russellApi.ts';
import { useAsync } from './useAsync.ts';
import { humanWhen, readingState } from './present.ts';

const EVIDENCE_WORDS: Record<string, string> = {
  MEASURED: 'measured',
  INFERRED: 'inferred',
  UNKNOWN: 'not measured',
  PROVIDER_ENFORCED: 'the provider enforced it',
};

const EVIDENCE_TONE: Record<string, string> = {
  MEASURED: 'rs-pill-good',
  INFERRED: 'rs-pill-watch',
  UNKNOWN: '',
  PROVIDER_ENFORCED: 'rs-pill-bad',
};

const MODE_WORDS: Record<string, string> = {
  HEALTH_CHECK: 'Health check',
  CALIBRATION: 'Calibration run',
  PUSH_TO_FAILURE: 'Push to failure',
  LAYOUT_TOURNAMENT: 'Work-layout tournament',
  ONE_ROUTINE_FIT: 'One-Routine fit',
  QUALITY_UNDER_PRESSURE: 'Quality under pressure',
  FLEET_PROVIDER: 'Fleet and provider',
  RECOVERY_DRILL: 'Failure and recovery drill',
};

export function FleetCentre({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.fleetReading(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const state = readingState({
    loading: query.loading,
    error: query.error,
    value: query.data ?? null,
    noun: 'the fleet',
  });
  if (state.phase !== 'READY' || !query.data) {
    return <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>;
  }
  const fleet = query.data.fleet;

  return (
    <div className="rs-column rs-column-wide">
      <p className="rs-eyebrow">Fleet</p>
      <h2 className="rs-view-title">How much power there is, and where it goes</h2>

      {/* The three numbers, kept apart. A configured target is a request; a
          usable count is a fact about surfaces; an observed throughput is the
          only one of the three that measures what Brain actually does. */}
      <div className="rs-grid">
        <Reading label="Configured target" reading={fleet.provisioned} />
        <Reading label="Usable right now" reading={fleet.usable} />
        <Reading label="Observed activations" reading={fleet.measured} />
      </div>

      <section className="rs-panel">
        <p className="rs-maturity-word">{fleet.bottleneckExplanation}</p>
        <p className="rs-hint">{fleet.ifWeAddedCapacity}</p>
        <ul className="rs-item-meta">
          <li>
            {fleet.active} running · {fleet.available} free · {fleet.cooling} cooling ·{' '}
            {fleet.unhealthy} unhealthy
          </li>
          <li>
            Waiting: {fleet.backlog.ready} ready, {fleet.backlog.leased} in flight,{' '}
            {fleet.backlog.needsHuman} stopped for a person
          </li>
          <li>
            {/* Whether the backlog fits is null when nothing has been measured,
                and a null must not render as a no. */}
            {fleet.fits === null
              ? 'Whether the fleet can clear this backlog has not been measured.'
              : fleet.fits
                ? 'Nothing is waiting.'
                : 'There is no healthy surface, so nothing can run.'}
          </li>
        </ul>
      </section>

      <section className="rs-group">
        <h3 className="rs-group-title">
          Surfaces
          <span className="rs-count">{fleet.surfaces.length}</span>
        </h3>
        <ul className="rs-list">
          {fleet.surfaces.map((surface) => (
            <li key={surface.routineId}>
              <article className="rs-card">
                <div className="rs-row">
                  <span className="rs-item-title">{surface.name}</span>
                  <span className={`rs-pill ${surface.usable ? 'rs-pill-good' : 'rs-pill-bad'}`}>
                    {surface.usable ? 'Ready' : surface.stateLabel}
                  </span>
                </div>
                <p className="rs-item-meta">
                  {surface.accountName}
                  {surface.reason ? ` · ${surface.reason}` : ''}
                </p>
                {surface.capabilities.length > 0 ? (
                  <p className="rs-item-meta rs-at-interested">
                    Can do: {surface.capabilities.join(', ')}
                  </p>
                ) : null}
                {/*
                  What actually refused, in the provider's own words.

                  The sentence above is the category; this is the evidence, and
                  it is the half an operator can act on. It arrives only at
                  technical depth and only for a surface that is not usable, so
                  a healthy fleet shows none of it.
                */}
                {surface.recordedReason ? (
                  <p className="rs-item-meta rs-at-technical">
                    Recorded when it was held back: {surface.recordedReason}
                  </p>
                ) : null}
                {/* Raw identifiers arrive only for a caller entitled to them. */}
                {surface.workerId ? (
                  <p className="rs-ref rs-at-technical">
                    {surface.routineId} · worker {surface.workerId} · {surface.consecutiveFailures}{' '}
                    failures, {surface.consecutiveNoShows} no-shows
                  </p>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      </section>

      <Policy fleet={fleet} projectId={projectId} onChanged={query.reload} />
      <Lab projectId={projectId} />
    </div>
  );
}

function Reading({
  label,
  reading,
}: {
  label: string;
  reading: FleetReading['provisioned'];
}): JSX.Element {
  return (
    <article className="rs-panel">
      <p className="rs-eyebrow">{label}</p>
      <p className="rs-hero-focus" style={{ fontSize: 'var(--step-3)' }}>
        {reading.value === null ? '—' : reading.value}
      </p>
      <p className={`rs-pill ${EVIDENCE_TONE[reading.evidence] ?? ''}`.trim()}>
        {EVIDENCE_WORDS[reading.evidence] ?? reading.evidence}
      </p>
      <p className="rs-item-meta">{reading.explanation}</p>
    </article>
  );
}

/**
 * Changing how much may run at once.
 *
 * A row, never a deployment — and it changes allocation rather than the right
 * to do anything new. The reason is required because the history is what makes
 * a change reviewable months later, and a change with no reason cannot be.
 */
function Policy({
  fleet,
  projectId,
  onChanged,
}: {
  fleet: FleetReading;
  projectId: string | null;
  onChanged(): void;
}): JSX.Element {
  const [target, setTarget] = useState(String(fleet.policy.target ?? 1));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <section className="rs-group">
      <h3 className="rs-group-title">How much may run at once</h3>
      <p className="rs-hint">
        This changes allocation. It does not grant a new kind of work, authorize spending, or
        widen anything&rsquo;s reach.
      </p>
      <div className="rs-build-submit">
        <label className="rs-decision-label" htmlFor="rs-fleet-target">
          At once
        </label>
        <input
          id="rs-fleet-target"
          type="number"
          min={0}
          max={1000}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <label className="rs-decision-label" htmlFor="rs-fleet-reason">
          Why is it changing?
        </label>
        <input
          id="rs-fleet-reason"
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          className="rs-button"
          disabled={busy || reason.trim().length === 0 || !projectId}
          onClick={() => {
            if (!projectId) return;
            setBusy(true);
            setProblem(null);
            void RussellApi.setFleetTarget(projectId, Number(target), reason.trim()).then(
              () => {
                setBusy(false);
                setReason('');
                onChanged();
              },
              () => {
                setBusy(false);
                setProblem('That did not go through. Nothing was changed — try again.');
              },
            );
          }}
        >
          {busy ? 'Saving…' : 'Change it'}
        </button>
      </div>
      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}

      {fleet.recentPolicyChanges.length > 0 ? (
        <ul className="rs-milestones rs-at-interested">
          {fleet.recentPolicyChanges.map((change) => (
            <li key={change.version}>
              v{change.version}: {change.target} at once — {change.actor}, {change.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * The Capability Lab.
 *
 * Two kinds of test, and the difference is visible rather than buried: the ones
 * that read rows and the ledger run now and cost nothing, and the ones that put
 * real pressure on real surfaces are declared with an envelope and refused
 * without a person's authorization. A refused test keeps its reason, because
 * what was asked for and why it was not allowed is worth as much as a result.
 */
function Lab({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(
    () => (projectId ? RussellApi.labExperiments(projectId) : Promise.resolve(null)),
    [projectId],
  );
  const [busy, setBusy] = useState(false);

  const experiments = query.data?.experiments ?? [];

  function declare(mode: LabMode, title: string): void {
    if (!projectId || busy) return;
    setBusy(true);
    void RussellApi.declareExperiment(projectId, {
      mode,
      title,
      envelope: {
        ceiling: 0,
        durationMinutes: 0,
        stopConditions: [],
        cleanup: 'Nothing is created.',
        rollback: 'Nothing is applied.',
        workloadClass: 'RESEARCH',
        workKind: 'SYNTHETIC',
      },
    })
      .then((answer) => RussellApi.runExperiment(projectId, answer.experiment.id, false))
      .then(
        () => {
          setBusy(false);
          query.reload();
        },
        () => setBusy(false),
      );
  }

  return (
    <section className="rs-group">
      <h3 className="rs-group-title">Capability Lab</h3>
      <p className="rs-hint">
        Two of these read rows and the dispatch ledger, and cost nothing. The rest put real
        pressure on real surfaces and are refused until somebody authorizes a ceiling, a duration
        and a stop condition.
      </p>

      <div className="rs-row">
        <button
          type="button"
          className="rs-button"
          disabled={busy || !projectId}
          onClick={() => declare('HEALTH_CHECK', 'Is the fleet reachable and able to audit?')}
        >
          {busy ? 'Running…' : 'Run a health check'}
        </button>
        <button
          type="button"
          className="rs-button"
          disabled={busy || !projectId}
          onClick={() => declare('CALIBRATION', 'What has the fleet actually done?')}
        >
          Read the ledger
        </button>
      </div>

      {query.loading ? <p className="rs-state rs-state-loading">Reading experiments…</p> : null}

      {experiments.length === 0 && !query.loading ? (
        <p className="rs-state rs-state-empty">
          Nothing has been tested yet. A health check is free and answers most of what goes wrong.
        </p>
      ) : null}

      <ul className="rs-list">
        {experiments.map((experiment) => (
          <li key={experiment.id}>
            <Experiment experiment={experiment} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Experiment({ experiment }: { experiment: LabExperiment }): JSX.Element {
  const when = humanWhen(experiment.createdAt);
  const result = experiment.result;
  return (
    <article className="rs-card">
      <div className="rs-row">
        <span className="rs-item-title">{experiment.title}</span>
        <span className="rs-pill">{MODE_WORDS[experiment.mode] ?? experiment.mode}</span>
        <span
          className={`rs-pill ${
            experiment.state === 'COMPLETE'
              ? 'rs-pill-good'
              : experiment.state === 'REFUSED'
                ? 'rs-pill-watch'
                : ''
          }`.trim()}
        >
          {experiment.state === 'REFUSED' ? 'Not run' : experiment.state.toLowerCase()}
        </span>
        {when ? (
          <time className="rs-when" dateTime={experiment.createdAt} title={when.exact}>
            {when.text}
          </time>
        ) : null}
      </div>

      {/* A refusal keeps its reason. It is evidence of what was asked for and
          why it was not allowed, which an error message would have lost. */}
      {experiment.refusalReason ? (
        <p className="rs-item-meta">{experiment.refusalReason}</p>
      ) : null}

      {result ? (
        <>
          <p className="rs-mission-why">{result.whatHappened}</p>
          <dl className="rs-mission-how">
            <dt>Bottleneck</dt>
            <dd>
              {result.bottleneck.value}{' '}
              <em>({EVIDENCE_WORDS[result.bottleneck.evidence] ?? result.bottleneck.evidence})</em>
            </dd>
            <dt>Recommended</dt>
            <dd>
              {result.recommendedSetting.value}{' '}
              <em>
                ({EVIDENCE_WORDS[result.recommendedSetting.evidence] ??
                  result.recommendedSetting.evidence}
                )
              </em>
            </dd>
            <dt>Highest tested</dt>
            <dd>
              {/* The sentence §15.4 insists on: a number reached without
                  failure is a lower bound, never a maximum. */}
              {result.highestTested.value === null
                ? 'Nothing was reached, so no capacity claim can be made.'
                : result.highestTested.anythingFailed
                  ? `Failed at ${result.highestTested.value}.`
                  : `Tested safely through ${result.highestTested.value}. That is a lower bound, not a maximum.`}
            </dd>
          </dl>

          {result.findings.length > 0 ? (
            <ul className="rs-milestones">
              {result.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          ) : null}

          {result.untested.length > 0 ? (
            <details className="rs-mission-how rs-at-interested">
              <summary>What this did not test</summary>
              <ul className="rs-milestones">
                {result.untested.map((item) => (
                  <li key={item} className="rs-milestone-open">
                    {item}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <p className="rs-hint rs-at-technical">
            Sample size {result.confidence.sampleSize}. {result.confidence.note}
          </p>
        </>
      ) : null}
    </article>
  );
}
