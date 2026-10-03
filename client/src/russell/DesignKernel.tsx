/**
 * The design kernel (§42), as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Every sentence on this screen is the server's
 * ---------------------------------------------------------------------------
 *
 * `services/design/view.ts`'s `designKernelView()` already does every reading
 * and every ranking this screen needs — which screens the kernel would look
 * at first and why (`rankSurfaces`' own `because`), how weak each of its own
 * abilities is (`describeCapability`, `weakestFirst`), what it found, what the
 * owner told it, what it learned and what it is trying to become able to do.
 * Nothing here re-derives a verdict, re-orders a list or composes an
 * explanation of its own. §29 records what two readers of one fact cost, and
 * §33 records it again: a screen that paraphrases a decision will eventually
 * paraphrase it wrongly, and then a person is reading one thing while the
 * machinery acts on another.
 *
 * ---------------------------------------------------------------------------
 * Two things this screen must not do — Machines.tsx's and Labor.tsx's rules,
 * kept identical here rather than reinvented
 * ---------------------------------------------------------------------------
 *
 * **It must not render an unknown as a number.** `UNTESTED`, `ABSENT` and
 * `UNKNOWN` are readings, not zeroes: a capability nothing implements cannot
 * have produced a finding, so an absent demand count is the absence of a
 * *reading* rather than a reading of absence, and rendering it as `0` or as a
 * percentage or a success-coloured element would be exactly the confident
 * wrong answer §30 and §38 both record as worse than no answer.
 *
 * **It must not disappear a section for want of rows.** Every list below
 * renders its own "nothing here yet" sentence on an empty kernel rather than
 * vanishing, because a screen whose sections come and go with the data is one
 * a person can no longer trust to show them everything that is there.
 *
 * ---------------------------------------------------------------------------
 * Why there is no control anywhere on this page
 * ---------------------------------------------------------------------------
 *
 * The kernel decides for itself what to render next, what to promote and what
 * to research — every one of those is a tick, a bin or a Russell candidate
 * this screen has no business triggering. The one thing a person could add —
 * an owner correction — is recorded through the terminal (`npm run design`),
 * exactly as `docs/DESIGN-KERNEL.md` describes, because a screen that could
 * write here would be a second, weaker way in beside the one the kernel
 * already reads corrections through. This is a reader, not an operator
 * console.
 */
import {
  DesignKernelApi,
  type CapabilityView,
  type DesignCorrection,
  type DesignCycle,
  type DesignFinding,
  type DesignKernelView,
  type DesignPattern,
  type ExpansionView,
  type RuntimeAvailability,
  type SurfaceRanking,
} from '../lib/designKernelApi.ts';
import { useAsync } from './useAsync.ts';

/**
 * A closed-set value as a person reads it.
 *
 * Presentation only, and a *fallback* rather than a dictionary: an unknown
 * value renders as its own words with the underscores taken out, so a
 * vocabulary that grows on the server never leaves a blank on the screen.
 */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

export function DesignKernel(): JSX.Element {
  const query = useAsync<DesignKernelView>(() => DesignKernelApi.kernel(), []);

  /*
   * A re-read leaves the previous answer up until the new one arrives —
   * `MachinesView`'s rule and §29's own reason for it: the loading branch must
   * never unmount a section that is already on screen.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty">Reading the design kernel…</p>;
  }
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading the design kernel…</p>;

  return (
    <div className="rs-stack rs-design">
      <h2>Design kernel</h2>
      <p className="rs-hint">
        Brain-wide rather than one project's: §42's tables carry no project, so this reads the
        whole kernel — every registered surface, every ability it has and has not proven, every
        open finding, every cycle, every pattern, every correction an owner gave it and every
        expansion it has proposed for itself.
      </p>
      <Runtime runtime={view.runtime} />
      <Surfaces surfaces={view.surfaces} />
      <Capabilities capabilities={view.capabilities} />
      <OpenFindings findings={view.openFindings} />
      <Cycles cycles={view.cycles} />
      <Patterns patterns={view.patterns} />
      <Corrections corrections={view.corrections} />
      <Expansions expansions={view.expansions} />
    </div>
  );
}

/**
 * What can actually be worked on now.
 *
 * A filter, never a ranking: a lane with no reason is healthy, and a lane with
 * one is not therefore unimportant — it simply cannot run right now, and the
 * reason says why.
 */
function Runtime({ runtime }: { runtime: RuntimeAvailability }): JSX.Element {
  return (
    <section className="rs-card rs-design-runtime">
      <h3>What can run right now</h3>
      <ul className="rs-design-lanes">
        <li className={runtime.canRender ? 'rs-design-lane-ok' : 'rs-design-lane-blocked'}>
          Render: {runtime.canRender ? 'can render' : 'cannot render'}
        </li>
        <li className={runtime.canJudge ? 'rs-design-lane-ok' : 'rs-design-lane-blocked'}>
          Judge: {runtime.canJudge ? 'can judge' : 'cannot judge'}
        </li>
      </ul>
      {runtime.reasons.length === 0 ? (
        <p className="rs-hint">Nothing is blocking either lane.</p>
      ) : (
        <ul className="rs-design-reasons">
          {runtime.reasons.map((one, index) => (
            <li key={`${one.lane}-${index}`}>
              <strong>{words(one.lane)}</strong>
              <p className="rs-hint">{one.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Which screens the kernel would look at first, and why.
 *
 * `because` is the server's own sentence, composed from the same inputs shown
 * beside it — nothing here re-explains a ranking the server already explained.
 */
function Surfaces({ surfaces }: { surfaces: SurfaceRanking[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-surfaces">
      <h3>Which screens, first</h3>
      {surfaces.length === 0 ? (
        <p className="rs-hint">No surface is registered yet.</p>
      ) : (
        <ol className="rs-design-ranked">
          {surfaces.map((entry) => (
            <li key={entry.surface.id}>
              <div className="rs-design-surface-head">
                <strong>{entry.surface.title}</strong>
                <span className="rs-hint"> — {entry.surface.route}</span>
              </div>
              <p className="rs-hint">{entry.because}</p>
              {entry.surface.retiredAt ? (
                <p className="rs-hint">Retired: {entry.surface.retiredReason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Every capability, weakest ability first.
 *
 * `abilityState` and `evidenceState` are rendered as their own words rather
 * than as a score, and `demandKnown: false` renders as *not measured* rather
 * than as `0` — the identical rule Labor.tsx already carries for its own
 * capability readings, applied here for the identical reason.
 */
function Capabilities({ capabilities }: { capabilities: CapabilityView[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-capabilities">
      <h3>What it can do</h3>
      {capabilities.length === 0 ? (
        <p className="rs-hint">No capability is registered yet.</p>
      ) : (
        <ul className="rs-design-caps">
          {capabilities.map((entry) => (
            <li key={entry.capability.id}>
              <div className="rs-design-cap-head">
                <strong>{entry.capability.title}</strong>
                <span className="rs-design-ability">{words(entry.capability.abilityState)}</span>
                <span className="rs-design-evidence">{words(entry.capability.evidenceState)}</span>
              </div>
              <p className="rs-hint">{entry.description}</p>
              <p className="rs-hint">
                Demand:{' '}
                {entry.demandKnown ? entry.demand : 'not measured'} — {entry.because}
              </p>
              {entry.capability.limitations.length > 0 ? (
                <ul className="rs-design-limitations">
                  {entry.capability.limitations.map((one, index) => (
                    <li key={index}>{one}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every open finding, across every surface. */
function OpenFindings({ findings }: { findings: DesignFinding[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-findings">
      <h3>Open findings</h3>
      {findings.length === 0 ? (
        <p className="rs-hint">Nothing is open.</p>
      ) : (
        <ul className="rs-design-finding-list">
          {findings.map((finding) => (
            <li key={finding.id}>
              <div className="rs-design-finding-head">
                <strong>{finding.surfaceKey}</strong>
                <span className="rs-design-severity">{words(finding.severity)}</span>
                <span className="rs-hint">{words(finding.kind)}</span>
              </div>
              <p className="rs-hint">{finding.statement}</p>
              <p className="rs-hint">{finding.whyItMatters}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every cycle, open and closed, carrying its own state and stop reason. */
function Cycles({ cycles }: { cycles: DesignCycle[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-cycles">
      <h3>Cycles</h3>
      {cycles.length === 0 ? (
        <p className="rs-hint">No cycle has run yet.</p>
      ) : (
        <ul className="rs-design-cycle-list">
          {cycles.map((cycle) => (
            <li key={cycle.id}>
              <div className="rs-design-cycle-head">
                <span className="rs-hint">{words(cycle.triggerKind)}</span>
                <span
                  className={
                    cycle.state === 'OPEN' ? 'rs-design-cycle-open' : 'rs-design-cycle-closed'
                  }
                >
                  {words(cycle.state)}
                </span>
              </div>
              <p className="rs-hint">
                {cycle.passes} pass(es)
                {cycle.stopReason ? ` — ${words(cycle.stopReason)}` : ''}
              </p>
              {cycle.stopDetail ? <p className="rs-hint">{cycle.stopDetail}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every pattern, carrying its origin, scope and confidence. */
function Patterns({ patterns }: { patterns: DesignPattern[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-patterns">
      <h3>Patterns</h3>
      {patterns.length === 0 ? (
        <p className="rs-hint">No pattern has been recorded yet.</p>
      ) : (
        <ul className="rs-design-pattern-list">
          {patterns.map((pattern) => (
            <li key={pattern.id}>
              <div className="rs-design-pattern-head">
                <strong>{pattern.statement}</strong>
                <span className="rs-hint">{words(pattern.origin)}</span>
                <span className="rs-hint">{words(pattern.scope)}</span>
                <span className="rs-hint">{words(pattern.confidence)}</span>
              </div>
              <p className="rs-hint">{pattern.appliesWhen}</p>
              {pattern.exceptions ? <p className="rs-hint">Exceptions: {pattern.exceptions}</p> : null}
              <p className="rs-hint">{words(pattern.state)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every owner correction, the stored words verbatim, the lesson kept
 * separate.
 *
 * `correction` is what the owner actually said and is never paraphrased here;
 * `lesson` is what Brain took from it, which is a different fact and is shown
 * beside it rather than merged into it, so somebody can say "that is not what
 * I meant" without the evidence having been overwritten.
 */
function Corrections({ corrections }: { corrections: DesignCorrection[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-corrections">
      <h3>What the owner said</h3>
      {corrections.length === 0 ? (
        <p className="rs-hint">Nothing has been recorded yet.</p>
      ) : (
        <ul className="rs-design-correction-list">
          {corrections.map((correction) => (
            <li key={correction.id}>
              <blockquote className="rs-design-correction-text">{correction.correction}</blockquote>
              {correction.lesson ? (
                <p className="rs-hint">Lesson: {correction.lesson}</p>
              ) : (
                <p className="rs-hint">Not yet taken as a lesson.</p>
              )}
              <p className="rs-hint">
                {words(correction.scope)}
                {correction.scopeRef ? ` — ${correction.scopeRef}` : ''} —{' '}
                {words(correction.confidence)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every expansion the kernel has proposed for itself.
 *
 * `live` is decided the same way `repos/design.ts`'s `liveExpansionFor` decides
 * it — `IDENTIFIED` or `ROUTED` is live, everything else carries its own state
 * and is shown rather than dropped, because a settled expansion is a reading
 * of the kernel's own history and not noise to clear away.
 */
function Expansions({ expansions }: { expansions: ExpansionView[] }): JSX.Element {
  return (
    <section className="rs-card rs-design-expansions">
      <h3>What it is trying to become able to do</h3>
      {expansions.length === 0 ? (
        <p className="rs-hint">Nothing has been proposed yet.</p>
      ) : (
        <ul className="rs-design-expansion-list">
          {expansions.map((expansion) => (
            <li key={expansion.id} className={expansion.live ? 'rs-design-expansion-live' : undefined}>
              <div className="rs-design-expansion-head">
                <strong>{expansion.statement}</strong>
                <span className="rs-hint">{words(expansion.state)}</span>
              </div>
              <p className="rs-hint">{expansion.why}</p>
              <p className="rs-hint">
                {words(expansion.route)}
                {expansion.routeRef ? ` — ${expansion.routeRef}` : ''}
              </p>
              {expansion.outcome ? <p className="rs-hint">{expansion.outcome}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
