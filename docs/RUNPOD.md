# RunPod GPU in the cheap lane

Brain's own model on a rented GPU, used before the free providers and backed by them.

| | |
|---|---|
| GPU | RTX 2000 Ada, 16 GB |
| Server | vLLM (`vllm-latest` template, OpenAI-compatible, port 8000) |
| Model | `Qwen/Qwen3-8B-AWQ` (4-bit, ~6 GB). Full-precision Qwen3-8B (~16 GB) does not fit with room for a KV cache. `Qwen/Qwen3-8B-FP8` (~9 GB) also fits; AWQ leaves more KV cache, so more jobs at once. |
| Code | `server/services/cheap/runpod.ts`, wired in `cheap/lane.ts` |
| Workflow | `Cheap lane` (`.github/workflows/cheap-lane.yml`), `runpod-*` actions + an hourly `runpod-auto` |

## Pod settings

Container start command (the template's "Container Start Command" / args):

```
--model Qwen/Qwen3-8B-AWQ --served-model-name Qwen/Qwen3-8B-AWQ
--host 0.0.0.0 --port 8000
--api-key <a long random string>
--max-model-len 32768 --gpu-memory-utilization 0.92
--enable-prefix-caching --max-num-seqs 16
```

Expose HTTP port 8000. The address is `https://<pod-id>-8000.proxy.runpod.net`.
A RunPod **serverless** vLLM endpoint also works: `https://api.runpod.ai/v2/<endpoint-id>/openai/v1` with the RunPod API key.

`--api-key` is required: the probe refuses an endpoint that answers without one,
because a public proxy URL with no key is anyone's GPU.

Research prompts carry up to six fetched pages (~10k tokens) plus an 8k answer
budget, so `--max-model-len` must be at least 20000; 32768 is Qwen3's native
context. The probe fails a smaller one.

## Secrets (GitHub repository secrets, Peyday007/V5)

| Secret | Value |
|---|---|
| `RUNPOD_VLLM_URL` | the pod (or serverless) address above |
| `RUNPOD_VLLM_KEY` | the `--api-key` value (or RunPod API key for serverless) |
| `RUNPOD_VLLM_MODEL` | optional; otherwise the first model the server lists |
| `RUNPOD_API_KEY` | optional but recommended: the RunPod **account** API key (RunPod → Settings → API Keys), so Brain can stop the idle pod and start it again |

Repository variable (not a secret): `RUNPOD_USD_PER_HOUR`, used for cost only until the pod's own
price has been sampled from RunPod.

## Keeping the GPU supplied, and stopping it when there is nothing to do

The GPU is one model in the free lane's capacity controller (§86), so it is fed the way every
lane model is: from the research queue, highest priority first, growing while useful research
waits and shrinking when it overloads; an idle slot takes another model's roles (spillover).
Nothing generates work to keep it busy — new research only comes from goals and packets.

- **Sized by the GPU's own calls.** A failed GPU call is answered by the free model, so the item
  window would read an overloaded GPU as healthy; the GPU slot is sized from its own recent calls
  instead, with a runaway guard of `BRAIN_RUNPOD_MAX_SLOTS` (default 32).
- **Stopped when idle.** With `RUNPOD_API_KEY` set, Brain checks every minute (`runpodPod.ts`):
  no research waiting and none in flight for 15 minutes (`BRAIN_RUNPOD_IDLE_STOP_MINUTES`) →
  `POST /v1/pods/{id}/stop`. Research waiting on a stopped pod → `POST /v1/pods/{id}/start`.
  No two changes within 3 minutes. `BRAIN_RUNPOD_AUTOSTOP=off` turns it off. An item every
  lane model is cooling down on after a provider failure is not counted as waiting: nothing
  would run it, so it does not keep the pod billing (2026-11-05: 14 such items, no slot busy).
- **Reported while stopped.** The hourly `runpod-auto` still runs the report when the probe fails
  because Brain stopped the pod, so stopped time is measured too.
- **Never interrupts research.** While the pod is stopped, starting, or vLLM is still loading,
  the GPU slot is paused: its calls go straight to the free model, with no timeout and no GPU
  failure counted. The slot returns to the GPU when `/v1/models` answers with the key.
- **Measured.** Every stop/start is a `RUNPOD_POD` event, and the pod's status and RunPod's own
  `costPerHr` are sampled every 5 minutes, so `runpod-report` prints running minutes and the
  measured cost per research job, beside jobs, accept rates, quality and fallbacks per model.
- **Stopping can lose the GPU, so a refused start ends automatic stopping.** A stopped pod gives
  its GPU back to RunPod and stays tied to its machine; if someone else takes that GPU the pod
  cannot start until it frees ([RunPod: zero GPUs](https://docs.runpod.io/pods/troubleshooting/zero-gpus)).
  Production, 2026-11-05 21:34Z: the `runpod-cycle` test stopped the pod and every start after it
  was refused. So while RunPod's latest answer to a start (within 7 days) is a refusal, Brain
  never stops the pod again; it keeps starting it for waiting research every 3 minutes, and
  records RunPod's own words for each refusal (`runpod-report` prints the last five pod events).
  A network volume or a pod on a host with spare GPUs is what makes stopping safe.
- A stopped pod keeps its ID and proxy address. If RunPod has no GPU free on that host the start
  fails; it is recorded (`START_FAILED`) and retried after the gap, while the free models carry
  the work.

## How it routes

- Off (`BRAIN_RUNPOD_MODE` unset or `off`): the lane is exactly the free providers, as before.
- Primary: slot A = the GPU, slot B = the first free model. Research and synthesis run on A,
  verification and audits on B, so a claim is still checked by a different model (§85).
- Every GPU call that fails (stopped pod, timeout, 5xx, context overflow) is answered by the
  free model instead. Three failures in a row open a breaker for two minutes so a stopped pod
  does not cost every call a timeout. Thinking is off (`enable_thinking: false`) and any
  `<think>` text is stripped before Brain's parsers read the answer.

## Connecting

Nothing to run by hand. Each hour `runpod-auto`:

1. no secrets → does nothing;
2. secrets present, not connected → runs the probe (no-key refused, model served, a real lane
   task, 4 in parallel, a ~10k-token prompt) and, only on a pass, sets `BRAIN_RUNPOD_*` on the
   Brain with mode `primary`;
3. connected → re-probes and reports research jobs on the GPU (`scripts/runpod-report.sh`)
   and fallbacks from the log; a changed secret (new pod) is reconnected.

By hand: `runpod-test`, `runpod-connect`, `runpod-disconnect` (back to free only), `runpod-report`.

## Does it reach the $10K plan?

The hourly `runpod-report` also prints, for every live cash goal (§89):

- `rounds` — the goal's research rounds opened, harvested (with openings), abandoned, open;
- `jobs <model>` — the goal's research jobs on each model (`runpod/...` is the GPU), with
  claims, sourced claims and opening signals on the fragments each submitted;
- `opening <id> [<model>]` — each opening the goal's research filed, which model's fragment it
  came from, payer and price on the card, and whether the plan MODELLED, CONSIDERED or left
  it out (and why: a fresh signal waits for its validation dive to name who pays);
- `plan` / `combined` — verdict, openings considered and modelled, those with a buyer and a
  price the plan accepts, the best combination's reach against the 90% requirement and p50;
- `history` — the plan's last readings (a row is written whenever those figures move);
- `why short` — the causes the next goal round is told to fix;
- `RUNPOD_GOAL_OPENINGS` / `RUNPOD_GOAL_OPENINGS_IN_PLAN` — GPU-made openings, and how many
  the plan has read.
