# Factory release: from approved objective to LIVE

The intended workflow is: **the owner approves an objective → the Factory plans,
builds, tests, repairs and is independently reviewed → an authorized release
merges and deploys it → Brain reads LIVE from the revision actually serving.**

Everything up to the reviewed pull request already existed (CLAUDE.md §27). This
document is the part after it (CLAUDE.md §58).

## The pieces

| piece | where | what it decides |
|---|---|---|
| Release classifier | `server/services/factory/releaseEligibility.ts` | Which changed paths may ship without a person. Deny by default. |
| Owner authorization | `factory_release_authorizations` (migration 111 / pg 102), `repos/releaseAuthorizations.ts` | A project administrator's standing, expiring, revocable decision for one repository. |
| Release reading | `server/services/factory/release.ts` | NOT_DELIVERED, MANUAL_RELEASE_REQUIRED, AUTO_RELEASE_ELIGIBLE, MERGED_NOT_LIVE, LIVE or UNKNOWN, with every blocker named. Read on the remote tick and on demand. |
| Release workflow | `.github/workflows/factory-release.yml` | Asks Brain, re-classifies from the canonical branch, tests the merged tree on both backends, pushes the tested merge without force, dispatches `Deploy`. |
| Unattended Postgres | `npm run test:pg` (`scripts/test-pg.mjs`) | A throwaway cluster on a private unix socket, the tests, cleanup. Allowlisted in `.claude/settings.json`. |
| Brain surface | Build → each campaign's **Deployment** block; each repository's **Unattended release** control | What stands between a change and production, and the owner's decision. |

## What always needs a person

`PROTECTED_CLASSES`: **credentials, security, financial authority, deployment
controls, schema, dependencies** — and anything outside the low-risk surface
(`client/`, `server/`, `tests/`, `docs/`, `objectives/`, `blueprints/`). The
classifier, the release reading, the authorization repository, the release
workflow and `test-pg.mjs` are themselves deployment controls, so a change to
the release machinery is never released by the release machinery.

A change is also manual when: the independent review did not PASS, its
independence is UNKNOWN, it reviewed a different head, a BLOCKER finding is
open, the forge truncated or could not read the diff, or nobody authorized
unattended release for that repository.

## The two keys

1. **Brain** — Build → Repositories → *Unattended release* → reason and days
   (1–90) → **Authorize unattended release**. `requirePerson` and project ADMIN;
   a worker is refused by type. Revoking keeps the row.
2. **GitHub** (repository administrator, once):
   - Settings → Secrets and variables → Actions → Variables:
     `FACTORY_AUTO_RELEASE` = `enabled`. Setting it to anything else stops
     every run before it asks Brain anything.
   - Settings → Environments → `factory-release`, deployment branches limited
     to the canonical branch. Adding required reviewers there turns unattended
     release back into a one-click approval without touching code.
   - If the canonical branch is protected against pushes, allow the
     `github-actions[bot]` to push to it, or the release job's push is refused
     (which is safe: nothing else happens).

Neither key alone releases anything.

## What "LIVE" means

LIVE is written only when the forge says the pull request's head is contained
in `BRAIN_REVISION` — the commit the running image was built from. A `Deploy`
that reported success is not LIVE; a merged change the running image does not
contain is `MERGED_NOT_LIVE` with the blocker `NOT_DEPLOYED`. `RELEASE_LIVE` is
recorded once per campaign in `factory_events`.

## Terminal

```
npm run factory -- release-status --campaign fcp_…
npm run factory -- release-queue --repository Peyday007/V5
npm run factory -- release-decision --repository Peyday007/V5 --pr 123 --head <sha>
npm run test:pg                                  # impacted tests against Postgres
npm run test:pg -- --files tests/x.test.ts       # exactly these
```

## The proof that is still owed

This change needs the owner's review before it is merged — it is a change to
deployment controls by its own classifier. After it is deployed and both keys
are turned, the proof is one real objective, approved once, taken by the
Factory to a reviewed pull request and by `factory-release.yml` to production
with nobody touching it, ending in `RELEASE_LIVE` on that campaign. Until that
row exists, the unattended path is built and tested, not proven.
