# Step 12B — what is still open, who can answer each, and what it would cost

One page, kept current, so that "what is left" is never something to reconstruct
from a run log. Every condition here is **in the denominator**: nothing is
exempt, no code under `scripts/` writes a `deferredBy`, and the `standing: true`
flag that once let a condition excuse itself from scoring was removed.

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

## 3 · Waiting on one credential, and on nothing being faked to avoid it

| | condition |
| --- | --- |
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
  the first version went unnoticed.
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

**The authorization was never missing, and checking first is why that is worth
saying.** `POST /projects/:id/lab/:experimentId/run` already requires a person
at `OPERATOR` depth sending `authorizePressure: true`, read from the route
rather than from the experiment's own row. **No new approval is requested
here.** What is absent is a person deciding to spend forty activations on it —
a decision, not a permission.

A run that widened its own ceiling is refused by name and is not that
measurement:

    ceiling 40 is above the declared 10; REAL_CANARY is not SYNTHETIC;
    stop condition missing: …

## 5 · A correction: controlled canaries are allowed

| | condition |
| --- | --- |
| **Q** | a canary ran against the deployed fleet, in an isolated scope, and rolled back |
| **Q** | and left the deployed fleet running on a policy that is not the canary |
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
