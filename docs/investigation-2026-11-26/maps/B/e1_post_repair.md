# Map B: E1, after the wave-1 deploy (~2026-11-26T05:50Z)

**Has any goal been re-planned since the deploy?** No, for every goal readable here. The newest stored plan reading of each live cash goal predates the deploy:

| goal | reading time |
|---|---|
| wst_4f0c… | 01:31Z |
| wst_db2e… | 02:05Z |
| wst_6631… | 04:42Z |
| wst_deed… | 05:33Z |
| wst_7b4f… | 05:40Z |
| wst_fa47… | 05:43Z |

These were read at 06:35–06:39Z (B-O003). At 06:34Z all ten live goals were `NOT_DERIVED`, "Brain was too busy to derive the goal this run", and `PAUSED` by the owner's priority override of 2026-11-26 (B-O001, B-O002). So **no E1 plan output exists to evaluate**. I did not trigger a re-plan.

## What did run in E1 (all OBSERVED)

### Research queue
New RESEARCH_FRAGMENT items appeared in the paused $10k project at 06:36, 06:44 and 06:52Z. None were leased; the project shows 47 QUEUED and 0 LEASED (B-O017).

### Bins
Bins of paused goals were touched, all READY or NEEDS_HUMAN and held `GOAL_PAUSED` (B-O016, B-O036):
- 06:39–06:40Z: all bins;
- 06:47Z: wst_6631…;
- 06:56Z: wst_deed….

### Knowledge library
Passes ran at 05:59, 06:30, 06:45, 07:00 and 07:15Z (B-O049):
- each finished DONE;
- the GPU interpreted metal-manufacturing NAICS;
- nothing was applied to any of the four cash projects.

### Hermes
In the hour ending 07:00Z it made 3 runs with 0 decisions and 0 actions, and inspected 0 goals (B-O043).

### Owner report, 07:05Z
- It still describes the $10k plan from the 05:40Z reading: 20.4%, binding CLOSE.
- It counts "50 plan reading(s)" in the hour.
- It does not say the goal is paused.
- Pipeline for the hour: research done 8, failed 13, queued 2,614, oldest wait about 88 days; PROCESS_RESTART ×2.

(B-O042, B-O044)

### Capacity at 07:12Z
- The live read did not finish in 20 s, so a cached reading was served.
- FREE_LANE: 1,264 waiting, both model slots held for "database connections contended".
- RESEARCH_SLOTS: 2,398 waiting, idle beside work.
- ROUTINES: 0/0 of 12.
- GPU: A100 RUNNING at 6 in flight against a target of 16, restricted by DB contention; 662 jobs accepted in 24 h, 11 in the last hour.

(B-O045, B-O046)

### Allocation at 07:15Z
- Reach is 0.0% for five goals, with the $10k goal "moved −97 pts", and 87% for wst_deed….
- Every goal is HOLD with "no executable work".

(B-O041)

### Read path
Two evidence searches on the $10k project timed out at 60 s, at 07:23Z and 07:25Z (B-O053).

## Implication for the investigation (INFERRED)

E1 is behaviourally unobserved for planning. The deploy can only be judged after a goal is re-derived and re-planned. The system-level conditions present at E1 would apply to the first re-plan:
- DB contention throttling the free lane;
- an idle routines pool;
- a research queue with an oldest wait of about 88 days.

See G15 and G10 in `observation_gaps.md`.
