/**
 * The design problem, as something that can be reasoned about.
 *
 * ---------------------------------------------------------------------------
 * What a design problem is here
 * ---------------------------------------------------------------------------
 *
 * Not "make this screen nicer". A design problem is a small set of facts that
 * together decide a layout, and the reason to write them down is that almost
 * every bad interface decision is made by *not having them* — so the decision
 * falls back on a rule of thumb about buttons.
 *
 * The facts are:
 *
 *   - **what is being represented**, in the product's own nouns;
 *   - **what a person can do**, and which of those the screen exists for;
 *   - **how often** each one happens, and **what it costs** to have done it —
 *     the pair that actually decides emphasis, because a rare irreversible
 *     action and a constant free one want opposite treatments and a "primary
 *     button" rule cannot tell them apart;
 *   - **how much material there is**, read from Brain's own rows rather than
 *     imagined, because a list design for three projects and one for three
 *     hundred are different designs;
 *   - **what has already been learned** that applies here — the patterns in
 *     scope, and the owner's corrections about this very screen;
 *   - **what is already wrong with it**, from the last render.
 *
 * ---------------------------------------------------------------------------
 * Product-aware means it reads the product
 * ---------------------------------------------------------------------------
 *
 * The material counts come from `projects`, `russell_missions`,
 * `russell_candidates` and the rest — the tables the screen is actually a view
 * of. That is what stops this being a generic UI agent: asked to design a
 * surface about missions, it can say *there are four of them and two are
 * running*, and a surface about candidates, *there are sixty-one*. Those are
 * different problems and the difference is a row count rather than an opinion.
 *
 * **It invents nothing.** A concept Brain has no table for reports `null`
 * rather than a plausible number. §30's rule at a new reading: *we could not
 * tell* must never read the same as *we checked*, and a made-up scale would send
 * a design toward a density the product will never have.
 */
import { getDb } from '../../db/database.ts';
import type {
  DesignCapture,
  DesignCorrection,
  DesignFinding,
  DesignPattern,
  DesignSurface,
  SurfaceAction,
} from '../../domain/design.ts';
import { listCaptures, listCorrections, listFindings } from '../../repos/design.ts';
import { patternsInScope } from './patterns.ts';

/**
 * Which table answers *how much of this is there*, per concept.
 *
 * A declared map rather than a naming convention, for `design_surfaces.concepts`'
 * own reason: a convention that turned the word `mission` into the table
 * `missions` would be right until the first concept whose table is named
 * something else, and then silently wrong. A concept that is not here has no
 * count, and says so.
 */
const CONCEPT_TABLES: Record<string, string> = {
  project: 'projects',
  layer: 'layers',
  document: 'documents',
  conversation: 'russell_conversations',
  mission: 'russell_missions',
  candidate: 'russell_candidates',
  idea: 'russell_candidates',
  decision: 'russell_human_requests',
  'human request': 'russell_human_requests',
  'change request': 'russell_software_requests',
  campaign: 'factory_campaigns',
  unit: 'factory_units',
  worker: 'workers',
  routine: 'fleet_routines',
  account: 'fleet_accounts',
  member: 'users',
  knowledge: 'russell_knowledge',
  claim: 'research_claims',
  packet: 'research_orchestrations',
  fragment: 'research_fragments',
  audit: 'audits',
  review: 'factory_reviews',
};

/** How much material a concept actually has, or that nobody knows. */
export interface ConceptScale {
  concept: string;
  /** Null means Brain has no table for this concept — never zero. */
  rows: number | null;
  table: string | null;
}

export interface DesignProblem {
  surface: DesignSurface;
  /** What this screen represents, with how much of it exists. */
  concepts: ConceptScale[];
  /** The one action the screen is for, when it declares one. */
  primaryAction: SurfaceAction | null;
  /**
   * Actions that are rare and expensive, which is the pair that decides
   * subordination: these are the ones that should be quiet until invoked and
   * should ask for confirmation in proportion to what they cost.
   */
  gravityActions: SurfaceAction[];
  /** Actions that happen constantly and cost nothing, which want to be instant. */
  routineActions: SurfaceAction[];
  /** Reusable knowledge that applies here, strongest evidence first. */
  patterns: DesignPattern[];
  /** What the owner has already said about this screen or its parts. */
  corrections: DesignCorrection[];
  /** What the last render found, still open. */
  openFindings: DesignFinding[];
  /** The most recent capture per width, so the problem is about a real state. */
  lastCaptures: DesignCapture[];
  /** Anything the model could not establish. Present rather than assumed. */
  unknowns: string[];
}

/**
 * Count the rows behind one concept.
 *
 * A `COUNT(*)` against a declared table name — the name never comes from the
 * concept string, so there is nothing here a caller could steer. A table that
 * does not exist on this schema answers null rather than throwing, because a
 * design problem must still be describable on a Brain that has not run every
 * migration.
 */
async function scaleOf(concept: string): Promise<ConceptScale> {
  const table = CONCEPT_TABLES[concept.toLowerCase()] ?? null;
  if (!table) return { concept, rows: null, table: null };
  try {
    const row = await getDb().get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return { concept, rows: Number(row?.count ?? 0), table };
  } catch {
    return { concept, rows: null, table };
  }
}

/**
 * Build the problem for one surface.
 *
 * Read-only by construction: nothing here opens a cycle, writes a finding or
 * moves a capability. §38's allocator is split from the pass that acts on it for
 * the same reason — somebody should be able to ask *what is the problem here*
 * without anything happening.
 */
export async function describeProblem(surface: DesignSurface): Promise<DesignProblem> {
  const concepts = await Promise.all(surface.concepts.map((one) => scaleOf(one)));
  const unknowns = concepts
    .filter((one) => one.rows === null)
    .map(
      (one) =>
        `how much "${one.concept}" there is — Brain has no table declared for it, so the scale of ` +
        'this part of the screen is not known rather than small',
    );

  const primaryAction = surface.actions.find((one) => one.primary) ?? null;
  const gravityActions = surface.actions.filter(
    (one) =>
      (one.reversibility === 'IRREVERSIBLE' || one.reversibility === 'COSTLY') &&
      (one.frequency === 'RARE' || one.frequency === 'OCCASIONAL'),
  );
  const routineActions = surface.actions.filter(
    (one) => one.frequency === 'CONSTANT' && one.reversibility === 'FREE',
  );

  const patterns = await patternsInScope({
    surfaceKey: surface.surfaceKey,
    faculty: surface.faculty,
    components: [],
  });

  /*
   * Corrections about this screen, and corrections about the whole product.
   *
   * Both, and deliberately not corrections about *another* screen: §24's rule
   * that a correction is evidence with a scope, and the failure mode of getting
   * it wrong is the one the owner described — a fix applied everywhere removing
   * something useful somewhere else.
   */
  const corrections = [
    ...(await listCorrections({ surfaceKey: surface.surfaceKey, limit: 50 })),
    ...(await listCorrections({ scope: 'GLOBAL', limit: 50 })),
    ...(surface.faculty
      ? await listCorrections({ scope: 'FACULTY', scopeRef: surface.faculty, limit: 50 })
      : []),
  ];
  const seen = new Set<string>();
  const deduped = corrections.filter((one) => (seen.has(one.id) ? false : (seen.add(one.id), true)));

  const openFindings = await listFindings({
    surfaceKey: surface.surfaceKey,
    state: 'OPEN',
    limit: 200,
  });

  const lastCaptures = await recentCaptures(surface.surfaceKey);
  if (lastCaptures.length === 0) {
    unknowns.push(
      'what this surface currently looks like — nothing has been rendered, so every statement ' +
        'about its layout would be a statement about the source',
    );
  }

  return {
    surface,
    concepts,
    primaryAction,
    gravityActions,
    routineActions,
    patterns,
    corrections: deduped,
    openFindings,
    lastCaptures,
    unknowns,
  };
}

/** The newest capture per width for one surface. */
async function recentCaptures(surfaceKey: string): Promise<DesignCapture[]> {
  const all = await listCaptures({ surfaceKey, limit: 60 });
  const byWidth = new Map<number, DesignCapture>();
  for (const capture of all) {
    // `listCaptures` is newest first, so the first per width wins.
    if (!byWidth.has(capture.width)) byWidth.set(capture.width, capture);
  }
  return [...byWidth.values()].sort((a, b) => b.width - a.width);
}

/**
 * The problem as prose, for a worker that is going to judge the screen.
 *
 * This is what makes the judged lane worth anything: a reviewer handed only a
 * picture can say "improve the visual hierarchy", and a reviewer handed *what
 * this screen represents, what a person does here, how much material there
 * really is, and what has already been said about it* can say something a
 * person can act on.
 *
 * It states the unknowns rather than omitting them, because a reviewer who does
 * not know that the scale of something is unknown will assume it.
 */
export function problemBrief(problem: DesignProblem): string {
  const lines: string[] = [];
  lines.push(`SURFACE  ${problem.surface.surfaceKey} — ${problem.surface.title}`);
  lines.push(`ADDRESS  ${problem.surface.route} (state: ${problem.surface.stateKey})`);
  lines.push('');
  lines.push('WHAT THIS SCREEN REPRESENTS, AND HOW MUCH OF IT EXISTS RIGHT NOW');
  for (const concept of problem.concepts) {
    lines.push(
      concept.rows === null
        ? `  ${concept.concept}: how many there are is not known`
        : `  ${concept.concept}: ${concept.rows}`,
    );
  }
  lines.push('');
  lines.push('WHAT A PERSON CAN DO HERE');
  for (const action of problem.surface.actions) {
    lines.push(
      `  ${action.primary ? '*' : ' '} ${action.name} — ${action.frequency.toLowerCase()}, ` +
        `${action.reversibility.toLowerCase().replace('_', ' ')}`,
    );
  }
  if (problem.gravityActions.length > 0) {
    lines.push('');
    lines.push(
      '  Rare and expensive, so they should be quiet until deliberately invoked and should ask ' +
        'for confirmation in proportion to what they cost: ' +
        problem.gravityActions.map((one) => one.name).join('; '),
    );
  }

  if (problem.patterns.length > 0) {
    lines.push('');
    lines.push('WHAT HAS ALREADY BEEN LEARNED THAT APPLIES HERE');
    for (const pattern of problem.patterns.slice(0, 12)) {
      lines.push(`  [${pattern.primitive}${pattern.branch ? `/${pattern.branch}` : ''}] ${pattern.statement}`);
      lines.push(`      applies when: ${pattern.appliesWhen}`);
      if (pattern.exceptions) lines.push(`      except: ${pattern.exceptions}`);
    }
  }

  if (problem.corrections.length > 0) {
    lines.push('');
    lines.push("WHAT THE OWNER HAS SAID ABOUT THIS, IN THEIR OWN WORDS");
    for (const correction of problem.corrections.slice(0, 10)) {
      lines.push(`  "${correction.correction}" (${correction.scope.toLowerCase()})`);
      if (correction.lesson) lines.push(`      taken as: ${correction.lesson}`);
    }
  }

  if (problem.openFindings.length > 0) {
    lines.push('');
    lines.push('WHAT IS ALREADY KNOWN TO BE WRONG WITH IT');
    for (const finding of problem.openFindings.slice(0, 20)) {
      lines.push(`  [${finding.severity}] ${finding.statement}`);
    }
  }

  if (problem.unknowns.length > 0) {
    lines.push('');
    lines.push('WHAT IS NOT KNOWN — do not assume a value for any of these');
    for (const unknown of problem.unknowns) lines.push(`  ${unknown}`);
  }

  return lines.join('\n');
}
