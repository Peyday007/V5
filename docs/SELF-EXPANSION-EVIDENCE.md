# What the self-expansion kernel can and cannot say, measured

A reading taken on 2026-09-18 against the reconciled tree, and against the
deployed Brain from outside it. Every figure here is a row, a hash, an exit code
or a count; anything that could not be measured says so rather than being
estimated.

---

## 1. What was reconciled, and why it needed reconciling

Three branches held parts of one workstream and none contained the others.

| Branch | Held |
|---|---|
| `origin/production` | the canonical tree, at `5db7866` |
| `claude/brain-self-expansion-kernel-yoxx30` | the kernel: blueprint ingestion, the self-model, realization packets |
| `claude/lucid-bardeen-r57iw7` | Research Intelligence (§35) |

Both feature branches took migration `067` on the SQLite chain and `058` on the
Postgres one. `loadMigrationFiles` refuses a duplicate version rather than
applying one and skipping the other, so the collision would have been a boot
failure with a sentence in it — §25's lesson, second occurrence. Research
Intelligence renumbered to `070`/`061`, which is a rename rather than an edit to
an applied migration: **neither chain had been applied anywhere**, and the
hosted tool list not carrying `brain_propose_plan_revision` is what establishes
that.

Both sections claimed `§35`. The kernel's is `§36` now; nothing was deleted.

## 2. The blueprint is the same bytes the kernel branch read

| Artifact | sha-256 | Bytes |
|---|---|---|
| `Brain_Intelligence_Map.md` | `da524c64808d85c101394e75903696e3b66aad550ae2163cbb7c42ecf7ca3ef0` | 63 586 |
| `AMENDMENT-001-faculty-14.md` | `78d42f34ccf8649894261f497f043ba21bfeb98d5f30715dd5ca6fa24faf5fe7` | 3 342 |

Registered on the reconciled tree, extraction `READY`, **15 sections declared**
from the document's own headings — identical to what `docs/CAPABILITY-KERNEL.md`
§5 recorded. The two documents are therefore the same artifacts rather than two
copies that happen to share a title.

## 3. The self-model census moved because the tree did

| Reading | Components |
|---|---|
| kernel branch, before the merge | 571 |
| reconciled tree | **589** |

Eighteen more, and no level moved on any existing component. The scan was taken
with no `BRAIN_REVISION`, which it reports as *unstamped* rather than attributing
the reading to a commit it cannot see — a local checkout legitimately has none.

## 4. Gates

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| SQLite suite | **159 files, 3 487 passed, 41 skipped** |
| Postgres suite, merged tree | **159 files, 3 497 passed, 12 skipped** |
| Postgres suite, with the three mechanisms | **160 files, 3 515 passed, 12 skipped** |
| Migrate from empty | 71 migrations applied in order |
| Restart against existing | clean; no reapplication, checksums verified |
| `deploymentOwnership` | 18 passed — no chain gap, no collision, no port collision |

One failure came out of the merge and nothing else could have found it:
`operatorConsoleRemoved` read `services/capability/reader.ts` as a second writer
of the site connector scope set. It is not one — it *cites* the constant in a
comment explaining why its own scopes are a constant, and grants a different set
to a different worker. The rule was right and the matcher took co-occurrence
anywhere in a file as a write. Tightened to match the write itself, and asserted
against both the write it exists for and the comment that produced the false
positive.

## 5. The deployed Brain, read and not touched

Read through the MCP tools as a `WORKER` principal. **Nothing was claimed,
completed, failed, released, cancelled or enqueued.**

- Eight projects. Four Cash Modes; only `Cash Mode 1` holds work.
- `Cash Mode 1` carries **15 work items `LEASED` with expired leases** and 4
  `QUEUED`. Several are past `max_attempts` — `attemptCount` 4, 6 and 7 against
  a maximum of 2.
- The most recent lease is `2026-09-18T16:22:29Z`, so the fleet is alive and
  workers are still arriving.
- Seven items record the same worker-reported fault: `brain_submit_synthesis`
  answering *"That call could not be completed"* across several orchestrations,
  leases and payload sizes, between 2026-09-17 15:10 and 2026-09-18 06:02.

**That fault has a recorded cause and a shipped fix, and the fix is now in
`origin/production`** — §33's *a key is not a filename*, where the bucket
refused the key of every staged cash report whose title carried an em dash. The
failures predate the fix reaching production. §33 also records, deliberately,
that the parked packets are **left exactly as they are**: reading them is not
repairing them, the reissue is a person's, and replaying live Cash research was
outside what this work was authorized to do.

**What is not established:** whether every one of those fifteen leases is
explained by that fault. The worker summaries name it on seven; the other eight
carry no summary, and saying they are the same thing would be the comfortable
half-truth this repository refuses.

## 6. What is now callable that was not

Three mechanisms existed, were tested, and had no caller.

| Mechanism | Was called by | Is now reached from |
|---|---|---|
| `moveDimension`, for five of six dimensions | nothing | `services/realize/realized.ts`, `npm run capability -- packet realize` |
| `compile()`'s `ObjectiveSubmission` | a printer | `services/realize/handoff.ts`, `npm run capability -- packet handoff` |
| `directorPass`'s questions | nothing | `services/realize/askTheWorld.ts`, `npm run capability -- packet ask` |
| `judgeGap`, the only way out of `NEEDS_A_READING` | four test suites | `npm run capability -- packet judge` |

The fourth is the one that made the other three unreachable in practice.
Everything downstream of an unread gap refuses — `readiness`,
`decisionReadiness`, `compile`, `handOff`, the implementation reading — so a
production packet could enter that state and never leave while every part passed
its own tests.

All three commands were driven against a real database rather than only against
tests, and each refuses correctly on an unknown packet.

## 7. What is still not true

- **No faculty is implemented.** `realized.ts` can now say one is, from rows.
  On this repository every packet still holds unread gaps, so it says nothing.
- **Nothing here has been deployed.** Every reading above is local.
- **No capability research has run.** A question becomes an idea; whether a
  mission follows is the standing authority's decision, and none has been
  granted on the architecture project.
- **The fifteen faculty readings were not re-run.** The kernel branch did that
  once and recorded it; the hashes above establish the artifacts are identical,
  so a second reading of the same bytes by the same session would produce the
  same thirteen promotions and no new information. What it would *not* produce
  is the independence the kernel branch already declined to claim: two handles
  are two workers and two sessions, and whether two model contexts were behind
  them is a fact no row can establish.
