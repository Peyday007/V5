# The software entrance, as it actually renders

**This is the record of one run at one commit. It is not a baseline, and nothing
compares anything to it.** Same rule as `step12b-visual.md`, for the same reason:
a screenshot in a repository is stale the moment the CSS changes, and a stale one
that still looks like evidence is worse than none. Deleting these four files
breaks no test.

| | |
| --- | --- |
| Commit | `2ae74d9`, plus the working-tree change to `scripts/visual-qa.ts` described below |
| Taken | 2026-09-13, 05:15–05:50 UTC |
| Command | `npx tsx scripts/visual-qa.ts <dir>` |
| Browser | Chromium, headless, `--hide-scrollbars`, `deviceScaleFactor: 2` |
| Server | a real Brain booted against a throwaway data directory, signed in as a real account |

Nothing here is a mock. It is the built client served by the server.

## What the harness gained, and the one thing it seeds

`build` is now a captured destination. It was never photographed — it sits behind
the More menu rather than on the rail, which is exactly the kind of place a
layout defect survives, and §29 records one that did.

**One row is seeded, and it says so.** Everything else the harness photographs is
whatever an ordinary boot produces, which is the right default. This exception is
a `PROPOSED` software request and the repository onboarding that gives it
somewhere to run, both written the way the product writes them —
`captureSoftwareChange` and `onboardRepository`, against the envelope's own grant.
Nothing is widened and nothing is authorized: `PROPOSED` is the only state a
capture can produce, and it stays that way unless somebody presses the button in
the image. The alternative was a worker turn against a fleet this harness
deliberately does not have.

**A capture that comes back empty is now a finding rather than a crash.**
`captureBeyondViewport` occasionally answers a tall page with no `data`, and
passing that to `Buffer.from` threw `ERR_INVALID_ARG_TYPE` from inside the loop
and ended the run — after fifteen captures had been taken and before any was
reported. One retry, then it is named and the sweep carries on. It fired once, on
`intermediate needs-you`, and did not recur on the next run.

---

## Needs You — the authorization card

`docs/evidence/software-entrance/desktop-needs-you.png`
`docs/evidence/software-entrance/phone-needs-you.png`

The card renders under **Changes to your sites**, below the standing authority
and above nothing, with:

- `WAITING FOR YOU`, the title, the objective and the expected outcome;
- **the reach, in the server's own sentence** — *"Only docs/ in
  peyday007/brain-worker-bootstrap. Anything outside that is rejected whole, and
  nothing is merged or deployed without you."* — composed by `repositoryChoicesFor`
  and travelling down with the repository choice, so the reach a person is shown
  and the reach `resolveProjectScope` enforces are one object;
- **Authorize** and **Not this**, immediately under it.

The nav badge reads **2**: the standing approval and this change. That is the
whole of §29's correction working at a third surface — a decision counted where
the control is, rather than a page saying nobody is needed above one.

An earlier run, before the onboarding was seeded, photographed the *other* branch
and is worth recording as correct: with no repository given to the project the
card offers no button at all and says *"This project has not been given a
repository yet, so there is nowhere to run this. Onboard one on Build →
Repositories, where the directories it may change are declared too."* A state
that says waiting which nobody can resolve is not waiting.

## Build — the boundary with no default

`docs/evidence/software-entrance/desktop-build.png`
`docs/evidence/software-entrance/phone-build.png`

- *"This project may change **docs/**"* — the boundary, read back from the row.
- The question, in the words that say why it is asked now: *"A campaign submitted
  here can narrow this and can never widen it, and narrowing it afterwards would
  not correct an answer that was too broad — so it is asked now."*
- **Both radios unselected**, and the button beneath them **disabled**. That is
  the property, photographed: the widest reach is a choice somebody makes rather
  than the value they get by saying nothing.
- Below it the objective form, its repository selector reading *"— not ready to
  execute"*, because no surface is registered yet.

## Widths

| Reading | Result |
| --- | --- |
| Destinations captured | 7 × 3 widths (1280, 900, 390) |
| Sideways scroll | none, at any width |
| Clipping sweep, 822 / 860 / 900 / 953 | nothing clips, across all 7 |
| Phone journey | 14 steps, every control pressed for real, Needs You and Build both reached through the thumb bar and the More sheet |
| Reachable at 360px | Russell · Work · Ideas · Knows · Who · Needs you · More · Search · **Build** · Connected sites · Normal · Interested · Technical · Full console · Sign out |

## One finding, and it is not this work's

    05-project-map: 9 constellation node pair(s) painted over each other at 390px

The Ideas constellation overlaps its own nodes at phone width. It is on
`Constellation.tsx`, predates this branch, and is unrelated to the software
entrance — recorded here because a harness finding that goes unmentioned is a
harness nobody believes.

---

## The corpus, and what it found

Added after the images above, and it is a reading rather than a picture.
`tests/softwareRequestPhrasing.test.ts` drives ordinary sentences through the
conversational gate. The first run of it, against the gate as it then stood,
found **fifteen misses and two inventions out of fifty** — which is what turned a
fifth widening of the verb list into a change of shape (§27).

The fifty were thirty-one sentences that ask for a change and nineteen that do
not, written before the gate was looked at rather than after:

| | Before | After |
| --- | --- | --- |
| Asks, read as asks | 16 / 31 | 31 / 31 |
| Not asks, read as not asks | 17 / 19 | 19 / 19 |

The committed corpus is that run turned into a declared suite — 28 accepts, 28
declines and the anaphora family, which the fifty could not test because the
answer depends on a row rather than on the sentence. Two of the fifty moved into
it: *"Same fix on the services page"* and *"Apply what we agreed above to the
quotes page"* both name nothing on their own, so they are now correctly declined
in a thread that has asked for nothing and accepted in one that has.

The two inventions are the ones worth naming, because they are the failure
direction that costs something: *"No need to fix the footer, we are replacing it
anyway"* and *"Please do not add anything else to the homepage"* both produced an
authorization card for the change the person had just said not to make.

Nothing in the corpus is a mock of the gate. The anaphora cases run through the
real `captureSoftwareChange`, against a real database, because the referent is a
row and a pure-function test would have passed with the flag hard-coded either
way.

## The clarification sentence is driven, not photographed

`tests/softwareClarification.test.tsx` renders the real `Conversation` against a
scripted server and reads the screen, because the failure this exists to prevent
is precisely a server that answers correctly into a browser that shows nothing.
It is not in the committed images above: those were taken before it existed, and
re-shooting the set for one paragraph would have replaced evidence of a real run
with a newer one that says less. What the driving test cannot prove is the
pixels, and that limit is the same one every jsdom test here carries.

## What driving the assembled path found that the helpers could not

Two defects, both in code whose own tests passed:

1. **The question could not be answered.** Brain displayed *"which project?"*,
   the person typed **"V4"**, and the execution gate declined it — correctly, as
   two characters with no verb. Nothing joined the answer to the question, so the
   only way forward was to retype the instruction.
2. **A mention decided the target.** In a Brain-attached thread, *"Do not change
   Brain, but fix the broken form in V4"* passed the gate and resolved to
   **Brain** — the project ruled out in the same sentence.

`tests/softwareConversationPath.test.ts` is the record: nine walks of
`beginTurn` → a scripted worker answering the bin → the tick, asserting on the
displayed question and on the rows either side of it. The one worth reading is
*"does not file twice when the worker restates the request alongside the
answer"*, because it pins why the resolution returns instead of falling through
— a restated objective is a different submission key, and one answer would
otherwise leave two cards for one decision.

## The reply, read the same way as the request

A third defect the assembled path found, after the two above and in the same
place: Brain asked *"Brain or V4?"*, the person answered **"Not Brain"**, and
the reply — still read for mentions — selected **Brain**.

`tests/softwareConversationPath.test.ts` grew three walks for it, and the two
that keep the question *open* are the ones worth reading:

| Offered | Reply | Result |
| --- | --- | --- |
| Brain or V4 | *Not Brain.* | one `PROPOSED` request against V4, question closed |
| Brain, V4 or V2 | *Not Brain.* | nothing filed anywhere, question still open |
| nothing — Brain ruled out by the request | *Brain.* | nothing filed, question still open; *V4* then files against V4 |

Each asserts the resulting project **and** that exactly one unauthorized
proposal exists, because "it went somewhere" and "it went to one place" are
different facts and only the second one is the fix.
