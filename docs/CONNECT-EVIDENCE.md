# The connector, proven

Everything below was read back from a database or an HTTP response. Nothing in
it is a summary of what a previous step printed.

The run used **both real applications** against **real databases**: Brain on its
own data root, Deal Dispatch on Postgres with its own migrations applied and its
own seed run, and the two talking over HTTP with a Brain-issued credential.

---

## The record

| | |
|---|---|
| Deal Dispatch opportunity | `cmtv9ata600fik61zz0v1lmia` |
| Name | Subcontracting: Brightpath Family Dental — Facility has recurring outsourced-service needs |
| Stage at import | `QUALIFICATION_REQUIRED`, later `BUYER_NEED_CONFIRMED` |
| Brain identity | `ext_62bd8c3386df40a5b8bc` |
| Brain project | `prj_ffae57f01c3c4024a518` |
| Brain idea | `rcn_e454c013b4b04bb18081` |
| Brain mission | `rms_3fb57b072c4149f48abb` |

---

## 1. It imports once

```
Meridian Deal Operations — 14 opportunity(ies)
  imported 14, updated 0, unchanged 0, older-than-held 0, refused 0 (1 page)
```

`external_records` afterwards: **14**. `external_record_rejections`: **0**.

## 2. Repeating the backfill creates zero duplicates

```
  imported 0, updated 0, unchanged 0, older-than-held 0, refused 0 (1 page)
```

Nothing was even sent: the local content digest matched for all fourteen, so the
second run made no request at all. `external_records` still **14**.

## 3. Updating the source updates the correct Brain object

The opportunity's stage was changed on the site and the push run:

```
  imported 0, updated 1, unchanged 0, older-than-held 0, refused 0
```

Brain then held `sourceState: BUYER_NEED_CONFIRMED`,
`sourceVersion: 2026-09-10T08:24:14.835Z` — and its own derived `state` was
unchanged by the update. Neither side overwrote the other's field.

## 4. An older or reordered update cannot win

A delivery replayed at `2026-01-01T00:00:00.000Z` with a different title:

```
{"imported":0,"updated":0,"unchanged":0,"stale":1,"rejected":[],"total":14}
```

Brain still held the newer title and the newer version.

## 5. Brain's projection reaches the site

| Measurement | Result |
|---|---|
| Brain state change → the site's record page | **202 ms** |
| Brain state change → the record reappears in a cursor-filtered poll | **3 554 ms** |
| The typed command → an answer on the site | **77 ms** |

The five-second target for an important state change is met by the second
figure; the first is the page a person is actually looking at, which reads
Brain live rather than polling.

## 6. One website command is one Brain action

The command was issued **five** times — once from a shell that died before it
could read the response, then four more times deliberately. Every reply after
the first carried `replayed: true`.

```
candidates: 1
operations: 1          (connect.command, SUCCEEDED, attempt_count 1)
command events: 1      (EXTERNAL_COMMAND_ACCEPTED)
linked records: 1
```

## 7. Duplicate delivery, and restarting either side

The lost-response case above is the restart case: the caller never saw the
answer, retried, and Brain replayed rather than performing a second command.
The Brain server was also stopped and restarted between commands in
`tests/connect.test.ts`, which asserts the same thing against a real socket.

## 8. Brain acts on it, with nobody involved

Within one Russell tick of the command:

```
candidate  rcn_e454c013b4b04bb18081  QUEUED  WORTH_DOING
           "useful strengthening work with nothing blocking it"
mission    rms_3fb57b072c4149f48abb  RUNNING
```

And the site, re-rendered with no manual step:

> **Brain** — Read from Brain just now
> **Being researched** · **Worth doing**
> Brain is researching this now.
> Why Brain ranks it there: useful strengthening work with nothing blocking it
> Asked for by Alex Reyes on 2026-09-10.

## 9. Unauthorized and cross-project access is refused

On the site:

| Caller | Result |
|---|---|
| Anonymous | `401` |
| Caller role (`dana@`) | `403 Missing one of: opportunity.write, deal.write` |
| Research reviewer (`research@`) | `403` |
| Owner, unknown opportunity id | `404 Opportunity not found` |

On Brain, with the site's own credential:

| Request | Result |
|---|---|
| A project the credential does not hold | `404 No project with that id.` |
| A project id that does not exist | `404 No project with that id.` — **the same body** |
| No credential | `401 Not authorized.` |
| A fabricated credential | `401 Not authorized.` |
| A worker holding `project:read` but not `external:sync` | `404` |
| A source system this Brain does not speak | `404` |

## 10. No paid model or API path is activated

The Brain the loop ran against had `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
`BRAIN_PROVIDER` all unset. `tests/connect.test.ts` asserts that after the
command there are **zero** research orchestrations and **zero** queue items in
the project — the command captures an idea and nothing else — and
`tests/brainConnector.test.ts` asserts that no file in the site's connector
mentions a provider host or an API key.

## 11. Storage accounting does not duplicate stored evidence

Three documents were registered, two of them byte-identical:

```
usedBytes < rawBytes,  duplicateBytesSaved > 0
```

The used figure groups by `file_hash`, so the two identical files count once.

With capacity and a unit price configured the reading is complete:

```
0.00 GiB of 2.00 GiB used (0%).   level OK
growth: null — "growth needs two readings and this Brain has taken one so far"
```

With them unset every derived figure is `null` and the reading says why, rather
than estimating.

## 12. Every Brain record traces back to its source

```
ext_62bd8c3386df40a5b8bc
  source_system       DEAL_DISPATCH
  source_record_type  OPPORTUNITY
  source_record_id    cmtv9ata600fik61zz0v1lmia
  source_version      2026-09-10T08:24:14.835Z
  source_ref          /opportunities/cmtv9ata600fik61zz0v1lmia
  content_hash        43c70d4a36db1c6c97e0b839730de64dbd3092718eafbcc135bdcc21c2570535
  idempotency_key     connect:DEAL_DISPATCH:cmtv9ata600fik61zz0v1lmia
  candidate_id        rcn_e454c013b4b04bb18081
  commanded_command   RESEARCH_FURTHER
  commanded_by_label  Alex Reyes (Owner)
  provenance          {"contract":"connect.v1", …, "registeredAt":"2026-09-10T08:42:44.095Z"}
```

And in the other direction:

```
candidate rcn_e454c013b4b04bb18081  ->  DEAL_DISPATCH cmtv9ata600fik61zz0v1lmia
mission   rms_3fb57b072c4149f48abb  ->  candidate rcn_e454c013b4b04bb18081
```

The project's own append-only history carries 14 `EXTERNAL_RECORD_IMPORTED`
rows and one `EXTERNAL_COMMAND_ACCEPTED`, and `identity_events` records the
authenticated principal for each:

```
EXTERNAL_COMMAND  WORKER  SUCCESS  {"sourceSystem":"DEAL_DISPATCH","sourceRecordId":"cmtv9ata6…","command":"RESEARCH_FURTHER"}
EXTERNAL_SYNC     WORKER  SUCCESS  {"sourceSystem":"DEAL_DISPATCH","imported":14,"updated":0,"unchanged":0,"stale":0,"rejected":0}
```

A body field naming a different worker changes nothing: `tests/connect.test.ts`
sends one and asserts the audit row still carries the credential's own worker id.

## 13. Both suites are green, on every backend used in production

| Suite | Result |
|---|---|
| Brain, SQLite | **1 923 passed**, 37 skipped, 0 failed |
| Brain, Postgres | **1 948 passed**, 12 skipped, 0 failed, exit 0 |
| Deal Dispatch | **989 passed**, 0 failed |
| Brain build (`npm run build`) | clean |
| Deal Dispatch build (`npm run build`) | clean, 44 routes |

The Postgres run earned its place twice.

The three new tables were first created without `seq`, the identity column
`dialect.ts` rewrites `rowid` to, and every cursor-ordered query failed there
while passing on SQLite.

And it surfaced a teardown race nothing else had: `tests/research.test.ts`
passed an `async` callback into `onProgress`, which is declared to return
`void`, so the cancel it started was a promise nobody owned. On a database far
enough away to make the write slow it finished after the file's teardown had
closed the connection, and the run exited non-zero with every test passing.
The test now holds the handle and awaits it.

## 14. Nothing leaks the credential

Searched for the site's live credential in: Brain's server log, the site's
server log, both rendered pages, every `identity_events` row, every
`external_records` row, and the site's own `AuditEvent` table.

```
credential occurrences: 0, everywhere
```
