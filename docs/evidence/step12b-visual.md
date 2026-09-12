# Step 12B — what the product looks like, walked

**This is the record of one run at one commit. It is not a baseline, and nothing
compares anything to it.** A screenshot in a repository is stale the moment the
CSS changes, and a stale one that still looks like evidence is worse than none —
which is why `scripts/visual-qa.ts` writes to a throwaway directory by default.
This set is committed anyway, for one reason: §29's acceptance asks a person to
approve what the product actually looks like, and a decision somebody has to
re-run a twenty-minute harness to see is a decision nobody makes. Deleting these
files breaks no test.

| | |
| --- | --- |
| Commit | `6c4c91cbf8fb10567781cf8e108d1a16271a40ba`, plus the working-tree changes to `scripts/visual-qa.ts`, `client/src/russell/design.css`, `client/src/russell/RussellShell.tsx` and `tests/step12bResponsive.test.tsx` described under **Defects** below |
| Taken | 2026-09-12, 22:26–22:36 UTC |
| Command | `npx tsx scripts/visual-qa.ts <dir>` |
| Browser | Chromium 141.0.7390.37, headless, `--hide-scrollbars` |
| Server | a real Brain booted against a throwaway data directory, ordinary seed, signed in as a real account |
| Images | 390 × 844 phone at `deviceScaleFactor: 1`, full page (`captureBeyondViewport`), except the two 360px ones |

Nothing here is a mock. Every screen is the built client served by the server,
every move in the journey is a press on a real control, and every number in this
file came out of that run.

---

## J — one continuous journey on a phone

The harness used to drive three isolated interactions: each opened its own
address, did one thing and stopped, which proves three controls and nothing
about the path between them. It now walks **one browser, one session and one
scroll history**. After the first address nothing navigates — every move is a
press, and a step whose control is missing is reported rather than crashing the
run.

Two readings are taken at **every** step, from the same two predicates the
822–953px band sweep uses:

- `document.documentElement.scrollWidth > window.innerWidth` — the page body
  scrolling sideways, which §29 forbids.
- content cut off inside a container whose `overflow-x` is `hidden` or `clip`.
  `auto` and `scroll` are deliberately out of scope: a container a person can
  scroll is how they reach the content, and flagging the tab strip for
  scrolling was a finding about the harness rather than about the build.

And a third, which is what found the defect below: every thumb-bar cell and the
send button are asked `document.elementFromPoint` at their own centre. A box of
the right size in the right place is still not a control if something else is
painted over it.

**Every step of the final run fits, at 390px and at 360px. No page scrolls
sideways, and nothing is cut off inside a clipping container.**

The pending turn at step 03 is §24 holding rather than a failure: no inference
is bought, so Russell's reply persists as `PENDING` carrying the server's own
reason — *"This is waiting to be handed to a worker."* — and a worker answers it
later. The journey reads that sentence and moves on.

| Image | Width | Step | What it shows |
| --- | --- | --- | --- |
| `journey-01-home.png` | 390 | 1 — land on Brain | The state sentence, the foundations strip, the docked command bar, and a thumb bar of six destinations **plus More**. |
| `journey-02-conversation.png` | 390 | 2 — open a conversation | Reached by pressing the thread in the list on home, not by navigating to its address. |
| `journey-03-said-something.png` | 390 | 3 — say something | The message the server stored, and Russell's `PENDING` turn with its own reason beneath it. |
| `journey-04-work.png` | 390 | 4 — Work | Reached by pressing its cell in the thumb bar. |
| `journey-05-project-map.png` | 390 | 5 — the project, Map tab | The constellation at 390px. **This is the one image with an unfixed defect in it** — see below. |
| `journey-06-project-maps.png` | 390 | 6 — Other maps | Reached from the project's own tab strip, which scrolls sideways inside itself (§29 allows a tab strip its own scroller). |
| `journey-13-needs-you.png` | 390 | 13 — Needs you | The decision surface, reached from the thumb bar. |
| `journey-14-back-home.png` | 390 | 14 — back home | Pressing Russell in the thumb bar returns to step 1. |
| `journey-15-everywhere-from-390.png` | 390 | reachability | The More sheet open: Search, Build, Connected sites, the depth control, Full console, Sign out. |
| `journey-16-thumb-bar-360.png` | 360 | the narrower phone | Seven cells still fit, and the composer's hint is one line rather than half of a second. |
| `journey-17-everywhere-from-360.png` | 360 | reachability | The same fifteen controls, reachable at the narrower width too. |
| `before-01-home-no-more.png` | 390 | **before** | The same screen before the fix: six cells and no More. Search, the depth control, Build, Connected sites, the full console and Sign out had no path on a phone at all. |

---

## H — the six maps at phone width

Every map type was selected by pressing its tab, at 390px, and two different
questions were asked of each.

**The picture and the list must be the same graph.** The outline comes from the
server in the same pass as the nodes, so a diagram holding more or fewer things
than its own list would be two derivations that can disagree — which is the
failure the one-pass rule exists to prevent. Measured as the count of
`.rs-map-node` against the count of rows in the outline:

| Map | Drawn | Listed | Reads |
| --- | --- | --- | --- |
| System | 9 | 9 | *What this project is made of, and how the parts connect.* |
| Workflow | 0 | 0 | empty: *No work has been started here yet.* |
| Knowledge | 8 | 8 | empty: *Nothing has been concluded, assumed or questioned here yet.* |
| Decisions | 8 | 8 | empty: *No decisions have been recorded for this project yet.* |
| Timeline | 1 | 1 | *What happened, in order.* |
| Money flow | 0 | 0 | empty: *Brain records no money for this project. The figures live in the connected system, which keeps them deliberately — so there is nothing here to draw.* |

Knowledge and Decisions draw eight things and still say nothing has been
concluded, and that is honest rather than contradictory: the eight are the
project's foundations, drawn as the scaffolding the knowledge would hang on, and
the sentence is about the knowledge rows, of which there are none.

**An empty map must say why.** A blank canvas with no sentence cannot be told
from one that failed to load. Every empty map above carries its reason.

**The money-flow map is the strong case and it passes**: nothing drawn, *"0
things, 0 connections"*, and a sentence saying the figures belong to the
connected site and stay there (§25). It draws no edges it does not have.
Inventing arrows to finish a diagram is an invented citation one altitude down.

**The outline is reachable, not merely present.** Both are always in the
document — the toggle changes which is shown — so the run presses *Show it as a
list* on a map that has something to list and captures the result.

| Image | Width | What it shows |
| --- | --- | --- |
| `journey-07-map-system.png` | 390 | System: 9 things, 8 connections, laid out by depth, no overlap. |
| `journey-08-map-workflow.png` | 390 | Workflow: empty, with its reason. |
| `journey-09-map-knowledge.png` | 390 | Knowledge: the foundations drawn, and the sentence about the knowledge rows. |
| `journey-10-map-decisions.png` | 390 | Decisions: the same shape, its own sentence. |
| `journey-11-map-timeline.png` | 390 | Timeline: one event. |
| `journey-12-map-money-flow.png` | 390 | Money flow: nothing drawn, nothing claimed, and the reason in words. |
| `journey-12b-map-as-a-list.png` | 390 | The System map as its outline — the same nine things, indented by depth. |

---

## O — what a person still has to approve, and what they are approving

This half is the evidence. **The approval itself is the owner's and has not
happened**; nothing in this file claims it has.

What the run establishes, and only this: at 390px and 360px the shell does not
scroll sideways, nothing is clipped inside a clipping container, every one of
the fifteen chrome controls can be pressed, and the maps say what they can and
cannot draw. Whether the result is *good* is a judgement a picture invites and a
harness cannot make.

The one thing a person is being asked to look at first is
`journey-05-project-map.png`, which has a real defect in it that is **not
fixed** — see below.

---

## Defects this run found

### Fixed — no phone path to six controls

`.rs-shell-bar .rs-rail-foot` was `display: none`. That one declaration took
**Search, the depth control and the whole More menu** off a phone, and with More
went Build, Connected sites, the full console and **Sign out**. A person on a
phone could not sign out.

Every assertion in `tests/step12bResponsive.test.tsx` passed the entire time,
and `RussellShell.tsx` had carried a `mode === 'BAR'` branch inside that menu —
written specifically for phone width, for exactly the two secondary
destinations — which nothing could ever reach, because the element holding the
menu was not rendered at the only width the branch is for.

The fix is the one the component's own documentation already described: at
thumb-bar width the foot becomes the bar's seventh cell holding More, and Search
and the depth control move *into* that sheet, which is what More already meant
here. The sheet is `position: fixed` so the bar's deliberate `overflow-x:
hidden` cannot clip it; the bar is not opened up for the sheet.

Before: `before-01-home-no-more.png`. After:
`journey-15-everywhere-from-390.png` and `journey-17-everywhere-from-360.png`.

The harness's first version of this reported it as `Build: no box at all` on
every one of seventeen steps. That was pointing at something real with a
predicate that cannot tell a control silently dropped from one the shell
deliberately renders elsewhere, so the question moved to where it belongs: a
declared list of what a person must be able to get to, checked by opening the
sheet and reading what is actually pressable.

### Fixed — the composer's hint cut in half at 360px

The box is one row tall, so at 360px *"Ask Russell, or tell it something…"*
wrapped and the thumb bar sliced its second line. It fits at 390px, which is why
a sample at one phone width would have missed it and why §24 names two.

`white-space: nowrap` on the placeholder is what fixes it — the hint now ends at
the edge of the box instead of spilling into the nav. `text-overflow: ellipsis`
is declared with it and **Chromium 141 renders no ellipsis on a textarea
placeholder**, so there is no character saying "there is more of this"; the
declaration is kept because an engine that honours it is strictly better. That
is a measurement from this run, not an assumption.

See `journey-16-thumb-bar-360.png`.

### Not fixed — the constellation overlaps its own nodes at phone width

    05-project-map: 9 nodes on a 316×316 canvas
    constellation: 9 nodes, 9 overlapping pair(s)
      Which opportunities ar × How we actually do the (2385px²)
      How the market works   × The different kinds of  (1430px²)
      Deal Dispatch          × How Brain learns what   (888px²)

`Constellation.tsx` places its nodes absolutely, so two that overlap are two
buttons where a person can press only one — and the covered label is not hard to
read, it is gone. `journey-05-project-map.png` shows *"Which opportunities are
worth it"* reading as *"W… opportunities are worth it"* and the nucleus itself
covered.

This is the defect that file's own header names first, and its documented
stagger — alternating every second node onto `0.62` of the radius — was written
as the fix for it. The measurement says the fix does not hold at nine nodes: the
inner ring lands 65–80px from the centre while a node's half-width alone is up
to 80px, so an inner node cannot clear the nucleus at any label size. It is not
a tuning problem. Seating nine labels at 390px needs a different layout for the
dense phone case — a taller canvas, a different arrangement, or fewer nodes at
once — and that is a design decision with a visual outcome, which is exactly the
thing §29 reserves for the owner rather than for whoever measured it.

So it is measured, photographed and left alone, and `scripts/visual-qa.ts` exits
non-zero while it stands.

### Not fixed, and not this scenario — Needs you contradicts itself

`journey-13-needs-you.png` reads **"Nothing needs your decision"** directly above
**"Russell may not start research on this project"**, with the nav badge showing
`1`. The empty-inbox card is keyed on `russell_human_requests` being empty; the
standing authority beneath it renders unfolded precisely because no grant exists
and nothing can proceed until one does. Both are behaving as written and the
screen argues with itself.

§29 names this exact shape — *"a status that contradicts the control beside it
is worse than no status: it teaches a person to stop reading it"* — and records
it as corrected once already, for the briefing and the badge. This is the third
reader of the same fact.

Not fixed here: it is a product-content decision rather than a layout defect,
and it needs the authority state where the empty-inbox sentence is decided.
Recorded with the image so somebody can act on it.

---

## The run, verbatim

The journey half of the final run's output, unedited:

```
One journey on a 390×844 phone, pressing real controls:
  01-home            arrived  fits  BAR
  02-conversation    arrived  fits  [opened the thread already there] /conversation/rcv_a27636401b554fc99213
  03-said-something  arrived  fits  2 turn(s), Russell says: This is waiting to be handed to a worker.
  04-work            arrived  fits  /work
  05-project-map     arrived  fits  9 nodes on a 316×316 canvas
    constellation: 9 nodes, 9 overlapping pair(s) — Which opportunities ar × How we actually do the (2385px²) | How the market works × The different kinds of (1430px²) | Deal Dispatch × How Brain learns what  (888px²)
  06-project-maps    arrived  fits  6 kinds of map offered
  the six maps, at phone width:
    System       9 drawn /  9 listed  fits  What this project is made of, and how the parts connect.
    Workflow     0 drawn /  0 listed  fits  empty: No work has been started here yet.
    Knowledge    8 drawn /  8 listed  fits  empty: Nothing has been concluded, assumed or questioned here yet.
    Decisions    8 drawn /  8 listed  fits  empty: No decisions have been recorded for this project yet.
    Timeline     1 drawn /  1 listed  fits  What happened, in order.
    Money flow   0 drawn /  0 listed  fits  empty: Brain records no money for this project. The figures live in the
    outline      shown
  13-needs-you       arrived  fits  Russell Work Ideas Knows Who Needs you 1 More Needs you Nothing needs your decis
  14-back-home       arrived  fits  /
  reachable at 390px (sheet opened): Russell · Work · Ideas · Knows · Who · Needs you · More · Search · Build · Connected sites · Normal · Interested · Technical · Full console · Sign out
  thumb bar at 360px: Russell · Work · Ideas · Knows · Who · Needs you1 · More
  reachable at 360px (sheet opened): Russell · Work · Ideas · Knows · Who · Needs you · More · Search · Build · Connected sites · Normal · Interested · Technical · Full console · Sign out

1 finding(s) from the phone journey:
  05-project-map: 9 constellation node pair(s) painted over each other at 390px — Which opportunities ar × How we actually do the (2385px²) | How the market works × The different kinds of (1430px²) | Deal Dispatch × How Brain learns what  (888px²)
```

And the band the rejected September 11 build clipped in, swept at its edges and
its middle rather than sampled at one width:

```
Sweeping the 822-953 band that the rejected build clipped in:
  nothing clips at any of 822, 860, 900, 953px across 6 destinations
```

The only console errors in the whole run were six per viewport from the Google
Fonts stylesheet being reset by this machine's outbound proxy — an environment
fact, named as one rather than filtered out, with the page rendering on its
fallback stack.
