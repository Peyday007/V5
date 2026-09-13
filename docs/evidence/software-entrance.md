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
