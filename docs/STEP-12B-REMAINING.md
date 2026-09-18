# Step 12B — what is still open, who can answer each, and what it would cost

One page, kept current, so that "what is left" is never something to reconstruct
from a run log. Every condition here is **in the denominator**: nothing is
exempt, no code under `scripts/` writes a `deferredBy`, and the `standing: true`
flag that once let a condition excuse itself from scoring was removed.

## The reading, and what kind of thing each answer is

Reconciled with production at **3a73bb1** — 118 commits over two merges — and
read at the head of that reconciliation.

    243 conditions · 217 held · 0 failing · 26 open · 0 unanswerable · 0 deferred

Every condition carries what **kind** of evidence answered it, on the record
rather than in the prose beside it, because *"the runner exists"* and *"the
measurement happened"* are the two sentences that read alike in a summary and
mean opposite things:

| kind | held | open | what it means |
| --- | --- | --- | --- |
| `EXERCISED` | 192 | 0 | this run drove it, through the real services against a scratch database it made and deleted |
| `TREE` | 25 | 0 | the mechanism is implemented, read out of the repository |
| `FLEET` | 0 | 24 | only a real Brain's rows can answer it |
| `PERSON` | 0 | 2 | a decision somebody has to take |

**Nothing is held on `FLEET` evidence and nothing is open on `TREE` or
`EXERCISED`**, which is the shape to check at a glance: no condition is being
counted as done because its reader exists, and no condition is sitting open
that a run here could have answered.

The two `PERSON` rows are O and H — one design decision. The 24 `FLEET` rows
are answered by a deploy of this revision and then by the container reading,
except J's three, which additionally need a person's browser session on the
deployed Brain.

---

## 1 · Waiting on a person, and nothing else

| | condition | who |
| --- | --- | --- |
| **O** | the owner's approval of the complete design, bound to a revision and these bytes | the owner |
| **H** | whether the maps are any good — covered by O | the owner |
| **D** | a lens has been asked and answered on the **deployed** Brain's own work | a person there |

**O and H are one decision.** The render set exists and digests consistently;
the judgement is not a thing any code here may take. Nothing under `scripts/`
can write that row and `tests/step12bProduct.test.ts` enforces it by refusing
any import of the writer outside `admin.ts`.

**D no longer asks you to manufacture the discovery.** The path is driven end to
end in every reporter run: a person opens an asked lens, it becomes a bin, a
worker's reply arrives, `validateLensReply` keeps the finding whose references
resolve and discards the one with nothing under it, and a person accepts the
survivor — which is what turns it into a frontier item.

    MISSING_MECHANISM opened by a person, carried by bin bin_88b9263b…
    answered: 1 kept, 1 discarded
    finding 0 ACCEPTED by a person → frontier item rfr_ccac926e…

**Nothing there invents a discovery**, which was the reason the condition used
to be unanswerable — and the reason was about Brain rather than about the path.
A finding a model invented resolves to no row and is discarded; a surviving one
is a *proposal* until a person accepts it. What is still open is only the
production half: whether a lens has been asked and answered on the deployed
Brain's own work.

## 2 · Waiting on a deploy of this revision

| | condition |
| --- | --- |
| **P** | the hosted verification passes either side of a real restart of a real machine |

Closed by merging this branch and running `Deploy` on `production`. **It needs
no evidence commit** — that was the defect this round repaired. The Deploy run
uploads `step12b-hosted-verification`; the acceptance workflow fetches it from
that run through the API, checks the run succeeded and that the record names the
run's own `head_sha`, drops it in `$RUNNER_TEMP`, and hands it to the reporter,
which compares it **exactly** to the revision the container reports for itself.

**And a deploy alone does not close it today, which is an operational fact
rather than a gap in this branch.** The last `Deploy` run on `production` that
concluded `success` is **run 236 at `82b3106`**, on 2026-09-17 at 08:36. The
**eighteen runs since have all failed**, every one of them after the image was
released and the *pre*-restart verification had passed — so those commits are
live and serving, and what failed is the scripted packet the release gate runs
after the restart. §27 records nine of these now and still claims no cause.

The consequence for P is precise rather than general. `gh run list --status
success --limit 1` finds run 236 and fetches its artifact, and the reporter then
refuses it, correctly: the record names `82b3106` and the container reports a
different revision, which is *"a statement that what is running was never
proved"* rather than a weaker pass. **So P stays open with a reason, not for
want of a file** — and it closes on the first post-restart verification that
passes at the deployed revision.

What this round added toward that is a reading rather than a remedy. Neither
`scripts/verify-hosted.ts` nor `scripts/mcpModernClient.ts` passes an
`AbortSignal` anywhere, and `undici`'s default `headersTimeout` measures
300 000ms on the runtime the container runs — the same five minutes as a work
item lease, which is why a bare `fetch failed` at that boundary has been
ambiguous in both directions. Each audit role's calls are now timed and
announced before they are made, and the failure handler walks `error.cause`.
No timeout, retry, lease or pool change: §20 refuses the retry and §27 refuses
the ceiling without a reading.

## 3 · Waiting on one credential, and on nothing being faked to avoid it

| | condition |
| --- | --- |
| **J** | the attached phone reading is of this Brain, at this revision, and does not contradict itself |
| **J** | the question a person typed was answered rather than left waiting |
| **J** | and its result was inspected there — a conclusion under Knows citing that mission |

Both need a **worker that reached the sources**, which a Brain this repository
spawns never has: no inference is bought (§24), so Russell's turn stays
`PENDING` and no packet files a report. The local journey records that
truthfully and leaves both open.

**The way they may not be closed is the important half.** The obvious route is
to do on the deployed Brain what the local journey does on its own — capture an
idea, grant a standing authority, wait. That is refused:

- a synthetic idea in a project of real research is a row somebody has to
  recognise as fake later;
- a standing grant created to make a report come out right is a **spending
  authorization created for a report**;
- and waiting for a worker to answer a question nobody asked spends the
  subscription on a test. §29 already refuses the smaller version of this — a
  Capability Lab health check reads rows rather than firing a worker to learn
  whether workers fire.

So the mode that answers them **only reads**:

    # one of these two, and neither involves typing a password anywhere but the
    # Brain's own form:
    npx tsx scripts/visual-qa.ts --deployed=https://<brain> --sign-in \
      --expect-revision=<sha> --emit-phone=/tmp/step12b-phone.json /tmp/phone-shots

    BRAIN_PHONE_SESSION='<cookie from a browser already signed in>' \
      npx tsx scripts/visual-qa.ts --deployed=https://<brain> \
      --expect-revision=<sha> --emit-phone=/tmp/step12b-phone.json /tmp/phone-shots

    npm run step12b:acceptance -- --phone /tmp/step12b-phone.json

It follows **one chain forwards**: a conversation with a `USER` turn and a
`COMPLETE` reply, the missions whose `conversationId` is that conversation, and
a conclusion whose `missionId` is one of those. Then it reads each end on screen
at 390px, by that answer's own words and that conclusion's own statement.
`SCREEN_STATE` names `SIGNED_OUT`, `LOADING`, `FORBIDDEN`, `ERROR`, `EMPTY` and
`NOT_RUSSELL`, and **only `READY` may pass**.

Three things about *how* it reads were wrong and are corrected rather than
quietly applied:

- **Knows is reached by pressing it from the thread, not by loading the
  address.** The shell renders the project the open conversation is attached
  to — which, until this round, it did not: it rendered `projects[0]`, so a
  person reading a thread about one project and tapping Knows was shown
  another's, silently. A reading that reloaded `/knowledge` directly landed on
  a fresh shell's project, and a conclusion missing from *that* project's list
  was reported as a conclusion missing from the screen.
- **Whitespace is normalized on both sides.** The page's own text was collapsed
  and the needle was not, so a statement carrying a newline, a run of spaces or
  a non-breaking space — which stored prose and rendered paragraphs both
  routinely do — could never be found however plainly it was displayed. A
  reading that says "not on screen" about something on the screen is the
  expensive direction of wrong: somebody spends an hour on a defect that is not
  there.
- **The record the reporter reads is validated rather than cast.** It was
  `JSON.parse(...) as DeployedPhoneRecord`, which is not a check: any JSON
  object became a record, a reading of somebody else's deployment was read as
  evidence about this one, a `revisionMatches: true` beside two revisions that
  differ was believed, and findings the harness itself recorded were never
  consulted. `scripts/phoneRecord.ts` is one definition and one validator,
  imported by the harness that writes the record and by the reporter that reads
  it, judged against the Brain this tree deploys (read from `fly.toml`, never
  from the attachment) and the revision being judged.

It seeds nothing, grants nothing, launches nothing, and makes **no write at
all** — not even a sign-in. If the Brain holds no such chain, it reports that.

### The exact request

**A person's session on the deployed Brain.** Two ways, and there is
deliberately no third:

| | |
| --- | --- |
| `--sign-in` | opens a **visible** browser at the origin and waits while you sign in to the Brain's own form. This process never sees the credential. |
| `BRAIN_PHONE_SESSION` | a session cookie from a browser that is already signed in. |

- **Why a person and not a worker.** Every route it reads is behind
  `requirePerson`, and a worker principal is refused at the conversation routes
  **by principal type** (§24). The whole point of the two conditions is that *a
  person can read these answers on their phone*.
- **Why no password option.** A harness that took one would mean typing a Brain
  password into a terminal, a CI secret or a chat window — to mint the same
  session the two paths above already produce. `BRAIN_PHONE_PASSWORD` is gone,
  and a test asserts it has not come back.
- **What it can do with it.** Read. Proved by driving the real mode through a
  real browser against a real Brain in
  `tests/deployedPhoneInspection.test.ts` — including a row count identical
  either side — rather than by reading its source, which is how six defects in
  the first version went unnoticed. It now also drives a chain in a **second
  project** and one whose answer and conclusion carry line breaks and a
  non-breaking space; both fail against the previous build, which is what makes
  them evidence. `tests/phoneRecord.test.ts` covers the invalid records.
- **What it cannot do with it.** Produce the approval render set: `--deployed`
  refuses `--renders` outright, because those images are of *this tree* built
  here.
- **If you would rather not.** Both conditions stay open and visible. That is a
  perfectly good outcome and is what this page is for.

## 4 · Waiting on a decision, not on a permission

| | condition |
| --- | --- |
| **G** | how much a real Cowork surface holds |

Every Capability Lab result carries `PROVIDER_UNTESTED`, honestly. The old text
here said the ceiling was "one nobody set" — **true, and the thing to fix.** It
is set now, in code, at `server/services/fleet/measurementEnvelope.ts`:

| | |
| --- | --- |
| capacity | **10 concurrent bins** — Step 10's own recommended operating ceiling, not a guess. Rungs 1–20 completed every bin; rung 30 had every dispatch refused. |
| activations | **40**, four per bin at the ceiling. Reaching it is a stop condition, never a reason to raise it. |
| duration | **30 minutes** — half a connector token's life, so a second session can appear; short enough that an unwatched run cannot still be going at end of day. |
| paid API | **$0**, and not a number this file chooses: the deployed Brain has no `ANTHROPIC_API_KEY` and no `BRAIN_PROVIDER`, and the standing authority already forbids turning paid usage on. |
| stop conditions | five, named |
| cleanup | every bin cancelled and its fencing generation advanced; the isolated scope keeps its rows, because they *are* the measurement |
| rollback | no fleet policy is applied at all, so there is nothing to undo |
| work | **synthetic** — a capacity measurement needs real activations, not real questions |

A run that widened its own ceiling is refused by name and is not that
measurement:

    ceiling 40 is above the declared 10; REAL_CANARY is not SYNTHETIC;
    stop condition missing: …

### The envelope was all there was, and this gate accepted it

**The correction is recorded rather than quietly applied.** With only the
envelope declared, G asked for an experiment that was `COMPLETE`, in a
`TECHNICAL` scope, whose stored bounds matched the ones above — and **every one
of those is satisfiable with zero worker execution.** A `HEALTH_CHECK` declared
through the ordinary Lab routes with that manifest reads rows, finishes in
milliseconds, fires nothing, and would have answered *"how much a real Cowork
surface holds"*.

An envelope is a bound on a measurement, never a measurement. What G reads now
is evidence only a fire can produce, correlated to the experiment's own bins by
a key on their manifest:

    bins carrying this experiment's id
      → `bin_dispatch` rows Brain marked SENT, each naming a provider session
        Brain did not choose
      → `worker_sessions` arrivals, attributed from those same dispatch rows
        rather than from anything a worker said about itself
      → bins that reached COMPLETE

`server/services/fleet/capacityMeasurement.ts` is both halves: the runner that
creates the bins, and the reading that correlates them back. The limits are
enforced **while it runs** — `enforceCapacityLimits` is the first thing the
dispatch tick does, before the re-arm and before any further intent is created,
so a run that has reached forty activations cannot buy a forty-first. Stopping
one cancels every outstanding bin, which advances its fencing generation, so a
late completion from a worker still holding one matches nothing.

`tests/capacityMeasurement.test.ts` drives both negative cases rather than
asserting them: a health check with the identical manifest and envelope
correlates to **0 bins, 0 activations, 0 arrivals, 0 completions**, and an
in-process queue exercise — a real claim, a real lease, a real completion
against the deployed queue code — produces no `bin_dispatch` row marked SENT,
because nothing left the process.

### And now the decision

**This is the part that had to come last.** An earlier version of this page said
*"the authorization was never missing"*, because
`POST /projects/:id/lab/:experimentId/run` requires a person at `OPERATOR` depth
sending `authorizePressure: true`. That over-claimed: a route that **can** carry
an authorization is not an authorization. It says such a decision is possible
and says nothing about whether this measurement was approved — and until the
executable path existed there was nothing coherent to approve.

There is now. The request is **one bounded run inside the envelope above** —
ten bins, at most forty activations, thirty minutes, synthetic work, $0 paid,
in the isolated `TECHNICAL` scope, with every outstanding bin cancelled when it
stops. Nothing else changes: no fleet policy is applied, no research is started,
no evidence bar moves, and the standing authority, the concurrency of 1 and the
$0 paid-API ceiling are untouched.

It is a **decision rather than a permission**, and it is not taken here.

## 5 · A correction: controlled canaries are allowed

| | condition |
| --- | --- |
| **Q** | a canary ran against the deployed fleet, in an isolated scope, and rolled back |
| **Q** | and the fleet is running on the setting that canary displaced, not merely on a newer row |
| **Q** | and the cycle it is part of retested under the canary and compared |
| **Q** | and nothing it did reached what the project believes |

This page used to say a canary against the live fleet "would be the
contamination R5 forbids, committed by the thing checking for it". **That is
wrong as stated and the correction is recorded rather than quietly applied.** A
controlled canary inside an isolated scope, with a declared rollback and a
recorded restore, is exactly what the Lab is for: the cycle applies, retests,
compares and rolls back, and every version stays in the history so a rollback is
a write forward rather than a delete.

Contamination is a canary that **changes what ordinary work is eligible for**,
or that **leaves its own number live**. Those are the two things the conditions
now ask, of rows, plus a third — that the scope it ran in holds no knowledge.

The reporter still only *reads* them. Choosing what the fleet runs on is a
person's decision through `applyFinding`, however safe the cycle is.

### Restoration is a value, and this gate compared an id

**A second correction, recorded rather than quietly applied.** The middle
condition used to read *"a policy that is not the canary"*, and it was decided
by comparing the live policy's **id** to the canary's. A rollback writes forward
rather than deleting (§29), so the row after a canary *always* has a different
id — including a row that kept the canary's own number. A different id is
evidence that something was written and no evidence at all that anything was
restored.

`restorationOf` in `server/services/fleet/lab.ts` is the rule, and it sits
beside `rollbackFinding` rather than in the reporter so the transition and the
reading of it cannot disagree about what "restored" means. The live policy must
be a **newer row than the canary** *and* carry the target the canary displaced —
which `applyFinding` recorded before it replaced anything. Both cases are asked,
because they have different right answers:

| the canary ran over | a rollback must leave |
| --- | --- |
| a real policy | that policy's own target |
| no policy at all | the dispatcher default (`DEFAULT_TARGET_WITH_NO_PRIOR_POLICY`), never the canary's number |

A newer row carrying the canary's value is refused **by name**, so it cannot
read as a near miss:

    the live policy is newer but still carries the canary's own target 12,
    not the displaced 4

And an unrelated policy row that happens to hold the right number cannot stand
in for the rollback either: it fails on the version, not on the value.

## 6 · Closed this round, and what the evidence for each actually is

| | condition | how |
| --- | --- | --- |
| **M** | the same comparison made over HTTP with an authenticated principal | the phone journey now asks `/progress` and `/briefing` as the signed-in person and compares them field for field |

It had been `held: null` with a paragraph — *"driven through the services the
routes call, which is where the derivation lives"* — every sentence of which is
true and which is still the substitution this repository refuses everywhere
else. **A scenario whose unmet condition is a paragraph is a scenario nobody can
finish.** It is answered in the journey rather than in the reporter because the
question needs a real server on a real socket and a person signed into it, and
that harness already has both while a read-only reporter has neither.


---

## 7 · One thing this page must not be read as saying

**P reads PASS 8/8 from a checkout in the reading taken at `7a7f9f9`, and that
is a test of the mechanism rather than evidence of a deploy.** The attachment
was written by hand naming that revision, precisely to exercise the four
outcomes:

| attachment | reads |
| --- | --- |
| names this revision, before and after true | `held: true` — *"this exact revision, attested by git in this checkout"* |
| names `dd1f9be`, the previously deployed one | `held: false` — *"run 34771692417 proved dd1f9be2, and this run is 7a7f9f9e — so what is running is not what was proved"* |
| names a run of a different repository | `held: false` — *"workflowRun does not name a run of Peyday007/V5"* |
| absent | `held: null`, awaiting a Deploy run at this revision |

The evidence that closes P for real is the artifact from a `Deploy` run of this
revision, fetched by the acceptance workflow from that run through the API,
with its `head_sha` checked against the record. Until that has happened, **P is
open**, and the container reading is the one that says so.
