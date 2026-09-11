# Deploying the connector

**Done, and superseded.** The connector is deployed, the site is connected, and
the production golden loop passes. What follows is kept because the reasoning is
the reason the migration numbering held — the file is history now, not a plan.

**Where deployment actually happens is `docs/DEPLOYMENT.md`:** one canonical
branch, `production`, named in `.github/CANONICAL_BRANCH`. Everything below
describes a world in which three branches each deployed themselves, which is
precisely the thing that went wrong and the reason that rule exists.

---

## Why it was not deployed at first

The production Brain runs from `claude/zealous-hypatia-78a2yp`, which is being
actively worked and deployed by the Step 12A closure. That branch and this one
are independently extending the same migration chain, and its highest migration
is `035` / pg `026` while this one adds `036` / pg `027`.

Deploying this branch would apply `036` to the production database. The next
migration written on the Step 12A branch would then naturally be numbered `036`
too — it is the next free number *there* — and its deploy would find version 36
already recorded with a different checksum and **refuse to boot**:

```
Migration 036_….sql changed after it was applied
(recorded checksum …, current …). Applied migrations are immutable.
```

That is the migrator working correctly. It is also a production outage caused
by a number, and it is not a risk worth taking unilaterally when the other half
of the loop is unavailable anyway (see below).

So the reconciliation happens in the repository first, and only then does
anything deploy.

## What actually happened

The merge did not go into the Step 12A branch. Both of those branches — and the
Software Factory branch — now merge into `production`, which is the only branch
that deploys. Migration `036` / pg `027` applied to production as the only
claimant of its number, exactly as this file predicted it must, and the Software
Factory's `037`/`038` and pg `028`/`029` follow it without a collision.

The prediction in the section above was right about the mechanism and wrong
about the remedy: reconciling *into whichever branch happened to be deploying*
would have left three branches able to deploy, and that is what came back to
bite. The remedy is one branch, not a careful merge order.
