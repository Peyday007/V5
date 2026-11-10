# Repository map

Moved verbatim from `CLAUDE.md` on 2026-11-02.

```
server/
  index.ts              boot: migrate -> seed -> recompute -> serve
  env.ts                every path the app uses
  config.ts             which database and which store, validated; no silent fallback
  bootRetry.ts          a boot whose cloud proof failed asks again, and falls back to nothing
  bootFailure.ts        what that Brain answers meanwhile: 503 and retryable, never a grant failure
  db/
    types.ts            the async Database interface both backends implement
    infra.ts            what a database failure is, and the control plane that must survive one
    pressure.ts         whether the database is answering well enough to start optional work
    driver.ts           SQLite driver abstraction (node:sqlite, or better-sqlite3 if installed)
    dialect.ts          ? -> $n and rowid -> seq, by walking the statement
    adapters/
      sqlite.ts         the local adapter
      postgres.ts       the cloud adapter: pooled, TLS, transactions pinned to a client
      transactions.ts   per-frame savepoints, so concurrent siblings cannot collide
    database.ts         opening the configured database and proving it works
    migrate.ts          automatic, checksum-verified, transactional migration runner
    migrations/*.sql    the SQLite schema, one numbered file per change
    pg-migrations/*.sql the Postgres schema, generated from it
  domain/
    types.ts            enums, row types, view types — the contract
    personName.ts       what a person is called; an address is never it
    version.ts          version parsing/ordering/next-version (never sort strings)
    naming.ts           canonical name / conversation title / filename
    jurisdiction.ts     states, postal codes, and where each one may be read from
    puzzle.ts           what a puzzle finding means, and where a retail price may not go
    puzzleCorpora.ts    the source material, and the rights in it — never researched
    signInName.ts       the name a person types, and what makes it theirs alone
    design.ts           ten design concerns, and the kinds a reading may establish
    manufacturing.ts    what a capability finding creates, and what it may never
    opportunitySignals.ts  what kind of opening a claim is, and what it becomes
    industry.ts         what a structural finding means, and what it may create
    construction.ts     §92: positions, assets and fact keys an industry is constructed from
    monetization.ts     every shape of transaction, what it needs and what it leaves
    labor.ts            what a labor finding means, and the one validator both doors call
    engineering.ts      the engineering policy: risk, tests, owners, next action, evidence
    dealflow.ts         what a claim establishes about a transaction, and where it lands
    auditProfile.ts     per-project audit criteria (Deal Dispatch G1-G14 + layers)
  repos/                data access, one module per entity
    scenario.ts       saved scenario models, and every run with exactly what it evaluated
    design.ts           surfaces, captures, findings, patterns, corrections, gaps
    auditReopens.ts     the record behind a re-audit, and its one reservation
    fleet.ts            accounts, Routines, capacity policy, and the fire slot
    deliveryProofs.ts   what each Routine has been shown able to deliver, per repository
    connectors.ts       one Claude account at one endpoint, and every OAuth client it ever was
    recoveryProbes.ts   each recovery probe and what its fire proved; one live at a time
    factory.ts          the contract, the campaign, and units that own a surface
    factoryFleet.ts     factory workers, sessions, reviews, findings, the ledger
    factoryRelease.ts   release grants, and each release attempt as a guarded state machine
    externalRecords.ts  a site's record, its version guard, and its refusals
    cashMode.ts       the sprint's row, and the append-only history beside it
    cashAuthority.ts  the commercial grant, and the ceiling spent by insert
    cashPortfolio.ts  the opportunities, and the needs they raise
    cashLedger.ts     money, as append-only rows; no balance column anywhere
    cashActions.ts    what was actually done, and under which grant
    cashJourney.ts    what the buyer said, what was agreed, and what it taught
    cashFulfillment.ts  one obligation per agreement, its events, and its refunds
    cashLock.ts       where two cash decisions stop being concurrent
    sharedFindings.ts the promotion record behind one shared Brain; pointers, never knowledge
    researchIntelligence.ts  the judgement above the engine: what to learn, and what changed it
    register.ts       workstreams, what they point at, and what happened to them
    goals.ts          a person's decisions about a goal, holds on bins, priority history
    bridge.ts         a person's bearer, a transcript exactly as it arrived, and its receipts
    dealflow.ts       both sides of a transaction, and everything hard between them
    puzzle.ts         the universe, the systems, the puzzles, the products, the trade
    faculties.ts      sources, candidates, faculties and their typed edges
    passkeys.ts       devices, enrollment links and challenges; digests, never secrets
    cashDiscovery.ts  which questions discovery asked, and which idea asked each
    capacityConnections.ts  one member's Claude connection, as rows rather than a conversation
    manufacturing.ts  the ladder, the capability ledger, and the one write research cannot reach
    cashCardFacts.ts  where each answer on a card came from, and what kind it is
    labor.ts          workflows, tasks, who produces each, and what has been asked
    monetization.ts   the possibility ledger; nothing in it is ever deleted
    engineering.ts    evidence, interventions and blockers; append-only
  services/
    storage.ts          document keys, confinement, and writing through the store
    storage/
      types.ts          the StorageProvider interface
      keys.ts           keys from Brain's identifiers; filenames are metadata
      local.ts          the data folder
      supabase.ts       the bucket, over REST
      index.ts          choosing one, and proving it answers
    cloudMigration.ts   the copy into the cloud, and its verification
    dependencies.ts     dependency checker
    stateEngine.ts      derived document/layer/project state
    planner.ts          Master Planner and next best action
    runtimeState.ts     data/runtime/project-state.json writer
    promptCompiler.ts   composable prompt sections
    auditEngine.ts      structured audits and their consequences
    redoEngine.ts       redo lineage
    synthesis.ts        synthesis preparation and packet validation
    freeze.ts           freeze / reopen semantics
    inference.ts        filename -> layer/version/type
    importer.ts         PDF import and registration
    reconcile.ts        scan & reconcile
    identity/
        secrets.ts        scrypt for passwords, sha-256 for generated credentials
      people.ts         who has actually joined, from a declared kind rather than a name
      foundation.ts     every account against every dimension, with one next action each
      recoveryContract.ts  the credential classes a recovery must retire, in one list
      webauthn.ts       a registration and an assertion, verified against Node crypto
      enrollment.ts     a member slot, its one link, and the recovery that retires first
      passkeyAuth.ts    the relying party, the challenge, and one refusal for everything
      passwordDoor.ts   who may still present a password, derived per account from rows
      tokenTouch.ts     a token's use, written even when the database was busy
      recentProof.ts    a bearer proved recently, so the handshake survives a slow database
      context.ts        the request's principal, and why it is also on the request
      policy.ts         roles, scopes, and the one authorization decision
      authenticate.ts   cookie or bearer -> principal, from server rows only
      bootstrap.ts      the first administrator, once, into an empty Brain
    agent/              chat tools and the local intent router
    archive/
      import.ts         folder-scale import: discovery, resume, retry, provenance
    reconcile/
      claims.ts         mechanical claim extraction from the project's own documents
      coverage.ts       requirement x archive -> SATISFIED / STALE / MISSING / ...
      plan.ts           the boundary, the requirement graph, and gap-only fragments
    audit/
      context.ts        what an audit is allowed to see
      prompts.ts        the primary / adversarial / judge prompts
      schema.ts         zero-trust validation of model output
      pipeline.ts       orchestration; the only path to a recorded verdict
      evidence.ts       the citation trail from a verdict back to passages
      integrityReaudit.ts  the second reason a round begins, and what it preserves
    dispatch/
      fire.ts           one POST to the Routine, and what a refusal means
      loop.ts           the tick: supersede, ensure, route, claim a slot, send
      candidates.ts     the fleet as numbers, read once per tick
      router.ts         a pure decision, and its named refusals: which wait, which end a burst
      pool.ts           every surface serving one logical worker, and what each has proved
      deliveryProof.ts  the repository half of a surface: push, pull request, cleanup, verified
      deliveryEvidence.ts  real work is the proof: a confirmed push proves a surface, a refused one takes it out
      scaler.ts         raise, lower, quarantine — proposals, never actions
      simulate.ts       a deterministic projection, structurally labelled
      profiles.ts       workload cost and activation traces, as queries
    factory/
      contract.ts       the change request, and what may never happen to it
      planner.ts        a proposed plan, validated to death before a row is written
      architect.ts      the decomposition pass, and the plan it is refused for
      registry.ts       the worker registry, and what the fleet can currently run
      scheduler.ts      a pure decision, and the lane count it measures
      git.ts            worktrees, diffs and merges — the factory's only evidence
      dispatch.ts       one unit on one worker, and the four ways it can end
      integrate.ts      ownership, the merge, and the verification that follows it
      glob.ts           what a path glob matches, asked by two questions
      forbidden.ts      what no unit may change, refused at the plan and on the diff
      review.ts         the independent verdict, and the lineage that makes it one
      repair.ts         a finding becomes work, exactly once
      ownership.ts      the one pre-dispatch check: every unit and repair can finish
      regrant.ts        the answer to a unit that ran out of attempts
      assemble.ts       the reviewable artifact, and the publishing it refuses
      release/
        gate.ts         whether a finished campaign may go live without a person, pure
        plan.ts         what the release workflow does next, recorded before it acts
        grant.ts        the owner's one decision, validated by one writer for both doors
        verify.ts       LIVE, measured inside the released Brain
        outcome.ts      BUILDING → VERIFYING → RELEASING → LIVE, or the exact blocker
      story.ts          why a campaign exists, its success conditions, plan rewrites in English
      metrics.ts        throughput from the ledger, with an evidence class
      sessions.ts       what the hosted plane ran, read back from Brain's own rows
      prompts.ts        every assignment, compiled from rows
      loop.ts           the tick, and every stage's answering transition
      executors/        how a worker is actually run; adding one is a row
      program/          one specification across many campaigns (§96)
        spec.ts         the verbatim source, located into items, nothing lost
        map.ts          requirements checked against the source: omitted, duplicated, conflicting, ambiguous
        plan.ts         bounded campaigns derived from the map, and the coverage gate
        status.ts       SPECIFIED → … → PRODUCTION_VERIFIED, derived; earliest-failure repair
        coordinator.ts  submit, approve, tick: verify, repair, queue through the line
        probes.ts       read-only production probes, under the protected path
        capacity.ts     where the factory's hours go, and the bottleneck
    connect/
      sites.ts          a connected site's identity, credential and status, as one action
      contract.ts       the frozen wire contract, and nothing about it trusted
      projection.ts     the six answers, derived from rows on the read path
      service.ts        registering a site's records, and its one typed command
      loop.ts           the tick that makes a state change visible to a poller
    capacity/
      connection.ts     connecting a Claude account, and the one step Brain cannot do
      adopt.ts          a surface Brain already fires, recorded as somebody's
      contribution.ts   whose connection is usable capacity, and why not when it is not
    storageHealth.ts    how much room is left, measured rather than guessed
    infra/
      incidents.ts      Brain's own outages as rows, so none is charged to a worker
    engineering/
      evidence.ts       what is already known: rows, delivery proofs, and CI via the forge
      watchdog.ts       executable work beside idle capacity, recorded and continued
    knowledge/
      shared.ts         what crosses between projects, and what may never
    goals/
      model.ts          a goal as Brain can read it: what happened, now, next, needs you
      priority.ts       each owner's goals in order, and the one fact that decides it
      tick.ts           holds, releases and allocation, on the durable tick
      decide.ts         pause, resume, cancel, reinstate, terms, objective — one writer each
      briefing.ts       the answer across goals, for somebody coming back
    register/
      resolve.ts        what the row behind a link says right now, or that it is gone
      view.ts           the six answers, derived on the read path and stored nowhere
      unfiled.ts        work nobody accounted for, offered and never filed
    bridge/
      sync.ts           exact, ordered, idempotent — and handed to the machinery that reads it
      status.ts         what Brain did with what was said, as rows rather than prose
      import.ts         a pasted or exported conversation, read two ways and never guessed
    memory/             historical memory (docs/HISTORICAL-MEMORY.md)
      parse.ts          a whole export read whole: every branch, file, project and time
      ingest.ts         manifest, batches, versions, attachments, bridge absorption
      classify.ts       passages, kinds, facets and subject terms, deterministically
      indexing.ts       messages into searchable passages, once each
      organize.ts       topics the material suggests: merged, split, many-to-many
      excavate.ts       the idea registry and what happened to each idea
      hubs.ts           sustained commitments, prepared hubs, Movie School's foundation
      rediscover.ts     why now, the open list, and the person's decisions
      coverage.ts       what is here, with denominators and named gaps
      views.ts          discoveries, ideas, conversations, topics, search
      pipeline.ts       the resumable pass Russell's tick runs
      upload.ts         one uploader for the page and the terminal
    fleet/
      view.ts           three capacity numbers that are not each other, and why it is slow
      capacity.ts       what the dispatcher would fire, counted once and labelled honestly
      workforce.ts      one card per Claude account: what it holds, finished and is waiting on
      connectorHealth.ts  the one answer to whether a connector can authenticate, and whose fault a no-show is
      arrivalIdentity.ts  who arrived for a fire; a wrong worker is stopped at once, restored once registered
      autoRecovery.ts   Brain probes the quarantines it derived again, bounded, one at a time
      connectionAlerts.ts  what is wrong with each connection, who acts, and exactly what
      connectorBinding.ts which connector a client and a Routine are, from proof; auth-caused quarantines lifted
      recoveryProbe.ts  one controlled fire that proves a quarantined, unattributed Routine's connector
      memberReconnect.ts  the one connector a signed-in member may restore without an invitation, or why not
      probe.ts          the one bounded self-test that turns configured into proven
      commission.ts     every commissioning step in order, and one READY / NOT READY answer
      lab.ts            the eight test modes, and the five this version refuses to run
    cash/
      providers/        Resend and Stripe adapters, their config and status (§53)
      invoicing.ts      an agreed amount invoiced, paid and settled — two entries
      journey/
        position.ts     where one deal stands, and its P&L, derived from the ledger
        deal.ts         observations and agreements; evidence or refusal
        fulfillment.ts  the obligation: work, delivery, acceptance, costs, refunds
        tick.ts         silence, the obligation pass, delivery and collection, on the tick
        learning.ts     measured outcomes, and lessons with their sample shown
        view.ts         every next step, and who takes it
      outreach.ts       the message a buyer is sent, composed from the card
      factoryHandoff.ts READY_TO_TEST to the Software Factory, under the standing grant
      jobPipeline.ts    a qualified opening becomes one job; its tasks, stage and blockers (§70)
      deal.ts           who holds each job: an even mix of every kind per person (§74)
      retireListings.ts openings from a freelance-marketplace listing, archived with their research (§76)
      deliverables/
        spec.ts         the closed specification a worker may submit
        render.ts       a spec becomes the files, deterministically
        verify.ts       the bytes re-read and checked before anything is sent
        pipeline.ts     a supplied CSV/Excel through declared steps
        capabilities.ts the per-process proof the PRODUCE_<KIND> capabilities read
        samples.ts      the realistic sample each kind is proved on
      access.ts         where the shared frontier ends and a private job begins
      shared.ts         what every member may read, built from the columns it names
      lifecycle.ts      activating a sprint, giving it somewhere to file, winding it down
      authority.ts      the closed set of commercial actions, and the check
      money.ts          the six figures, and the arithmetic that keeps them apart
      card.ts           what is unknown, and the task that would answer each
      portfolio.ts      the disposition of every piece, and the assembled plan
      needs.ts          a missing capability, with somewhere to go
      review.ts         grouping by shared remedy; compression, measured
      opportunities.ts  the producer, and every transition an opportunity has
      capabilities.ts   what Brain can verifiably do, read rather than declared
      answers.ts        research reaching the card, and the view Brain forms on it
      figures.ts        a money figure read from a source, and never produced
      tier.ts           signal, candidate, qualified, ready — derived, never stored
      conditions.ts     what settles a need, as a function rather than a wiring
      effects.ts        the three commercial operations Brain can be connected to perform
      perform.ts        a receipt becomes the record; an unknown waits for a person
      record.ts         what happened on one piece: actions, ledger figures, attempts
      discoveryAuthority.ts  what pressing Start authorizes, and what it never will
      validation.ts     the bounded deep dive, and what it puts on the card
      engineCard.ts     fact, estimate, decision, unknown — and the margin withheld
      discovery.ts      where the portfolio comes from: buckets, and a lane
      operate.ts        acting on a need: raise, settle, resume, start work
      view.ts           one private section, derived in one place
      monetization/
        enumerate.ts    the possibility space, from a closed table rather than a model
        status.ts       where one possibility stands, and what decided it
        rank.ts         lexicographic, so it can say exactly why — and what would move it
        movement.ts     that a position moved, which is the one thing no derivation recovers
        graph.ts        §21's chain, as a consequence of what each method produces
        ledger.ts       every answer the brief asks for, composed from one read
        surface.ts      the five, the groups, and the operator's own questions
        decisions.ts    naming, judging, merging, splitting — and destroying nothing
        commission.ts   which question is worth asking, as the sort function read backwards
        commissionPass.ts  asking it through the machinery that already exists, and filing the answer
        inFlight.ts     what is being researched, derived rather than stored
      readiness.ts      four people and four surfaces, counted from rows
    design/
      surfaces.ts       what can be looked at, and what each screen is about
      renderRuntime.ts  whether this machine can render the product, discovered
      browser.ts        a headless browser over the debugger, bounded everywhere
      observe.ts        what is read in the page while it is on the screen
      capture.ts        a render, bound to its bytes, its engine and its revision
      evaluate.ts       readings become findings, deterministically
      model.ts          the design problem: what it represents, and how much exists
      patterns.ts       reusable knowledge, seeded small and grown from evidence
      corrections.ts    what the owner said, kept at the scope they gave it
      capabilities.ts   what this kernel can and cannot do, read from rows
      priority.ts       three altitudes, and no weighted score anywhere
      impact.ts         whether a change reaches the interface, and which screens
      route.ts          a landed change becomes design work, where it landed
      judge.ts          the view a measurement cannot establish, through a bin
      render.ts         the route a picture takes from a machine that has a browser
      scope.ts          which project design work is filed against; one reader
      operate.ts        loop 1: render, measure, repair, render, stop honestly
      learn.ts          loop 2: what recurred, what they said, what it cannot do
      expand.ts         loop 3: its own weakest ability, routed somewhere real
      kernel.ts         the tick, and the seed
    labor/
      necessity.ts      the twelve questions, and the two Brain reads from its own rows
      derive.ts         where a workflow comes from when nobody types one in
      assign.ts         who produces a task, and the two Brain may decide alone
      allocate.ts       which labor question is next, and why — pure over a snapshot
      questions.ts      what each round asks, composed from the output rather than a title
      expand.ts         opening the questions, and filing what a gated claim declared
      map.ts            the map as Brain can read it, with every reading derived
      view.ts           §13's six readings, and the four figures nothing measures
      declare.ts        a person naming a workflow; the one origin Brain may not write
      kernel.ts         the tick, bounded by authority and concurrency and nothing else
    manufacturing/
      program.ts        starting a programme, and what pressing Start authorizes
      ladder.ts         the classes of machine, and how far Brain has got with each
      readiness.ts      the four conditions, and why an unknown is never met
      allocate.ts       demand before capability, as a pure decision over a snapshot
      questions.ts      what each round asks, and the one it must not be asked
      expand.ts         opening a question, and filing what a gated claim established
      declare.ts        the three things only a person can say
      kernel.ts         one project's pass, derived on the tick
      view.ts           the ladder, the gaps, and what would close the nearest one
    puzzle/
      formats/
        engine.ts       what a generator is, what a validator is, the wall between
        sudoku.ts       dug by one path, proved by another that reads only the grid
        wordsearch.ts   the words found by searching, and the ones nobody placed
        maze.ts         the openings counted against the squares, so the route is one
        cryptogram.ts   every checkable property, and the one it refuses to claim
        crossword.ts    a validator with no generator, which is the honest shape
        index.ts        which formats this repository can make or check — a reading
      generate.ts       validated, deduplicated and rights-clear, or not recorded
      products.ts       a master into products, and where a reskin has nowhere to hide
      economics.ts      what it earns, and every reason that number is withheld
      maturity.ts       ten rungs, three of them unreachable by construction
      leverage.ts       three multipliers that are not each other, two of them UNKNOWN
      ledger.ts         every way puzzle work turns into money, none ever removed
      capabilities.ts   what Brain can do about puzzles, and what it cannot
      questions.ts      what each round asks, with the format named verbatim
      graph.ts          everything the kernel knows, read once per pass
      allocate.ts       finishing before starting, pure over a recorded snapshot
      expand.ts         opening the questions, and filing what a gated claim declared
      promote.ts        where a product becomes work Cash Mode already pursues
      lessons.ts        observations into rules, with the sample shown
      seed.ts           the things only a person does to this kernel
      kernel.ts         the tick: file, make, compile, promote, allocate
      view.ts           the operator surface, in the order the brief asks for it
    dealflow/
      compliance.ts     the five layers, and why no rows is not a clearance
      economics.ts      the landed cost, and every reason it is withheld
      structures.ts     thirteen ways to be paid, and what each one costs us
      maturity.ts       the derived ladder, and what it declines to guess
      graph.ts          everything the kernel knows, read once per pass
      questions.ts      what each round actually asks
      allocate.ts       a pure decision, in the order the trade fails in
      expand.ts         opening the questions, and filing what comes back
      lessons.ts        observations into rules, with the sample shown
      promote.ts        where a deal becomes work Cash Mode already pursues
      seed.ts           the two things a person does to this kernel directly
      view.ts           the operator surface: what exists, what is next, what blocks
      kernel.ts         the tick: file, pair, promote, allocate
    capability/
      ingest.ts         a blueprint becomes a registered, readable source
      sections.ts       the sections a document declares, from its own headings
      extraction.ts     the bin, the validation, the audit, the promotion
      independence.ts   a reading is not audited by the session that produced it
      reopen.ts         the answering transition for a reading that failed
      reader.ts         the identity a reading is submitted under; it grants no tier
    selfmodel/
      levels.ts         seven kinds of evidence, three answers each
      observe.ts        what Brain can honestly read about itself, from here
      scan.ts           taking a reading, and noticing that one changed
      refresh.ts        when the reading stopped being about this system
    realize/
      gaps.ts           what Brain derives, and the four kinds it refuses to
      authority.ts      the answer to a gap no amount of building closes
      packet.ts         the ten-section packet, versioned, as living state
      director.ts       what to research, and when to stop — with the reason
      compile.ts        the change request a decision-ready packet implies
      realized.ts       three dimensions derived from rows, and the one with no mover
      handoff.ts        the compiled contract becoming an ask somebody can approve
      askTheWorld.ts    a capability question becomes an idea, and never a packet
      advance.ts        the ordering the tick runs, and no transition of its own
      prove.ts          what makes a capability exist, as opposed to built
    scenario/
      expr.ts           a closed arithmetic grammar, parsed by hand, compiled to closures
      random.ts         seeded streams, Φ and Φ⁻¹, Cholesky — no clock, no Math.random
      model.ts          a definition validated to death and compiled once
      engine.ts         drawing the worlds, and every strategy on the same draw
      analyze.ts        distributions, dominance, trade-offs, sensitivity, break-evens
      run.ts            the one pure entrance, and the digest that proves reproducibility
      isolate.ts        a worker thread per run, terminated past the budget; one run at a time
      worker.ts         the thread itself; worker-boot.mjs registers tsx before loading it
      service.ts        a run written down before it starts; the read-only demonstration
      demo.ts           the illustrative demonstration model
      units.ts          the unit of every expression, inferred and held to the declared one
      planCheck.ts      a plan reconciled from one model before anybody is shown it (§77)
    quant/              §79: a number nobody published, reconstructed from the mechanism
      pool.ts           transfer, shared data and random-effects pooling, refusals first
      reconstruct.ts    the evidence ladder, recursive, stopping where the evidence is enough
      mechanism.ts      demand × supply × capture, for arrangements with no name
      value.ts          which unknown could change the choice, with noise held out
      deadline.ts       research first, learn by doing, act on the estimate, or ignore
      portfolio.ts      combinations under shared resources, recycled capital, shared risk
      export.ts         an estimate as a scenario input, never stronger than its evidence
      knowledge.ts      Brain's own card facts and outcomes, as transferable observations
      problem.ts        one question end to end, from a file (`npm run quant`)
    cash/construct.ts   §80: arrangements composed from the map, decomposed into the round's question
    cash/properties.ts  §82: transaction designs, the properties they produce, reverse targets, stress
    cash/exclusions.ts  §82: what the goal's owner said to leave out, read where a negator governs it
    cash/volume.ts      §80: deals the market can take, read only where a source states a count
    russell/
      home.ts           the eight things home says, in the order S6 fixes them
      collections.ts    threads organized without inventing a category, ranked by meaning
      frontier.ts       where understanding runs out: five regions, five lenses answered, four asked
      maps.ts           six maps over the authoritative graph, and an outline that is the same graph
      search.ts         scope decided before the query, never filtered after
      preferences.ts    a closed set of presentational keys; nothing here changes a fact
      whyThisMatters.ts real milestones, quiet by default, no gamification
      routing.ts        which project a conversation is about, authorization-first
      judgment.ts       what is worth capturing, dedupe, and Russell's own priority
      similarity.ts     the floor a proposed semantic merge is held to
      authority.ts      what Russell may do here, in the words a person decides in
      coverage.ts       the archive check that runs before any work is created
      launch.ts         the one way a mission comes into existence, and its repair
      turn.ts           one conversation turn, carried by the Routine fleet
      probe.ts          the bounded light probe, and its deterministic verdict
      probeEnvelope.ts  where a probe may look — in code, named by id
      proposal.ts       zero-trust validation of what a model proposes
      writeback.ts      what happens when a mission finishes, exactly once
      needsHuman.ts     the park a packet stops at, and the answer that finishes it
      planning.ts       the judgment pass, its post-probe repeat, and the mission spec
      loop.ts           the durable tick, beside the dispatcher
      subject.ts        what an idea is about, from rows rather than its own prose
      dealDispatch.ts   the connected system, with its freshness in the type
      projections.ts    the briefing, and progress that may not be invented
      inbox.ts          Needs you: every genuine human decision, grouped by kind (§57)
      summary.ts        Home's money, research and build lines, from the destinations' own readings
    research/
      intelligence/
        model.ts        what Brain believes it was asked, versioned so it can be wrong
        uncertainty.ts  the decision-relevant unknown, and the graph between them
        depth.ts        how hard to look — raised by consequence, never lowered
        director.ts     what a finding should change about the plan, as a pure decision
        apply.ts        the guards that decision has to pass before it is a row
        sufficiency.ts  whether the answer is ready for the decision it is for
        proposals.ts    zero-trust validation of a worker's judgement about the plan
        retrospective.ts what the campaign taught, at the level it is true at
        view.ts         the mental state, derived on the read path
      overview.ts       the Research destination: goal → budget → packets, six plain kinds (§57)
      schema.ts         zero-trust validation of every research pass
      sources.ts        what makes a claim sourced; structural URL validation
      standards.ts      the evidence standard per claim type, and independence
      actorScope.ts     whose action a forbidden phrase is: Brain’s, or the source’s
      gate.ts           the seven evidence conditions, applied per fragment
      splitting.ts      fragment splitting and the dependency order
      bundling.ts       which fragments may share one job, and which never may
      quota.ts          execution tiers, and pausing rather than lowering the bar
      repair.ts         the plan behind a second attempt, never the same search
      replan.ts         new evidence against old, and cancelling needless work
      contradictions.ts which kind of disagreement two claims are actually in
      independence.ts   audit independence by execution lineage, not role name
      packet.ts         does this answer the goal, and what is missing if not
      review.ts         the plan a person approves before anything is spent
      approvalEnvelope.ts  limits a person set first, and the check against them
      progress.ts       where the run is, read from persisted state only
      prompts.ts        plan / fragment / bundle / verification / synthesis prompts
      orchestrator.ts   the assignment loop, and the only path to a filed report
      queue.ts          one job at a time, cancellation, restart recovery
    providers/
      connection.ts     detect / authenticate / test / models / paid overage
    sources/
      fetchForWorker.ts reads one public page for a worker whose sandbox cannot; public addresses only
      segmenter.ts      conversation- and topic-aware segmentation
      classify.ts       content-based layer proposals, and injection detection
      ingest.ts         the ingestion pipeline and its counted report
    documents/
      formats.ts        format detection by magic bytes, not extension
      pdf.ts            columns -> lines -> blocks, plus quality signals
      docx.ts           OOXML via mammoth, headings/lists/tables preserved
      text.ts           plain text, Markdown and pasted text
      ocr.ts            recognition, per-block boxes and confidence
      ocrRuntime.ts     deterministic discovery of the local OCR executables
      normalize.ts      artifact cleanup that keeps the raw text
      quality.ts        the gate: READY / READY_WITH_WARNINGS / BLOCKED
      chunker.ts        heading-aware chunks with page and block anchors
      extraction.ts     the pipeline, and crash recovery
      queue.ts          serial background extraction
      retrieval.ts      passage search and citation resolution
      findings.ts       the structured index, anchored to real quotes
  providers/            AIProvider abstraction: mock, Claude, OpenAI, Antigravity
    antigravity/        runtime probe, bounded process, job workspaces, PTY path
  mcp/                  the remote MCP gateway (Step 7)
    protocol.ts         versions, header rules, error codes, result envelopes
    validate.ts         _meta and header-body validation, era detection
    errors.ts           the closed set of tool error categories
    limits.ts           sizes, pages, rate and concurrency
    tools.ts            the permanent tool surface, over existing services
    engineeringTools.ts the seven engineering-connector tools every coding worker shares
    sourceTools.ts      brain_fetch_source: Brain opens a page under a worker's live research lease
    execute.ts          one call: rate slot, authorize, bound, audit
    modern.ts           the 2026-07-28 dispatcher
    legacy.ts           the 2025-11-25 front-end, over the official SDK
    endpoint.ts         POST /mcp: auth, origin, limits, era selection
  routes/               HTTP API
    factory.ts          the Software Factory: objective, stage, evidence, release
    connect.ts          a connected site's door: records, projections, one command (Step 12C)
    cash.ts             Cash Mode's door: the sprint, the grant, the portfolio, the money
    labor.ts            the labor kernel's door: workflows, tasks, who produces each
    scenario.ts         the scenario engine's door: models, runs, the demonstration, reproduce
    manufacturing.ts    the programme's door: the ladder, the categories, the ledger
    register.ts         the work register's door: workstreams, links, corrections
    bridge.ts           the conversation entrance: credentials, sync, transcript, status
    memory.ts           historical memory: import, coverage, discoveries, decisions, search
    russell.ts          Russell's surface: threads, briefing, work, ideas, sites, Needs You
    passkeys.ts         enrolling, signing in with a device, and your own devices
    people.ts           who has joined, what can run, and connecting your Claude account
    oauth.ts            the authorization server: discovery, consent, tokens (Step 8)
                        (rotation is idempotent and a bound consent offers one worker, §51)
    pages.ts            shared chrome for the server-rendered pages
    guard.ts            request context, authentication, deny-by-default
    escape.ts           what a request answers when an error escapes its handler
    unavailable.ts      a credential nobody judged, said as retryable rather than refused
    auth.ts             sign in, sign out, change a password
    admin.ts            people, workers, credentials, membership, the identity audit
    access.ts           the optional shared-token outer layer (not the security model)
    files.ts            serving a stored document through the storage layer
client/                 React UI
  src/Root.tsx          which shell this address wants, and who is signed in
  src/russell/          the whole product: conversation, thin views, states
  src/russell/Build.tsx the factory, as a person uses it: one objective, one approval
  src/russell/Research.tsx  what Brain is trying to learn: goals, budgets, packets, results
  src/russell/Scenarios.tsx  model a decision, run 50,000 evaluations, read what drives it
  src/russell/Connections.tsx  every Claude account Brain runs on, in six words
  src/russell/Cash.tsx  one Cash page: one skeleton, and a role decides what is in it
  src/russell/Machines.tsx  the ladder, what entering costs, and the three decisions that are a person's
  src/russell/cashPage.ts  both payloads, normalized; the capabilities the server sent
  src/russell/People.tsx     who has joined, my Claude connection, and usable capacity
  src/russell/ClaudeConnection.tsx  one connection screen, for every account, with no role in it
  src/russell/Register.tsx  the six answers, and the one form Brain may not fill in
  src/russell/Devices.tsx    your own passkeys, and nobody else's
  src/components/Enrol.tsx   where an enrollment link lands, before the sign-in gate
  src/components/SignIn.tsx  one button; no address, no password, no alternative
  src/components/Recovery.tsx  the break-glass door, unlinked, ending in a device
  src/russell/Home.tsx  the command center: state, focus, maturity strip, collections
  src/russell/Fleet.tsx capacity, surfaces, policy as rows, and the lab beside it
  src/russell/Workforce.tsx one card per Claude account, and the workforce totals
  src/russell/Frontier.tsx  the five regions, each item naming what it came from
  src/russell/Maps.tsx  six maps, with the outline always in the document
  src/russell/Search.tsx one search over everything this person may see
  src/russell/design.css the Step 12B design system: tokens, container reflow, both themes
  src/App.tsx           the legacy console, at /legacy
blueprints/             the blueprint and its amendments, preserved with their hashes
objectives/             software objectives a person approved, in the image by design
scripts/
  design.ts                 render a real screen, measure it, and ask what is next
  design.sh                 the half that reads rows, inside the deployed container
  capability.ts             the kernel's operator surface: register, advance, derive
  factory.ts                the operator's factory surface: register, submit, run
  factory-release.ts        the protected half of an automatic release, run by its workflow
  release-scan.ts           the gate's own reading of the merged diff: reserved paths, credentials
  test-postgres.sh          a throwaway, unprivileged Postgres for the suite, without a prompt
  manufacturing.ts          the programme's recovery door, when the bundle will not load
  connect-site.ts           a site's worker and grant, made without a browser
  connect-report.ts         what a connected site has done, read from inside
  refinement-report.ts      where every deep dive spent its time, stage by stage
  labor-report.ts           §13's six readings, and the four figures nothing measures
  labor-report.sh           the same, inside the deployed container, naming the revision serving it
  scenario-bench.ts         time the engine at 50,000 evaluations on this machine
  plan-check.ts             npm run plan:check — the one door a quantitative plan goes through
  quant.ts                  npm run quant — reconstruct, combine and value one problem file (§79)
  connection-report.ts      pools, incidents, auth refusals, misses by cause, every connector
  connection-report.sh      the same, inside the deployed container, on one connection
  puzzle-report.ts          what was made, proved, sold and learned; one puzzle re-rendered
  puzzle-report.sh          the same, inside the deployed container, on one connection
                            (reached by .github/workflows/puzzle-report.yml, which
                            checks the marker it prints)
  admin.ts                  emergency administration, on a terminal rather than a page
  engineering.ts            the engineering connector on a terminal; the only door for CI/OPERATOR evidence
  step12a-acceptance.ts     the nineteen gates, from rows; exit 0 only if all PASS
  fleet.ts                  the operator's fleet surface: register, target, explain, verify a pool
  generate-pg-baseline.mjs  the Postgres schema, generated from the SQLite one
  migrate-cloud.ts          npm run migrate:cloud
tests/                  Vitest suites
  designKernel.test.ts       what a design kernel may conclude, and what it may not
  designJudgedWalk.test.ts   one cycle, walked: a change lands, two bins, a closed cycle
  manufacturingKernel.test.ts  a gated round files everything and holds nothing
  researchIntelligence.test.ts   the judgement layer, in three unrelated domains
  researchIntelligencePass.test.ts  one campaign, walked, with only the world simulated
  dealflowKernel.test.ts     two sides, five layers, and every figure it refuses to invent
  puzzleKernel.test.ts       broken grids the validator has to catch by itself
  puzzleIntegrationPass.test.ts  a seeded format to a promoted product, over the wire
  dealflowIntegrationPass.test.ts  one deal, walked the whole way, over the wire
  capabilityKernel.test.ts   one blueprint, read the whole way: bytes to canonical
  capabilityReopen.test.ts   a failed reading put back, and everything it must not destroy
  systemSelfModel.test.ts    what a reading may claim, and the seven it may not
  realizationPacket.test.ts  derive what is readable; refuse to guess the rest
  capabilityDirector.test.ts most gaps are not research, and the archive comes first
  capabilityCompile.test.ts  every clause traces to a gap, and it starts nothing
  facultyRealization.test.ts  the dimensions that move, the ask that stops, the question that spends nothing
  capabilityTick.test.ts     the kernel advancing unattended, and the card a person answers
  capabilityProof.test.ts    a merge moves no dimension; each one needs its own evidence
  capabilityAuthority.test.ts  the escalation's answering transition, and every refusal in it
  step12bProduct.test.ts     the product decisions, where they are decided
  step12bResponsive.test.ts  the widths that were clipping, and why they no longer do
  cashMode.test.ts           the lifecycle, and the off switch that is not the Brain's
  cashMoney.test.ts          the six figures, and the cost that must not be subtracted twice
  cashAuthority.test.ts      the closed vocabulary, and the race for the last dollar
  cashPortfolio.test.ts      the unknowns, the dispositions, and the measured compression
  cashDiscovery.test.ts      the buckets, the lane, and the blank card they produce
  cashPipelineRepair.test.ts the fifteen proofs the production audit asked for
  cashOperate.test.ts        a capability read, a need resumed, an action recorded
  cashIntegrationPass.test.ts  one sprint, walked the whole way, entrances only
  cashProposal.test.ts       the seven terms, and the numbers Brain will not invent
  cashFirstDollar.test.ts    discovery to settled cash, restarted twice, and every way it fails
  cashPostSale.test.ts       agreement to learning: one obligation, bounded refunds, one P&L
  cashOpportunityStandard.test.ts  what is an opportunity, and whose question is whose
  monetizationLedger.test.ts   forty ways preserved, ranked, and never rounded to one
  monetizationCommissioning.test.ts  a discovery to a moved rank, and every way it must not double-ask
  cashBrowserToDatabase.test.ts  the screen, the route and the row, with no seam
  cashFourAccounts.test.ts   four private operations, and the walls between them
  cashDeploymentSmoke.test.ts  the artifact booted, driven over HTTP as a person and a worker
  russellFoundationCloseout.test.ts  five production defects, asserted as absences
  factoryPool.test.ts        one Factory worker, three accounts, and the failover between them
  sharedKnowledge.test.ts    one finding, two operations, and the wall between them
  workRegister.test.ts       no stored state, no source that ships, no URL that merges
  conversationBridge.test.ts exact bytes, real order, kept edits, and a replay that says so
  bridgeHttp.test.ts         the door: a worker refused by type, and one body for two refusals
  intakeToResult.test.ts     a transcript from outside, to a pull request, and back out
  factoryUnblock.test.ts     where a blocked campaign resumes, derived from its own rows
  factoryOwnership.test.ts   the deadlock and the test-only repair, reproduced and refused
  webauthn.test.ts           a real P-256 credential, and every refusal that would not have been one
  passkeyEnrollment.test.ts  a link spent once, a recovery that retires, a count that waits
  passkeyHttp.test.ts        the door, over a socket: five ways in and nothing else new
  passkeyOnlyAuth.test.ts    the owner's own migration, and the door shutting behind it
  oauthMemberReconnect.test.ts  a signed-in member restores their own connector; nobody else's
  signInIdentity.test.ts     one name, one account, and the door that stays open on purpose
  signInMobile.test.ts       the login journey on a phone, read out of the stylesheets
  signInSurface.test.tsx     the screen an unauthenticated person is actually served
  sharedCashAccess.test.ts   a member reads the frontier; nobody reads somebody's job
  peopleAndCapacity.test.ts  a declared person, a counted Routine, a resumable setup
  accountFoundation.test.ts  four account shapes, six dimensions, and a recovery that retires
  claudeConnectionLifecycle.test.ts  asking, checking, misbinding, lapsing, revoking, reconnecting
  claudeConnectionParity.test.ts     three real accounts, one screen, compared field by field
  peopleSection.test.tsx     the two screens the defects were actually visible on
  migrationRebuild.test.ts   a rebuild over rows, and the cascade it must not fire
  cashConcurrency.test.ts    two commitments, forced to overlap, on both backends
  cashCurrencyHttp.test.ts   a sprint that is not in dollars, driven as a person does
  cashHttp.test.ts           Cash Mode's door, driven as an attack
  cashSection.test.tsx       the Cash section in a browser: four states, one control
  cashCommercialJourney.test.ts  READY to settled through the real routes, and every unknown
  cashEffectReconciliation.test.ts  a receipt whose record failed, finished once by the tick
  connectorIsolation.test.ts one site, two private operations, two identities
  laborKernel.test.ts        who produces the work, and what an absence may never conclude
  laborFrontierAudit.test.ts every answer combination; silent exactly when defensible
  scenarioEngine.test.ts     known answers, refusals, correlation, pairing, sensitivity
  scenarioHttp.test.ts       models and runs persist, reproduce after a restart, and stay private
  scenarioSurface.test.tsx   the page over the real route: labelled simulation, never a probability
  connectorLifecycle.test.ts two accounts on one worker, an auth no-show, and a recovery nobody pressed
  connectionRecovery.test.ts the wrong connector, an arrival that took nothing, a probe nobody asked for
  connectorRecoveryProbe.test.ts  a quarantined, unattributed Routine proving its own connector
  connectionReliability.test.ts  the whole chain with the database failing on purpose
  integration3Product.test.ts   the readings the six destinations are built on
  integration3Surfaces.test.tsx the six destinations, driven through the real shell
  russellPassIsolation.test.ts   one pass that throws, and every pass after it still runs
  autonomyChain.test.ts      discovery to READY_TO_TEST to a Factory campaign to COMPLETE, no manual tick
  fixtures/             generated PDFs and DOCX packages, not opaque binaries
data/                   database, documents, backups, runtime state (gitignored)
```
