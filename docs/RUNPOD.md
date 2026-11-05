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
