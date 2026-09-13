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
| **D** | an asked lens has been answered by a reader on real work | any reader |

**O and H are one decision.** The render set exists and digests consistently;
the judgement is not a thing any code here may take. Nothing under `scripts/`
can write that row and `tests/step12bProduct.test.ts` enforces it by refusing
any import of the writer outside `admin.ts`.

**D is smaller than it looks and is still not ours.** Five lenses are *asked*
and five are *answered*: which assumptions have nothing supporting them, which
findings contradict each other, which declared region has no work in it — those
are rows, and Brain answers them. What adjacent possibility is absent, what
lesson transfers from another project, what the current map makes impossible to
see — those need a reader, and **a Brain that filled them in from a template
would be manufacturing insight**, which is §8's rule at the one altitude where
breaking it is most tempting. The mechanism is built (`openInquiry`,
`validateLensReply`); one reply on real work closes the condition.

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

    npx tsx scripts/visual-qa.ts --deployed=https://<brain> \
      --emit-phone=/tmp/step12b-phone.json /tmp/phone-shots

    npm run step12b:acceptance -- --phone /tmp/step12b-phone.json

It signs in, finds a question a person genuinely typed that a worker genuinely
answered, finds a conclusion a real mission genuinely produced, and reads both
**on screen at 390px**. It seeds nothing, grants nothing, launches nothing, and
`visit` — the only way it talks to the Brain after signing in — takes a cookie
and a route and has no method argument to pass `POST` to. If the Brain holds
neither thing, it reports that it holds neither. A record written inside this
repository is refused at both ends.

### The exact request

**One person's sign-in on the deployed Brain**, as `BRAIN_PHONE_EMAIL` and
`BRAIN_PHONE_PASSWORD`.

- **Why a person and not a worker.** Every route it reads is behind
  `requirePerson`, and a worker principal is refused at the conversation routes
  **by principal type** (§24). There is no weaker credential that would do, and
  the whole point of the two conditions is that *a person can read these answers
  on their phone*.
- **What it can do with it.** Read. The read-only guarantee is four tests, not a
  convention: one write in the whole mode and it is the sign-in; no mutating
  route named anywhere in it; one `JSON.stringify` body and it is the
  credentials; and the record's own type carries no password and no cookie.
- **What it cannot do with it.** Produce the approval render set — `--deployed`
  refuses `--renders` outright, because those images are of *this tree* built
  here and a deployed Brain is running whatever was last released.
- **If you would rather not.** Both conditions stay open and visible. That is a
  perfectly good outcome and is what this page is for.

## 4 · Waiting on a measurement somebody must authorize

| | condition |
| --- | --- |
| **G** | how much a real Cowork surface holds |

Every Capability Lab result carries `PROVIDER_UNTESTED`, honestly. Measuring it
means putting real pressure on a fleet serving real research, against a ceiling
nobody set, and §29 is explicit that the two tempting alternatives are both
refused: simulating it produces figures a reader cannot tell from measurements,
and running it unattended spends real capacity. **The mechanism is complete and
the measurement is not taken**, which is the honest report.

## 5 · Refused by design, and correctly

| | condition |
| --- | --- |
| **Q** | the same canary cycle against the deployed fleet |

A canary displaces a policy version somebody is actually running on. A reporter
that drove one against the live fleet would be **the contamination R5 forbids,
committed by the thing checking for it.** The cycle is driven both ways round
against real `fleet_policy` rows in an isolated scope, which is the strongest
form of it that does not corrupt what it measures.

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
