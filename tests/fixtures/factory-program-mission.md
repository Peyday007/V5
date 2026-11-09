MISSION: MAKE FACTORY CAPABLE OF IMPLEMENTING COMPLETE, LARGE-SCALE ARCHITECTURES WITHOUT LOSING REQUIREMENTS

Repository: Peyday007/V5
Branch: production

OBJECTIVE

Strengthen Brain's existing Factory so it can receive a large, detailed master architecture specification, independently break it into engineering work, implement the entire specification across multiple campaigns, and prove that every requirement and required interaction was preserved.

This is preparation for a much larger Brain architecture implementation.

Do not implement that master architecture yet.

Implement and verify the Factory safeguards needed to execute it reliably.

IMPORTANT

Factory already has planning, task decomposition, dependency validation, integration, review, repair, acceptance conditions, and release infrastructure.

Inspect these existing mechanisms first.

Reuse everything that already satisfies the requirements.

Do not build duplicate planners, schedulers, reviewers, ledgers, or execution engines.

Do not spend time investigating capabilities whose current production evidence already proves they work.

1. LOSSLESS SPECIFICATION PRESERVATION

Factory must be able to receive a substantial, detailed architecture document without compressing away its requirements.

Preserve the original document verbatim as an immutable reference for the approved implementation.

Derive individually traceable requirements from that source.

Every requirement must have:

- A stable identifier.
- An exact reference to its original source.
- Its intended observable behavior.
- Relevant inputs, outputs and constraints.
- Dependencies and interactions with other requirements.
- Existing implementation, if any.
- Missing implementation work.
- Verification conditions.
- Current implementation and verification status.

The extracted requirement map must not replace the original specification.

The original remains authoritative.

Factory must detect omitted requirements, duplicated requirements, conflicting interpretations, and relationships lost during decomposition.

Ambiguities must remain visible rather than being silently resolved in a way that changes the owner's intent.

2. COMPLETE REQUIREMENT COVERAGE

Before Factory begins implementing a program, it must demonstrate that its proposed work covers the approved requirements.

Every requirement must be assigned to appropriate implementation and verification work.

Every required interaction between subsystems must also be accounted for.

Existing functionality can satisfy a requirement, but only with suitable evidence.

A task title, code comment, function name or worker's assertion does not establish implementation.

If Factory cannot account for a requirement, it must reject or repair the incomplete plan.

It cannot quietly drop that requirement to produce a smaller campaign.

3. PROGRAM-LEVEL COORDINATION

Determine whether Factory already supports a single large objective spanning many dependent campaigns.

If it does, verify that capability.

If it does not, extend the existing system with the minimum necessary program-level coordination.

Factory must be able to:

- Own one complete parent objective.
- Decompose it into appropriately bounded campaigns.
- Derive dependencies between campaigns.
- Schedule independent work concurrently.
- Prevent conflicting ownership and duplicate implementation.
- Integrate completed work continuously.
- Track progress against the original parent requirements.
- Replan remaining work when implementations expose new dependencies.
- Continue automatically into the next eligible work.
- Recover after worker failure, context loss, restarts, or interrupted sessions.

No requirement may disappear when work crosses a campaign or session boundary.

The program coordinator must use existing Factory components rather than become a separate competing Factory.

4. PREVENT PREMATURE COMPLETION

Factory must distinguish:

SPECIFIED
MAPPED
IMPLEMENTED
INTEGRATED
PRODUCTION VERIFIED
BLOCKED
NOT DONE

Use existing status terminology where appropriate instead of duplicating states.

A requirement is not complete because its PR merged or its unit tests passed.

The parent program cannot report DONE until every required capability and integration has passed its acceptance conditions.

A dependent requirement cannot pass merely because its underlying component exists.

If code is complete but production behavior is unverified, retain that distinction.

If production reveals a defect, reopen the affected requirement and its dependent verification work.

Do not manufacture success through changed acceptance wording.

5. AUTOMATIC REPAIR AND CONTINUATION

Reuse Factory's existing review and repair mechanisms.

Extend them only where necessary to operate across the complete parent program.

When production verification fails:

- Identify the earliest relevant failure.
- Determine which requirements are affected.
- Create or resume the smallest necessary repair work.
- Preserve unaffected completed requirements.
- Run focused verification.
- Recheck the affected integration.
- Resume the program.

Recurring failures should trigger structural improvements when justified.

Never create endless duplicate repairs, reports or campaigns.

6. VERIFY CROSS-SYSTEM BEHAVIOR

Factory must prove that separate implementations work together.

For example, implementing business generation and quantitative modeling independently does not prove that newly generated businesses are correctly quantified.

The architecture's required interactions must have their own acceptance conditions.

Track these interactions explicitly.

Use real production behavior wherever possible.

Tests and synthetic fixtures support verification but cannot substitute for actual production evidence when production behavior is the requested outcome.

7. MEASURE FACTORY'S EXECUTION CAPACITY

Read current Factory performance.

Measure:

- Available and usable workers.
- Actual concurrent execution.
- Queue and scheduling delays.
- Planning time.
- Coding time.
- Integration and review time.
- Repair time.
- Deployment and verification time.
- Work completed per hour.
- Requirements completed per hour.
- Idle capacity.
- Failed or duplicated work.

Determine whether additional workers, better scheduling, improved model routing or greater computing resources would materially increase throughput.

Do not assume a larger server is automatically the solution.

Fix demonstrable scheduling and resource-allocation problems before increasing infrastructure costs.

If additional resources are genuinely needed, quantify the expected benefit and cost.

8. LARGE-SPECIFICATION RELIABILITY TEST

Demonstrate Factory's ability to handle a specification substantially larger than its usual objectives.

Test at least:

- A specification with 100+ distinct requirements.
- Multiple interdependent subsystems.
- Requirements with shared ownership.
- Requirements that depend on interactions between subsystems.
- Previously implemented functionality.
- Missing functionality.
- Conflicting or ambiguous requirements.
- Work spanning multiple campaigns.
- Worker and session interruptions.
- A failed production acceptance condition.

Verify that:

- Every original requirement remains traceable.
- No requirement disappears during decomposition.
- Dependencies are respected.
- Independent work can execute concurrently.
- Existing functionality is reused.
- Incomplete work cannot be reported as DONE.
- Repairs propagate through affected dependencies.
- The complete parent objective can resume after interruption.

Use focused automated tests for scale and failure cases, then demonstrate the safeguards on a real Factory campaign.

Do not claim large-program reliability solely from synthetic tests.

9. PRESERVE AUTHORITY

Factory may determine how to implement the approved architecture.

It may not silently redefine what the architecture requires.

Do not allow Factory workers to weaken, remove, reinterpret or replace approved acceptance conditions to make their work pass.

Follow existing authorization and release policies.

Engineering autonomy does not imply permission for unrelated commercial, financial or external actions.

10. IMPLEMENT AND VERIFY

First compare every requirement above with current Factory capabilities.

Classify each as:

ALREADY WORKING
PARTIALLY WORKING
MISSING
UNPROVEN

For working capabilities, preserve the existing implementation.

For missing or partial capabilities, implement the minimum coherent additions.

Use Factory workers for suitable independent engineering tasks.

Coordinate existing sessions and avoid duplicating active work.

Add regression tests and integration tests.

Merge, deploy, and verify the results on production.

FINAL ACCEPTANCE

The objective is DONE only when Factory can demonstrably:

1. Preserve a complete detailed specification.
2. Derive a traceable requirement and dependency map.
3. Account for every requirement and interaction.
4. Coordinate implementation across multiple campaigns.
5. Reuse existing components without duplication.
6. Resume automatically after interruptions.
7. Detect omitted and unfinished work.
8. Repair failed requirements.
9. Verify integrated production behavior.
10. Refuse completion while any required behavior remains unverified.

Report the demonstrated capabilities, production evidence, performance measurements, and remaining limitations.

If any required safeguard is not working, report NOT DONE and continue implementing the missing capability.

Do not stop after producing a document, implementation plan, PR, or passing test suite.

IMPORTANT FINAL INSTRUCTION

This mission strengthens Factory itself.

Do not begin implementing the owner's larger Brain Master Architecture during this assignment.

Factory must be ready to receive and implement that complete architecture afterward, without losing its detail or requiring the owner to manually break it into dozens of prompts.
