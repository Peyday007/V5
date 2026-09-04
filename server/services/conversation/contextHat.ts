/**
 * What Russell is holding in mind when it answers.
 *
 * Not fine-tuned weights — nobody is training a model here, and pretending
 * otherwise would be the kind of claim this platform exists to refuse. This is
 * the practical equivalent: a bounded, ordered, *authorized* assembly of the
 * things that bear on one question, compiled fresh for each turn.
 *
 * Three properties matter more than the content.
 *
 * **It is bounded.** A budget in characters, spent in priority order, with
 * whatever does not fit reported rather than silently dropped. Sending the
 * whole Brain on every turn is both expensive and worse: a model given
 * everything attends to nothing.
 *
 * **It is authorized.** Every source is read through a boundary that already
 * exists — the project gate for project material, the owner for a
 * conversation. There is no query here that reads more than the caller could
 * read for themselves, so the hat cannot become a way to see round a refusal.
 *
 * **It says what it left out.** `omitted` is part of the result, because a
 * grounded answer built on a truncated context is still a truncated answer,
 * and the reviewer in the teacher loop needs to know which.
 */
import { listTurns } from '../../repos/russellConversations.ts';
import { listCurrentKnowledge, listMissions, listOpenRequests } from '../../repos/russellMissions.ts';
import { knowsForProject } from '../russell/knows.ts';
import { projectProgress } from '../russell/progress.ts';
import type { RussellMessage } from '../../domain/types.ts';

/** The order things are packed in. Earlier survives a tight budget. */
export const HAT_SECTIONS = [
  'IDENTITY',
  'RECENT_MESSAGES',
  'PROJECT_STATE',
  'ACCEPTED_KNOWLEDGE',
  'OPEN_GAPS',
  'ACTIVE_WORK',
  'STANDING_INSTRUCTIONS',
] as const;
export type HatSection = (typeof HAT_SECTIONS)[number];

export interface HatPart {
  section: HatSection;
  text: string;
}

export interface ContextHat {
  /** The system text, assembled in section order. */
  system: string;
  /** The recent turns, as messages rather than as prose. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  parts: HatPart[];
  /** Sections that did not fit, named. Never silently dropped. */
  omitted: HatSection[];
  /** Characters used, so a caller can bound its own token estimate. */
  characters: number;
}

/**
 * Russell's voice and its limits, in one place.
 *
 * The prohibitions are stated to the model *and* enforced in code. Saying them
 * here does not make them true — a prompt is not a boundary — but a model that
 * has been told what it may not do produces fewer proposals the server has to
 * refuse, and the refusals stay where they belong.
 */
export const IDENTITY = [
  'You are Russell, the way a person talks to this Brain.',
  'Answer in plain words. Never use an internal name, an id, or a status enum.',
  'Say what is established, what is provisional, and what is unknown, and never blur them.',
  'If the archive already answers something, say so rather than proposing to research it again.',
  'You may discuss, connect, question, summarise and propose.',
  'You may not settle evidence, change what is recorded, widen anyone’s access,',
  'authorise spending, or do anything irreversible. Propose those; the server decides.',
].join('\n');

/**
 * How many characters roughly become one token.
 *
 * Deliberately conservative and named. The number is used to *reserve* money,
 * so being wrong in the cheap direction is the expensive mistake.
 */
export const CHARS_PER_TOKEN = 3.2;

export function estimateTokens(characters: number): number {
  return Math.ceil(characters / CHARS_PER_TOKEN);
}

/**
 * Compile one turn's context.
 *
 * `budgetCharacters` is the whole hat including the identity, so a caller
 * lowering it gets less context rather than a silently larger request.
 */
export async function compileHat(input: {
  conversationId: string;
  projectId: string | null;
  projectName: string | null;
  ownerUserId: string;
  budgetCharacters?: number;
  recentTurns?: number;
  standingInstructions?: string[];
}): Promise<ContextHat> {
  const budget = Math.max(2_000, input.budgetCharacters ?? 24_000);
  const parts: HatPart[] = [{ section: 'IDENTITY', text: IDENTITY }];
  const omitted: HatSection[] = [];

  const turns = await listTurns(input.conversationId, input.recentTurns ?? 20);
  const messages = turns
    .filter((turn): turn is RussellMessage => turn.role === 'USER' || turn.role === 'RUSSELL')
    .map((turn) => ({
      role: turn.role === 'USER' ? ('user' as const) : ('assistant' as const),
      content: turn.content,
    }));

  if (input.projectId) {
    const [progress, knowledge, gaps, missions, requests] = await Promise.all([
      projectProgress({
        projectId: input.projectId,
        projectName: input.projectName ?? 'this project',
      }),
      knowsForProject({ projectId: input.projectId, includePrivate: false, limit: 40 }),
      listCurrentKnowledge({
        projectId: input.projectId,
        kinds: ['GAP', 'UNKNOWN', 'CONTRADICTION'],
        includePrivate: false,
        limit: 10,
      }),
      listMissions({ projectId: input.projectId, limit: 20 }),
      listOpenRequests(input.projectId),
    ]);

    parts.push({
      section: 'PROJECT_STATE',
      text: [
        `Project: ${input.projectName ?? 'unnamed'}.`,
        progress.headline,
        progress.blockedBy.length > 0 ? `Blocked by: ${progress.blockedBy.join('; ')}.` : '',
        requests.length > 0
          ? `${requests.length} decision${requests.length === 1 ? '' : 's'} waiting for a person.`
          : 'No decision is waiting for a person.',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // Accepted first, and labelled. A provisional claim presented without its
    // status is the single thing this surface must never do.
    const accepted = knowledge.filter((entry) => entry.status === 'ACCEPTED').slice(0, 20);
    const provisional = knowledge.filter((entry) => entry.status !== 'ACCEPTED').slice(0, 10);
    if (accepted.length > 0 || provisional.length > 0) {
      parts.push({
        section: 'ACCEPTED_KNOWLEDGE',
        text: [
          ...accepted.map(
            (entry) =>
              `ESTABLISHED: ${entry.statement}` +
              (entry.provenance.sourceUrl ? ` [${entry.provenance.sourceUrl}]` : ''),
          ),
          ...provisional.map(
            (entry) =>
              `${entry.status}: ${entry.statement}` +
              (entry.missingEvidence.length > 0
                ? ` (still missing: ${entry.missingEvidence.join('; ')})`
                : ''),
          ),
        ].join('\n'),
      });
    }

    if (gaps.length > 0) {
      parts.push({
        section: 'OPEN_GAPS',
        text: gaps.map((gap) => `OPEN: ${gap.statement}`).join('\n'),
      });
    }

    const active = missions.filter(
      (mission) => mission.state === 'RUNNING' || mission.state === 'PLANNED',
    );
    if (active.length > 0) {
      parts.push({
        section: 'ACTIVE_WORK',
        text: active
          .slice(0, 10)
          .map((mission) => `${mission.state === 'RUNNING' ? 'NOW' : 'NEXT'}: ${mission.objective}`)
          .join('\n'),
      });
    }
  }

  if (input.standingInstructions && input.standingInstructions.length > 0) {
    parts.push({
      section: 'STANDING_INSTRUCTIONS',
      text: input.standingInstructions.map((rule) => `- ${rule}`).join('\n'),
    });
  }

  // Spend the budget in order. Identity is never dropped: an assistant with no
  // instructions is a different assistant.
  const kept: HatPart[] = [];
  let used = 0;
  for (const part of parts) {
    if (part.section !== 'IDENTITY' && used + part.text.length > budget) {
      omitted.push(part.section);
      continue;
    }
    kept.push(part);
    used += part.text.length;
  }

  return {
    system: kept.map((part) => part.text).join('\n\n'),
    messages,
    parts: kept,
    omitted,
    characters: used,
  };
}
