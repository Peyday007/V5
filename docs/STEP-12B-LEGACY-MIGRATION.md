# Step 12B — the legacy migration map

§23 asks for an inventory of what the legacy console still does, a parity map
with existing destinations credited, and only the genuinely missing
destinations built. This is that inventory, taken from the code rather than
from memory: every row below is a real call the legacy shell makes.

**`/operator` is not in this document as a source.** It was deleted in §26 and
stays deleted: `GET` and `POST` return 404 for an anonymous caller and for an
administrator alike, there is no redirect, and `tests/operatorConsoleRemoved.ts`
reads the repository and fails on any link or any instruction to go there. The
console that remains is the old three-pane *main* console at `/legacy`, which is
a different surface with a different history.

## What moved, and where it is now

| Legacy capability | Destination | State |
| --- | --- | --- |
| Read a project, its layers and its next action | Russell home, Project → Overview | **Migrated** — one projection, `home.ts` |
| Master Planner ordering | Work, the five groups | **Migrated** — `work.ts` |
| Mission and packet state | Work, the mission card | **Migrated** |
| Conclusions, claims, sources, documents | Knows, grouped by kind | **Migrated** — `knows.ts` |
| Where the project's understanding runs out | Project → Frontier | **New in 12B** — `frontier.ts` |
| Search across everything | Search | **New in 12B** — `search.ts` |
| Fleet capacity, surfaces, policy | Who → Fleet centre | **Migrated and extended** — `fleet/view.ts` |
| Capability testing | Who → Capability Lab | **New in 12B** — `fleet/lab.ts` |
| Human approvals and gap decisions | Needs you | **Migrated** in 12A |
| Standing authority | Needs you | **Migrated** in 12A |
| Connected sites, credential, rotation | Connected sites | **Migrated** in 12C |
| Software Factory | Build | **Migrated** in 12A |
| Project maps | Project → Map and Other maps | **Migrated and extended** — `maps.ts` |

## What is still only in `/legacy`, and why

These are real capabilities with no Russell destination yet. Each one is an
*operation on the archive* rather than a view of the work, which is why none of
them blocked the product surface — and each is named here rather than quietly
left out.

| Capability | Legacy calls | Why it is still there |
| --- | --- | --- |
| Import a PDF or a folder, resolve an ambiguous import | `importFiles`, `resolveImport`, `importProjectSource` | Registering an artifact is §4's job and has its own guarded service. A Russell destination is a v1 improvement, not a 12B blocker. |
| Read a document's extracted text, findings, extraction run | `extractedText`, `findings`, `extraction`, `reprocess` | Inspection of a document's own processing. Technical by nature; belongs behind Technical depth when it moves. |
| Run, complete, fail, redo or upload a research run by hand | `startRun`, `completeRun`, `failRun`, `redoRun`, `uploadRunResult` | The manual path Steps 1–3 used. Russell's pipeline is the automatic one; these stay as the recovery route. |
| Freeze, reopen, recompute, reconcile a layer | `freeze`, `reopen`, `recompute`, `reconcile`, `reconcileFix` | State-engine operations. `recomputeProject` runs automatically after every meaningful action (§6); these are the manual override. |
| Prompt preview, packet manifest, synthesis preparation | `promptPreview`, `packetManifest`, `synthesis` | Internal Brain operations, which §23 explicitly routes *away* from the product surface rather than into it. |
| Provider connection, models, paid overage | `detectProvider`, `setProviderModels`, `setPaidOverage` | Paid inference is disabled at a `$0` ceiling and stays disabled. Moving this control into the product would put a spending switch on a surface a person uses daily. |
| Source ingestion review, link decisions | `ingest`, `ingestion`, `decideLink`, `reprocessUnfiled` | §11's proposals-become-evidence flow. A person accepts a link; the screen for it has not moved. |

**None of these is a hidden manual workflow for normal Brain use.** Ordinary
operation — asking Russell something, seeing what it is doing, approving what it
may spend, reading what it found, answering a decision — happens entirely in
Russell. The list above is the archive's own machinery and the manual recovery
paths, which is exactly what §23 says should *not* be promoted into the product.

## What `/legacy` is, at Step 12B completion

One click away behind the More menu, at its own address, unchanged. §23 forbids
a permanent "old dashboard beside new dashboard" state and this is the honest
reading of that: the new product is not a partial replacement waiting for the
old one to be finished. Everything a person does is in Russell; `/legacy` holds
the archive operations above and nothing that duplicates a Russell surface.

Removing it is a v1 improvement with a precondition — the seven rows in the
second table need destinations first — and it is recorded as a post-v1 item
rather than done hastily at the end of a release.

## Deep links

Every Russell address is a real link a person can bookmark, send and reload
onto: `/`, `/conversation/:id`, `/work`, `/build`, `/projects`, `/knowledge`,
`/fleet`, `/needs-you`, `/sites`, `/search`, `/legacy`. An unknown path is
`NOT_FOUND` rather than a silent redirect to the home page, because a stale
bookmark that quietly showed something else is how a person ends up believing
they are looking at the thing they asked for.

`/operator` is not among them and never will be. It is refused before the
client bundle can answer it, so the 404 is Brain's and not the router's.
