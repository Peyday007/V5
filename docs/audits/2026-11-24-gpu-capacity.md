# GPU capacity audit — 2026-11-24

The owner's dedicated RunPod GPU, measured from production. Each figure is
marked **MEASURED** (read from a production run or RunPod), **DERIVED**
(computed from measured figures), or **NOT YET MEASURED**.

Evidence runs (`cheap-lane.yml` unless noted): 44483902486 (runpod-launch,
11-19 08:00Z), 44489206809 (runpod-report 1 h, 11-19 08:38Z), 44281808757 /
44260466650 / 44252330377 / 44217821987 / 44353886005 (runpod-report while the
GPU ran, 11-17/18), 45260588741 (scheduled runpod-auto, 11-23 20:33Z),
45320773844 (runpod-report 24 h, 11-24 03:37Z), admin.yml 45321762270
(`free-lane show`, failed on a statement timeout).

## Headline

The GPU has done **no work since 2026-11-19 19:49:56Z**. The owner's bounded
run (`runpod-launch`, $57 for a fixed 12 h window from 08:00Z) exhausted its
budget ($62.45 spent) and the supervisor stopped the pod; a fixed window that
has ended refuses every start (`decidePod`), so it will not start again without
a new budget from the owner (rule 11: `SPEND_OVER_CEILING`).

Meanwhile the production report credited the free fallback's work to the GPU:
the 24 h report printed "runpod 328 submitted, 418 accepted claims, GPU COST
$125.77 for ~1426 min running" while the same report read the pod EXITED,
running ~0 min, stopped ~1,380 min (run 45320773844). Every GPU figure printed
since 11-19 was the fallback's. This change fixes that.

## Hardware

| figure | value | class | evidence |
|---|---|---|---|
| GPU | 1 × NVIDIA H200 SXM, pod `eaboawshas41wq`, secure cloud | MEASURED | 44483902486 |
| VRAM capacity | 141 GB (recipe `minGpuGb`) | DERIVED | `runpodRestore.ts` `gpt-oss-120b-big` |
| Hourly cost | $5.29/h running, $0/h now | MEASURED | 44483902486, 45320773844 |
| RunPod balance | $142.02, spending $0.000/h (11-23 20:33Z); $104.98 at launch | MEASURED | 45260588741, 44483902486 |
| Status | EXITED since 11-19 19:49:56Z, "GPU budget exhausted: $62.45 of $57.00 spent in 12 h" | MEASURED | 45320773844 |
| Uptime | 0 min running / ~1,380 min stopped in the last 24 h; last run ~11.8 h | MEASURED | 45320773844 |
| VRAM use, GPU util | none while stopped; launch read 0%/0% while loading | NOT YET MEASURED | — |

## AI capability

| figure | value | class | evidence |
|---|---|---|---|
| Model | `openai/gpt-oss-120b`, MoE 117B / 5.1B active, MXFP4 (~61 GB), 128K context, `--max-num-seqs 128`, openai tool + reasoning parsers | MEASURED (probe) | 44483902486 |
| Probe | auth 401 without key; task 778 ms; 4 parallel 1,031 ms; ~10K-token prompt 588 ms; tool call 475 ms | MEASURED | 44483902486 |
| Director/tool score | 0.79 (passed as `tool_score` at launch); §108 bench: `auto/best-coding` 0.98 | DERIVED | 44483902486, ARCHITECTURE-RECORD §108 |
| GPU jobs in flight while running | 5.5–8.9 on average (one 5-min sample 25) | MEASURED | 44281808757, 44260466650, 44252330377, 44217821987, 44353886005, 44489206809 |
| Concurrency cap | 12 = database-pool share (8 × 3 / 2 models, `slotShare`); halved to 6 on Brain CPU 88–90% (11-19 08:27Z, 08:36Z) | MEASURED | 44489206809 |
| Max sustainable concurrency | ~7–12 jobs, bound by Brain's event loop (85–100% busy), not the GPU; ~5–9% of its 128 sequences | DERIVED | above |
| Throughput | 11-19: 26 GPU-slot jobs submitted in ~35 min running, 12 accepted claims, $0.22/claim; 11-18 12 h: 86 submitted, 71 not accepted over 270 min running ≈ 19 accepted/running h | MEASURED / DERIVED (slot-labelled; may include fallback answers) | 44489206809, 44281808757 |
| Tokens per second | Brain records no token counts | NOT YET MEASURED | — |

## Productive work

| figure | value | class |
|---|---|---|
| Doing now / active jobs | nothing / 0 | MEASURED (45320773844) |
| GPU jobs last 24 h | 0, $0 (the report's 328 / 418 / $125.77 were the fallback under the GPU's label) | DERIVED |
| Whole free lane last 24 h | 1,559 arrived, 1,522 finished, 1,027 succeeded; 890 leases expired; 425 ineffective retries | MEASURED (45320773844) |
| Brain restarts | every ~20–30 min (boot-grace shrinks 02:41, 03:13, 03:35Z), each holding the lane at 2 slots for 10 min; peak loop lag 4,539 ms | MEASURED (45320773844) |
| Idle while work waited | free lane ~40 min / 24 h; the GPU 100% of the ~4.3 days since 11-19 19:49Z | MEASURED / DERIVED |

## Backlog

- Ready bins: **361** now (45320773844); 1,866 at 11-23 20:33Z (45260588741).
  The ~1,664 figure is not in either reading. The new `GPU CAPACITY` section
  breaks ready bins down by purpose and kind, and by whether the lane may take them.
- GPU-suitable research claimable now: **185** (verify 101, audit 57, fragment
  26, plan 1); oldest fragment waited ~85 days (MEASURED, 45320773844).
- What blocks dispatch:
  1. **Grant (spend authority):** the bounded run's budget and window are
     spent; the supervisor refuses every start. Owner's call.
  2. **Software, fixed here:** fitness read the fallback's answers as the
     GPU's. "HELD BACK runpod/openai/gpt-oss-120b|RESEARCH_PLAN" (45320773844)
     came from five fallback failures, and would have kept the GPU off
     planning for up to 24 h after it returned.
  3. **Software, necessary:** the database-pool share (12 slots; §88's 593-waiter
     incident), halving on Brain CPU, and the 10-minute boot hold, which the
     restart loop triggers every ~25 min.
  4. **Not hardware:** ~7 of 128 sequences used.
- Time to clear the 185 at ~19 accepted per running hour: ~10 GPU-hours ≈ $52
  at $5.29/h (DERIVED).

## Corrections in this change

1. **GPU work is what the GPU answered.** `servedByGpu` / `answeredBy`
   (`cheap/runpod.ts`) read `servedBy`. `runpod-report` prints `GPU SERVED`,
   sets `RUNPOD_SUBMITTED` to GPU-answered jobs (so the hourly "no GPU job"
   warning is true again), prices cost per GPU-answered job, and no longer
   derives running time from the span of fallback jobs.
2. **`GPU CAPACITY` section** (`cheap/gpuCapacity.ts`, 14 days): account and
   pod hardware from RunPod (GPU, count, VRAM, vCPU, uptime, live util),
   running hours and dollars per day, GPU-answered jobs per running hour,
   mean in flight, accepted share, dollars per accepted job, what moved the
   GPU's slot count, ready bins and queued research by purpose and whether
   the lane may take each, launchable ideas against research-grant slots, and
   hours to clear (`GPU_THROUGHPUT`, `GPU_BACKLOG` lines).
3. **Fitness by who answered** (`freeLane/worker.ts` `answerRows` →
   `attributeAnswer`): a GPU-slot row the fallback answered counts against the
   fallback, so the GPU is never held back (or cleared) by another model's answers.
4. **`runpod-survey` survives RunPod's REST outage**: the pod list falls back
   to GraphQL. Every survey from 11-17 to 11-19 had ended
   "FAIL survey: fetch failed" before printing a price.

No concurrency number was raised. The measured limit is Brain's event loop
(halving at 85% CPU) and the database-pool share, and the GPU already reached
both. A larger cap would add event-loop stalls, not throughput (§86: the
controller's output, not a typed number).

## Scaling recommendation

**Buy no more or larger GPUs.** The H200 ran ~7 jobs against 128 sequences.
More cards or a B200 would add idle capacity at $5.29–$7.99/h (the 11-18 B200
pod `ximwaoxs3apc4c` read $7.99/h in 44281123120). The constraints are Brain's
2-vCPU server event loop, the 8-connection workload pool and the restart
loop.

- **Cheaper hardware for the same work:** the `gpt-oss-120b-80` recipe (one 80 GB
  H100/H200 at $4.39/h, migrated 11-17 MIGRATED row) serves 48 sequences, still
  about 4× what Brain fed it. It cuts the hourly cost ~17% with no measured
  throughput loss. Fresh RunPod prices: NOT YET MEASURED (survey fixed here).
- **Whether to run the GPU at all** is the owner's call: ~19 accepted jobs per
  running hour at $5.29/h ≈ $0.28 per accepted job, against $0 for the free route
  (`auto/best-coding`, which scored 0.98 on the §108 bench but times out often:
  124+111+47 timeouts in 24 h, 45320773844).

## After deploy

1. `cheap-lane.yml` `runpod-report` with `hours=24`: read `GPU SERVED`,
   `GPU CAPACITY`, `GPU_THROUGHPUT` and `GPU_BACKLOG`.
2. `cheap-lane.yml` `runpod-survey`: current GPU prices and stock.
