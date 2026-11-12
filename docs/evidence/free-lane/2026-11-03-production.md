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

## 09:07Z, after #459 and #460 (Admin run 41608344595, commit 0ec315a)

```
  ready             yes — 8 displaced item(s); the free lane submitted 7 in the last hour.
  displaced queued  {"RESEARCH_AUDIT":2,"RESEARCH_FRAGMENT":6}
  unsupported       {}
  last hour         submitted=7 failed=45  last=2026-11-03T09:05:16.547Z
  runner consumed   28 next-stage item(s) queued after free-lane work (24h)
  outcomes (24h)    {"RESEARCH_AUDIT:FAILED_RETRYABLE":52,"RESEARCH_AUDIT:RELEASED_TRANSIENT":16,"RESEARCH_AUDIT:SUBMITTED":8,"RESEARCH_FRAGMENT:FAILED_RETRYABLE":50,"RESEARCH_FRAGMENT:SUBMITTED":11,"RESEARCH_SYNTHESIZE:SUBMITTED":6,"RESEARCH_VERIFY:FAILED_RETRYABLE":2,"RESEARCH_VERIFY:SUBMITTED":11}
  packets resumed   15
  claims            13 accepted of 19 submitted by free workers
  packets filed     2
  failed            2026-11-03T08:55:26.594Z RESEARCH_AUDIT model brain-a: the model returned no usable JSON
  failed            2026-11-03T08:53:48.423Z RESEARCH_FRAGMENT model brain-a: no readable source among 10 candidate page(s)
  failed            2026-11-03T08:53:11.765Z RESEARCH_FRAGMENT model brain-a: the answer did not survive Brain's own checks (unquoted, uncited or empty)
```

Provider outages now hand items back (`RELEASED_TRANSIENT`: 16) instead of
spending their attempts. The remaining failures are parser strictness on audit
answers that arrive unwrapped, and quotes that differ from the page only in
typography; both are corrected in the change that appends this section.
