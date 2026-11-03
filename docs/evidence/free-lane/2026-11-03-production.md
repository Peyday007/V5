# Free research lane on production, 2026-11-03

Verbatim output of `admin free-lane show` on the deployed Brain (Admin workflow
run 41600405107, commit 8e2630a), about 50 minutes after the free lane first
went live (Deploy 41593755225, commit 09562bd).

```
  configured        yes (2 model(s))
  ready             yes — Nothing is displaced.
  displaced queued  {}
  unsupported       {}
  last hour         submitted=26 failed=58  last=2026-11-03T08:00:32.277Z
  runner consumed   10 next-stage item(s) queued after free-lane work (24h)
  outcomes (24h)    {"RESEARCH_AUDIT:FAILED_RETRYABLE":31,"RESEARCH_AUDIT:SUBMITTED":5,"RESEARCH_FRAGMENT:FAILED_RETRYABLE":25,"RESEARCH_FRAGMENT:SUBMITTED":8,"RESEARCH_SYNTHESIZE:SUBMITTED":5,"RESEARCH_VERIFY:FAILED_RETRYABLE":2,"RESEARCH_VERIFY:SUBMITTED":8}
  packets resumed   11
  claims            13 accepted of 16 submitted by free workers
  packets filed     1
  failed            2026-11-03T08:00:36.722Z RESEARCH_FRAGMENT model brain-a: no readable source among 6 candidate page(s)
  failed            2026-11-03T07:57:05.608Z RESEARCH_FRAGMENT model brain-a: the answer did not survive Brain's own checks (unquoted, uncited or empty)
  failed            2026-11-03T07:56:50.916Z RESEARCH_AUDIT model brain-b: model call failed: cheap lane HTTP 503
```

The first live reading (Admin run 41596544336, 07:29Z), minutes after release:

```
  configured        yes (2 model(s))
  ready             yes — 19 displaced item(s); the free lane submitted 5 in the last hour.
  displaced queued  {"RESEARCH_AUDIT":5,"RESEARCH_FRAGMENT":14}
  outcomes (24h)    {"RESEARCH_AUDIT:FAILED_RETRYABLE":7,"RESEARCH_AUDIT:SUBMITTED":3,"RESEARCH_SYNTHESIZE:SUBMITTED":2}
  packets resumed   4
```

What it shows: parked play-research packets were taken by the free lane (11
resumed), its claims passed Brain's evidence gate (13 of 16 accepted), Brain
filed one packet, and the packet runner queued 10 next-stage items from free-lane
results. The two defects it exposed — a provider 503 spending an item's attempt,
and model-recalled URLs that do not open — are fixed in the change that adds
this file.
