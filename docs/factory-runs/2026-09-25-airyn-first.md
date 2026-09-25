# Factory run record — 2026-09-25, Airyn-first

This is a record of one operator session. It is not project state: the Brain is
authoritative, and every line below names the read it was taken from so it can
be checked again.

## Routing override (temporary)

- **What changed:** `fleet set-target --scope ROUTINE --ref trig_01JN1h6UdhvR3bMpWFvaRbD2 --target 0`
  (Factory surface 1, account *Brain Research A*). Recorded as `fleet_policy`
  version 1 for that Routine, actor `operator:fleet-cli`, 2026-09-25T17:58:09Z,
  with the reason on the row.
- **Effect, read back:** `factory allocation` → `next task -> Airyn
  (acct_a5bac7f8350840f9bdbc)`, *Selected Factory surface 2 on Airyn*; Factory
  surface 1 reads *routine at target 0/0*.
- **What did not change:** no lease was touched; no research Routine, account
  target, fleet target or routing row was written. Factory surface 1 is a
  repository-capability Routine that serves no research.
- **What was there before:** Factory surface 1 had **no** Routine-level policy
  (dry run printed `— -> 0`); it was bounded only by its account target of 4.
- **Caveat:** a target of 0 excludes the surface, so this is Airyn-*only* for V5
  Factory work, not Airyn-then-fallback. The router has no preferred-account
  knob. The only other ordering input, person-reported allowance, is a reading a
  person takes, and writing one to steer routing would record something nobody
  saw.
- **To remove it:** `Fleet` workflow, `command=set-target`, `scope=ROUTINE`,
  `ref=trig_01JN1h6UdhvR3bMpWFvaRbD2`, `target=4`, with a reason. That matches
  the old behaviour, because the account target of 4 was already the bound. The
  version-1 row stays in the history.
- **Airyn's surface, before the change:** `fleet verify-pool --repository
  Peyday007/V5` → Factory surface 2 (Airyn) `PROVEN`: fired
  2026-09-25T04:54:55Z, arrived as worker-10, assigned and completed
  `bin_ed2fd51d47fb46c29670`.

## The live Factory backlog, as read

| Source | Read | Unfinished and executable |
|---|---|---|
| Factory campaigns | `factory campaigns` | none. `fcp_76e5…` (#38), `fcp_189e…` (#31) and `fcp_84a5…` (oakwood #1) are COMPLETE; `fcp_bd17…` and `fcp_05bc…` were CANCELLED ("retired by an operator; the work is obsolete"); `fcp_bb1f…` is a verification beacon |
| Change requests | `goals show` → UNFILED | none. All six are `APPROVED`, each has a campaign listed above, and none is `DRAFT` |
| Realization packets | `capability packets` | none. See below |
| Open V5 pull requests | GitHub | #3, #23, #30, #35, #36, #37 come from interactive sessions, not Factory campaigns. Merging is a person's decision, and none of them has a Factory objective to resume |

### Realization packets: every one is skipped, with the reason

- **Research Intelligence `rlp_ca981f0b0933427098b5`.** This is the only one
  that compiles. Objective: *"Implement the 1 missing part(s) of Research
  Intelligence … suggested experiments or simulations"* (gap
  `rlg_c15e0c958d7d4e679c6f`, MUST_BE_BUILT). **Skipped: not executable.**
  - `packet show` gives `Ready: no`. Seven design sections are unwritten:
    TARGET_TOPOLOGY, INFORMATION_SUPPLY, KNOWLEDGE_COMPILATION,
    COGNITIVE_CONTRACT, FACTORY_DEPENDENCIES, EVALUATION_GRAPH and
    CAPABILITY_REGISTRATION. Brain declines to write any of them itself, because
    a design filled in from a template would look the same as one somebody made.
    `realize/advance.ts` hands off only a packet that passes that readiness
    check.
  - Its single acceptance condition, "the change serves this requirement", says
    nothing checkable about what success means.
  - Submitting and approving the compile output by hand would get around a
    refusal Brain makes on purpose. It would also invent the design. Both are
    outside the authorization given.
  - Handing it off also requires the architecture-scope project to be onboarded
    for V5. That is a person's action on Build. Filing it under Deal Dispatch
    instead would change which project it belongs to.
- **Simulation and Modeling `rlp_28c4eede67ea41b9b1dd`.** Sampled.
  `packet compile` → refused: 13 gaps still need a reading and one needs a
  person (*resource and authority constraints*).
- **The other twelve packets.** The durable tick runs readiness and handoff on
  every packet on every pass. None has produced a change request. By the
  kernel's own rule, that means none has passed readiness.

## Outcome

**State B.** No unfinished V5 Factory build is currently executable. Each
recorded candidate is complete, retired, or blocked, and the reason is written
above. No objective was submitted or approved, and nothing was invented.

## What would unblock the next build

1. A person writes the seven design sections of `rlp_ca981f0b0933427098b5`
   (or of another packet), and the architecture-scope project is onboarded for
   V5 on Build. The durable tick then compiles the packet and records a DRAFT
   change request. That is covered by this session's authorization to approve.
2. Or a new objective arrives through Build, Russell, or `objectives/*.json`
   followed by `factory submit`.
