# Connection durability: every failure mechanism, 2026-10-15

This walks the whole chain: Claude Routine → connector → authentication →
network → Brain → check-in → quarantine → recovery. Each row says:
- whether the mechanism was **reproduced**;
- whether it is **fixed**;
- the evidence;
- what is left outside Brain's control.

Production readings are from `connection-report` (48 h, revision `15c8381`,
run 38792203469) and from this repository's own Claude session. Its two Brain
connectors are real Claude-side clients.

## What production said

These latencies were recorded on the live process, which started at 13:24Z:

| operation | p50 | p95 | max |
|---|---|---|---|
| `authenticate` | 159 ms | 15.2 s | 40.6 s |
| `oauth_token` (refresh) | 15.0 s | 52.6 s | 52.6 s |
| `brain_check_in` | 23 s | 182 s | 182 s |

Claude's MCP client gives a connector about 30 s to connect, retries a
transient failure three times, and then marks the server failed for the session
(code.claude.com/docs/en/mcp). Every one of those maxima is past that budget.
The session that started then has no Brain tools. It ends, and Brain recorded
it as "never checked in".

The same thing was seen from outside. In this repository's session the
`Factory_Brain` connector (`/mcp/factory`) failed with `CONNECT_TIMEOUT after
30000ms`. Its first call then answered `Service Unavailable`, and the next call
authenticated normally as worker-10. `cloud_brain` (`/mcp`) connected first
time as worker-05.

The costliest statement in the database was connector health's 45-day token
history scan: 441 runs in about 6 h, mean 12 s, max 73 s.

## The matrix

| # | mechanism | reproduced | fixed | evidence | outside Brain's control |
|---|---|---|---|---|---|
| 1 | **The connector handshake waits on the database.** `initialize` / `tools/list` authenticate against rows; a slow or failing database past ~30 s leaves the session without tools for life. | Yes: production latencies above, and this session's own `Factory_Brain` timeout followed by a 503 | **Yes.** A machine bearer that was authenticated within 15 min may answer only handshake methods when the database check throws or has not answered within 8 s (`services/identity/recentProof.ts`). Every tool call still authenticates against current rows. A refused credential is forgotten at once. | `connectionReliability`: handshake on proof; slow database; no proof → 503; revocation forgets. Two of the three defect tests fail with the fix off. | A cold process (just restarted) has no proofs, and a brand-new token has none until its first use. |
| 2 | **An answer later than the client waits was invisible.** A 40 s authentication or a 52 s refresh *succeeds* on Brain's side, so no incident was written. The session that gave up was charged as a no-show, or a probe read NO_MCP. | Yes: production maxima. Airyn 2-B's probe at 17:50 read NO_MCP minutes after Brain failed check-ins at 17:43–17:46. | **Yes.** `SLOW_ANSWER` (> 25 s) at `mcp:authenticate` and `oauth:token` is an arrival-path incident, so the fire is an infra miss. It is not an overload kind, so it does not drive shedding. | `connectionReliability`: a slow answer excuses its fire. | — |
| 3 | **Database load slowed authentication itself.** The token-history scan was re-run every 5 min per connector. | Yes: 441 × 12 s mean | **Reduced.** Its expiry is an hour; every token event that changes the answer still clears it by name. | Existing `tokenHistoryCache` tests. | The database host's own capacity (§61, §63) is the owner's. |
| 4 | **A refused credential was not told it was invalid.** The 401 challenge had no `error="invalid_token"`, so a client could not tell "refresh" from "connect again" (RFC 6750 §3.1). | Read from code | **Yes.** A presented-and-refused bearer gets `error="invalid_token"`. A request with no credential keeps the bare discovery pointer, and neither names a reason. | `connectionReliability`: challenge test (fails with the fix off). | Whether Claude's client reacts better is not observable from here. |
| 5 | **Token uses lost on restart.** Shutdown never flushed the in-memory touches. A rotated successor whose only uses were pending read later as "reply not picked up", and three quiet fires later as `CLIENT_STOPPED_RETRYING`, which asked for a person. | Read from code; 15 restarts in 48 h | **Yes.** Shutdown settles the touches (bounded at 3 s) before closing the database. | Code read; no test can drive the process's signal handler. | — |
| 6 | **A member's own reconnect never lifted the quarantine**, although Brain said it would. "After the quarantine" was `updated_at`, which every fire, probe fire, delivery proof and the token exchange's own touch move. | Yes | **Yes.** `fleet_routines.state_changed_at` (migration 117 / pg 108) is written only when `state` moves, and the lift compares against it. | `connectionRecovery`: reconnect lifts after probes, repeated over three cycles. Fails on the old code. | — |
| 7 | **A right-worker probe on a mixed history counted as a failure.** An owner who fixed the connector after the second probe reached two right sessions of three, and the budget was exhausted. | Yes | **Yes.** Such a probe is progress. The next one follows after 15 min. Found independently by #206; that version is the one that ships. | `connectionRecovery`, `airynDurability`: mixed-but-right (fails on the old code). | — |
| 8 | **After four probes nothing ever retried.** An owner who fixed the Claude Routine without telling anybody stayed quarantined until somebody probed by hand. | Yes: Caleb 3-B, 3-C and Factory surface 3 read `RECOVERY_EXHAUSTED` | **Yes, bounded.** One probe a day for 14 more days, with the owner still named and the alert saying when Brain checks next. | `connectionRecovery`: daily check after the fast budget, and the late fix lifted by itself. Both fail on the old code. | Every extra probe is a real activation (≤ 14 per Routine). |
| 9 | **A session that checks in without `session_ref` left no arrival.** Its fires read as unanswered and its count never reset. | Yes | **Yes, narrowly.** It is credited only when its credential's connector holds exactly one open fire for that worker in the window, and nothing when there are two. | `connectionRecovery`: credited to the one open fire; two open fires credited to neither (the first fails on the old code). | A sibling's sessionless session could still mask one Routine's silence on a shared connector. |
| 10 | Held in-memory evidence was matched without the fired worker. | Read from code | **Yes.** The worker is passed in. | Covered by existing outage tests. | — |
| 11 | Database outage → "Not authorized" | Previously (§53) | Already fixed. Re-verified: no path found. | Chaos matrix, 20 cases | — |
| 12 | Concurrent refresh / lost reply | Previously (§51) | Already fixed: derived successor, 5-minute leeway | Existing tests | A client keeping per-session copies of an old refresh token for over 5 min would be refused once. Not observed. |
| 13 | Refresh token expiry | — | Not a defect: 30-day sliding window, no absolute cap | Code | 30 days with no refresh at all (a month-long quarantine) needs consent again. That is by design. |
| 14 | Restart windows | Yes: 15 in 48 h | Already handled: the restart window excuses fires | Existing tests | Fires sent between `listen` and the platform routing traffic (about 35 s) are not confirmed either way. |
| 15 | **Routine chooses the wrong connector** (Airyn 2-B/C/D) | Yes: 52 wrong-worker arrivals on 2-C in 7 days | Detected and stopped after one activation (§59). | Production rows | **Claude-side.** The Routine holds both of Airyn's Brain connectors. Only the account owner can remove `/mcp` from it. |
| 16 | **Routine whose sessions never reach Brain** (Airyn 2-B since 10-11; Caleb 3-B, 3-C and 3-D; Factory surface 3) | Yes: probes read NO_MCP. 2-B's probe connector is shared with 2-A/2-C, which do reach Brain. | Not fixable in Brain. Brain now keeps checking daily and lifts by itself once fixed (row 8). | Production rows | **Claude-side.** Brain cannot read Airyn's or Caleb's Routine configuration: `list_triggers` from this session shows only the owner's account. |
| 17 | Tool-name allowlist mismatch (`mcp__Factory_Brain__*` vs the bootstrap's lowercase `mcp__factory_brain__*`; Brain's suggested name "Brain (Name)") | No | Not changed | Claude Code docs: a Routine's attached connectors run "without asking for permission", so this is probably not a blocker. | Not established. |

## What is established, and what is not

- **Established by tests on both backends:** every row marked fixed. Each
  regression was run against the code it replaced and failed there.
- **Established in production:** the latency and the slow answers that caused
  rows 1–3. The handshake fix, the slow-answer record and the recovery changes
  have **not** run in production yet. Durability needs elapsed time after the
  release. The 24 h, 48 h and 72 h Airyn readings already scheduled are where
  that is read.
- **Not reachable from here:** Airyn's and Caleb's Claude Routine
  configuration (which connectors each Routine holds, and whether it starts).
  Only the account owner, or a session signed in to that account, can read or
  change it.

## After release, 2026-10-15 21:39Z

The release went out in Deploy 38805467065 on `1c61b183`, which contains #207. The connection report read it back as `SERVING_REVISION 1c61b183`.
- **Both hosted verifications never ran.** The harness itself could not get a pooler connection (`ECHECKOUTTIMEOUT … after 15000ms`). That is the database condition above. It is not a check that failed.
- **Already seen in production:** a 29.4 s token refresh was recorded as `SLOW_ANSWER @ oauth:token`, on the arrival path. Before this change, the session behind it would have been a no-show.
- **Already seen in production:** exhausted alerts now say when Brain will check again.
- **Already seen in production:** no unanswered fires in the window since the restart.
- **Already seen in production:** Airyn 2-B's right-worker arrivals rose from 2 to 3.
- **Not established yet:** durability over days. The scheduled 24 h, 48 h and 72 h Airyn readings are where it is read.
- **Seen in CI:** the Postgres gate on `2bc9b4a` failed twice in `independenceEvidence` setup (a test schema vanished mid-migration). The same suite passed on `1c61b183`. The cause is a test-harness race, not this change, and it is not fixed here.
