# Resource consolidation: Surge B (directive of 2026-11-15 ~07:40Z)

Readings come from production. Each table row is one sample. Resource classes are never added together: a Claude routine, a free-lane slot, a research slot and a Factory slot do different work.

## Down-curve reserve (decided 07:50Z)

Surge A (reliability) closed at 02:45Z with every critical item verified. Its remaining backlog is noncritical:
- F10 idempotent goal creation;
- the filing upload transaction;
- factory MCP reads;
- `brain_check_in` latency after a restart;
- the stuck packet orc_aefa9509;
- the pg concurrent-query warning;
- CPU hotspots;
- H-8 dropped scheduled runs;
- P-12 release-gate contention.

**Reserve kept:** no dedicated agents. These stay active:
- Deploy's own verification (280 hosted checks before and after restart);
- the hourly report routine (session "Beginning of the end");
- Hermes' self-scheduled runs;
- this session, which watches every deploy and owns incident response.

If a production incident occurs (a Deploy fails after restart, `/healthz` above 5 s, or pool exhaustion recurring), this session redirects its engineers to it first.

Why that is enough: none of the backlog blocks Surge B or production. The one recurring operational cost is P-12, merges superseding deploys; it is handled by a release protocol, not by agents. Surge B merges only when no Deploy is in flight, and this has been agreed with the Factory release session.

## Capacity samples (Brain's four pools, `brain_operator_capacity`)

| at (Z) | ROUTINES run/cap (waiting) | FREE_LANE run/cap (waiting) | RESEARCH_SLOTS run/cap (waiting) | FACTORY run/cap (waiting) | notes |
|---|---|---|---|---|---|
| 07:46 | 3/12 (1) | 6/14 (11) | 14/16 (503) | 2/3 (1) | FREE_LANE: RunPod Qwen3-4B 2/2 held at proven capacity, and brain-a 4/12 "slots not filled" beside 11 waiting, so idle capacity sits beside waiting work: a defect, engineer assigned. RESEARCH: the 2 free slots are held by per-project grants. ROUTINES: 9 idle, 1 executable item. |
| 07:49 | 2/12 (0) | 8/14 (8) | 11/16 (504) | 2/3 (1) | FREE_LANE: brain-a 6/12, held at its database-pool share of 12/24 (a deliberate safety margin). RESEARCH: "5 launchable ideas have a free slot" but the launch pass is not taking them, so a second engineer is on it. ROUTINES no longer idle. |
| 08:10 (cached, 273 s old) | 2/12 (1) | 3/4 (3) | 13/16 (503) | 0/1 (1) | Read right after the restart for Deploy 1087 (Factory #923). FREE_LANE is held at its starting size. ROUTINES and FACTORY each show 1 executable item idle beside free capacity; both are re-read after warm-up before any fix is assigned. RESEARCH: 3 launchable ideas are not launching, which is fixed in part 8 (PR #925). |

## Other classes (07:46Z)

- **Claude Code sessions:**
  - 1 active: this one (Surge B director).
  - Idle and available: "Brain Architecture Release 01", which releases on its own program.
  - Surge A is closed; the others are idle or blocked on owner actions.
- **This session's engineering agents:** worktree agents, typically 2 to 4 at once. This machine is memory-limited, so tests run with at most 3 workers.
- **Production server:** Fly performance-2x with dedicated vCPUs since Deploy 1075. After the restart, the engine ran in 1.05 s and `/healthz` peaked at 26 ms (Surge A closeout).
- **Database pool:** 8 connections. The free lane's share is 3 of 6 (#922). Two exhaustions were recorded: 00:03Z (one Hermes inventory call) and 01:12Z (one Hermes run).
- **RunPod:** one RTX 2000 Ada running Qwen3-4B at $0.19/h. Its balance needs a top-up before about 11-20 (owner).
- **Model rate limits:** the free switchboard returned HTTP 429 on 2 of 4 model-lane calls (plan read at 03:53Z).
- **Deploy infrastructure:** one Deploy at a time; a newer merge supersedes the one in flight. About 30 to 45 min per release.

## Corrections

- **08:10Z: free lane (part 8, commit 95abb93, waiting for the part-7 Deploy to finish).** Three root causes:
  - `freeLane/worker.ts`: after a 503 from the provider, an item stayed blocked on brain-a for 5 to 60 minutes even once brain-a was answering again. So 8 of brain-a's 12 slots skipped work that was waiting.
  - `stageCapacity.ts`: a route counted as "failing" if its newest row in a 6-hour window was a failure. So 100 failures from hours ago held growth back.
  - Any failing route held growth on every model, so RunPod was held because of brain-a's failures.

  Fix: an item blocked because its route was down is freed as soon as that route answers again. A route now counts as failing only if it failed within the last 30 minutes, under 20% of its items were accepted, and it has not answered since. Only the failing route is held back. No limit was raised, and the existing safety behaviour still halves a route's concurrency when it errors or slows.
