# Deliverables: from a Russell request to a file a person can open

§51 of `CLAUDE.md` holds the rules. This is how the journey actually runs, what
each piece is, and how to read it back from production.

## The journey

```
person, in Russell:  "Put together a dossier comparing … as a PDF"
  │
  ▼  RUSSELL_TURN_V1 bin — a worker reads the thread and proposes
REQUEST_DELIVERABLE { title, kind, requestedFormat, intendedUse, audience,
                      requiredContents[], sourceRequirements,
                      acceptanceConditions[], externalDelivery }
  │  validateProposal (exact), captureDeliverableRequest:
  │   · the owner's authority (WRITE on the project), never the worker's
  │   · a deterministic gate: the person's own words must name an output
  │   · format honesty: PDF / PPTX / CSV → nearest verified format + a need
  ▼
deliverables row, BRIEFED  ──(same tick)──▶  DELIVERABLE_BUILD_V1 bin
  │  manifest carries the brief, the content schema, the rules and the
  │  project's citable claims whole (no worker tool dereferences a claim id)
  ▼  worker submits structured content under unit "content"
completion contract runs validateContent while the worker holds the lease:
  every cite is a citable claim of this project · every figure appears in a
  cited claim · every required content is covered or declared a gap
  → RETRY with the exact problems, or satisfied
  ▼  tick
Brain renders the file itself (DOCX or XLSX), stores it through the storage
layer at projects/<slug>/deliverables/<id>/v<n>/<file>, reads it back out of
the store and checks it natively:
  DOCX: jszip opens it · XML parts well formed · mammoth renders it · every
        heading, passage, table and source present · every [n] resolves ·
        every link is its claim's URL · limitations carried
  XLSX: jszip opens it · sheets in order · every cell reads back as specified ·
        every formula recomputed from the cells it names equals its cached
        value · Sources sheet resolves every cited claim · links match
  │  failed → findings, REPAIR build (≤ 4 builds), else NEEDS_PERSON
  ▼  passed → DELIVERABLE_REVIEW_V1 bin
a different session reads the rendered pages and the cited claims and
answers PASS | REPAIR with findings and per-requirement coverage
  │  same session as the builder → refused, re-asked (≤ 3), else NEEDS_PERSON
  │  REPAIR → REPAIR build carrying the findings → new version
  ▼  PASS
DELIVERED: current_version_id moves; a Russell message in the original
conversation carries the link, what the file contains, what was verified,
the reviewer's independence tier, and every limitation.
  │
  ▼  later, in the same conversation: "change the dossier to …"
REQUEST_DELIVERABLE { revisionOf, correction } → REVISION build → v(n+1)
  (v(n) keeps its bytes, its row and its link; current moves only on PASS)
```

## Where each piece lives

| Piece | File |
|---|---|
| Schema (both chains) | `server/db/migrations/093_deliverables.sql`, `server/db/pg-migrations/084_deliverables.sql` |
| Types | `server/domain/deliverables.ts` |
| Rows, CAS moves, versions, findings | `server/repos/deliverables.ts` |
| The content contract | `server/services/deliverables/content.ts` |
| Evidence pack and resolver | `server/services/deliverables/evidence.ts` (`projectCitableClaims` in `repos/research.ts`) |
| Renderers | `docx.ts`, `xlsx.ts`, `zip.ts` in `server/services/deliverables/` |
| Native check | `server/services/deliverables/check.ts` |
| Review contract | `server/services/deliverables/review.ts` |
| Bin contracts | `server/services/deliverables/contract.ts`, wired in `services/bins/contracts.ts` |
| The pipeline (tick) | `server/services/deliverables/pipeline.ts`, called from `services/russell/loop.ts` step 1b′ |
| Russell action | `REQUEST_DELIVERABLE` in `services/russell/proposal.ts`, effect in `turn.ts`, capture in `services/russell/deliverable.ts` |
| HTTP | `server/routes/deliverables.ts` |
| Client | `DeliverableTrail` in `client/src/russell/Conversation.tsx`, `Deliverables` on the Work view |
| Walk | `tests/deliverables.test.ts` |

## Routes

- `GET /api/projects/:projectId/deliverables` — every deliverable in a project.
- `GET /api/deliverables/:id` — one, with every version, check and finding.
- `GET /api/deliverables/:id/file` — the current version's bytes.
- `GET /api/deliverables/:id/versions/:n/file` — version *n*, permanently.
- `GET /api/deliverables/:id/versions/:n/preview` — the rendered view the
  reviewer read, served inert (no script, no network).
- `POST /api/deliverables/:id/revise` `{ correction }` — a person only.

All of them resolve the project through `authorizeProject`: absent and
forbidden are one 404 with one body.

## What it deliberately does not do

- **It does not send a file anywhere.** A request to email or publish becomes a
  need on the deliverable, stated in the file and the message.
- **It does not render PDF or slides.** It builds and verifies DOCX and XLSX,
  and a request for another format gets the nearest one plus a named need.
- **It does not research.** A deliverable is composed from claims the project
  already accepted through the evidence gate. A required content the archive
  does not settle is declared a gap, and the gap is written into the file.
- **It does not store a worker's file.** There is nothing in a worker's
  environment to strand: the worker submits content and Brain writes the bytes.

## What production needs

Nothing new to configure. The bins route to the research family by their
`RUSSELL_` workload class, the storage layer is the one every document uses,
and `jszip` is a direct dependency. The production checks are jszip, mammoth
and Brain's own cell reader and formula evaluator — no office suite, no
browser.
