# Historical memory

Brain's recovery, organization and rediscovery of a person's own conversation
history. The page is **Historical memory** (`/memory`, under More). The code is
`server/services/memory/`; the schema is migration 142 (SQLite) / 133 (Postgres).

## What it does

1. **Recovers** a whole ChatGPT history — the official export or ChatGPTExporter
   JSON/Markdown — plus every conversation the bridge syncs live.
2. **Organizes** it into topics the material suggests, merging and splitting them
   as it grows, with many-to-many membership.
3. **Excavates** a registry of ideas, goals, projects and commitments from the
   person's own words, and reconstructs what happened to each.
4. **Rediscovers**: brings back what deserves another look, says why and why now,
   links the source conversations, and acts on the person's decision.
5. **Keeps going**: re-evaluates when new conversations arrive, when the person
   records a change in circumstance, and when Brain's own projects or abilities
   change.

## Starting it — the one input it needs

Nothing is recovered until an export is imported. Brain cannot reach ChatGPT
history by itself (see `CONVERSATION-BRIDGE.md`, *When synchronization actually
happens*).

1. ChatGPT → **Settings → Data controls → Export data**. The emailed link
   downloads a `.zip` containing `conversations.json` and the uploaded/generated
   files.
2. Either choose that zip on **Historical memory → Import & coverage** (it is read
   in the browser and sent in batches), or, for a very large export, from a
   terminal: `npm run memory -- import export.zip --url https://<brain> --key brnc_…`
   (the key is the person's own bridge credential).
3. Interrupted? Run the same import again. The manifest is idempotent and Brain
   answers which conversations are still missing; only those are sent.

## Layers

| layer | tables | rule |
|---|---|---|
| Original | `memory_archives`, `memory_archive_entries`, `memory_conversations`, `memory_conversation_versions`, `memory_messages`, `memory_attachments` | Exactly what arrived. A changed conversation is a new version; a changed message is a new row and the old row records the version that superseded it. Raw objects are kept in the document store under `memory/<owner>/…`, their hashes beside them. |
| Derived | `memory_passages`, `memory_topics`, `memory_topic_members` | Rebuilt deterministically from the original layer; never a source. |
| Decided | `memory_ideas` (+ `_versions`, `_evidence`, `_links`), `memory_discoveries`, `memory_decisions`, `memory_hubs`, `memory_circumstances`, `memory_practice` | Interpretations and the person's decisions, each resolving to passages of the original. Decisions are append-only; ideas are versioned. |

`memory_events` is the append-only log (counts and ids only — safe to print).
`memory_cursors` holds two whole-archive watermarks (organized, re-evaluated).

## What is kept from an export

Conversation ids and titles; created/updated times; every node of the message
tree with parent, depth, sibling order and whether it is on the path the person
last read (edited prompts and regenerated answers are alternates, not lost);
roles, model, content type, hidden context; images, uploaded files, audio and
generated images as attachments (with dimensions/size/metadata), and their bytes
when the archive holds them; the ChatGPT Project / custom GPT a conversation
belonged to; citations and other message metadata. Markdown imports say they
carry no ids, branches or times rather than inventing them.

## How each judgment is made

Deterministic first (`classify.ts`), because it is cheap, auditable and repeatable:

- **Passages** are paragraph-sized pieces of a message. The person's passages get
  *kinds* (goal, idea, project, commitment, plan, progress, obstacle, rejection,
  pause, completion, direction change, question, decision); every passage gets
  *facets* (domain, film facets, obstacle category). An assistant passage never
  gets a kind: an answer listing ideas is not the person's ambition.
- **Topics** are subject terms the archive repeats across conversations, weighted
  by distinctiveness; overlapping topics merge (Jaccard ≥ 0.6, recorded as an
  event), broad ones split into subtopics, and retired topics are kept.
- **Ideas** are seeded by every passage in which the person states an intention,
  however rarely — frequency is never the gate. A restatement joins the idea it
  repeats (shared subject words), so one idea is one row.
- **State** is the last thing the record says: pursued → ACTIVE, put on hold →
  PAUSED, given up → REJECTED, finished → COMPLETED, replaced by another idea →
  SUPERSEDED. Silence is **UNRESOLVED**, never "abandoned". A decision made in
  Brain outranks the archive.
- **Commitments** need pursuit, not talk: ≥ 5 conversations, ≥ 2 months, and
  statements of intent or progress in the person's own words. A pursued
  commitment gets a prepared **hub** with a draft plan; accepting it makes it a
  Brain project. Movie School is prepared whenever film material exists, and
  keeps the historical foundation separate from future practice and assessment —
  discussion frequency is never read as skill.

Models are spent where the person decides to go further: an idea they choose to
explore or plan becomes a Russell idea (`russell_candidates`), which Russell's own
pipeline judges and turns into missions on the fixed-subscription fleet. No paid
API is introduced.

## Rediscovery

A discovery needs a reason, recorded as its trigger: unresolved and quiet for a
month or more; a new conversation that returned to it; or a circumstance —
recorded by the person (`POST /api/memory/circumstances`) or derived by Brain
(its active projects, its ability to build software) — that removes the obstacle
the idea stalled on or makes it newly relevant. At most 12 are open and at most 4
are added per pass. The score takes the larger of how plainly it was wanted and
how much it was returned to, so a single emphatic idea competes with a topic of a
hundred conversations; it is multiplied by a learned per-kind weight from the
person's decisions and follow-through.

Choices: **A** explore (→ Russell idea), **B** game plan (→ Russell idea plus a
draft plan on the record), **C** dedicated project (→ new Brain project), **D**
later (eligible again only when something changes, after a cooldown), **E** not
interested (kept, never resurfaced), **F** update what I want (new version).
Free-text feedback is stored with every decision.

## Processing

`runMemoryPass` is the deferrable `historical-memory` pass on Russell's tick. Each
stage reads what is due from row checkpoints (`indexed_version`,
`excavated_version`, `reconstructed_at` vs `evidence_changed_at`), so a pass cut
short resumes and nothing is processed twice. Summer 2025 onward is indexed
first; nothing earlier is skipped. Rediscovery waits until the history has
settled. The initial sweep can be forced with `npm run admin -- memory sweep`
(or the Admin workflow); `memory show` prints the coverage counts per owner.

## Privacy

Every route is `requirePerson` and every statement is scoped to the owner;
another person's ids read exactly as absent ones. Workers are refused by type.
Logs, events and admin output carry counts and ids, never text. Raw exports live
only in the owner's document store prefix.

## Coverage

`GET /api/memory/coverage` (and the Import & coverage tab) reports, with
denominators: conversations declared vs recovered vs failed vs not yet sent;
messages declared vs stored; alternate branches and superseded versions kept;
attachments referenced vs recovered; messages indexed for search; topics, ideas
and discoveries. It separates **recovered**, **discovered but not recovered**,
and **unverifiable** (anything no archive declared), and never claims
completeness beyond what an archive declared.
