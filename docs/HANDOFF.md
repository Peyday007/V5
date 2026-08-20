# Handoff — existing-evidence reconciliation, dynamic fragmentation, large-archive ingestion, live Antigravity

**Branch** `claude/zealous-hypatia-78a2yp` · **Final commit** `b6aa055` ·
**Base** `64aceb6` (accepted Checkpoint C)

## Internal checkpoints

| Commit | What it added |
| --- | --- |
| `ff729b4` | Folder-scale archive import: discovery, per-file state, resume, retry, provenance |
| `8743bdd` | Boundary contract, requirement graph, existing-claim extraction, coverage matrix, gap-only fragments |
| `282063d` | Evidence standards per claim type, source-independence grouping, splitting, dependency order |
| `190dac2` | Job bundling: compatible fragments share one execution, never one verdict |
| `5e6d0df` | Execution tiers, quota pause and resume, model tiers, paid overages off by default |
| `82f1934` | New-evidence reconciliation, contradiction classification, planned repairs |
| `2c489ce` | Provider connection service, real detect/test, PTY path behind a flag |
| `5fca6e5` | Settings → Research Providers → Antigravity |
| `5b7f4bc` | Review before execution: plan everything, spend nothing, wait |
| `8a61efb` | Packet coverage before synthesis, targeted repair, old-and-new evidence in one ledger |
| `1fa06d6` | Live progress from persisted state, review UI, restart recovery for jobs |
| `c058840` | Three subsystems reported separately |
| `72aec48` | Migration test against a database that already holds data |
| `967bd20` | End-to-end acceptance run |
| `3054415` | CLAUDE.md rules and invariants |
| `29620e9` | Search pages and grounding redirects refused as sources |
| `b6aa055` | Windows verification and upgrade documentation |

## Migrations (all additive, applied automatically, checksum-locked)

| # | Name | What it adds |
| --- | --- | --- |
| 007 | `archive_import` | `import_jobs`, `import_files`; `documents.import_job_id / source_path / source_modified_at` |
| 008 | `evidence_reconciliation` | `boundary_contracts`, `requirements`, `existing_claims`, `requirement_coverage`; ~19 columns on `research_fragments`, ~11 on `research_claims` |
| 009 | `jobs_and_provider` | `research_jobs`, `research_job_fragments`, `quota_pauses`, `provider_connections`; `research_passes.bundle_id` |
| 010 | `findings_reconciliation` | `research_claims.contradiction_kind / reconciliation_detail`; `research_fragments.repair_plan / cancelled_reason` |
| 011 | `provider_models` | `provider_connections.light_model / verified_run_at / verified_run_detail` |
| 012 | `review_before_execution` | `research_orchestrations.auto_approve / approved_at / approval_note` |

No column is dropped, renamed or reinterpreted. Boot backs the database up first.

## Domain model

New enums: `QUOTA_STATES`, `QUOTA_SCOPES`, `CONTRADICTION_KINDS`, `REPAIR_STRATEGIES`,
`JOB_KINDS`, `JOB_STATUSES`, `RECONCILIATION_OUTCOMES`, plus `SEARCH_RESULT` and
`GROUNDING_REDIRECT` claim-validation states, `PAUSED_QUOTA` and
`AWAITING_APPROVAL` orchestration statuses, and five new event types.
New interfaces: `ProviderQuota`, `RepairPlan`, `ResearchJob`, `BoundaryContract`,
`Requirement`, `ExistingClaim`, `RequirementCoverage`, `ProviderConnection`,
`ImportJob`, `ImportFile`.

## Routes

- `POST /api/projects/:id/archive-import`, `GET /api/imports/:jobId`,
  `POST /api/imports/:jobId/{resume,cancel,retry}`
- `GET|POST /api/research/:id/review` — the plan, and the decision on it
- `GET /api/research/readiness` — now with the three subsystem statuses
- `GET /api/providers/connections/:provider` and
  `POST .../{detect,test,disconnect,paid-overage}`, `PATCH .../models`
- `GET /api/research/:id` — now carries `jobs` and the full `progress` snapshot

## Services

`archive/import.ts`; `reconcile/{claims,coverage,plan}.ts`;
`research/{standards,splitting,bundling,quota,repair,replan,contradictions,packet,review,progress}.ts`;
`providers/connection.ts`; `providers/antigravity/pty.ts`.

## UI

`ProviderSettings.tsx` (the connection page), `ResearchReview.tsx` (the plan
before execution), `ResearchProgress.tsx` (persisted-state progress), a SETTINGS
button in the top bar, and the three-subsystem readiness row on the research
panel.

## Tests — 427 passing, 24 files, 0 failing

| Area | File | Tests |
| --- | --- | --- |
| Archive import | `archive.test.ts` | 13 |
| Existing-evidence reconciliation | `reconciliation.test.ts` | 20 |
| Evidence standards & independence | `standards.test.ts` | 17 |
| Job bundling | `bundling.test.ts` | 8 |
| Quota & execution order | `quota.test.ts` | 9 |
| Repair plans | `repair.test.ts` | 9 |
| New-evidence reconciliation | `replan.test.ts` | 14 |
| Antigravity connection | `connection.test.ts` | 14 |
| Orchestration end to end | `research.test.ts` | 48 |
| Acceptance run | `acceptance.test.ts` | 1 |
| Everything from before | 14 files | 274 |

Archive import covers 40+ nested mixed files, duplicates, revisions,
unsupported and unreadable files, cancellation, restart, resume, retry-only-failures,
uncertain classification and project-wide transcripts. Reconciliation covers every
coverage status plus correct avoidance of unnecessary research. Restart recovery
covers interrupted passes, abandoned jobs, and leaving deliberate stops
(AWAITING_APPROVAL, PAUSED_QUOTA) alone.

## Status

- **RESEARCH ENGINE: READY**
- **ARCHIVE INGESTION: READY** (OCR present on this machine; without it, scanned
  pages are reported unreadable rather than treated as empty)
- **REAL ANTIGRAVITY WORKER: UNVERIFIED** — no live run has happened on the
  user's Windows machine. Everything above was verified against scripted
  providers, which proves the engine and proves nothing about the tool.

## Remaining blockers

One, and it is the known upstream stall: `agy -p` hangs when its stdout is a
pipe. The PTY path exists for it behind `BRAIN_ANTIGRAVITY_PTY=1`, but whether it
clears the stall on that machine can only be found out there. See
`docs/WINDOWS_VERIFICATION.md`.

Checkpoint D and Checkpoint E are not started, as specified.
