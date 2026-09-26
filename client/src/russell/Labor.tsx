/**
 * Who does the work here, as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Every sentence on this screen is the server's
 * ---------------------------------------------------------------------------
 *
 * Nothing here re-derives a verdict, re-orders a list or composes an
 * explanation of its own. `services/labor/view.ts` already answers §13's six
 * readings and §11's four figures, in the order the brief asks for them and
 * with the ordering rules it argues for — weakest-backed role first, nearest
 * frontier item first, both directions of compression. §29 records what two
 * readers of one fact cost, and §33 records it again: a screen that paraphrases
 * a decision will eventually paraphrase it wrongly, and then a person is
 * reading one thing while the machinery acts on another.
 *
 * ---------------------------------------------------------------------------
 * The three things this screen must not do
 * ---------------------------------------------------------------------------
 *
 * **It must not render an unknown as a zero.** Four of §11's figures are
 * `UNKNOWN` and will stay that way until somebody builds the measurement. An
 * invented automation percentage is exactly the number a person would quote in
 * a decision about whether to keep employing somebody, so a null value renders
 * as *not measured* beside the note saying what would measure it — never as 0,
 * never as a dash a reader could take for zero, and never omitted, because an
 * absent row reads as *nothing to say about this*.
 *
 * **It must not fold the undecided into either side.** A workflow with two
 * Brain tasks and eight nobody has looked at is not eighty per cent automated.
 * The server counts them apart and so does every line here.
 *
 * **It must not engage anybody.** Recording that a person produces a task is a
 * fact about how the work is done today. It contacts, quotes for and hires
 * exactly as many people as it did before, which is none — and the server says
 * so on every such write, so the screen shows the server's own note rather than
 * a reassurance of its own.
 *
 * ---------------------------------------------------------------------------
 * Which controls exist, and why they are disabled rather than removed
 * ---------------------------------------------------------------------------
 *
 * Every decision offered here is one the domain reserves to a person: naming a
 * workflow or a task, which `SEED` origin makes Brain's one forbidden write;
 * recording who produces something; and retiring a workflow, which destroys
 * nothing. There is deliberately **no control that answers a necessity
 * question** — those are Brain's to research, and §33 records what a form
 * asking a person to attest to Brain's own work costs.
 *
 * `capabilities` comes from the server, because the browser holds one role flag
 * and every decision here is project `ADMIN`. A control somebody may not use is
 * **disabled carrying the server's reason** rather than removed (§35): a screen
 * that removes it has a different shape per reader, and *there is no button*
 * and *the button is not for you* are answers a person reads very differently.
 */
import { HumanWorkSection } from './HumanWork.tsx';
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';

type Backing = 'RESEARCH' | 'PERSON' | 'ASSERTED';
type EvidenceClass = 'MEASURED' | 'UNKNOWN';

interface Blocker {
  kind: string;
  statement: string;
  remedy: string;
}

interface HumanDependency {
  taskId: string;
  path: string;
  output: string;
  layer: string;
  reason: string;
  rationale: string;
  backing: Backing;
  sourcingOptions: number;
  since: string;
}

interface FrontierItem {
  taskId: string;
  path: string;
  output: string;
  layer: string | null;
  blockers: Blocker[];
  automatedPrecedents: number;
}

interface Bottleneck extends Blocker {
  tasks: number;
  capabilityId: string | null;
}

interface CapacityNeed {
  taskId: string;
  path: string;
  output: string;
  kind: 'NO_SOURCING_ESTABLISHED' | 'NOBODY_HAS_DECIDED';
  statement: string;
  reason: string | null;
}

interface CompressionEvent {
  taskId: string;
  path: string;
  from: string;
  to: string;
  wasFor: string | null;
  at: string;
  rationale: string;
  direction: 'COMPRESSED' | 'ESCALATED';
}

interface WorkflowEconomics {
  workflowId: string;
  name: string;
  opportunityId: string | null;
  tasks: number;
  humanTasks: number;
  machineTasks: number;
  undecided: number;
  fullyAutomated: boolean;
  compressedSince: number;
}

interface Figure {
  key: string;
  label: string;
  value: number | null;
  denominator: string | null;
  evidence: EvidenceClass;
  note: string;
}

interface LaborView {
  projectId: string;
  at: string;
  workflows: number;
  tasks: number;
  humanDependencies: HumanDependency[];
  automationFrontier: FrontierItem[];
  bottlenecks: Bottleneck[];
  capacityNeeds: CapacityNeed[];
  roleCompression: CompressionEvent[];
  economics: WorkflowEconomics[];
  measurements: Figure[];
  nextQuestions: { subject: string; purpose: string; why: string }[];
  declined: { subject: string; why: string }[];
  summary: string;
  capabilities: {
    mayShapeTheMap: boolean;
    mayRecordWhoProduces: boolean;
    because: string | null;
  };
  vocabulary: {
    productionLayers: string[];
    humanLayers: string[];
    humanReasons: string[];
  };
}

/**
 * A closed-set value as a person reads it.
 *
 * Presentation only, and a *fallback* rather than a dictionary: a value the
 * screen has never heard of renders as its own words with the underscores taken
 * out, so a vocabulary that grows on the server never leaves a blank. §29
 * records what a screen that silently drops what it does not recognise costs.
 */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

const BACKING_LABEL: Record<Backing, string> = {
  RESEARCH: 'a published source',
  PERSON: 'somebody answering the question',
  ASSERTED: 'nothing — the reason is asserted',
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LaborView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<LaborView | null>(
    async () => (projectId ? await api<LaborView>(`/api/projects/${projectId}/labor`) : null),
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see who does its work.</p>;
  }
  /*
   * A re-read leaves the previous answer up until the new one arrives.
   *
   * `reload()` sets `loading`, and returning the placeholder here would unmount
   * **every section on the page** — including a form a person was part-way
   * through. §29 records the production instance one surface along: pressing the
   * button reloaded the list, the reload counted as loading, and loading
   * unmounted the section, taking the invitation shown once down with it. Every
   * server test passed. So the placeholder is for the *first* read only.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty">Reading the labor map…</p>;
  }
  /*
   * The server's own sentence, whatever the status.
   *
   * A 404 here is *absent or forbidden* and the route refuses both with the same
   * body on purpose — invariant 23, where the thing being hidden is who does
   * somebody else's work. So this branch must not say the map is empty and must
   * not say it is forbidden; it says what the server said.
   */
  if (query.error) {
    return <p className="rs-empty">{query.error.message}</p>;
  }
  const view = query.data;
  if (!view) return <p className="rs-empty">Reading the labor map…</p>;

  return (
    <div className="rs-stack rs-labor">
      <Header view={view} />
      <HumanRoles view={view} projectId={projectId} reload={query.reload} />
      <Frontier view={view} />
      <Bottlenecks view={view} />
      <CapacityNeeds view={view} projectId={projectId} reload={query.reload} />
      <HumanWorkSection projectId={projectId} />
      <Compression view={view} />
      <Economics view={view} />
      <Measurements view={view} />
      <NextQuestions view={view} />
      <ShapeTheMap view={view} projectId={projectId} reload={query.reload} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Header({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor rs-labor-header">
      <h3>Who does the work</h3>
      {/* The server's one sentence, unabridged. It is what `npm run
          report:labor` prints, so the screen and the terminal agree. */}
      <p className="rs-labor-summary">{view.summary}</p>
      <ul className="rs-labor-counts">
        <li>
          {view.workflows} workflow{view.workflows === 1 ? '' : 's'}
        </li>
        <li>
          {view.tasks} task{view.tasks === 1 ? '' : 's'}
        </li>
      </ul>
      <p className="rs-hint">
        Brain is the default production layer and a person is an escalation layer. That is a
        burden of proof rather than an assumption: nothing here is moved to Brain because nobody
        looked at it, and no human role is kept without naming which of six reasons makes it
        necessary.
      </p>
    </section>
  );
}

/**
 * §13's HUMAN DEPENDENCIES, weakest-backed first — which is the server's own
 * ordering and the whole point of the section.
 *
 * A role nothing has checked is the one worth looking at, so `backing` is shown
 * on every row rather than being folded into a count. `ASSERTED` is not styled
 * as a failure: somebody is entitled to say *we do it this way for now* and
 * have that be true, and §7's request is that Brain keeps re-examining it.
 */
function HumanRoles({
  view,
  projectId,
  reload,
}: {
  view: LaborView;
  projectId: string;
  reload(): void;
}): JSX.Element {
  return (
    <section className="rs-card rs-labor-roles">
      <h3>People, and why they are necessary</h3>
      {view.humanDependencies.length === 0 ? (
        <p className="rs-empty">
          No task on this map is recorded as produced by a person. That is not the same fact as
          nobody being needed — a task nobody has decided is counted under the frontier below.
        </p>
      ) : (
        <ul className="rs-labor-list">
          {view.humanDependencies.map((one) => (
            <li key={one.taskId} className={`rs-labor-role rs-labor-backing-${one.backing}`}>
              <header>
                <strong>{one.path}</strong>
                <span className="rs-labor-layer">{words(one.layer)}</span>
              </header>
              <p className="rs-labor-output">{one.output}</p>
              <p className="rs-labor-reason">
                Necessary because of <strong>{words(one.reason)}</strong>, backed by{' '}
                {BACKING_LABEL[one.backing]}.
              </p>
              <p className="rs-hint">{one.rationale}</p>
              <p className="rs-item-meta">
                {one.sourcingOptions === 0
                  ? 'Nothing published has been read about where this capability is sourced.'
                  : `${one.sourcingOptions} published way${
                      one.sourcingOptions === 1 ? '' : 's'
                    } of sourcing this is on record.`}
              </p>
              <RecordProducer
                view={view}
                projectId={projectId}
                taskId={one.taskId}
                path={one.path}
                current={one.layer}
                reload={reload}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * §13's AUTOMATION FRONTIER: what Brain is close to absorbing, nearest first.
 *
 * *Nearest* is a count of blockers rather than a score — the same refusal the
 * portfolio makes — and a task with none left is ready to move now. Every
 * blocker carries the server's own remedy, because a blocker with no first step
 * is §24's escalation nobody can answer.
 */
function Frontier({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-frontier">
      <h3>What Brain is close to absorbing</h3>
      {view.automationFrontier.length === 0 ? (
        <p className="rs-empty">
          Nothing on this map is produced by a person or waiting on a decision, so there is no
          frontier to report.
        </p>
      ) : (
        <ul className="rs-labor-list">
          {view.automationFrontier.map((one) => (
            <li key={one.taskId} className="rs-labor-frontier-item">
              <header>
                <strong>{one.path}</strong>
                <span className="rs-labor-distance">
                  {one.blockers.length === 0
                    ? 'ready to move now'
                    : `${one.blockers.length} thing${
                        one.blockers.length === 1 ? '' : 's'
                      } in the way`}
                </span>
              </header>
              <p className="rs-labor-output">{one.output}</p>
              <p className="rs-item-meta">
                {one.layer === null
                  ? 'Nobody has decided who produces this.'
                  : `Produced by ${words(one.layer)} today.`}
                {one.automatedPrecedents > 0
                  ? ` ${one.automatedPrecedents} published precedent${
                      one.automatedPrecedents === 1 ? '' : 's'
                    } for doing it with software.`
                  : ''}
              </p>
              {one.blockers.length > 0 ? (
                <ul className="rs-labor-blockers">
                  {one.blockers.map((blocker) => (
                    <li key={`${one.taskId}:${blocker.kind}`}>
                      <p className="rs-labor-blocker-what">{blocker.statement}</p>
                      <p className="rs-hint">{blocker.remedy}</p>
                    </li>
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

/** §13's BOTTLENECKS: what currently prevents additional Brain execution. */
function Bottlenecks({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-bottlenecks">
      <h3>What is holding it</h3>
      {view.bottlenecks.length === 0 ? (
        <p className="rs-empty">Nothing is blocking additional Brain execution on this map.</p>
      ) : (
        <ul className="rs-labor-list">
          {view.bottlenecks.map((one) => (
            <li key={one.kind}>
              <header>
                <strong>{one.statement}</strong>
                <span className="rs-labor-count">
                  {one.tasks} task{one.tasks === 1 ? '' : 's'}
                </span>
              </header>
              <p className="rs-hint">{one.remedy}</p>
              {/*
               * The capability is named only where every task naming this
               * blocker names the same one — the server's own rule, because two
               * tasks blocked on two different integrations are two remedies and
               * naming one would send somebody to fix half the problem while
               * believing they had fixed it.
               */}
              {one.capabilityId ? (
                <p className="rs-item-meta">The capability is {one.capabilityId}.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** §13's HUMAN CAPACITY NEEDS: where more human capability would actually help. */
function CapacityNeeds({
  view,
  projectId,
  reload,
}: {
  view: LaborView;
  projectId: string;
  reload(): void;
}): JSX.Element {
  return (
    <section className="rs-card rs-labor-needs">
      <h3>Where more human capability would help</h3>
      {view.capacityNeeds.length === 0 ? (
        <p className="rs-empty">Nothing on this map is waiting on human capacity.</p>
      ) : (
        <ul className="rs-labor-list">
          {view.capacityNeeds.map((one) => (
            <li key={`${one.taskId}:${one.kind}`}>
              <header>
                <strong>{one.path}</strong>
                <span className="rs-labor-need-kind">{words(one.kind)}</span>
              </header>
              <p className="rs-labor-output">{one.output}</p>
              <p className="rs-hint">{one.statement}</p>
              {one.reason ? (
                <p className="rs-item-meta">The role exists for {words(one.reason)}.</p>
              ) : null}
              {/*
                * The first decision, where it is actually open.
                *
                * The control used to live only on the human-roles list, so a
                * task **nobody had decided** — the one this section exists to
                * name — had nowhere to be decided at all. §24's sentence at a
                * new surface: a state saying a person must decide, which that
                * person cannot act on, is stuck rather than waiting. Found by
                * walking the journey rather than by reading it, which is the
                * only way this kind of gap ever is.
                */}
              {one.kind === 'NOBODY_HAS_DECIDED' ? (
                <RecordProducer
                  view={view}
                  projectId={projectId}
                  taskId={one.taskId}
                  path={one.path}
                  current={null}
                  reload={reload}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * §13's ROLE COMPRESSION, both directions.
 *
 * A task that went back to a person is the single most useful row in this
 * table, so it is shown rather than filtered — a list of only the compressions
 * would be a scoreboard rather than a record.
 */
function Compression({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-compression">
      <h3>Where the work moved</h3>
      {view.roleCompression.length === 0 ? (
        <p className="rs-empty">
          Nothing on this map has changed hands yet. This reads from the allocation chain, which
          is why both decision tables are append-only: current state is exactly what forgets.
        </p>
      ) : (
        <ul className="rs-labor-list">
          {view.roleCompression.map((one) => (
            <li
              key={`${one.taskId}:${one.at}`}
              className={`rs-labor-move rs-labor-${one.direction}`}
            >
              <header>
                <strong>{one.path}</strong>
                <span className="rs-labor-direction">
                  {one.direction === 'COMPRESSED' ? 'to Brain' : 'back to a person'}
                </span>
              </header>
              <p className="rs-labor-output">
                {words(one.from)} → {words(one.to)}
                {one.wasFor ? `, where the role had existed for ${words(one.wasFor)}` : ''}
              </p>
              <p className="rs-hint">{one.rationale}</p>
              <p className="rs-item-meta">{one.at}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * §13's NEW BUSINESS ECONOMICS, counted rather than valued.
 *
 * `undecided` is its own column and is never folded into either side, because a
 * workflow with two Brain tasks and eight nobody has looked at is not eighty per
 * cent automated. There is no percentage anywhere on this table for the same
 * reason.
 */
function Economics({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-economics">
      <h3>Per workflow</h3>
      {view.economics.length === 0 ? (
        <p className="rs-empty">No workflow is on the map yet.</p>
      ) : (
        <div className="rs-table-wrap">
          <table className="rs-labor-table">
            <caption className="rs-visually-hidden">
              Per workflow: tasks, who produces them, and how many have moved to Brain
            </caption>
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Tasks</th>
              <th scope="col">By a person</th>
              <th scope="col">Without a person</th>
              <th scope="col">Undecided</th>
              <th scope="col">Moved to Brain</th>
            </tr>
          </thead>
          <tbody>
            {view.economics.map((one) => (
              <tr key={one.workflowId}>
                <th scope="row">
                  {one.name}
                  {one.fullyAutomated ? (
                    <span className="rs-labor-automated"> every decided task is automated</span>
                  ) : null}
                </th>
                <td>{one.tasks}</td>
                <td>{one.humanTasks}</td>
                <td>{one.machineTasks}</td>
                <td>{one.undecided}</td>
                <td>{one.compressedSince}</td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * §11's measurements, with the four Brain cannot take reported as unmeasured.
 *
 * The null ones are the reason this section exists. An absent row would read as
 * *nothing to say about this*; a zero would be quoted in a decision about
 * whether to keep employing somebody. So the value renders as *not measured*
 * and the note says what would measure it.
 */
function Measurements({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-measurements">
      <h3>What is measured, and what is not</h3>
      <ul className="rs-labor-figures">
        {view.measurements.map((figure) => (
          <li key={figure.key} className={`rs-labor-figure rs-labor-${figure.evidence}`}>
            <span className="rs-labor-figure-label">{figure.label}</span>
            <span className="rs-labor-figure-value">
              {figure.value === null ? 'not measured' : figure.value.toLocaleString('en-US')}
              {figure.value !== null && figure.denominator ? (
                <span className="rs-labor-denominator"> {figure.denominator}</span>
              ) : null}
            </span>
            <span className="rs-hint">{figure.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What Brain would ask next, and what it considered and did not ask.
 *
 * Reading this creates nothing: the server composes it with `plan`, which is
 * the allocation decision *without acting on it*, so a person can look before
 * anything moves.
 */
function NextQuestions({ view }: { view: LaborView }): JSX.Element {
  return (
    <section className="rs-card rs-labor-next">
      <h3>What Brain would ask next</h3>
      <p className="rs-hint">
        Reading this creates nothing. It is the allocation decision without acting on it.
      </p>
      {view.nextQuestions.length === 0 ? (
        <p className="rs-empty">Brain has no labor question to ask on this project right now.</p>
      ) : (
        <ul className="rs-labor-list">
          {view.nextQuestions.map((one) => (
            <li key={`${one.subject}:${one.purpose}`}>
              <header>
                <strong>{one.subject}</strong>
                <span className="rs-labor-purpose">{words(one.purpose)}</span>
              </header>
              <p className="rs-hint">{one.why}</p>
            </li>
          ))}
        </ul>
      )}
      {view.declined.length > 0 ? (
        <>
          <h4>Considered and not asked</h4>
          <ul className="rs-labor-list">
            {view.declined.map((one) => (
              <li key={one.subject}>
                <strong>{one.subject}</strong>
                <p className="rs-hint">{one.why}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* The decisions a person makes                                              */
/* ------------------------------------------------------------------------- */

/**
 * A control that may not succeed, rendered as itself with the reason.
 *
 * §35's rule rather than hiding it: *there is no button* and *the button is not
 * for you* are answers a person reads very differently, and a screen with a
 * different shape per reader is one two people cannot talk about. The reason is
 * rendered rather than hidden in a `title`, because an explanation only a mouse
 * can reach is no explanation on a phone.
 */
function Locked({ because }: { because: string | null }): JSX.Element {
  return <p className="rs-hint rs-labor-locked">{because ?? 'This is not yours to change.'}</p>;
}

/**
 * Recording who produces one task.
 *
 * The vocabularies come down with the view, so the set this offers and the set
 * the route validates against are one object. A human layer demands a reason,
 * which is the schema's own CHECK rather than a rule repeated here — the form
 * knows which layers those are because the server said, never because a name
 * reads like a person.
 *
 * The server's own note is what is shown afterwards, including the one it
 * attaches to every human allocation: recording that a person produces this
 * engages nobody.
 */
function RecordProducer({
  view,
  projectId,
  taskId,
  path,
  current,
  reload,
}: {
  view: LaborView;
  projectId: string;
  taskId: string;
  path: string;
  current: string | null;
  reload(): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [layer, setLayer] = useState(current ?? view.vocabulary.productionLayers[0] ?? 'BRAIN');
  const [reason, setReason] = useState(view.vocabulary.humanReasons[0] ?? '');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string[] | null>(null);

  const needsReason = view.vocabulary.humanLayers.includes(layer);

  const submit = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    void api<{ message: string; note?: string }>(
      `/api/projects/${projectId}/labor/tasks/${taskId}/allocation`,
      {
        method: 'POST',
        body: JSON.stringify({
          productionLayer: layer,
          necessityReason: needsReason ? reason : null,
          rationale,
        }),
      },
    ).then(
      (answer) => {
        setBusy(false);
        setSaid([answer.message, ...(answer.note ? [answer.note] : [])]);
        reload();
      },
      (error: unknown) => {
        // The button comes back rather than spinning. A control that never
        // recovers from one failed press is worse than one that did nothing.
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, layer, needsReason, projectId, rationale, reason, reload, taskId]);

  if (!view.capabilities.mayRecordWhoProduces) {
    return <Locked because={view.capabilities.because} />;
  }
  if (!open) {
    return (
      <p className="rs-labor-actions">
        <button type="button" className="rs-button-quiet" onClick={() => setOpen(true)}>
          Record who produces {path}
        </button>
      </p>
    );
  }

  return (
    <div className="rs-labor-form">
      <label>
        <span className="rs-field-label">Produced by</span>
        <select value={layer} onChange={(event) => setLayer(event.target.value)}>
          {view.vocabulary.productionLayers.map((one) => (
            <option key={one} value={one}>
              {words(one)}
            </option>
          ))}
        </select>
      </label>
      {needsReason ? (
        <label>
          <span className="rs-field-label">Which reason makes a person necessary</span>
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            {view.vocabulary.humanReasons.map((one) => (
              <option key={one} value={one}>
                {words(one)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        <span className="rs-field-label">Why</span>
        <textarea
          rows={3}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
        />
      </label>
      <p className="rs-labor-actions">
        <button type="button" onClick={submit} disabled={busy || rationale.trim().length === 0}>
          {busy ? 'Recording…' : 'Record it'}
        </button>
        <button type="button" className="rs-button-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </p>
      {problem ? <p className="rs-hint rs-labor-problem">{problem}</p> : null}
      {said
        ? said.map((sentence) => (
            <p key={sentence} className="rs-hint rs-labor-said">
              {sentence}
            </p>
          ))
        : null}
    </div>
  );
}

/**
 * Naming a workflow, and naming a task in one.
 *
 * `SEED` is the one origin Brain itself may never write: deciding what a
 * business does is a design act rather than a derivation, and no amount of
 * reading rows answers it. So this is the entrance that makes the kernel usable
 * at all — the map also fills itself from qualified openings, and until
 * somebody has one, a person naming a workflow is the only way anything gets on
 * it.
 *
 * Declaring spends nothing and starts nothing. It creates a row; the kernel
 * decides when it is asked about, the standing authority decides whether that
 * may run, and the evidence gate decides what may be claimed. The server says
 * exactly that on the way back, and it is the server's sentence that is shown.
 */
function ShapeTheMap({
  view,
  projectId,
  reload,
}: {
  view: LaborView;
  projectId: string;
  reload(): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [taskWorkflow, setTaskWorkflow] = useState('');
  const [taskName, setTaskName] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const post = useCallback(
    (path: string, body: unknown, clear: () => void) => {
      if (busy) return;
      setBusy(true);
      setProblem(null);
      void api<{ message: string }>(path, { method: 'POST', body: JSON.stringify(body) }).then(
        (answer) => {
          setBusy(false);
          setSaid(answer.message);
          clear();
          reload();
        },
        (error: unknown) => {
          setBusy(false);
          setProblem(describe(error));
        },
      );
    },
    [busy, reload],
  );

  return (
    <section className="rs-card rs-labor-declare">
      <h3>Name a workflow</h3>
      <p className="rs-hint">
        Brain never writes one of these itself. Deciding what the business does is a design act
        rather than a derivation, so a workflow exists because a person named it or because a
        qualified opening declared what delivering it needs.
      </p>
      {!view.capabilities.mayShapeTheMap ? (
        <Locked because={view.capabilities.because} />
      ) : (
        <>
          <div className="rs-labor-form">
            <label>
              <span className="rs-field-label">Workflow name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <p className="rs-labor-actions">
              <button
                type="button"
                disabled={busy || name.trim().length === 0}
                onClick={() =>
                  post(`/api/projects/${projectId}/labor/workflows`, { name }, () => setName(''))
                }
              >
                {busy ? 'Naming…' : 'Name it'}
              </button>
            </p>
          </div>

          <h4>Name a task in one</h4>
          {view.economics.length === 0 ? (
            <p className="rs-empty">Name a workflow first; a task belongs to one.</p>
          ) : (
            <div className="rs-labor-form">
              <label>
                <span className="rs-field-label">Workflow</span>
                <select
                  value={taskWorkflow || (view.economics[0]?.workflowId ?? '')}
                  onChange={(event) => setTaskWorkflow(event.target.value)}
                >
                  {view.economics.map((one) => (
                    <option key={one.workflowId} value={one.workflowId}>
                      {one.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="rs-field-label">Task name</span>
                <input value={taskName} onChange={(event) => setTaskName(event.target.value)} />
              </label>
              <label>
                {/*
                 * Question 1 of the necessity test, required here because it is
                 * required there: every other question is about this output, and
                 * a task without one cannot be assessed at all.
                 */}
                <span className="rs-field-label">What one completed output is</span>
                <input value={output} onChange={(event) => setOutput(event.target.value)} />
              </label>
              <p className="rs-labor-actions">
                <button
                  type="button"
                  disabled={busy || taskName.trim().length === 0 || output.trim().length === 0}
                  onClick={() =>
                    post(
                      `/api/projects/${projectId}/labor/workflows/${
                        taskWorkflow || view.economics[0]?.workflowId
                      }/tasks`,
                      { name: taskName, output },
                      () => {
                        setTaskName('');
                        setOutput('');
                      },
                    )
                  }
                >
                  {busy ? 'Naming…' : 'Name the task'}
                </button>
              </p>
            </div>
          )}
        </>
      )}
      {problem ? <p className="rs-hint rs-labor-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-labor-said">{said}</p> : null}
    </section>
  );
}
