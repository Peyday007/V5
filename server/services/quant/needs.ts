/**
 * Sending a causal graph's decision-critical unknowns to the owners that act on
 * them (CAUSAL-14-4: "send decision-critical unknowns to targeted research or
 * authorized action").
 *
 * The graph names its needs (`routes/causal.ts` derives them from the model);
 * this hands each one to an owner that already exists, so there is no queue,
 * scheduler or store of its own (§10.3):
 *
 *   - A RESEARCH need, when the request names a research orchestration of the
 *     same project, opens a `research_uncertainties` row on it through
 *     `openUncertainty` — the question the research director ranks and plans
 *     fragments for (§40). Consumed by a CALCULATION: the graph's figure.
 *   - A RESEARCH need with no orchestration named still goes to research: it is
 *     recorded through `raiseNeed` (keyed EVIDENCE:<key>, so its answer is found
 *     by the need it settles) and opened as an idea through `createCandidate`,
 *     pointed at by `setNeedCandidate` — the same research entrance
 *     `requestMarketHistory` uses, which Russell judges and the research path
 *     runs (§24). Research work is never left in a person's review queue
 *     (§41, §44): a need without its idea is reported as not sent.
 *   - Every AUTHORIZED_ACTION need is raised through `raiseNeed` as a
 *     `cash_needs` row — the review a person already reads, carrying the
 *     recommended way forward, the next step and what would settle it. An
 *     action's need is keyed on the AUTHORITY it lacks, so one grant is found
 *     with one indexed read across every need it blocks.
 *
 * Both writes are idempotent by a key built from the graph's own identity and
 * the need's subject — never from anything else the caller sent (invariant 27)
 * — so asking the same graph the same question twice sends nothing new, and the
 * answer says so. A refusal from an owner is returned as `sent: false` with its
 * reason, never dropped and never reported as sent.
 */
import { createHash } from 'node:crypto';
import { getOrchestration } from '../../repos/research.ts';
import { openUncertainty } from '../../repos/researchIntelligence.ts';
import { raiseNeed } from '../cash/needs.ts';
import { getNeed, replaceNeedCandidate, setNeedCandidate } from '../../repos/cashPortfolio.ts';
import { createCandidate, getCandidate } from '../../repos/russellCandidates.ts';
import { getDb } from '../../db/database.ts';

export interface Need {
  /** What is missing, in the graph's own words. */
  subject: string;
  /** The targeted question that would settle it. */
  question: string;
  /** Information is learned; an action needs authority a person or a grant holds. */
  route: 'RESEARCH' | 'AUTHORIZED_ACTION';
  /** For an action: the permissions its owner must hold. */
  permissions: string[];
}

export type NeedDelivery =
  | {
      subject: string;
      sent: true;
      /** Which existing owner now holds it. */
      to: 'RESEARCH_UNCERTAINTY' | 'RESEARCH_CANDIDATE' | 'REVIEW_NEED';
      /** The row it is: an uncertainty id, a research idea (candidate) id, or a need id. */
      ref: string;
      /** For a RESEARCH_CANDIDATE: the need the idea's answer settles. */
      needId?: string;
      /** False when the same need was already sent and is still open: nothing new was written. */
      created: boolean;
    }
  | { subject: string; sent: false; reason: string };

export interface SendNeedsInput {
  projectId: string;
  /** The person on whose request the graph was read; the need is recorded against them. */
  actorRef: string;
  /** The graph's identity: its stored key when it has one, otherwise its subject. */
  graphScope: string;
  needs: readonly Need[];
  /** A research orchestration of this project that a RESEARCH need should be asked on. */
  orchestrationId?: string | null;
  /**
   * The request key's prefix (`needKeyOf`); `causal` unless the caller's needs
   * are a class another selector must recognise by their key, such as a goal's
   * own price questions (`GOAL_PRICE_KEY_PREFIX`, `goalIdeaSql`).
   */
  keyPrefix?: string;
}

export interface SendNeedsDeps {
  getOrchestration?: typeof getOrchestration;
  openUncertainty?: typeof openUncertainty;
  raiseNeed?: typeof raiseNeed;
  createCandidate?: typeof createCandidate;
  setNeedCandidate?: typeof setNeedCandidate;
  replaceNeedCandidate?: typeof replaceNeedCandidate;
  getCandidate?: typeof getCandidate;
}

/** An idea in one of these states will not answer its need: parked or refused, it never launches again. */
const ENDED_UNANSWERED = new Set(['PARKED', 'REJECTED']);

/** How many ideas one need may be asked through before it is left for a person to read. */
const MAX_ASKS = 3;

/** How many ideas this project has opened under this need's title: the asks so far. */
async function askedTimes(projectId: string, title: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ? AND title = ?',
    [projectId, title],
  );
  return Number(row?.n ?? 0);
}

/** Thrown when a named orchestration is absent or another project's: the two are one refusal (invariant 23). */
export class UnknownOrchestrationError extends Error {
  constructor() {
    super('No such research orchestration.');
  }
}

/** The idea a need already points at, read back after another request attached it first. */
async function readNeedCandidate(needId: string): Promise<string | null> {
  const need = await getNeed(needId);
  return need?.candidateId ?? null;
}

/** The longest research statement an idea is opened with. */
const STATEMENT_MAX = 4000;

/** How `raiseNeed` says it read an open need back instead of writing one. */
const ALREADY_RAISED = 'This need was already raised';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** A key that is the same for the same need of the same graph, and fits every owner's key rules. */
export function needKeyOf(graphScope: string, need: Need, prefix = 'causal'): string {
  return `${prefix}-${digest(`${graphScope}\u0000${need.route}\u0000${need.subject}`)}`;
}

/** A permission as a blocker-key argument: the characters the key grammar allows, nothing else. */
function authorityArgument(permission: string): string {
  const cleaned = permission.trim().replace(/[^A-Za-z0-9_.:@/+-]/g, '_').slice(0, 200);
  return cleaned || 'unnamed';
}

function permissionsOf(need: Need): string[] {
  return need.permissions.filter((one) => one.trim() && one.trim().toLowerCase() !== 'none');
}

/**
 * Hand every need to its owner and say, per need, what happened. Throws only
 * `UnknownOrchestrationError`; an owner's refusal is a `sent: false` entry.
 */
export async function sendNeeds(input: SendNeedsInput, deps: SendNeedsDeps = {}): Promise<NeedDelivery[]> {
  const read = deps.getOrchestration ?? getOrchestration;
  const open = deps.openUncertainty ?? openUncertainty;
  const raise = deps.raiseNeed ?? raiseNeed;
  const propose = deps.createCandidate ?? createCandidate;
  const attach = deps.setNeedCandidate ?? setNeedCandidate;
  const replace = deps.replaceNeedCandidate ?? replaceNeedCandidate;
  const readCandidate = deps.getCandidate ?? getCandidate;

  let orchestrationId: string | null = null;
  if (input.orchestrationId) {
    const orchestration = await read(input.orchestrationId);
    if (!orchestration || orchestration.projectId !== input.projectId) throw new UnknownOrchestrationError();
    orchestrationId = orchestration.id;
  }

  const out: NeedDelivery[] = [];
  const seen = new Set<string>();
  for (const need of input.needs) {
    const key = needKeyOf(input.graphScope, need, input.keyPrefix);
    if (seen.has(key)) continue;
    seen.add(key);

    if (need.route === 'RESEARCH' && orchestrationId) {
      const { uncertainty, created } = await open({
        orchestrationId,
        projectId: input.projectId,
        uncertaintyKey: key,
        question: need.question,
        whyItMatters: `The causal graph ${input.graphScope} cannot state ${need.subject}; every answer that rests on it stays unknown until it is evidenced.`,
        consumerKind: 'CALCULATION',
        consumerRef: `causal:${input.graphScope}`,
        beliefBasis: 'UNKNOWN',
        stoppingCondition: `A sourced figure for ${need.subject} (VERIFIED, or an ESTIMATE with its basis) replaces the unknown in graph ${input.graphScope}.`,
        origin: 'COVERAGE_GAP',
        originRef: `causal:${input.graphScope}`,
      });
      out.push({ subject: need.subject, sent: true, to: 'RESEARCH_UNCERTAINTY', ref: uncertainty.id, created });
      continue;
    }

    const action = need.route === 'AUTHORIZED_ACTION';
    const permissions = permissionsOf(need);
    const result = await raise({
      projectId: input.projectId,
      actorRef: input.actorRef,
      blockedAction: action
        ? `${need.subject} in causal graph ${input.graphScope}: ${need.question}`
        : `Every answer in causal graph ${input.graphScope} that rests on ${need.subject}`,
      whyItMatters: action
        ? `The graph's plan includes this action, and it cannot be performed without ${permissions.join(', ') || 'a grant nobody has named'}.`
        : `The graph cannot state ${need.subject}, so what rests on it stays unknown rather than guessed.`,
      recommendedPath: action
        ? `Grant ${permissions.join(', ') || 'the named permission'} to the action's actor, or change the plan so the action is not needed.`
        : `Targeted research: ${need.question}`,
      setupEffort: action ? 'a decision by whoever holds the authority' : 'one targeted research question',
      nextStep: action
        ? `Decide whether to grant ${permissions.join(', ') || 'the permission'}, and record the grant or the refusal.`
        : `Research is open on this question as an idea; its sourced answer settles the need: ${need.question}`,
      completionCondition: action
        ? `The actor holds ${permissions.join(', ') || 'the permission'}, or the action is removed from graph ${input.graphScope}.`
        : `A sourced figure for ${need.subject} replaces the unknown in graph ${input.graphScope}.`,
      requestKey: key,
      blockerKey: action ? `AUTHORITY:${authorityArgument(permissions[0] ?? 'unnamed')}` : `EVIDENCE:${key}`,
    });
    if (!result.ok) {
      out.push({ subject: need.subject, sent: false, reason: result.reason });
      continue;
    }
    // `raiseNeed` reads an open need under the same key back rather than raising it again, and says so.
    const raisedNow = !result.message.startsWith(ALREADY_RAISED);
    if (action) {
      out.push({ subject: need.subject, sent: true, to: 'REVIEW_NEED', ref: result.value.id, created: raisedNow });
      continue;
    }
    // Research is opened, not left for a person to open: the need is pointed at an idea the research path runs.
    let candidateId = result.value.candidateId ?? null;
    let opened = false;
    const title = `Causal unknown: ${need.subject}`.slice(0, 200);
    // Room for a construction's own price question (`nextInputQuestion`, ~1,800 characters with its filing
    // instructions) and its scope: cut at 2,000, the instructions that make its answer file were lost.
    const statement = `For causal graph ${input.graphScope}, establish from sourced evidence: ${need.question}`.slice(0, STATEMENT_MAX);
    /*
     * An OPEN need whose idea ended without an answer is asked again, a bounded number of times.
     *
     * Production 2026-11-20 03:10-03:27Z: goal price questions planned before #1162 were refused
     * by the envelope screen ("instructs the researcher to purchase"), parked for a person and
     * CANCELLED, and their ideas PARKED - 11 of goal A's and 7 of goal B's. The need stayed OPEN
     * pointing at a parked idea, `setNeedCandidate` will never re-point it, and the next read only
     * read it back: the price that plan was waiting on could never be asked again. The old idea
     * keeps its row and missions (`replaceNeedCandidate`), so what was asked first stays readable.
     */
    if (candidateId) {
      const current = await readCandidate(candidateId);
      if (current && ENDED_UNANSWERED.has(current.state) && (await askedTimes(input.projectId, title)) < MAX_ASKS) {
        const fresh = await propose({ projectId: input.projectId, title, statement });
        if (await replace(result.value.id, candidateId, fresh.id)) {
          candidateId = fresh.id;
          opened = true;
        }
      }
    }
    if (!candidateId) {
      const candidate = await propose({ projectId: input.projectId, title, statement });
      if (await attach(result.value.id, candidate.id)) {
        candidateId = candidate.id;
        opened = true;
      } else {
        // Another request pointed the need first; its idea stands and this one is not attached.
        candidateId = (await readNeedCandidate(result.value.id)) ?? null;
      }
    }
    if (!candidateId) {
      out.push({ subject: need.subject, sent: false, reason: `The research idea for ${need.subject} could not be attached to its need.` });
      continue;
    }
    out.push({ subject: need.subject, sent: true, to: 'RESEARCH_CANDIDATE', ref: candidateId, needId: result.value.id, created: raisedNow || opened });
  }
  return out;
}
