/**
 * `npm run report:cash` — what a Cash sprint actually holds, and nothing else.
 *
 * Read-only, on purpose and by construction: it opens the database, prints what
 * is there, and closes it. It activates nothing, authorizes nothing, launches
 * nothing, harvests nothing and takes no decision. The one thing it can do to
 * production is read it.
 *
 *   npm run report:cash -- --project prj_xxx
 *   npm run report:cash                      (every project that runs a sprint)
 *
 * It exists because the production audit that found this pipeline had never run
 * to the end had to ship a scratch query runner into the container to ask the
 * question, and a question worth asking once about a live sprint is worth being
 * able to ask again. `packet-report.ts` is the same shape one altitude down,
 * and runs the same way: inside the container, through `flyctl ssh console`,
 * from a workflow, so the answer comes from the rows rather than from a screen
 * somebody photographed.
 *
 * What it reports is chosen to answer the questions a repaired sprint actually
 * raises, in the order they are asked:
 *
 *   * is the sprint running, and what does its own authorization permit;
 *   * is a commercial grant present, which is a separate decision and must
 *     read absent unless somebody made it;
 *   * where every discovery round is, and what is stopping the parked ones;
 *   * what the queue holds — queued, leased, done, failed;
 *   * what has been promoted into the portfolio, and from which claim;
 *   * which openings are being qualified and which have a card.
 *
 * No credential is read, printed or required. Nothing here names a connection
 * string, a bucket key or a token: it reports what a project contains, never
 * where it is kept.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { industryView } from '../server/services/industry/view.ts';
import { dealflowView } from '../server/services/dealflow/view.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode, listCashEvents } from '../server/repos/cashMode.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { liveAuthority } from '../server/repos/cashAuthority.ts';
import { listGoals } from '../server/repos/russellAuthority.ts';
import { getCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { getOrchestration, listOrchestrationsByProject } from '../server/repos/research.ts';
import { cashRoadmap } from '../server/services/cash/roadmap.ts';
import { CASH_DISCOVERY_AUTHORITY_NAME } from '../server/services/cash/discoveryAuthority.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { composeLedger } from '../server/services/cash/monetization/ledger.ts';
import { listCommissions } from '../server/repos/monetization.ts';
import { WORK_ITEM_STATES } from '../server/domain/types.ts';
import type { WorkItem } from '../server/domain/types.ts';
import { latestMissionForCandidate, listMissions } from '../server/repos/russellMissions.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** One line, never wrapped, never a wall of JSON. */
function trim(value: string | null | undefined, width = 88): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function tally<T>(rows: T[], key: (row: T) => string): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(' ') || '—';
}

/**
 * The work items belonging to this project's research, by state.
 *
 * Counted from `WORK_ITEM_STATES` rather than from hand-written strings,
 * because the first version of this counted `COMPLETED` — a state that does not
 * exist; the enum says `SUCCEEDED`. So a sprint whose items had succeeded
 * reported `completed=0`, which is the most alarming reading this line can
 * produce and is not a true one. A diagnostic that invents a number is worse
 * than one that omits it: it was nearly read as a deadlock.
 *
 * The buckets are therefore exhaustive by construction, and `total` is printed
 * beside them so a reader can see for themselves that they add up.
 */
function queueShape(items: WorkItem[]): { total: number; byState: Record<string, number> } {
  const byState: Record<string, number> = {};
  for (const state of WORK_ITEM_STATES) byState[state] = 0;
  for (const item of items) {
    byState[item.state] = (byState[item.state] ?? 0) + 1;
  }
  return { total: items.length, byState };
}

async function reportProject(projectId: string, projectName: string): Promise<boolean> {
  const mode = await getCashMode(projectId);
  if (!mode) return false;

  console.log('');
  console.log('='.repeat(100));
  console.log(`CASH MODE — ${projectName} (${projectId})`);
  console.log('='.repeat(100));
  console.log(`  state       ${mode.state}`);
  console.log(`  currency    ${mode.currency}`);
  console.log(`  objective   ${trim(mode.objective)}`);
  console.log(`  envelope    ${mode.envelopeId ?? '—'}`);
  console.log(`  activated   ${mode.createdAt} by ${mode.createdByUserId}`);

  /*
   * The two authorizations, side by side and never conflated.
   *
   * The research grant is what pressing Start writes. The commercial grant is a
   * separate decision a person makes deliberately, and it must read absent
   * unless somebody has made it — printing them together is what makes that
   * checkable at a glance rather than inferred.
   */
  const goals = await listGoals(projectId);
  const discovery = goals.find(
    (goal) => goal.state === 'ACTIVE' && goal.name === CASH_DISCOVERY_AUTHORITY_NAME,
  );
  console.log('');
  console.log('AUTHORIZATION');
  if (discovery) {
    console.log(`  research    ACTIVE ${discovery.id}`);
    console.log(`    allows        ${discovery.allowedWork.join(', ')}`);
    console.log(`    prohibits     ${discovery.prohibitions.join(', ')}`);
    console.log(`    max spend     ${discovery.maxExternalSpend}`);
    console.log(`    concurrency   ${discovery.maxConcurrent}`);
    console.log(`    policy        ${discovery.workPolicy}`);
  } else {
    console.log('  research    ABSENT — no live internal discovery grant on this project');
  }
  const commercial = await liveAuthority(projectId);
  console.log(
    commercial
      ? `  commercial  PRESENT ${commercial.id} committed_ceiling=${commercial.maxCommittedCents} per_action=${commercial.maxPerActionCents} actions=${commercial.allowedActions.join(',')}`
      : '  commercial  ABSENT — nothing here may contact, buy, spend, commit or publish',
  );

  // --- Where the ideas are ------------------------------------------------
  const candidates = await listCandidates({ projectId });
  console.log('');
  console.log(`IDEAS (${candidates.length}) — ${tally(candidates, (one) => one.state)}`);
  /*
   * A parked idea prints the exact field the resume reads, not a paraphrase.
   *
   * `resumeAuthorityParkedCandidates` matches `judgment.blockedBy` against the
   * sentences `checkAuthority` itself composes, and refuses to unpark anything
   * else — so when a park survives a tick, the one thing worth knowing is
   * which of those sentences it actually carries. Printing `reason` alone
   * would be printing a neighbour of the answer.
   */
  for (const candidate of candidates.filter((one) => one.state === 'PARKED')) {
    // Already mapped out of the row by the repository, so it is read rather
    // than parsed here — the raw column is what `blockedOnStandingAuthority`
    // reads, and both resolve to the same value.
    const blockedBy = candidate.judgment['blockedBy'];
    console.log(`  PARKED ${candidate.id} priority=${candidate.priority ?? '—'}`);
    console.log(`      blockedBy: ${trim(typeof blockedBy === 'string' ? blockedBy : null)}`);
    console.log(`      reason:    ${trim(candidate.reason)}`);
  }

  const roadmap = await cashRoadmap(projectId);
  console.log('');
  console.log(
    `DISCOVERY ROUNDS — total=${roadmap.rounds.total} open=${roadmap.rounds.open}` +
      ` harvested=${roadmap.rounds.harvested} abandoned=${roadmap.rounds.abandoned}`,
  );
  // The live ones, which are the only ones anything is still waiting on.
  for (const round of roadmap.active) {
    console.log(
      `  ${round.bucketId.padEnd(26)} r${String(round.round).padEnd(3)}` +
        ` ${round.activity.padEnd(16)} found=${round.found ?? 'not counted yet'}` +
        (round.plan ? ` items=${round.plan.byStatus.ACCEPTED}/${round.plan.planned}` : ' items=—'),
    );
    if (round.blocker) console.log(`      not moving: ${trim(round.blocker)}`);
  }

  // --- What the fleet has to do -------------------------------------------
  const orchestrations = await listOrchestrationsByProject(projectId);
  const items = await listWorkItems(projectId, { limit: 500 });
  const shape = queueShape(items);
  console.log('');
  console.log(`RESEARCH (${orchestrations.length} packets) — ${tally(orchestrations, (one) => one.status)}`);
  console.log(
    `  work items  ${shape.total} total — ` +
      WORK_ITEM_STATES.map((state) => `${state.toLowerCase()}=${shape.byState[state] ?? 0}`).join(' '),
  );
  console.log(`  by type     ${tally(items, (one) => one.workType)}`);

  /*
   * Every failed item, named, with the one fact that decides what may be done
   * about it.
   *
   * The counts above say *how many* failed and nothing else, which is the
   * reading that sends somebody to guess. A failed item is a question with
   * exactly two answers — reissue it, or leave it — and what separates them is
   * whether the packet it belongs to already filed a report: an item whose
   * orchestration holds a `documentId` has already produced the thing a second
   * attempt would produce, so reissuing it would duplicate accepted work.
   *
   * So the packet's own `documentId`, its status and its recorded
   * `failureReason` are printed beside the item, rather than left to be
   * inferred from the round's truncated blocker line. §33 is the reason that
   * line cannot be trusted for this: a packet re-entered by the runner
   * overwrote its real cause — the bucket refusing the storage key — with a
   * guess about the worker, and every reading of that guess sent somebody to
   * look in the wrong place.
   *
   * Read-only, like everything else here.
   */
  const failed = items.filter((one) => one.state === 'FAILED');
  if (failed.length > 0) {
    console.log('');
    console.log(`FAILED WORK ITEMS (${failed.length})`);
    for (const item of failed) {
      const packet = item.orchestrationId ? await getOrchestration(item.orchestrationId) : null;
      console.log(
        `  ${item.id}  ${item.workType.padEnd(20)} attempts ${item.attemptCount}/${item.maxAttempts}` +
          ` ${item.failureCategory ?? 'no category'}`,
      );
      console.log(`      packet     ${item.orchestrationId ?? '—'} ${packet ? packet.status : ''}`);
      console.log(
        `      filed      ${packet?.documentId ?? 'NOTHING FILED'}` +
          (packet?.verdict ? ` verdict=${packet.verdict}` : ''),
      );
      if (item.resultSummary) console.log(`      said       ${trim(item.resultSummary)}`);
      if (packet?.failureReason) console.log(`      packet says ${trim(packet.failureReason)}`);
      console.log(`      updated    ${item.updatedAt}`);
    }
  }

  /*
   * What is holding the grant's concurrency.
   *
   * A packet can be terminal while the mission that asked for it is still
   * RUNNING, and a live mission holds one of the very few slots the standing
   * authority allows — so "nothing is launching" and "nothing is left to
   * launch" look identical from the packet column alone. This is the one thing
   * that tells them apart.
   */
  const missions = await listMissions({ projectId });
  console.log(`  missions    ${missions.length} — ${tally(missions, (one) => one.state)}`);

  // --- What became a piece of work ----------------------------------------
  const opportunities = await listOpportunities({ projectId });
  console.log('');
  console.log(`PORTFOLIO (${opportunities.length})`);
  let cardsComplete = 0;
  let validationsStarted = 0;
  /*
   * The tier, counted here as well as printed per piece.
   *
   * It is the one number a person asking "is any of this actually an
   * opportunity" wants, and before it existed the report said `PORTFOLIO (31)`
   * about thirty-one published price lists. Derived exactly as `cashView`
   * derives it, from the same two functions, so the terminal and the page
   * cannot disagree.
   */
  const byTier: Record<string, number> = {
    SIGNAL: 0,
    CANDIDATE: 0,
    QUALIFIED: 0,
    READY_TO_TEST: 0,
  };
  for (const opportunity of opportunities) {
    if (opportunity.validationState !== null) validationsStarted += 1;
    const facts = await cardFactsFor(opportunity.id);
    const card = cashEngineCard({ opportunity, facts });
    if (card.unknowns.length === 0) cardsComplete += 1;
    const tier = cashTier({
      opportunity,
      card,
      readiness: evidenceCard(opportunity).readiness,
    });
    byTier[tier.tier] = (byTier[tier.tier] ?? 0) + 1;
    console.log(
      `  ${opportunity.id}  ${tier.tier.padEnd(14)} ${opportunity.state.padEnd(12)}` +
        ` signal=${String(opportunity.opportunitySignal ?? '—').padEnd(32)}` +
        ` validation=${String(opportunity.validationState ?? 'NOT_STARTED').padEnd(12)}` +
        ` round=${opportunity.validationRounds}` +
        ` answered=${tier.answered}/${tier.required}`,
    );
    if (tier.toAdvance.length > 0) {
      console.log(
        `      to advance: ${tier.toAdvance.map((one) => one.key).join(', ')}`,
      );
    }
    console.log(`      ${trim(opportunity.title)}`);
    console.log(
      `      from claim ${opportunity.sourceClaimId ?? '—'}` +
        ` · packet ${opportunity.orchestrationId ?? '—'}` +
        ` · round ${opportunity.discoveryRoundId ?? '—'}`,
    );
    /*
     * Why a started deep dive has not launched yet.
     *
     * `validation=PENDING` says the candidate exists and no mission is running
     * for it, and that one word covers four different situations with four
     * different remedies: it is waiting its turn in the launch queue, it has no
     * compiled specification so `nextLaunchable` will never see it, it was
     * parked, or a mission exists and something else is wrong. Nothing in the
     * row says which, so the row is printed.
     */
    if (opportunity.candidateId && opportunity.validationState !== 'COMPLETE') {
      const candidate = await getCandidate(opportunity.candidateId);
      const mission = await latestMissionForCandidate(opportunity.candidateId);
      const spec = candidate?.judgment?.['missionSpec'];
      console.log(
        `      deep dive   candidate ${opportunity.candidateId}` +
          ` state=${candidate?.state ?? '—'} priority=${candidate?.priority ?? '—'}` +
          ` ordinal=${candidate?.ordinal ?? '—'}` +
          ` spec=${spec ? 'yes' : 'NO — nextLaunchable cannot see it'}` +
          ` mission=${mission ? `${mission.state}` : 'none yet'}`,
      );
      if (candidate?.reason) console.log(`      deep dive   reason: ${trim(candidate.reason)}`);
    }
  }

  /*
   * The industry map, which is where the search is actually pointed.
   *
   * Reported beside the portfolio rather than in a script of its own, because
   * "which industries has Brain looked at" and "what did it find" are one
   * question asked from two ends, and two commands is how a reader comes to
   * see only one of them.
   */
  const map = await industryView(projectId);
  console.log('');
  console.log(
    `INDUSTRY MAP (${map.subjects.length} live, ${map.retired.length} retired) — ` +
      `${Object.entries(map.byKind).map(([kind, count]) => `${kind}:${count}`).join(' ') || 'empty'}`,
  );
  if (!map.bootstrap.asked) {
    console.log('  the map has never been started — nothing has asked what the economy contains');
  } else if (map.bootstrap.open) {
    console.log('  the bootstrap question is running');
  }
  for (const subject of map.subjects.slice(0, 40)) {
    console.log(
      `  ${'  '.repeat(subject.depth)}${subject.name} [${subject.kind}/${subject.origin}] ` +
        `${subject.verdict}` +
        ` children=${subject.children} openings=${subject.openings}` +
        ` scans=${subject.scanRounds}/${subject.bucketsTotal} maps=${subject.mapRounds}` +
        (subject.live ? ' (a question is running)' : ''),
    );
    console.log(`  ${'  '.repeat(subject.depth)}  because: ${trim(subject.because)}`);
  }
  for (const subject of map.retired) {
    console.log(`  ${subject.name} RETIRED — ${trim(subject.because)}`);
  }
  if (map.next.length > 0) {
    console.log('');
    console.log('WHAT BRAIN WOULD ASK NEXT (reading this creates nothing)');
    for (const next of map.next) {
      console.log(`  ${next.purpose} — ${next.subject}`);
      console.log(`    because: ${trim(next.why)}`);
    }
  }
  if (map.capital.length > 0) {
    console.log('');
    console.log(`CAPITAL DECOMPOSED (${map.capital.length})`);
    for (const one of map.capital) {
      console.log(
        `  ${trim(one.title)} — ` +
          (one.minimumOwnerCents === null
            ? `minimum WITHHELD (${one.unknown})`
            : `minimum ${one.minimumOwnerCents} tier=${one.tier} executable=${one.executableNow}`),
      );
      for (const requirement of one.requirements) {
        console.log(
          `      ${requirement.requirement}: gross=${requirement.grossCents ?? 'unknown'} ` +
            `net=${requirement.netCents ?? 'unknown'}`,
        );
      }
      if (one.mechanisms.length > 0) console.log(`      structures: ${one.mechanisms.join(', ')}`);
      for (const constraint of one.constraints) console.log(`      constraint: ${trim(constraint)}`);
    }
  }

  /*
   * The cross-border dealflow kernel, reported in the order §15 of the brief
   * asks for it: what exists, what is furthest along, what is blocking it, and
   * what Brain would ask next.
   *
   * Every figure printed here is one the kernel derived from rows. There is no
   * revenue line, because there is no revenue figure: what we earn is a fee
   * under a structure nobody has chosen, and printing a number would be
   * somebody else's published range multiplied by a transaction value and
   * presented as arithmetic.
   */
  const dealflow = await dealflowView(projectId);
  if (
    dealflow.counts.categories > 0 ||
    dealflow.counts.deals > 0 ||
    dealflow.counts.liveQuestions > 0 ||
    dealflow.counts.observations > 0
  ) {
    console.log('');
    console.log(
      `DEALFLOW — categories=${dealflow.counts.categories} buyers=${dealflow.counts.buyers} ` +
        `suppliers=${dealflow.counts.suppliers} deals=${dealflow.counts.deals} ` +
        `outreach_ready=${dealflow.counts.outreachReady} blocked=${dealflow.counts.blocked} ` +
        `questions=${dealflow.counts.liveQuestions}/${dealflow.counts.questionSlots}`,
    );
    if (dealflow.gate) console.log(`  ${trim(dealflow.gate)}`);

    for (const category of dealflow.categories) {
      console.log(
        `  ${category.equipmentClass} — buyers=${category.buyers} ` +
          `suppliers=${category.suppliers} deals=${category.deals} ` +
          `costs=${category.costLines} structures=${category.attestedStructures}` +
          (category.markets.length > 0 ? ` markets=${category.markets.join(', ')}` : '') +
          (category.liveQuestions > 0 ? ' (a question is running)' : ''),
      );
    }

    /*
     * Every party with the claim that established it, because §4's whole rule
     * is that a party is a row a gated claim produced rather than a name
     * somebody typed. A reader who cannot walk from the name to the passage
     * cannot check it.
     */
    if (dealflow.buyers.length > 0 || dealflow.suppliers.length > 0) {
      console.log('');
      console.log('DEALFLOW PARTIES');
      for (const party of [...dealflow.buyers, ...dealflow.suppliers]) {
        const side = dealflow.buyers.includes(party) ? 'BUYER' : 'SUPPLIER';
        console.log(
          `  [${side}] ${party.id}  ${party.name}` +
            (party.country ? ` — ${party.country}` : '') +
            `  class=${party.equipmentClass} deals=${party.deals}`,
        );
        console.log(
          `      from claim: ${party.sourceClaimId ?? '— (seeded by a person, not a claim)'}` +
            (party.decisionMaker ? `  decision maker: ${trim(party.decisionMaker)}` : ''),
        );
      }
    }

    /*
     * The five layers, each named with its own reading.
     *
     * A count of unresearched layers says how many are missing; only the list
     * says which, and the whole point of the five not collapsing is that they
     * have different remedies. NOT_ESTABLISHED is printed as loudly as the
     * others, because an absence of rows reading as a clearance is the one
     * mistake here that gets equipment built for a market it cannot enter.
     */
    for (const market of dealflow.markets) {
      console.log(
        `  ${market.destination}: buyers=${market.buyers} deals=${market.deals} — ` +
          market.envelopes
            .map(
              (one) =>
                `${one.equipmentClass}=${one.verdict}` +
                (one.unestablished > 0 ? `(${one.unestablished} unresearched)` : ''),
            )
            .join(' '),
      );
      for (const envelope of market.envelopes) {
        console.log(
          `      ${envelope.equipmentClass}: ` +
            envelope.layers.map((one) => `${one.layer}=${one.reading}`).join(' '),
        );
      }
    }

    if (dealflow.deals.length > 0) {
      console.log('');
      console.log('DEAL CANDIDATES (furthest along first)');
      for (const deal of dealflow.deals.slice(0, 20)) {
        console.log(
          `  [${deal.stage}] ${deal.id}  ${deal.buyer} \u2194 ${deal.supplier} — ` +
            `${deal.equipmentClass}` +
            (deal.destination ? ` into ${deal.destination}` : ' (market unknown)'),
        );
        // Whether this deal became work Cash Mode is pursuing, and nothing
        // about whether anybody may act on it: that is the standing commercial
        // grant, which this report prints separately and which is a different
        // decision by a different person.
        console.log(
          `      opportunity: ${deal.opportunityId ?? '— (not promoted; nothing has been created)'}`,
        );
        console.log(
          `      transaction=${
            deal.transactionValueCents === null
              ? 'WITHHELD'
              : `${deal.transactionValueCents} ${deal.currency ?? ''}`.trim()
          } our_revenue=not-stated capital=${deal.capitalClass ?? 'unknown'}`,
        );
        if (deal.paidWhen) console.log(`      paid: ${trim(deal.paidWhen)}`);
        console.log(`      because: ${trim(deal.because)}`);
        if (deal.blocker) console.log(`      blocker: ${trim(deal.blocker)}`);
        if (deal.nextAction) console.log(`      next: ${trim(deal.nextAction)}`);
        if (deal.outstanding.length > 0) {
          console.log(`      outstanding: ${deal.outstanding.join('; ')}`);
        }
      }
    }

    if (dealflow.live.length > 0) {
      console.log('');
      console.log('DEALFLOW QUESTIONS RUNNING');
      for (const question of dealflow.live) {
        console.log(
          `  ${question.purpose} round ${question.round} — ${trim(question.subject)}`,
        );
        // The round and the idea it is, so a reader can walk from the question
        // to the mission, the packet, the work item and the claims.
        console.log(
          `      round: ${question.id}  candidate: ${question.candidateId}  ` +
            `opened ${question.openedAt}`,
        );
      }
    }

    if (dealflow.next.length > 0) {
      console.log('');
      console.log('WHAT THE DEALFLOW KERNEL WOULD ASK NEXT (reading this creates nothing)');
      for (const next of dealflow.next) {
        console.log(`  ${next.purpose} — ${trim(next.subject)}`);
        console.log(`    because: ${trim(next.why)}`);
      }
    }
    for (const declined of dealflow.declined.slice(0, 10)) {
      console.log(`  not asked: ${trim(declined.subject)} — ${trim(declined.why)}`);
    }

    if (dealflow.lessons.length > 0) {
      console.log('');
      console.log(`WHAT THE ATTEMPTS TAUGHT (${dealflow.lessons.length})`);
      for (const lesson of dealflow.lessons) {
        console.log(`  ${lesson.kind} — ${trim(lesson.says)}`);
      }
    }
  }

  /*
   * The possibility ledger, and what Brain is asking about it.
   *
   * Here rather than in a report of its own for the reason the surface has one
   * block rather than two: a possibility and the question being asked about it
   * are one subject, and two readers of it would eventually disagree about what
   * is happening. It is also the only way to answer the question this loop
   * exists to make answerable — *is the ledger's evidence coming from anywhere*
   * — against production rows rather than against a scripted test.
   *
   * Read-only, like everything else here: `composeLedger` is a projection that
   * writes nothing, and the three repository reads below take no lock and move
   * no state.
   */
  const ledger = await composeLedger({ projectId });
  const commissions = await listCommissions({ projectId });
  const sourced = ledger.entries.reduce(
    (count, entry) =>
      count + entry.answers.filter((one) => one.kind === 'FACT').length,
    0,
  );
  const proposed = ledger.entries.reduce(
    (count, entry) =>
      count + entry.answers.filter((one) => one.kind === 'ESTIMATE').length,
    0,
  );

  console.log('');
  console.log(
    `THE POSSIBILITY LEDGER (${ledger.entries.length}) — ` +
      `${tally(ledger.entries, (one) => one.status)}`,
  );
  console.log(
    `  answers: ${sourced} from a published source, ${proposed} proposed by Brain`,
  );
  for (const entry of ledger.entries.slice(0, 8)) {
    console.log(
      `  #${entry.rank} ${trim(entry.path.title, 60)} [${entry.status}]` +
        ` ${entry.unknowns.length} open`,
    );
    if (entry.previousRank !== null) {
      console.log(
        `      moved from #${entry.previousRank}${
          entry.movementReason ? ` — ${trim(entry.movementReason, 60)}` : ''
        }`,
      );
    }
  }

  const openAsks = commissions.filter((one) => one.state === 'OPEN');
  console.log('');
  console.log(
    `WHAT BRAIN IS ASKING ABOUT IT (${commissions.length} ever, ${openAsks.length} open)` +
      ` — ${tally(commissions, (one) => one.state)}`,
  );
  for (const one of commissions.slice(-12)) {
    const path = ledger.entries.find((entry) => entry.path.id === one.pathId);
    console.log(
      `  ${one.state} ${one.attribute} round ${one.round} — ` +
        `${trim(path?.path.title ?? one.pathId, 50)}`,
    );
    console.log(`      because: ${trim(one.reason, 100)}`);
    console.log(`      idea: ${one.candidateId}${one.settledAt ? ` settled ${one.settledAt}` : ''}`);
    if (one.outcome) console.log(`      outcome: ${trim(one.outcome, 100)}`);
  }

  const events = await listCashEvents(projectId);
  console.log('');
  console.log(`HISTORY (${events.length}) — ${tally(events, (one) => one.kind)}`);

  console.log('');
  console.log(
    `CASH-REPORT: ${projectId} state=${mode.state}` +
      ` research_grant=${discovery ? 'ACTIVE' : 'ABSENT'}` +
      ` commercial_grant=${commercial ? 'PRESENT' : 'ABSENT'}` +
      ` ideas=${candidates.length}` +
      ` rounds=${roadmap.rounds.total}` +
      ` queued=${shape.byState['QUEUED'] ?? 0} leased=${shape.byState['LEASED'] ?? 0}` +
      ` succeeded=${shape.byState['SUCCEEDED'] ?? 0} failed=${shape.byState['FAILED'] ?? 0}` +
      ` cancelled=${shape.byState['CANCELLED'] ?? 0}` +
      ` opportunities=${opportunities.length}` +
      ` signals=${byTier['SIGNAL']} candidates=${byTier['CANDIDATE']}` +
      ` qualified=${byTier['QUALIFIED']} ready=${byTier['READY_TO_TEST']}` +
      ` validations=${validationsStarted}` +
      ` cards_complete=${cardsComplete}` +
      ` subjects=${map.subjects.length} retired_subjects=${map.retired.length}` +
      ` capital_decomposed=${map.capital.length}` +
      ` possibilities=${ledger.entries.length}` +
      ` ledger_sourced=${sourced} ledger_proposed=${proposed}` +
      ` asked=${commissions.length} asking_now=${openAsks.length}` +
      ` answered=${commissions.filter((one) => one.state === 'ANSWERED').length}` +
      ` unresolved=${commissions.filter((one) => one.state === 'UNRESOLVED').length}` +
      /*
       * Counted because it can happen. `ABANDONED` became reachable when
       * `abandonPutAway` got its writer, and a state a row can hold that the
       * one line an operator reads does not count is how a reader concludes
       * every question is still being asked.
       */
      ` abandoned=${commissions.filter((one) => one.state === 'ABANDONED').length}`,
  );
  return true;
}

async function main(): Promise<void> {
  await initDatabase();

  const only = flag('project');
  const projects = await listProjects();
  let found = 0;
  for (const project of projects) {
    if (only && project.id !== only) continue;
    if (await reportProject(project.id, project.name)) found += 1;
  }

  console.log('');
  if (found === 0) {
    // Not a failure: most projects hold no sprint, and saying so is the answer.
    console.log('CASH-REPORT: OK sprints=0 — no project here is running a cash sprint');
    return;
  }
  console.log(`CASH-REPORT: OK sprints=${found}`);
}

main()
  .catch((error) => {
    console.error('CASH-REPORT: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
