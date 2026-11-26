# L-002: Inventory of operational evidence (GPU, database, free lane), lead, Section 5

| source | epoch | what it establishes | class |
|---|---|---|---|
| docs/audits/2026-11-24-gpu-capacity.md | E0 (11-17 to 11-24) | <ul><li>The GPU (H200, gpt-oss-120b) did no work from 11-19 19:49Z because its fixed-window budget ran out.</li><li>**The production report credited the fallback's work to the GPU label** ("runpod 328 submitted … $125.77" while the pod was EXITED).</li><li>GPU concurrency was capped at 7–12 by Brain's event loop (85–100% busy), against the model's 128 sequences.</li><li>Brain restarted every ~20–30 min.</li><li>890 leases expired and 425 retries were ineffective in 24 h.</li></ul> | VALID BUT NEEDS RECHECK: GPU state has changed since. Probes on 11-26 were served by `gpu:openai/gpt-oss-120b`, so the pod was running then. |
| docs/RESEARCH-STARVATION-DIAGNOSIS round 2 | E0 (11-26 00:40–01:45Z) | <ul><li>Research capacity existed Brain-wide (5,148 free-lane items in 24 h).</li><li>Live goals did not get it: FIFO within a priority put cancelled goals' work first.</li><li>DuckDuckGo refused about 70% of searches.</li><li>Firecrawl was capped at 15 credits a day.</li><li>There was no keyed search provider.</li></ul> | VALID BUT NEEDS RECHECK: the coordinator's cancel/reinstate fix is reported merged and must be checked on E1 queue order |
| docs/audits/DATABASE-BOTTLENECK-2026-10-16.md | historical | database contention diagnosis from October | SUPERSEDED candidate, to be checked against 11-26 commits `a38fe9b` and `0b397c2` (free-lane saturation accounting, liveness reading) |
| production goal list, 06:26Z (worker-05) | E1 | <ul><li>Research goals are paused "to reduce system load (DB contention/FREE_LANE lag)".</li><li>The $10k goal is waiting on "CAPACITY: bin … queued at priority 8".</li><li>5 of 6 cash goals read "[NOBODY] Brain judges each idea on its next pass".</li></ul> | OBSERVED |

**Cross-cutting pattern (hypothesis H-LABEL):** a serving substitution is reported under the requested model's label in three places:
- the GPU report (audit 11-24);
- the Qwen route in the model exam (44 attempts served by nemotron under the Qwen name);
- Brain's route asks, where a fallback reply is not distinguished in the owner-facing outcome. E-015 is to confirm this.

This is one shared mechanism: *the served model is not the recorded model*. It conceals RC1 and RC14 from every downstream judgement, including the operations report's "STRONGER MODEL: NO" decision. **Status:** SUPPORTED. The 11-24 instance is measured; the route-ask instance is pending E-015.
