# Major-run decision report — deadline 2026-11-17 08:21Z (T0 03:21:56Z)

_Draft committed at the start of the five-hour window; the coordinator replaces it with the final version before 08:21Z. If you are reading this draft, the final update did not land — every line below is evidence as of 03:40Z._

## A. READY FOR THE MAJOR RUN: NO (as of 03:40Z)

## B. Fixed, deployed and verified on production (evidence)
- GPU routing to a deleted pod — #984; GPU fallbacks 72 → 0 (runpod-report 2026-11-16).
- Scheduling deadlock / holds — #992, #995; the 120B took 52–76 jobs/h afterwards (runpod-report 21:07Z, 01:45Z).
- Refusal accounting by model + what the model sent — #989, #990.
- Cost reporting from RunPod's live price, $ per accepted/surviving claim — #1001, #1005 (runpod-report 43997621795).
- RunPod REST outage: GraphQL fallbacks for read/stop/start/create/delete — #1006, #1008, #1009; a real pod was created and stopped through them.
- Billing-based budget cap with automatic shutdown — #1002 + #1011; production test 2026-11-17: cap $1/1h, pod 5e8ks9cr2o8yml stopped by Brain itself (RunPod $0/h at 03:01Z, before the manual stop at 03:10Z). Cost of the test $2.06.
- One-dispatch launch with budget — #1013 (runpod-launch).

## C. Remaining (03:40Z)
- GPU research does not reach the $10K goal: 0 accepted claims/h for wst_7b4fcbb5f2384f31b6c3 during the 01:02–01:49Z run; the goal's rounds: 4 of 5 ended without a report.
- 40% of the 120B's research answers refused (50 of 126).
- Both free fallback models fail 100% of calls.
- Transfer to unfamiliar objectives: not demonstrated in production (one commercial goal exercised).

## D. Cost basis (measured)
- H200 SXM: $5.29/h SECURE, $3.59/h COMMUNITY (RunPod quotes at pod creation, 2026-11-17).
- Model load: 888 s and 1005 s measured (≈ 15–17 min billed before serving).
- Throughput: 76 research jobs/h, 14.7 accepted claims/h lane-wide; $0.36 per accepted claim at RunPod billing.
- RunPod balance: $80.05 (03:07Z).

## G. Launch instruction
Not ready (see C).
