#!/bin/sh
# Run the manufacturing kernel's operator surface inside the deployed container.
# Same reason as admin.sh, fleet.sh and capability.sh: `flyctl ssh console -C`
# opens a session in `/`, and every path this script resolves is relative to the
# application.
set -e
cd "$(dirname "$0")/.."

# One pooler client, for the reason the five `*-report.sh` scripts already
# carry and this one did not.
#
# The Supabase pooler has a shared fifteen-client limit, the app holds up to
# `BRAIN_DATABASE_POOL_SIZE` (ten by omission) while it works, and a command
# here with no setting takes the adapter's default of ten as well. Measured on
# 2026-09-21, twice, on the same image within one minute: `manufacturing show`
# through `closeout-report.yml` — which sets the variable at the call site —
# printed the whole ladder, and the same command through `manufacturing.yml`,
# which did not, died with
# `(EMAXCONNSESSION) max clients reached in session mode - max clients are
# limited to pool_size: 15` on `SELECT * FROM manufacturing_rounds`.
#
# `tests/dealflowKernel.test.ts` already states the rule and gives the reason:
# *a rule one of five readers obeys is worse than none, because the next report
# is written by copying whichever one the author opened.* This is that rule one
# file along — a reading nobody can take while the thing it reads is working is
# not a reading, and a `show` is exactly the command somebody reaches for while
# production is busy.
#
# It is `${…:-1}` rather than a plain assignment so the workflow's own call-site
# setting wins, and so a terminal can raise it deliberately.
export BRAIN_DATABASE_POOL_SIZE="${BRAIN_DATABASE_POOL_SIZE:-1}"

exec node --import tsx scripts/manufacturing.ts "$@"
