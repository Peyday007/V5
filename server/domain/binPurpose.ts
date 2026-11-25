/**
 * What a bin is for, decided once, when it is created.
 *
 * Owner's order, 2026-11-03: paid Claude routines do only work that improves
 * Brain itself — research methods, source finding and judging, evidence rules,
 * reasoning and scoring, memory and learning, audits of Brain's own methods,
 * and Brain's code, tools and worker system. Everything about one play, deal,
 * product, market, company, country, buyer or price is PLAY_RESEARCH, bulk
 * lookups are GRUNT, and anything that needs a person's legal call is
 * BLOCKED_LEGAL. See ARCHITECTURE-RECORD §84.
 *
 * Deterministic rules first, over rows that created the bin (its kind, its
 * repository, its project). Keywords only as a backup, and only to move a bin
 * *away* from Claude — a keyword never makes a play bin Brain work, because a
 * classifier that can be talked into "Brain improvement" by a word in a title
 * is a bypass. Anything nothing decided is PLAY_RESEARCH: default deny.
 *
 * Pure, so "why was this bin parked" is answerable from the inputs alone.
 */

export const BIN_PURPOSES = ['BRAIN_IMPROVEMENT', 'PLAY_RESEARCH', 'GRUNT', 'BLOCKED_LEGAL'] as const;
export type BinPurpose = (typeof BIN_PURPOSES)[number];

/** Where a bin goes under brain-only mode. */
export type BinLane = 'CLAUDE' | 'FREE_LANE' | 'WAITING_FOR_FREE_LANE' | 'PARKED_LEGAL';

/**
 * Goals the owner has directed Brain's resources to (2026-11-14: "THE PRIORITY IS
 * THE PLAN. FOCUS RESOURCES THERE."; 2026-11-23: "Restore productive utilization
 * of existing resources: Claude routines 0/12"). The one exception to brain-only
 * mode: a bin this goal links to may be handed to an idle routine (§84, §118).
 * Ids only, and checked against a character class before they reach SQL.
 */
export const OWNER_DIRECTED_GOAL_IDS: readonly string[] = ['wst_7b4fcbb5f2384f31b6c3'];

/**
 * Every owner-directed goal, read from rows (§119: an owner's rule lives in a
 * row), as one uncorrelated sub-select of `workstreams.id`.
 *
 * A goal is owner-directed when a person owns it and stated a measurable target
 * for it (`owner_user_id`, `target_metric`, `target_set_at`, migration 128) and
 * it is live — not archived, cancelled or paused (a person's pause, or an
 * operator's under a committed decision, takes its research back off the
 * routines). `OWNER_DIRECTED_GOAL_IDS` stays in the set: it is the order the
 * owner gave before the target columns existed.
 *
 * Production, 2026-11-25 00:19Z: five cash goals the owner set on 2026-11-19
 * (wst_db2e2e0e…, wst_fa476177…, wst_deede499…, wst_66311cab…, wst_4f0c3124…)
 * read "Brain fires the next free Routine at bin …" beside 11 idle routines,
 * and none was ever fired: the list above named only the $10K goal, so their
 * research waited on the free lane alone.
 */
export function ownerDirectedGoalIdsSql(): string {
  const ids = OWNER_DIRECTED_GOAL_IDS.filter((id) => /^wst_[0-9a-f]+$/.test(id));
  const listed = ids.length > 0 ? `SELECT ow.id FROM workstreams ow WHERE ow.id IN (${ids.map((id) => `'${id}'`).join(', ')}) UNION ` : '';
  return (
    `${listed}SELECT ow2.id FROM workstreams ow2` +
    ` WHERE ow2.owner_user_id IS NOT NULL AND ow2.target_metric IS NOT NULL AND ow2.target_set_at IS NOT NULL` +
    ` AND ow2.archived_at IS NULL AND ow2.cancelled_at IS NULL AND ow2.paused_at IS NULL`
  );
}

/** The project whose research is how Brain researches (`capability/ingest.ts`). */
export const BRAIN_PROJECT_SLUG = 'brain-architecture';

/** Brain's own repository, as `repositoryIdOf` spells it. */
export const BRAIN_REPOSITORY_ID = 'peyday007/v5';

export interface PurposeInput {
  kind: string;
  workloadClass?: string | null;
  completionContract?: string | null;
  title: string;
  objective: string;
  rationale?: string | null;
  /** The manifest's `lineage.goal`, the assignment text. */
  goal?: string | null;
  /** `owner/name`, lower case, when the manifest names a repository. */
  repositoryId?: string | null;
  project: { slug: string; purpose: string } | null;
}

export interface PurposeDecision {
  purpose: BinPurpose;
  /** The rule that decided it, recorded on the row. */
  basis: string;
}

/**
 * A person's call: sanctions, export control, legality — and the jurisdictions
 * under comprehensive sanctions, because a question about selling into one is a
 * sanctions question whatever its title says (bin_481feaaee88f48ffa917, Russia
 * dump-truck landed cost, declined by three sessions for LEGAL_RISK).
 */
const LEGAL_PATTERNS: readonly RegExp[] = [
  /\bsanction(s|ed)?\b/i,
  /\bexport[- ]control/i,
  /\bembargo/i,
  /\bofac\b/i,
  /\bitar\b/i,
  /\bear99\b/i,
  /\bdual[- ]use\b/i,
  /\blegality\b/i,
  /\bis it legal\b/i,
  /\blegal(ly)? (risk|call|question|advice|review|opinion)\b/i,
  /\b(russia|russian|iran|iranian|north korea|syria|syrian|cuba|cuban|belarus|crimea)\b/i,
];

/** Bulk lookups, lead hunting, list building, simple extraction. */
const GRUNT_PATTERNS: readonly RegExp[] = [
  /\blead(s| list| hunt| hunting| generation)\b/i,
  /\bbuild (a |the )?list\b/i,
  /\blist[- ]building\b/i,
  /\bbulk (lookup|look-up|search)/i,
  /\bscrape\b/i,
  /\bcontact (list|details)\b/i,
];

function textOf(input: PurposeInput): string {
  return [input.title, input.objective, input.rationale ?? '', input.goal ?? ''].join('\n');
}

/** Whether the project is Brain's own: its research methods, or machinery proving itself. */
export function isBrainProject(project: PurposeInput['project']): boolean {
  if (!project) return false;
  return project.slug === BRAIN_PROJECT_SLUG || project.purpose === 'TECHNICAL';
}

export function classifyBinPurpose(input: PurposeInput): PurposeDecision {
  const signals = [input.kind, input.workloadClass ?? '', input.completionContract ?? ''];

  // 1. The worker system proving itself: fleet probes and delivery proofs.
  if (signals.some((s) => s === 'DETERMINISTIC_CHECK' || s.startsWith('SURFACE_PROBE'))) {
    return { purpose: 'BRAIN_IMPROVEMENT', basis: 'KIND:WORKER_SYSTEM_PROBE' };
  }

  // 2. Software: Brain's own repository is Brain work; any other repository is a product.
  if (input.repositoryId || signals.some((s) => s.startsWith('FACTORY'))) {
    if (input.repositoryId === BRAIN_REPOSITORY_ID) {
      return { purpose: 'BRAIN_IMPROVEMENT', basis: 'REPOSITORY:BRAIN' };
    }
    return { purpose: 'PLAY_RESEARCH', basis: `REPOSITORY:${input.repositoryId ?? 'UNNAMED'}` };
  }

  // 3. The project: Brain's own projects are Brain work, audits and judges included.
  if (isBrainProject(input.project)) {
    return { purpose: 'BRAIN_IMPROVEMENT', basis: `PROJECT:${input.project?.slug}` };
  }

  // Everything below is outside Brain's own projects, so it is never Claude's.
  const text = textOf(input);

  // 4. Backup: a person's legal call, which no worker may be handed.
  if (LEGAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { purpose: 'BLOCKED_LEGAL', basis: 'KEYWORD:LEGAL' };
  }

  // 5. Simple extraction by kind, then grunt work by keyword.
  if (signals.some((s) => s.startsWith('CAPABILITY_'))) {
    return { purpose: 'GRUNT', basis: 'KIND:EXTRACTION' };
  }
  if (GRUNT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { purpose: 'GRUNT', basis: 'KEYWORD:GRUNT' };
  }

  // 6. Default deny.
  return {
    purpose: 'PLAY_RESEARCH',
    basis: input.project ? `PROJECT:${input.project.slug}` : 'DEFAULT_DENY',
  };
}

/**
 * Where a bin goes. A bin with no purpose is PLAY_RESEARCH. A legal bin is
 * parked whatever the mode; under brain-only mode everything else that is not
 * Brain work belongs to the free research lane (`services/freeLane/worker.ts`)
 * when a free model is configured, and waits for one when none is.
 */
export function binLane(purpose: BinPurpose | null, brainOnlyMode: boolean, freeLaneConfigured = false): BinLane {
  const effective = purpose ?? 'PLAY_RESEARCH';
  if (effective === 'BLOCKED_LEGAL') return 'PARKED_LEGAL';
  if (effective === 'BRAIN_IMPROVEMENT' || !brainOnlyMode) return 'CLAUDE';
  // §85: the free research lane drains PLAY_RESEARCH and GRUNT whenever it is configured.
  return freeLaneConfigured && purpose !== null ? 'FREE_LANE' : 'WAITING_FOR_FREE_LANE';
}
