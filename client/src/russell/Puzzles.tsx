/**
 * The puzzle kernel, as a person reads it.
 *
 * ---------------------------------------------------------------------------
 * Every sentence on this screen is the server's
 * ---------------------------------------------------------------------------
 *
 * `services/puzzle/view.ts` already answers the operator's brief in the order
 * it asks for: right now, the top five monetization routes beside the whole
 * ledger, what is being made, leverage, quality, economics, the dollar-book
 * reading, physical production, maturity, lessons, recent observations, what
 * needs a person, the next action and what this repository can and cannot do.
 * Nothing here re-derives a rung, re-ranks the ledger or composes a sentence of
 * its own. §29 records what two readers of one fact cost, and §33 records it
 * again: a screen that paraphrases a decision will eventually paraphrase it
 * wrongly, and then a person is reading one thing while the machinery acts on
 * another.
 *
 * ---------------------------------------------------------------------------
 * The two things this screen must not do
 * ---------------------------------------------------------------------------
 *
 * **It must not render an unknown as a zero.** §48's leverage multipliers, its
 * quality pass rate, and its economics contributions are all `null` until
 * somebody builds the measurement, and an invented figure is exactly the
 * number a person would quote in a decision to spend on this. A null value
 * renders as *not measured* or *withheld*, beside the note saying what would
 * measure it — never as 0, never as a dash a reader could take for zero, and
 * never omitted, because an absent line reads as *nothing to say about this*.
 *
 * **It must not engage, submit or publish anything.** Seeding a format,
 * retiring one, and recording an observation are the only writes this screen
 * offers, and every one of them records a fact about what has already
 * happened or names something a person decides — never an action taken on
 * this screen's behalf. There is deliberately no control that submits a
 * puzzle anywhere, lists a product, or contacts a buyer: those are commercial
 * actions under the standing grant, and this kernel is not where they live.
 *
 * ---------------------------------------------------------------------------
 * An id the view does not hand out is typed, never invented
 * ---------------------------------------------------------------------------
 *
 * Retiring a format needs its row id, and re-rendering a puzzle needs its
 * instance id — and `PuzzleView` deliberately does not carry either, because
 * it is a reading rather than a browsable table of every row. Where the view
 * already names a format (the maturity ladder) or a route (the ledger), this
 * screen offers it as a choice; where it does not, the field is typed, with a
 * hint saying where the id came from, rather than inventing a listing this
 * view was never built to hold.
 */
import { useCallback, useState } from 'react';
import {
  getPuzzleInstance,
  getPuzzleView,
  recordPuzzleObservation,
  retirePuzzleFormat,
  seedPuzzleFormat,
} from '../lib/puzzleApi.ts';
import type {
  PuzzleArtifact,
  PuzzleInstanceReading,
  PuzzleObservation,
  PuzzleView,
} from '../lib/puzzleApi.ts';
import { useAsync } from './useAsync.ts';

/**
 * A closed-set value as a person reads it.
 *
 * Presentation only, and a *fallback* rather than a dictionary: a value the
 * screen has never heard of renders as its own words with the underscores
 * taken out, so a vocabulary that grows on the server never leaves a blank.
 * §29 records what a screen that silently drops what it does not recognise
 * costs.
 */
function words(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

/** Minor units as a figure, matching Machines.tsx's own rendering exactly. */
function money(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every kind of outcome this kernel records, labelled.
 *
 * A `Record` over the whole type rather than a value import of the server's
 * constant array: the closed set is fixed in the schema, exactly like
 * `ConditionReading['answer']` on the machines screen, so the compiler
 * refuses this file the moment a kind is added there and not here.
 */
const OBSERVATION_KIND_LABEL: Record<PuzzleObservation['kind'], string> = {
  SUBMISSION_ACCEPTED: 'A submission was accepted',
  SUBMISSION_REJECTED: 'A submission was rejected',
  SALE: 'A sale',
  NO_SALE: 'Offered, and not bought',
  CUSTOMER_COMPLAINT: 'A customer complaint',
  DEFECT_FOUND: 'A defect was found',
  CHANNEL_TERMS_CHANGED: 'A channel changed its terms',
  PRODUCTION_RESULT: 'A production run result',
  ROUTE_REJECTED: 'A monetization route was turned down',
  HUMAN_EDIT_PASSED: 'A person read what the machine made, and it passed',
  HUMAN_EDIT_FAILED: 'A person read what the machine made, and it did not pass',
  PLAYTEST_RESULT: 'A playtest result',
};

export function PuzzlesView({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<PuzzleView | null>(
    async () => (projectId ? await getPuzzleView(projectId) : null),
    [projectId],
  );

  if (!projectId) {
    return <p className="rs-empty">Open a project to see its puzzle kernel.</p>;
  }
  /*
   * A re-read leaves the previous answer up until the new one arrives.
   *
   * §29 records the production instance this guards against: `reload()` sets
   * `loading`, and returning the placeholder here would unmount **every
   * section on the page** — including a form a person was part-way through.
   * So the placeholder below is for the *first* read only.
   */
  if (query.loading && !query.data) {
    return <p className="rs-empty rs-puzzles-loading">Reading the puzzle kernel…</p>;
  }
  /*
   * Not-available and error are kept visually apart, because they are
   * different facts. A 404 here is *absent or forbidden*, rendered
   * identically on purpose — invariant 23, where the thing being hidden is
   * another project's puzzle kernel. Anything else is a fact about this
   * request, this instant, and calling it the same thing as *you may not see
   * this* would tell a person to stop asking when the honest answer is to
   * try again.
   */
  if (query.error) {
    return query.error.status === 404 ? (
      <p className="rs-empty rs-puzzles-notavailable">{query.error.message}</p>
    ) : (
      <p className="rs-empty rs-puzzles-error">{query.error.message}</p>
    );
  }
  const view = query.data;
  if (!view) return <p className="rs-empty rs-puzzles-loading">Reading the puzzle kernel…</p>;

  if (!view.active) {
    return (
      <section className="rs-card rs-puzzles rs-puzzles-empty">
        <h3>Puzzle products</h3>
        <p className="rs-hint">
          This project holds no sprint, so nothing here has run. Puzzle discovery and
          production are part of Cash Mode: activate a sprint from the Cash section, and this
          kernel starts absorbing on the next tick.
        </p>
      </section>
    );
  }

  return (
    <div className="rs-stack rs-puzzles">
      <RightNow view={view} />
      <Ledger view={view} />
      <BeingMade view={view} />
      <Leverage view={view} />
      <Quality view={view} />
      <Economics view={view} />
      <DollarBook view={view} />
      <Physical view={view} />
      <Maturity view={view} />
      <Lessons view={view} />
      <Recent view={view} />
      <NeedsPerson view={view} />
      <NextAction view={view} />
      <Capabilities view={view} />
      <PuzzleInstanceLookup projectId={projectId} />
      <ShapeThePuzzleMap projectId={projectId} view={view} reload={query.reload} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function RightNow({ view }: { view: PuzzleView }): JSX.Element {
  const { rightNow } = view;
  return (
    <section className="rs-card rs-puzzles-header">
      <h3>Puzzle products</h3>
      <ul className="rs-puzzles-counts">
        <li>
          {rightNow.formatsOnMap} format{rightNow.formatsOnMap === 1 ? '' : 's'} on the map
        </li>
        <li>
          {rightNow.formatsBrainCanMake} this repository can make
        </li>
        <li>
          {rightNow.systems} system{rightNow.systems === 1 ? '' : 's'}
        </li>
        <li>
          {rightNow.validPuzzles} valid puzzle{rightNow.validPuzzles === 1 ? '' : 's'}
        </li>
        <li>
          {rightNow.qualifiedProducts} qualified product{rightNow.qualifiedProducts === 1 ? '' : 's'}
        </li>
        <li>
          {rightNow.promoted} promoted to the portfolio
        </li>
        <li>
          {rightNow.currency ? `${rightNow.currency} ${money(rightNow.collectedCents)}` : 'nothing'}{' '}
          collected
        </li>
      </ul>
      {rightNow.furthest ? (
        <p className="rs-item-meta">
          Furthest along: <strong>{rightNow.furthest.format}</strong> at{' '}
          {words(rightNow.furthest.rung)}, with {rightNow.furthest.validPuzzles} valid puzzle
          {rightNow.furthest.validPuzzles === 1 ? '' : 's'} and {rightNow.furthest.products}{' '}
          product{rightNow.furthest.products === 1 ? '' : 's'}.
        </p>
      ) : (
        <p className="rs-hint">Nothing is on the map yet.</p>
      )}
    </section>
  );
}

/**
 * The top five monetization routes, shown alongside the whole ledger.
 *
 * `topFive` is never a filter that hides the rest — every route the brief
 * enumerated stays visible below it, including the archived ones a person
 * turned down, because a route that vanished would be indistinguishable from
 * one nobody thought of.
 */
function Ledger({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-ledger">
      <h3>Monetization routes</h3>
      <h4>Top five, right now</h4>
      {view.topFive.length === 0 ? (
        <p className="rs-empty">Nothing on the ledger is close enough to rank.</p>
      ) : (
        <ul className="rs-puzzles-list rs-puzzles-topfive">
          {view.topFive.map((entry) => (
            <LedgerRow key={entry.route.id} entry={entry} />
          ))}
        </ul>
      )}
      <h4>The whole ledger ({view.ledger.length})</h4>
      <p className="rs-hint">
        Every route the brief named, and nothing is ever removed from this list. A route a
        person turned down stays here with the reason, which is what stops it being proposed
        again next week.
      </p>
      <ul className="rs-puzzles-list">
        {view.ledger.map((entry) => (
          <LedgerRow key={entry.route.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function LedgerRow({ entry }: { entry: PuzzleView['ledger'][number] }): JSX.Element {
  return (
    <li className={`rs-puzzles-route rs-puzzles-route-${entry.state}`}>
      <header>
        <strong>{entry.route.title}</strong>
        <span className="rs-puzzles-route-state">{words(entry.state)}</span>
      </header>
      <p className="rs-puzzles-output">{entry.route.description}</p>
      <p className="rs-item-meta">
        Capital at risk: {words(entry.route.capitalAtRisk)} · stage {entry.route.stage}
        {entry.bestFormat ? ` · closest format: ${entry.bestFormat}` : ''}
      </p>
      {entry.met.length > 0 ? (
        <p className="rs-item-meta">Met: {entry.met.map(words).join(', ')}</p>
      ) : null}
      {entry.unmet.length > 0 ? (
        <p className="rs-item-meta">Not yet met: {entry.unmet.map(words).join(', ')}</p>
      ) : null}
      <p className="rs-hint">{entry.next}</p>
      {entry.rejectedBecause ? (
        <p className="rs-hint rs-puzzles-rejected">Turned down: {entry.rejectedBecause}</p>
      ) : null}
    </li>
  );
}

/** What is running right now: open questions, and systems making puzzles. */
function BeingMade({ view }: { view: PuzzleView }): JSX.Element {
  const { beingMade } = view;
  return (
    <section className="rs-card rs-puzzles-beingmade">
      <h3>Being made now</h3>
      <h4>Open questions</h4>
      {beingMade.openQuestions.length === 0 ? (
        <p className="rs-empty">Nothing is being researched right now.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {beingMade.openQuestions.map((one) => (
            <li key={one.roundId}>
              <span className="rs-puzzles-purpose">{words(one.purpose)}</span>{' '}
              {one.subject} (round {one.round})
            </li>
          ))}
        </ul>
      )}
      <h4>Systems generating</h4>
      {beingMade.systemsGenerating.length === 0 ? (
        <p className="rs-empty">No system has been set up yet.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {beingMade.systemsGenerating.map((one) => (
            <li key={one.masterId}>
              <strong>{one.title}</strong> — {one.held} valid puzzle{one.held === 1 ? '' : 's'}{' '}
              held
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The three leverage multipliers, and the two Brain has not measured.
 *
 * `Reading.value === null` renders as *not measured* rather than 0 — the same
 * rule the labor screen enforces for §11's figures, because an invented
 * multiplier is exactly the number somebody would use to justify spending on
 * this.
 */
function ReadingValue({ reading }: { reading: PuzzleView['leverage']['masterToSku'] }): JSX.Element {
  return (
    <li className={`rs-puzzles-reading rs-puzzles-${reading.evidence}`}>
      <span className="rs-puzzles-reading-value">
        {reading.value === null ? 'not measured' : reading.value.toLocaleString('en-US')}
      </span>
      <span className="rs-hint">{reading.note}</span>
    </li>
  );
}

function Leverage({ view }: { view: PuzzleView }): JSX.Element {
  const { leverage } = view;
  return (
    <section className="rs-card rs-puzzles-leverage">
      <h3>Leverage</h3>
      <ul className="rs-puzzles-counts">
        <li>{leverage.provenMasters} proven system{leverage.provenMasters === 1 ? '' : 's'}</li>
        <li>{leverage.validPuzzles} valid puzzle{leverage.validPuzzles === 1 ? '' : 's'}</li>
        <li>{leverage.qualifiedOutputs} qualified output{leverage.qualifiedOutputs === 1 ? '' : 's'}</li>
        <li>{leverage.reskins} reskin{leverage.reskins === 1 ? '' : 's'} refused</li>
      </ul>
      <dl className="rs-puzzles-readings">
        <dt>Master to SKU</dt>
        <dd>
          <ul className="rs-puzzles-list">
            <ReadingValue reading={leverage.masterToSku} />
          </ul>
        </dd>
        <dt>Setup to unit yield</dt>
        <dd>
          <ul className="rs-puzzles-list">
            <ReadingValue reading={leverage.setupToUnitYield} />
          </ul>
        </dd>
        <dt>Contribution per setup</dt>
        <dd>
          <ul className="rs-puzzles-list">
            <ReadingValue reading={leverage.contributionPerSetup} />
          </ul>
        </dd>
        <dt>Valid puzzles per editorial hour</dt>
        <dd>
          <ul className="rs-puzzles-list">
            <ReadingValue reading={leverage.validPuzzlesPerEditorialHour} />
          </ul>
        </dd>
      </dl>
    </section>
  );
}

/**
 * Quality: what is measured, what is an invariant rather than a rate, and
 * what a person or a customer found wrong.
 *
 * `passRate` is always UNKNOWN by design — a refused puzzle is never stored,
 * so there is no denominator in the table for it. `storedAllValid` is not a
 * rate at all: it can only ever be every stored row, so it is shown as the
 * count it is rather than a permanent 100% wearing a measurement's clothes.
 */
function Quality({ view }: { view: PuzzleView }): JSX.Element {
  const { quality } = view;
  return (
    <section className="rs-card rs-puzzles-quality">
      <h3>Quality</h3>
      <ul className="rs-puzzles-list">
        <ReadingValue reading={quality.passRate} />
      </ul>
      <ul className="rs-puzzles-counts">
        <li>
          {quality.storedAllValid.valid} of {quality.storedAllValid.total} stored instance
          {quality.storedAllValid.total === 1 ? '' : 's'} valid
        </li>
        <li>{quality.duplicatesHeld} duplicate canonical form{quality.duplicatesHeld === 1 ? '' : 's'} held</li>
        <li>{quality.defectsReported} defect{quality.defectsReported === 1 ? '' : 's'} reported</li>
        <li>{quality.complaints} complaint{quality.complaints === 1 ? '' : 's'}</li>
      </ul>
      {quality.humanEdited.length > 0 ? (
        <p className="rs-item-meta">A person has read: {quality.humanEdited.join(', ')}</p>
      ) : (
        <p className="rs-hint">No format has had a person read what the machine made yet.</p>
      )}
      {quality.failingChecks.length > 0 ? (
        <>
          <h4>Failing checks, by name</h4>
          <ul className="rs-puzzles-list">
            {quality.failingChecks.map((one) => (
              <li key={one.name}>
                {one.name} — {one.count} time{one.count === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * What a product class earns, with a contribution only where the receipts and
 * every load-bearing cost line are actually published.
 *
 * `withheld` is the whole point of this component, the same way it is the
 * whole point of the identical field on the machines screen's capital
 * reading: a contribution computed past a missing line would be smaller than
 * anything published says, which reads as a bargain rather than as a mistake.
 * So a withheld reading is shown in words and there is no `?? 0` anywhere in
 * this file.
 */
function Economics({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-economics">
      <h3>Unit economics</h3>
      {view.economics.length === 0 ? (
        <p className="rs-empty">No product class has a published figure yet.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {view.economics.map((one) => (
            <li key={`${one.formatKey}:${one.productClass}`}>
              <header>
                <strong>{one.formatKey}</strong>
                <span className="rs-puzzles-purpose">{words(one.productClass)}</span>
              </header>
              {/*
                * `withheld === null` is the domain's own guarantee that the
                * four figures below are established rather than a gap this
                * screen has to guess past — so the non-null assertions read
                * the guarantee rather than substitute a favourable zero for
                * an unknown. There is no `?? 0` in this component.
                */}
              {one.withheld || one.receiptsPerUnitCents === null || one.perUnitCostCents === null ? (
                <p className="rs-hint rs-puzzles-withheld">
                  Contribution withheld: {one.withheld ?? 'the figures do not settle it.'}
                </p>
              ) : (
                <p className="rs-item-meta">
                  {one.currency} {money(one.receiptsPerUnitCents)} receipts per unit,{' '}
                  {money(one.perUnitCostCents)} cost per unit
                  {one.contributionPerUnitCents !== null
                    ? `, contribution ${money(one.contributionPerUnitCents)}`
                    : ''}
                  {one.breakevenUnits !== null
                    ? ` — breakeven at ${one.breakevenUnits} unit${one.breakevenUnits === 1 ? '' : 's'}`
                    : ''}
                </p>
              )}
              {one.retailPriceCents !== null ? (
                <p className="rs-hint">
                  Retail price {one.currency} {money(one.retailPriceCents)}, reported and never
                  used in any arithmetic here.
                </p>
              ) : null}
              {one.lines.length > 0 ? (
                <details className="rs-puzzles-lines">
                  <summary>Published lines ({one.lines.length})</summary>
                  <ul>
                    {one.lines.map((line) => (
                      <li key={line.component}>
                        {words(line.component)}: {line.currency}{' '}
                        {line.lowCents === line.highCents
                          ? money(line.lowCents)
                          : `${money(line.lowCents)}–${money(line.highCents)}`}{' '}
                        ({line.sources} source{line.sources === 1 ? '' : 's'})
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The brief's own named question: how does a hundred-puzzle book at a dollar
 * work. Answered from rows or not at all, so `established` and `missing` are
 * both shown — a chain with three guesses in the middle is worse than an
 * honest list of what nothing has settled yet.
 */
function DollarBook({ view }: { view: PuzzleView }): JSX.Element {
  const { dollarBook } = view;
  return (
    <section className="rs-card rs-puzzles-dollarbook">
      <h3>The hundred-puzzles-for-a-dollar question</h3>
      <p className="rs-puzzles-because">{dollarBook.verdict}</p>
      {dollarBook.established.length > 0 ? (
        <>
          <h4>Established</h4>
          <ul className="rs-puzzles-list">
            {dollarBook.established.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      ) : null}
      {dollarBook.missing.length > 0 ? (
        <>
          <h4>Missing</h4>
          <ul className="rs-puzzles-list">
            {dollarBook.missing.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** Physical production: what stage it is at, and what would move it. */
function Physical({ view }: { view: PuzzleView }): JSX.Element {
  const { physical } = view;
  return (
    <section className="rs-card rs-puzzles-physical">
      <h3>Physical production</h3>
      <p className="rs-item-meta">Stage {physical.stage} of 5</p>
      <p className="rs-hint">{physical.reading}</p>
      {physical.productionRoutes.length > 0 ? (
        <ul className="rs-puzzles-list">
          {physical.productionRoutes.map((one) => (
            <li key={`${one.format}:${one.name}`}>
              <strong>{one.name}</strong> for {one.format}
              <p className="rs-hint">{one.terms}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rs-empty">No production route is established.</p>
      )}
      {physical.heldCapabilities.length > 0 ? (
        <p className="rs-item-meta">Held: {physical.heldCapabilities.join(', ')}</p>
      ) : null}
    </section>
  );
}

/**
 * Every format's maturity, furthest first — the server's own tie-break, never
 * re-sorted here.
 *
 * Ten rungs and no partial credit: the ladder stops at the first one that is
 * not met, so `waitingOn` and `remedy` are what a reader acts on rather than
 * the rung's bare name.
 */
function Maturity({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-maturity">
      <h3>Maturity, by format</h3>
      {view.maturity.length === 0 ? (
        <p className="rs-empty">No format is on the map yet.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {view.maturity.map((one) => (
            <li key={one.formatKey} className="rs-puzzles-format">
              <header>
                <strong>{one.name}</strong>
                <span className="rs-puzzles-rung">{words(one.rung)}</span>
              </header>
              <p className="rs-item-meta">
                {one.evidence.validPuzzles} valid puzzle{one.evidence.validPuzzles === 1 ? '' : 's'},{' '}
                {one.evidence.products} product{one.evidence.products === 1 ? '' : 's'},{' '}
                {one.evidence.buyers} buyer{one.evidence.buyers === 1 ? '' : 's'},{' '}
                {one.evidence.channels} channel{one.evidence.channels === 1 ? '' : 's'}
              </p>
              <p className="rs-hint">
                {one.waitingOn} <em>({words(one.remedy)})</em>
              </p>
              {one.limitation ? <p className="rs-hint rs-puzzles-limitation">{one.limitation}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What attempting this has taught, with the sample shown beside every rule.
 *
 * A single observation is an anecdote and is never hidden — one customer
 * complaint about a puzzle nobody could finish is often the most valuable row
 * here, and a threshold that hid it until it happened three times would be a
 * threshold that waits for the damage.
 */
function Lessons({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-lessons">
      <h3>What attempting this has taught</h3>
      {view.lessons.length === 0 ? (
        <p className="rs-empty">Nothing has been observed yet.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {view.lessons.map((one) => (
            <li key={`${one.kind}:${one.subject}`} className={`rs-puzzles-lesson-${one.strength}`}>
              <header>
                <strong>{one.subject}</strong>
                <span className="rs-puzzles-purpose">{words(one.kind)}</span>
              </header>
              <p className="rs-item-meta">
                {one.observations} observation{one.observations === 1 ? '' : 's'} ({one.fromPeople}{' '}
                from a person) — {one.strength === 'PATTERN' ? 'a pattern' : 'an anecdote'}
              </p>
              <ul className="rs-puzzles-statements">
                {one.statements.map((statement, index) => (
                  <li key={index}>{statement}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What changed, newest first — the one place in this screen recency is the point. */
function Recent({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-recent">
      <h3>Recent observations</h3>
      {view.recent.length === 0 ? (
        <p className="rs-empty">Nothing has been recorded yet.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {view.recent.map((one) => (
            <li key={one.id}>
              <header>
                <strong>{OBSERVATION_KIND_LABEL[one.kind] ?? words(one.kind)}</strong>
                <span className="rs-item-meta">{one.recordedBy === 'BRAIN' ? 'Brain' : 'a person'}</span>
              </header>
              <p className="rs-hint">{one.statement}</p>
              <p className="rs-item-meta">{one.createdAt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What Brain cannot decide for itself. */
function NeedsPerson({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-needsperson">
      <h3>Needs a person</h3>
      {view.needsPerson.length === 0 ? (
        <p className="rs-empty">Nothing here is waiting on a person right now.</p>
      ) : (
        <ul className="rs-puzzles-list">
          {view.needsPerson.map((one, index) => (
            <li key={index}>
              <strong>{one.what}</strong>
              <p className="rs-hint">{one.why}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The single sentence somebody acts on, verbatim. */
function NextAction({ view }: { view: PuzzleView }): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-next">
      <h3>Next</h3>
      <p className="rs-puzzles-because">{view.nextAction}</p>
    </section>
  );
}

/**
 * What this repository can and cannot do about puzzles, kept apart from the
 * commercial capabilities every kernel shares.
 *
 * The two are shown separately for the reason the machines screen already
 * gives: research claims and what this repository can verifiably do are
 * different kinds of fact, and nothing here derives the second from the
 * first.
 */
function Capabilities({ view }: { view: PuzzleView }): JSX.Element {
  const { capabilities } = view;
  return (
    <section className="rs-card rs-puzzles-capabilities">
      <h3>What Brain can and cannot do</h3>
      <h4>About the puzzles themselves</h4>
      <ul className="rs-puzzles-list">
        {capabilities.puzzle.map((one) => (
          <li key={one.id} className={`rs-puzzles-cap rs-puzzles-cap-${one.state}`}>
            <header>
              <strong>{words(one.id)}</strong>
              <span className="rs-puzzles-cap-state">{words(one.state)}</span>
            </header>
            <p className="rs-hint">{one.does}</p>
            <p className="rs-item-meta">{one.reading}</p>
            {one.nextStep ? <p className="rs-hint">{one.nextStep}</p> : null}
          </li>
        ))}
      </ul>
      <h4>Commercial</h4>
      <ul className="rs-puzzles-list">
        {capabilities.commercial.map((one) => (
          <li key={one.id} className={`rs-puzzles-cap rs-puzzles-cap-${one.state}`}>
            <header>
              <strong>{one.definition ? words(one.definition.id) : words(one.id)}</strong>
              <span className="rs-puzzles-cap-state">{words(one.state)}</span>
            </header>
            {one.definition ? (
              <>
                <p className="rs-hint">{one.definition.does}</p>
                <p className="rs-item-meta">{one.definition.requires}</p>
                {one.definition.nextStep ? <p className="rs-hint">{one.definition.nextStep}</p> : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Reading one puzzle from its own specification                             */
/* ------------------------------------------------------------------------- */

/**
 * Re-render one puzzle instance and say whether it still hashes to what was
 * recorded when it was validated.
 *
 * There is no grid stored anywhere for this to read back, which is the whole
 * of "the specification is the storage" — it is rendered fresh from the
 * master and the seed every time, so a mismatch means the generator changed
 * underneath the row rather than that the row itself changed.
 *
 * `PuzzleView` does not enumerate instance ids, so the id is typed rather
 * than chosen from a list this view was never built to hold.
 */
function PuzzleInstanceLookup({ projectId }: { projectId: string }): JSX.Element {
  const [instanceId, setInstanceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState<PuzzleInstanceReading | null>(null);

  const open = useCallback(() => {
    if (busy || instanceId.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    setReading(null);
    getPuzzleInstance(projectId, instanceId.trim()).then(
      (answer) => {
        setBusy(false);
        setReading(answer);
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, instanceId, projectId]);

  return (
    <section className="rs-card rs-puzzles-instance">
      <h3>Open a puzzle instance</h3>
      <p className="rs-hint">
        Re-renders it from its own specification, and says whether it still hashes to what was
        recorded when it was validated.
      </p>
      <div className="rs-puzzles-form">
        <label>
          <span className="rs-field-label">Instance id</span>
          <input value={instanceId} onChange={(event) => setInstanceId(event.target.value)} />
        </label>
        <p className="rs-puzzles-actions">
          <button type="button" disabled={busy || instanceId.trim().length === 0} onClick={open}>
            {busy ? 'Rendering…' : 'Open it'}
          </button>
        </p>
      </div>
      {problem ? <p className="rs-hint rs-puzzles-problem">{problem}</p> : null}
      {reading ? <InstanceArtifact reading={reading} /> : null}
    </section>
  );
}

function InstanceArtifact({ reading }: { reading: PuzzleInstanceReading }): JSX.Element {
  return (
    <div className={`rs-puzzles-rendered ${reading.reproduced ? 'rs-puzzles-ok' : 'rs-puzzles-mismatch'}`}>
      <p className="rs-hint">{reading.message}</p>
      {reading.artifact ? <Artifact artifact={reading.artifact} /> : null}
    </div>
  );
}

function Artifact({ artifact }: { artifact: PuzzleArtifact }): JSX.Element {
  return (
    <div className="rs-puzzles-artifact">
      <p className="rs-item-meta">{artifact.instructions}</p>
      <pre className="rs-puzzles-grid">{artifact.grid.join('\n')}</pre>
      {artifact.prompts.length > 0 ? (
        <ul className="rs-puzzles-prompts">
          {artifact.prompts.map((one, index) => (
            <li key={index}>{one}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Solution</summary>
        <pre className="rs-puzzles-grid">{artifact.solution.join('\n')}</pre>
      </details>
      <details>
        <summary>Answer key</summary>
        <pre className="rs-puzzles-grid">{artifact.answerKey.join('\n')}</pre>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* The decisions a person makes                                              */
/* ------------------------------------------------------------------------- */

/**
 * Naming a format, retiring one, and recording an observation — the only
 * three writes this screen offers, following Labor.tsx's rule exactly: every
 * write posts only the fields `puzzleApi.ts` exposes, and shows the server's
 * own message or refusal text rather than a sentence composed here.
 *
 * There is deliberately no control here that defines a system, submits a
 * puzzle anywhere, or marks a product as sold — those either need no
 * dedicated control yet, or belong to Cash Mode's own commercial actions.
 */
function ShapeThePuzzleMap({
  projectId,
  view,
  reload,
}: {
  projectId: string;
  view: PuzzleView;
  reload(): void;
}): JSX.Element {
  return (
    <section className="rs-card rs-puzzles-declare">
      <h3>Name a format, and record what happened</h3>
      <p className="rs-hint">
        Naming a format spends nothing and starts nothing. It creates a row; the kernel decides
        when it is asked about, the sprint's standing authority decides whether that may run,
        and the evidence gate decides what may be claimed.
      </p>
      <SeedFormat projectId={projectId} reload={reload} />
      <RetireFormat projectId={projectId} reload={reload} />
      <RecordObservation projectId={projectId} view={view} reload={reload} />
    </section>
  );
}

function SeedFormat({ projectId, reload }: { projectId: string; reload(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    seedPuzzleFormat(projectId, { name: name.trim(), note: note.trim() || undefined }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setName('');
        setNote('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, name, note, projectId, reload]);

  return (
    <div className="rs-puzzles-form">
      <h4>Name a format</h4>
      <label>
        <span className="rs-field-label">Format name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span className="rs-field-label">Note</span>
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <p className="rs-puzzles-actions">
        <button type="button" disabled={busy || name.trim().length === 0} onClick={submit}>
          {busy ? 'Naming…' : 'Name it'}
        </button>
      </p>
      {problem ? <p className="rs-hint rs-puzzles-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-puzzles-said">{said}</p> : null}
    </div>
  );
}

/**
 * Stop asking about a format.
 *
 * The id is typed rather than chosen from a list, because `PuzzleView` names
 * formats by key and by name — never by the row id this route needs — and
 * inventing a lookup this view was not built to hold would be the kind of
 * affordance that only ever half-works.
 */
function RetireFormat({ projectId, reload }: { projectId: string; reload(): void }): JSX.Element {
  const [formatId, setFormatId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy || formatId.trim().length === 0 || reason.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    retirePuzzleFormat(projectId, formatId.trim(), { reason: reason.trim() }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setFormatId('');
        setReason('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, formatId, projectId, reason, reload]);

  return (
    <div className="rs-puzzles-form">
      <h4>Retire a format</h4>
      <p className="rs-hint">
        Never a delete. Its systems, every puzzle they made and every product compiled from them
        keep their rows, which is what stops it arriving again as a fresh discovery.
      </p>
      <label>
        <span className="rs-field-label">Format id</span>
        <input
          value={formatId}
          placeholder="fmt_… — from when it was seeded, or npm run report:puzzle"
          onChange={(event) => setFormatId(event.target.value)}
        />
      </label>
      <label>
        <span className="rs-field-label">Reason</span>
        <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <p className="rs-puzzles-actions">
        <button
          type="button"
          disabled={busy || formatId.trim().length === 0 || reason.trim().length === 0}
          onClick={submit}
        >
          {busy ? 'Retiring…' : 'Retire it'}
        </button>
      </p>
      {problem ? <p className="rs-hint rs-puzzles-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-puzzles-said">{said}</p> : null}
    </div>
  );
}

/**
 * Recording what actually happened.
 *
 * `format` and `route` are offered as choices from what the view already
 * names — the maturity ladder's formats and the ledger's routes — because
 * both are closed sets this view already carries. `productId` is typed: no
 * section of this view lists product ids, so a person supplies the one they
 * mean rather than being offered a list this view cannot honestly draw.
 *
 * `HUMAN_EDIT_PASSED` is the one kind that can move a format to SELLABLE, and
 * there is no separate flag anywhere that stands in for it — it is exactly
 * this form, with that kind chosen.
 */
function RecordObservation({
  projectId,
  view,
  reload,
}: {
  projectId: string;
  view: PuzzleView;
  reload(): void;
}): JSX.Element {
  const kinds = Object.keys(OBSERVATION_KIND_LABEL) as PuzzleObservation['kind'][];
  const [kind, setKind] = useState<PuzzleObservation['kind']>(kinds[0] ?? 'SALE');
  const [statement, setStatement] = useState('');
  const [formatKey, setFormatKey] = useState('');
  const [productId, setProductId] = useState('');
  const [route, setRoute] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const submit = useCallback(() => {
    if (busy || statement.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    recordPuzzleObservation(projectId, {
      kind,
      statement: statement.trim(),
      format: formatKey || undefined,
      productId: productId.trim() || undefined,
      route: route || undefined,
    }).then(
      (answer) => {
        setBusy(false);
        setSaid(answer.message);
        setStatement('');
        reload();
      },
      (error: unknown) => {
        setBusy(false);
        setProblem(describe(error));
      },
    );
  }, [busy, formatKey, kind, productId, projectId, reload, route, statement]);

  return (
    <div className="rs-puzzles-form">
      <h4>Record an observation</h4>
      <p className="rs-hint">
        This is the one kind that matters most: reading what the machine made, once, and saying
        it passed, is the only thing that can move a format to SELLABLE.
      </p>
      <label>
        <span className="rs-field-label">What happened</span>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as PuzzleObservation['kind'])}
        >
          {kinds.map((one) => (
            <option key={one} value={one}>
              {OBSERVATION_KIND_LABEL[one]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="rs-field-label">Format (optional)</span>
        <select value={formatKey} onChange={(event) => setFormatKey(event.target.value)}>
          <option value="">Not about a particular format</option>
          {view.maturity.map((one) => (
            <option key={one.formatKey} value={one.formatKey}>
              {one.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="rs-field-label">Monetization route (optional)</span>
        <select value={route} onChange={(event) => setRoute(event.target.value)}>
          <option value="">Not about a particular route</option>
          {view.ledger.map((one) => (
            <option key={one.route.id} value={one.route.id}>
              {one.route.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="rs-field-label">Product id (optional)</span>
        <input
          value={productId}
          placeholder="This view does not list product ids — paste one if you have it"
          onChange={(event) => setProductId(event.target.value)}
        />
      </label>
      <label>
        <span className="rs-field-label">What happened, in words</span>
        <textarea rows={3} value={statement} onChange={(event) => setStatement(event.target.value)} />
      </label>
      <p className="rs-puzzles-actions">
        <button type="button" disabled={busy || statement.trim().length === 0} onClick={submit}>
          {busy ? 'Recording…' : 'Record it'}
        </button>
      </p>
      {problem ? <p className="rs-hint rs-puzzles-problem">{problem}</p> : null}
      {said ? <p className="rs-hint rs-puzzles-said">{said}</p> : null}
    </div>
  );
}
