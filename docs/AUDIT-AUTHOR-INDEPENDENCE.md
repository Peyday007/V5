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

## 5. What the repair does not do

**It does not make this packet's audit independent.** The repair stops the
pairing happening again; it changes no recorded row, and §5 forbids destroying
the ones that exist. `orc_abab7d7130d545eaa1a1` is `COMPLETE` with a `PASS`
verdict and a filed document, and its PRIMARY audit was written by the report's
own author.

**There is no supported transition that reopens an audit round for this
reason**, and that is the honest finding rather than an omission to paper over.
`auditRound.ts` starts a new round from exactly one event — an `OTHER_LAYER`
handoff, which asserts the document moved layers, and this document did not.
Using it here would make the rows say something untrue to get a lookup to come
out right, which is the thing that module was written to refuse.

So this is §24's own sentence at a new altitude: **an escalation with no
answering transition is not waiting, it is stuck.** Obtaining an eligible
independent PRIMARY review on a packet that has already passed needs either a
guarded re-audit transition that does not exist, or the person who owns the
project deciding that the filed conclusion stands with the violation recorded
against it. Both are decisions, and neither is one a worker or this session may
take alone.

What can be said without any of that: the three *reviewer* pairs on this packet
are genuinely session-separated, the evidence gate, the verification pass and
the judge's own verdict are untouched, and the report's six cited claim ids all
resolve to accepted evidence present in the stored bytes.
