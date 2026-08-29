# Running a research packet

What an operator does, in order, to take one question from an empty box to a
canonical audited document in the Brain.

Everything here happens in a browser and in **Cowork**. Nothing needs a
terminal, and no credential is ever copied by hand.

**Two things this page assumes, because they are the architecture.**

The worker runs in Cowork, connected to the deployed Brain over OAuth — not in
an ordinary Claude conversation. See §22 of `CLAUDE.md`; `STEP-8-PLAN.md` §1
says otherwise and is superseded.

And **the worker's results go into the Brain, not into a reply.** Claims,
verdicts, checkpoints and the filed document all arrive through the tools. You
never copy research out of one Claude conversation and into another, and nothing
that stays in a transcript counts. The most a session should hand back is how it
ended: how many items it completed, and whether the queue emptied or its
allowance ran out.

**Somebody still has to start it.** Step 9 runs on manually initiated Cowork
sessions — the Brain never reaches out to Claude. Automatic activation is
Step 10's, and it is unbuilt: no mechanism has been chosen, and nothing here
should be read as scheduling that exists.

---

## Before you start

You need one thing that is not on this page: **a connected worker with access to
the project**. `CONNECTING-A-WORKER.md` covers that.

If the worker was connected before the research tools existed, its row on
`/operator` says so and offers **Update access**. Press it. A worker holding the
older scope set will claim a research item happily and then be refused by every
tool that would let it record anything — and the refusal is the same *no such
thing* a missing item gives, so from the outside it looks like a broken Brain
rather than a stale grant.

---

## 0. Try it without spending anything — you

Before pointing a real question at this, run a **test packet**.

`/operator` → **Try it without spending anything** → **Create a test packet**.

It appears in the same **Research packets** card a real one does, labelled
`— TEST PACKET`, with the same approval screen. Approve it. It costs nothing:
its claims are written into the Brain's own source, and approving it runs them
through the same gate, the same filing and the same ledger a worker's submission
goes through.

What to look at afterwards:

- **Three fragments, three outcomes.** One cleared the gate. One cleared it and
  lost a claim. One failed because its only source was about a different thing
  than the fragment asked about — a correct fact, correctly cited, answering a
  different question. That third one contributed nothing to the report.
- **The rejected claim is still there**, marked, in the ledger. It was not
  dropped, because a ledger that hides what could not be sourced looks better
  than the research was.
- **The filed document.** Open it. Every sentence resolves to a claim id, a URL
  and a passage — that is the check the whole machine exists to make possible.

It stops before the audit and says so on the row. That is the one part a fixture
cannot honestly stand in for: an audit is a model reading a document and forming
a judgement, and writing a verdict nobody reached is exactly what the audit
rules exist to prevent. Seeing that half run needs a worker.

Once you have looked at that and think the machinery is worth it, carry on.

## 1. Write the assignment — you

`/operator` → **Start a research packet**.

Choose the layer the answer belongs to. Give it a title. Then write the
assignment, and this is the part worth spending time on, because **the
boundaries you write become the standard the evidence is judged against.**

Say, explicitly:

- **The question.** One question, not a subject.
- **The decision it informs.** What changes depending on the answer.
- **Geography, timeframe, population.** A claim that is true somewhere else, or
  was true two years ago, is rejected at the gate rather than quietly used.
- **Definitions.** The terms that would otherwise mean two things.
- **Inclusions and exclusions.** What is deliberately not being asked.
- **The completion standard.** What a good answer resolves to — "a statute
  section a reader can open" is a standard; "well researched" is not.
- **What the assignment does not settle.** So the worker reports those as out of
  scope instead of answering them.

Press **Plan it**. This queues one planning job and stops. Nothing has been
spent.

## 2. Ask the worker to work — you

The Brain does not reach out to Claude; Claude asks the Brain for work. So open
a conversation with the connected account and say, in your own words:

> Claim any work waiting in the Brain and do it. Read the assignment first.

Scheduling this is Step 10. Until then, a person says go.

## 3. The plan comes back — the worker

The worker reads the assignment and proposes bounded fragments: one question
each, with the geography, timeframe, definitions, evidence lanes, acceptable and
excluded source types, completion criteria and independent-source minimum that
make an answer checkable. A fragment missing those is refused at submission,
because a fragment that cannot be judged must not be researched.

Then it stops. **Nothing is researched until you approve.**

Before the proposal becomes a plan the Brain checks it against what the project
already holds. A fragment the archive answers is dropped there and then, with
the claims that answer it named, so the plan you read is the work that is
actually still open — §13's default of not researching, applied before anything
can be spent rather than after. The worker sees the same list back, under
`alreadyAnswered`.

If the archive answers **all** of it, there is no plan to approve: the packet
ends as `CANCELLED` saying so, and that is a good outcome. The project already
knew.

## 4. Read the plan and approve it — you

Refresh `/operator`. The **Research packets** card shows every proposed
fragment in full — not a count, because "approve 6 fragments" is not a decision
anybody can make.

Read them as what they are: the list of things the account's allowance is about
to be spent on. Ask of each one:

- Is this actually part of the question I asked?
- Are its boundaries the ones I wrote, or has it drifted somewhere easier?
- Would the evidence it demands convince me?

Press **Approve this plan and start researching** when the answer is yes. This
is the only point in the whole packet where a human decision is load-bearing:
before it nothing costs anything, after it each fragment costs a little.

## 5. The research runs — the worker

Fragment by fragment, in dependency order. A fragment whose dependency has not
been accepted waits, because a fragment that settles definitions has to land
before the ones that use them.

For each, the worker researches and submits claims. **Every claim is stored
unaccepted.** Then a verification pass answers, per claim, the two questions only
a reader of the source can — does the source support the claim, does its scope
match — and the Brain applies all seven gate conditions and records which claims
survived and why the rest did not.

You do not have to be there. Ask the worker to keep going, or come back later
and ask again; the queue holds the work either way.

## 6. The packet is filed and audited — the worker

Once every fragment has finished, the worker writes the report from the accepted
ledgers only. A citation the Brain cannot resolve to an accepted claim is
refused — the whole report, not that sentence.

The filed document carries the evidence ledger inside it, so every claim
resolves to an id, a URL and a passage. Then the primary/adversarial/judge audit
runs over it, and the judge's verdict is validated strictly: the gap counts are
recomputed from the gaps it classified and must agree, and an advancing verdict
is refused while a foundational gap is open.

## 7. Read it — you

Open the layer in the Brain and read the filed document.

**Check the citations.** Open two or three and see whether the passage says what
the claim says. That is the check the whole machine is built to make possible,
and nothing in the Brain can do it for you.

---

## When it stops

The packet stops rather than guessing, and the console says why.

| It says | What happened | What to do |
|---|---|---|
| waiting for a person to approve | The plan is ready | Read it and approve, or start again with a tighter assignment |
| no fragment cleared its evidence gate | The research did not meet the bar you set | Read the rejection reasons; narrow the question or lower nothing |
| a work item finished without recording anything | A worker completed without submitting | Look at what it did; the packet will not retry on its own |
| the report was filed but could not be read back | Extraction failed on the artifact | Reprocess the document |

None of these retries by itself, deliberately. **A repair is planned; a retry is
not a repair.** Re-running the same search is how an allowance gets spent
learning nothing.

## What this cannot do yet

- **Nothing is scheduled.** Every packet starts with a person pressing a button
  and continues with a person asking the worker to work. Step 10.
- **One account plays every role**, including all three audit roles. Three
  passes on one account is weaker than three independent readers; argue against
  yourself properly until there is a second worker. Step 11.
- **No automatic repair.** A failed packet stops with its reasons rather than
  planning its own second attempt. Also Step 11's neighbourhood.
