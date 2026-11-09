# Checklist: writing a requirement map

Follow this when you write the requirement map for a Factory program. The fields and
statuses below are the ones `server/domain/factoryProgram.ts` defines
(`ProgramRequirement`, `REQUIREMENT_STATUSES`); `tests/program-2adb7f5e-checklist-d1.test.ts`
fails if this file omits one. How to submit, approve and read a program is in
`docs/FACTORY-PROGRAMS.md`.

## Fields of a requirement

Give every requirement all of these.

- [ ] `key` — the stable identifier other requirements refer to.
- [ ] `kind` — `CAPABILITY` (one thing that must work) or `INTERACTION` (several that must work together).
- [ ] `title` — a short name a person can scan.
- [ ] `subsystem` — the part of the system that owns the behavior.
- [ ] `source` — the source item ids (`S-0001`…) the requirement answers.
- [ ] `behavior` — what must be true once it is done, in terms a check can test.
- [ ] `inputs` — what the behavior reads or is given.
- [ ] `outputs` — what the behavior produces or changes.
- [ ] `constraints` — rules the implementation must keep, such as extending an existing owner.
- [ ] `dependsOn` — keys of requirements that must be done first; leave empty when none.
- [ ] `interactsWith` — for an `INTERACTION`, the requirements whose implementations must work together.
- [ ] `existing` — what already implements it, with the files as evidence; never enough alone, and null when nothing does.
- [ ] `missingWork` — the work still missing; empty only when `existing` claims the whole behavior.
- [ ] `paths` — the files the missing work is expected to change.
- [ ] `verification` — the checks that prove it on production.
- [ ] `ambiguities` — each unclear passage with the question and the proposed reading; a null reading blocks the requirement until a person answers.

The type also carries `quote` (the exact clause covered, or null), `priority` (when the work
is wanted, never whether) and `prepared` (specified and kept ready, not started until
something needs it).

## Requirement statuses, in order

- [ ] `SPECIFIED` — in the map, not yet assigned to work or to an existing implementation.
- [ ] `MAPPED` — assigned to a campaign or an existing implementation that has not delivered.
- [ ] `IMPLEMENTED` — its campaign delivered code that production does not run.
- [ ] `INTEGRATED` — production runs the code; its own checks have not all passed there yet.
- [ ] `PRODUCTION_VERIFIED` — every check passed on production, and so did every requirement it depends on.
- [ ] `BLOCKED` — stopped on something named: an open ambiguity, a person's decision, repeated repair failure.
- [ ] `NOT_DONE` — production verification failed; the requirement is reopened and under repair.
