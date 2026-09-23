# Goal ownership — production evidence

Every figure here was read from the production Brain through the `Goals`,
`Closeout report` and `Dispatch diagnose` workflows, each of which prints the
container's own `SERVING_REVISION`. Nothing below was composed; ids resolve to
rows.

## Before: nothing held a goal

Deploy 329 released `e5928ce` (migration 092 / pg 083). The first read:

```
SERVING_REVISION e5928ce8fe9348cf3cc484040f823ae8eab1fdf2
BRIEFING No goals are set. Brain is doing the work it was asked for, but nothing here says what that work is for.
UNFILED 81 piece(s) of recorded work no goal accounts for
GOALS: OK goals=0 unfiled=81
```

Eighty-one live pieces of work — approved change requests, running missions,
missions parked at a decision — and not one statement of what any of it was
for. The work register had shipped and never been used, so *"what happened,
what is happening, what is next, what needs me"* had no answer anywhere.

## Real work filed as goals

Filed from existing rows with each row's own words as the intent (`goals file
--from`), attributed to the owner's administrator account. Nothing invented:

| Goal | Filed from | Kind of work |
| --- | --- | --- |
| `wst_9241ac4d679f433aa6d2` | campaign `fcp_189ea30c7ded4e7b9280` | software change — PR #31 |
| `wst_c6cf9b5b6e8e458ba5b2` | mission `rms_ae1b7213f56d4a039067` | research — which puzzles are sold |
| `wst_0446f024a2ad4bdcbfb0` | mission `rms_e808c115a1fd4443becf` | dealflow — landed cost, dump trucks BY→RU |
| `wst_fb7ccabc29f9478a8bcc` | mission `rms_3d5809c225f047829cfb` | research — the Depositphotos opening |

## What the first reading of real goals showed, and was fixed

1. **A merge request for a merged PR.** The PR #31 goal put *"Read and merge
   PR #31"* in Needs You. PR #31 had merged. A campaign reads `PR_READY` for
   ever; the attested `PULL_REQUEST` link the factory writeback records from
   the forge is what knows about the merge, and the goal now reads it
   (`b79353b`).
2. **A goal stopped at a person ranked as workable.** The dump-truck goal —
   mission `NEEDS_HUMAN` since 2026-09-21, both bins `NEEDS_HUMAN` — held rank
   2 and bin priority 7. A goal with a decision and no runnable bin is no longer
   workable (`b79353b`).
3. **"Queued" over a bin nothing would fire.** See the interruption below
   (`a136d2a`).

## The interruption: pause, then resume, with no stage button

On `e5928ce`, the puzzle goal's only bin `bin_c7e1132d0cb54b25ad22` was READY
at priority 8.

- **17:29:58Z** `goals pause wst_c6cf9b5b6e8e458ba5b2`.
- Next read, the tick had acted by itself:
  ```
  GOAL wst_c6cf9b5b6e8e458ba5b2  PAUSED
    bin    bin_c7e1132d0cb54b25ad22 READY priority=8 attempts=0/5 HELD(GOAL_PAUSED)
    next   [PERSON] Resume it when you are ready. 1 bin(s) are held meanwhile, with every lease, attempt and result kept.
  GOAL wst_fb7ccabc29f9478a8bcc  (Depositphotos)
    bin    bin_c16805ee268543658a94 READY priority=7
    moved  2 → 1 at 17:30:27.393Z: below the goal above it because that one: it pursues money directly …
  ```
  The freed capacity went to the next goal: its bin moved from priority 6 to 7,
  and the move is recorded with the fact that caused it.
- **17:32:57Z** `goals resume` — the command changes one column and prints what
  the tick will do. It advances no stage.
- **17:33:20Z** the tick released the hold; **17:33:25Z** the puzzle goal went
  back to rank 0 and the Depositphotos goal back to rank 2 / priority 6.
- The bin's own trace (`Dispatch diagnose`, `bin_c7e1132d0cb54b25ad22`): the
  dispatcher considered it at 17:23:03, **not at all during the hold**, and again
  at **17:34:09** — the first dispatch tick after the release. Attempts stayed
  0/5 and the generation stayed 0 throughout: nothing was spent or reset.

## What the trace also showed: the goal view had been wrong

The same trace showed every dispatch decision since **14:01:00Z** refusing the
bin as `NO_SURFACE_SERVES_THIS_PROJECT`, and `fleet show` explained why: every
Routine bound to `wkr_1cdd82cfb2a54faf8edd` — the only worker with membership on
Cash Mode 1 — was `QUARANTINED` between 12:15 and 13:59Z for *"3 consecutive
fired sessions never checked in"*. The goal had said *"queued; Brain fires the
next free Routine"*, which was not true and would not become true.

`a136d2a` makes a goal read its bins' dispatch intents. An operator-class
refusal is a blocker, and for this refusal the remedy names the Routines that
would serve the project, their state and recorded reason, and what brings them
back.

## What is still blocked, and on whom

Cash Mode 1's research cannot run until the Brain connector behind Brain
Research A, 1-B, 1-C, 1-D and Airyn 2-A…2-D authorizes again. That is a Claude
account action no code here can take (§22: the surface owns whether a worker may
act), followed by one operator command per Routine to lift the quarantine.
