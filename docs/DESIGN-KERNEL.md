# The Design Kernel

A small seed with a complete loop: render the real interface, measure it, judge
what measurement cannot settle, repair what it can, learn from the outcome,
notice what it cannot do, and route that somewhere that already exists.

This document is the operator's account. `CLAUDE.md` §39 is the rule set;
`server/services/design/` carries the reasoning in the code.

---

## Where this is, exactly

**Branch** `claude/design-kernel-implementation-a5bws8`. **Nothing here is
merged and nothing is deployed.** Production runs the `production` branch, which
does not contain `server/services/design` at all — so the deployed Brain has no
design tables, runs no design tick, and holds no cycle, capture, finding or
expansion. Any design row referred to anywhere is a local one.

That matters for one claim in particular. An earlier report named two Russell
candidates as evidence that proactive expansion had routed research. They were
rows in a throwaway SQLite directory. Read through the MCP connector on
2026-09-20, production's `brain-architecture` project (`prj_ac780d726f394a8ca81d`)
holds one layer, `Capability Realization`, `NOT_STARTED`, and **zero work
items**. Nothing has been routed there by anything.

### What works end to end, and what the evidence is

| | Evidence |
| --- | --- |
| A landed change opens a cycle | `remoteLoop` → `requestDesignCycle`, walked in `tests/designJudgedWalk.test.ts` |
| A cycle reaches a machine with a browser | the tick opens a `DESIGN_RENDER_V1` bin; the walk claims and answers it |
| The real interface is rendered and measured | `npm run design render` against Chromium 141, six surfaces × three widths |
| A judgement comes back and is validated | `DESIGN_REVIEW_V1`, zero-trust validator, recorded lineage, the walk |
| The judgement is bound to the evidence it saw | `design_bin_requests.capture_digest`; a moved set is refused by name |
| The cycle closes with a derived stop reason | `settleJudgedCycles`, and a REFUSED review may not settle one |
| Three open findings are closed | re-rendered: zero low-contrast, zero small-target findings |

### Checks, against the revision actually tested

`d09c1ce`, a clean tree, both backends:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| Full suite, SQLite | 168 files passed, 1 skipped; 3692 passed, 41 skipped |
| Full suite, Postgres | 169 files passed; 3721 passed, 12 skipped |
| Six surfaces × three widths, Chromium 141 | zero low-contrast, small-target and unreachable findings |
| A full cycle over three surfaces | stopped `SETTLED` |
| Cycle digest vs. `design-manifest` | both `d04277bc0819…` over the same nine pictures |

An earlier full run was in flight when two more commits landed, so it was
running against a tree that no longer existed. It was stopped and discarded
rather than reported: a green result over a tree that changed underneath it is
not a result about this one.

### What is still partial or blocked

- **No fleet worker has answered a design bin.** The machinery is complete and
  the walk drives it with real `WORKER` principals over the real queue, but a
  *fired* Cowork session needs this branch deployed. That is a person's decision
  and the honest state is UNPROVEN, not working.
- **`JUDGE_COMPOSITION` reads a description, never the picture.** Unchanged, and
  declared as the absent capability `VISUAL_COMPOSITION_FROM_PIXELS`.
- **The deployed Brain still has no browser** and must not acquire one. The
  render bin is how that stops being a dead end; it needs the deploy and a
  `worker_routing` row for `GENERAL_DESIGN_RENDER`.
- **No design surface exists in the product.** Findings are read on a terminal.

---

## What was already here, and what was reused

Nothing in this kernel is a second copy of machinery Brain already has.

| Already here | How the kernel uses it |
| --- | --- |
| `server/repos/designApprovals.ts` | Untouched. A capture set digests with the same semantics, so a cycle's `captureDigest` and a `design_approvals` row bind to the same bytes. |
| `scripts/design-manifest.ts` | Untouched. A cycle writes the `index.json` it refuses to guess at, so the existing tool digests a set the kernel actually produced. |
| `scripts/visual-qa.ts` | Its CDP driver, its bounds and two rules it learned from false findings were lifted into `services/design/browser.ts` and `observe.ts` rather than re-derived. |
| Bins, leases, fencing, `bins/routing.ts` | The judged lane is a bin with a `DESIGN_REVIEW_V1` contract and `GENERAL_DESIGN_REVIEW` workload class. No second worker fleet. |
| `services/identity/policy.ts` | Unchanged. The kernel adds no policy module and no route that could authorize anything. |
| Russell candidates → judgment → compiler → envelope → gate → audit | The `RESEARCH` expansion route creates a candidate. No second research engine. |
| Software Factory + Build | The `SOFTWARE` route prepares an objective a person authorizes. No second capability-acquisition engine. |
| `services/documents/ocrRuntime.ts` | The shape for `renderRuntime.ts`: a local capability Brain discovers and reports, never assumes. |
| `services/capability/*`, `services/selfmodel/*`, `services/realize/*` | The *shape* of a registry with independent dimensions and no aggregate. The design self-model is its own table because a design ability is not a blueprint faculty — forcing one into `faculties` would need an invented `capability_sources` row, which is a declared lie. |
| `services/industry/kernel.ts` | The tick shape: derive on every pass, bound by concurrency and never by a lifetime quota, absorb before deciding. |

---

## The three loops

### 1. Operate — `services/design/operate.ts`

```
a change lands
  →  requestDesignCycle opens a cycle, on a Brain with no browser
    →  the tick asks for a render, as a bin
      →  a worker with a checkout and a browser answers it
        →  the tick stores the captures and measures them
          →  the tick asks for the judgement, as a bin
            →  a different session answers it
              →  the tick closes the cycle, with a reason derived from what is open
```

The measured half runs synchronously wherever a browser and a running product
exist. The judged half is a bin, because §8 says model prose never mutates state
and §24 says the deployed Brain buys no inference.

**Both halves are bins because they have to be, and for a while only one of them
was.** A capture needs a browser; the deployed Brain has none. A judgement needs
the fleet; the fleet only fires at the deployed Brain. Those are two machines
with nothing between them, and until `services/design/render.ts` there was no
route: a cycle opened by a real change waited for somebody to run a command
against a database that does not hold it. `openDesignReview`, meanwhile, had
exactly one caller in the repository and it was a test.

**It is bounded at three rounds** (`MAX_DESIGN_PASSES`). A cycle that reaches the
ceiling closes `REPAIR_EXHAUSTED` **with its findings still OPEN**, and they are
then marked `UNRESOLVED` — a thing somebody has to answer, rather than a thing
the loop is still working on. Closing them to make the cycle read as finished is
the one outcome this loop exists not to produce.

Five stop reasons, and only one of them is `SETTLED`:

| Stop | Means | Remedy |
| --- | --- | --- |
| `SETTLED` | nothing open, everything readable | none |
| `REPAIR_EXHAUSTED` | the ceiling with findings open | read them; they are kept |
| `NO_RENDER_RUNTIME` | no browser here | install one, or run the cycle where there is one |
| `NEEDS_PERSON` | every repair is a code change | authorize it on Build |
| `ABANDONED` | superseded, or no surface requested | none |

### 2. Learn — `services/design/learn.ts`

After a cycle closes: what recurred, what the owner said, what the run revealed
about the kernel itself.

- A defect **kind** that has appeared in three distinct *cycles* is compiled into
  a pattern. Distinct cycles, not distinct findings: ten instances in one run of
  one screen is one observation.
- The statement is composed from the kind, never by concatenating three
  findings' prose — a rule made that way carries three screens' specifics and
  applies cleanly to none of them.
- Everything compiled is `PROPOSED`. A kernel that activated its own rules would
  be generalising from its own output, and the first wrong generalisation becomes
  the lens it reads everything else through.
- A reader that could not answer becomes a recorded **limitation** on the
  capability it belongs to.

### 3. Expand — `services/design/expand.ts`

Runs on the Russell tick with **no trigger**. Nothing has to fail, nothing has to
be complained about, and nobody has to name a capability.

1. Settle live expansions against a fresh reading.
2. Rank every declared capability — including the ones nothing implements.
3. Open the top gaps, up to a concurrency ceiling of two.
4. Route each to machinery that already exists.

| Route | Where it goes |
| --- | --- |
| `READING` | Brain can settle it from its own rows. Costs nothing, so it is always preferred. |
| `RESEARCH` | A Russell candidate on the architecture project: archive check, compiler, approval envelope, evidence gate, three audit roles. What comes back is absorbed — see below. |
| `SOFTWARE` | An objective a person authorizes on Build. §27 reserves that decision. |
| `PERSON` | A decision no amount of building closes. |

There is deliberately **no route meaning "the design kernel will build this
itself"**.

#### And research that came back becomes knowledge — `services/design/absorb.ts`

`design_patterns.origin` declared `RESEARCH` and, until this module, nothing
wrote it: an expansion could run the whole research pipeline and what came back
sat in `research_claims` as a report, with the next design problem assembled
from the same seven seed patterns as before. A pile of links, exactly as the
brief warns.

Each **citable** claim — accepted, on a fragment that reached `ACCEPTED` or
`BLOCKED`, the same read a filed report uses — becomes one pattern:

- the statement is the claim **verbatim**; composing a nicer sentence out of it
  would be prose becoming a rule with the citation still attached;
- the evidence is the claim id, its source URL and its publisher;
- the scope note carries the claim's geography, timeframe and population, so
  outside them it is *unestablished* rather than false;
- confidence is `MEDIUM` at most, because a well-sourced statement about
  interfaces in general is not a lesson this product has paid for;
- it is `PROPOSED`, like everything else the kernel compiles for itself.

And the expansion settles **`EVALUATED`, not `PROMOTED`**: knowing how something
is done is not being able to do it, and the capability dimension moves only on a
reading of the capability itself.

---

## Priority

Three altitudes, **lexicographic over observable facts** and no weighted score
anywhere — a score needs weights, weights are a judgement nobody made, and the
number then reads like a measurement.

**Brain-wide** (`facultyActivity`) — live missions, live packets, live campaigns,
ready bins. Effort follows what Brain is doing.

**Design-local** (`rankSurfaces`), in this order:

1. a surface nobody has ever rendered, because it is the only one about which
   *nothing* is known;
2. the worst open severity;
3. whether the owner has already corrected it — the best predictor that this
   screen costs them time;
4. how many kinds of defect keep recurring there;
5. how busy its faculty is;
6. how many findings are open, as the tiebreak rather than the headline.

**Runtime** (`runtimeAvailability`) — a **filter**, never a term in the other two.
Something that cannot run right now has not become less important.

**Expansion** (`rankCapabilities`) — measured demand first, then how weak it is,
then how often it has gone wrong. Failure is third on purpose: putting it first
is how a kernel only ever improves in response to failure.

---

## The evidence model

A capture is bytes with a hash, an engine, a version and a revision on them.

- `design_captures.content_hash` is the sha-256 of the image.
- `digestCaptures` digests a set with `digestRenderSet`'s semantics, so a cycle's
  digest and a `design_approvals` row are comparable.
- A cycle writes `index.json`, which `scripts/design-manifest.ts` then digests.

**This was verified rather than asserted.** The run of 2026-09-20 produced a
cycle whose `captureDigest` was `17d9a70a3d9b1c6e…`, and
`npm run design:manifest -- docs/evidence/design-renders` over the same nine
files printed `17d9a70a3d9b1c6ee4615c21e27fd018dca66454172b3c226970d62dc52a2c6d`.
Same number, two paths, nine real pictures.

Nothing in `scripts/` can record an approval, and that is unchanged.

---

## The first real run, and what it found

`npm run design cycle -- --surfaces russell/default,build/default,fleet/default`
against the real client, a real server, a real Chromium 141 and three widths.

**It found a systemic, verified accessibility defect on its first pass.**
`--ink-faint: #74838f` — read by 35 rules across the product — measures:

| against | ratio | floor |
| --- | --- | --- |
| `--surface` `#ffffff` | 3.90:1 | 4.5:1 |
| `--paper` `#f2f4f6` | 3.54:1 | 4.5:1 |
| `--surface-sunk` `#e9edf1` | 3.31:1 | 4.5:1 |

Those are exactly the three numbers the reader reported, independently
recomputed. The repair — `#5c6b78` in light mode and `#8b99a5` in dark, both
verified against every surface token — took the Russell surface from **17 open
findings to 5**, measured by re-rendering rather than by anybody's say-so.

### Two false positives the run produced, and the corrections

Both are recorded in the code rather than quietly fixed, because §29 is explicit
that **a false finding costs more than the defect it was looking for**.

**A responsive regression that was not one.** The resting page at 390px cannot
press Search, Build, Connected sites, Cash or Sign out — they live in a sheet
that is not in the DOM until something opens it. The reader called them lost.
§29's rule is *reached in one press or in two — through More is still reached*,
so `revealExpression` opens the disclosures **after** the screenshot and unions
the sets. The picture is still the resting state; the reachable set is not.

**An unreachable control that scrolling reaches.** Brain's shell is a grid whose
reading column scrolls internally, so a control below that column's fold has a
rectangle inside the viewport and is painted over by the command bar in the row
beneath. Every one of them reported as covered. The condition is scroll *room*
now, not the coverer's position.

### The three findings that were left open, and how each one closed

All three were re-measured against the current UI rather than taken from the
report, and every one had a root cause a level above where it was reported.

**`h4.rs-collection-name` at 1.66:1 was a stylesheet leak, not a colour
choice.** `main.tsx` imports `styles.css` and `design.css` globally, and
`styles.css` is the legacy console's — *dark, dense, information-first*, by its
own first line. Its bare `h4 { color: var(--fg-dim); text-transform: uppercase }`
applies to every h4 in the application, and `--fg-dim` is `#b3c1d1`, a grey-blue
for a near-black background, painted on `--paper` `#f2f4f6`. The conversation
names on Home were rendering in capitals nobody chose, at 1.66:1.

Repairing it found the same leak one element along — bare `label` puts `#7d8ea1`
on white at 3.36:1 inside every scope row on Build — so the fix is scoped to the
class of defect: inside `.rs-shell`, headings, labels, legends, selects and
textareas take their colour from what contains them and impose no case or
tracking. Size is untouched, because size is what a Russell class decides.
Nothing about `/legacy` changes.

**The Build radios were never 13×13.** A native radio is that size in every
browser and nobody aims at it: it sits in a `<label>`, and the words are the
target. The reader measured the control, so the honest number was hidden — the
target is 870×**23**, one pixel under the floor. `observe.ts` measures the union
of a control and the label that labels it now, and only a label that wraps it or
names it in `for`. Beside it, an unstyled `<button>` measured 21px tall;
`.rs-shell button:not([class])` gives the buttons nobody styled an appearance
and a floor, and touches no button the file already styles.

**And the reader was wrong again on a surface nobody had rendered.** Fleet's
link-styled buttons came back as small targets; both sit *in a sentence*, which
is WCAG 2.2 SC 2.5.8's own Inline exception. Implemented in the criterion's
terms: the parent must hold real text outside the control and the control must
fit in one line of it.

**The ochre line was the one that touches identity, and the repair changes no
surface.** `--ochre` is a background colour being read as text: 3.15:1 on
`--paper`, 3.01:1 on its own wash. `--moss` is 4.07:1 on its wash and fails by
less. Both now have the ink companion `--verdigris-ink` has always had —
`--ochre-ink: #8a6011` (4.74:1 on the worst light surface), `--moss-ink:
#42704f` (4.79:1) — chosen by computing the luminances rather than by eye. The
surface tokens are untouched, so every chip, border and background is the colour
it was, and dark mode already measured 7:1 and better so its inks resolve to
what it already uses.

**Verified by re-rendering, not by reasoning.** russell/default, build/default,
fleet/default, work/default, projects/default and knowledge/default, three
widths each: **zero low-contrast and zero small-target findings**.

A finding now carries the two colours as well as the ratio, because "1.66:1"
sends a reader back to the browser to find the pair, and the pair is the repair.

---

## What the self-model said afterwards

Read from rows, never declared. After the run:

```
RENDER_REAL_INTERFACE          LIVE     / PASSING
MEASURE_LAYOUT_FAULTS          LIVE     / PASSING
MEASURE_ACCESSIBILITY_FLOOR    LIVE     / PASSING
REPAIR_WITHIN_BOUNDS           LIVE     / PASSING   (the stopping half only)
JUDGE_COMPOSITION              PARTIAL  / UNTESTED
DETECT_UI_IMPACT               PARTIAL  / UNTESTED
LEARN_FROM_CORRECTION          PARTIAL  / UNTESTED
MOBILE_INTERACTION             ABSENT   / UNTESTED
VISUAL_COMPOSITION_FROM_PIXELS ABSENT   / UNTESTED
MOTION_AND_TRANSITION          ABSENT   / UNTESTED
```

Every one of those moves was written with the reading that caused it, into
`design_capability_events`.

## What it decided to do about itself

`npm run design expand`, with nothing having failed and nobody having asked:

```
opened dex_316131f7… [RESEARCH] MOBILE_INTERACTION
       Nothing in Brain can judge interaction on a handheld screen — reach,
       gesture, thumb travel, sheets.
opened dex_0d6c3294… [RESEARCH] MOTION_AND_TRANSITION
       Nothing in Brain can judge what happens between two states.
passed over MEASURE_ACCESSIBILITY_FLOOR: already live and passing, so closing it
       would be polish rather than capability.
passed over VISUAL_COMPOSITION_FROM_PIXELS: 2 expansions are already live, which
       is the concurrency ceiling — not a quota.
```

Both parked on that database, naming the remedy: it had no architecture project
for the research to be filed against. Creating one is `npm run admin`, which is
a person's decision — a loop that made itself a project to have somewhere to put
its own work would be a machine creating its own scope.

**The park was then answered, which is the half that matters.** The same pass,
run against a Brain holding `brain-architecture` (`prj_17172d01abf843fcba05`),
routed both: `rcn_2d1a4599051f4544bf68` and `rcn_d69ba7de0d924c5b8f7c` are real
`russell_candidates` rows, and the two expansions read `ROUTED` rather than
`PARKED`. Nothing about the candidates is special to this kernel — they go
through `judgeCandidate`, the archive check, the compiler, the approval envelope,
the evidence gate and three audit roles exactly as any other idea does, and
whether a packet is ever bought is that pipeline's decision and a person's, not
this loop's.

Which project that is, is resolved through `ARCHITECTURE_SLUG` — the capability
kernel's own answer to the identical question — before falling back to
`purpose = 'TECHNICAL'`. Two kernels resolving *Brain's architecture scope* by
two different rules would file into two different projects, and the disagreement
would read as research going missing rather than as a routing defect.

### The correction that made that possible

The first version refused any capability with zero demand. **Zero demand is not
the same fact as no demand**: a capability nothing implements cannot have
produced a finding, so an empty count there is the absence of a *reading* rather
than a reading of absence. Refusing on it made the three abilities this kernel
most obviously lacks — among them judging a picture at all — permanently
invisible to the loop that exists to find them. §30's rule about an unknown
never being a favourable assumption, failing in the direction that quietly ends
self-expansion.

---

## The sharpest limitation, said plainly

**The judged lane reads a structured description of the rendered page, not the
picture.** A reviewer is given the heading outline in document order, the
controls a person can actually press, the element counts, the container nesting
depth, every measurement already taken, and the full product context — what the
screen represents, how much of each thing exists right now, what a person can do
there, how often and at what cost.

That is a great deal and it is **not seeing**. The kernel can establish that an
outline skips a level and cannot establish that a composition is ugly. It is
recorded as a limitation on `JUDGE_COMPOSITION`, it is stated in the bin's own
brief so a reviewer knows which questions it is not in a position to answer, and
`VISUAL_COMPOSITION_FROM_PIXELS` exists as a declared absent capability so the
expansion loop can find it. It is not papered over anywhere.

---

## Using it

```
npm run design -- surfaces       # what can be looked at, in priority order
npm run design -- capabilities   # the self-model, re-read
npm run design -- next           # what the expansion loop would do; creates nothing
npm run design -- expand         # run one expansion pass
npm run design -- cycle --surfaces russell/default,build/default
npm run design -- resume <cycleId>   # a cycle the Factory opened when a change landed
npm run design -- render --surfaces a,b --pass 0   # answer a render bin
npm run design -- findings [--cycle <id>]
npm run design -- impact --paths a,b --says "..."
npm run design -- correction --admin you@example.com --says "..."
npm run design -- report
```

`correction` asks for the scope and refuses to choose one: it prints the
narrowest reading of what was pointed at and what else it could reasonably be,
and records nothing until told. The convenient answer is always the wider one,
and the failure the owner described is a fix applied everywhere removing
something useful somewhere else. Driven once for real against the proof
database, it moved `LEARN_FROM_CORRECTION` from `ABSENT` to `LIVE / PASSING`.

`cycle` and `resume` build the client, boot a server against a throwaway data
directory, sign in and render. Set `BRAIN_DATA_DIR` to keep the rows so the
reading commands can see them afterwards.

`render` is the worker half of the render lane. A `DESIGN_RENDER_V1` bin tells a
worker to run exactly this line; it renders with the same `capture.ts` a local
cycle uses and prints one JSON object between two markers, which the worker
submits through `brain_bin_submit_unit`. The bytes stay with the renderer and
the hashes travel. It writes to a throwaway directory rather than to
`docs/evidence/design-renders`, deliberately: that set is declared, digested and
committed as the evidence of one run at one commit, and half-replacing it with
pictures from another revision would leave a manifest whose digest no longer
describes what is in the directory.

Nothing in this script talks to a deployed Brain. The worker's own connector
does, which is what keeps this a command rather than a second client holding a
second credential.

## Registering a surface

Rows, not a deployment. The seed is `SEED_SURFACES` in
`services/design/surfaces.ts`; anything else is a `design_surfaces` insert. A
surface must declare what it is **about** — Brain's own nouns — and what a person
can **do** there, with how often and at what cost, because those are what let a
design problem be reasoned about rather than styled. They are declared and never
inferred: a kernel that read a route and guessed the domain would be §25's
Westbrook defect at a screen.

## Where the tick runs it

`services/russell/loop.ts`, step 1a-iv-f, fleet-wide, in its own `try`. Six
things, in the order the work is in:

1. read back renders whose bins finished, store the captures and measure them;
2. read back judged reviews whose bins finished;
3. close the cycles whose judgement landed;
4. ask for a render for any cycle still waiting for a machine with a browser;
5. learn from cycles that closed, and from what recurred across them;
6. absorb finished design research, then run one expansion pass.

The order matters: a render that came back this tick produces the captures a
review is briefed on, and a review that came back this tick is what lets a cycle
close. Any other order makes each stage a tick late for ever.

**Rendering itself deliberately does not run there** — the deployed Brain has no
browser and a tick that tried would either fail every pass or quietly decide a
surface was fine. What the tick does is *ask*, which is a row; the browser work
happens wherever the worker that claims the bin is.
