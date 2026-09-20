# The Design Kernel

A small seed with a complete loop: render the real interface, measure it, judge
what measurement cannot settle, repair what it can, learn from the outcome,
notice what it cannot do, and route that somewhere that already exists.

This document is the operator's account. `CLAUDE.md` §39 is the rule set;
`server/services/design/` carries the reasoning in the code.

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
render the real interface  →  measure it  →  judge what measurement cannot settle
  →  repair  →  render again  →  measure again  →  settle, or stop honestly
```

The measured half runs synchronously wherever a browser and a running product
exist. The judged half is a bin, because §8 says model prose never mutates state
and §24 says the deployed Brain buys no inference.

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
| `RESEARCH` | A Russell candidate on the architecture project: archive check, compiler, approval envelope, evidence gate, three audit roles. |
| `SOFTWARE` | An objective a person authorizes on Build. §27 reserves that decision. |
| `PERSON` | A decision no amount of building closes. |

There is deliberately **no route meaning "the design kernel will build this
itself"**.

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
`--ink-faint: #74838f` — used in 38 places across the product — measures:

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

### What is still open, and honestly so

- `--ochre` at 3.15:1 on the "You are needed" line. Real, and `--ochre` is also
  used as a background — so changing it is an accent decision that belongs to
  the owner. Reported, not repaired.
- `h4.rs-collection-name` at 1.66:1. A real reading with its element and its
  number, for somebody to check.
- Touch targets under 24px on Build's radio inputs.

The cycle closed `NEEDS_PERSON` naming all of it. That is the correct outcome
within current authority, and it is not dressed up as anything else.

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

Both parked, naming the remedy: this Brain has no `purpose = 'TECHNICAL'`
project for architecture research to be filed against. Creating one is
`npm run admin`.

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

## Registering a surface

Rows, not a deployment. The seed is `SEED_SURFACES` in
`services/design/surfaces.ts`; anything else is a `design_surfaces` insert. A
surface must declare what it is **about** — Brain's own nouns — and what a person
can **do** there, with how often and at what cost, because those are what let a
design problem be reasoned about rather than styled. They are declared and never
inferred: a kernel that read a route and guessed the domain would be §25's
Westbrook defect at a screen.

## Where the tick runs it

`services/russell/loop.ts`, step 1a-iv-f, fleet-wide, in its own `try`. It
ingests judged reviews whose bins finished, learns from closed cycles, and runs
one expansion pass. **Rendering deliberately does not run there** — the deployed
Brain has no browser and a tick that tried would either fail every pass or
quietly decide a surface was fine.
