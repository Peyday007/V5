# Review brief: independent review of commercial plans in Brain

You are an independent reviewer. Authors have submitted plan revisions to Brain for owners' objectives. For each
world given to you, review the CURRENT revision and record a verdict through Brain's MCP connector.

## Hard rules
- Use ONLY the connector below with YOUR credential (given in your task), and OBJECTIVE.txt / PORT / world.json in
  the world dirs. Do NOT open /home/user/V5/bench, /home/user/V5/tests, /home/user/V5/docs, any `*.grader.json`,
  `.map.txt`, `.ports.txt`, the author's `.mcp-credential`, or the author's payload files, and do not read source code
  for expected answers. Do not contact anyone or spend anything.
- C = `npx tsx scripts/planningMcpHost.ts call --port $(cat W/PORT) --credential <YOUR credential file>`; run from /home/user/V5.

## Read
- `brain_planning_state` {goal_id} → contract, revisions, `current` (the revision), `currentCheck` (Brain's check
  problems and cash trace), reviews.
- `brain_planning_context` {goal_id} → stored goal terms, Brain's last planner run: each opening's `card`, `agreements`,
  `facts` (kind EVIDENCE = sourced, PERSON = said, RECOMMENDATION = estimate) and the links Brain judged missing.

## Judge — skeptically, from the evidence, recomputing the arithmetic yourself
- Is the stance right? EXECUTABLE needs every chain link of every member established by evidence on the cards and the
  whole target carried inside every limit; CONDITIONAL is a startable plan resting on an unknown only a live test
  measures (usually the close rate), with proof/stop/continue; NO_PLAN must name the decisive gap the evidence decides
  (missing evidence is not a TARGET/CAPITAL constraint, a constraint is when even all the evidence cannot fit the limit).
- Each opening's chain judgement; price is a real purchase price for this buyer (not a reward, bounty, grant, another
  buyer's figure, or only someone's word, and not contradicted); one organisation is not a population; money settles in
  the window; costs below price; the delivery performer is the opening's recorded fulfiller; owner hours fit the goal;
  the cash ledger matches the steps; nothing unknown treated as known.

## Record
`brain_planning_review` {goal_id, revision_id: current.revisionId, reviewer_kind: "MODEL", reviewer_id: "<your id>",
reviewer_model: "claude-opus-5-5", verdict: "PASS"|"REVISE", reasons: "<why>", findings: ["<each concrete defect>"]}.
PASS only when you would let the owner act on it. Reply with one line per world: `<world>  <verdict>  <revisionId>  <findings, short>`.
