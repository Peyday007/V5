/**
 * The manufacturing programme, as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * One authoritative verdict, composed on the server
 * ---------------------------------------------------------------------------
 *
 * Every verdict, every reason and every condition on this screen is a string
 * the server produced. Nothing here re-derives a status, re-orders a ladder or
 * composes an explanation of its own — §29 records what two readers of one fact
 * cost, and §33 records it again: a screen that paraphrases a decision will
 * eventually paraphrase it wrongly, and then a person is reading one thing
 * while the machinery acts on another.
 *
 * ---------------------------------------------------------------------------
 * The one thing this screen must not become
 * ---------------------------------------------------------------------------
 *
 * **There is no control here that lets Brain infer or award a held
 * capability.** A capability a machine *teaches* is never one this company
 * holds; only a person records that, and the only control that does it demands
 * a sentence saying how it came to be true. The screen shows required against
 * held plainly, side by side, because the *difference* between them is the
 * whole kernel — a single "12 capabilities" would read as competence.
 *
 * Research claims and company-held declarations are kept visually and
 * structurally apart for the same reason: one is what published sources say
 * about machines, the other is what this company can do, and nothing derives
 * the second from the first.
 */
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';

interface ConditionReading {
  condition: string;
  answer: 'MET' | 'NOT_MET' | 'UNKNOWN';
  because: string;
}

interface CapabilityRow {
  id: string;
  name: string;
  heldAt: string | null;
  heldEvidence: string | null;
  heldBy: string | null;
  heldNote: string | null;
}

interface EvidenceEntry {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  observedOn: string | null;
}

interface CapitalEntry {
  id: string;
  requirement: string;
  scenario: string;
  amountLowMinor: number | null;
  amountHighMinor: number | null;
  currency: string | null;
  basis: string;
  asOf: string;
  statement: string;
}

interface ScenarioReading {
  scenario: string;
  /** Null means a requirement here has no published figure. Never rendered as 0. */
  totals: { currency: string; lowMinor: number; highMinor: number }[] | null;
  priced: CapitalEntry[];
  unpriced: CapitalEntry[];
  because: string;
}

interface CapitalReading {
  state: 'UNEXAMINED' | 'PARTIAL' | 'ESTABLISHED';
  scenarios: ScenarioReading[];
  cheapestFullyPriced: ScenarioReading | null;
  unpricedRequirements: string[];
  because: string;
}

interface CategoryReading {
  categoryId: string;
  path: string[];
  verdict: string;
  conditions: ConditionReading[];
  missing: { capability: CapabilityRow; taughtBy: { id: string; name: string }[] }[];
  held: CapabilityRow[];
  wouldTeach: CapabilityRow[];
  barriers: string[];
  capital: CapitalReading;
  evidence: {
    demand: EvidenceEntry[];
    distribution: EvidenceEntry[];
    against: EvidenceEntry[];
    boughtIn: EvidenceEntry[];
  };
  because: string;
}

interface FactorReading {
  factor: string;
  value: number;
  because: string;
}

interface PriorityEntry {
  categoryId: string;
  path: string[];
  position: number;
  factors: FactorReading[];
  separatedBy: { factor: string; because: string } | null;
  because: string;
}

interface AcquisitionRow {
  candidate: {
    id: string;
    name: string;
    contribution: string;
    statement: string;
    sourceClaimId: string;
    setAsideAt: string | null;
    setAsideReason: string | null;
  };
  subject: string | null;
}

interface OpenQuestion {
  topic: string;
  state: 'OPEN' | 'RESOLVED';
  resolution: string | null;
  resolvedAt: string | null;
  question: string;
  criteria: string[];
  dependencies: string[];
  trigger: string;
  because: string;
}

interface CapabilityReading {
  capability: CapabilityRow;
  requiredBy: { categoryId: string; name: string; path: string[] }[];
  taughtBy: { categoryId: string; name: string; path: string[] }[];
}

interface RoundReading {
  id: string;
  purpose: string;
  state: string;
  round: number;
  subject: string | null;
  openedAt: string;
  harvestedAt: string | null;
  found: number | null;
  barren: boolean;
}

interface PersonDecision {
  kind: string;
  what: string;
  why: string;
  categoryId: string | null;
  capabilities: { id: string; name: string; taughtBy: string[] }[];
}

interface ProgrammeView {
  program: { id: string; objective: string; state: string };
  authorized: boolean;
  directive: {
    path: string | null;
    sha256: string | null;
    reaching: boolean;
    why: string | null;
    bands: { ordinal: number; name: string; examples: string }[];
    sequencingRefusal: string | null;
  };
  frontier: PriorityEntry[];
  counts: {
    categories: number;
    retired: number;
    capabilities: number;
    capabilitiesHeld: number;
    openRounds: number;
    settledRounds: number;
    capitalRequirements: number;
    capitalRequirementsPriced: number;
    acquisitionCandidates: number;
    acquisitionCandidatesSetAside: number;
  };
  ladder: CategoryReading[];
  enterable: CategoryReading[];
  acquisitions: AcquisitionRow[];
  openQuestions: OpenQuestion[];
  next: {
    reading: CategoryReading;
    bridges: { categoryId: string; name: string; supplies: string[] }[];
  }[];
  plan: {
    asks: { purpose: string; subject: string; why: string }[];
    declined: { subject: string; why: string }[];
  };
  open: { id: string; purpose: string; round: number }[];
  capabilities: CapabilityReading[];
  history: RoundReading[];
  refusals: { at: string; claimId: string; why: string }[];
  decisions: PersonDecision[];
}

/**
 * What each state means, in one line.
 *
 * Presentational only: the server decides which state this is, and this maps it
 * to a sentence. A screen that decided the state itself would be the second
 * reader §29 keeps having to remove.
 */
const PROGRAMME_STATE: Record<string, string> = {
  ACTIVE: 'Running — Brain is opening questions and filing what comes back.',
  PAUSED: 'Deferred — everything already running still finishes and is filed.',
  ARCHIVED: 'Stopped — the research authority was withdrawn.',
};

const ANSWER_LABEL: Record<ConditionReading['answer'], string> = {
  MET: 'met',
  NOT_MET: 'not met',
  UNKNOWN: 'not established',
};

const CONDITION_LABEL: Record<string, string> = {
  DEMAND_ESTABLISHED: 'Somebody is buying',
  ROUTE_TO_BUYER_ESTABLISHED: 'There is a route to them',
  REQUIREMENTS_KNOWN: 'What producing requires is known',
  CAPABILITIES_HELD: 'We hold what it requires',
  ENTRY_COST_ESTABLISHED: 'What entering costs is known',
};

/**
 * A closed-set value as a person reads it.
 *
 * Presentation only, and a *fallback* rather than a dictionary: an unknown
 * value renders as its own words with the underscores taken out, so a
 * vocabulary that grows on the server never leaves a blank on the screen. §29
 * records what a screen that silently drops what it does not recognise costs.
 */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

/**
 * Minor units as a figure.
 *
 * Two decimal places for every currency, matching the server's own rendering
 * rather than guessing an exponent per currency — inventing precision is the
 * thing this whole capital reading exists to refuse.
 */
function money(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

const VERDICT_LABEL: Record<string, string> = {
  ENTER: 'Ready to enter',
  COST_UNKNOWN: 'Entry cost not established',
  BUILD_CAPABILITY_FIRST: 'Capability first',
  NO_ROUTE_FOUND: 'No route to buyers found',
  INVESTIGATING: 'Being researched',
  UNEXAMINED: 'Not yet examined',
  NO_DEMAND_FOUND: 'No demand found',
  RETIRED: 'Retired',
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MachinesView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<ProgrammeView | null>(
    async () =>
      projectId ? api<ProgrammeView>(`/api/projects/${projectId}/manufacturing`) : null,
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see its manufacturing programme.</p>;
  }
  /*
   * A re-read leaves the previous answer up until the new one arrives.
   *
   * `reload()` sets `loading`, and returning the loading paragraph here
   * unmounted **every section on the page** — including the form a person was
   * part-way through. §29 records the production instance one surface along:
   * pressing the button reloaded the list, the reload counted as loading, and
   * loading unmounted the section, taking the invitation shown once down with
   * it. Every server test passed.
   *
   * So the placeholder is for the *first* read only, and a refresh keeps what
   * is on screen until it can be replaced.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty">Reading the programme…</p>;
  }
  if (query.error?.status === 404) {
    return <StartProgramme projectId={projectId} reload={query.reload} />;
  }
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Nothing to show.</p>;

  return (
    <div className="rs-stack rs-machines">
      <ProgrammeHeader view={view} />
      <Lifecycle view={view} projectId={projectId} reload={query.reload} />
      <Decisions view={view} projectId={projectId} reload={query.reload} />
      <OpenQuestions view={view} projectId={projectId} reload={query.reload} />
      <Frontier view={view} />
      <NowResearching view={view} />
      <Ladder view={view} />
      <Acquisitions view={view} projectId={projectId} reload={query.reload} />
      <Ledger view={view} />
      <History view={view} />
    </div>
  );
}

function ProgrammeHeader({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-state">
      <h2>Manufacturing programme</h2>
      <p className="rs-machines-status">
        {PROGRAMME_STATE[view.program.state] ?? view.program.state}
      </p>
      {!view.authorized ? (
        <p className="rs-hint rs-machines-warn">
          No live research grant covers this programme, so nothing it asks could run.
        </p>
      ) : null}
      <p className="rs-hint">{view.program.objective}</p>
      <ul className="rs-machines-counts">
        <li>
          <strong>{view.counts.categories}</strong> categories considered
          {view.counts.retired > 0 ? ` (${view.counts.retired} retired)` : ''}
        </li>
        <li>
          <strong>
            {view.counts.capabilitiesHeld} of {view.counts.capabilities}
          </strong>{' '}
          capabilities held
        </li>
        <li>
          <strong>{view.counts.openRounds}</strong> questions running,{' '}
          {view.counts.settledRounds} settled
        </li>
        <li>
          <strong>
            {view.counts.capitalRequirementsPriced} of {view.counts.capitalRequirements}
          </strong>{' '}
          entry requirements carry a published figure
        </li>
        <li>
          <strong>{view.counts.acquisitionCandidates}</strong> firms named
          {view.counts.acquisitionCandidatesSetAside > 0
            ? ` (${view.counts.acquisitionCandidatesSetAside} set aside)`
            : ''}
        </li>
      </ul>
      <Directive directive={view.directive} />
    </section>
  );
}

/**
 * The directive this programme runs under, and whether it is reaching the
 * questions.
 *
 * Two facts, said separately, because recording a path and a digest proves the
 * file has not changed and proves nothing about whether one word of it reached
 * a worker. A programme whose directive stopped being readable says so here
 * rather than quietly producing assignments that carry only its objective.
 *
 * The example levels are shown as **illustrations of scale**, and they are
 * shown only together with the directive's own refusal of its own sequencing —
 * which is a property of the server, which returns the two together and
 * returns neither without the other. Nothing on the ladder is compared to one,
 * no category carries a level, and they appear in no ordering anything acts
 * on.
 */
function Directive({ directive }: { directive: ProgrammeView['directive'] }): JSX.Element {
  return (
    <div className="rs-machines-directive">
      <h4>Directive</h4>
      {directive.path ? (
        <p className="rs-hint">
          <code>{directive.path}</code>
          {directive.sha256 ? (
            <span className="rs-machines-digest"> sha-256 {directive.sha256.slice(0, 12)}…</span>
          ) : null}
        </p>
      ) : null}
      <p className={directive.reaching ? 'rs-hint' : 'rs-machines-warn'}>
        {directive.reaching
          ? 'Its own sentences are carried into every question this programme asks — its core ' +
            'principle, its evaluation dimensions, its compounding questions and its ' +
            'vertical-integration test. A path and a digest alone would prove only that the ' +
            'file had not changed.'
          : (directive.why ??
            'The directive is not reaching the questions this programme asks.')}
      </p>
      {directive.bands.length > 0 && directive.sequencingRefusal ? (
        <details className="rs-machines-bands">
          <summary>The scales it illustrates ({directive.bands.length})</summary>
          <p className="rs-hint">{directive.sequencingRefusal}</p>
          <ul>
            {directive.bands.map((band) => (
              <li key={band.ordinal}>
                <strong>{words(band.name)}</strong>
                <span className="rs-hint"> — {band.examples}</span>
              </li>
            ))}
          </ul>
          <p className="rs-hint">
            These are search seeds and a span of scale, never an order. Nothing on the ladder
            carries a level, nothing is ranked by one, and Brain does not work through them.
          </p>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The decisions that are genuinely yours.
 *
 * Only two kinds reach here, and both are things no amount of research could
 * settle. A list that also carried everything Brain is merely *doing* is a list
 * nobody finishes reading.
 */
function Decisions({
  view,
  projectId,
  reload,
}: {
  view: ProgrammeView;
  projectId: string;
  reload: () => void;
}): JSX.Element | null {
  if (view.decisions.length === 0) {
    return (
      <section className="rs-card rs-machines-decisions">
        <h3>Needs you</h3>
        <p className="rs-hint">
          Nothing is waiting on a decision. Brain keeps researching, and a category only
          reaches you once published sources have settled everything they can.
        </p>
      </section>
    );
  }
  return (
    <section className="rs-card rs-machines-decisions">
      <h3>Needs you</h3>
      {view.decisions.map((decision, index) => (
        <article key={`${decision.kind}-${decision.categoryId ?? index}`} className="rs-machines-decision">
          <p className="rs-machines-decision-what">{decision.what}</p>
          <p className="rs-hint">{decision.why}</p>
          {decision.capabilities.length > 0 ? (
            <DeclareHeld
              projectId={projectId}
              capabilities={decision.capabilities}
              reload={reload}
            />
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * The only control on this screen that records a held capability.
 *
 * It demands a sentence saying how it came to be true, and the server refuses
 * an empty one — a capability recorded as held for no stated reason is
 * indistinguishable afterwards from one somebody guessed. Nothing is
 * pre-filled, nothing is suggested, and there is no control anywhere that marks
 * one held from what research established.
 */
function DeclareHeld({
  projectId,
  capabilities,
  reload,
}: {
  projectId: string;
  capabilities: { id: string; name: string; taughtBy: string[] }[];
  reload: () => void;
}): JSX.Element {
  const [chosen, setChosen] = useState(capabilities[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/projects/${projectId}/manufacturing/capabilities`, {
        method: 'POST',
        body: JSON.stringify({ capabilityId: chosen, note }),
      });
      setNote('');
      reload();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }, [chosen, note, projectId, reload]);

  return (
    <div className="rs-machines-declare">
      <ul className="rs-machines-gap">
        {capabilities.map((one) => (
          <li key={one.id}>
            <strong>{one.name}</strong>
            {one.taughtBy.length > 0 ? (
              <span className="rs-hint"> — developed by {one.taughtBy.join(', ')}</span>
            ) : (
              <span className="rs-hint"> — nothing on the ladder develops this yet</span>
            )}
          </li>
        ))}
      </ul>
      <label>
        Which capability
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {capabilities.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        How this company came to hold it
        <textarea
          value={note}
          rows={2}
          placeholder="What was hired, bought, built or delivered."
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button type="button" disabled={busy || note.trim().length === 0} onClick={submit}>
        Record as held
      </button>
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </div>
  );
}

function NowResearching({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-now">
      <h3>Research</h3>
      {view.open.length === 0 ? (
        <p className="rs-hint">No question is running.</p>
      ) : (
        <ul className="rs-machines-open">
          {view.open.map((one) => (
            <li key={one.id}>
              <span className="rs-machines-purpose">{one.purpose}</span> round {one.round}
            </li>
          ))}
        </ul>
      )}
      {view.plan.asks.length > 0 ? (
        <>
          <h4>Next</h4>
          <ul className="rs-machines-asks">
            {view.plan.asks.map((one) => (
              <li key={`${one.purpose}-${one.subject}`}>
                <span className="rs-machines-purpose">{one.purpose}</span> {one.subject}
                <p className="rs-hint">{one.why}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {view.plan.declined.length > 0 ? (
        <details className="rs-machines-declined">
          <summary>Considered and not asked ({view.plan.declined.length})</summary>
          <ul>
            {view.plan.declined.map((one, index) => (
              <li key={`${one.subject}-${index}`}>
                {one.subject} — <span className="rs-hint">{one.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {view.refusals.length > 0 ? (
        <details className="rs-machines-refusals">
          <summary>Declarations Brain could not file ({view.refusals.length})</summary>
          <ul>
            {view.refusals.map((one) => (
              <li key={one.claimId}>
                <code>{one.claimId}</code> — <span className="rs-hint">{one.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Ladder({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-ladder">
      <h3>Categories</h3>
      {view.ladder.length === 0 ? (
        <p className="rs-hint">Nothing is on the ladder yet.</p>
      ) : null}
      {view.ladder.map((reading) => (
        <article key={reading.categoryId} className="rs-machines-category">
          <header>
            <h4>{reading.path.join(' → ')}</h4>
            <span className={`rs-machines-verdict rs-machines-verdict-${reading.verdict}`}>
              {VERDICT_LABEL[reading.verdict] ?? reading.verdict}
            </span>
          </header>
          {/* The server's own sentence, never one composed here. */}
          <p className="rs-machines-because">{reading.because}</p>
          <ul className="rs-machines-conditions">
            {reading.conditions.map((condition) => (
              <li key={condition.condition} className={`rs-machines-${condition.answer}`}>
                <span className="rs-machines-answer">{ANSWER_LABEL[condition.answer]}</span>{' '}
                {CONDITION_LABEL[condition.condition] ?? condition.condition}
                <p className="rs-hint">{condition.because}</p>
              </li>
            ))}
          </ul>
          <div className="rs-machines-capsplit">
            <div>
              <h5>Required, and held</h5>
              {reading.held.length === 0 ? (
                <p className="rs-hint">None recorded.</p>
              ) : (
                <ul>
                  {reading.held.map((one) => (
                    <li key={one.id}>
                      {one.name}
                      {one.heldNote ? <span className="rs-hint"> — {one.heldNote}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h5>Required, and not held</h5>
              {reading.missing.length === 0 ? (
                <p className="rs-hint">None outstanding.</p>
              ) : (
                <ul>
                  {reading.missing.map((gap) => (
                    <li key={gap.capability.id}>
                      {gap.capability.name}
                      {gap.taughtBy.length > 0 ? (
                        <span className="rs-hint">
                          {' '}
                          — developed by {gap.taughtBy.map((one) => one.name).join(', ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {reading.wouldTeach.length > 0 ? (
            <p className="rs-hint rs-machines-unlocks">
              Producing here would develop{' '}
              {reading.wouldTeach.map((one) => one.name).join(', ')}, which something else on
              the ladder requires.
            </p>
          ) : null}
          {reading.barriers.length > 0 ? (
            <p className="rs-hint">Must be obtained first: {reading.barriers.join(', ')}</p>
          ) : null}
          <Capital reading={reading.capital} />
          <Evidence reading={reading} />
        </article>
      ))}
    </section>
  );
}

/**
 * The capability ledger, and what holding each one would unlock.
 *
 * `requiredBy` is the answer to *what does this unlock* and it is derived from
 * the same edges the chain is, so it moves the moment a category establishes
 * that it needs something.
 */
function Ledger({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-ledger">
      <h3>Capabilities</h3>
      <p className="rs-hint">
        What published sources say producing a machine requires is research. Whether this
        company holds it is not — no claim can establish that, and nothing here infers it.
      </p>
      {view.capabilities.length === 0 ? (
        <p className="rs-hint">The ledger is empty.</p>
      ) : (
        <ul className="rs-machines-caps">
          {view.capabilities.map(({ capability, requiredBy, taughtBy }) => (
            <li key={capability.id}>
              <span
                className={
                  capability.heldAt ? 'rs-machines-held' : 'rs-machines-notheld'
                }
              >
                {capability.heldAt ? 'held' : 'not held'}
              </span>{' '}
              <strong>{capability.name}</strong>
              {capability.heldNote ? (
                <p className="rs-hint">
                  Recorded by a person: {capability.heldNote}
                </p>
              ) : null}
              {requiredBy.length > 0 ? (
                <p className="rs-hint">Unlocks: {requiredBy.map((one) => one.name).join(', ')}</p>
              ) : null}
              {taughtBy.length > 0 ? (
                <p className="rs-hint">
                  Developed by: {taughtBy.map((one) => one.name).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every round ever asked, including the barren ones.
 *
 * A round that found nothing is a reading of a market. Dropping it would make
 * the history look like it had only ever been productive, which is the shape of
 * encouragement §29 refuses.
 */
function History({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-history">
      <h3>Rounds</h3>
      {view.history.length === 0 ? (
        <p className="rs-hint">Nothing has been asked yet.</p>
      ) : (
        <table className="rs-machines-rounds">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">About</th>
              <th scope="col">State</th>
              <th scope="col">Found</th>
            </tr>
          </thead>
          <tbody>
            {view.history.map((one) => (
              <tr key={one.id} className={one.barren ? 'rs-machines-barren' : undefined}>
                <td>
                  {one.purpose} {one.round > 1 ? `(round ${one.round})` : ''}
                </td>
                <td>{one.subject ?? 'the machines themselves'}</td>
                <td>{one.state}</td>
                <td>
                  {/* Null while OPEN rather than 0: not counted yet and nothing
                      found are different facts. */}
                  {one.found === null ? 'not counted yet' : one.found}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The questions this kernel raises and cannot settle.
 *
 * Kept apart from **Needs you** above, and the difference is what each one is
 * waiting for. Those are things a person could settle today. These are open by
 * design: the directive asks for one master brand and then says, in its own
 * words, not to lock the division names prematurely — so *no name chosen* is
 * the correct state rather than a gap, and the screen says so.
 *
 * Nothing here proposes an answer. Not a shortlist, not a generator, not an
 * example. What it shows is the criteria any answer would have to satisfy,
 * what the question currently depends on, and when leaving it open stops being
 * the right choice — all of which the server derived from the ladder, because
 * a stored criterion is stale the moment the span it is about changes.
 */
function OpenQuestions({
  view,
  projectId,
  reload,
}: {
  view: ProgrammeView;
  projectId: string;
  reload: () => void;
}): JSX.Element | null {
  if (view.openQuestions.length === 0) return null;
  return (
    <section className="rs-card rs-machines-questions">
      <h3>Open questions</h3>
      {view.openQuestions.map((question) => (
        <article key={question.topic} className="rs-machines-question">
          <header>
            <h4>{words(question.topic)}</h4>
            <span
              className={`rs-machines-qstate rs-machines-qstate-${question.state}`}
            >
              {question.state === 'OPEN' ? 'open' : 'answered'}
            </span>
          </header>
          <p className="rs-machines-because">{question.question}</p>
          <p className="rs-hint">{question.because}</p>
          {question.resolution ? (
            <blockquote className="rs-machines-answer">{question.resolution}</blockquote>
          ) : null}

          <h5>What any answer has to satisfy</h5>
          <ul className="rs-machines-criteria">
            {question.criteria.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>

          <h5>What it depends on</h5>
          <ul className="rs-machines-deps">
            {question.dependencies.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>

          <p className="rs-hint rs-machines-trigger">{question.trigger}</p>
          <AnswerQuestion
            projectId={projectId}
            topic={question.topic}
            state={question.state}
            reload={reload}
          />
        </article>
      ))}
    </section>
  );
}

/**
 * The control that answers one, and the control that unanswers it.
 *
 * A person's own words, posted exactly as typed. Nothing validates them
 * against a vocabulary and nothing here suggests any — a screen that offered
 * three candidate brand names would have made the decision and left somebody
 * the clerical half of it.
 */
function AnswerQuestion({
  projectId,
  topic,
  state,
  reload,
}: {
  projectId: string;
  topic: string;
  state: 'OPEN' | 'RESOLVED';
  reload: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/projects/${projectId}/manufacturing/decisions/${topic}`, {
        method: state === 'OPEN' ? 'POST' : 'PATCH',
        body: JSON.stringify(
          state === 'OPEN' ? { resolution: text } : { reason: text },
        ),
      });
      setText('');
      reload();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }, [projectId, reload, state, text, topic]);

  return (
    <div className="rs-machines-answerform">
      <label>
        {state === 'OPEN' ? 'Your answer' : 'Why this should be reopened'}
        <textarea
          value={text}
          rows={2}
          placeholder={
            state === 'OPEN'
              ? 'In your own words. Nothing here suggests one.'
              : 'A name chosen early may need unchoosing. Say what changed.'
          }
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="button" disabled={busy || text.trim().length === 0} onClick={send}>
        {state === 'OPEN' ? 'Record this answer' : 'Reopen'}
      </button>
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </div>
  );
}

/**
 * The frontier: every live category ranked, with the reason for each position.
 *
 * The directive refuses a stored sequence and demands a derived one in the
 * same breath, and a flat list of identical verdicts answers only the first
 * half. What makes this a ranking somebody can argue with rather than one they
 * can only accept is `separatedBy`: the single factor that put each entry
 * below the one above it, named, with the rows it was read from.
 *
 * There is no score here, because there is no score on the server. Two entries
 * with nothing between them say so — Brain cannot tell them apart, which is
 * itself a finding.
 */
function Frontier({ view }: { view: ProgrammeView }): JSX.Element {
  return (
    <section className="rs-card rs-machines-frontier">
      <h3>Strongest next expansion</h3>
      <p className="rs-hint">
        Derived on every read from what the rows currently say, never stored. An acquisition,
        a breakthrough or one new piece of evidence moves it. There is no score: each entry
        names the one factor that put it below the entry above.
      </p>
      {view.frontier.length === 0 ? (
        <p className="rs-hint">Nothing is on the ladder yet, so there is nothing to rank.</p>
      ) : (
        <ol className="rs-machines-ranked">
          {view.frontier.map((entry) => (
            <li key={entry.categoryId}>
              <div className="rs-machines-rank-head">
                <strong>{entry.path.join(' → ')}</strong>
                {entry.separatedBy ? (
                  <span className="rs-machines-sep">{words(entry.separatedBy.factor)}</span>
                ) : (
                  <span className="rs-machines-sep rs-machines-sep-tied">level</span>
                )}
              </div>
              <p className="rs-hint">{entry.because}</p>
              <details className="rs-machines-factors">
                <summary>Every factor ({entry.factors.length})</summary>
                <ul>
                  {entry.factors.map((factor) => (
                    <li key={factor.factor}>
                      <strong>{words(factor.factor)}</strong>
                      <p className="rs-hint">{factor.because}</p>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Firms published sources name that hold something a category requires.
 *
 * The directive asks Brain to identify acquisition opportunities; identifying
 * one is research, and everything that follows from one is not. So this screen
 * shows what a source said and offers exactly one verb: a person may set a
 * candidate aside.
 *
 * There is no control here that approaches a firm, values one, records an
 * offer or marks one as being pursued — and that is a property of there being
 * no such route and no column to write into, rather than a rule this component
 * is following.
 */
function Acquisitions({
  view,
  projectId,
  reload,
}: {
  view: ProgrammeView;
  projectId: string;
  reload: () => void;
}): JSX.Element {
  return (
    <section className="rs-card rs-machines-acquisitions">
      <h3>Could be bought rather than built</h3>
      <p className="rs-hint">
        Identification only. Nothing here approaches, values, offers for or commits to
        anybody, and nothing in this programme can — every one of those is a decision you
        authorize separately.
      </p>
      {view.acquisitions.length === 0 ? (
        <p className="rs-hint">
          No firm has been named. Brain asks this only where a category requires something
          nothing on the ladder is established to develop.
        </p>
      ) : (
        <ul className="rs-machines-candidates">
          {view.acquisitions.map(({ candidate, subject }) => (
            <li
              key={candidate.id}
              className={candidate.setAsideAt ? 'rs-machines-aside' : undefined}
            >
              <div className="rs-machines-cand-head">
                <strong>{candidate.name}</strong>
                <span className="rs-machines-contribution">
                  {words(candidate.contribution)}
                </span>
              </div>
              {subject ? <p className="rs-hint">For {subject}</p> : null}
              <p className="rs-machines-because">{candidate.statement}</p>
              {candidate.setAsideAt ? (
                <p className="rs-hint">
                  Set aside: {candidate.setAsideReason}
                </p>
              ) : (
                <SetAside projectId={projectId} candidateId={candidate.id} reload={reload} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A person saying no to a candidate.
 *
 * It destroys nothing: the row keeps its name, its contribution, its statement
 * and the claim it came from, because deleting it would let the same firm
 * arrive again next round as a fresh discovery.
 */
function SetAside({
  projectId,
  candidateId,
  reload,
}: {
  projectId: string;
  candidateId: string;
  reload: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/projects/${projectId}/manufacturing/acquisitions/${candidateId}`, {
        method: 'PATCH',
        body: JSON.stringify({ reason }),
      });
      setReason('');
      reload();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }, [candidateId, projectId, reason, reload]);

  return (
    <div className="rs-machines-setaside">
      <label>
        Set aside, and why
        <input
          type="text"
          value={reason}
          placeholder="It stays on the record rather than being deleted."
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button type="button" disabled={busy || reason.trim().length === 0} onClick={send}>
        Set aside
      </button>
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </div>
  );
}

/**
 * What entering one category costs, with a total only where there is one.
 *
 * The rendering of `totals === null` is the whole point of this component. A
 * requirement nobody publishes a figure for is a finding, the server withholds
 * the total rather than summing past it, and a screen that rendered the missing
 * figure as zero — or quietly showed the partial sum — would put back exactly
 * the defect the server refuses. So null renders as words naming what is
 * missing, and there is no `?? 0` anywhere in this file.
 */
function Capital({ reading }: { reading: CapitalReading }): JSX.Element {
  return (
    <div className="rs-machines-capital">
      <h5>What entering costs</h5>
      <p className="rs-hint">{reading.because}</p>
      {reading.scenarios.map((scenario) => (
        <div key={scenario.scenario} className="rs-machines-scenario">
          <div className="rs-machines-scenario-head">
            <strong>{words(scenario.scenario)}</strong>
            {scenario.totals === null ? (
              <span className="rs-machines-nototal">no total — a requirement is unpriced</span>
            ) : (
              <span className="rs-machines-total">
                {scenario.totals
                  .map((total) =>
                    total.lowMinor === total.highMinor
                      ? `${total.currency} ${money(total.lowMinor)}`
                      : `${total.currency} ${money(total.lowMinor)}–${money(total.highMinor)}`,
                  )
                  .join(' plus ')}
              </span>
            )}
          </div>
          <ul className="rs-machines-requirements">
            {[...scenario.priced, ...scenario.unpriced].map((entry) => (
              <li key={entry.id}>
                <strong>{words(entry.requirement)}</strong>{' '}
                {entry.amountLowMinor === null || entry.currency === null ? (
                  <span className="rs-machines-unpriced">no published figure</span>
                ) : (
                  <span className="rs-machines-figure">
                    {entry.currency} {money(entry.amountLowMinor)}
                    {entry.amountHighMinor !== null &&
                    entry.amountHighMinor !== entry.amountLowMinor
                      ? `–${money(entry.amountHighMinor)}`
                      : ''}
                  </span>
                )}
                <p className="rs-hint">
                  {entry.statement} <em>{words(entry.basis)}</em>, as of {entry.asOf}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * What the sources said, under the verdict that was read from it.
 *
 * `against` is the half a screen is most likely to omit and the half that
 * matters: recalls, service gaps, unmet requirements and what has to be
 * certified first are the facts that cut against entering, and a card showing
 * only the demand would be an encouraging reading of the same rows.
 */
function Evidence({ reading }: { reading: CategoryReading }): JSX.Element | null {
  const groups: { title: string; entries: EvidenceEntry[] }[] = [
    { title: 'Somebody is buying', entries: reading.evidence.demand },
    { title: 'How it reaches them', entries: reading.evidence.distribution },
    { title: 'What cuts against it', entries: reading.evidence.against },
    { title: 'Bought in rather than made', entries: reading.evidence.boughtIn },
  ];
  if (groups.every((group) => group.entries.length === 0)) return null;
  return (
    <details className="rs-machines-evidence">
      <summary>
        The evidence underneath ({groups.reduce((total, one) => total + one.entries.length, 0)})
      </summary>
      {groups
        .filter((group) => group.entries.length > 0)
        .map((group) => (
          <div key={group.title}>
            <h5>{group.title}</h5>
            <ul>
              {group.entries.map((entry) => (
                <li key={entry.id}>
                  <strong>{words(entry.subject)}</strong>
                  {entry.observedOn ? (
                    <span className="rs-hint"> — observed {entry.observedOn}</span>
                  ) : null}
                  <p className="rs-hint">{entry.statement}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </details>
  );
}


/**
 * Starting a programme, which is also what authorizes its research.
 *
 * ---------------------------------------------------------------------------
 * A person presses this, and there is no other way it happens
 * ---------------------------------------------------------------------------
 *
 * There is no tick, no derivation and no worker path that starts a programme.
 * The route behind this is `requirePerson` plus project `ADMIN`, so a machine
 * is refused by level *and* by principal type, and no membership configuration
 * turns one into a person.
 *
 * What it authorizes is said in full before it is pressed rather than in a
 * paragraph somewhere else, because pressing Start **is** the authorization
 * (§33): a person who has decided to run a programme has decided Brain may read
 * published sources about it, and asking them to then fill in a research grant
 * is asking twice for one decision. What it does *not* authorize is said in the
 * same breath, because a person reading "this authorizes research" is entitled
 * to know where that stops.
 *
 * The objective is the person's own sentence and nothing pre-fills it. The
 * server refuses a short one with its own reasoning — "build machines" is a
 * slogan and not an objective — and that sentence is what a person reads,
 * rather than a length check composed here.
 */
function StartProgramme({
  projectId,
  reload,
}: {
  projectId: string;
  reload: () => void;
}): JSX.Element {
  const [objective, setObjective] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/api/projects/${projectId}/manufacturing`, {
        method: 'POST',
        body: JSON.stringify({ objective }),
      });
      setConfirming(false);
      reload();
    } catch (error) {
      setProblem(describe(error));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }, [objective, projectId, reload]);

  return (
    <section className="rs-card rs-machines-start">
      <h2>No manufacturing programme</h2>
      <p className="rs-hint">
        This project has none. Starting one authorizes Brain to research, from published
        sources, which classes of machine exist, who is buying them, how product reaches
        them, what producing each one takes and teaches, what entering one costs, and which
        firms hold something a category requires.
      </p>
      <p className="rs-hint">
        It authorizes nothing else. No spending, no paid data, no contact with any person or
        organisation, no advertising, no publishing — and nothing at all about building,
        buying, tooling, certifying or entering anything. Those are decisions with a factory
        on the end of them, and there is no route to one through this programme.
      </p>
      <label>
        What this company is trying to be able to build, and what it is starting from
        <textarea
          value={objective}
          rows={3}
          placeholder="Your own sentence. Every question this programme asks carries it."
          onChange={(event) => {
            setObjective(event.target.value);
            setConfirming(false);
          }}
        />
      </label>
      {confirming ? (
        <div className="rs-machines-confirm">
          <p>
            Start the programme, and authorize read-only research under the objective above?
          </p>
          <button type="button" disabled={busy} onClick={start}>
            Yes, start it
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            Not yet
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy || objective.trim().length === 0}
          onClick={() => setConfirming(true)}
        >
          Start a programme
        </button>
      )}
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </section>
  );
}

/**
 * Pausing, resuming and archiving — the second decision that is a person's.
 *
 * Each one is offered only from the state it moves out of, so the screen never
 * shows a control that would be refused. The transitions are guarded in the
 * service as well, because a hidden button is not authorization (§17) and a
 * screen that decided this would be the second reader §29 keeps removing.
 *
 * Pausing and archiving are **not the same off switch**, and the difference is
 * said rather than implied. Pausing stops new questions and keeps everything
 * already running, finishing and being filed — §30's line between winding a
 * section down and ending an obligation already incurred. Archiving withdraws
 * the research grant as well.
 *
 * Archiving asks for confirmation and pausing does not, because the two are not
 * equally reversible: resuming a paused programme costs nothing, and archiving
 * withdraws an authorization that reactivating has to write again.
 */
function Lifecycle({
  view,
  projectId,
  reload,
}: {
  view: ProgrammeView;
  projectId: string;
  reload: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const move = useCallback(
    async (to: string) => {
      setBusy(true);
      setProblem(null);
      try {
        await api(`/api/projects/${projectId}/manufacturing`, {
          method: 'PATCH',
          body: JSON.stringify({ state: to }),
        });
        setConfirming(null);
        reload();
      } catch (error) {
        setProblem(describe(error));
        setConfirming(null);
      } finally {
        setBusy(false);
      }
    },
    [projectId, reload],
  );

  const state = view.program.state;
  return (
    <section className="rs-card rs-machines-lifecycle">
      <h3>The programme itself</h3>
      {state === 'ACTIVE' ? (
        <p className="rs-hint">
          Pausing stops Brain opening new questions. Everything already running still
          finishes and is filed — the spending happened when it ran, and dropping the results
          would throw away work already paid for.
        </p>
      ) : null}
      {state === 'PAUSED' ? (
        <p className="rs-hint">
          No new questions are being opened. What was already running is still finishing and
          being filed, and the research grant is still live.
        </p>
      ) : null}
      {state === 'ARCHIVED' ? (
        <p className="rs-hint">
          The research authority was withdrawn. Nothing was deleted: every category,
          capability, round and finding is exactly where it was, and reactivating writes the
          grant again.
        </p>
      ) : null}

      {confirming ? (
        <div className="rs-machines-confirm">
          <p>
            {confirming === 'ARCHIVED'
              ? 'Archive the programme and withdraw its research authority? Nothing is deleted, and reactivating writes the grant again.'
              : `Move the programme to ${confirming.toLowerCase()}?`}
          </p>
          <button type="button" disabled={busy} onClick={() => move(confirming)}>
            Yes
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="rs-machines-lifecycle-controls">
          {state !== 'ACTIVE' ? (
            <button type="button" disabled={busy} onClick={() => move('ACTIVE')}>
              {state === 'PAUSED' ? 'Resume' : 'Reactivate'}
            </button>
          ) : null}
          {state === 'ACTIVE' ? (
            <button type="button" disabled={busy} onClick={() => move('PAUSED')}>
              Pause
            </button>
          ) : null}
          {state !== 'ARCHIVED' ? (
            <button type="button" disabled={busy} onClick={() => setConfirming('ARCHIVED')}>
              Archive
            </button>
          ) : null}
        </div>
      )}
      {problem ? <p className="rs-machines-warn">{problem}</p> : null}
    </section>
  );
}
