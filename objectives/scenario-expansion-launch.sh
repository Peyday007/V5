#!/bin/sh
# Launch the scenario-expansion Factory campaign. Run from the V5 repo root on a
# machine with flyctl signed in as the Brain operator.
#   sh objectives/scenario-expansion-launch.sh <PEYTON_ACCOUNT_NAME>
# Step 1 takes Peyton's account out of routing so friends' accounts take every
# unit first (the router has no "owner last" rule; see dispatch/router.ts routeBin).
# Step 4 puts it back only if the friend accounts can't take the work.
set -e
PEYTON="${1:?pass Peyton's fleet account name (see step 0 output)}"
APP=northline-brain

echo "== 0. fleet + allocation before"
flyctl ssh console -a "$APP" -C "sh scripts/fleet.sh show"
flyctl ssh console -a "$APP" -C "sh scripts/factory.sh allocation"

echo "== 1. Peyton's account last resort: take it out of routing"
flyctl ssh console -a "$APP" -C "sh scripts/fleet.sh set-state --kind account --ref $PEYTON --to UNAVAILABLE --reason scenario_expansion_campaign_friends_accounts_first"

echo "== 2. submit + approve"
flyctl ssh console -a "$APP" -C "sh scripts/factory.sh submit --project prj_ac780d726f394a8ca81d --file objectives/scenario-expansion.json"
echo "Copy the change-request id above, then:"
echo "  flyctl ssh console -a $APP -C 'sh scripts/factory.sh approve --change-request <id>'"
echo "  flyctl ssh console -a $APP -C 'sh scripts/factory.sh status --campaign <fcp_id>'"
echo "== 4. Only if no friend account can take a unit (allocation shows none routable):"
echo "  flyctl ssh console -a $APP -C 'sh scripts/fleet.sh set-state --kind account --ref $PEYTON --to ENABLED --reason friends_accounts_exhausted_<why>'"
