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
import { describeDiveRefusal, whyNotDiving } from '../server/services/cash/validation.ts';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { industryView } from '../server/services/industry/view.ts';
import { dealflowView } from '../server/services/dealflow/view.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { listOpportunities } from '../server/repos/cashPortfolio.ts';
import { cardFactsFor } from '../server/repos/cashCardFacts.ts';
import { liveAuthority } from '../server/repos/cashAuthority.ts';
import { listGoals } from '../server/repos/russellAuthority.ts';
import { getCandidate, listCandidates } from '../server/repos/russellCandidates.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import {
  getClaim,
  getFragment,
  getOrchestration,
  listOrchestrationsByProject,
} from '../server/repos/research.ts';
import { cashRoadmap } from '../server/services/cash/roadmap.ts';
import { CASH_DISCOVERY_AUTHORITY_NAME } from '../server/services/cash/discoveryAuthority.ts';
import { cashTier } from '../server/services/cash/tier.ts';
import { evidenceCard } from '../server/services/cash/card.ts';
import { cashEngineCard } from '../server/services/cash/engineCard.ts';
import { composeLedger } from '../server/services/cash/monetization/ledger.ts';
import { listCommissions } from '../server/repos/monetization.ts';
import { WORK_ITEM_STATES } from '../server/domain/types.ts';
import type { WorkItem } from '../server/domain/types.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { commercialProviderStatus, probeProviders } from '../server/services/cash/providers/status.ts';
import { listInvoices } from '../server/repos/cashInvoices.ts';
import { latestMissionForCandidate } from '../server/repos/russellMissions.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { totalsByKind } from '../server/repos/cashLedger.ts';
import { CASH_MONEY_KINDS } from '../server/domain/types.ts';
import { gateFailureDistribution } from '../server/repos/research.ts';

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

/**
 * A complete count by one column, from the database rather than from a list.
 *
 * Every population this report states — ideas, missions, work items, packets,
 * fragments, events — used to be counted off a list a repository read with a
 * LIMIT (100 ideas, 100 missions, 500 items, 50 events), so it printed
 * `missions 100 — FAILED=74` beside an uncapped 308 (RES-12a). A sample may
 * still be printed, and says it is one; a total is an aggregate.
 */
async function countBy(sql: string, params: unknown[]): Promise<{ total: number; by: Map<string, number> }> {
  const rows = await getDb().all<{ k: string | null; n: number }>(sql, params as never[]);
  const by = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const n = Number(row.n);
    by.set(row.k ?? '—', n);
    total += n;
  }
  return { total, by };
}

function shown(counts: { by: Map<string, number> }): string {
  return (
    [...counts.by.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || '—'
  );
}

/**
 * Why an idea is parked, from the field the park was recorded in (RES-12d).
 *
 * `candidate.reason` is the judgment's sentence, which for an authority park is
 * the generic "depends on X, which is not ready…" priority wording. The
 * decision that parked it is in `judgment`: the compiler's own `refusal`, the
 * run's own words for research that produced no report, or the authority
 * sentence in `blockedBy` that the resume matches. Each is printed with where
 * it came from, and the priority sentence only when nothing more specific was
 * recorded.
 */
function parkReason(candidate: {
  reason: string | null;
  judgment: Record<string, unknown>;
}): { from: string; text: string } {
  const judgment = candidate.judgment ?? {};
  const refusal = judgment['refusal'];
  if (typeof refusal === 'string' && refusal.trim()) {
    return { from: 'compiler refusal', text: refusal };
  }
  const researched = judgment['researchedWithoutReport'];
  if (researched && typeof researched === 'object') {
    const why = (researched as Record<string, unknown>)['reason'];
    if (typeof why === 'string' && why.trim()) return { from: 'research produced no report', text: why };
  }
  const blockedBy = judgment['blockedBy'];
  if (typeof blockedBy === 'string' && blockedBy.trim()) {
    return { from: 'blocked by', text: blockedBy };
  }
  return { from: 'judgment', text: candidate.reason ?? '(no reason recorded)' };
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

  // --- Commercial providers (§52) ----------------------------------------
  // Registered here exactly as the server registers them at boot, so this
  // reading inside the released container is the reading the tick acts on.
  registerCommercialProviders();
  console.log('');
  console.log('COMMERCIAL PROVIDERS');
  for (const line of await commercialProviderStatus()) {
    console.log(
      `  ${line.area.padEnd(10)} ${line.state.padEnd(9)} ${line.capability.padEnd(17)} ` +
        `${line.provider ?? '—'}${line.mode ? ` (${line.mode})` : ''}`,
    );
    console.log(`      ${trim(line.detail)}`);
    if (line.state === 'MISSING') console.log(`      next: ${trim(line.nextAction, 160)}`);
  }
  if (process.argv.includes('--probe')) {
    const probe = await probeProviders();
    console.log(`  probe      messaging ${trim(probe.messaging)}`);
    console.log(`  probe      billing   ${trim(probe.billing)}`);
  }
  const invoices = await listInvoices({ projectId });
  console.log(`  invoices   ${invoices.length} — ${tally(invoices, (one) => one.state) || 'none'}`);
  for (const invoice of invoices.slice(-10)) {
    console.log(
      `    ${invoice.id} ${invoice.state} ${invoice.amountCents} ${invoice.currency} due ${invoice.dueDate} ` +
        `provider=${invoice.providerInvoiceId ?? '—'} ${trim(invoice.stateReason, 60)}`,
    );
  }

  // --- The money ledger (RES-12b) -----------------------------------------
  /*
   * Read from `cash_money_entries` through the same `cashPosition` every
   * surface uses, so this is the ledger's own arithmetic rather than a second
   * opinion: costs subtracted once, a payment not counted as funds until it
   * settles, held commitments and reserves apart. Bounded to the sprint's own
   * currency, with any other currency in the ledger named rather than
   * converted. Nothing here is inferred from an opportunity's estimate, a
   * capability or a provider's configuration. A read that fails says so, and
   * is never printed as zero.
   */
  console.log('');
  console.log(`MONEY LEDGER (${mode.currency})`);
  try {
    const money = await cashPosition({ projectId, currency: mode.currency });
    const totals = await totalsByKind({ projectId, currency: mode.currency });
    const entries = await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cash_money_entries WHERE project_id = ?',
      [projectId],
    );
    const cents = (value: number) => `${(value / 100).toFixed(2)}`;
    console.log(`  entries               ${Number(entries?.n ?? 0)} (all currencies)`);
    console.log(`  pipeline (not cash)   ${cents(money.pipelineCents)}`);
    console.log(`  customer payments     ${cents(money.customerPaymentsCents)} (net of refunds; not yet funds)`);
    console.log(`  available funds       ${cents(money.availableFundsCents)}`);
    console.log(`  unpaid commitments    ${cents(money.unpaidCommitmentsCents)}`);
    console.log(`  held commitments      ${cents(money.heldCommitmentsCents)}`);
    console.log(`  reserves              ${cents(money.reservesCents)}`);
    console.log(`  deployable            ${cents(money.deployableCents)}${money.shortfall ? '  SHORTFALL' : ''}`);
    console.log(`  completed contribution ${cents(money.completedContributionCents)}`);
    console.log(
      `  by kind               ${
        CASH_MONEY_KINDS.filter((kind) => Number(totals[kind] ?? 0) !== 0)
          .map((kind) => `${kind}=${cents(Number(totals[kind] ?? 0))}`)
          .join(' ') || 'no entries'
      }`,
    );
    if (money.otherCurrencies.length > 0) {
      console.log(
        `  NOT INCLUDED          entries in ${money.otherCurrencies.join(', ')} — not converted at a rate nobody chose`,
      );
    }
  } catch (error) {
    console.log(
      `  (the ledger could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)} — this is not zero)`,
    );
  }

  // --- Where the ideas are ------------------------------------------------
  const ideaCounts = await countBy(
    'SELECT state AS k, COUNT(*) AS n FROM russell_candidates WHERE project_id = ? GROUP BY state',
    [projectId],
  );
  console.log('');
  console.log(`IDEAS (${ideaCounts.total}) — ${shown(ideaCounts)}`);
  /*
   * A parked idea prints the reason it was parked, from the field that decided
   * it (`parkReason`), in full rather than trimmed to a line — a refusal cut at
   * 88 characters (RES-13) is a reason nobody can act on. The list is a
   * bounded sample and says so; the count above is complete.
   */
  const parkedTotal = ideaCounts.by.get('PARKED') ?? 0;
  const parked = await listCandidates({ projectId, states: ['PARKED'], limit: 50 });
  if (parkedTotal > 0) {
    console.log(`  PARKED — showing ${parked.length} of ${parkedTotal}`);
  }
  for (const candidate of parked) {
    const why = parkReason(candidate);
    console.log(`  PARKED ${candidate.id} decided_by=${String(candidate.judgment['decidedBy'] ?? '—')}`);
    console.log(`      ${why.from}: ${trim(why.text, 400)}`);
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
  const itemCounts = await countBy(
    'SELECT state AS k, COUNT(*) AS n FROM work_items WHERE project_id = ? GROUP BY state',
    [projectId],
  );
  const itemTypes = await countBy(
    'SELECT work_type AS k, COUNT(*) AS n FROM work_items WHERE project_id = ? GROUP BY work_type',
    [projectId],
  );
  const shape = {
    total: itemCounts.total,
    byState: Object.fromEntries(WORK_ITEM_STATES.map((state) => [state, itemCounts.by.get(state) ?? 0])),
  };
  const fragmentCounts = await countBy(
    `SELECT f.status AS k, COUNT(*) AS n FROM research_fragments f
       JOIN research_orchestrations o ON o.id = f.orchestration_id
      WHERE o.project_id = ? GROUP BY f.status`,
    [projectId],
  );
  console.log('');
  console.log(`RESEARCH (${orchestrations.length} packets) — ${tally(orchestrations, (one) => one.status)}`);
  console.log(`  fragments   ${fragmentCounts.total} — ${shown(fragmentCounts)}`);
  console.log(
    `  work items  ${shape.total} total — ` +
      WORK_ITEM_STATES.map((state) => `${state.toLowerCase()}=${shape.byState[state] ?? 0}`).join(' '),
  );
  console.log(`  by type     ${shown(itemTypes)}`);

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
  const failed = await listWorkItems(projectId, { states: ['FAILED'], limit: 50 });
  if (failed.length > 0) {
    console.log('');
    console.log(`FAILED WORK ITEMS (showing ${failed.length} of ${shape.byState['FAILED'] ?? 0})`);
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
  const missionCounts = await countBy(
    'SELECT state AS k, COUNT(*) AS n FROM russell_missions WHERE project_id = ? GROUP BY state',
    [projectId],
  );
  console.log(`  missions    ${missionCounts.total} — ${shown(missionCounts)}`);
  // A rate needs its window and its denominator: missions created in the last
  // seven days, by the state each is in now.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const recentMissions = await countBy(
    `SELECT state AS k, COUNT(*) AS n FROM russell_missions
      WHERE project_id = ? AND created_at >= ? GROUP BY state`,
    [projectId, weekAgo],
  );
  const recentFailed = recentMissions.by.get('FAILED') ?? 0;
  console.log(
    `  missions created since ${weekAgo.slice(0, 10)}: ${recentMissions.total} — ${shown(recentMissions)}` +
      (recentMissions.total > 0
        ? ` (failed ${recentFailed}/${recentMissions.total} = ${Math.round((100 * recentFailed) / recentMissions.total)}%)`
        : ''),
  );
  await researchYield(projectId);
  await gateFailures(projectId);
  await researchAccounting(projectId);

  // --- What became a piece of work ----------------------------------------
  const opportunities = await listOpportunities({ projectId });
  console.log('');
  console.log(`PORTFOLIO (${opportunities.length})`);
  let cardsComplete = 0;
  let validationsStarted = 0;
  let duplicates = 0;
  let closed = 0;
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
    /*
     * Whether this record is one opening or a second record of another, when
     * it closes, and why no deep dive will start — three facts the tick acts
     * on that nothing printed, so duplicate prevention and the closing-date
     * check could only be verified by trusting them.
     */
    if (opportunity.duplicateOfId) {
      duplicates += 1;
      console.log(`      duplicate of ${opportunity.duplicateOfId}`);
    }
    if (card.disqualifiedBy?.closed) closed += 1;
    if (opportunity.expiresAt) console.log(`      closes ${opportunity.expiresAt}`);
    {
      const refusal = await whyNotDiving(opportunity);
      if (refusal.kind !== 'ELIGIBLE') {
        console.log(`      no dive: ${refusal.kind} — ${trim(describeDiveRefusal(refusal))}`);
      }
    }
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
    /*
     * Where each evidence fact on the card came from.
     *
     * One line per opening, naming every EVIDENCE fact's claim with the packet
     * and fragment status behind it — so whether a card holds only citable
     * evidence (accepted, sourced, from an ACCEPTED or BLOCKED fragment) is a
     * reading rather than an assumption. `UNCITABLE` is the word to look for.
     */
    const evidence = facts.filter((fact) => fact.kind === 'EVIDENCE' && fact.claimId);
    if (evidence.length > 0) {
      const parts: string[] = [];
      for (const fact of evidence) {
        const claim = await getClaim(fact.claimId!);
        const fragment = claim?.fragmentId ? await getFragment(claim.fragmentId) : null;
        const citable =
          claim !== null &&
          claim.accepted &&
          claim.sourceUrl !== null &&
          (fragment?.status === 'ACCEPTED' || fragment?.status === 'BLOCKED');
        parts.push(
          `${fact.field}=${fact.claimId}@${claim?.orchestrationId ?? '—'}/${fragment?.status ?? '—'}` +
            (citable ? '' : ' UNCITABLE'),
        );
      }
      console.log(`      evidence    ${evidence.length}: ${parts.join(' ')}`);
    }
    /*
     * The card itself, for a piece past SIGNAL.
     *
     * A commercial-quality audit asks what each field *says* — who the payer
     * is, what the capture thesis proposes, where the evidence came from — and
     * the ids above answer only where it came from. One line per fact, the
     * value trimmed, the source's publisher and address beside evidence.
     */
    if (tier.tier !== 'SIGNAL') {
      for (const fact of facts) {
        let source = '';
        if (fact.kind === 'EVIDENCE' && fact.claimId) {
          const claim = await getClaim(fact.claimId);
          source = ` <- ${claim?.sourcePublisher ?? '—'} ${claim?.sourceUrl ?? '—'}`;
        }
        console.log(`      card ${fact.field.padEnd(18)} ${fact.kind.padEnd(14)} ${trim(fact.value, 220)}${source}`);
      }
    }
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
    /*
     * The row, and when it was asked.
     *
     * Every line in this report resolves to a row a reader can look up, and
     * this one did not: it printed the idea it created and never its own id,
     * nor when it was opened — so a question that had been open for a day and
     * one opened on this tick were the same line. §45 settles the rule one
     * kernel along, where a party printed by name with no claim beside it was
     * the defect the first production reading found.
     */
    console.log(
      `      ${one.id} opened ${one.openedAt}` +
        `${one.settledAt ? ` settled ${one.settledAt}` : ''}`,
    );
    console.log(`      idea: ${one.candidateId}`);
    if (one.outcome) console.log(`      outcome: ${trim(one.outcome, 100)}`);
  }

  const eventCounts = await countBy(
    'SELECT kind AS k, COUNT(*) AS n FROM cash_events WHERE project_id = ? GROUP BY kind',
    [projectId],
  );
  console.log('');
  console.log(`HISTORY (${eventCounts.total}) — ${shown(eventCounts)}`);

  console.log('');
  console.log(
    `CASH-REPORT: ${projectId} state=${mode.state}` +
      ` research_grant=${discovery ? 'ACTIVE' : 'ABSENT'}` +
      ` commercial_grant=${commercial ? 'PRESENT' : 'ABSENT'}` +
      ` ideas=${ideaCounts.total} missions=${missionCounts.total} work_items=${shape.total}` +
      ` rounds=${roadmap.rounds.total}` +
      ` queued=${shape.byState['QUEUED'] ?? 0} leased=${shape.byState['LEASED'] ?? 0}` +
      ` succeeded=${shape.byState['SUCCEEDED'] ?? 0} failed=${shape.byState['FAILED'] ?? 0}` +
      ` cancelled=${shape.byState['CANCELLED'] ?? 0}` +
      ` opportunities=${opportunities.length}` +
      ` signals=${byTier['SIGNAL']} candidates=${byTier['CANDIDATE']}` +
      ` qualified=${byTier['QUALIFIED']} ready=${byTier['READY_TO_TEST']}` +
      ` validations=${validationsStarted}` +
      ` duplicates=${duplicates} closed=${closed}` +
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

/**
 * Where the research went, and why so little of it filed anything.
 *
 * Every packet, mission and duplicate opening is a row; this groups them by the
 * reason each one stopped, so "516 packets, 26 complete" turns into the handful
 * of causes that account for the rest. Grouped on the first words of each
 * recorded reason, which is Brain's own sentence rather than anybody's
 * classification of it. A section that cannot be read says so and the report
 * carries on.
 */
/** What a mission is stopped on: a parked one waits, an ended one has a terminal reason. */
const MISSION_REASON_SQL =
  "CASE WHEN state = 'NEEDS_HUMAN' THEN COALESCE(NULLIF(waiting_on, ''), terminal_reason, '') " +
  "ELSE COALESCE(terminal_reason, '') END";

/**
 * Why gated research failed its gate, over one fixed window (RES-1).
 *
 * `gateFailureDistribution` is the measurement; this prints its four
 * populations apart — fragments judged, claims inside them, the packets they
 * belong to, and failed conditions per claim — because reading one as another
 * is how "143 blocked, 12 accepted" was compared against a different window.
 * The window is printed so two readings can be compared only when they match.
 */
async function gateFailures(projectId: string): Promise<void> {
  try {
    const until = new Date().toISOString();
    const since = new Date(Date.parse(until) - 7 * 86_400_000).toISOString();
    const d = await gateFailureDistribution({ projectId, since, until });
    console.log('');
    console.log(`GATE OUTCOMES (fragments judged ${since} → ${until})`);
    console.log(
      `  fragments judged=${d.fragments.judged} accepted=${d.fragments.accepted} blocked=${d.fragments.blocked}`,
    );
    for (const [cause, n] of Object.entries(d.blockedByCause).sort((a, b) => b[1] - a[1])) {
      const example = d.examples[cause]?.[0];
      console.log(
        `    ${String(n).padStart(4)}  ${cause}${example ? `  e.g. ${example.fragmentId} (${example.orchestrationId})` : ''}`,
      );
    }
    console.log(
      `  claims in those fragments submitted=${d.claims.submitted} accepted=${d.claims.accepted}` +
        ` accepted-inside-blocked=${d.claims.acceptedInBlocked} unread=${d.claims.unread}`,
    );
    const conditions = Object.entries(d.failedConditions).sort((a, b) => b[1] - a[1]);
    console.log(`  failed conditions per claim ${conditions.map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}`);
    console.log(
      `  packets those fragments belong to ${d.packets.total}: ` +
        (Object.entries(d.packets.byStatus).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'),
    );
  } catch (error) {
    console.log('');
    console.log(`GATE OUTCOMES (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
}

/**
 * The research work and failures Session F was asked to account for, as reads.
 *
 * Three questions nothing deployed could answer from a container (#196):
 *   - which packet owns each stale research item, and whether it is still
 *     needed — a QUEUED item never claimed, or a LEASED one whose lease
 *     lapsed, still under its own attempt ceiling;
 *   - what cancelled the work under a mission that failed "left RESEARCHING
 *     with nothing queued" — `work_items.cancelled_reason`, grouped;
 *   - which Routine, account and host each source-access block came from, and
 *     which of four different facts it is.
 * Nothing here writes. Each section is bounded and fails on its own.
 */
async function researchAccounting(projectId: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  try {
    console.log('');
    console.log('STALE RESEARCH WORK (under its own ceiling, untouched for a day, or a lapsed lease)');
    const stale = await db.all<{
      id: string; work_type: string; state: string; attempt_count: number; max_attempts: number;
      updated_at: string; orchestration_id: string | null; o_status: string | null; m_state: string | null;
    }>(
      `SELECT w.id, w.work_type, w.state, w.attempt_count, w.max_attempts, w.updated_at, w.orchestration_id,
              o.status AS o_status,
              (SELECT m.state FROM russell_missions m WHERE m.orchestration_id = w.orchestration_id
                ORDER BY m.updated_at DESC LIMIT 1) AS m_state
         FROM work_items w LEFT JOIN research_orchestrations o ON o.id = w.orchestration_id
        WHERE w.project_id = ? AND w.work_type LIKE 'RESEARCH_%'
          AND w.attempt_count < w.max_attempts
          AND ((w.state = 'QUEUED' AND w.updated_at < ?) OR (w.state = 'LEASED' AND w.lease_expires_at < ?))
        ORDER BY w.updated_at LIMIT 40`,
      [projectId, dayAgo, now],
    );
    if (stale.length === 0) console.log('  none');
    for (const row of stale) {
      console.log(
        `  ${row.id} ${row.work_type} ${row.state} ${Number(row.attempt_count)}/${Number(row.max_attempts)}` +
          ` since ${row.updated_at} packet ${row.orchestration_id ?? '—'} ${row.o_status ?? '—'} mission ${row.m_state ?? '—'}`,
      );
    }
  } catch (error) {
    console.log(`  (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
  try {
    console.log('');
    console.log("MISSIONS FAILED 'left RESEARCHING with nothing queued' — what cancelled their work");
    const reasons = await db.all<{ work_type: string; reason: string | null; n: number; example: string }>(
      `SELECT w.work_type, SUBSTR(COALESCE(w.cancelled_reason, ''), 1, 110) AS reason, COUNT(*) AS n,
              MIN(m.orchestration_id) AS example
         FROM russell_missions m
         JOIN work_items w ON w.orchestration_id = m.orchestration_id AND w.state = 'CANCELLED'
        WHERE m.project_id = ? AND m.state = 'FAILED' AND m.terminal_reason LIKE '%with nothing queued%'
        GROUP BY w.work_type, SUBSTR(COALESCE(w.cancelled_reason, ''), 1, 110)
        ORDER BY COUNT(*) DESC LIMIT 15`,
      [projectId],
    );
    if (reasons.length === 0) console.log('  none');
    for (const r of reasons) {
      console.log(`  ${String(Number(r.n)).padStart(4)}  ${r.work_type} ${r.reason || '(no reason recorded)'}  e.g. ${r.example}`);
    }
  } catch (error) {
    console.log(`  (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
  try {
    console.log('');
    console.log('SOURCE ACCESS BLOCKS by Routine (fragments whose recorded reason names the network)');
    const rows = await db.all<{ id: string; blocked_reason: string; routine: string | null; session: string | null }>(
      `SELECT f.id, f.blocked_reason,
              (SELECT p.executor_routine_id FROM research_passes p WHERE p.fragment_id = f.id
                 AND p.executor_routine_id IS NOT NULL ORDER BY p.started_at DESC LIMIT 1) AS routine,
              (SELECT p.executor_session_ref FROM research_passes p WHERE p.fragment_id = f.id
                 AND p.executor_session_ref IS NOT NULL ORDER BY p.started_at DESC LIMIT 1) AS session
         FROM research_fragments f
        WHERE f.project_id = ? AND f.status = 'BLOCKED' AND f.blocked_reason IS NOT NULL
          AND (f.blocked_reason LIKE '%ENOTFOUND%' OR f.blocked_reason LIKE '%CONNECT%'
               OR f.blocked_reason LIKE '%403%' OR f.blocked_reason LIKE '%network%'
               OR f.blocked_reason LIKE '%egress%' OR f.blocked_reason LIKE '%policy%'
               OR f.blocked_reason LIKE '%unread%' OR f.blocked_reason LIKE '%could not be read%')
        LIMIT 400`,
      [projectId],
    );
    const kindOf = (reason: string): string =>
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(reason)
        ? 'DNS_FAILURE'
        : /CONNECT[^\n]{0,40}403|proxy|network polic|egress|not allowed by/i.test(reason)
          ? 'PROVIDER_ENVIRONMENT_DENIED'
          : /\b(403|401|429)\b|forbidden|robots/i.test(reason)
            ? 'HOST_REFUSED'
            : 'UNREADABLE_CONTENT';
    const routines = new Map<string, { name: string; account: string }>();
    for (const r of await db.all<{ id: string; name: string; account: string | null }>(
      `SELECT r.id, r.name, a.name AS account FROM fleet_routines r LEFT JOIN fleet_accounts a ON a.id = r.account_id`,
    )) {
      routines.set(r.id, { name: r.name, account: r.account ?? '—' });
    }
    // The fallback when a pass carries no Routine: the routed dispatch whose
    // session that pass reported (`session_<id>` from the worker, `cse_<id>`
    // on the fire), read from Brain's own bin_events.
    const viaDispatch = async (session: string | null): Promise<string | null> => {
      if (!session) return null;
      const bare = session.replace(/^(session_|cse_)/, '');
      const hit = await db.get<{ routine_id: string | null }>(
        `SELECT routine_id FROM bin_events WHERE session_ref IN (?, ?, ?) AND routine_id IS NOT NULL LIMIT 1`,
        [session, `cse_${bare}`, `session_${bare}`],
      );
      return hit?.routine_id ?? null;
    };
    const grouped = new Map<string, { n: number; example: string; host: string | null }>();
    for (const row of rows) {
      const routine = row.routine ?? (await viaDispatch(row.session));
      const known = routine ? routines.get(routine) : null;
      const host = /https?:\/\/([^/\s'")]+)/.exec(row.blocked_reason)?.[1] ?? null;
      const key = `${kindOf(row.blocked_reason).padEnd(28)} ${known ? `${known.name} (${known.account})` : routine ?? 'unattributed'}`;
      const entry = grouped.get(key) ?? { n: 0, example: row.id, host };
      entry.n += 1;
      grouped.set(key, entry);
    }
    if (grouped.size === 0) console.log('  none');
    for (const [key, entry] of [...grouped].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${String(entry.n).padStart(4)}  ${key}  e.g. ${entry.example}${entry.host ? ` host ${entry.host}` : ''}`);
    }
  } catch (error) {
    console.log(`  (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
}

async function researchYield(projectId: string): Promise<void> {
  const db = getDb();
  try {
    console.log('');
    console.log('RESEARCH YIELD (last 14 days)');
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const byDay = await db.all<{ day: string; status: string; n: number }>(
      `SELECT SUBSTR(queued_at, 1, 10) AS day, status, COUNT(*) AS n FROM research_orchestrations
        WHERE project_id = ? AND queued_at >= ? GROUP BY SUBSTR(queued_at, 1, 10), status ORDER BY day`,
      [projectId, since],
    );
    const days = new Map<string, string[]>();
    for (const row of byDay) days.set(row.day, [...(days.get(row.day) ?? []), `${row.status}=${Number(row.n)}`]);
    for (const [day, counts] of days) console.log(`  ${day}  ${counts.join(' ')}`);
    const reasons = await db.all<{ status: string; reason: string | null; n: number; newest: string | null }>(
      `SELECT status, SUBSTR(COALESCE(cancel_reason, failure_reason, ''), 1, 90) AS reason, COUNT(*) AS n,
              MAX(updated_at) AS newest
         FROM research_orchestrations
        WHERE project_id = ? AND queued_at >= ? AND status IN ('CANCELLED', 'FAILED', 'NEEDS_HUMAN', 'AWAITING_REPAIR')
        GROUP BY status, SUBSTR(COALESCE(cancel_reason, failure_reason, ''), 1, 90)
        ORDER BY COUNT(*) DESC LIMIT 14`,
      [projectId, since],
    );
    console.log('  why packets stopped');
    for (const r of reasons) console.log(`    ${String(Number(r.n)).padStart(4)}  ${r.status.padEnd(15)} ${r.reason || '(no reason recorded)'}  newest ${r.newest ?? '-'}`);
    // RES-9: a stopped packet with no reason is a defect only if a writer still
    // produces one, so name them with when each last moved.
    const reasonless = await db.all<{ id: string; status: string; updated_at: string }>(
      `SELECT id, status, updated_at FROM research_orchestrations
        WHERE project_id = ? AND status IN ('FAILED', 'NEEDS_HUMAN', 'AWAITING_REPAIR')
          AND COALESCE(cancel_reason, failure_reason, '') = ''
        ORDER BY updated_at DESC LIMIT 8`,
      [projectId],
    );
    for (const r of reasonless) console.log(`      reasonless ${r.id} ${r.status} updated ${r.updated_at}`);
    const titles = await db.all<{ title: string; n: number; complete: number }>(
      `SELECT SUBSTR(title, 1, 70) AS title, COUNT(*) AS n,
              SUM(CASE WHEN status = 'COMPLETE' THEN 1 ELSE 0 END) AS complete
         FROM research_orchestrations WHERE project_id = ? AND queued_at >= ?
        GROUP BY SUBSTR(title, 1, 70) ORDER BY COUNT(*) DESC LIMIT 10`,
      [projectId, since],
    );
    console.log('  questions asked most often');
    for (const t of titles) console.log(`    ${String(Number(t.n)).padStart(4)}x complete=${Number(t.complete)}  ${t.title}`);
    const missionReasons = await db.all<{ state: string; reason: string | null; n: number }>(
      // A parked mission's reason is `waiting_on`: `needsHuman.ts` writes the
      // packet's own failure reason there and leaves `terminal_reason` empty,
      // because the mission has not ended. Reading only the terminal column
      // printed 54 parked missions as "(no reason recorded)" (RES-9).
      `SELECT state, SUBSTR(${MISSION_REASON_SQL}, 1, 90) AS reason, COUNT(*) AS n FROM russell_missions
        WHERE project_id = ? AND state IN ('FAILED', 'NEEDS_HUMAN')
        GROUP BY state, SUBSTR(${MISSION_REASON_SQL}, 1, 90) ORDER BY COUNT(*) DESC LIMIT 10`,
      [projectId],
    );
    console.log('  why missions stopped');
    for (const m of missionReasons) console.log(`    ${String(Number(m.n)).padStart(4)}  ${m.state.padEnd(12)} ${m.reason || '(no reason recorded)'}`);
    const dupes = await db.get<{ total: number; duplicates: number; canonicals: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN duplicate_of_id IS NOT NULL THEN 1 ELSE 0 END) AS duplicates,
              COUNT(DISTINCT duplicate_of_id) AS canonicals
         FROM cash_opportunities WHERE project_id = ?`,
      [projectId],
    );
    console.log(
      `  openings ${Number(dupes?.total ?? 0)}, of which ${Number(dupes?.duplicates ?? 0)} re-found an opening already held` +
        ` (${Number(dupes?.canonicals ?? 0)} distinct openings found more than once)`,
    );
  } catch (error) {
    console.log(`  (could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
  }
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
