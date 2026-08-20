# Verifying the real Antigravity worker on Windows

Everything else in this build is verified by the automated suite. This one
thing cannot be: whether the Antigravity CLI can actually be driven by another
program on **your** machine. A scripted provider passing 426 tests says nothing
about it, and Brain will not claim otherwise — until the steps below succeed,
the app reports **REAL ANTIGRAVITY WORKER: UNVERIFIED**.

It takes about ten minutes. Everything happens in Brain's own interface except
starting the app itself.

## Before you start

- Antigravity installed, opened once, and signed in **inside Antigravity**.
  Brain never asks for your password and never stores a credential.
- Brain running: `npm install` then `npm run dev`, and open the URL it prints.

## The procedure

1. **Detect.** Press **SETTINGS** in the top bar, then **DETECT ANTIGRAVITY**.
   - Expected: *Antigravity is installed* ticks, with the executable path and
     version beside it.
   - If it does not: the tick stays empty and the page names the next step. The
     usual cause is the command-line tool not being on `PATH`. You can point
     Brain straight at it with `BRAIN_ANTIGRAVITY_PATH=C:\path\to\agy.exe`.

2. **Confirm the version.** Read the path and version on the same card. If the
   version is blank the executable answered nothing, which is a different
   problem from not being found — the diagnostics table says which stage failed.

3. **Confirm authentication.** Press **CHECK AUTHENTICATION**.
   - Expected: *An account is signed in* ticks.
   - If it does not: sign in inside Antigravity's own window and press it again.

4. **Test the connection.** Press **TEST CONNECTION**. This runs one real job
   with a trivial prompt.
   - Expected: *Connection test passed*, and the fourth fact — *A real job has
     actually run here* — ticks.
   - **If it hangs and then reports a timeout**, this is the known non-TTY stall
     (antigravity-cli issue #318): the tool is waiting for a console that is not
     there. Go to step 4b.
   - **If it exits immediately with no output**, that is the same stall wearing
     a different face, and step 4b applies too.

   ### 4b. Only if the test stalled: the terminal path
   Stop Brain, set these, and start it again:

   ```
   set BRAIN_ANTIGRAVITY_PTY=1
   set BRAIN_ANTIGRAVITY_PTY_COMMAND=C:\path\to\winpty.exe
   npm run dev
   ```

   `winpty` gives the tool the console it is waiting for. Brain enforces exactly
   the same limits on this path — argument arrays, the prompt on stdin, the
   timeout, cancellation, whole-process-tree kill, the job's own workspace, the
   output caps. Then press **TEST CONNECTION** again.

   If it still stalls, stop here and report **REAL ANTIGRAVITY WORKER:
   BLOCKED**. Nothing below will work, and nothing about Brain is broken:
   research stays manual through COPY PROMPT, and every other subsystem is
   unaffected.

5. **Start one small real assignment.** Open a layer, go to **RESEARCH**, and
   give it something small and checkable with a real answer — for example:
   *"Establish how many people work in the outsourced telemarketing occupation
   in the United States, on the official statistical definition, for the most
   recent published year."*
   - Expected: Brain plans it and **stops**, showing the goal as it understood
     it, what your archive already answers, the genuine gaps, and the jobs it
     proposes. Nothing has been spent yet.

6. **Check the fragments are justified.** In the review, each fragment says
   which requirement it exists for and why the archive was not enough. If one
   looks unnecessary, press its name to drop it. This is the check that matters
   most: fragments should be for gaps, not for everything.

7. **Check the bundling.** The proposed jobs should carry more than one fragment
   where the scope and sources match, with a sentence explaining why they are
   together.

8. **Approve.** Press **APPROVE AND START RESEARCH**. The real worker launches.
   - Expected: the progress panel shows the active job and the fragments riding
     in it, then accepted and rejected claim counts moving as evidence lands.

9. **Check the artifact was captured.** When a job finishes, the run's passes
   carry the exact prompt, its sha-256 and the raw reply. If a fragment failed,
   its repair says what failed and what to do differently.

10. **Check the claims were validated.** Open a fragment. Every accepted claim
    has a canonical URL and the quoted passage; every rejected one says why.
    A claim with a search-results URL or no passage should be rejected.

11. **Check the audit ran.** When the report is filed, the layer shows the
    primary / adversarial / judge verdict on it.

12. **Test cancellation.** Start another assignment and press **CANCEL** while a
    job is running.
    - Expected: it stops within a few seconds, says nothing was recorded, and
      leaves the completed fragments intact. The Antigravity process should be
      gone from Task Manager — Brain kills the whole tree, not just the process
      it can see.

## What to report back

- The status shown on the research panel: **REAL ANTIGRAVITY WORKER: VERIFIED**,
  **UNVERIFIED**, or **BLOCKED**.
- If BLOCKED: which step failed, and what the page said. The diagnostics table
  on the settings page is the useful part — it is already sanitized, so it is
  safe to copy.
