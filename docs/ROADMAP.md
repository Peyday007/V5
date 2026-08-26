# Roadmap

The phases, and where the boundaries between them fall. This file exists
because those boundaries are load-bearing: several of them are the difference
between "one machine safely" and "several machines corrupting each other", and
a comment that attributes a guarantee to the wrong step will send somebody
looking for it in code that was never supposed to contain it.

Keep this register accurate. When a step lands, say so here and nowhere else —
the tag in git is the record of *when*, this file is the record of *what*.

## Done

| Step | What it established | Tag |
|---|---|---|
| 1–2 | The Brain itself: state engine and planner, the primary/adversarial/judge audit pipeline, document understanding and OCR, the staged research engine, archive ingestion | — |
| **3** | **Off one computer.** Postgres and Supabase Storage behind one repository layer, `migrate:cloud`, the access gate, the container, the deployment | `step-3-cloud-brain-foundation` |

Step 3's evidence — what was proven, what merely passes its tests, and what
nobody has run — is in [`STEP-3-EVIDENCE.md`](STEP-3-EVIDENCE.md).

## Ahead

Each of these is a separate step on purpose. They are listed in order and the
order is a dependency order, not a preference.

| Step | What it contains |
|---|---|
| **4** | Identities, credentials, authorization, and the explicit carry-forward register |
| **5** | Distributed queue, atomic claiming, leases, and heartbeats |
| **6** | Idempotency and safe concurrent effects |
| **7** | Remote MCP |
| **8** | Connect one Claude Max worker |
| **9** | Manual end-to-end research packet |
| **10** | Scheduled firing and interruption recovery |
| **11** | Additional workers and fleet controls |

### The separations that matter most

- **Step 4 is not Step 5.** Knowing *who* a worker is does not make it safe for
  two of them to take the same job. Identity is authorization; claiming is
  concurrency. `server/routes/access.ts` — the temporary shared-token gate — is
  Step 4's to delete and replace, and it has nothing to do with leases.
- **Step 5 is not Step 6.** A lease stops two workers starting the same job. It
  does not make the *effects* of a job safe to apply twice, which is what
  happens when a lease expires mid-flight and the work is retried. Idempotency
  is its own step because assuming it comes free with leases is how duplicated
  effects get shipped.
- **Step 7 is not Step 8.** Exposing the protocol and connecting a real worker
  to it are different claims, and only the second one is evidence that the
  first works — the same distinction Step 3 drew between the research engine
  passing its tests against a scripted provider and a real job having actually
  run.
- **Step 11 is the only one that runs more than one worker.** Until it lands,
  Brain runs a single instance deliberately: the extraction and research queues
  are per-instance and nothing coordinates them.

## Why one instance, until Step 5 and Step 11

`fly.toml` pins `min_machines_running = 1` and `auto_stop_machines = false`, and
deployment uses `--ha=false`. That is not a cost decision. Two machines today
would each run their own extraction and research queue against one shared
database, with nothing preventing both from claiming the same work. Step 5 adds
the atomic claiming and leases that make a second instance safe; Step 11 is
where a second one is actually run.
