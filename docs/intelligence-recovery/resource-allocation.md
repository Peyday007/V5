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
