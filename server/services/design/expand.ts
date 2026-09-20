/**
 * LOOP 3 — improve without waiting to be told what is wrong.
 *
 * ---------------------------------------------------------------------------
 * What makes this loop the one that matters
 * ---------------------------------------------------------------------------
 *
 * The first two loops are reactive by construction: something happened, so Brain
 * looked at it and learned from it. A system with only those gets better exactly
 * as fast as it gets hurt, and its capability map is shaped by whatever happened
 * to fail rather than by what is worth being able to do.
 *
 * So this loop **originates its own work**, and every property below exists to
 * make that true rather than nominal:
 *
 *   - It runs on a tick with no trigger. Nothing has to fail, nothing has to be
 *     complained about, and nobody has to name a capability.
 *   - It reads `design_capabilities` — which includes abilities nothing
 *     implements, declared on purpose (§30's *MISSING means Brain understands
 *     the capability and does not have it*), because a gap nobody has named
 *     cannot be found.
 *   - **Demand is measured.** `rankCapabilities` orders on how many findings
 *     have landed on each capability's primitive, so a weakness rises because
 *     work keeps running into it rather than because somebody thought it was
 *     important. A capability can therefore be weak, in demand, and have never
 *     thrown an error, and this loop will still reach it. That is the whole
 *     difference from retry logic.
 *   - **And zero demand is not the same fact as no demand**, which is a
 *     correction rather than a design. A capability nothing implements cannot
 *     have produced a finding, so an empty count there is the absence of a
 *     reading — and refusing on it made the three abilities this kernel most
 *     obviously lacks, among them judging a picture at all, permanently
 *     invisible to the loop that exists to find them. §30's rule about an
 *     unknown never being a favourable assumption, failing in the direction that
 *     quietly ends self-expansion.
 *
 * ---------------------------------------------------------------------------
 * Every route is machinery that already exists
 * ---------------------------------------------------------------------------
 *
 * There is deliberately **no route meaning "the design kernel will build this
 * itself"**. That would be the second capability-acquisition engine the brief
 * forbids and §22 refuses on its own grounds. The four are:
 *
 *   RESEARCH  a bounded question, as a Russell candidate — so it goes through
 *             the archive check (§13), the compiler, the approval envelope
 *             (§16), the evidence gate (§12) and all three audit roles, exactly
 *             as any other research does.
 *   SOFTWARE  a change to Brain, prepared and parked for a person to authorize
 *             on Build. §27 reserves that decision and this loop does not have
 *             it. The objective is written down so the wait is not a dead end.
 *   READING   something Brain can settle from its own rows, which costs nothing
 *             and is therefore always preferred when it is possible.
 *   PERSON    a decision no amount of building closes.
 *
 * ---------------------------------------------------------------------------
 * And nothing is promoted without evidence
 * ---------------------------------------------------------------------------
 *
 * `evaluateExpansion` moves a capability dimension only when a **reading** of
 * that capability says it moved — the same `readAbility` the self-model uses,
 * never the fact that an expansion finished. §37's sentence: a merged pull
 * request moves no dimension in the registry, and the reason it must not is that
 * a campaign routinely succeeds at something narrower than the packet asked for.
 */
import type {
  DesignCapability,
  DesignExpansion,
  DesignExpansionOrigin,
  DesignExpansionRoute,
} from '../../domain/design.ts';
import {
  getCapability,
  lastExpansionFor,
  listCapabilities,
  listExpansions,
  openExpansion,
  routeExpansion,
  settleExpansion,
} from '../../repos/design.ts';
import { rankCapabilities, runtimeAvailability, type CapabilityRanking } from './priority.ts';
import { readAbility, refreshCapabilities } from './capabilities.ts';
import { getDb } from '../../db/database.ts';

/**
 * How many expansions may be live at once.
 *
 * A **concurrency** bound and not a lifetime quota. §24 removed exactly that
 * kind of number from the standing authority and recorded why: nothing it
 * rationed was scarce, so it measured a starting point and then became a
 * permanent ceiling. What is scarce here is attention and provider capacity, and
 * that is a question about how many things are open at once.
 */
export const MAX_LIVE_EXPANSIONS = 2;

/**
 * How long a settled gap is left alone before it may be offered again.
 *
 * §38's cool-off on a settled round, at a second kernel, and it was a defect
 * the tests found rather than a precaution: an expansion that **parks** — for
 * want of somewhere to file the research, or because it is waiting for a person
 * on Build — is no longer live, so the partial unique index allows another, and
 * every tick opened two more rows about the same three gaps for ever.
 *
 * A cool-off rather than a permanent refusal, because the conditions that park
 * one are conditions that change: an operator creates the architecture project,
 * a person authorizes the change, a browser appears. Six hours is long enough
 * that a tick every ten seconds writes nothing, and short enough that a gap
 * whose blocker was cleared this morning is offered again today.
 */
export const EXPANSION_COOL_OFF_MS = 6 * 60 * 60 * 1000;

export interface ExpansionPass {
  /** Opened this pass, with why each was chosen. */
  opened: DesignExpansion[];
  /** Considered and not opened, with the reason. Reported, never acted on. */
  declined: { capabilityKey: string; why: string }[];
  /** Live expansions that were settled by a fresh reading. */
  settled: { expansionId: string; state: string; outcome: string }[];
  liveBefore: number;
}

/**
 * One pass of the expansion loop.
 *
 * Settling comes before opening, deliberately, and for the reason the industry
 * kernel gives about absorbing first: an expansion that finished has changed
 * what the ranking sees, and deciding before reading it would make every
 * discovery a tick late for ever.
 */
export async function runExpansionPass(
  origin: DesignExpansionOrigin = 'PROACTIVE',
): Promise<ExpansionPass> {
  const settled = await settleLiveExpansions();

  const live = await listExpansions({ state: 'IDENTIFIED' });
  const routed = await listExpansions({ state: 'ROUTED' });
  const liveBefore = live.length + routed.length;

  const capabilities = await listCapabilities();
  const ranked = await rankCapabilities(capabilities);

  const opened: DesignExpansion[] = [];
  const declined: { capabilityKey: string; why: string }[] = [];
  let slots = Math.max(0, MAX_LIVE_EXPANSIONS - liveBefore);

  for (const entry of ranked) {
    if (slots === 0) {
      declined.push({
        capabilityKey: entry.capability.capabilityKey,
        why:
          `${liveBefore + opened.length} expansion(s) are already live, which is the concurrency ` +
          'ceiling. This is not a quota — it will be offered again on the pass after one settles.',
      });
      continue;
    }

    const decision = shouldExpand(entry);
    if (!decision.worth) {
      declined.push({ capabilityKey: entry.capability.capabilityKey, why: decision.why });
      continue;
    }

    const recent = await lastExpansionFor(entry.capability.capabilityKey);
    if (recent !== null && Date.now() - Date.parse(recent.updatedAt) < EXPANSION_COOL_OFF_MS) {
      declined.push({
        capabilityKey: entry.capability.capabilityKey,
        why:
          `this was looked at ${describeAge(recent.updatedAt)} and settled as ${recent.state}: ` +
          `${recent.outcome ?? 'no outcome recorded'} Offering it again now would write a second ` +
          'row about the same gap without anything having changed.',
      });
      continue;
    }

    const route = routeFor(entry.capability);
    const { expansion, created } = await openExpansion({
      capabilityKey: entry.capability.capabilityKey,
      origin,
      statement: decision.statement,
      why: decision.why,
      rankInputs: { ...entry.inputs, rank: entry.rank, because: entry.because },
      rank: entry.rank,
      route: route.route,
      evidence: [`design_capability:${entry.capability.capabilityKey}`],
    });
    if (!created) {
      declined.push({
        capabilityKey: entry.capability.capabilityKey,
        why: 'an expansion for this is already live, and two would be two pieces of work for one gap.',
      });
      continue;
    }

    await sendSomewhere(expansion, route);
    opened.push((await listExpansions({ limit: 200 })).find((one) => one.id === expansion.id) ?? expansion);
    slots -= 1;
  }

  return { opened, declined, settled, liveBefore };
}

/** How long ago, in words, so a decline reads as a decline rather than a code. */
function describeAge(at: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(at));
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 90) return `${minutes} minute(s) ago`;
  return `${Math.round(minutes / 60)} hour(s) ago`;
}

export interface ExpansionDecision {
  worth: boolean;
  statement: string;
  why: string;
}

/**
 * Whether closing this gap is worth anything.
 *
 * The refusals are what stop the loop being a machine for generating work:
 *
 *   - **A capability that is LIVE and PASSING is not a gap.** Improving
 *     something that works is polish, and the loop's whole justification is that
 *     it reduces future correction cost.
 *   - **A capability nothing has needed is not a gap yet.** Zero demand means no
 *     finding has ever landed on its primitive, so closing it would be spending
 *     the allowance to acquire something nothing has asked for — §13's default,
 *     applied to the kernel's own abilities rather than to research.
 *
 * What is *not* a refusal is the absence of a recent failure, and that is the
 * point of the loop: a weak, in-demand capability that has never gone wrong is
 * exactly the thing a reactive system never gets to.
 */
export function shouldExpand(entry: CapabilityRanking): ExpansionDecision {
  const capability = entry.capability;

  if (capability.abilityState === 'LIVE' && capability.evidenceState !== 'UNTESTED') {
    if (capability.evidenceState === 'FAILING') {
      return {
        worth: true,
        statement: `${capability.title} exists and its last check said it did not work.`,
        why: `${entry.because} A capability whose own evaluation is failing is worse than one that is absent, because it is being relied on.`,
      };
    }
    return {
      worth: false,
      why: `it is already ${capability.abilityState.toLowerCase()} and ${capability.evidenceState.toLowerCase()}, so closing it would be polish rather than capability.`,
      statement: '',
    };
  }

  /*
   * No demand is a refusal only where demand could have been measured.
   *
   * A capability nothing implements cannot have produced a finding, so an empty
   * count is the absence of a reading rather than a reading of absence — and
   * refusing on it would make the abilities this kernel most obviously lacks
   * permanently invisible to the loop that exists to find them. That is §30's
   * rule about an unknown never being a favourable assumption, failing in the
   * direction that quietly ends self-expansion.
   */
  if (entry.inputs.demand === 0 && entry.inputs.demandKnown) {
    return {
      worth: false,
      why:
        `no finding has ever landed on ${capability.primitive} and something here can look, so ` +
        'nothing has needed this yet. Acquiring it now would be spending on something nothing has ' +
        'asked for.',
      statement: '',
    };
  }

  if (capability.route === null) {
    return {
      worth: true,
      statement: `Nothing in Brain can ${capability.title.toLowerCase()}.`,
      /*
       * The reason says what is true rather than what would sound persuasive.
       *
       * The first version of this sentence claimed "work keeps producing
       * findings on ${primitive}" — which is false precisely here, because
       * nothing can look for them. That is §29's status-contradicting-itself
       * defect inside the very justification a person reads before authorizing
       * work, and it would have been the most expensive place in this kernel to
       * be wrong.
       */
      why:
        `${entry.because} Every screen this kernel has looked at was judged with this missing, ` +
        'and how much it cost is not known — which is the argument for finding out rather than ' +
        'against it.',
    };
  }

  return {
    worth: true,
    statement: `${capability.title} is ${capability.abilityState.toLowerCase()} and ${capability.evidenceState.toLowerCase()}.`,
    why: entry.because,
  };
}

export interface RouteChoice {
  route: DesignExpansionRoute;
  /** What would actually be done, written out so the wait is not a dead end. */
  objective: string;
  because: string;
}

/**
 * Where a gap goes.
 *
 * The order is the decision, and it is **cheapest first**: a gap Brain can
 * settle from its own rows costs nothing, so it is always preferred; research
 * spends the subscription; software spends a person's attention and their
 * authorization. §13's default — the default is not to research — applied one
 * level up, to acquiring an ability rather than to answering a question.
 */
export function routeFor(capability: DesignCapability): RouteChoice {
  /*
   * An ability that exists and has never been checked needs a reading rather
   * than a build. This is the branch that most often keeps the loop cheap, and
   * missing it would send Brain to research something it already has.
   */
  if (capability.abilityState !== 'ABSENT' && capability.evidenceState === 'UNTESTED') {
    return {
      route: 'READING',
      objective:
        `Exercise ${capability.route} once and take a reading, so ${capability.capabilityKey} ` +
        'stops being an ability nobody has checked.',
      because:
        'It exists and nothing has confirmed it works. That is answerable from Brain’s own rows ' +
        'by running it, which costs nothing.',
    };
  }

  /*
   * An ability with no evaluation method cannot be *built* into something
   * checkable until somebody decides what checking it would mean. That is a
   * design decision rather than a research question, so it goes to a person —
   * and naming which decision is what stops it being a park with no remedy.
   */
  if (capability.evaluationMethod === null && capability.route === null) {
    return {
      route: 'RESEARCH',
      objective:
        `Establish what ${capability.title.toLowerCase()} would require: which interface patterns ` +
        'solve it well, what the tradeoffs are, how anybody would evaluate it, and which of those ' +
        'approaches fits a product like this one.',
      because:
        'Nothing implements it and nothing says what implementing it would even mean, so the first ' +
        'bounded question is what the approaches are — not how to build one.',
    };
  }

  return {
    route: 'SOFTWARE',
    objective:
      `Implement ${capability.title.toLowerCase()} in the design kernel, and give it the ` +
      `evaluation it declares: ${capability.evaluationMethod ?? 'a stated way of checking it'}.`,
    because:
      'What it needs is code rather than an answer, and authorizing a change to a repository is a ' +
      'person’s decision on Build.',
  };
}

/**
 * Send an expansion where its route says.
 *
 * `RESEARCH` creates a Russell candidate, which is the same entrance §38's
 * kernel rounds use — so the archive is asked first, the compiler writes the
 * specification, the approval envelope decides whether it may start, and the
 * evidence gate decides what may be claimed. Nothing about that is bypassed and
 * nothing here is a second research engine.
 *
 * `SOFTWARE` and `PERSON` **park with the objective written down**. That is the
 * authority boundary rather than a gap: §27 reserves authorizing a change to a
 * person, and a loop that could route around it would be Brain granting itself
 * the one decision that separation exists for. What it must not be is a silent
 * stop, so the objective is recorded and the expansion says exactly what it is
 * waiting for.
 */
async function sendSomewhere(expansion: DesignExpansion, route: RouteChoice): Promise<void> {
  if (route.route === 'RESEARCH') {
    const projectId = await architectureProject();
    if (projectId === null) {
      await settleExpansion({
        id: expansion.id,
        state: 'PARKED',
        outcome:
          'There is no project for Brain’s own architecture work to be filed against, so a ' +
          'research question about this kernel has nowhere to go. Creating one is `npm run admin`.',
      });
      return;
    }
    const { createCandidate } = await import('../../repos/russellCandidates.ts');
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: `Design capability: ${expansion.capabilityKey}`,
      statement: `${route.objective}\n\nWhy this is worth asking: ${expansion.why}`,
    });
    await routeExpansion({ id: expansion.id, routeRef: candidate.id, route: 'RESEARCH' });
    return;
  }

  if (route.route === 'READING') {
    await routeExpansion({ id: expansion.id, routeRef: null, route: 'READING' });
    return;
  }

  await routeExpansion({ id: expansion.id, routeRef: null, route: route.route });
  await settleExpansion({
    id: expansion.id,
    state: 'PARKED',
    outcome:
      `${route.because} Waiting for a person to authorize it on Build. What it would say: ` +
      `"${route.objective}"`,
  });
}

/**
 * The project Brain's own architecture work is filed against.
 *
 * `purpose = 'TECHNICAL'`, which migration 028 declares for exactly this and
 * whose comment is *declared, not inferred*. Null when there is none, which is a
 * real state on a fresh Brain and is parked rather than guessed at — filing
 * architecture research into somebody's research project would be the
 * cross-project reach §31 draws a line under.
 */
async function architectureProject(): Promise<string | null> {
  try {
    const row = await getDb().get<{ id: string }>(
      `SELECT id FROM projects WHERE purpose = 'TECHNICAL' ORDER BY created_at ASC, id ASC`,
    );
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Settle live expansions whose capability has actually moved.
 *
 * **The reading is what settles it, never the route finishing.** A research
 * mission that came back, or a change that merged, says the work happened; only
 * `readAbility` says the capability exists — and §37 records why the difference
 * matters: a campaign routinely succeeds at something narrower than the packet
 * asked for, so the two come apart precisely when things go well.
 */
export async function settleLiveExpansions(): Promise<
  { expansionId: string; state: string; outcome: string }[]
> {
  const settledOut: { expansionId: string; state: string; outcome: string }[] = [];

  // A fresh reading first, so what follows is decided against current rows.
  await refreshCapabilities('DESIGN_EXPAND');

  for (const expansion of [
    ...(await listExpansions({ state: 'IDENTIFIED' })),
    ...(await listExpansions({ state: 'ROUTED' })),
  ]) {
    const capability = await getCapability(expansion.capabilityKey);
    if (!capability) continue;
    const reading = await readAbility(expansion.capabilityKey);
    if (!reading) continue;

    if (reading.ability === 'LIVE' && reading.evidence === 'PASSING') {
      const outcome =
        `The capability now reads LIVE and PASSING. ${reading.because.join(' ')} ` +
        'Promoted because a reading says so, not because the work it was routed to finished.';
      if (await settleExpansion({ id: expansion.id, state: 'PROMOTED', outcome })) {
        settledOut.push({ expansionId: expansion.id, state: 'PROMOTED', outcome });
      }
      continue;
    }

    if (reading.ability === 'ABSENT' && capability.route === null && expansion.route === 'READING') {
      /*
       * Routed to a reading and there is nothing to read. Rejected with the
       * reason rather than left live: §33 records thirteen production claims
       * destroyed by a rejection with no reason on it, and an expansion that sat
       * open for ever would make the same gap look like it was being worked on.
       */
      const outcome =
        'This was routed as a reading on the basis that something implemented it. Nothing does, ' +
        'so there is nothing to read and the gap is still open — it will be offered again with a ' +
        'route that can close it.';
      if (await settleExpansion({ id: expansion.id, state: 'REJECTED', outcome })) {
        settledOut.push({ expansionId: expansion.id, state: 'REJECTED', outcome });
      }
    }
  }

  return settledOut;
}

/**
 * What the loop would do next, without doing it.
 *
 * Split from the pass that acts, for `planFrom`'s reason and `readProof`'s: a
 * person should be able to ask *what would you work on next* and have nothing
 * happen. It also reports what could not run right now, because an expansion
 * routed to research on a fleet with no healthy surface would park, and knowing
 * that in advance is worth more than finding out afterwards.
 */
export async function previewExpansion(): Promise<{
  ranked: CapabilityRanking[];
  wouldOpen: { capabilityKey: string; route: DesignExpansionRoute; statement: string; why: string }[];
  blocked: { lane: string; reason: string }[];
}> {
  /*
   * Ranked against a **fresh reading**, not against the stored states.
   *
   * The stored states are whatever the last refresh wrote, and a preview that
   * ranked on them would answer about a system that has since changed — which is
   * exactly how somebody is told the top gap is a capability that has been
   * working for a week. It writes nothing: `readAbility` reads the filesystem,
   * the rows and the runtime, and the projection below is discarded.
   */
  const stored = await listCapabilities();
  const fresh: DesignCapability[] = [];
  for (const capability of stored) {
    const reading = await readAbility(capability.capabilityKey);
    fresh.push(
      reading
        ? { ...capability, abilityState: reading.ability, evidenceState: reading.evidence }
        : capability,
    );
  }
  const ranked = await rankCapabilities(fresh);
  const availability = await runtimeAvailability();

  const live =
    (await listExpansions({ state: 'IDENTIFIED' })).length +
    (await listExpansions({ state: 'ROUTED' })).length;
  let slots = Math.max(0, MAX_LIVE_EXPANSIONS - live);

  const wouldOpen: {
    capabilityKey: string;
    route: DesignExpansionRoute;
    statement: string;
    why: string;
  }[] = [];
  for (const entry of ranked) {
    if (slots === 0) break;
    const decision = shouldExpand(entry);
    if (!decision.worth) continue;
    /*
     * The cool-off is asked here too, because a preview that disagreed with the
     * pass would be the two-readers-of-one-rule defect at the surface somebody
     * reads before deciding whether to run it.
     */
    const recent = await lastExpansionFor(entry.capability.capabilityKey);
    if (recent !== null && Date.now() - Date.parse(recent.updatedAt) < EXPANSION_COOL_OFF_MS) continue;
    const route = routeFor(entry.capability);
    wouldOpen.push({
      capabilityKey: entry.capability.capabilityKey,
      route: route.route,
      statement: decision.statement,
      why: `${decision.why} Route: ${route.because}`,
    });
    slots -= 1;
  }

  return { ranked, wouldOpen, blocked: availability.reasons };
}
