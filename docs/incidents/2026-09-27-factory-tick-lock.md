# Owed structural repair

### A factory campaign tick held the database for hours — 2026-09-27

From about 09:38Z the app's pool read 10/10 in use, the tick heartbeat for
`fcp_03a8a0adfdb943a29171` (`extendCampaignTick`) timed out **while locking a
`factory_campaigns` tuple**, and from 07:01Z every read that needed a pooler
client — the Build line, every operator script — failed to connect, because the
app held ten of the pooler's fifteen session-mode clients. No factory branch
moved after 06:50Z. Nothing recovered by itself; redeploying the already
released commit (Deploy 367, same SHA) freed the connections and the lock, and
both hosted verifications passed immediately afterwards.

What held the row was not identified: `pg_stat_activity` and `pg_locks` need a
connection, and no connection could be had. Two structural repairs are owed and
deliberately not made during the incident: (1) whatever in the remote campaign
tick keeps a transaction open across slow work must stop doing so, and the
tick needs a statement or idle-in-transaction bound it cannot outlive; (2) an
operator diagnostic that reads `pg_stat_activity` / `pg_locks` over a
connection reserved for it, so the next occurrence names its lock holder
instead of needing a restart.
