# Who may deploy production

One branch. It is named in [`.github/CANONICAL_BRANCH`](../.github/CANONICAL_BRANCH)
and it is **`production`**.

Step 12A, Website Connection and the Software Factory merge *into* it. None of
them deploys itself.

---

## Why this exists

Three branches were dispatching the one `Deploy` workflow at the same Fly app,
and each overwrote the last. `/operator` — a console that had been deliberately
deleted — came back **twice in one evening**. Nobody re-added it. A branch that
predated the removal simply deployed after the branch that removed it, and a
connector went missing the same way.

That is worth being precise about, because the obvious reading is wrong. Nobody
made a mistake. A dispatchable deploy workflow with no opinion about its ref
deploys whatever ref you hand it, and "whatever ref you hand it" eventually
includes a branch that is behind. **A feature branch reaching production is the
default behaviour, not the exception.**

---

## The two halves, and why one is not enough

### The guard in the workflow — fast and legible

`deploy.yml`'s first job is `canonical`, and every other job `needs:` it. It
refuses two different things:

- a ref that is not the branch named in `.github/CANONICAL_BRANCH`; and
- the canonical branch itself when the checkout is **behind** its own remote,
  because a re-run of an older dispatch is the same rollback wearing the right
  branch name.

It reads the branch name from the file rather than restating it. A second copy
of the name is a second thing to forget to change.

### The environment branch policy — the half that actually binds

**A guard inside a workflow file cannot bind a branch whose copy of that file
predates the guard.** `workflow_dispatch` runs the workflow *from the ref it is
dispatched on*. An older branch carries an older `deploy.yml`, and an older
`deploy.yml` has no guard. This is not a gap that can be closed with more code
in the repository; it is how the platform works.

What binds every ref is GitHub's **deployment branch policy** on the
`production` environment. The deploy job already declares
`environment: production`, so GitHub refuses the job *before it starts* when the
ref is not allowed — and the branch being deployed cannot edit that setting.

It is repository configuration rather than code, so it is set once, by hand, by
somebody with admin rights:

> **Settings → Environments → `production` → Deployment branches and tags**
> → **Selected branches and tags** → **Add rule** → `production`

### And make `production` the default branch

**Settings → General → Default branch → switch to `production`.**

Two things depend on it, and neither is cosmetic. GitHub runs `schedule`
workflows only on the default branch and registers `workflow_dispatch` from it,
so `production-guard.yml` below does nothing at all until the default moves —
and a new workflow added on the canonical branch is not dispatchable until then
either. Second, a branch cut from the default inherits the `canonical` guard,
so the guardless-older-copy problem stops being created going forward.

Once that is in place, dispatching `Deploy` on any other branch fails at the
environment gate with *"Branch is not allowed to deploy to production"*, whatever
that branch's workflow file says.

Optionally add **Required reviewers** to the same environment if you want a
person to approve each production deploy. Nothing in this repository depends on
that either way.

---

## The routine

```
feature branch  ──merge──▶  production  ──Deploy──▶  Fly
```

1. Do the work on a branch.
2. Merge it into `production` and reconcile anything that collides — migrations
   especially, which are numbered independently per backend and must not share a
   number.
3. Run both suites and both builds on the merged tree.
4. Dispatch **Deploy** on `production`.

Never dispatch `Deploy` on a feature branch, never add a second workflow that
runs `flyctl deploy`, and never deploy a branch "temporarily" to test
something — that is exactly what happened, twice.

---

## What is checked automatically

`tests/deploymentOwnership.test.ts` fails if:

- the canonical branch name is restated instead of read from the file;
- the guard stops being the first job, or stops refusing an outdated checkout;
- a second workflow gains a `flyctl deploy` command;
- the deploy job stops declaring `environment: production`, which is the half
  GitHub enforces;
- `CLAUDE.md` loses the rule or the invariant;
- `/operator` comes back as a route, a client reference or a tracked file;
- a merge drops a file that Step 12A, Website Connection or the Software Factory
  owns;
- either migration chain gains a gap or a duplicate number.

The suite deliberately checks for a `flyctl deploy` **command** at the start of a
line rather than the phrase, because one workflow quotes a product owner's
authorization that contains those words. A check that goes red on correct
content teaches people to delete it.

## And what is checked against production itself

A suite reads the repository, and when this went wrong **the repository was
correct the whole time** — production was running a build from before the
removal. Nothing in a test could have seen that.

So `.github/workflows/production-guard.yml` asks the deployment, hourly: that
`/operator` answers 404 at every old address, does not redirect and returns no
form; that `/healthz` is up and `/api/projects` still refuses an anonymous
caller; that Connected sites answers **401 rather than 404**, because a 404
there means the route is not deployed; and that the client bundle carries no
`/operator`. It holds no secret, changes nothing and cannot deploy.

If it goes red, production does not match the canonical branch — re-deploy the
canonical branch, and set the environment policy above so it cannot recur.
