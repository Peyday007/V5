# Deploying the connector

The package is deploy-ready and **has deliberately not been deployed**. This
file says why, and what the one action is.

---

## Why it is not deployed

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

## The one action

`claude/blissful-tesla-a31dc1` already contains everything on
`claude/zealous-hypatia-78a2yp` plus the connector, with the migration
renumbered past theirs. Once the Step 12A closure is at a point where it can
take it:

1. Merge `claude/blissful-tesla-a31dc1` into `claude/zealous-hypatia-78a2yp`
   (or make it the deployment branch — it is a strict superset).
2. Run the **Deploy** workflow on that branch.

Migration `036` then applies to production as the only claimant of that number,
and every subsequent migration on either line is `037`.

## What deploying does, and does not do

| | |
|---|---|
| Creates | `external_records`, `external_record_rejections`, `storage_readings` |
| Alters | nothing |
| Deletes | nothing |
| Reads | nothing that existed before |
| Costs | no new service, no new secret, no paid provider |

Rolling back is deploying the previous image. The three tables stay, unread by
anything; no other table references them, and no existing row changes. To
remove them: `DROP TABLE external_records, external_record_rejections,
storage_readings;`

## Connecting the site afterwards

`docs/CONNECT.md` §6. Three steps in a browser, once — create the worker, grant
it the project **as a connected site**, issue its credential — then three
environment variables on the site.
