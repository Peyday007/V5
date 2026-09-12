# The author of the report was not a party to its own audit

A targeted check, asked of one packet, answered from Brain's own rows. It found
a real independence violation that every existing control reported as
compliant, and this file records the reading, the defect behind it, the repair,
and the one thing the repair does not do.

---

## 1. The question

The recovered Cowork session of 2026-09-12 released its bin saying:

> *"Synthesis redo and PRIMARY audit are complete and checkpointed."*

One sentence naming two pieces of work on one packet. If that is one session
writing a report and then filing the primary audit on it, it is §23's threat
stated exactly — **one model context reviewing its own work** — and the fact
that it was said out loud in a release message rather than hidden is the only
reason anybody asked.

The packet is `orc_abab7d7130d545eaa1a1`, *"Unsettled: Montmorency, Oakland and
Ottawa were never read"*.

---

## 2. What the rows say

**The three audit roles** (`step10 audit-lineage`, run 34689906949, against the
deployed Brain):

| Role | Worker | Routine | Account | Session |
| --- | --- | --- | --- | --- |
| PRIMARY | `wkr_1cdd82cfb2a54faf8edd` | `rtn_c7bcec972bd44afa91d7` | `acct_70dda3fae2e1428e944b` | `oat_b7e9bffca36a45a896c6` |
| ADVERSARIAL | same | same | same | `oat_b97a31fba2184e1cb83c` |
| JUDGE | same | same | same | `oat_abccc52ecdee4c68b515` |

Three distinct credentials, one worker, one Routine, one account →
`SESSION_SEPARATED`, the floor, reported truthfully and never rounded up. The
command's own verdict: `compliant=true passes=3`.

**The packet** (`packet-report`, run 34689966128): `COMPLETE`, audit
`aud_b84704fe7b3542a7a184` verdict `PASS` at `2026-09-12T10:52:13.551Z`,
document `doc_d7fb8b7ed5aa4edfac25` (*World Model v1E*, 10 376 bytes, 6/6 cited
claim ids present in the stored bytes). Seven passes. Audit ordinals completed
at 09:10:05.581, 09:46:04.110 and 10:52:05.107.

**The activation** (`step10 trace bin_2a66343bb7ea4e38a2d9`, run 34689995508) —
this is the part no other reader could produce:

```
09:04:47.997  DISPATCH_SENT       session cse_01XCUQgeYWmMTwUVpyLNihAE
09:05:06.068  BIN_TAKEOVER        session claude-code-web-session_01XCUQgeYWmMTwUVpyLNihAE
09:05:15.566  BIN_ITEM_CLAIMED
09:07:47.662  BIN_CHECKPOINT
09:07:50.487  BIN_ITEM_CLAIMED
09:10:10.639  BIN_ITEM_WITHHELD   REFUSED_BY_ADMISSION
              RESEARCH_AUDIT: ADVERSARIAL would share the same session as PRIMARY,
              which PRIMARY_ADVERSARIAL requires to differ
09:10:26.765  BIN_ITEM_CLAIMED
09:10:53.308  BIN_ATTEMPT_CREDITED
09:11:07.830  BIN_ATTEMPT_CREDITED
09:11:34.175  BIN_RELEASED
              Synthesis redo and PRIMARY audit are complete and checkpointed.
```

**The answer is that the release message describes that session's own work, not
previously completed work.** One authenticated session claimed three items
inside one activation, submitted a synthesis and the PRIMARY audit, and the
PRIMARY pass's completion timestamp — 09:10:05.581 — falls between its second
and third claims.

Brain proves the pairing itself, four and a half seconds later: at 09:10:10 it
refused that same session the ADVERSARIAL role *because it already held
PRIMARY*. So the guard knew exactly which session had filed the primary audit.
It simply had nothing to say about the session that had written the thing being
audited.

---

## 3. Why every control reported compliant

`lineageFromPasses` has always returned `{ synthesis, audits }`, and the
synthesis half has always been extracted, typed and labelled. **Every caller
destructured `{ audits }`.** A grep for `.synthesis` across the three call
sites — `auditEligibility`, `auditMatrixVerdict` and `auditAdmission` — matched
nothing.

`AUDIT_SEPARATION_MINIMUM` had three entries: `PRIMARY_ADVERSARIAL`,
`JUDGE_PRIMARY`, `JUDGE_ADVERSARIAL`. There was no key an author could be
compared under, so even a caller that had kept the lineage had nothing to apply.

`checkIndependence` in `independence.ts` *does* hold a self-audit rule, checked
at every level including `NONE`, with the right comment above it. It is called
by tests and by nothing in production. **A mechanism nothing calls is not a
mechanism** — the fourth time this repository has needed that sentence.

And neither of the two things that could have answered the question could:
`step10 audit-lineage` filtered to `passKey === 'AUDIT'` one line before handing
the list to the matrix, and `packet-report` read the synthesis pass only for its
cited claim ids. The rows held the answer the whole time; nothing printed it.

---

## 4. The repair

Three matrix entries become six — `SYNTHESIS_PRIMARY`, `SYNTHESIS_ADVERSARIAL`
and `SYNTHESIS_JUDGE`. All three reviewer roles are named, because an
adversarial critic of its own report and a judge of its own report are the same
defect one step along.

**The level did not move.** Every pair is still `SESSION`, and still names no
topology, so the correction that removed the two-account requirement is not
reintroduced by this one: the same account may still review its own author's
work from a different activation, which is what keeps the floor reachable on a
one-Routine fleet. The set of parties changed; the bar did not.

Both guards read the author now — the one before the lease and the one that
guards storage — and `lineageFromPasses` returns **every** completed synthesis
attempt rather than only the newest, because a session that wrote a superseded
one argued the report into the shape the current one inherits.

`auditMatrixVerdict` keys its lookup by *party* rather than by role. Without
that, a `SYNTHESIS_*` entry would have found `undefined` on both sides and
continued past in silence — the entries would have been in the constant and
enforced by nothing, which is the same shape as the defect they exist to close.

`step10 audit-lineage` and `packet-report` print the author beside the
reviewers, and both feed the whole pass list to the verdict production applies.

A11 gains `AUTHOR_IS_NOT_A_REVIEWER`: derived per packet from every completed
synthesis attempt, fail-closed on unrecorded authorship, asked last so a packet
that filed nothing is still refused by name for *that*. The gate also exercises
the new refusal live, because a strengthened constant nothing runs is a claim
rather than a reading.

Verified 2328 on SQLite and 2329 on Postgres.

---

## 5. What the repair did not do, and the transition that now does

The first version of this section ended with an honest gap, kept here rather
than deleted because it is why the transition is shaped the way it is:

> **There is no supported transition that reopens an audit round for this
> reason.** `auditRound.ts` starts a new round from exactly one event — an
> `OTHER_LAYER` handoff, which asserts that the document moved layers, and this
> document did not. Obtaining an eligible independent PRIMARY review on a packet
> that has already passed needs either a guarded re-audit transition that does
> not exist, or the person who owns the project deciding that the filed
> conclusion stands with the violation recorded against it.

The reasoning about the handoff still holds: using it here would make the rows
say something untrue to get a lookup to come out right, which is what that
module was written to refuse. **The owner chose the first option, so the
transition exists now** — as a second, narrower reason a round may begin, with
its own event (`AUDIT_ROUND_REOPENED`) and its own append-only record
(`audit_integrity_reopens`). Nothing about the handoff changed.

**It destroys nothing.** The superseded audit keeps its row, its verdict, its
gaps and its `created_at`; every pass keeps its raw response, its lineage and
its timestamps; the document keeps its bytes, version, hash and storage key.
What moves is a boundary in *time*, which is the same mechanism the handoff uses
and the reason neither has to edit history to work.

**It is bound to the bytes and to a person.** The reservation key is a sha-256
of the orchestration, the document, its exact content hash and the finding —
server facts only, so nothing a caller sent contributes and a key is never a way
to reopen a packet in another project. `UNIQUE (request_key)` is the arbiter,
which makes a duplicate request, a retry after a lost response and a restart
mid-request the same outcome. A document whose bytes changed produces a
different key, because it is a different operation; an open reopen whose
document no longer hashes the same is `SUPERSEDED_BY_VERSION`, never
`RESOLVED` — nothing re-audited anything, and saying otherwise would claim an
assurance nobody earned.

**A replay re-reads and re-authorizes.** The stored `requested_by_id` is a
record of who asked, never a credential: a person whose access was revoked
between the attempts is refused at the second, from current rows, in the same
words a non-member gets. A worker cannot reach it at all — the principal is
built from a user row, so the policy only ever sees a `HUMAN` here.

**Which roles run again is derived, not chosen.** `decideRoleReuse` reads the
recorded lineage: a role is carried forward only if its session authored nothing
(every completed synthesis attempt counts, including superseded ones), no role
it is built from is being rerun, and it has a completed pass to carry. The
dependency closure comes from `auditBriefFor`, which composes the adversarial
prompt from the primary's raw response and the judge's from both — so for
`orc_abab7d7130d545eaa1a1`, where PRIMARY is the conflicted role, **all three
rerun and nothing is carried.**

**The old JUDGE verdict cannot validate a replacement PRIMARY.** The packet's
own `verdict` and `audit_id` pointers are cleared — the `audits` row is
untouched and the reopen points at it — and a reopen settles only on an audit id
that differs from the superseded one *and* a judge pass completed after the
boundary. Restoring the old pointer settles nothing.

**A11 says so while it is open.** `AUTHOR_IS_NOT_A_REVIEWER` reports the
violation and names the correction in the same breath — pending, resolved or
superseded — because an escalation that cannot mention its own answering
transition sends a reader to do work that is already happening.

## 5a. What the first real reopen found, ninety seconds in

The transition was exercised in production on 2026-09-12, and it found a defect
in itself. This is recorded rather than quietly fixed, for the reason every
other correction in this repository is.

`air_fdf0af5981c0404389e6` opened at 13:31:53 against `orc_abab7d7130d545eaa1a1`
at `v1E` (`96b3b10c1307…`). It rerun `PRIMARY, ADVERSARIAL, JUDGE`, carried
nothing, superseded `aud_b84704fe7b3542a7a184`, moved the packet back to
`AUDITING` with its verdict pointer cleared, cancelled the previous round's
outstanding items, and built `bin_50336752dd134a2c97fa`. Every one of those is
what it was supposed to do. What it did not do was enqueue the round's work:

```
13:31:53  BIN_READY
13:31:59  DISPATCH_INTENT → DISPATCH_ROUTED   Selected V1 on primary: 0/2 Routine, 0/2 account
13:32:00  DISPATCH_SENT                        session cse_01S3HDc52B7jsgnoGvLfqSJk
13:32:15  BIN_ASSIGNED                         worker wkr_1cdd82cfb2a54faf8edd
13:32:34  BIN_COMPLETION_REFUSED               "The packet is AUDITING, which is not a state it files a report in."
13:34:17  BIN_RELEASED                         "No open work item exists yet for this reopened audit round"
13:34:19  DISPATCH_INTENT → 13:34:20 DISPATCH_SENT   (fired again)
```

Brain fired fifteen seconds after the bin went ready and a worker arrived
fifteen seconds after that — the dispatch half was exactly right. The worker
then had nothing to claim, released saying so, and was fired again. Left alone
that is a loop which looks like progress and ends with the bin's five attempts
spent against a packet whose own state said a worker should be working.

`advancePacket` is what turns "this packet is `AUDITING`" into a claimable work
item, and **every other transition that reopens work calls it** — `startPacket`,
`reissue`, `surfaceRecovery`, `needsHuman`, the launch, and the submit tools.
This one did not. It calls it now, ahead of building the bin so there is no
window where the fire exists and the work does not, and it reports what the
round is waiting on. It is idempotent by the round rather than by a flag:
`auditRoleSubmitted`, `stillRunning` and `alreadyCreated` are all asked of *this*
round, so a replay, a restart mid-request or a concurrent tick enqueues one item
for the first outstanding role and no more. One, not three — the roles are built
from each other, so `ADVERSARIAL` is enqueued once `PRIMARY` has argued and
`JUDGE` once both have.

**And the replay had to assert it too, which is the same mistake one move
along.** The advance was put on the winning path only, and a replay returns
before it — so re-running the command against the round production had *already*
opened would have answered "nothing was opened twice" and left it with nothing in
it. **Idempotency means the effect is present after either call, not that the
second call does nothing.** It is safe to repeat for the same reason it is safe
at all: it is idempotent by the round rather than by a flag, so a role already
argued, already out or already enqueued adds nothing. Cancelling the previous
round's items and building a bin stay on the winning path, because those are not.

**And enqueuing the work is only half a remedy for the round already in that
state, which is the third move of the same mistake.** Those five activations
spent the bin's five attempts, so it retired at `NEEDS_HUMAN` — and a live round
whose only bin is terminal is *a packet nothing can be sent for*, §24's own
words. So a replay reuses the bin while it can still deliver, because two live
bins for one packet is the duplicate the replay path exists to avoid, and builds
a new one when it cannot. **A remedy that cannot reach the state it exists for
is not a remedy.** The spent bin keeps its row, its attempts, its checkpoints
and its events.

The five workers were not the problem and are worth recording as the opposite.
Each one arrived, read the state correctly, said so precisely — *"no claimable
RESEARCH_AUDIT work items exist for this reopened round"*, *"attempt 4 of 5,
identical stuck state as attempts 1-3"* — and released rather than inventing a
report. The completion contract refused every attempt with the accurate reason:
*"The packet is AUDITING, which is not a state it files a report in."* The
machinery was honest about a defect for five consecutive activations, which is
exactly what it is for.

**The test fixture is why reading did not find it.** It had a filed document and
no fragments, which is a shape production cannot produce: a packet cannot have a
document without having synthesized one, and it cannot synthesize without a
fragment that cleared its gate. With no fragment `advancePacket` walks to the
planning branch, so a test that called it would have been testing a different
packet. The fixture now carries the accepted fragment the document implies, and
two tests pin the queue rather than the call — what an arriving worker can claim,
and that a replay adds nothing to it.

## 5b. What the corrected round actually did, and the reader that lied about it

The replay at 15:48 put the round back in business and the fleet took it
without anybody involved:

```
15:48:18  BIN_READY            bin_9933ad0a856440418241
15:48:25  DISPATCH_ROUTED      Selected V1 on primary: 0/2 Routine, 0/2 account
15:48:26  DISPATCH_SENT        session cse_01HrfBw1rvDFrDnss3CWZ7j8
15:48:40  BIN_ASSIGNED         worker wkr_1cdd82cfb2a54faf8edd
15:48:58  BIN_ITEM_CLAIMED     ← the thing that did not exist before the fix
15:51:53  PRIMARY pass complete, session oat_564ad322fc284a94a54c
15:51:59  BIN_ITEM_WITHHELD    REFUSED_BY_ADMISSION —
                               "ADVERSARIAL would share the same session as PRIMARY"
```

Forty seconds from replay to a worker holding the work, zero refusals on the
bin. The replacement PRIMARY ran in `oat_564ad322fc284a94a54c`, which is
distinct from **both** synthesis sessions — so the pairing the finding is about
is gone, and `auditMatrixVerdict` reads `compliant` over the current round's
six pairs. The old passes are all still there with their original timestamps,
and `audits=4 synthesis=2` is the honest count of a packet that has been
audited twice.

The refusal six seconds later is the floor working rather than a second fault:
the same session may not also argue the other side, so ADVERSARIAL waits for
one that is genuinely distinct. The reopen stays `OPEN` until a **fresh judge
verdict** lands, which is the whole point — the old `PASS` cannot settle it.

**And one reader lied about all of it.** `binForOrchestration` was a `SELECT`
with no `ORDER BY`, which was fine while a packet had one bin and stopped being
fine the moment a reopened round gave it a second. It returned the *spent* bin
while the live one was running the replacement review, so `packet-report`
printed **"1 claimable item(s) and the bin is COMPLETE: nothing can be sent for
this packet"** about a packet that was at that moment being worked on. A warning
that cries wolf is worse than no warning — it teaches a reader to stop believing
the one place that tells them a packet is genuinely stranded.

The paragraph directly above it, on `binByCreator`, already names the defect in
so many words: *"a `SELECT` with no `ORDER BY` over two rows returns whichever
the backend feels like."* The neighbour was left standing. It now orders a bin
that can still deliver ahead of one that cannot and takes the newest as the
tiebreak, so the answer is deterministic in both dialects.
`creditPacketProgress` had the quieter half of the same bug, refunding an
attempt to whichever bin came back rather than the one doing the work.

## 6. The scope, reported without reopening anything

`npm run admin -- packets independence [project]` reads every packet's lineage
and names the ones where a reviewer shared a session with an author. It is
read-only by construction: it opens nothing and proposes nothing per packet,
because "which other packets have this problem" is a question a person asks
before deciding, and a command that answered it by reopening what it found would
be making that decision for them.

It reports a packet whose sessions were **never recorded** separately from one
where the author demonstrably reviewed. That distinction is the whole of this
repair in one column: *we could not tell* is not the same fact as *we checked*.

What is true either way for this packet: the three *reviewer* pairs are
genuinely session-separated, the evidence gate, the verification pass and the
judge's own verdict are untouched, and the report's six cited claim ids all
resolve to accepted evidence present in the stored bytes.
