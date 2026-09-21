/**
 * Cash: one person's private sprint, and nobody else's.
 *
 * The five things §10 of the plan asks a person to be shown, in the order it
 * asks for them — my cash, my current work, what Brain has done, what Brain
 * needs, decisions for me — plus the one decision at the top that nothing can
 * proceed without.
 *
 * Three rules, and every one of them is a defect this repository has already
 * recorded somewhere else.
 *
 * **Nothing here derives a figure.** Every number comes from the server's own
 * projection. A screen that computed deployable cash would be a second opinion
 * about the same money, and the two would eventually disagree in the direction
 * that spends something.
 *
 * **Nothing here composes a sentence about a permission or a state.** The
 * authority's lines, the disposition's reason, the review item's consequence
 * and the lifecycle's message are all the server's words. A screen that
 * paraphrased a permission would eventually paraphrase it wrongly.
 *
 * **The status agrees with the control beside it.** Where an approval is
 * outstanding it is named first and never folded, and answering it goes back to
 * the server rather than optimistically redrawing — §29's rule, at the surface
 * that authorizes spending.
 */
import { useState } from 'react';
import { useAsync } from './useAsync.ts';
import { cashPage, modeState, type CashPage } from './cashPage.ts';
import {
  CashApi,
  type CashModeState,
  type CashRoadmap,
  type CashView,
  type CashViewReading,
  type DerivedFigureView,
  type EngineCardView,
  type Placement,
  type ReviewItem,
} from '../lib/cashApi.ts';

/**
 * What a round is really doing, in the words a person reads.
 *
 * The state column says OPEN until a round is harvested, which in production
 * meant ten rounds reading as research under way while every candidate was
 * parked and no work item existed. The server derives the real answer; this
 * only names it.
 */
const ROUND_ACTIVITY: Record<string, string> = {
  AWAITING_LAUNCH: 'captured, not started yet',
  PARKED: 'stopped',
  RESEARCHING: 'being researched now',
  ANSWERED: 'research finished',
};

const DISPOSITION_LABEL: Record<Placement['disposition'], string> = {
  EXECUTE_NOW: 'Execute now',
  RUN_IN_PARALLEL: 'Run in parallel',
  WAIT_FOR_DEPENDENCY: 'Wait for a named dependency',
  TEST_A_DECISIVE_UNKNOWN: 'Test a decisive unknown',
  BEING_QUALIFIED: 'Brain is qualifying this',
  EVIDENCE_ONLY: 'Evidence — not work',
  ARCHIVED: 'Archived',
};

/**
 * The dispositions that mean a person has something to do or something to wait
 * for.
 *
 * The client reads this only to choose a heading; the server already decided
 * which list each piece is in. It is here so a payload from before the split
 * (a tab open across a deploy) still separates the two rather than showing
 * every record as work.
 */
const WORK_DISPOSITIONS = new Set<Placement['disposition']>([
  'EXECUTE_NOW',
  'RUN_IN_PARALLEL',
  'WAIT_FOR_DEPENDENCY',
  'TEST_A_DECISIVE_UNKNOWN',
]);

/** Cents to a readable amount. Presentation only; no arithmetic happens here. */
function money(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A typed amount in ordinary money, as cents.
 *
 * Null when it is not a well-formed amount, which is what the control checks
 * rather than trying to guess what somebody meant. Commas and a leading
 * currency symbol are tolerated because people type them; anything else is
 * refused, because rounding an ambiguous string into a spending ceiling is the
 * wrong direction to be forgiving in.
 *
 * Presentation only. The API still takes cents and its guards are unchanged —
 * this is the conversion that stops a person being asked to do it in their
 * head, which is how $250 gets typed where 25000 was meant.
 */
function centsFromAmount(typed: string): number | null {
  const cleaned = typed.trim().replace(/^[^0-9.]+/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/**
 * The section, over one chosen operation.
 *
 * `projectId` is the shell's current selection and is a **candidate**, not the
 * answer. It used to be the answer, which meant somebody with a broad Brain
 * project and a private cash project could be shown — and could activate — the
 * wrong one, because the shell hands out the first project a person can see. An
 * operation is what a sprint belongs to, so it is chosen here.
 */
export function CashView_({
  projectId: _shellProject,
  isBrainAdmin,
}: {
  projectId: string | null;
  /**
   * Whether to *offer* the invite control. It is a convenience and never the
   * control: the route refuses anybody else with the same 404 a missing one
   * gives, whatever this renders.
   */
  isBrainAdmin: boolean;
}): JSX.Element {
  /*
   * No operation is chosen, because there is nothing to choose between.
   *
   * This used to read a list of sprints and pick one — the shell's project if
   * it happened to have a sprint, otherwise the first the person had. That was
   * the four-operation model rendered: four frontiers, four objectives, and a
   * question in front of a person before anything could start. The server now
   * resolves the single root, so the shell's project is deliberately ignored.
   */
  const reading = useAsync(() => CashApi.mode(), []);
  const known = reading.data ?? null;
  const rootId = known?.root?.projectId ?? null;

  const view = useAsync(
    () => (rootId ? CashApi.view(rootId) : Promise.resolve(null as CashViewReading | null)),
    [rootId],
  );

  if (!known) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Reading Cash Mode&hellip;</p>
      </section>
    );
  }

  /*
   * Not started: no root at all, or a root with no sprint on it. Both are the
   * same thing to a person and get the same one-button card.
   */
  if (!known.mode) {
    return (
      <Activate
        objective={known.objective}
        currencies={known.currencies}
        isBrainAdmin={isBrainAdmin}
        onActivated={() => {
          reading.reload();
          view.reload();
        }}
      />
    );
  }

  /*
   * A re-read must not blank what is already showing.
   *
   * `loading` is true both when there is nothing yet and when the view is being
   * read again, and treating the second as "not ready" unmounts the section —
   * which is how Build lost an invitation that was shown once.
   */
  const data = view.data ?? null;

  if (view.error) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className={`rs-state rs-state-${view.error.status === 404 ? 'forbidden' : 'error'}`}>
          {view.error.status === 404
            ? 'There is nothing here for you to see. That is the same answer a project that does not exist gives, on purpose.'
            : view.error.message}
          {view.error.status === 404 ? null : (
            <button type="button" onClick={view.reload}>
              Try again
            </button>
          )}
        </p>
      </section>
    );
  }

  /*
   * `known.mode` above says a sprint exists; this says the *view* has caught up
   * with it. Both are asked, because the two reads are separate requests and a
   * render between them would otherwise dereference a mode that is not there
   * yet — the same "loading is not the same as absent" distinction the error
   * branch above makes.
   */
  if (!data || !rootId || !data.mode) {
    return (
      <section className="rs-view rs-view-cash">
        <h2>Cash</h2>
        <p className="rs-state rs-state-loading">Reading the frontier&hellip;</p>
      </section>
    );
  }

  /*
   * One page, both roles.
   *
   * There used to be an early `return <SharedFrontier/>` here, and it was a
   * **second page**: nine sections against five, no heading in common and not
   * one section identifier in common. The privacy boundary it protected was
   * right; selecting a different layout to protect it was not, and it meant a
   * defect on one of the two pages was invisible to anybody looking at the
   * other.
   *
   * So the role no longer chooses which sections exist. It chooses what is
   * *inside* one, through `page.capabilities` — and the private blocks are
   * still **absent from the payload** for a member, so there is no arrangement
   * of this component that could render one and nothing hidden in the bundle
   * to find.
   */
  const page = cashPage({ reading: data });

  return (
    <section className="rs-view rs-view-cash">
      <h2>Cash</h2>
      {/*
        * Brain's mandate, not a sentence somebody typed. The short reading is
        * what is shown; the full text is on the element so it is always
        * reachable rather than paraphrased away.
        */}
      <p className="rs-lede" title={known.objective.full}>
        {known.objective.summary}
      </p>
      <p className="rs-hint">{page.frontier.discovery.reason}</p>

      {/*
        * The order is the order a person reads in, and it is a correction.
        *
        * It used to open with the decisions, then the whole money picture,
        * then every money entry, then every piece in the portfolio with its
        * full card, then every need, then the research table, then every
        * event. In production that was thirty-one raw signals and five
        * "decisions" standing for ninety-eight items before anything said what
        * state the sprint was in.
        *
        * Now: where this stands, what to decide, what is worth doing, what the
        * money is — and everything else behind a disclosure that is still one
        * click away and still complete. Nothing was deleted; the first screen
        * stopped being all of it.
        */}
      <Status page={page} />
      <Decisions page={page} projectId={rootId} onChanged={view.reload} />
      <YourWork page={page} onChanged={view.reload} />
      <BestOpportunities page={page} onChanged={view.reload} />
      <MoneyRow page={page} />
      <Details page={page} onChanged={view.reload} />
      {/*
        * People and capacity used to render here, inline: a member list, an
        * invite control, the outstanding links and every Claude capacity
        * account. None of it was about Cash.
        *
        * A person joins a **Brain** and a Routine serves every project in it.
        * §32 removed the last count on this surface that gated anything, so
        * what was left was Brain-wide account infrastructure administered from
        * a section that is meant to be wound down in a month or two — §30's own
        * first sentence failing in the navigation. It is a destination now, and
        * what stays here is one link to it.
        */}
      <p className="rs-hint">
        Who has joined this Brain and how much Claude research capacity it can fire are the
        same in every project, so they live on{' '}
        <a className="rs-link" href="/people">
          People &amp; capacity
        </a>
        . Neither starts or stops the work above.
      </p>
      <Lifecycle
        projectId={rootId}
        state={modeState(page) ?? 'ACTIVE'}
        mayAdminister={page.capabilities.mayAdminister}
        onChanged={view.reload}
      />
    </section>
  );
}

/**
 * Cash Mode is not running yet.
 *
 * One button, and deliberately nothing else required.
 *
 * It used to ask two questions first: *which operation* — a picker over four
 * person-derived sprints — and *what is this account trying to produce*, a
 * required free-text objective with a 12-character floor. Both were wrong for
 * the same reason. There is one shared frontier, so there is no operation to
 * choose; and an objective typed into a box silently becomes a boundary the
 * Brain will not search past, made of whatever the person did not think to
 * write that morning. Nobody can see that omission afterwards.
 *
 * So the mandate is Brain's own and is shown rather than solicited, and the
 * constraints box is collapsed, optional, and **additive** — the server appends
 * it under a heading that keeps the standing mandate legible beside it.
 *
 * Starting it still takes one deliberate click, because activation is a
 * person's decision. It authorizes no spending: what Brain may do with money is
 * a separate grant, below, and this card cannot make one.
 */
function Activate({
  objective,
  currencies,
  isBrainAdmin,
  onActivated,
}: {
  objective: { summary: string; full: string };
  currencies: string[];
  /**
   * Whether to offer the Start control at all.
   *
   * A convenience and never the control: `POST /api/cash/activate` is
   * `requirePerson` plus `requireBrainAdmin`, so the worst an ordinary member
   * sees is a card that explains what Cash Mode is and no button.
   */
  isBrainAdmin: boolean;
  onActivated(): void;
}): JSX.Element {
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [constraints, setConstraints] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.start({
        ...(constraints.trim().length > 0 ? { constraints: constraints.trim() } : {}),
        currency,
      });
      onActivated();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rs-view rs-view-cash">
      <h2>Cash</h2>
      <div className="rs-card rs-cash-activate">
        <p className="rs-authority-headline">What Cash Mode does</p>
        <p className="rs-lede">{objective.summary}</p>
        <p className="rs-item-meta">Not started.</p>

        <p className="rs-hint">
          Starting this spends nothing and authorizes nothing. What Brain may do with money is a
          separate decision, and it is yours.
        </p>

        {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
        {/*
          * Readiness is reported on People & capacity and does not gate this button.
          *
          * The four-of-four count was the owner's decision to wait for
          * everybody rather than a property of the system, and it has been
          * withdrawn — on the screen and on the route together, because a
          * button enabled against a route that still refused would be the
          * worse of the two failures. The panel above still says who cannot
          * sign in yet and which surfaces are unproven; it simply stops
          * nothing. The "not ready to start" sentence went with the lock: a
          * status contradicting the control beside it is §29's own defect.
          */}
        {isBrainAdmin ? (
          <button type="button" className="rs-button" disabled={busy} onClick={submit}>
            {busy ? 'Starting\u2026' : 'Start Cash Mode'}
          </button>
        ) : (
          /*
            * Not a refusal dressed as an absence: the sentence says whose
            * decision it is. The route refuses anybody else with the same 404 a
            * missing one gives whatever this renders, so the button's absence
            * is a convenience and the guard is somewhere a page cannot reach.
            */
          <p className="rs-hint">
            Starting Cash Mode is a Brain administrator&rsquo;s decision. Nothing is running yet,
            and nothing here is hidden from you — there is simply nothing to show until it is.
          </p>
        )}

        <button
          type="button"
          className="rs-button-quiet"
          aria-expanded={showAdvanced}
          aria-controls="cash-advanced"
          onClick={() => setShowAdvanced((open) => !open)}
        >
          {showAdvanced ? 'Hide constraints' : 'Add constraints (optional)'}
        </button>
        {showAdvanced ? (
          <div id="cash-advanced">
            <label className="rs-field-label" htmlFor="cash-currency">
              The one currency this keeps its money in
            </label>
            <select
              id="cash-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <p className="rs-hint">
              It holds exactly one. Brain does not choose an exchange rate, so an entry in another
              currency is refused rather than converted.
            </p>

            <label className="rs-field-label" htmlFor="cash-constraints">
              Anything to prioritise, rule out, or make Brain aware of
            </label>
            <textarea
              id="cash-constraints"
              rows={3}
              value={constraints}
              onChange={(event) => setConstraints(event.target.value)}
              placeholder="A deadline, a category to avoid, a resource you have, a budget change."
            />
            <p className="rs-hint">
              This is added to the mandate above, never substituted for it. Leaving it empty
              narrows nothing.
            </p>

            <details>
              <summary className="rs-field-label">The mandate in full</summary>
              <p className="rs-item-meta">{objective.full}</p>
            </details>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Decisions for me.
 *
 * Named first because the first of them is usually the one nothing can proceed
 * without. The compression is reported rather than claimed: the count of
 * underlying items each group stands for is on the screen.
 */
function Decisions({
  page,
  projectId,
  onChanged,
}: {
  page: CashPage;
  projectId: string;
  onChanged(): void;
}): JSX.Element {
  const view = page.full;

  /*
   * The section exists for both roles and is empty for one of them.
   *
   * A decisions review is a list of things for **one person** to answer, so it
   * is not on the shared frontier and never will be. What the section must not
   * do is disappear: removing it would take the heading and the identifier off
   * the member's page and put the sections after it at different positions,
   * which is the divergence this whole change exists to remove. So it renders,
   * and says the true thing.
   */
  if (!view) {
    return (
      <section className="rs-card rs-cash-decisions">
        <h3>Decisions for you</h3>
        <p className="rs-hint">
          Nothing here is waiting on you. Decisions about an execution job &mdash; what it charges,
          what it commits and when it goes ahead &mdash; belong to whoever owns that job, and are
          not sent to this page.
        </p>
      </section>
    );
  }

  return (
    <section className="rs-card rs-cash-decisions">
      <h3>Decisions for you</h3>
      <p className="rs-hint">{view.decisionsForMe.summary}</p>
      {/*
        * The approval is listed *or* rendered as its card, never both.
        *
        * The server names it first because nothing can proceed without it, and
        * the card below is the control that answers it. Rendering both put the
        * same sentence on the screen twice, one of them with no button — which
        * is the noisier half of §29's defect: a person learns to skim the list
        * because part of it repeats what is underneath.
        *
        * The condition is exactly the one that decides whether the card
        * renders, so the two can never disagree about which is showing it.
        */}
      {view.decisionsForMe.items.length === 0 ? null : (
        <ul className="rs-list">
          {view.decisionsForMe.items
            .filter((item) => !(item.key === 'AUTHORITY' && !view.authority.exists))
            .map((item) => (
              <li key={item.key} className={`rs-decision rs-decision-${item.urgency.toLowerCase()}`}>
                <p className="rs-item-title">{item.title}</p>
                <p className="rs-decision-why">{item.why}</p>
                <p className="rs-decision-what">{item.recommendation}</p>
                <p className="rs-choice-consequence">{item.consequence}</p>
                {item.costNote ? <p className="rs-item-meta">{item.costNote}</p> : null}
                {item.underlying.length > 0 ? (
                  <p className="rs-item-meta">
                    {/*
                      * "Stands for" and "covers" are different claims, and the
                      * server decides which. A group whose members share one
                      * remedy is answered once; one that merely shares a kind
                      * of work is a batch, and saying otherwise teaches a
                      * person to stop believing the counts.
                      */}
                    {item.sharedRemedy ? 'One answer covers' : 'The same kind of work on'}{' '}
                    {item.underlying.length} {item.underlying.length === 1 ? 'item' : 'items'}.
                  </p>
                ) : null}
                <DecisionAnswer item={item} view={view} onDone={onChanged} />
              </li>
            ))}
        </ul>
      )}
      <Authority
        view={view}
        projectId={projectId}
        mayGrant={page.capabilities.mayGrantAuthority}
        onChanged={onChanged}
      />
    </section>
  );
}

/**
 * The control that answers one decision, and the honest absence of one.
 *
 * Every answer names an operation that already exists — the grant, closing a
 * need, releasing a commitment, filling a card. This renders the one the server
 * chose and composes none of its own; a screen that decided what answering
 * something meant would be a second opinion about one sprint.
 *
 * `NOTHING_TO_PRESS` renders as a sentence rather than a disabled button. An
 * expiring opening is worth putting in front of somebody and is answered by
 * taking it, and a button that only marked it read would be a control that
 * pretends to do something.
 */
function DecisionAnswer({
  item,
  view,
  onDone,
}: {
  item: ReviewItem;
  view: CashView;
  onDone(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState('');
  const [reference, setReference] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const kind = item.answer.kind;

  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      setDone(await work());
      setAsking(false);
      setSaid('');
      setReference('');
      onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /*
   * What the answer would actually touch, named before it is given.
   *
   * §29's rule about counts, one surface along: a control that says it releases
   * five and releases one teaches a person to stop believing the screen. The
   * server already says which rows an item stands for; this says it back.
   */
  const affects =
    item.answer.targets.length > 0 ? (
      <p className="rs-item-meta">
        This answer applies to {item.answer.targets.length}{' '}
        {item.answer.targets.length === 1 ? 'record' : 'records'}. Brain then checks it by
        reading: {item.answer.completionCondition}
      </p>
    ) : null;

  const outcome = done ? <p className="rs-state rs-state-ok">{done}</p> : null;
  const failure = problem ? <p className="rs-state rs-state-error">{problem}</p> : null;

  if (kind === 'NOTHING_TO_PRESS') {
    return (
      <>
        <p className="rs-item-meta">{item.answer.label}.</p>
        {affects}
      </>
    );
  }

  /*
   * The grant is answered by the card below, which is the control it *is*.
   *
   * The rest used to render as a sentence with the same excuse — that funding
   * and release controls existed elsewhere on the page — and they did not: the
   * money panel is a read-only table and the opportunity actions are
   * ready/execute/deliver/collect/decline. So every answer but one was a
   * paragraph telling somebody what to do somewhere that had no way to do it.
   */
  if (kind === 'GRANT_AUTHORITY') {
    return (
      <>
        <p className="rs-item-meta">{item.answer.label} — the card below is where.</p>
        {affects}
      </>
    );
  }

  const opportunityId = item.answer.targets[0] ?? null;

  /*
   * A trigger only for the kinds this component actually implements.
   *
   * It used to render one for *any* kind, which was harmless only while every
   * kind had a branch below. Removing `RESOLVE_NEED` made it visible: the
   * button still drew itself from `answer.label`, and pressing it opened
   * nothing — a dead control, which is worse than the wrong form it replaced,
   * because a person presses it twice and concludes the page is broken.
   *
   * The union no longer contains that kind, so typed code cannot produce one;
   * this payload arrives over `fetch` and is not typed at runtime, and a
   * rolling deploy serves an old body to a new bundle for as long as it takes
   * the last instance to turn over. So the set is named rather than assumed,
   * and a kind this build does not implement renders the sentence and no
   * control — §29's rule that the interface is never optimistic, applied to a
   * payload rather than to a state.
   */
  const IMPLEMENTED = ['RECORD_MONEY', 'RELEASE_COMMITMENT'];
  if (!IMPLEMENTED.includes(kind)) {
    return (
      <>
        <p className="rs-item-meta">{item.answer.label}.</p>
        {affects}
      </>
    );
  }

  return (
    <div className="rs-cash-actions">
      {affects}
      {!asking ? (
        <button type="button" className="rs-button-quiet" onClick={() => setAsking(true)}>
          {item.answer.label}
        </button>
      ) : null}

      {/*
        * The `RESOLVE_NEED` branch was here, and it is deleted with the server
        * section that produced it.
        *
        * It asked *"What did you do?"* against the need's completion
        * condition, offered a second box for what you were doing instead if
        * the integration was still missing, and recorded the answer with a
        * **Confirm** — on a row whose own stored reason says Brain looks the
        * fact up rather than asking. Every need is Brain-owned, so there was
        * no narrower version of this form that was correct, and the rows it
        * stood for are on this page already under *What Brain needs*.
        */}

      {/*
        * The `FILL_CARD_FIELD` branch was here and is deleted with the review
        * section that produced it. Every field it could have offered is a fact
        * Brain researches or a proposal Brain composes, so the server emits no
        * such item any more and this arm was reachable by nothing.
        *
        * A person answering a card question is not gone — it moved to where
        * the question is actually asked, on the card itself. See `EngineCard`.
        */}

      {asking && kind === 'RECORD_MONEY' ? (
        <>
          <p className="rs-hint">
            Money that actually arrived. A settlement needs the bank or provider reference that
            makes it verifiable — a payment nobody can trace is pipeline, not cash.
          </p>
          <label className="rs-field-label" htmlFor={`cash-amount-${item.key}`}>
            How much, in {view.myCash.position.currency} cents
          </label>
          <input
            id={`cash-amount-${item.key}`}
            inputMode="numeric"
            value={said}
            onChange={(event) => setSaid(event.target.value)}
          />
          <label className="rs-field-label" htmlFor={`cash-ref-${item.key}`}>
            The reference it can be traced by
          </label>
          <input
            id={`cash-ref-${item.key}`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || !/^\d+$/.test(said.trim()) || reference.trim().length === 0}
            onClick={() =>
              void run(async () => {
                await CashApi.recordMoney(view.mode!.projectId, {
                  kind: 'CAPITAL_IN',
                  amountCents: Number(said.trim()),
                  currency: view.myCash.position.currency,
                  verifiedReference: reference.trim(),
                  // Built from what it records rather than from a clock, so a
                  // retry after a lost response is the same entry once.
                  idempotencyKey: `funding:${reference.trim()}`,
                });
                return 'Recorded. Deployable cash is recomputed from the ledger.';
              })
            }
          >
            {busy ? 'Recording…' : 'Confirm'}
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {asking && kind === 'RELEASE_COMMITMENT' ? (
        <>
          <p className="rs-hint">
            Releasing frees the money for something else. It is never released by a clock, so
            this is somebody saying it is not going to be spent.
          </p>
          {view.myCash.commitments.filter((one) => one.state === 'HELD').length === 0 ? (
            <p className="rs-item-meta">Nothing is held, so there is nothing to release.</p>
          ) : (
            <>
              <label className="rs-field-label" htmlFor={`cash-release-${item.key}`}>
                Which commitment
              </label>
              <select
                id={`cash-release-${item.key}`}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              >
                <option value="">Choose one</option>
                {view.myCash.commitments
                  .filter((one) => one.state === 'HELD')
                  .map((one) => (
                    <option key={one.id} value={one.id}>
                      {money(one.amountCents, one.currency)} &mdash; {one.purpose}
                    </option>
                  ))}
              </select>
              <label className="rs-field-label" htmlFor={`cash-why-${item.key}`}>
                Why it is not being spent
              </label>
              <input
                id={`cash-why-${item.key}`}
                value={said}
                onChange={(event) => setSaid(event.target.value)}
              />
              <button
                type="button"
                className="rs-button-quiet"
                disabled={busy || reference === '' || said.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await CashApi.releaseCommitment(reference, said.trim());
                    return 'Released. Nothing was spent, and the record stays.';
                  })
                }
              >
                {busy ? 'Releasing…' : 'Confirm'}
              </button>
            </>
          )}
          <button type="button" className="rs-linklike" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : null}

      {outcome}
      {failure}
    </div>
  );
}

/**
 * The patch key each card field is written under.
 *
 * The card names a field by its own key and `fillCard` takes the view type's
 * name for it; they differ for exactly the fields where the column and the
 * concept are not the same word. Anything absent falls through as itself — an
 * `ENGINE_FIELDS` key has no column at all and is written under its own name,
 * so a new one reaches the card without a second place to remember.
 */
const CARD_PATCH_KEY: Record<string, string> = {
  access: 'reachableChannel',
  buyingEvidence: 'buyingSignal',
  offer: 'offerScope',
  acceptance: 'acceptanceCondition',
  delivery: 'deliveryMethod',
  fulfillment: 'fulfillmentOwner',
  economics: 'economicsNote',
  cashDates: 'deadline',
  exposure: 'peakFundingCents',
  price: 'priceCents',
};

/**
 * What Brain may spend here.
 *
 * **The defaults are gone, and their absence is the point.** The card used to
 * arrive prefilled — $1,000 committed, $250 per action, three opportunities,
 * every commercial action ticked — with **Approve** visible and the actual
 * terms folded away under *Change details*. Three things were wrong with that
 * and they compound: nobody chose the numbers, the person approving could not
 * see what they were approving, and the three-opportunity cap quietly
 * contradicted the whole point of assembling several pieces at once.
 *
 * It is §27's `mutationScope` defect one subject along: the safe answer was the
 * one somebody had to remember and the unsafe one was free. So the ceilings are
 * typed, the server says what they would mean, and only then is there anything
 * to approve. Reading the preview creates nothing.
 */
function Authority({
  view,
  projectId,
  mayGrant,
  onChanged,
}: {
  view: CashView;
  projectId: string;
  /**
   * Whether to offer making or withdrawing a grant. Project `ADMIN`, decided by
   * the server and decided again on the call.
   *
   * **Reading is not gated by it.** A grant that exists bounds what this sprint
   * may spend, and a member of the project who cannot change it is still owed
   * the answer to *what is Brain allowed to do here* — the sentences below are
   * the server's own, composed for exactly that reading.
   */
  mayGrant: boolean;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [committed, setCommitted] = useState('');
  const [perAction, setPerAction] = useState('');
  const [concurrent, setConcurrent] = useState('');
  const [actions, setActions] = useState<string[]>(view.vocabulary.commercialActions);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');

  if (view.authority.exists) {
    return (
      <div className="rs-authority">
        <p className="rs-authority-headline">Spending limits &mdash; what Brain may spend here</p>
        <ul className="rs-authority-list">
          {view.authority.lines.map((line) => (
            <li key={line} className="rs-authority-limit">
              {line}
            </li>
          ))}
        </ul>
        <p className="rs-item-meta">
          Committed right now: {money(view.authority.heldCents, view.myCash.position.currency)}.
          Used so far is evidence, not an allowance.
        </p>
        {!mayGrant ? (
          <p className="rs-hint">
            Changing or withdrawing this is a decision for whoever administers the project.
          </p>
        ) : (
        <details>
          <summary className="rs-linklike">Withdraw this</summary>
          <label className="rs-field-label" htmlFor="cash-withdraw">
            Why
          </label>
          <input
            id="cash-withdraw"
            value={withdrawReason}
            onChange={(event) => setWithdrawReason(event.target.value)}
          />
          <p className="rs-hint">
            Withdrawing keeps every commitment, every money record and every opportunity. What
            stops is new commercial action, and money still held stays held against whatever you
            grant next.
          </p>
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || withdrawReason.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                await CashApi.withdrawAuthority(projectId, view.authority.id!, withdrawReason);
                onChanged();
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            Withdraw
          </button>
          {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
        </details>
        )}
      </div>
    );
  }

  /*
   * No grant, and nobody here who may make one.
   *
   * The sentence is what a person needs — nothing may be spent, and who would
   * decide otherwise — rather than a form that would be refused on submit.
   */
  if (!mayGrant) {
    return (
      <div className="rs-authority">
        <p className="rs-authority-headline">Spending limits &mdash; what Brain may spend here</p>
        <p className="rs-hint">
          Nothing is authorized to be spent. Setting that limit is a decision for whoever
          administers this project. Discovery and qualification cost nothing and are not waiting on
          it.
        </p>
      </div>
    );
  }

  /** Whether there is anything to spend on yet, which decides how loud this is. */
  const hasWork = view.myCurrentWork.placements.length > 0;

  /*
   * Typed in ordinary money, sent in cents.
   *
   * The two ceilings used to be typed *in cents*, which asked a person to do a
   * conversion in their head in the one box where being out by a factor of a
   * hundred is a spending limit. Nothing about the grant moved: the route still
   * takes cents, `checkCommercialAuthority` still decides, and the preview a
   * person approves is still the server's own sentences about the values that
   * actually arrive.
   */
  const committedCents = centsFromAmount(committed);
  const perActionCents = centsFromAmount(perAction);
  const concurrentCount = Number(concurrent);
  const numbers = {
    maxCommittedCents: committedCents ?? 0,
    maxPerActionCents: perActionCents ?? 0,
    maxConcurrent: concurrentCount,
  };
  const complete =
    committedCents !== null &&
    perActionCents !== null &&
    concurrent.trim().length > 0 &&
    Number.isInteger(concurrentCount) &&
    concurrentCount >= 1 &&
    actions.length > 0;

  async function run(what: 'preview' | 'approve'): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      if (what === 'preview') {
        setPreview((await CashApi.previewAuthority(projectId, { allowedActions: actions, ...numbers })).lines);
      } else {
        await CashApi.grantAuthority(projectId, { allowedActions: actions, ...numbers });
        onChanged();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-authority">
      <p className="rs-authority-headline">Spending limits &mdash; what Brain may spend here</p>
      <p className="rs-hint">
        These are <em>limits</em>, not a forecast and not a budget anybody expects to be used.
        Nothing is set aside, reserved or pre-paid by setting them; they are the ceiling every
        commitment is checked against. Nothing can be committed, quoted or collected until this
        exists, however good an opening is. Discovery keeps running meanwhile, and reading this
        card creates nothing.
      </p>

      {/*
        * The decision stays named; the form is what folds.
        *
        * With nothing in the portfolio yet, a set of empty ceiling boxes is the
        * largest thing on the screen and the least useful, which is what the
        * money picture above is actually for. §29's rule is that the approval a
        * project cannot proceed without is never folded away — so the headline,
        * the consequence and the control to open it are always visible, and
        * only the inputs start closed. Once there is something to spend on,
        * they start open.
        */}
      <details className="rs-cash-authority-details" open={hasWork}>
        <summary className="rs-linklike">
          {hasWork ? 'Set the limits' : 'Set the limits now, or leave it until there is an opening'}
        </summary>
        <label className="rs-field-label" htmlFor="cash-committed">
          Most that may be committed at once
        </label>
        <input
          id="cash-committed"
          inputMode="decimal"
          placeholder={`${view.myCash.position.currency} 1,000.00`}
          value={committed}
          onChange={(event) => {
            setCommitted(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          In ordinary {view.myCash.position.currency}, not cents. The total Brain may have held
          against openings at any one moment. Money released or settled stops counting against it.
        </p>
        <label className="rs-field-label" htmlFor="cash-per-action">
          Most in any single commitment
        </label>
        <input
          id="cash-per-action"
          inputMode="decimal"
          placeholder={`${view.myCash.position.currency} 250.00`}
          value={perAction}
          onChange={(event) => {
            setPerAction(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          The size of one commitment Brain may make without you. It is a per-item ceiling, not a
          share of the figure above.
        </p>
        <label className="rs-field-label" htmlFor="cash-concurrent">
          How many opportunities may be executing at once
        </label>
        <input
          id="cash-concurrent"
          inputMode="numeric"
          value={concurrent}
          onChange={(event) => {
            setConcurrent(event.target.value);
            setPreview(null);
          }}
        />
        <p className="rs-hint">
          This bounds what may be <em>executing</em>, which is real fulfilment capacity. It is not
          a limit on how many pieces the portfolio may hold.
        </p>
        {[committed, perAction].some((typed) => typed.trim().length > 0) &&
        (committedCents === null || perActionCents === null) ? (
          <p className="rs-state rs-state-error">
            Type an amount like 1000 or 1,000.50. Brain will not guess at an amount it cannot read.
          </p>
        ) : null}
        <fieldset>
          <legend className="rs-field-label">What it authorizes</legend>
          {view.vocabulary.commercialActions.map((action) => (
            <label key={action} className="rs-choice">
              <input
                type="checkbox"
                checked={actions.includes(action)}
                onChange={(event) => {
                  setActions((current) =>
                    event.target.checked
                      ? [...current, action]
                      : current.filter((entry) => entry !== action),
                  );
                  setPreview(null);
                }}
              />
              <span className="rs-choice-text">{action}</span>
            </label>
          ))}
        </fieldset>
      </details>

      <ul className="rs-authority-never">
        {view.vocabulary.neverAuthorizable.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      <p className="rs-item-meta">Those can never be authorized, by any grant, at any ceiling.</p>

      {preview ? (
        <>
          <p className="rs-authority-headline">This is what you would be approving</p>
          <ul className="rs-authority-list">
            {preview.map((line) => (
              <li key={line} className="rs-authority-limit">
                {line}
              </li>
            ))}
          </ul>
          <button type="button" className="rs-button" disabled={busy} onClick={() => void run('approve')}>
            {busy ? 'Approving\u2026' : 'Approve'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="rs-button"
          disabled={busy || !complete}
          onClick={() => void run('preview')}
        >
          Show me what this authorizes
        </button>
      )}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

/**
 * The money picture: what is *known*, and what the evidence cannot yet say.
 *
 * Two kinds of number and they are never shown alike. A **fact** is derived
 * from an append-only entry or from a limit a person set — authorized,
 * committed, spent, remaining — and zero is one of those: "nothing authorized"
 * is something Brain knows, not something it has failed to work out. A
 * **forecast** is arithmetic over evidence on opportunity cards, and where the
 * cards are blank it is withheld naming the blanks, rather than estimated.
 *
 * Nothing on this screen is computed here. Every figure comes down on the view;
 * a client deriving one would be a second opinion about one sprint.
 */
function MoneyPicture({ view }: { view: CashView }): JSX.Element {
  const currency = view.forecast.currency;
  const grant = view.authority;
  const remaining = Math.max(grant.maxCommittedCents - grant.committedCents, 0);

  const facts: { label: string; value: string; note: string }[] = [
    {
      label: 'Authorized',
      value: grant.exists ? money(grant.maxCommittedCents, currency) : money(0, currency),
      note: grant.exists
        ? 'The most that may be committed at once, which you set.'
        : 'No spending has been authorized here yet. Nothing can be committed until it is.',
    },
    {
      label: 'Committed',
      value: money(grant.committedCents, currency),
      note: 'Authorized and held against something, not yet spent.',
    },
    {
      label: 'Spent',
      value: money(grant.spentCents, currency),
      note: 'Money that has actually left the account.',
    },
    {
      label: 'Remaining authorized capacity',
      value: grant.exists ? money(remaining, currency) : money(0, currency),
      note: grant.exists
        ? 'What is left inside the limit you set, not a forecast of what will be used.'
        : 'There is no limit to have room inside yet.',
    },
  ];

  const estimates: {
    key: string;
    label: string;
    value: string | null;
    range: string | null;
    basis: string;
    unknown: string[];
    blocking: string;
    confidence: string;
    fromRows: number;
  }[] = [
    { key: 'upfront', label: 'Upfront cash needed', e: view.forecast.upfrontCash },
    { key: 'ongoing', label: 'Ongoing costs', e: view.forecast.ongoingCosts },
    { key: 'revenue', label: 'Revenue', e: view.forecast.revenue },
    { key: 'contribution', label: 'Profit contribution', e: view.forecast.contribution },
  ].map(({ key, label, e }) => ({
    key,
    label,
    value: e.valueCents === null ? null : money(e.valueCents, currency),
    range:
      e.lowCents === null || e.highCents === null || e.lowCents === e.highCents
        ? null
        : `${money(e.lowCents, currency)} to ${money(e.highCents, currency)}`,
    basis: e.basis,
    unknown: e.unknown,
    blocking: e.blocking,
    confidence: e.confidence,
    fromRows: e.fromRows,
  }));

  const durations: {
    key: string;
    label: string;
    value: string | null;
    range: string | null;
    basis: string;
    unknown: string[];
    blocking: string;
    confidence: string;
    fromRows: number;
  }[] = [
    { key: 'first-dollar', label: 'Time to the first dollar', d: view.forecast.timeToFirstDollar },
    { key: 'break-even', label: 'Time to break even', d: view.forecast.breakEven },
  ].map(({ key, label, d }) => ({
    key,
    label,
    value: d.days === null ? null : `${d.days} ${d.days === 1 ? 'day' : 'days'}`,
    range:
      d.lowDays === null || d.highDays === null || d.lowDays === d.highDays
        ? null
        : `${d.lowDays} to ${d.highDays} days`,
    basis: d.basis,
    unknown: d.unknown,
    blocking: d.blocking,
    confidence: d.confidence,
    fromRows: d.fromRows,
  }));

  const rows = [...estimates, ...durations];

  return (
    <section className="rs-card rs-cash-picture">
      <h3>The money picture</h3>

      <p className="rs-item-meta">
        These four are facts. They are what you authorized and what has actually moved.
      </p>
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            Authorized, committed, spent and remaining: figures Brain knows
          </caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col">Amount</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.label}>
                <th scope="row">{fact.label}</th>
                <td>{fact.value}</td>
                <td>{fact.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="rs-item-meta">
        These are estimates over the openings Brain has qualified &mdash;{' '}
        {view.forecast.qualified} of {view.forecast.considered}. An estimate is shown only where
        the evidence carries it; the rest say exactly what is still unknown.
      </p>
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            What the evidence supports estimating, and what it does not
          </caption>
          <thead>
            <tr>
              <th scope="col">Estimate</th>
              <th scope="col">Figure</th>
              <th scope="col">Range and confidence</th>
              <th scope="col">Where it comes from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.value ?? <span className="rs-item-meta">Not yet estimable</span>}</td>
                <td>
                  {row.value === null
                    ? '\u2014'
                    : `${row.range ?? 'No spread: one figure'} \u00b7 ${
                        row.confidence === 'SEVERAL_ROWS'
                          ? `from ${row.fromRows} openings`
                          : row.confidence === 'SINGLE_ROW'
                            ? 'from a single opening'
                            : 'no supporting rows'
                      }`}
                </td>
                <td>
                  {row.basis}
                  {row.value === null ? (
                    <>
                      {' '}
                      <strong>{row.blocking}</strong>
                      {row.unknown.length > 0 ? ` Still unknown: ${row.unknown.join(', ')}.` : ''}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.forecast.humanHours.total === null ? (
        <p className="rs-hint">
          Nobody has estimated the hours these openings would take.
          {view.forecast.humanHours.unknown.length > 0
            ? ` Still unknown: ${view.forecast.humanHours.unknown.join(', ')}.`
            : ''}
        </p>
      ) : (
        <p className="rs-hint">
          {view.forecast.humanHours.total} hours of your own work across{' '}
          {view.forecast.humanHours.fromRows}{' '}
          {view.forecast.humanHours.fromRows === 1 ? 'opening' : 'openings'}. Reported beside the
          money rather than inside it: no hourly rate has been set, so turning hours into a cost
          would be a number nobody chose.
        </p>
      )}
    </section>
  );
}

/** My cash: the six figures, kept apart, each labelled with what it means. */
function MyCash({ view }: { view: CashView }): JSX.Element {
  const p = view.myCash.position;
  const rows: { label: string; value: number; note: string }[] = [
    { label: 'Pipeline', value: p.pipelineCents, note: 'Agreed work. No cash received.' },
    {
      label: 'Customer payments',
      value: p.customerPaymentsCents,
      note: 'Verified, including what is still pending with the provider.',
    },
    {
      label: 'Available funds',
      value: p.availableFundsCents,
      note: 'Settled and usable through the verified route.',
    },
    {
      label: 'Unpaid commitments',
      value: p.unpaidCommitmentsCents,
      note: 'Delivery costs and supplier bills owed.',
    },
    {
      label: 'Held commitments',
      value: p.heldCommitmentsCents,
      note: 'Authorized and not yet spent.',
    },
    { label: 'Reserves', value: p.reservesCents, note: 'Protected cash: delivery, tax, operating.' },
    {
      label: 'Deployable',
      value: p.deployableCents,
      note: 'What can actually be committed to something new.',
    },
    {
      label: 'Completed contribution',
      value: p.completedContributionCents,
      note: 'Earned sales minus every incremental cost, before overhead and tax.',
    },
  ];

  return (
    <section className="rs-card rs-cash-money">
      <h3>Your cash</h3>
      {p.shortfall ? (
        <p className="rs-state rs-state-error">
          Deployable cash is negative. New discretionary commitments are refused until that is
          funded or something is released. Delivery on work already sold continues.
        </p>
      ) : null}
      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            The figures of this account, each kept separate
          </caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col">Amount</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{money(row.value, p.currency)}</td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.myCash.entries.length === 0 ? (
        <p className="rs-hint">No money has moved yet.</p>
      ) : (
        <ul className="rs-list">
          {view.myCash.entries.slice(0, 8).map(({ entry, effect }) => (
            <li key={entry.id} className="rs-row">
              <span className="rs-item-title">
                {entry.kind} {money(entry.amountCents, entry.currency)}
              </span>
              <span className="rs-item-meta">
                {effect} &middot; {entry.occurredAt}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * My current work: the assembled plan, not a ranked list to choose from.
 *
 * Every piece carries its disposition and the server's own sentence saying what
 * decided it, so "waiting" always names what it is waiting for.
 */
/**
 * Where this sprint stands, in one screen.
 *
 * Seven counts and two sentences, and every one of them is a row the server
 * already derived. It exists because the page had no such screen: a person
 * arriving at it met thirty-one raw signals and had to infer the state of the
 * machine from the length of a list.
 *
 * The tiers are the honest version of the number that used to be here. "31
 * openings" was one count over four different things — market evidence, a
 * capture thesis, a supported case, and something a test could actually be run
 * against — and calling all four an opening is the defect this whole change
 * is about.
 */
function Status({ page }: { page: CashPage }): JSX.Element {
  const frontier = page.frontier;
  const tiers = frontier.byTier;

  /*
   * The blocker, and only a real one.
   *
   * A decision the server marked BLOCKING is one nothing can proceed without.
   * Anything else — work in progress, a question Brain is out researching — is
   * not a blocker, and a screen that called it one would be asking somebody to
   * act on something that is already moving.
   *
   * A member has no decisions review at all — it is a list of things for one
   * person to answer — so the count is empty for them and the sentence below
   * says what is true of the frontier rather than pretending nothing is waiting
   * on anybody.
   */
  const blocking = (page.full?.decisionsForMe.items ?? []).filter(
    (item) => item.urgency === 'BLOCKING' || item.urgency === 'URGENT',
  );

  return (
    <section className="rs-card rs-cash-status">
      <h3>The cash machine</h3>
      {/*
        * Every figure here is the shared frontier's, for both roles. The tiers
        * are counted by the server from the same opportunities the list below
        * renders, so the summary and the list cannot disagree — and the owner
        * and a member are reading one set of numbers rather than two that
        * happen to match.
        */}
      <ul className="rs-cash-tiers">
        <li>
          <strong>
            {frontier.mode?.state === 'ACTIVE' ? 'Active' : (frontier.mode?.state ?? 'Not started')}
          </strong>
          <span>Discovery</span>
        </li>
        <li>
          <strong>{tiers.SIGNAL}</strong>
          <span>Signals found</span>
        </li>
        <li>
          <strong>{tiers.CANDIDATE}</strong>
          <span>Being qualified</span>
        </li>
        <li>
          <strong>{tiers.QUALIFIED}</strong>
          <span>Qualified</span>
        </li>
        <li>
          <strong>{tiers.READY_TO_TEST}</strong>
          <span>Ready to test</span>
        </li>
        <li>
          {/*
            * The raw states, not the availability words. `availability`
            * collapses DELIVERING into DELIVERED so a member cannot read how
            * far somebody else's job has got, which is right for *is this
            * taken* and wrong for *how many are executing*.
            */}
          <strong>{frontier.byState.EXECUTING + frontier.byState.DELIVERING}</strong>
          <span>Executing</span>
        </li>
        <li>
          <strong>{frontier.byState.COLLECTED}</strong>
          <span>Collected</span>
        </li>
      </ul>
      <p className="rs-decision-why">{frontier.roadmap.whatHappensNext}</p>
      {!page.capabilities.mayViewPrivateJob ? (
        <p className="rs-hint">
          This is the shared frontier: what Brain has found, and how far it has got. A signal is
          evidence Brain found and is still working out how money would be made from it; it is not
          work for you. Decisions about an execution job belong to whoever owns that job.
        </p>
      ) : blocking.length === 0 ? (
        <p className="rs-hint">
          Nothing is waiting on you. A signal is evidence Brain found and is still working out how
          money would be made from it; it is not work for you.
        </p>
      ) : (
        <p className="rs-hint">
          {blocking.length === 1
            ? 'One thing is waiting on you, below.'
            : `${blocking.length} things are waiting on you, below.`}
        </p>
      )}
    </section>
  );
}

const TIER_LABEL: Record<string, string> = {
  SIGNAL: 'Signal — evidence, not yet work',
  CANDIDATE: 'Being qualified',
  QUALIFIED: 'Qualified',
  READY_TO_TEST: 'Ready to test',
};

/**
 * What this person actually has to do, and what is genuinely held up.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * There was no such section. *Your current work* was the heading over the whole
 * portfolio, so in production it read `1 to act on now, 40 waiting` above a list
 * of thirty-one market observations — Rev and GoTranscript publishing different
 * transcription prices, WriterAccess and Verblio publishing different rates,
 * Adobe Stock and Depositphotos publishing different subscription tiers. Every
 * one of those is a real, gated, well-sourced finding, and not one of them says
 * anybody would pay us. Presenting them as a queue asked a person to work on a
 * market, and forty of them "waiting" made the one genuine item impossible to
 * find.
 *
 * ---------------------------------------------------------------------------
 * The rule, and where it is applied
 * ---------------------------------------------------------------------------
 *
 * The server decides. `isWorkable` in `services/cash/portfolio.ts` is the one
 * predicate, `assemble` puts each piece in exactly one list, and this renders
 * the two lists it is given. The client re-reads the disposition only to choose
 * between two headings, so a payload from before the split — a tab left open
 * across a deploy — still separates them rather than showing everything as
 * work.
 *
 * **The aggregate is absent when the work is.** `combinedContributionCents` is
 * null rather than zero over an empty list, and a null renders as no line at
 * all: a figure of zero reads as a measurement of an empty portfolio, and the
 * figure this replaced was the summed difference between other people's
 * published prices.
 */
function YourWork({ page, onChanged }: { page: CashPage; onChanged(): void }): JSX.Element {
  const view = page.full;
  const frontier = page.frontier;

  /*
   * A member has no private job, so they have no current work — and the
   * section still renders, saying that, because §36's parity rule is that a
   * permission decides what is *inside* a section and never which sections
   * exist. A heading that vanished for one reader would move every section
   * below it and make the two pages impossible to compare.
   */
  if (!view) {
    return (
      <section className="rs-card rs-cash-work">
        <h3>Your current work</h3>
        <p className="rs-hint">
          Work belongs to whoever owns an execution job, and none of it is sent to this page.{' '}
          {frontier.counts.beingQualified} {frontier.counts.beingQualified === 1 ? 'opening is' : 'openings are'}{' '}
          being qualified; what Brain has found is below.
        </p>
      </section>
    );
  }

  const work = view.myCurrentWork;
  const acting = work.executeNow;
  const held = work.waiting;
  const qualifying = work.beingQualified ?? [];
  const evidence = work.evidence ?? [];

  if (acting.length === 0 && held.length === 0) {
    return (
      <section className="rs-card rs-cash-work">
        <h3>Your current work</h3>
        <p className="rs-hint">
          Nothing is ready for you to act on, and nothing is waiting on you.
          {qualifying.length > 0
            ? ` Brain is qualifying ${qualifying.length} ${qualifying.length === 1 ? 'opening' : 'openings'} — establishing the payer, the price and the exposure before any of them is a decision.`
            : ''}
          {evidence.length > 0
            ? ` ${evidence.length} further ${evidence.length === 1 ? 'record is' : 'records are'} evidence about a market: Brain found ${evidence.length === 1 ? 'it' : 'them'} and cannot yet say how we would be paid from ${evidence.length === 1 ? 'it' : 'them'}.`
            : ''}
        </p>
      </section>
    );
  }

  return (
    <section className="rs-card rs-cash-work">
      <h3>Your current work</h3>
      <p className="rs-item-meta">
        {acting.length} to act on now, {held.length} waiting.
        {/* Only where there is work to total. Null is not zero. */}
        {work.combinedContributionCents !== null && work.combinedContributionCents !== undefined
          ? ` Combined conservative contribution: ${money(
              work.combinedContributionCents,
              view.myCash.position.currency,
            )} — an arithmetic illustration from quoted prices, not a bank balance.`
          : ''}
      </p>
      <ul className="rs-list">
        {[...acting, ...held].map((placement) => (
          <li key={placement.opportunity.id} className="rs-group">
            <p className="rs-item-title">{placement.opportunity.title}</p>
            <p className="rs-badge">
              {WORK_DISPOSITIONS.has(placement.disposition)
                ? DISPOSITION_LABEL[placement.disposition]
                : DISPOSITION_LABEL.EVIDENCE_ONLY}
            </p>
            <p className="rs-decision-why">{placement.because}</p>
            {placement.opportunity.nextAction ? (
              <p className="rs-item-meta">{placement.opportunity.nextAction}</p>
            ) : null}
            {page.capabilities.mayActOnJob ? (
              <Actions
                placement={placement}
                allowedActions={view.authority.allowedActions}
                onChanged={onChanged}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The few worth putting in front of somebody, and nothing else.
 *
 * Qualified first; where there are none, the candidates with the fewest
 * questions left, said plainly to be that. It is never filled up with signals,
 * which is the whole correction: a best-opportunities section padded with a
 * vendor's published price list is worse than an empty one, because the empty
 * one is true.
 *
 * The full portfolio is not hidden — it is under *Everything Brain has found*,
 * with every claim, source and packet on it.
 */
function BestOpportunities({
  page,
  onChanged,
}: {
  page: CashPage;
  onChanged(): void;
}): JSX.Element {
  const view = page.full;
  /*
   * The same openings, chosen by the same rule, for both roles.
   *
   * `frontier.best` is picked server-side by `chooseBest`, which is the very
   * function the owner's `assemble` calls, over tiers derived by the one
   * `cashTier`. So this section names the same pieces in the same order
   * whoever is reading — rather than two client branches that agree until one
   * of them is edited.
   */
  const best = page.frontier.best;
  const byTier = page.frontier.byTier;

  return (
    <section className="rs-card rs-cash-best">
      <h3>Best opportunities</h3>
      {best.length === 0 ? (
        <p className="rs-hint">
          Nothing is qualified yet, and nothing is being padded out to fill this space.{' '}
          {byTier.CANDIDATE > 0
            ? `${byTier.CANDIDATE} ${byTier.CANDIDATE === 1 ? 'idea has' : 'ideas have'} a capture thesis and ${byTier.CANDIDATE === 1 ? 'is' : 'are'} being qualified.`
            : `Brain is working out how money would be made from ${byTier.SIGNAL} ${byTier.SIGNAL === 1 ? 'signal' : 'signals'} it has found.`}
        </p>
      ) : (
        <>
          {page.frontier.bestAreNearlyQualified ? (
            <p className="rs-hint">
              None of these is qualified yet. They are the ones closest to it, with the fewest
              questions left.
            </p>
          ) : null}
          <ul className="rs-list">
            {best.map((one) => {
              const tier = one.tier;
              /*
                * The owner's placement for the same piece, where there is one.
                *
                * It carries the *disposition* — execute now, wait on a named
                * dependency, test a decisive unknown — which is a recommendation
                * to whoever owns the job rather than a fact about the frontier,
                * and composing it needs the deployable balance. So a member sees
                * the piece and what is holding it, and not what somebody should
                * do about it.
                */
              const placement = view?.myCurrentWork.placements.find(
                (p) => p.opportunity.id === one.id,
              );
              return (
                <li key={one.id} className="rs-group">
                  <p className="rs-item-title">{one.title}</p>
                  <p className="rs-badge">{TIER_LABEL[tier.tier] ?? tier.tier}</p>
                  <p className="rs-decision-why">{tier.summary}</p>
                  <p className="rs-item-meta">
                    {tier.answered} of {tier.required} decision questions answered.
                    {placement
                      ? ` Next: ${DISPOSITION_LABEL[placement.disposition]} \u2014 ${placement.because}`
                      : ` ${one.because}`}
                  </p>
                  {tier.toAdvance.length > 0 ? (
                    <p className="rs-item-meta">
                      Brain is establishing:{' '}
                      {tier.toAdvance
                        .slice(0, 4)
                        .map((entry) => entry.label.toLowerCase())
                        .join(', ')}
                      {tier.toAdvance.length > 4 ? `, and ${tier.toAdvance.length - 4} more` : ''}.
                    </p>
                  ) : null}
                  {/*
                    * The decision brief and the controls are the job's, so they
                    * render only where the payload carries them. The section,
                    * its heading, its identifier and every piece above are the
                    * same for both roles — which is requirement 2's line: a
                    * permission changes what is inside a section, never which
                    * sections there are.
                    */}
                  {view && page.capabilities.mayViewPrivateJob ? (
                    <EngineCard
                      opportunityId={one.id}
                      card={view.myCurrentWork.engineCards?.[one.id]}
                      economics={view.myCurrentWork.economics?.[one.id] ?? []}
                      onChanged={onChanged}
                    />
                  ) : null}
                  {view && placement && page.capabilities.mayActOnJob ? (
                    <Actions
                      placement={placement}
                      allowedActions={view.authority.allowedActions}
                      onChanged={onChanged}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The money, in one row.
 *
 * Four figures and a disclosure. The detailed authority form is real and is
 * still here; what changed is that it is no longer the second thing on the
 * page on a sprint where nothing is qualified yet, because a screen that leads
 * with *set a spending limit* implies discovery is waiting on one. It is not:
 * §33's discovery authorization is what pressing Start gave, and this grant is
 * for an entirely different thing.
 */
function MoneyRow({ page }: { page: CashPage }): JSX.Element {
  const view = page.full;
  const qualified = page.frontier.byTier.QUALIFIED + page.frontier.byTier.READY_TO_TEST;
  const grantIsLive =
    view?.authority.exists ?? page.frontier.commercialGrant === 'PRESENT';

  /*
   * The figures are the job's; the *sentence* is the frontier's.
   *
   * Whether a commercial grant exists at all is shared, and deliberately so:
   * it is the reason nothing in the portfolio is executing, and a member
   * looking at a long list of open pieces is owed that answer. Its ceilings,
   * what has been committed and what has been spent are not, so a member sees
   * the section, the heading and the explanation with no numbers in it — which
   * is a permission changing what is inside a section rather than which
   * sections there are.
   */
  return (
    <section className="rs-card rs-cash-money-row">
      <h3>Money</h3>
      {view ? (
        <ul className="rs-cash-tiers">
          <li>
            <strong>{money(view.authority.maxCommittedCents, view.myCash.position.currency)}</strong>
            <span>Authorized</span>
          </li>
          <li>
            <strong>{money(view.authority.committedCents, view.myCash.position.currency)}</strong>
            <span>Committed</span>
          </li>
          <li>
            <strong>{money(view.authority.spentCents, view.myCash.position.currency)}</strong>
            <span>Spent</span>
          </li>
          <li>
            <strong>
              {money(view.myCash.position.deployableCents, view.myCash.position.currency)}
            </strong>
            <span>Remaining capacity</span>
          </li>
        </ul>
      ) : (
        <p className="rs-hint">
          The money belongs to whoever owns an execution job, and no figure of it is sent to this
          page &mdash; not a balance, not a ceiling, not what has been spent.
        </p>
      )}
      <p className="rs-hint">
        {grantIsLive
          ? 'A standing commercial authority is live. It bounds what may be committed; it commits nothing.'
          : qualified > 0
            ? 'Nothing is authorized to be spent. Something is qualified now, so this is the decision it is waiting on.'
            : 'Nothing is authorized to be spent, and nothing needs it yet. Discovery and qualification cost nothing and are not waiting on this.'}
      </p>
    </section>
  );
}

/**
 * Everything else, complete and one click away.
 *
 * §29's rule about `/legacy` applied inside a page: nothing is deleted and
 * nothing is hidden, it stops being the first thing. Each disclosure carries
 * its own count in the summary, so a person can tell whether opening it is
 * worth it without opening it.
 */
function Details({ page, onChanged }: { page: CashPage; onChanged(): void }): JSX.Element {
  const view = page.full;
  const frontier = page.frontier;

  /*
   * All five disclosures exist for both roles, in one order.
   *
   * Dropping one for a member would take its heading and its identifier off the
   * page and move every section after it, which is the divergence this change
   * exists to remove. So the money disclosure is here for a member too, saying
   * what is true — that the figures belong to whoever owns a job and are not
   * sent — rather than vanishing and leaving them to wonder whether Cash has a
   * money section at all.
   */
  return (
    <>
      <details className="rs-card rs-cash-portfolio">
        <summary>
          <h3>Everything Brain has found</h3>
          <span className="rs-hint">
            {frontier.opportunities.length}{' '}
            {frontier.opportunities.length === 1 ? 'record' : 'records'}, with their claims and
            sources
          </span>
        </summary>
        <Portfolio page={page} onChanged={onChanged} />
      </details>
      <details className="rs-card rs-cash-needs-detail">
        <summary>
          <h3>What Brain is working on</h3>
          <span className="rs-hint">
            {frontier.needs.length} open {frontier.needs.length === 1 ? 'question' : 'questions'} in
            Brain&rsquo;s own queue
          </span>
        </summary>
        <p className="rs-hint">
          These are facts about the world, so Brain looks them up. None of them is a task for you.
        </p>
        <Needs page={page} />
      </details>
      <details className="rs-card rs-cash-research">
        <summary>
          <h3>Research detail</h3>
          <span className="rs-hint">
            {frontier.roadmap.rounds.total} discovery{' '}
            {frontier.roadmap.rounds.total === 1 ? 'round' : 'rounds'},{' '}
            {frontier.roadmap.research.planned} planned items
          </span>
        </summary>
        <Roadmap roadmap={frontier.roadmap} discoveryReason={frontier.discovery.reason} />
      </details>
      <details className="rs-card rs-cash-money-detail">
        <summary>
          <h3>Money detail and the spending authority</h3>
          <span className="rs-hint">
            {view
              ? `${view.myCash.entries.length} recorded ${
                  view.myCash.entries.length === 1 ? 'entry' : 'entries'
                } \u00b7 ${view.authority.exists ? 'a grant is live' : 'no grant'}`
              : frontier.commercialGrant === 'PRESENT'
                ? 'A grant is live. Its limits and the ledger belong to the job.'
                : 'No grant. The ledger belongs to the job.'}
          </span>
        </summary>
        {view ? (
          <>
            <MoneyPicture view={view} />
            <MyCash view={view} />
          </>
        ) : (
          <p className="rs-hint">
            Whether a commercial grant exists is shared, because it is why nothing here is
            executing. Its ceilings, what has been committed, what has been spent and every entry in
            the ledger belong to whoever owns the job, and none of it is sent to this page.
          </p>
        )}
      </details>
      <details className="rs-card rs-cash-history">
        <summary>
          <h3>Activity</h3>
          <span className="rs-hint">
            {view
              ? `${view.whatBrainHasDone.length} recent ${
                  view.whatBrainHasDone.length === 1 ? 'event' : 'events'
                }`
              : `${frontier.activity.reduce((total, one) => total + one.count, 0)} events in ${
                  frontier.activity.length
                } ${frontier.activity.length === 1 ? 'kind' : 'kinds'}`}
          </span>
        </summary>
        <Done page={page} />
      </details>
    </>
  );
}

function Portfolio({
  page,
  onChanged,
}: {
  page: CashPage;
  onChanged(): void;
}): JSX.Element {
  const view = page.full;
  const frontier = page.frontier;

  /*
   * One list, in one order, for both roles.
   *
   * The records are the frontier's — already `rank`-ordered by the server, the
   * same ranking the owner's placements carry, because `rank` reads properties
   * of the piece rather than of the account. What an owner additionally sees on
   * each row is the disposition, the decision brief and the controls; what
   * nobody sees here is a figure a member is not entitled to, because the
   * figures are not in their payload at all.
   */
  /*
   * `rs-cash-portfolio-body`, not `rs-cash-portfolio`.
   *
   * The disclosure around this already carries that identifier, and two nested
   * elements sharing one name make `querySelector` answer whichever comes
   * first — which is a structural problem rather than a style one: a parity
   * check reading the section tree would have been comparing an ambiguous
   * name. The stylesheet targets `.rs-cash-portfolio .rs-group`, so the
   * descendant rules still apply from the disclosure. The same is true of
   * `rs-cash-history-body` below.
   */
  return (
    <section className="rs-card rs-cash-portfolio-body">
      {/*
        * The heading says what this list is, and it used to say the opposite.
        *
        * It read *Your current work* over every record in the portfolio —
        * thirty-one of which were market evidence — with a combined
        * contribution summed across all of them. A person reading that was
        * being told that a published price list was theirs to act on and that
        * the difference between two vendors' prices was money this sprint
        * would make. Work has its own section now, above; this is the archive
        * it is drawn from, and it says so.
        */}
      <h3>Everything in the portfolio</h3>
      {frontier.opportunities.length === 0 ? (
        <p className="rs-hint">Nothing in the portfolio yet. {frontier.discovery.reason}</p>
      ) : (
        <>
          {view ? (
            <p className="rs-item-meta">
              {view.myCurrentWork.byTier
                ? `${view.myCurrentWork.byTier.QUALIFIED + view.myCurrentWork.byTier.READY_TO_TEST} qualified, ` +
                  `${view.myCurrentWork.byTier.CANDIDATE} being qualified, ` +
                  `${view.myCurrentWork.byTier.SIGNAL} evidence.`
                : `${frontier.opportunities.length} records.`}{' '}
              Everything Brain has found, in rank order, with its claim and its source. Evidence is
              here because it is worth keeping, not because it is worth doing.
            </p>
          ) : (
            <p className="rs-item-meta">
              {frontier.counts.open} open, {frontier.counts.beingQualified} being qualified,{' '}
              {frontier.counts.claimed + frontier.counts.inExecution} taken. What each piece would
              earn belongs to whoever takes it on.
            </p>
          )}
          <ul className="rs-list">
            {frontier.opportunities.map((one) => {
              const placement = view?.myCurrentWork.placements.find(
                (p) => p.opportunity.id === one.id,
              );
              return (
                <li key={one.id} className="rs-group">
                  <p className="rs-item-title">{one.title}</p>
                  <p className="rs-badge">
                    {placement
                      ? DISPOSITION_LABEL[placement.disposition]
                      : (TIER_LABEL[one.tier.tier] ?? one.tier.tier)}
                  </p>
                  <p className="rs-decision-why">{placement ? placement.because : one.because}</p>
                  {placement?.opportunity.exhaustedAt ? (
                    <p className="rs-item-meta">
                      This opening is finished: {placement.opportunity.exhaustedReason}. Whatever it
                      earned still counts.
                    </p>
                  ) : null}
                  {/*
                    * The publisher's own dated signal and the claim it resolves
                    * to, for both roles. It is accepted evidence carrying a
                    * source and a passage, so a member can check it rather than
                    * take Brain's word for it — §10 at a new reader.
                    */}
                  {one.buyingSignal ? (
                    <p className="rs-item-meta">
                      {one.buyingSignal}
                      {one.signalObservedAt
                        ? ` \u00b7 observed ${new Date(one.signalObservedAt).toLocaleDateString()}`
                        : ''}
                      {one.sourceClaimId ? ` \u00b7 claim ${one.sourceClaimId}` : ''}
                    </p>
                  ) : null}
                  {/*
                    * Optional access on purpose.
                    *
                    * The server always sends both, but a deploy replaces the
                    * server and the browser tab separately — so for the minutes
                    * between, a client built after the field existed can be
                    * holding a view fetched before it did. Rendering nothing is
                    * the right answer there; throwing would take the whole
                    * portfolio down over a card.
                    */}
                  {view && page.capabilities.mayViewPrivateJob ? (
                    <EngineCard
                      opportunityId={one.id}
                      card={view.myCurrentWork.engineCards?.[one.id]}
                      economics={view.myCurrentWork.economics?.[one.id] ?? []}
                      onChanged={onChanged}
                    />
                  ) : null}
                  {view && placement && page.capabilities.mayActOnJob ? (
                    <Actions
                      placement={placement}
                      allowedActions={view.authority.allowedActions}
                      onChanged={onChanged}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * What a person needs before deciding, and where each answer came from.
 *
 * The server composes this; nothing is derived here. Each line says which of
 * four things its answer is, and the four are rendered differently on purpose:
 * a gated claim carries the id it resolves to, an estimate carries its basis
 * and what would change it and is labelled a proposal, a person's decision says
 * so, and an unknown shows the task that would answer it rather than a blank.
 *
 * Rendering an estimate the way a fact is rendered would tell somebody a guess
 * was checked, which is the one thing this section may not do.
 */
const ENGINE_KIND_LABEL: Record<string, string> = {
  FACT: 'from a source',
  ESTIMATE: "Brain's proposal",
  DECISION: 'your decision',
  UNKNOWN: 'not known yet',
};

function EngineCard({
  opportunityId,
  card,
  economics,
  onChanged,
}: {
  opportunityId: string;
  card: EngineCardView | undefined;
  economics: DerivedFigureView[];
  onChanged(): void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!card) return null;

  const answered = card.entries.filter((entry) => entry.value !== null);
  const unknown = card.entries.filter((entry) => entry.value === null);

  return (
    <div className="rs-cash-engine">
      <button type="button" className="rs-link-button" onClick={() => setOpen(!open)}>
        {open ? 'Hide the full card' : 'Show the full card'} &mdash; {answered.length} answered,{' '}
        {unknown.length} still unknown
        {card.validationState ? ` · deep dive ${card.validationState}` : ' · no deep dive yet'}
      </button>
      {note ? <p className="rs-hint">{note}</p> : null}
      {open ? (
        <>
          <ul className="rs-list rs-sublist">
            {card.entries.map((entry) => (
              <li key={entry.key}>
                <p className="rs-item-title">
                  {entry.label} <span className="rs-badge">{ENGINE_KIND_LABEL[entry.kind]}</span>
                </p>
                {entry.value === null ? (
                  <>
                    <p className="rs-item-meta">{entry.task}</p>
                    {/*
                      * A person answers a question that is *theirs*, and no
                      * card field is.
                      *
                      * This rendered a text box and a **Confirm** under every
                      * blank on the card, because the entry carried no owner
                      * and the screen had nothing to decide on. So the payer,
                      * the price, the delivery method, the economics and the
                      * contact channel — every one of them a fact about the
                      * world that §33's `owner` correction had already given
                      * to Brain — asked the person to type one in, and
                      * `fillCard` recorded whatever they typed as a `PERSON`
                      * fact that `mayReplace` then keeps above anything Brain
                      * later establishes. A blank is Brain's work, and its
                      * task is printed above; what is gone is the box.
                      *
                      * `fieldOwner` decides, on the server, and is carried
                      * down on the entry. `PERSON_ONLY` is the whole of what
                      * this renders for — today that is nothing, which is the
                      * correct reading of a card whose every field is a fact
                      * or a proposal rather than a decision, and the control
                      * appears by itself if one is ever added.
                      */}
                    {entry.owner === 'PERSON_ONLY' && answering === entry.key ? (
                      <>
                        <label
                          className="rs-field-label"
                          htmlFor={`cash-engine-${opportunityId}-${entry.key}`}
                        >
                          {entry.label}
                        </label>
                        <input
                          id={`cash-engine-${opportunityId}-${entry.key}`}
                          value={said}
                          onChange={(event) => setSaid(event.target.value)}
                        />
                        <button
                          type="button"
                          className="rs-button-quiet"
                          disabled={busy || said.trim().length === 0}
                          onClick={() => {
                            setBusy(true);
                            setNote(null);
                            const key = CARD_PATCH_KEY[entry.key] ?? entry.key;
                            void CashApi.fillCard(opportunityId, { [key]: said.trim() })
                              .then(() => {
                                setNote(
                                  'Answered. It is yours now, so Brain will not propose over it.',
                                );
                                setAnswering(null);
                                setSaid('');
                                onChanged();
                              })
                              .catch((error: unknown) => {
                                setNote(error instanceof Error ? error.message : 'That did not save.');
                              })
                              .finally(() => setBusy(false));
                          }}
                        >
                          {busy ? 'Saving\u2026' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          className="rs-linklike"
                          onClick={() => setAnswering(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : entry.owner === 'PERSON_ONLY' ? (
                      <button
                        type="button"
                        className="rs-linklike"
                        onClick={() => {
                          setAnswering(entry.key);
                          setSaid('');
                          setNote(null);
                        }}
                      >
                        Answer the {entry.label.toLowerCase()}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <p className="rs-decision-why">{entry.value}</p>
                )}
                {entry.claimId ? (
                  <p className="rs-item-meta">Resolves to claim {entry.claimId}.</p>
                ) : null}
                {entry.kind === 'ESTIMATE' ? (
                  <p className="rs-item-meta">
                    Basis: {entry.basis ?? '\u2014'} · Assumes: {entry.assumptions ?? '\u2014'} ·
                    Would change if: {entry.uncertainty ?? '\u2014'}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {economics.length > 0 ? (
            <ul className="rs-list rs-sublist">
              {economics.map((figure) => (
                <li key={figure.key}>
                  <p className="rs-item-title">{figure.label}</p>
                  <p className="rs-item-meta">{figure.formula}</p>
                  {figure.value ? (
                    <p className="rs-decision-why">{figure.value}</p>
                  ) : (
                    <p className="rs-item-meta">Withheld: {figure.withheld}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The transitions this piece actually has, from its own state.
 *
 * A transition that needs a reason reveals a field for it rather than opening a
 * browser dialog: a dialog cannot be read by the page that explains what the
 * choice does, cannot be styled to the 44px target the rest of the shell keeps,
 * and on a phone covers the thing it is asking about.
 */
function Actions({
  placement,
  allowedActions,
  onChanged,
}: {
  placement: Placement;
  allowedActions: string[];
  onChanged(): void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [performed, setPerformed] = useState(allowedActions[0] ?? 'CONTACT_BUYER');
  const state = placement.opportunity.state;

  /*
   * `asks` says what the server needs before this transition is true.
   *
   * `REASON` is a sentence kept on the record. `ACTION` is the correction §3
   * asked for: executing means the transaction is being pursued, so the call
   * has to say what was actually done, and the control asks rather than
   * pressing a button that writes the state anyway.
   */
  const available: { action: string; label: string; asks?: 'REASON' | 'ACTION' }[] = [];
  if (state === 'DISCOVERED' || state === 'EVIDENCE_CARD') {
    /*
     * *Mark ready to test* is offered only where it could succeed.
     *
     * `markReady` refuses while a load-bearing field is unknown, and on a
     * piece that is still evidence every one of them is. So the button was a
     * control that could never work, on thirty-one records at once — and
     * §35's rule is the opposite: a control that cannot succeed should not be
     * offered, because a refusal somebody could not have predicted teaches
     * them the refusal is arbitrary. Nothing about the server's own check
     * moved; this stops asking it a question whose answer is already known.
     *
     * *Pass on this* stays for every piece. Saying a thing is not worth
     * keeping is a decision about what to want, and it is available whatever
     * the evidence says.
     */
    const tier = placement.tier?.tier;
    if (tier === 'QUALIFIED' || tier === 'READY_TO_TEST') {
      available.push({ action: 'ready', label: 'Mark ready to test' });
    }
    available.push({ action: 'decline', label: 'Pass on this', asks: 'REASON' });
  }
  if (state === 'READY') {
    available.push({ action: 'execute', label: 'Record the first move', asks: 'ACTION' });
  }
  if (state === 'EXECUTING') available.push({ action: 'deliver', label: 'Delivering' });
  if (state === 'EXECUTING' || state === 'DELIVERING') {
    available.push({ action: 'collect', label: 'Money is in' });
  }
  if (available.length === 0) return null;

  const asks = available.find((entry) => entry.action === asking)?.asks ?? null;

  async function run(action: string, body: Record<string, unknown> = {}): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await CashApi.act(placement.opportunity.id, action, body);
      setAsking(null);
      setReason('');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rs-cash-actions">
      {available.map((entry) => (
        <button
          key={entry.action}
          type="button"
          className="rs-button-quiet"
          disabled={busy}
          onClick={() => (entry.asks ? setAsking(entry.action) : void run(entry.action))}
        >
          {entry.label}
        </button>
      ))}
      {asks === 'REASON' && asking ? (
        <>
          <label className="rs-field-label" htmlFor={`cash-reason-${placement.opportunity.id}`}>
            Why? It is kept on the record, and it is what an offer to somebody else says.
          </label>
          <input
            id={`cash-reason-${placement.opportunity.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void run(asking, { reason })}
          >
            Confirm
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </>
      ) : null}
      {asks === 'ACTION' && asking ? (
        <>
          {/*
            * A person-only control, so it says what the answer authorizes.
            *
            * This is a genuine one — recording a commercial action somebody
            * actually performed, chosen from the closed set their standing
            * grant permits — and it is the *only* control on this page that
            * asks a person what happened. It shared its opening words with
            * the need form that is now gone, which made two different things
            * look like one generic *"what did you do"* box, and the generic
            * one was the one that should never have existed.
            */}
          <p className="rs-hint">
            You are recording an action you have already taken, under the spending limits you
            granted. Brain performs nothing here: this writes the action to the record and moves
            this piece to executing, so the plan stops counting it as waiting.
          </p>
          <label className="rs-field-label" htmlFor={`cash-did-${placement.opportunity.id}`}>
            Which action did you take? Only what your standing authority permits is listed.
          </label>
          <select
            id={`cash-did-${placement.opportunity.id}`}
            value={performed}
            onChange={(event) => setPerformed(event.target.value)}
          >
            {(allowedActions.length > 0 ? allowedActions : ['CONTACT_BUYER']).map((one) => (
              <option key={one} value={one}>
                {one.toLowerCase().replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <label className="rs-field-label" htmlFor={`cash-detail-${placement.opportunity.id}`}>
            Who you contacted or what you sent, and any reference it has outside Brain. This is
            the record of the action, not a description of work Brain should do.
          </label>
          <input
            id={`cash-detail-${placement.opportunity.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void run(asking, { action: performed, detail: reason })}
          >
            Confirm
          </button>
          <button type="button" className="rs-linklike" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </>
      ) : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
    </div>
  );
}

/** What Brain needs: a blocked action with a recommended way forward. */
function Needs({ page }: { page: CashPage }): JSX.Element {
  const view = page.full;
  const needs = page.frontier.needs;

  /*
   * The need, its reason and its remedy are the frontier's — a capability gap
   * is a fact about what Brain cannot currently do, and every member is owed
   * it. What is the owner's is `setupEffort`, which is a **cost**, so it
   * renders only where the payload carries one.
   */
  return (
    <section className="rs-card rs-cash-needs">
      <h3>What Brain needs</h3>
      {needs.length === 0 ? (
        <p className="rs-hint">Nothing is missing that Brain knows about.</p>
      ) : (
        <ul className="rs-list">
          {needs.map((need) => {
            /*
              * The owner's own row for the same need, where there is one.
              *
              * The need, its reason and its remedy are the **frontier's** — a
              * capability gap is a fact about what Brain cannot currently do,
              * and every member is owed it. Two fields are not on the shared
              * projection and are read from here instead: `setupEffort`, which
              * is a cost, and `researchStatus`, which is the sentence
              * `assessResearch` derives about why the looking-up has not
              * happened. Neither is added to the shared payload — that
              * projection is built from the columns it names, and widening it
              * is a separate decision with its own argument.
              */
            const mine = view?.whatBrainNeeds.find((one) => one.id === need.id);
            return (
              <li key={need.id} className="rs-group">
                <p className="rs-item-title">{need.blockedAction}</p>
                <p className="rs-decision-why">{need.whyItMatters}</p>
                <p className="rs-decision-what">{need.recommendedPath}</p>
                <p className="rs-item-meta">
                  {mine ? `${mine.setupEffort} \u00b7 ` : ''}next step: {need.nextStep}
                </p>
                {/*
                  * Where the research got to, when it did not get there.
                  *
                  * The server derives it and sends `null` for a need whose
                  * research is simply running — so the absence of this line is
                  * *in progress*, and a line saying so under work in progress
                  * would tell a reader nothing they cannot already see.
                  *
                  * It used to be the explanation on a decision card asking the
                  * person to mark the need done. The card is gone; the sentence
                  * is the half of it that was worth keeping, and it belongs
                  * here, under Brain's work, where it answers the only question
                  * a reader of this list has.
                  */}
                {mine && mine.researchStatus !== null ? (
                  <p className="rs-item-meta">{mine.researchStatus}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="rs-hint">
        An open need never stops unrelated work. Everything Brain can do without it carries on.
      </p>
    </section>
  );
}

/**
 * Where the research is up to.
 *
 * Above the activity log and deliberately separate from it. The log answers
 * *what happened* — a stream of event codes, newest first — and reading it for
 * progress is what left a person watching `CASH_DISCOVERY_OPENED` scroll past
 * with no idea whether that was one of three things or one of thirty. This
 * answers *where is this up to*, and every number on it is a count the server
 * took over rows that already existed.
 *
 * **Every denominator here is the plan's own.** A round's planned count is how
 * many fragments its mission actually holds. There is no target in this file,
 * and no completion percentage over discovery as a whole: discovery is
 * open-ended by mandate, so a percentage of it would be a fraction of a number
 * nobody knows. A *round* is bounded, so a round is what carries a fraction.
 *
 * It renders a projection and presses nothing. There is no control on it.
 */
function Roadmap({
  roadmap,
  discoveryReason,
}: {
  roadmap: CashRoadmap;
  discoveryReason: string;
}): JSX.Element {
  /*
   * Takes the roadmap rather than a view, because it is **identical** for both
   * roles: `CashRoadmap` is carried whole on the shared frontier, so there is
   * nothing here for a permission to change and no reason for this component to
   * know who is reading.
   */
  const map = roadmap;
  const research = map.research;
  const queued = research.byStatus.PLANNED + research.byStatus.QUEUED;
  const running = research.byStatus.RUNNING + research.byStatus.VALIDATING;
  /*
   * Every status is on the screen, so the rows sum to the plan.
   *
   * A table that showed five of nine statuses would be a denominator that does
   * not add up, and the missing four are exactly the ones a person needs to see:
   * stopped work, and work that stopped for them.
   */
  const stopped = research.byStatus.CANCELLED + research.byStatus.NEEDS_HUMAN;

  return (
    <section className="rs-card rs-cash-roadmap">
      <h3>What Brain is researching</h3>
      {/*
        * `whatHappensNext` is on the status screen above, and only there.
        *
        * It was here too, which put the server's one sentence about where the
        * sprint is on the page twice — and the second copy was inside a
        * disclosure, so a person could read it, open this, and read it again.
        * One fact, one place.
        */}

      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            The research plan of the rounds that are open, counted from the plan itself
          </caption>
          <thead>
            <tr>
              <th scope="col">Research</th>
              <th scope="col">How many</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Planned in the open rounds</th>
              <td>{research.planned}</td>
            </tr>
            <tr>
              <th scope="row">Waiting to start</th>
              <td>{queued}</td>
            </tr>
            <tr>
              <th scope="row">Being researched now</th>
              <td>{running}</td>
            </tr>
            <tr>
              <th scope="row">Finished and accepted</th>
              <td>{research.byStatus.ACCEPTED}</td>
            </tr>
            <tr>
              <th scope="row">Rejected at the evidence gate</th>
              <td>{research.byStatus.REJECTED}</td>
            </tr>
            <tr>
              <th scope="row">Blocked</th>
              <td>{research.byStatus.BLOCKED}</td>
            </tr>
            <tr>
              <th scope="row">Stopped, or waiting on a person</th>
              <td>{stopped}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="rs-item-meta">
        {map.rounds.open} {map.rounds.open === 1 ? 'round' : 'rounds'} open of {map.rounds.total}{' '}
        opened so far ({map.rounds.harvested} harvested, {map.rounds.abandoned} abandoned), across{' '}
        {map.mechanisms.length} {map.mechanisms.length === 1 ? 'way' : 'ways'} of earning.
      </p>

      {map.active.length === 0 ? (
        <p className="rs-hint">No round is open right now. {discoveryReason}</p>
      ) : (
        <ul className="rs-list">
          {map.active.map((round) => (
            <li key={round.roundId} className="rs-row">
              <span className="rs-item-title">
                {round.mechanism} &mdash; round {round.round}
              </span>
              <span className="rs-item-meta" title={`${round.bucketId} \u00b7 ${round.roundId}`}>
                {ROUND_ACTIVITY[round.activity]}
                {' \u00b7 '}
                {round.plan
                  ? `${round.plan.byStatus.ACCEPTED} of ${round.plan.planned} research items done`
                  : 'no research planned yet'}
                {' \u00b7 '}
                {round.found === null
                  ? 'openings not counted yet'
                  : `${round.found} ${round.found === 1 ? 'opening' : 'openings'} found`}
                {' \u00b7 '}
                opened {round.openedAt}
              </span>
              {/*
                * Why it is not moving, in the words of whatever stopped it.
                *
                * A round reads OPEN until it is harvested, so a parked one used
                * to show as research under way with nothing behind it — which
                * is what every round of the live sprint looked like while all
                * ten candidates were parked and no work item existed anywhere.
                */}
              {round.blocker ? (
                <p className="rs-item-meta">Not moving: {round.blocker}</p>
              ) : null}
              {round.plan && round.plan.inFlight.length > 0 ? (
                <ul className="rs-list rs-sublist">
                  {round.plan.inFlight.map((question) => (
                    <li key={question} className="rs-item-meta">
                      {question}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="rs-table-wrap">
        <table>
          <caption className="rs-visually-hidden">
            What discovery has produced, counted by the state each piece is in
          </caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">How many</th>
              <th scope="col">What it means</th>
            </tr>
          </thead>
          <tbody>
            {map.pipeline.map((stage) => (
              <tr key={stage.key}>
                <th scope="row">{stage.label}</th>
                <td>{stage.count}</td>
                <td>{stage.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * An event code, in the words somebody reads.
 *
 * The code is kept rather than replaced: it is on the row's own title, so the
 * underlying detail stays reachable exactly as it was. A kind with no entry
 * falls back to its own words rather than to a shrug, so a new event kind
 * reaches the screen legibly without this map having to be remembered.
 */
const EVENT_PLAIN: Record<string, string> = {
  CASH_MODE_ACTIVATED: 'Cash Mode started',
  CASH_MODE_WINDING_DOWN: 'Winding down: no new discovery',
  CASH_MODE_ARCHIVED: 'Archived',
  CASH_MODE_ACTIVE: 'Made active again',
  CASH_LAYER_CREATED: 'Somewhere to file the work was created',
  CASH_DISCOVERY_OPENED: 'A new search was opened',
  CASH_OPPORTUNITY_HARVESTED: 'An opening was harvested from the research',
  CASH_OPPORTUNITY_CAPTURED: 'An opening was written down',
  CASH_OPPORTUNITY_READY: 'An opening became ready to test',
  CASH_OPPORTUNITY_DECLINED: 'An opening was declined',
  CASH_OPPORTUNITY_ARCHIVED: 'An opening was archived',
  CASH_OPPORTUNITY_REOFFERED: 'An archived opening was offered again',
  CASH_OPENING_EXHAUSTED: 'An opening ran out of attempts',
  CASH_CARD_UPDATED: 'An answer was filled in on a card',
  CASH_CARD_ANSWERED: 'Research answered something on a card',
  CASH_TERMS_PROPOSED: 'Brain proposed terms for an opening',
  CASH_NEED_RAISED: 'Brain said what it is missing',
  CASH_NEED_RESOLVED: 'Something Brain was missing was answered',
  CASH_NEED_WITHDRAWN: 'A need was withdrawn',
  CASH_AUTHORITY_GRANTED: 'You set what Brain may spend',
  CASH_AUTHORITY_WITHDRAWN: 'Spending authority was withdrawn',
  CASH_COMMITTED: 'Money was committed',
  CASH_COMMITMENT_RELEASED: 'A commitment was released',
  CASH_COMMITMENT_SETTLED: 'A commitment was settled',
  CASH_MONEY_RECORDED: 'A money record was added',
  CASH_ACTION_RECORDED: 'Brain did something in the world',
  CASH_EXECUTION_STARTED: 'Work on an opening started',
};

function plainEvent(kind: string): string {
  const known = EVENT_PLAIN[kind];
  if (known !== undefined) return known;
  const words = kind.replace(/^CASH_/, '').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What Brain has done: the append-only history, newest first.
 *
 * Supporting detail under the roadmap rather than the progress report itself.
 * The internal code is translated and kept: it is on the row, so a person
 * reading for progress is not decoding enum names and somebody debugging has
 * lost nothing.
 */
/** How many events the history shows before somebody asks for more. */
const EVENTS_PER_PAGE = 10;

function Done({ page }: { page: CashPage }): JSX.Element {
  const [shown, setShown] = useState(EVENTS_PER_PAGE);
  const view = page.full;

  /*
   * Counted for a member, quoted for the owner — and the same section either
   * way.
   *
   * `cash_events.summary` is free text composed by whatever wrote the event and
   * `detail` is an untyped bag, so deciding per sentence whether one of them
   * names money would be a filter over prose, which is exactly what the shared
   * projection refuses to be. A count per kind carries no prose at all, so a
   * member gets the shape of the activity and none of its words.
   */
  if (!view) {
    const activity = page.frontier.activity;
    return (
      <section className="rs-card rs-cash-history-body">
        <h3>Everything that has happened</h3>
        {activity.length === 0 ? (
          <p className="rs-hint">Nothing has happened here yet.</p>
        ) : (
          <ul className="rs-list">
            {activity.map((one) => (
              <li key={one.kind} className="rs-row">
                <span className="rs-item-title">{plainEvent(one.kind)}</span>
                <span className="rs-item-meta">
                  {one.count} {one.count === 1 ? 'time' : 'times'} &middot; most recently{' '}
                  {new Date(one.mostRecentAt).toLocaleString()}
                </span>
                <details className="rs-cash-event-raw">
                  <summary>What Brain called it</summary>
                  <code>{one.kind}</code>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p className="rs-hint">
          Counted rather than quoted: what each event *said* belongs to whoever owns the job it was
          about, so the shared frontier carries the kinds and the counts and no free text at all.
        </p>
      </section>
    );
  }

  const all = view.whatBrainHasDone;
  const page_ = all.slice(0, shown);
  return (
    <section className="rs-card rs-cash-history-body">
      <h3>Everything that has happened</h3>
      {all.length === 0 ? (
        <p className="rs-hint">Nothing has happened here yet.</p>
      ) : (
        <>
          <ul className="rs-list">
            {page_.map((event) => (
              <li key={event.id} className="rs-row">
                <span className="rs-item-title">{event.summary}</span>
                <span className="rs-item-meta">
                  {plainEvent(event.kind)} &middot; {event.createdAt}
                </span>
                {/*
                  * The internal code, kept and shown rather than hidden in a
                  * tooltip. A title attribute is not reachable on a phone and
                  * is not reachable by a screen reader on a span, so the one
                  * person it was there for — somebody debugging — could not
                  * get at it on either. It is translated *and* kept, which is
                  * the whole reason `plainEvent` exists.
                  */}
                <details className="rs-cash-event-raw">
                  <summary>What Brain called it</summary>
                  <code>{event.kind}</code>
                  {event.actorRef ? <span className="rs-hint"> · {event.actorRef}</span> : null}
                </details>
              </li>
            ))}
          </ul>
          {shown < all.length ? (
            <button
              type="button"
              className="rs-link-button"
              onClick={() => setShown(shown + EVENTS_PER_PAGE)}
            >
              Show {Math.min(EVENTS_PER_PAGE, all.length - shown)} more of {all.length}
            </button>
          ) : (
            <p className="rs-hint">
              {all.length === 1 ? 'That is the one event' : `All ${all.length} events`} Brain keeps
              on this page. The record itself is append-only and is never trimmed.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Winding the sprint down, and what that actually stops.
 *
 * The consequence sentence is the server's, because it is the one thing about
 * this control people get wrong: winding down stops **new discovery** and
 * nothing else. Customers, delivery, money and every other part of Brain carry
 * on, and reactivating is a decision rather than a recovery.
 */
function Lifecycle({
  projectId,
  state,
  mayAdminister,
  onChanged,
}: {
  projectId: string;
  state: CashModeState;
  /**
   * Whether to *offer* the transitions. The server decided it, at project
   * `ADMIN`, and decides it again on the call — this only stops offering a
   * control that would be refused.
   */
  mayAdminister: boolean;
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const next: CashModeState[] = (['ACTIVE', 'WINDING_DOWN', 'ARCHIVED'] as const).filter(
    (candidate) => candidate !== state,
  );

  return (
    <section className="rs-card rs-cash-lifecycle">
      <h3>The sprint</h3>
      <p className="rs-item-meta">It is {state.toLowerCase().replace('_', ' ')}.</p>
      {/*
        * The state is a fact about the sprint and is shown to everybody; the
        * transitions are a decision and are offered to whoever may take it.
        * The section itself stays either way, because removing it would move
        * every heading above it on one of the two pages.
        */}
      {!mayAdminister ? (
        <p className="rs-hint">
          Starting, winding down and archiving the sprint are decisions for whoever administers this
          project. Winding it down would stop new discovery and nothing else.
        </p>
      ) : (
      <>
      <label className="rs-field-label" htmlFor="cash-lifecycle-reason">
        Why
      </label>
      <input
        id="cash-lifecycle-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="rs-cash-actions">
        {next.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="rs-button-quiet"
            disabled={busy || reason.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                const answer = await CashApi.setLifecycle(projectId, candidate, reason);
                setMessage(answer.message);
                onChanged();
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {candidate === 'ACTIVE'
              ? 'Make it active'
              : candidate === 'WINDING_DOWN'
                ? 'Wind it down'
                : 'Archive it'}
          </button>
        ))}
      </div>
      {message ? <p className="rs-hint">{message}</p> : null}
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      </>
      )}
    </section>
  );
}

export { CashView_ as CashSection };
