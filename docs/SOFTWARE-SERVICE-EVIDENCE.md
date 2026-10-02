# The Software Factory through Russell — live evidence

Every line here resolves to a row, a workflow run, a pull request or a commit.
A line that is not yet true says so. Fixture proofs are listed separately and
are never counted as live.

## 0. What production held before this build (read 2026-09-23, 15:40–16:09Z)

| Fact | Reading | Source |
|---|---|---|
| Serving revision | `222f8fd7` (Deploy 328) | Actions run 35866969134 |
| Hosted V5 campaigns | `fcp_189ea30c7ded4e7b9280` REMOTE COMPLETE → PR #31, merged by a person 2026-09-22T14:12:44Z | `factory campaigns` (run 35883263529), forge |
| How that campaign entered | from the **Deal Dispatch** project; no Russell software request behind it | same |
| Projects | `prj_ac780d726f394a8ca81d` **Brain Architecture** exists | `admin projects list` (run 35883496112) |
| V5 factory worker | `worker-10` `wkr_f8e118e87fd141689adc`, routed `FACTORY` for `peyday007/v5` only, caps `repository, repository-write` | `routing show` (run 35883499886) |
| V5 factory surface | `Factory surface 1` ENABLED, fires=18, refusals=0, unanswered=0 | `fleet show` (run 35886691591) |
| Research / Russell-turn surfaces | only `Caleb 3-A..D` ENABLED; `Brain Research A`, `1-B/C/D`, `Airyn 2-A..D`, `V2` QUARANTINED | same |

## 1. Defects found by reading the path end to end

1. The Russell Authorize buttons (thread and Needs You) posted no acceptance
   conditions; the server refuses to invent them and the factory refuses a
   contract without them — so **no Russell-authorized change could ever start**.
2. Nothing wrote to the originating conversation after authorization; the thread
   had no Authorize control at all.
3. A hosted campaign's merge was checked once, at completion, and never again;
   nothing observed deployment or behaviour.

## 2. Fixture proofs (not live)

- `tests/softwareDelivery.test.ts` — 15 tests, SQLite and Postgres.
- `tests/softwareThreadCard.test.tsx` — 4 tests, jsdom.
- Updated: `tests/softwareDecisionCard.test.tsx` (the assertion that pinned the
  defect now asserts the conditions are sent).

## 3. The live journey

Recorded below as it happens.
