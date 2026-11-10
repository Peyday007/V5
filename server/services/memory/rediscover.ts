/**
 * Rediscovery: bringing an old idea back when it deserves another look, and
 * acting on what the person decides.
 *
 * A discovery is surfaced for a reason, and the reason is a row: an idea left
 * unresolved and not raised for months, a new conversation that came back to
 * it, or a change in circumstance that removes the obstacle it stalled on.
 * Without a reason there is no discovery, and the open list is capped so the
 * page holds a few findings that matter rather than every reminder possible.
 *
 * The person's answer is the strongest fact in the system. It updates the idea
 * (versioned, never overwritten), is logged append-only, and is learned from:
 * kinds of idea the person keeps taking up rank higher, kinds they keep
 * dismissing rank lower — without ever erasing anything.
 */
import { getDb } from '../../db/database.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { createProject, getProject, listProjects } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { tokens } from './classify.ts';
import { getCursor, recordMemoryEvent, setCursor } from './events.ts';
import { linkIdeas, type IdeaKind, type IdeaState } from './excavate.ts';

export const MAX_OPEN_DISCOVERIES = 12;
export const MAX_NEW_PER_PASS = 4;
const DECIDED_COOLDOWN_DAYS = 30;

export const DECISIONS = ['EXPLORE', 'PLAN', 'CREATE_SECTION', 'LATER', 'NOT_INTERESTED', 'UPDATE_WANT', 'FEEDBACK'] as const;
export type MemoryDecision = (typeof DECISIONS)[number];

export type TriggerKind = 'UNRESOLVED_AND_QUIET' | 'NEW_RELATED_DISCUSSION' | 'CIRCUMSTANCE' | 'CONNECTION' | 'RECONSIDER';

const KIND_WEIGHT: Record<IdeaKind, number> = {
  AMBITION: 1,
  GOAL: 0.9,
  BUSINESS: 0.9,
  CREATIVE: 0.9,
  PROJECT: 0.85,
  FINANCIAL: 0.8,
  COMMITMENT: 0.8,
  PLAN: 0.6,
  DECISION: 0.5,
  INTEREST: 0.5,
  QUESTION: 0.35,
};

const STATE_WEIGHT: Record<IdeaState, number> = {
  UNRESOLVED: 1,
  PAUSED: 0.95,
  ACTIVE: 0.45,
  SUPERSEDED: 0.25,
  COMPLETED: 0,
  REJECTED: 0,
};

interface IdeaForScoring {
  id: string;
  kind: IdeaKind;
  title: string;
  statement: string;
  state: IdeaState;
  owner_state: IdeaState | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  conversation_count: number;
  mention_count: number;
  user_words: number;
  cue_strength: number;
  obstacles: string;
  signature: string;
  domain: string | null;
  owner_intent: string | null;
}

/**
 * Learned preference per kind: (taken up + 1) / (decided + 2). Follow-through
 * counts double — an idea promoted and then actually moving says more than a
 * click.
 */
export async function learnedWeights(ownerId: string): Promise<Record<string, number>> {
  const rows = await getDb().all<{ idea_kind: string; decision: string; n: number }>(
    `SELECT idea_kind, decision, COUNT(*) AS n FROM memory_decisions WHERE owner_user_id = ? AND decision <> 'FEEDBACK'
      GROUP BY idea_kind, decision`,
    [ownerId],
  );
  const followed = await getDb().all<{ kind: string; n: number }>(
    `SELECT i.kind, COUNT(*) AS n FROM memory_ideas i JOIN russell_candidates c ON c.id = i.candidate_id
      WHERE i.owner_user_id = ? AND c.state NOT IN ('CAPTURED','REJECTED') GROUP BY i.kind`,
    [ownerId],
  );
  const taken = new Map<string, number>();
  const decided = new Map<string, number>();
  for (const r of rows) {
    decided.set(r.idea_kind, (decided.get(r.idea_kind) ?? 0) + Number(r.n));
    if (['EXPLORE', 'PLAN', 'CREATE_SECTION'].includes(r.decision)) taken.set(r.idea_kind, (taken.get(r.idea_kind) ?? 0) + Number(r.n));
  }
  for (const f of followed) taken.set(f.kind, (taken.get(f.kind) ?? 0) + Number(f.n));
  const weights: Record<string, number> = {};
  for (const kind of Object.keys(KIND_WEIGHT)) {
    const d = decided.get(kind) ?? 0;
    const t = Math.min(taken.get(kind) ?? 0, d + 2);
    // 0.5 with no history; between ~0.3 and ~1 as history accrues. Scaled so
    // "no history" is neutral (1.0).
    weights[kind] = ((t + 1) / (d + 2)) * 2;
  }
  return weights;
}

/** The score, its parts, and the archive's own clock (not wall time). Exported for tests. */
export function scoreIdea(idea: Pick<IdeaForScoring, 'kind' | 'state' | 'cue_strength' | 'conversation_count' | 'user_words' | 'last_seen_at'>, now: string, learned: Record<string, number>, triggerBoost: number): number {
  const kind = KIND_WEIGHT[idea.kind] ?? 0.5;
  const state = STATE_WEIGHT[idea.state] ?? 0.5;
  if (state === 0) return 0;
  // Importance is the larger of how plainly it was wanted and how much it was
  // returned to — never their product — so a single emphatic mention competes
  // with a topic of a hundred conversations.
  const breadth = Math.min(1, Math.log2(1 + idea.conversation_count) / 4);
  const effort = Math.min(1, idea.user_words / 400);
  const importance = Math.max(idea.cue_strength, breadth, effort * 0.8);
  const days = idea.last_seen_at ? (Date.parse(now) - Date.parse(idea.last_seen_at)) / 86_400_000 : 365;
  const quiet = days > 180 ? 1 : days > 60 ? 0.75 : days > 14 ? 0.5 : 0.3;
  const learnedFactor = learned[idea.kind] ?? 1;
  return Number((kind * state * (0.35 + importance) * (0.5 + quiet) * learnedFactor + triggerBoost).toFixed(4));
}

function monthYear(iso: string | null): string {
  if (!iso) return 'an unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'an unknown date' : d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function whyMatters(idea: IdeaForScoring): string {
  const parts: string[] = [];
  if (idea.cue_strength >= 0.5) parts.push('you stated it as something you wanted, not just a passing thought');
  if (idea.conversation_count >= 3) parts.push(`you came back to it in ${idea.conversation_count} conversations`);
  else if (idea.conversation_count <= 1) parts.push('you raised it once, and it was never picked up again');
  if (idea.user_words >= 300) parts.push(`you wrote about ${idea.user_words} words on it yourself`);
  const obstacles = parseJson<string[]>(idea.obstacles, []).filter((o) => o !== 'OTHER');
  if (obstacles.length) parts.push(`it stalled on ${obstacles.map((o) => o.toLowerCase()).join(' and ')}`);
  const sentence = parts.length ? parts.join('; ') : 'it is one of your own stated intentions';
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

interface Trigger {
  kind: TriggerKind;
  ref: string | null;
  why: string;
  boost: number;
}

/**
 * Brain's own circumstances, derived from its rows: the projects it is working
 * on now (priorities) and what it can do that it could not before. Recorded
 * once each, so a circumstance re-evaluates the archive once rather than on
 * every pass.
 */
export async function deriveBrainCircumstances(ownerId: string): Promise<number> {
  const db = getDb();
  let added = 0;
  const at = nowIso();
  const capability = await db.run(
    `INSERT INTO memory_circumstances (id, owner_user_id, kind, statement, terms, source, source_ref, observed_at)
     VALUES (?, ?, 'CAPABILITY', ?, ?, 'BRAIN', 'factory-software', ?)
     ON CONFLICT (owner_user_id, source, source_ref) DO NOTHING`,
    [
      newId('mcs'), ownerId,
      'Brain can now design, build and ship software itself (its Factory), so an idea that stalled on not knowing how to build it, or on the tools not existing, may now be buildable.',
      ' app apps software website site tool tools automation automate bot code coding platform build program api ',
      at,
    ],
  );
  added += Number(capability.changes);
  for (const project of (await listProjects()).filter((p) => p.status === 'ACTIVE').slice(0, 100)) {
    const words = [...new Set(tokens(`${project.name} ${project.description ?? ''} ${project.northStar ?? ''}`))].slice(0, 20);
    if (words.length === 0) continue;
    const r = await db.run(
      `INSERT INTO memory_circumstances (id, owner_user_id, kind, statement, terms, source, source_ref, observed_at)
       VALUES (?, ?, 'PRIORITY', ?, ?, 'BRAIN', ?, ?)
       ON CONFLICT (owner_user_id, source, source_ref) DO NOTHING`,
      [newId('mcs'), ownerId, `Brain is currently working on "${project.name}".`, ` ${words.join(' ')} `, `project:${project.id}`, at],
    );
    added += Number(r.changes);
  }
  return added;
}

export async function recordCircumstance(input: {
  ownerId: string;
  kind: 'CAPABILITY' | 'CAPITAL' | 'PRIORITY' | 'OBSTACLE_REMOVED' | 'OPPORTUNITY' | 'FEASIBILITY';
  statement: string;
}): Promise<{ id: string }> {
  const id = newId('mcs');
  await getDb().run(
    `INSERT INTO memory_circumstances (id, owner_user_id, kind, statement, terms, source, source_ref, observed_at)
     VALUES (?, ?, ?, ?, ?, 'PERSON', ?, ?)`,
    [id, input.ownerId, input.kind, input.statement.slice(0, 1000), ` ${[...new Set(tokens(input.statement))].join(' ')} `, id, nowIso()],
  );
  await recordMemoryEvent(input.ownerId, 'CIRCUMSTANCE', id, 'CIRCUMSTANCE_RECORDED', { kind: input.kind });
  return { id };
}

const OBSTACLE_FOR: Record<string, string[]> = {
  CAPABILITY: ['TECHNOLOGY', 'SKILL'],
  CAPITAL: ['MONEY'],
  OBSTACLE_REMOVED: ['MONEY', 'SKILL', 'TIME', 'TECHNOLOGY', 'PEOPLE', 'CONFIDENCE', 'OTHER'],
  FEASIBILITY: ['TECHNOLOGY', 'SKILL', 'MONEY'],
  PRIORITY: [],
  OPPORTUNITY: [],
};

/**
 * Re-evaluate the registry against what changed, then surface what deserves it.
 */
export async function reevaluate(ownerId: string, now = nowIso()): Promise<{ surfaced: number; retired: number; triggers: number }> {
  const db = getDb();
  const triggers = new Map<string, Trigger>();
  const put = (ideaId: string, t: Trigger): void => {
    const prior = triggers.get(ideaId);
    if (!prior || prior.boost < t.boost) triggers.set(ideaId, t);
  };

  // 1. New discussion that returned to an idea after it was last surfaced or decided.
  const since = (await getCursor(ownerId, 'reevaluated_at')) ?? '1970-01-01T00:00:00.000Z';
  const returned = await db.all<{ idea_id: string; said_at: string | null; conversation_id: string }>(
    `SELECT e.idea_id, MAX(e.said_at) AS said_at, MAX(e.conversation_id) AS conversation_id
       FROM memory_idea_evidence e JOIN memory_ideas i ON i.id = e.idea_id
      WHERE i.owner_user_id = ? AND e.created_at > ? AND i.first_seen_at IS NOT NULL AND e.said_at > i.first_seen_at
      GROUP BY e.idea_id`,
    [ownerId, since],
  );
  for (const r of returned) {
    put(r.idea_id, {
      kind: 'NEW_RELATED_DISCUSSION',
      ref: r.conversation_id,
      why: `A conversation from ${monthYear(r.said_at)} came back to this.`,
      boost: 0.3,
    });
  }

  // 2. Circumstances not yet applied.
  const circumstances = await db.all<{ id: string; kind: string; statement: string; terms: string }>(
    `SELECT id, kind, statement, terms FROM memory_circumstances WHERE owner_user_id = ? AND applied_at IS NULL`,
    [ownerId],
  );
  if (circumstances.length > 0) {
    const open = await db.all<{ id: string; signature: string; obstacles: string; statement: string }>(
      `SELECT id, signature, obstacles, statement FROM memory_ideas WHERE owner_user_id = ? AND state IN ('UNRESOLVED','PAUSED','ACTIVE')`,
      [ownerId],
    );
    for (const c of circumstances) {
      const terms = new Set(c.terms.trim().split(/\s+/).filter(Boolean));
      const removes = OBSTACLE_FOR[c.kind] ?? [];
      for (const idea of open) {
        const words = new Set([...idea.signature.split(' '), ...tokens(idea.statement)]);
        const overlap = [...terms].filter((t) => words.has(t)).length;
        const obstacles = parseJson<string[]>(idea.obstacles, []);
        const unblocks = removes.some((o) => obstacles.includes(o)) && (c.kind !== 'CAPABILITY' || overlap >= 1);
        const relates = overlap >= 2;
        if (unblocks) {
          put(idea.id, { kind: 'CIRCUMSTANCE', ref: c.id, why: `${c.statement} This idea stalled on exactly that.`, boost: 0.6 });
        } else if (relates && (c.kind === 'PRIORITY' || c.kind === 'OPPORTUNITY')) {
          put(idea.id, { kind: 'CIRCUMSTANCE', ref: c.id, why: `${c.statement} This older idea is about the same thing.`, boost: 0.35 });
        }
      }
      await db.run('UPDATE memory_circumstances SET applied_at = ? WHERE id = ?', [now, c.id]);
    }
  }

  // 3. Retire open discoveries the record has since settled.
  const retired = await db.run(
    `UPDATE memory_discoveries SET state = 'RETIRED', decided_at = ?
      WHERE owner_user_id = ? AND state = 'OPEN'
        AND idea_id IN (SELECT id FROM memory_ideas WHERE owner_user_id = ? AND state IN ('COMPLETED','REJECTED'))`,
    [now, ownerId, ownerId],
  );

  const surfaced = await surface(ownerId, triggers, now);
  await setCursor(ownerId, 'reevaluated_at', now);
  return { surfaced, retired: Number(retired.changes), triggers: triggers.size };
}

async function surface(ownerId: string, triggers: Map<string, Trigger>, now: string): Promise<number> {
  const db = getDb();
  const open = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memory_discoveries WHERE owner_user_id = ? AND state = 'OPEN'`,
    [ownerId],
  );
  let room = Math.min(MAX_NEW_PER_PASS, MAX_OPEN_DISCOVERIES - Number(open?.n ?? 0));
  if (room <= 0) return 0;

  const learned = await learnedWeights(ownerId);
  const ideas = await db.all<IdeaForScoring & { last_decision: string | null; last_decided_at: string | null; has_open: number }>(
    `SELECT i.id, i.kind, i.title, i.statement, i.state, i.owner_state, i.first_seen_at, i.last_seen_at,
            i.conversation_count, i.mention_count, i.user_words, i.cue_strength, i.obstacles, i.signature, i.domain, i.owner_intent,
            (SELECT d.decision FROM memory_decisions d WHERE d.idea_id = i.id AND d.decision <> 'FEEDBACK' ORDER BY d.created_at DESC LIMIT 1) AS last_decision,
            (SELECT MAX(d.created_at) FROM memory_decisions d WHERE d.idea_id = i.id) AS last_decided_at,
            (SELECT COUNT(*) FROM memory_discoveries x WHERE x.idea_id = i.id AND x.state = 'OPEN') AS has_open
       FROM memory_ideas i
      WHERE i.owner_user_id = ? AND i.state NOT IN ('COMPLETED','REJECTED')`,
    [ownerId],
  );
  const scored: { idea: (typeof ideas)[number]; score: number; trigger: Trigger }[] = [];
  for (const idea of ideas) {
    if (Number(idea.has_open) > 0) continue;
    const trigger = triggers.get(idea.id);
    // Something the person already answered comes back only when something
    // changed (a trigger) and the cooldown has passed. "Not interested" never
    // does — it is kept, and not resurfaced.
    if (idea.last_decision === 'NOT_INTERESTED') continue;
    if (idea.last_decision && ['EXPLORE', 'PLAN', 'CREATE_SECTION'].includes(idea.last_decision)) continue;
    if (idea.last_decided_at) {
      const days = (Date.parse(now) - Date.parse(idea.last_decided_at)) / 86_400_000;
      if (!trigger || days < DECIDED_COOLDOWN_DAYS) continue;
    }
    // Unprompted surfacing needs an idea left open and quiet; a trigger can
    // bring back anything open.
    const quietDays = idea.last_seen_at ? (Date.parse(now) - Date.parse(idea.last_seen_at)) / 86_400_000 : 365;
    const effective: Trigger | null =
      trigger ??
      ((idea.state === 'UNRESOLVED' || idea.state === 'PAUSED') && quietDays >= 30
        ? {
            kind: 'UNRESOLVED_AND_QUIET',
            ref: null,
            why: `You last discussed this in ${monthYear(idea.last_seen_at)} and the archive never says what became of it.`,
            boost: 0,
          }
        : null);
    if (!effective) continue;
    const score = scoreIdea(idea, now, learned, effective.boost);
    if (score <= 0.05) continue;
    scored.push({ idea, score, trigger: effective });
  }
  scored.sort((a, b) => b.score - a.score);

  let surfaced = 0;
  for (const entry of scored) {
    if (room <= 0) break;
    const id = newId('mds');
    const r = await db.run(
      `INSERT INTO memory_discoveries (id, owner_user_id, idea_id, state, score, why_matters, why_now, trigger_kind, trigger_ref, surfaced_at)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idea_id) WHERE state = 'OPEN' DO NOTHING`,
      [id, ownerId, entry.idea.id, entry.score, whyMatters(entry.idea), entry.trigger.why, entry.trigger.kind, entry.trigger.ref, now],
    );
    if (Number(r.changes) > 0) {
      surfaced += 1;
      room -= 1;
      await recordMemoryEvent(ownerId, 'DISCOVERY', id, 'DISCOVERY_SURFACED', { ideaId: entry.idea.id, trigger: entry.trigger.kind });
    }
  }
  return surfaced;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
export interface DecisionResult {
  decisionId: string;
  ideaId: string;
  state: IdeaState;
  created: { kind: 'CANDIDATE' | 'PROJECT' | null; id: string | null; projectId: string | null };
}

export class DecisionRefused extends Error {}

interface IdeaRow {
  id: string;
  owner_user_id: string;
  kind: IdeaKind;
  title: string;
  statement: string;
  state: IdeaState;
  version: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  state_basis: string;
  open_questions: string;
  obstacles: string;
  owner_intent: string | null;
  candidate_id: string | null;
  project_id: string | null;
  reconsider_when: string;
}

/** A concrete game plan from the idea's own history. Deterministic; a draft for the person. */
export function gamePlanFor(idea: Pick<IdeaRow, 'title' | 'statement' | 'owner_intent' | 'obstacles' | 'open_questions' | 'state_basis'>, feedback: string | null): string[] {
  const steps: string[] = [];
  steps.push(`Define the outcome: ${idea.owner_intent ?? idea.title}`);
  for (const obstacle of parseJson<string[]>(idea.obstacles, []).filter((o) => o !== 'OTHER')) {
    steps.push(`Resolve the ${obstacle.toLowerCase()} obstacle that stalled it before — decide how it is handled now.`);
  }
  for (const question of parseJson<string[]>(idea.open_questions, []).slice(0, 3)) {
    steps.push(`Answer the open question: ${question}`);
  }
  if (feedback) steps.push(`Apply your instruction: ${feedback}`);
  steps.push('Choose the smallest first piece of work that proves it, and do it this week.');
  steps.push('Review what happened and decide the next step.');
  return steps;
}

async function defaultProjectFor(ownerId: string): Promise<string | null> {
  const projects = (await listProjects()).filter((p) => p.status === 'ACTIVE');
  // An explicit "Historical memory" project, if the person made one; else the
  // project the person has used most recently. Never invented.
  const named = projects.find((p) => /historical memory|rediscover/i.test(p.name));
  if (named) return named.id;
  const recent = await getDb().get<{ project_id: string }>(
    `SELECT project_id FROM russell_conversations WHERE owner_user_id = ? AND project_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
    [ownerId],
  );
  return recent?.project_id ?? null;
}

export async function decide(input: {
  ownerId: string;
  ideaId: string;
  decision: MemoryDecision;
  feedback?: string | null;
  projectId?: string | null;
  wantedNow?: string | null;
}): Promise<DecisionResult> {
  const db = getDb();
  const idea = await db.get<IdeaRow>('SELECT * FROM memory_ideas WHERE id = ? AND owner_user_id = ?', [input.ideaId, input.ownerId]);
  if (!idea) throw new DecisionRefused('No such idea.');
  const feedback = input.feedback?.trim() ? input.feedback.trim().slice(0, 4000) : null;
  const at = nowIso();
  let state: IdeaState = idea.state;
  let ownerState: IdeaState | null = null;
  let created: DecisionResult['created'] = { kind: null, id: null, projectId: null };
  let ownerIntent = idea.owner_intent;
  let reconsider = parseJson<string[]>(idea.reconsider_when, []);
  let nextActions: string[] | null = null;

  const history = `Originally (${monthYear(idea.first_seen_at)}): ${idea.statement}\n\nWhat happened: ${idea.state_basis}`;

  switch (input.decision) {
    case 'EXPLORE':
    case 'PLAN': {
      ownerState = 'ACTIVE';
      const projectId = input.projectId ?? idea.project_id ?? (await defaultProjectFor(input.ownerId));
      if (projectId && !(await getProject(projectId))) throw new DecisionRefused('No such project.');
      nextActions = input.decision === 'PLAN' ? gamePlanFor(idea, feedback) : null;
      const statement = [
        input.decision === 'PLAN' ? 'Turn this rediscovered idea into a concrete game plan.' : 'Explore this rediscovered idea.',
        '',
        `Idea: ${ownerIntent ?? idea.title}`,
        history,
        feedback ? `\nInstruction from the owner: ${feedback}` : '',
        nextActions ? `\nDraft plan:\n${nextActions.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
      ].join('\n');
      if (!idea.candidate_id) {
        const candidate = await createCandidate({
          title: (ownerIntent ?? idea.title).slice(0, 200),
          statement,
          projectId,
          visibility: 'PRIVATE',
        });
        created = { kind: 'CANDIDATE', id: candidate.id, projectId };
        await db.run('UPDATE memory_ideas SET candidate_id = ?, project_id = COALESCE(project_id, ?) WHERE id = ?', [candidate.id, projectId, idea.id]);
        await linkIdeas(idea.id, 'CANDIDATE', candidate.id, 'PROMOTED_TO', `Owner chose ${input.decision}.`);
        if (projectId) {
          await recordEvent({
            projectId,
            entityType: 'russell_candidate',
            entityId: candidate.id,
            eventType: 'MEMORY_IDEA_PROMOTED',
            payload: { ideaId: idea.id, decision: input.decision },
          });
        }
      } else {
        created = { kind: 'CANDIDATE', id: idea.candidate_id, projectId: idea.project_id };
      }
      break;
    }
    case 'CREATE_SECTION': {
      ownerState = 'ACTIVE';
      let projectId = idea.project_id;
      if (!projectId || !(await getProject(projectId))) {
        const project = await createProject({
          name: (ownerIntent ?? idea.title).slice(0, 120),
          description: `Rediscovered from your conversation history.\n\n${history}`.slice(0, 4000),
          northStar: ownerIntent ?? idea.title,
        });
        projectId = project.id;
        await recordEvent({
          projectId,
          entityType: 'project',
          entityId: projectId,
          eventType: 'MEMORY_SECTION_CREATED',
          payload: { ideaId: idea.id },
        });
      }
      created = { kind: 'PROJECT', id: projectId, projectId };
      await db.run('UPDATE memory_ideas SET project_id = ? WHERE id = ?', [projectId, idea.id]);
      await linkIdeas(idea.id, 'PROJECT', projectId, 'PROMOTED_TO', 'Owner created a dedicated section.');
      break;
    }
    case 'LATER': {
      ownerState = idea.state === 'ACTIVE' ? 'PAUSED' : null;
      if (feedback) reconsider = [...reconsider, feedback].slice(-10);
      break;
    }
    case 'NOT_INTERESTED': {
      ownerState = 'REJECTED';
      break;
    }
    case 'UPDATE_WANT': {
      const wanted = input.wantedNow?.trim() || feedback;
      if (!wanted) throw new DecisionRefused('Say what you want from it now.');
      ownerIntent = wanted.slice(0, 2000);
      break;
    }
    case 'FEEDBACK': {
      if (!feedback) throw new DecisionRefused('Feedback cannot be empty.');
      break;
    }
  }
  if (ownerState) state = ownerState;

  const decisionId = newId('mdc');
  const discovery = await db.get<{ id: string }>(
    `SELECT id FROM memory_discoveries WHERE idea_id = ? AND state = 'OPEN'`,
    [idea.id],
  );
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO memory_decisions (id, owner_user_id, idea_id, discovery_id, decision, feedback, outcome_kind, outcome_ref, idea_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [decisionId, input.ownerId, idea.id, discovery?.id ?? null, input.decision, feedback, created.kind, created.id, idea.kind, at],
    );
    const version = idea.version + 1;
    await db.run(
      `UPDATE memory_ideas SET state = ?, owner_state = COALESCE(?, owner_state), owner_intent = ?, owner_feedback = COALESCE(?, owner_feedback),
         reconsider_when = ?, next_actions = COALESCE(?, next_actions), version = ?, updated_at = ?
       WHERE id = ?`,
      [state, ownerState, ownerIntent, feedback, toJson(reconsider), nextActions ? toJson(nextActions) : null, version, at, idea.id],
    );
    await db.run(
      `INSERT INTO memory_idea_versions (idea_id, version, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      [idea.id, version, toJson({ state, ownerIntent, decision: input.decision, feedback, created }), `You chose ${input.decision}.`, at],
    );
    if (discovery && input.decision !== 'FEEDBACK') {
      await db.run(
        `UPDATE memory_discoveries SET state = 'DECIDED', decided_at = ?, decision = ? WHERE id = ?`,
        [at, input.decision, discovery.id],
      );
    }
  });
  await recordMemoryEvent(input.ownerId, 'IDEA', idea.id, 'IDEA_DECIDED', { decision: input.decision, created: created.kind });
  return { decisionId, ideaId: idea.id, state, created };
}
