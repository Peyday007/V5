# Step 12B — what the product looks like, walked

**This is the record of one run at one commit. It is not a baseline, and nothing
compares anything to it.** A screenshot in a repository is stale the moment the
CSS changes, and a stale one that still looks like evidence is worse than none —
which is why `scripts/visual-qa.ts` writes to a throwaway directory by default.
This set is committed anyway, for one reason: §29's acceptance asks a person to
approve what the product actually looks like, and a decision somebody has to
re-run a twenty-minute harness to see is a decision nobody makes. Deleting these
files breaks no test — it drops J back to what the code alone can say.

| | |
| --- | --- |
| Commit | `d62f64392a8b9db9c28e8bb93e35468c389827f7` |
| Taken | 2026-09-13, 15:41 UTC |
| Command | `npx tsx scripts/visual-qa.ts <dir> --renders docs/evidence/step12b-renders` |
| Browser | Chromium, headless, `--hide-scrollbars` |
| Server | a real Brain booted against a throwaway data directory, ordinary seed, signed in as a real account |
| Images | 390 × 844 phone at `deviceScaleFactor: 1`, full page (`captureBeyondViewport`), except the four 360px ones |
| Findings | **0** |

Nothing here is a mock. Every screen is the built client served by the server,
every move in the journey is a press on a real control, and every number in this
file came out of that run. `journey.json` beside these images is the same run in
machine-readable form, and it is what `scripts/step12b-acceptance.ts` reads —
this file is for a person.

---

## J — one continuous journey on a phone, that changes something

The harness used to drive three isolated interactions: each opened its own
address, did one thing and stopped, which proves three controls and nothing
about the path between them. It walks **one browser, one session and one scroll
history** — after the first address nothing navigates, and every move is a press.

**And the owner's objection to the first version of that was exact:** *"The 14
entries mostly demonstrate navigation and layout."* They did. A step that
arrived is a fact about routing. So the journey now **does** something, and the
doing is the evidence:

1. approves the standing authority — the one decision a project cannot proceed
   without — by pressing Approve on Needs You;
2. opens one idea a connected site asked about, and **overrules Russell's own
   priority on it**, typing the reason the control requires;
3. waits while Russell judges that idea, compiles a specification, launches a
   mission, and the packet stops **outside what was preauthorized**;
4. answers that decision with a thumb — *Authorize this plan and let it run*;
5. reads the same mission carrying on, then Knows, then Who.

Every one of those is read back out of the rows, through the product's own
routes, **inside that same journey**:

| | |
| --- | --- |
| standing authority | granted, and still there |
| the idea | priority `MUST_DO`, overridden by a person, and Russell's own judgment kept beside it |
| the parked mission | `rms_c48e96d27b51438098e0` · **NEEDS_HUMAN → RUNNING** |
| its request | `rhr_c442765bf6144e8c9a9f` · settled |
| its packet | `orc_bd5188acdca2442189bd` |
| the work, on screen | identified by the ids Brain wrote: `Mission=rms_c48e96d27b51438098e0 Packet=orc_bd5188acdca2442189bd Bin=bin_d94695e5b3ac44daa5c2 State=NEEDS_HUMA` |
| its result | **none yet** — 0 conclusion(s) in the project, 0 citing this mission, no filed document |
| the question asked | Russell's turn is **PENDING** |

**The last two are the honest open ones, and they are open on purpose.** A
conclusion needs a claim through `gate.ts` and a judge's verdict; an answered
question needs a worker to take the bin. Neither is something a checkout Brain
with no fleet can produce, and inventing either would be inventing a research
result. They are carried into gate J as conditions needing PRODUCTION rather
than passed from a screen that merely loaded — which is the correction the
owner asked for after the first version of this leg awarded a pass from
arriving at `/knowledge`.

**Three readings are taken at every step.** The first two are the predicates the
822–953px band sweep uses: the page body scrolling sideways, which §29 forbids;
and content cut off inside a container whose `overflow-x` is `hidden` or `clip`
(`auto` and `scroll` are deliberately out of scope — a container a person can
scroll is how they reach the content). The third is what found the thumb-bar
defect: every chrome control and the send button are asked
`document.elementFromPoint` at their own centre, because a box of the right size
in the right place is still not a control if something else is painted over it.

**22 of 22 steps arrived, 22 of 22 fit, 22 of 22 clipped nothing, and no chrome control
was unreachable at 390px or 360px.**

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
| `journey-05-project-map.png` | 390 | 5 — the project, Map tab | The constellation at 390px, as a spine. No overlapping pair. |
| `journey-06-project-maps.png` | 390 | 6 — Other maps | Reached from the project's own tab strip, which scrolls sideways inside itself (§29 allows a tab strip its own scroller). |
| `journey-07…12b-*.png` | 390 | 7–12 — the six maps | One per kind, plus the System map as its own outline. See below. |
| `journey-13-needs-you.png` | 390 | 13 — Needs you | The decision surface, after the journey has answered everything on it. |
| `journey-14-back-home.png` | 390 | 14 — back home | Pressing Russell in the thumb bar returns to step 1. |
| `journey-15-ideas.png` | 390 | 15 — Ideas | The backlog with the site's request in it, carrying the priority Russell formed. |
| `journey-16-open-the-idea.png` | 390 | 16 — one idea | Russell's own judgment on it: the priority, and the sentence behind it. |
| `journey-17-changed-the-priority.png` | 390 | 17 — **disagree** | A person overruling Russell, with the reason the control requires. The screen reads back *"You already overruled Russell here…"*, which comes from the row rather than from the click. |
| `journey-18-the-parked-decision.png` | 390 | 18 — **the decision Brain could not take** | Written by `parkStoppedMissions` from the packet's own recorded status, offering the answers `choicesFor` says this packet can actually take. |
| `journey-19-authorized-the-plan.png` | 390 | 19 — **answered** | §16's other way a start gets authorized: the same `approvePlan` the envelope calls, recorded as this person's decision. |
| `journey-20-the-mission-resumed.png` | 390 | 20 — **the same mission, carrying on** | Its own card, found by the objective on it. Not a replacement started beside it — the id is the one that was parked. |
| `journey-21-what-the-work-actually-is.png` | 390 | 21 — **what the work actually is** | The reader turns the depth up to Technical from the More sheet and opens *"How it is being done"*. The ids are the mission, its packet and its bin — and the filed document, once there is one. |
| `journey-22-knows.png` | 390 | 22 — Knows | What the project believes, **read** rather than arrived at: a conclusion and what it rests on, or the server's own sentence for why there is none. |
| `journey-23-who-and-fleet.png` | 390 | 23 — Who | The people on the project and the fleet behind it. |
| `journey-23-everywhere-from-390.png` | 390 | reachability | The More sheet open: Search, Build, Connected sites, the depth control, Full console, Sign out. |
| `journey-24-thumb-bar-360.png` | 360 | the narrower phone | Seven cells still fit, and the composer's hint is one line rather than half of a second. |
| `journey-25-everywhere-from-360.png` | 360 | reachability | The same fifteen controls, reachable at the narrower width too. |
| `journey-26-constellation-360.png` | 360 | the constellation | The spine at the narrowest width the harness looks at. |
| `before-01-home-no-more.png` | 390 | **before** | The same screen before the fix: six cells and no More. Search, the depth control, Build, Connected sites, the full console and Sign out had no path on a phone at all. |

---

## H — the six maps at phone width

Each map is built over the project's real rows and compared to its own outline
in the same pass, so a diagram and the list beside it cannot describe different
graphs. An empty map is an **answer**: the money-flow map draws nothing because
the margin, the costs and the contacts belong to the connected site and stay
there (§25), and inventing edges to finish a diagram is an invented citation one
altitude down.

| Image | Width | What it shows |
| --- | --- | --- |
| `journey-07-map-system.png` | 390 | System: the things this project is made of, and how they connect. |
| `journey-08-map-workflow.png` | 390 | Workflow: empty, with its reason. |
| `journey-09-map-knowledge.png` | 390 | Knowledge: the foundations drawn, and the sentence about the knowledge rows. |
| `journey-10-map-decisions.png` | 390 | Decisions: the same shape, its own sentence. |
| `journey-11-map-timeline.png` | 390 | Timeline: what happened, in order. |
| `journey-12-map-money-flow.png` | 390 | Money flow: nothing drawn, nothing claimed, and the reason in words. |
| `journey-12b-map-as-a-list.png` | 390 | The System map as its outline — the same things, indented by depth. |

---

## The three widths, and the band between them

`desktop-*`, `intermediate-*` and `phone-*` are six destinations at 1180, 953
and 390 pixels. `*-needs-you.png` is the **populated** Needs You — a project with
no standing grant has exactly one decision outstanding and the page refuses to
fold it — and `*-needs-you-settled.png` is the same address after the journey
answered it. Two real states of one screen, separated by one press on a real
control.

The order matters and was got wrong once: capturing the settled state *before*
the journey granted the authority first, which meant a freshly captured idea was
judged and launched within a tick and there was nothing left in the backlog for
the journey's override step to press. Three findings, all of them the harness
racing the product it was measuring. The settled capture happens after the
journey now.

```
Sweeping the 822-953 band that the rejected build clipped in:
  nothing clips at any of 822, 860, 900, 953px across 6 destinations
```

That band is not an arbitrary sample: it is where a rail, a main column and a
detail column stop fitting side by side, and it is exactly where a viewport
media query lies about how much room a component has. The rejected September 11
interface clipped in it.

---

## The constellation, measured at every width

A ring cannot seat nine labels on a 316px canvas — at a 390px viewport the inner
ring would land 59–75px from the centre while a node's half-width alone reaches
73px, so an inner node cannot clear the nucleus at *any* label size. Below
`RING_MIN_CANVAS` the same graph is drawn as a **spine**, and the difference
that matters is not how it looks: the ring is only known not to overlap for the
labels this projection produces, while two nodes in two grid cells are disjoint
whatever the label does.

```
   1180px  orbit    9 drawn /  8 listed   866×541   0 overlapping pair(s)
    953px  spine    9 drawn /  8 listed   647×256   0 overlapping pair(s)
    390px  spine    9 drawn /  8 listed   316×341   0 overlapping pair(s)
    390px  spine   10 drawn /  9 listed   316×434   0 overlapping pair(s)
    360px  spine    9 drawn /  8 listed   286×358   0 overlapping pair(s)
```

One more node than row, not the same number: the diagram draws the nucleus and
its children while the list beside it is the children.

---

## O — what a person still has to approve, and what they are approving

This half is the evidence. **The approval itself is the owner's and has not
happened**; nothing in this file claims it has, and nothing under `scripts/` can
record it — a test asserts that no module there imports the writer but
`admin.ts`.

What this run establishes, and only this: at 1180, 953, 390 and 360 pixels the
shell does not scroll sideways, nothing is clipped inside a clipping container,
every chrome control can be pressed, the maps say what they can and cannot draw,
and the journey's presses reach the rows. Whether the result is *good* is a
judgement a picture invites and a harness cannot make.

`docs/evidence/step12b-renders/` is the set the approval is actually **of** —
four screens at three widths, declared in `index.json` with a digest over the
bytes, which is what `design_approvals` binds a decision to.

---

## The run, verbatim

The journey half of this run's output, unedited:

```
One journey on a 390×844 phone, pressing real controls:
  01-home            arrived  fits  BAR
  02-conversation    arrived  fits  [opened the thread already there] /conversation/rcv_9ba057b4714d4642b0e7
  03-said-something  arrived  fits  2 turn(s), Russell says: This is waiting to be handed to a worker.
  04-work            arrived  fits  /work
  05-project-map     arrived  fits  10 nodes on a 316×434 canvas
    constellation at 390px: spine — 10 node(s) on a 316×434 canvas, 9 listed beside it, 0 overlapping pair(s)
  06-project-maps    arrived  fits  6 kinds of map offered
  the six maps, at phone width:
    System      10 drawn / 10 listed  fits  What this project is made of, and how the parts connect.
    Workflow     0 drawn /  0 listed  fits  empty: No work has been started here yet.
    Knowledge    8 drawn /  8 listed  fits  empty: Nothing has been concluded, assumed or questioned here yet.
    Decisions    8 drawn /  8 listed  fits  empty: No decisions have been recorded for this project yet.
    Timeline     3 drawn /  3 listed  fits  What happened, in order.
    Money flow   0 drawn /  0 listed  fits  empty: Brain records no money for this project. The figures live in the
    outline      shown
  needs-you answer   approved, and the card swapped its control
  15-ideas           arrived  fits  10 node(s): Deal Dispatch · How the market works · The different kinds of deals 
  16-open-the-idea   arrived  fits  [opened Parcel 118 — how long recording takes in] Russell says Worth doing
  17-changed-the-priority arrived  fits  You already overruled Russell here: The site is waiting on this one, so it goes 
  waiting for Russell to reach a decision it cannot take…
  the parked decision  mission rms_c48e96d27b51438098e0 parked at NEEDS_HUMAN, request rhr_c442765bf6144e8c9a9f
  18-the-parked-decision arrived  fits  Authorizing research Brain was not preauthorized to start. B — offers: Authorize
  19-authorized-the-plan arrived  fits  [chose Authorize this plan and let it run] Russell Work Ideas Knows Who Needs you 1 More Needs you Nothing needs your decis
  20-the-mission-resumed arrived  fits  Establish, from official Michigan public records,  — waiting on The proposed pla
  21-what-the-work-actually-is arrived  fits  [turned the depth up and opened the mission’s detail] Mission=rms_c48e96d27b51438098e0 Packet=orc_bd5188acdca2442189bd Bin=bin_d94695e
  22-knows           arrived  fits  nothing concluded yet — There is nothing here yet.
  23-who-and-fleet   arrived  fits  Russell Work Ideas Knows Who Needs you 1 More Who visual-qa@example.invalid (you
  the work, identified on screen by its own ids — Mission=rms_c48e96d27b51438098e0 Packet=orc_bd5188acdca2442189bd Bin=bin_d94695e5b3ac44daa

What the journey changed, read back from the rows:
  standing authority   granted, and still there
  the idea             priority MUST_DO, overridden by a person, and Russell’s own judgment kept beside it
  the parked mission   rms_c48e96d27b51438098e0 NEEDS_HUMAN → RUNNING, its request settled
  what Russell knows   0 conclusion(s), 0 citing rms_c48e96d27b51438098e0, no filed document yet
  the question asked   Russell's turn is PENDING
  work                 0 group(s) after the change
  13-needs-you       arrived  fits  Russell Work Ideas Knows Who Needs you 1 More Needs you Nothing needs your decis
  14-back-home       arrived  fits  /
  reachable at 390px (sheet opened): Russell · Work · Ideas · Knows · Who · Needs you · More · Search · Build · Connected sites · Normal · Interested · Technical · Full console · Sign out
  thumb bar at 360px: Russell · Work · Ideas · Knows · Who · Needs you1 · More
  reachable at 360px (sheet opened): Russell · Work · Ideas · Knows · Who · Needs you · More · Search · Build · Connected sites · Normal · Interested · Technical · Full console · Sign out
  constellation at 360px: spine — 9 node(s) on a 286×358 canvas, 8 listed beside it, 0 overlapping pair(s)
```

The only console errors in the whole run were from the Google Fonts stylesheet
being fetched through this machine's outbound proxy — an environment fact, named
as one rather than filtered out. The two font hosts are answered from Node,
which does have the proxy, so the captures render in the product's real
typefaces rather than on a fallback stack: type sets every label width, and a
label width is what an overlap is made of.
