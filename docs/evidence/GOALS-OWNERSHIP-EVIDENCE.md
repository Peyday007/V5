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

## Deploy 330: the blocker names its remedy, and a restart resumed everything

Deploy 330 released `a136d2a`, restarted the machine, and passed its hosted
verification on both sides of the restart. The first `goals show` afterwards,
from the released container:

```
SERVING_REVISION a136d2a0ef2ef9e73550b63fa04f6b3416171866
BRIEFING 4 active goal(s) · 2 decision(s) wait on you.
GOAL wst_c6cf9b5b6e8e458ba5b2  ACTIVE
  bin    bin_c7e1132d0cb54b25ad22 READY priority=8 attempts=0/5 dispatch=PENDING(NO_SURFACE_SERVES_THIS_PROJECT)
  next   [OPERATOR] Every Routine that serves this project is out of routing — Brain Research A,
         Brain Research 1-B, 1-C, 1-D, Airyn 2-A…2-D (QUARANTINED: 3 consecutive fired sessions
         never checked in …); V2 (QUARANTINED …). … reconnect it there, then lift the quarantine
         (npm run fleet -- set-state --kind routine --to ENABLED). The bin fires on the next tick
         after that, with nothing else to press.
GOALS: OK goals=4 unfiled=78
```

Across the restart nothing was re-entered: the four goals, their holds and
their ranks were re-derived from rows on the first tick, and the priority
history continued (the Depositphotos goal's `2 → 1` at 18:10:44Z is the tick
reacting to the dump-truck goal becoming unworkable, with no command issued).
No trigger reference and no secret name appears anywhere in the reading.

## What that reading still got wrong, and was fixed (`8c52df0`)

1. **It asked the owner to merge PR #31, which merged on 2026-09-22 at
   14:12:44Z** (forge: `merged: true, merged_by: Peyday007`). The merge
   observer is called from `recordCampaignOutcome`, and
   `listCampaignsPendingOutcome` says which finished campaigns still need it —
   but only the *local* `tickAllCampaigns` read that list. The tick production
   runs, `tickAllRemoteCampaigns`, visited live campaigns only, so a finished
   remote campaign was never offered back and the observer ran for nobody. It
   is offered now; the regression drives the hosted tick and was run against
   the unfixed loop to watch it fail (`expected [] to have a length of 1`).
2. **The blocker sentence argued with its own remedy.** It printed the
   dispatcher's text about a missing membership beside a remedy about
   quarantined surfaces, and aged it `0h` because the intent is re-stamped
   every tick. Where every serving Routine is out of routing it now says so,
   aged from when the last one went out.

## Deploy 331: the privacy boundary, read from production — and one check that did nothing

Deploy 331 released the goals boundary check and passed `238/238` before the
restart and `257/257` after it. In the released Brain, both times:

```
Goals, as a member and as a machine
  PASS  a member may read the goals briefing — 200
  PASS  and reads no goal from a project it may not read — 0 goal(s) readable, 0 outside the member's projects
  PASS  a foreign goal existed to compare with — no goal sits outside the member's projects; skipped
  PASS  a worker credential is refused the goals — status 404
```

The third line is a skipped comparison that reads as a pass. It asked the
verification administrator for a goal outside the member's projects, and that
administrator administers only the verification project, so it could never
find one — while four real goals sat in Deal Dispatch and Cash Mode 1. Recorded
rather than rounded up: on deploy 331 the member was shown to read nothing it
should not, and a worker was refused, but the *byte-identical refusal* of a real
foreign goal was not exercised. The harness now takes a live foreign goal from
the rows (filing and archiving one in the holdout only when none exists), also
checks that the refused pause moved nothing, and a guard reads the harness and
fails on the old version.

## Deploy 332: the merge was observed, and the restart window cost the second half

Deploy 332 released `3c1ca73` (carrying `8c52df0`). Seconds after release the
hosted tick offered the finished campaign back to the writeback, and the PR #31
goal read:

```
GOAL wst_9241ac4d679f433aa6d2  COMPLETE
  link   PULL_REQUEST merged=true attested by pull-request-merge-observation at 2026-09-23T20:04:09.790Z
```

The pre-restart verification passed `238/238`. The post-restart half failed on
`GET /api/projects/…/cash: socket hang up` directly after `flyctl` reported
*failed to wait for health checks to pass: context deadline exceeded* — the
restart window §20 records, not a regression: `Record what was released` was
`success`, and deploy 333 re-ran both halves on a later tree.

## Deploy 333: the comparison ran, and was still half vacuous

Deploy 333 released `12ae65e` and passed `241/241` before the restart and
`260/260` after. Both sides printed a real byte-identical refusal of a foreign
goal and a refused pause that moved nothing. The merge observation, the COMPLETE
goal and the quarantine blocker (aged from 13:59:13Z, not `0h`) all survived the
restart, read afterwards from the released container.

Reading that log found two more things wrong with the check itself:

1. **The positive half proved nothing.** *"0 goal(s) readable"* is what a member
   who can read nothing at all would print, so the check could not tell a
   correct boundary from a route that refuses everyone.
2. **It acted on a real person's goal.** The foreign goal it compared against
   was a live production goal, and the refused-pause check POSTed a pause at it
   as the member. The refusal held, so nothing moved — but a release gate that
   depends on a refusal holding in order not to change a person's work is
   testing the boundary with the thing it protects.

`97b4d6f` files both goals itself — one in the member's own verification
project, one in a dedicated `verification-scope-foreign` TECHNICAL project the
member is shown not to belong to — asserts the member reads and opens its own
and is refused the other byte-identically to an id that does not exist, and
archives both in a `finally`. The guard in `tests/goalsHttp.test.ts` reads the
harness and fails on the previous version (`expected 1 to be 2`).

## Operator reads between deploys: a slow database, first misread as a wrapper

From 21:38Z every `factory events` read failed on a pooler connection
timeout, while a one-client goals read at 22:06Z succeeded. `factory.sh` was the
only wrapper defaulting to two pooler clients against §39's rule of one, so
`40afc79` corrected it and made the guard assert the value. **That was right
about the rule and wrong as a diagnosis**: the next factory read failed with
one client too, and the goals read at 22:17Z then failed with
`(EAUTHQUERY) auth_query secret check timed out` — the pooler checking a
credential by querying the database, and the database not answering in time.
The condition was the database, intermittently, and the interleaving was
chance. `/healthz` answered in 0.2s throughout, because it touches no database.

It also showed that the one error naming the database as slow was the one
Brain printed no diagnosis for: neither `describePoolerRefusal` nor the boot
hint recognised `EAUTHQUERY`. Both do now, and say the database rather than the
password or the client count.

## Deploy 334: a release refused by the store, and an outage nobody could end

Deploy 334 (`fa4e3cd`) built, passed its gate, and failed at `flyctl deploy`
with `timeout reached waiting for health checks`. **Nothing was released**: the
step `Record what was released` is `skipped`, the §27 reading that separates a
failed release from a failed gate. The new machine's boot log reads
`Brain could not use the document storage it was configured for` /
`HTTP 544 DatabaseTimeout` — §18 refusing correctly while the database was the
slow one the operator reads had already shown. Infrastructure, not the change.

What was a defect is what followed. The machine served the error, nothing asked
again, and Fly does not restart a machine for a failing health check, so
`/healthz` answered `503` after 35s through the proxy long after a one-client
goals read at 23:44Z showed the database answering again. Recovery needed a
redeploy (335). `server/bootRetry.ts` is the remedy: the same proof, asked
again on a capped backoff, with the error page replaced by the Brain on the
same port once it holds. Proved with a real local boot against a bucket stub
that answered `544` twice and then `200`: error page served, `attempt 1
failed; asking again in 30s`, `The cloud answered`, all 92 migrations applied,
`/healthz` `200` — no restart and no redeploy. `tests/bootRetry.test.ts` pins
the schedule, the single hand-over, and that boot retries `proveCloud` itself;
its wiring assertion fails against the previous `server/index.ts`.

## Deploy 335: the recovery, and the privacy check reading a real foreign goal

Deploy 335 re-released `fa4e3cd` at 00:08:40Z and `/healthz` answered 200 in
0.4s — the end of the 23:12–00:08 outage. Before the restart the harness read
`HOSTED-VERIFICATION: PASS 245/245`, and its goals section is no longer vacuous
in either half: *a member may read the goals briefing — 200*; *reads no goal
from a project it may not read — 1 goal(s) readable, 0 outside*; *does read the
goal in its own project — wst_5a7ed0e628c945c192f2*; *may open that goal —
200*; *another operation's goal is not found — 404*, *byte-identical to a goal
that does not exist (wst_16f9e97d749c4b9f92cc)*; *a worker credential is
refused the goals — 404*.

After the restart the machine answered after four polls, and the harness never
reached it: `DatabaseConfigurationError … (ECHECKOUTTIMEOUT) unable to check out
connection from the pool after 15000ms in Session mode … in: SELECT version()`
at the harness's own connect. That is the pooler condition §27 names and the
same database slowness the operator reads showed all evening — not a finding
about the release, which was live and serving throughout. It is recorded as a
failed half rather than rounded up.

## Deploy 336: refused by its own test gate, and rightly

Deploy 336 (`d59a46a`, the boot retry) never reached Fly: `puzzleIntegrationPass`
failed with `expected 2 to be greater than or equal to 20`, so nothing was
released and production kept serving `fa4e3cd`. The test was right and the code
was wrong: the puzzle batch judged its defect rate after four attempts, and two
unlucky word searches in a row stopped a healthy generator. The fix, a
twelve-attempt sample floor, is recorded in CLAUDE.md §48.

## Deploy 337: released, then a route error ended the process — and the boot retry's first reading

Deploy 337 (`2673fc4`) passed its test gate and released at 02:00:08Z
(`Record what was released: success`). The pre-restart verification passed
(`hosted verification: success`). The post-restart half reached the audit
roles (PRIMARY at 02:18:08, ADVERSARIAL at 02:21:44) and ended at 02:25:29 with
`HOSTED-VERIFICATION: FAIL could-not-complete` / `brain_complete_work: no
result` and an ssh session closed with no exit status. That is not the
`ECHECKOUTTIMEOUT` shape at the harness connect.

The live log, read with `Logs` run 23, says what actually happened, and it is
an application defect rather than noise. At 02:25:29 the Brain's own pool was
exhausted (`10/10 connection(s) in use, 0 idle, 11 caller(s) waiting`), the
timeout was thrown inside `POST /oauth/token` (`getClientByClientId`, routes/
oauth.ts:709), that handler was a `void (async …)()` with nothing to catch its
rejection, and Node 22 ended the process: `Main child exited normally with code:
1`, `reboot: Restarting system`. That exit is what killed the harness's ssh
session. One slow query in one request took every other request down.

The machine rebooted into Supabase's storage API answering `544
DatabaseTimeout`, and the boot retry shipped in this release did exactly what it
is for, observed in production for the first time: *Serving the migration
error*, then *Boot proof attempt 1 failed; asking again in 30s*, attempts 2, 3
and 4 at 60s, 120s and 240s, with nothing but the error served and no fallback.
Before this release that machine would have stayed at 503 until somebody
redeployed.

The fix is in the next commit: every fire-and-forget async body under
`server/routes` and `server/mcp` (fourteen of them) now ends in
`.catch(answerEscapedFailure(res, …))`, which answers `503
{"error":"temporarily_unavailable"}` and logs. The process also gets an
`unhandledRejection` backstop that logs and keeps serving.
`tests/escapedRouteFailure.test.ts` drives the real token route over a socket
with a throwing database. Against the old code the request hung for 30s and the
rejection escaped. It also refuses `void (async` anywhere in those directories.

### The outage that ended by itself

`Logs` run 25 shows how the reboot ended. At 02:51:19Z the machine logged *The
cloud answered. Replacing the error page with the Brain.*. At 02:53:53 it
logged *Brain is running* (schema 83, migrations up to date). The health check
was passing at 02:54:21, and `/healthz` answered 200 in 0.34s from outside.
The outage ran from 02:25:29 to 02:54:21, and it ended with no deploy, no
restart and nobody pressing anything. The two outages before the boot retry
(deploys 324 and 334) each lasted until somebody redeployed. Deploy 338
(another session's `3a3bd1e`) ran during the outage and correctly released
nothing, because its health check could not pass against the same 544.

## Deploy 339: refused at the health check while Supabase refused connections

Deploy 339 (`93cd734`, which carries the route escape catch) passed its test gate.
`flyctl deploy` then failed (`Record what was released: skipped`), so nothing in
it was released by that run. The boot log says why. At 03:30:48, still on the
337 image, the pool was full (`10/10 connection(s) in use, 3 caller(s)
waiting`). After the machine was replaced at 03:36:56, Supabase's storage API
answered `544 DatabaseTimeout` and then `429 too_many_connections`, and the
pooler itself stopped handing out connections (`Connection terminated due to
connection timeout` at 03:41:35). The boot retry did what §18 asks: it served
the error and asked again at 30, 60, 120 and 240 seconds. The health check could
not pass inside flyctl's window, so the release was refused. This is
infrastructure, not this commit. Deploy 341 (`caba2b2`, another session's fix
for stacked Russell ticks holding pool connections) contains `93cd734` and is
the next attempt to release it.

## Deploy 341: the proof held and the port was still closed

Deploy 341 (`caba2b2`, which contains `93cd734`) also ended with
`release: failure`, so neither run released anything. This time the boot retry
got through: at 04:18:56 the machine logged *The cloud answered. Replacing the
error page with the Brain.* But `continueBoot` recomputed every project,
asking the store about every document, before it opened the port. Supabase
Storage was still slow, so the proxy kept reporting no healthy instance until
flyctl gave up. That is a boot-ordering defect, not this commit's.
`45f338c` (another session: open the port first, recompute after it) fixes it
and is in Deploy 342, which also contains `93cd734`.

## Deploy 342: the recompute was not the whole gap

Run 35956355757 on `45f338c`, which moved the recompute behind the listen.
`release: failure`, both verification halves `skipped`, and the image serving
throughout was the one that became healthy at 04:34:35. The boot log from the
new machine:

    04:58:59  health check failing (machine started)
    04:59:10  The document store could not be checked (HTTP 544) — DatabaseTimeout
    04:59:50  The cloud answered. Replacing the error page with the Brain.
    05:00:01  Design kernel: 8 surface(s), 7 pattern(s), 10 declared capability(ies).
    05:04:12  flyctl gives up; no "Brain is running." line ever printed

The boot retry did its job in forty seconds. What held the port for the next
four minutes was not the recompute, which no longer ran before `listen`. It was
the work between the design kernel and the port: advancing every pending packet,
re-driving every dispatchable bin, repairing launches and queueing unread
documents. All of those are passes over rows, and none is needed to answer
`/healthz`.

**Deploy 341 had the same shape and I read it wrong.** That boot went from
04:19:01 to 04:34:26, and I blamed the recompute alone. The recompute was part
of it. 342 shows the rest was still there once the recompute had moved.

The fix is on the branch: every re-derivation step now runs after the port opens,
in the same order as before. Each step is timed (`boot: <step> took Ns`), and a
failing step is logged rather than stopping the others. A line saying how long
after the cloud answered the port opened is printed too, so the next slow boot
names its step rather than leaving a gap between two log lines.
`tests/bootRetry.test.ts` fails against `45f338c`'s order.

## Deploy 343: the same gap, on another session's tree

Run 35960856346 on `f84d306`: `release: failure`, both halves `skipped`. The
new machine served the 544/429 error from 06:01:17, the boot retry's second
attempt held at **06:02:17**, the design kernel seeded at 06:02:24, and there
was no `Brain is running.` line when flyctl gave up at about 06:06. That is
342's shape again: the proof took a minute and the port stayed closed for four
more. `1f99be1` is what removes that wait, and it is what is being deployed
next.

## Deploy 344: released, and the port opened 14.2 seconds after the cloud answered

Run 35965025952 on `87c5c87`, which carries `1f99be1`. **`release: success`**,
the first release since 337. The boot log from the new machine:

    06:52:31  The cloud answered. Replacing the error page with the Brain.
    06:52:45  boot: opening the port 14.2s after the cloud answered
    06:52:45  Brain is running.

Compare 342 and 343, which were still closed four minutes after the same line.
No `boot: <step> took Ns` line was printed for anything before the port, which
fits the remaining pre-listen steps being cheap row updates. **The boot fix is
proven in production.**

Both hosted verification halves then ended `FAIL could-not-complete`, each on a
single `UNAVAILABLE` from a mutation deep in the scripted research packet:

- **Before the restart:** `brain_propose_fragments`, 07:10:50 → 07:15:35 (4m45s),
  reference `req_tjlvRADe5ndT`. Everything before it passed: identity, the queue,
  idempotency, the MCP gateway, and the goals privacy check.
- **After the restart:** `brain_submit_synthesis`, 07:45:54 → 07:46:21 (27s),
  reference `req_RCQDMLeUEG8l`. That half passed further, through proposal,
  approval, claims, verification and the gate.

The two failures come from two different tools, at two different points in the
packet, with two different durations, on a day when Supabase has answered 544
and 429 for hours. Nothing is concluded from that alone: the
`[mcp] tool call failed` lines carrying the underlying errors were requested
through the Logs workflow, and the classification below waits for them.

## What is still blocked, and on whom

Cash Mode 1's research cannot run until the Brain connector behind Brain
Research A, 1-B, 1-C, 1-D and Airyn 2-A…2-D authorizes again. That is a Claude
account action no code here can take (§22: the surface owns whether a worker may
act), followed by one operator command per Routine to lift the quarantine.
