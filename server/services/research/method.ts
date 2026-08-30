/**
 * How a worker is expected to research — and the reason this is code rather
 * than a document.
 *
 * `docs/workers/WORKER-CONTRACT.md` is where an operator reads the worker's
 * obligations, and for a long time that was the only place they existed. A file
 * in this repository is not something the worker can read. Cowork never sees
 * the repository; it sees an MCP endpoint and whatever that endpoint tells it.
 * So guidance kept only in the document reaches nobody, and guidance pasted
 * into a scheduled task's prompt is maintained by hand, drifts from the code,
 * and is the human relaying that the whole worker architecture exists to
 * remove.
 *
 * There are exactly two paths that put text into a worker's context without a
 * person carrying it:
 *
 *   1. **The MCP `instructions` field**, returned by discovery in the modern
 *      era and by `initialize` in the legacy one. Clients place it in the
 *      model's context. This is proven rather than assumed — the text of
 *      `SERVER_INSTRUCTIONS` appears verbatim in a connected Claude session's
 *      own system prompt.
 *   2. **A tool the worker can call**, which is this module's `RESEARCH_METHOD`
 *      returned by `brain_research_method`.
 *
 * Both are served from here so they cannot disagree, and a test asserts the
 * document says the same thing.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a prompt
 * ---------------------------------------------------------------------------
 *
 * §5.2 of the Step 9 plan forbids a work item carrying a prompt, and a test
 * asserts an assignment contains no instruction text. That rule is about
 * *content*: the Brain must never tell a worker what to conclude about the
 * subject it was given, because a queue that can do that is a queue that can
 * make a borrowed Claude account say anything.
 *
 * This is subject-free. It is identical for every packet, every fragment and
 * every project, it names no question and no answer, and it is versioned so a
 * packet can record which revision of the method produced it. It says how to
 * work, never what to say — the same line §11 draws when it treats an imported
 * document as data rather than as instructions.
 */

/** Bumped when the text changes, and recorded on the run that used it. */
export const RESEARCH_METHOD_VERSION = '2026-08-30.1';

/**
 * The standing method, restored from the workflow that produced the archive's
 * best research before the queue existed.
 *
 * Every line here earned its place by being the difference between that run and
 * the first pull-path packet: the earlier one opened full sources, recovered
 * from blocked ones, said plainly what it could not verify, and attacked its
 * own conclusions. The pull path had none of that written down anywhere the
 * worker could see it.
 */
export const RESEARCH_METHOD = `
# How Brain expects research to be done

This is method, not content. It never tells you what to conclude.

## Search broadly, then read fully
Start wide enough to find the sources you did not already know about, then
**open them**. A snippet is a pointer to evidence, not evidence. Quote from the
document you opened, and record the locator you read it at.

## Prefer primary sources, and say which is which
Statute, regulation, regulator guidance, court records, filings, standards
bodies and first-party contracts settle facts. Classify every source you cite as
PRIMARY, SECONDARY or ANECDOTAL. An organisation's own site is conclusive about
what it says and worth nothing as independent confirmation of whether it is true.

## When a source is blocked, recover — then report it
Paywalls, robots exclusions, JavaScript-only pages, 403s and dead links are
ordinary. Try the alternatives: an official mirror, the regulator's own copy,
the filing rather than the summary, a cached authoritative version, a different
official jurisdiction page.

If you still cannot read it, **submit the claim with its retrieval state set**
(PAYWALLED, ROBOTS_BLOCKED, JS_ONLY, NOT_REACHABLE). Do not quietly drop it and
do not substitute a source you did not read. A claim you could not check is not
a claim you got wrong: it is recorded as unresolved, named in the report, and
excluded from the fragment's rejection rate. Inferring the content of a page you
could not open is the one thing that would make this worse than saying nothing.

## State uncertainty explicitly
Submit what you actually found, including what you could not source. Everything
you submit is stored unaccepted and the Brain's gate decides. There is nothing
to gain by overstating support and something real to lose: a claim waved through
is one the packet then rests on.

## Carry your conditions
If your assignment says a dependency did not establish something, your claims
must say so. Write the conditional — "if the transaction falls within the
statute's scope, then…" — rather than asserting the antecedent nobody proved.

## Attack your own findings before submitting
Ask what would have to be true for your conclusion to be wrong, and go look for
it. Where two sources disagree, work out first whether they are answering
different questions — a different definition, timeframe, geography or population
explains most apparent contradictions completely. Report the disagreement rather
than averaging it away.

## Finish honestly
A bounded answer with its gaps named is worth more than a complete-looking one
that hides them. Name what is unresolved, and why.
`.trim();

/** The compact form, for the MCP `instructions` field every client already reads. */
export const RESEARCH_METHOD_SUMMARY =
  'When you research: search broadly, then open full sources rather than quoting snippets; ' +
  'prefer primary evidence and classify each source PRIMARY, SECONDARY or ANECDOTAL; when a ' +
  'source is paywalled, robots-blocked, JavaScript-only or unreachable, try an official ' +
  'alternative and, if it is still unreadable, submit the claim with its retrieval state set ' +
  'rather than dropping it or inferring the page — an unread source is recorded as unresolved, ' +
  'not as a rejection; state uncertainty explicitly; carry forward any condition your ' +
  'assignment says a dependency left unsettled; and attack your own load-bearing claims before ' +
  'submitting. Call brain_research_method for the full contract.';
