# Map B: components expected on the goal path that show no execution

Each row below is OBSERVED as absent: the record a component would leave is empty or zero. Ids refer to `observations.json`.

| # | expected component / effect | evidence of non-execution | goals | epoch | obs |
|---|---|---|---|---|---|
| N1 | A plan reading after the wave-1 deploy | Every latest reading is timestamped 01:31Z–05:43Z. The goals list says "Brain was too busy to derive the goal this run", and all goals are PAUSED. | all 6 cash goals | E1 | B-O001–B-O003 |
| N2 | Committee model specialists | `specialists.state` reads NOT_RUN for 7b4f, db2e, deede and 4f0c, and PENDING for 6631. For fa47 it is BOUND, but SKEPTIC and QUANT got "no parseable verdict". | 6 | E0 | B-O013, B-O025, B-O037 |
| N3 | Answers to committee questions | `answeredBy: []` and `committee.answered: 0` in every reading. | 6 | E0 | B-O014 |
| N4 | Plan acceptance, authorization, execution, collection | planSet `accepted 0`, attempts `authorized 0, executed 0`, collections `observed 0`, ladder D/E/F 0. No PLAN_READY owner notice exists. | 6 | E0/E1 | B-O004 |
| N5 | Steps beyond research | Every reading has exactly one step: RESEARCH, cost 0, day 0. There are no outreach, offer, invoice or collection steps. | 6 | E0 | B-O005 |
| N6 | Dispatch of the plan's step to Claude routines | The step names "Claude routines (RESEARCH_A_QUESTION)", but the ROUTINES pool shows 0 waiting and 0 running of 12. The report lists "Fix ROUTINES idle dispatch" as BLOCKED. | 6 | E1 | B-O048 |
| N7 | Reconstruction adoption | In 4 of 6 readings the reconstruction is "flagged implausible" and nothing is adopted. `explored.winner` is null in 5 of 6. | 6 | E0 | B-O009 |
| N8 | Composition of the full arrangement set | Only 400 arrangements are composed per pass; 207–1,258 ranked candidates are never composed. | 6 | E0 | B-O006 |
| N9 | Hermes operator acting on goals | 3 runs, 0 decisions, 0 actions, "Goals inspected 0". The last run was an engineering fix. | — | E1 | B-O043 |
| N10 | Leasing of the $10k project's queued research | 47 items are QUEUED and 0 LEASED. Items have repeated lease generations with attemptCount 0. The oldest has been queued since 11-04. | 7b4f | E1 | B-O017 |
| N11 | Knowledge applied to the cash projects in E1 | The 07:15Z pass applied to 30 other projects, all with counts of 0. The four Cash Mode projects are absent. | 6 | E1 | B-O049 |
| N12 | Keyed web search and payments | Google Programmable Search is REPAIRING (no key). Stripe is REPAIRING (no key). Places is REFUSED with HTTP 403. | all | E1 | B-O052 |
| N13 | Strong route model | The Anthropic and OpenAI providers read NOT_IN_USE. | all | E1 | B-O052 |
| N14 | Research for eval goal p10 | 0 searches and 0 pages read. 6 fragments are queued. | dec1125c p10 | E0 | B-O057 |
| N15 | A route using the owner's own labour (p06) | No proposer output in any arm proposed it, except one TaskRabbit route that the parser rejected with MARGIN. | dec1125c p06 | E0 | B-O060–B-O062, B-O064 |
| N16 | Resolution of the knowledge contradiction | kcn_1fad1e9d4a51439b98c0 has been UNRESOLVED since 11-24. | db2e, 4f0c, 7b4f | E0 | B-O051 |
| N17 | Person-request handling for the $10k goal | 6 DEADLINE-ceiling requests have been open since 10-18 … 11-06, with "the card names no mission" and no recommendation. | 7b4f | E1 | B-O016 |
| N18 | Factory work | 11 units queued, the oldest for 75,333 minutes. No Factory workers are registered. | — | E1 | B-O043 (report) |
| N19 | Runtime snapshot | data/runtime/project-state.json is absent. data/ holds only a development DB. | — | E0 | B-O054 |
