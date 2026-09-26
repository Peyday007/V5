/**
 * What pressing Start Cash Mode actually authorizes, and the row that says so.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to remove
 * ---------------------------------------------------------------------------
 *
 * Activation created a mode row, a layer and ten discovery buckets, and nothing
 * a launch could run under. `standingAuthority` refuses every launch on a
 * project with no grant, correctly, so all ten captured ideas parked with
 * `no standing authority exists for this project` recorded in a JSON column no
 * surface reads. The sprint was, in production, a section that could open
 * questions and answer none of them — §24's *waiting nobody can resolve* at a
 * new altitude, and worse than the usual case because the remedy was a form
 * nobody was being shown.
 *
 * The remedy is not another form. **Start Cash Mode is the authorization.** A
 * person deciding to run a cash sprint has decided that Brain may read
 * published sources, research and validate openings, keep the evidence, compare
 * what it finds, calculate from accepted evidence and prepare recommended
 * plans. Asking them to then fill in a research grant is asking twice for one
 * decision, and the second ask is the one that gets left un-answered.
 *
 * ---------------------------------------------------------------------------
 * What it does not authorize, and why that is structural
 * ---------------------------------------------------------------------------
 *
 * Nothing that touches the world. No contact, no purchase, no spending, no
 * accepted terms, no commitment, no publication, no operating an opportunity
 * externally. That is not a promise in this comment: `createGoal` and
 * `ensureGoal` union `ALWAYS_PROHIBITED` into every grant and write
 * `max_external_spend = 0` as a literal, so a grant that permitted any of them
 * cannot be written by this module, by a script, by a screen or by a migration.
 * Every commercial effect is a `COMMERCIAL_ACTION` under a separate grant a
 * person makes deliberately (§30), and this file neither reads nor writes one.
 *
 * ---------------------------------------------------------------------------
 * One grant, decided by the database
 * ---------------------------------------------------------------------------
 *
 * The tick runs every few seconds, on more than one instance, and both halves
 * of a check-then-write can read "there is no grant here". So the arbiter is
 * `idx_russell_goals_one_live_cash_discovery`, a partial unique index, and the
 * loser of the race reads back the winner's row. The seventh time this codebase
 * has needed a compare-and-swap on a value the claimant does not supply.
 */
import {
  ensureGoal,
  liveGoalNamed,
  revokeGoal,
  setGoalConcurrency,
} from '../../repos/russellAuthority.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { resumeParkedForProject } from '../russell/resumeParked.ts';
import type { RussellGoal } from '../../domain/types.ts';

/**
 * The grant's name, and the identity the unique index is written against.
 *
 * A constant rather than a derived string: the index predicate compares against
 * this exact literal, so a name built per project would make the index match
 * nothing and the one-per-project rule would quietly stop being enforced.
 */
export const CASH_DISCOVERY_AUTHORITY_NAME = 'Cash Mode internal discovery';

/** The work class a research launch is checked against. Unchanged. */
const RESEARCH_WORK = 'RESEARCH';

/**
 * How many of this sprint's missions may be in flight at once.
 *
 * The one limit on it that is real. §24 removed the lifetime quotas because
 * nothing they rationed was scarce — the subscription behind a research mission
 * is already paid for — and left concurrency, which is provider capacity rather
 * than an allowance.
 *
 * **It was two, and its own reasoning was wrong.** That comment said two left a
 * fleet with something "for the validation work those missions create", and one
 * grant governs discovery *and* validation alike — so the number could not
 * reserve anything for anybody. It capped the total, and the queue handed both
 * slots to whatever arrived first. What actually orders the two is
 * `CompilerProfile.launchOrdinal`, which is a different mechanism entirely.
 *
 * Production then measured the cost of the number itself. Two long discovery
 * missions held both slots while twenty-four filed openings waited to be
 * qualified, and the deep dives — correctly ranked first, with a compiled
 * specification and nothing else wrong with them — simply had nowhere to run.
 * Meanwhile the fleet sat **idle**: four eligible Routines, nothing in flight,
 * three hundred and seventeen fires on the first with two refusals.
 *
 * Six, which is bounded by what has actually been observed rather than chosen
 * to sound safe: §22 records a measured operating ceiling of ten concurrent
 * bins on one Routine, and this fleet has four. It is still a ceiling and still
 * refuses the seventh, and it authorizes nothing — every mission it admits
 * passes the same envelope, the same evidence gate and the same three audit
 * roles it did at two.
 */
export const DISCOVERY_CONCURRENCY = 6;

export interface EnsuredAuthority {
  goal: RussellGoal;
  /** True only on the tick that actually wrote it. */
  created: boolean;
}

/**
 * The live discovery grant for one cash project, created if it is absent.
 *
 * Idempotent by the index, so it is safe to call from activation *and* from
 * every tick — which is what reconciles a sprint that was activated before this
 * existed without anybody pressing anything. That is the same distinction
 * `rearmSurfaceDeferredIntents` draws and the fifth time this repository has
 * needed it: a hook fixes one entrance, and rows reach every entrance plus
 * everything already stranded.
 *
 * Returns null when there is no cash mode, which is not a failure: most
 * projects hold no sprint and the tick asks about all of them.
 */
export async function ensureDiscoveryAuthority(
  projectId: string,
): Promise<EnsuredAuthority | null> {
  const mode = await getCashMode(projectId);
  if (!mode) return null;
  // An archived sprint is not running discovery, and a live research grant on a
  // project nobody is working is a widening nobody asked for. Winding down is
  // deliberately not here: §30 keeps delivery, collection and the research that
  // supports an existing obligation working in every state.
  if (mode.state === 'ARCHIVED') return null;

  const { goal, created } = await ensureGoal({
    projectId,
    // Whose sprint this is, and who pressed Start. Both come from the row that
    // person's own action wrote, so the grant names a human who authorized it
    // rather than a process that wanted one.
    ownerUserId: mode.ownerUserId,
    createdByUserId: mode.createdByUserId,
    name: CASH_DISCOVERY_AUTHORITY_NAME,
    allowedWork: [RESEARCH_WORK],
    // `ALWAYS_PROHIBITED` is unioned in by the repository and carries every
    // external effect. These are named again because they are the ones a reader
    // of a cash sprint will look for, and a prohibition that is only implied is
    // one somebody argues about later.
    prohibitions: ['NEW_SPENDING', 'PURCHASE', 'CONTACT_PERSON', 'PUBLISH_EXTERNALLY'],
    // Meaningless under UNCAPPED and written as zero rather than as a large
    // number pretending to be unlimited, which is §24's own correction.
    maxMissions: 0,
    maxFragments: 0,
    maxProbes: 0,
    maxConcurrent: DISCOVERY_CONCURRENCY,
    workPolicy: 'UNCAPPED',
    // No expiry. The sprint's own lifecycle is the bound: archiving revokes
    // this, and a clock that ended it mid-sprint would be the "released by a
    // clock" failure §30 forbids one table along.
    expiresAt: null,
  });

  /*
   * A grant written under an earlier constant keeps its own number, and this
   * is what reaches it.
   *
   * `ensureGoal` is `ON CONFLICT DO NOTHING`, so changing
   * `DISCOVERY_CONCURRENCY` would otherwise reach every sprint started after
   * the change and no sprint already running — which is this repository's own
   * recurring sentence, and the second time tonight it would have applied to a
   * number I had just corrected. The live sprint would have kept two for ever.
   *
   * It is narrow on purpose. Only the grant Brain issues under its own
   * canonical name is touched, only the concurrency, and only to the constant
   * in this file — nothing a person wrote by hand is reconciled to anything,
   * and no other term of the grant moves. Ordering the check by inequality
   * keeps it idempotent: once they agree, no tick writes anything.
   */
  if (goal.maxConcurrent !== DISCOVERY_CONCURRENCY) {
    const from = goal.maxConcurrent;
    if (await setGoalConcurrency(goal.id, DISCOVERY_CONCURRENCY)) {
      await recordCashEvent({
        projectId,
        kind: 'CASH_DISCOVERY_AUTHORIZED',
        actorRef: 'BRAIN',
        summary:
          `How much of this sprint may run at once moved from ${from} to ` +
          `${DISCOVERY_CONCURRENCY}. It is provider capacity rather than an allowance, and ` +
          'nothing about what may be researched, spent or acted on changed.',
        detail: { goalId: goal.id, from, to: DISCOVERY_CONCURRENCY },
      });
    }
  }

  if (created) {
    await recordCashEvent({
      projectId,
      kind: 'CASH_DISCOVERY_AUTHORIZED',
      actorRef: 'BRAIN',
      summary:
        'Starting Cash Mode authorized Brain to research openings from published sources. ' +
        'Nothing here permits spending, contact, purchase, commitment or publication.',
      detail: {
        goalId: goal.id,
        authorizedByUserId: mode.createdByUserId,
        allowedWork: goal.allowedWork,
        prohibitions: goal.prohibitions,
        maxExternalSpend: 0,
        maxConcurrent: goal.maxConcurrent,
      },
    });
  }
  return { goal, created };
}

/** The live discovery grant, or null. Reading only; creates nothing. */
export async function discoveryAuthority(projectId: string): Promise<RussellGoal | null> {
  return liveGoalNamed(projectId, CASH_DISCOVERY_AUTHORITY_NAME);
}

/**
 * Withdraw it when the sprint is archived.
 *
 * The answering transition for the one state that should not leave a research
 * grant standing. It destroys nothing: the row keeps its id, its terms and its
 * reason, every reservation ever written against it stays, and re-activating
 * the sprint calls `ensureDiscoveryAuthority` again.
 */
export async function withdrawDiscoveryAuthority(input: {
  projectId: string;
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  const goal = await discoveryAuthority(input.projectId);
  if (!goal) return false;
  return revokeGoal({
    goalId: goal.id,
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
}

export interface ResumedCandidate {
  candidateId: string;
  previousReason: string | null;
}

/**
 * Put back the ideas that parked for want of the grant that now exists.
 *
 * A caller of `resumeParkedForProject` (`../russell/resumeParked.ts`) rather
 * than a second implementation, so there is one rule for what counts as a park
 * on missing authority and one rule for what resumes it — asked here through
 * `discoveryAuthority()` so this stays exactly what it always was: a Cash Mode
 * pass, gated on Cash Mode's own named grant. `resumeParkedForProject` decides
 * eligibility generically (any live grant covering research, not only one with
 * this name), which is a strictly wider condition than "this goal exists" and
 * is therefore already satisfied whenever it does.
 *
 * The previous reason is carried onto a `CASH_DISCOVERY_RESUMED` event before
 * the re-judgment overwrites it, because a park that was real is history worth
 * keeping even once it has been answered — Cash Mode's own activity feed reads
 * this event, so it keeps reporting exactly what it reported before this
 * became a caller of the shared rule rather than a second copy of it.
 */
export async function resumeAuthorityParkedCandidates(input: {
  projectId: string;
  limit?: number;
}): Promise<ResumedCandidate[]> {
  const goal = await discoveryAuthority(input.projectId);
  if (!goal) return [];

  const resumed = await resumeParkedForProject({
    projectId: input.projectId,
    limit: input.limit,
  });

  const out: ResumedCandidate[] = [];
  for (const one of resumed) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'CASH_DISCOVERY_RESUMED',
      actorRef: 'BRAIN',
      summary:
        'An idea that had nothing to run under is back in the queue now that starting Cash ' +
        'Mode has authorized internal discovery.',
      detail: { candidateId: one.candidateId, previousReason: one.previousReason, goalId: goal.id },
    });
    out.push({ candidateId: one.candidateId, previousReason: one.previousReason });
  }
  return out;
}
