/**
 * The project chat (section 6).
 *
 * Deterministic, local and offline: intent is routed by rules, every answer is
 * assembled from tool output, and no provider is consulted. That is not a
 * limitation, it is the point — invariant 7 says the AI layer may never claim
 * project state from memory, and invariant 12 says no project state may depend
 * on one chat transcript. A turn therefore looks like:
 *
 *   persist USER -> route intent -> run tools against live SQLite + disk ->
 *   persist one TOOL message per call -> persist an ASSISTANT message built
 *   strictly out of what those tools returned.
 *
 * If a tool finds nothing, the answer is "there is no such document" — never a
 * recollection of something seen earlier in the conversation.
 */
import type {
  Conversation,
  LayerStatus,
  Message,
  PlannerItem,
  RunType,
} from '../../domain/types.ts';
import { extractVersionToken } from '../../domain/version.ts';
import {
  addMessage,
  getConversation,
  getOrCreateMainConversation,
  listMessages,
} from '../../repos/conversations.ts';
import { recordEvent } from '../../repos/events.ts';
import { getProject } from '../../repos/projects.ts';
import type {
  LayerStateData,
  NextActionData,
  ProjectStateData,
  RunsData,
  ToolName,
  ToolResult,
} from './tools.ts';
import { resolveLayerReference, runTool } from './tools.ts';

export interface ChatToolCall {
  name: ToolName;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface ChatTurnResult {
  conversationId: string;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls: ChatToolCall[];
}

type Intent =
  | 'NEXT_ACTION'
  | 'RUN_NEXT'
  | 'WHAT_IS_MISSING'
  | 'AUDIT_LAYER'
  | 'REDO'
  | 'FREEZE_LAYER'
  | 'COMPILE_PROMPT'
  | 'LAYER_STATUS'
  | 'LIST_DOCUMENTS'
  | 'LIST_RUNS'
  | 'RECONCILE'
  | 'ADD_FILE'
  | 'RUN_INTERRUPTED'
  | 'HELP';

interface Turn {
  projectId: string;
  content: string;
  lower: string;
  invoke(name: ToolName, args?: Record<string, unknown>): Promise<ToolResult>;
}

const CAPABILITIES = [
  'I answer only from the live database and the project folder — never from what was said earlier.',
  'Things I can do:',
  '  "What\'s next?"                                  the single next best action',
  '  "Run the next thing."                            create that run and hand you the prompt',
  '  "What is missing?"                               missing documents, broken packets, stray files',
  '  "Audit Discovery."                               prepare the audit run for a layer',
  '  "Redo v1G."                                      chain a corrected attempt to the failed one',
  '  "Freeze World Model."                            freeze a layer on its canonical artifact',
  '  "Generate the Qualification synthesis prompt."   compile and record a prompt to copy',
  '  "Status of Discovery Logic."                     one layer, in full',
  '  "List documents." / "List runs."                 what is actually registered',
  '  "Scan and reconcile."                            compare the folder against the database',
  '  "Add this PDF."                                  how to get a file into the platform',
  '  "Routing rate limit ran out."                    record that a run died, then re-plan',
].join('\n');

/** Run types that a plain "run the next thing" may create on its own. */
const RUN_TYPE_FOR_ACTION: Partial<Record<PlannerItem['actionType'], RunType>> = {
  RUN_FOUNDATION: 'FOUNDATION',
  RUN_EXPANSION: 'EXPANSION',
  RUN_AUDIT: 'AUDIT',
  RUN_SYNTHESIS: 'SYNTHESIS',
};

function importAffordance(projectSlug: string | null): string {
  const slug = projectSlug ?? '<project-slug>';
  return [
    'A chat message carries no attachment, so there is no PDF for me to read here.',
    'Two ways to get one in:',
    `  1. IMPORT in the left pane — drop the file, the platform stores the original, infers the`,
    '     layer and version from the filename, and asks you only when that is genuinely ambiguous.',
    `  2. Copy it into data/projects/${slug}/documents/<layer-folder>/ and then say`,
    '     "scan and reconcile", which registers what it finds.',
    'A file on disk is not a registered document until one of those happens.',
  ].join('\n');
}

/**
 * Rule-based intent routing. Ordered from the most specific utterance to the
 * most general, so "Redo v1G." never falls through to the generic "run" branch.
 */
function detectIntent(content: string): Intent {
  const lower = content.trim().toLowerCase();
  if (lower.length === 0) return 'HELP';

  const isQuestion =
    lower.endsWith('?') ||
    /^(what|which|why|how|who|when|where|is|are|do|does|did|can|could|should|show|list|tell)\b/.test(
      lower,
    );

  if (/^(help|what can you do|commands|options)\b/.test(lower)) return 'HELP';
  if (
    !isQuestion &&
    /(rate limit|ran out|run out|out of (tokens|credit|credits|context|quota)|quota|timed out|time ?out|crashed|died|cut off|stopped early|interrupted|errored|\bfailed\b)/.test(
      lower,
    )
  ) {
    return 'RUN_INTERRUPTED';
  }
  if (
    /\b(add|attach|upload|import|register)\b/.test(lower) &&
    /\b(pdf|file|document|doc|report|attachment)\b/.test(lower)
  ) {
    return 'ADD_FILE';
  }
  // A question is never a command. "Is World Model ready to freeze?" must report
  // readiness, not freeze the layer, and "What should I do next?" must not create
  // a run. Every intent below this line changes state, so a question falls
  // through to the read-only branches that answer it instead.
  if (!isQuestion && /\b(freeze|frozen)\b/.test(lower)) return 'FREEZE_LAYER';
  if (!isQuestion && /\b(redo|re-?run|retry)\b|\btry again\b/.test(lower)) return 'REDO';
  if (!isQuestion && /\bprompts?\b/.test(lower)) return 'COMPILE_PROMPT';
  if (!isQuestion && /\baudit(ed|ing)?\b/.test(lower)) return 'AUDIT_LAYER';
  if (/\b(scan|reconcile|re-?sync)\b/.test(lower)) return 'RECONCILE';
  if (/\b(missing|gap|gaps|incomplete|outstanding|blocked|blocking)\b/.test(lower)) {
    return 'WHAT_IS_MISSING';
  }
  if (!isQuestion && /\b(run|do|start|execute|begin|kick off)\b[^.?!]*\bnext\b/.test(lower)) return 'RUN_NEXT';
  if (/\bnext\b|what should i do|where (am i|are we)|what now/.test(lower)) return 'NEXT_ACTION';
  if (/\bruns?\b|\battempts?\b/.test(lower) && /\b(list|show|which|what|any|open|active)\b/.test(lower)) {
    return 'LIST_RUNS';
  }
  if (
    /\b(documents?|files?|reports?)\b/.test(lower) &&
    /\b(list|show|which|what|have|has|got|exist|exists)\b/.test(lower)
  ) {
    return 'LIST_DOCUMENTS';
  }
  if (/\b(status|state|how is|how'?s|where is|tell me about|show me)\b/.test(lower)) {
    return 'LAYER_STATUS';
  }
  // A question we suppressed above still deserves the layer's real state as its answer.
  if (isQuestion && /\b(freeze|frozen|redo|audit(ed|ing)?|prompts?)\b/.test(lower)) {
    return 'LAYER_STATUS';
  }
  return 'HELP';
}

async function layerArgs(projectId: string, content: string): Promise<{ layerId: string } | null> {
  const layer = await resolveLayerReference(projectId, content);
  return layer ? { layerId: layer.id } : null;
}

async function unknownLayerBlocks(turn: Turn, verb: string): Promise<string[]> {
  const state = await turn.invoke('get_project_state');
  return [
    `I could not tell which layer you meant, so I did not ${verb} anything. Name one of the layers below.`,
    state.text,
  ];
}

// ---------------------------------------------------------------------------
// Intent handlers — each returns the blocks the assistant message is built from
// ---------------------------------------------------------------------------

async function handleNextAction(turn: Turn): Promise<string[]> {
  return [(await turn.invoke('calculate_next_action')).text];
}

async function handleRunNext(turn: Turn): Promise<string[]> {
  const next = await turn.invoke('calculate_next_action');
  const blocks = [next.text];
  const item = (next.data as NextActionData | null)?.nextBestAction ?? null;
  if (!item) {
    blocks.push('There is nothing startable right now, so I created no run.');
    return blocks;
  }

  const runType = RUN_TYPE_FOR_ACTION[item.actionType];
  if (runType) {
    blocks.push(
      (await turn.invoke('create_run', {
        layerId: item.layerId,
        runType,
        targetVersion: item.targetVersion,
      })).text,
    );
    return blocks;
  }

  switch (item.actionType) {
    case 'RUN_REDO':
      blocks.push(
        (await turn.invoke('create_redo', {
          layerId: item.layerId,
          reason: 'Redo started from chat: "run the next thing".',
        })).text,
      );
      break;
    case 'FREEZE_LAYER':
      blocks.push((await turn.invoke('get_layer_state', { layerId: item.layerId })).text);
      blocks.push(
        `Freezing is an explicit act, so I stopped short of it. Say "Freeze ${item.layerName}." and I will.`,
      );
      break;
    case 'IMPORT_DOCUMENT':
      blocks.push(importAffordance(null));
      blocks.push((await turn.invoke('scan_and_reconcile')).text);
      break;
    case 'RECONCILE':
      blocks.push((await turn.invoke('scan_and_reconcile')).text);
      break;
    case 'RESOLVE_DEPENDENCY':
      blocks.push(
        (await turn.invoke(
          'resolve_dependencies',
          item.missing.length > 0 ? { canonicalNames: item.missing } : { layerId: item.layerId },
        )).text,
      );
      break;
    default:
      blocks.push('That is not something I can start on my own — it needs you.');
      break;
  }
  return blocks;
}

async function handleWhatIsMissing(turn: Turn): Promise<string[]> {
  return [
    (await turn.invoke('get_project_state')).text,
    (await turn.invoke('resolve_dependencies')).text,
    (await turn.invoke('scan_and_reconcile')).text,
    (await turn.invoke('calculate_next_action')).text,
  ];
}

async function handleAuditLayer(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  if (!target) return unknownLayerBlocks(turn, 'audit');
  return [
    (await turn.invoke('get_layer_state', target)).text,
    (await turn.invoke('create_run', { ...target, runType: 'AUDIT' })).text,
  ];
}

async function handleRedo(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  const version = extractVersionToken(turn.content);
  const redo = await turn.invoke('create_redo', {
    ...(target ?? {}),
    ...(version ? { version } : {}),
    reason: `Redo requested in chat: ${JSON.stringify(turn.content)}`,
  });
  const blocks = [redo.text];
  if (!redo.ok) {
    blocks.push((await turn.invoke('list_runs', { ...(target ?? {}), limit: 10 })).text);
    if (version) {
      blocks.push((await turn.invoke('find_document', { ...(target ?? {}), version })).text);
    }
  }
  return blocks;
}

async function handleFreeze(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  if (!target) return unknownLayerBlocks(turn, 'freeze');
  const state = await turn.invoke('get_layer_state', target);
  const frozen = await turn.invoke('mark_layer_frozen', target);
  return frozen.ok ? [frozen.text] : [frozen.text, state.text];
}

/** Which run type a "generate the … prompt" request means for this layer now. */
function runTypeFromText(lower: string): RunType | null {
  if (/\bsynthes/.test(lower)) return 'SYNTHESIS';
  if (/\baudit/.test(lower)) return 'AUDIT';
  if (/\bexpansion|sibling\b/.test(lower)) return 'EXPANSION';
  if (/\bfoundation\b/.test(lower)) return 'FOUNDATION';
  if (/\bpatch\b/.test(lower)) return 'PATCH';
  return null;
}

function runTypeForStatus(status: LayerStatus): RunType {
  switch (status) {
    case 'SYNTHESIS_READY':
      return 'SYNTHESIS';
    case 'AUDIT_READY':
    case 'AUDITING':
      return 'AUDIT';
    case 'NOT_STARTED':
      return 'FOUNDATION';
    default:
      return 'EXPANSION';
  }
}

async function handleCompilePrompt(turn: Turn): Promise<string[]> {
  if (/\bredo\b/.test(turn.lower)) return handleRedo(turn);
  const target = await layerArgs(turn.projectId, turn.content);
  if (!target) return unknownLayerBlocks(turn, 'compile a prompt for');

  const state = await turn.invoke('get_layer_state', target);
  const snapshot = (state.data as LayerStateData | null)?.snapshot ?? null;
  const runType =
    runTypeFromText(turn.lower) ?? (snapshot ? runTypeForStatus(snapshot.status) : 'EXPANSION');
  return [state.text, (await turn.invoke('create_run', { ...target, runType })).text];
}

async function handleLayerStatus(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  // get_layer_state already lists the layer's documents, so one call answers this.
  if (!target) return [(await turn.invoke('get_project_state')).text];
  return [(await turn.invoke('get_layer_state', target)).text];
}

async function handleListDocuments(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  return [(await turn.invoke('list_documents', target ?? {})).text];
}

async function handleListRuns(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  return [(await turn.invoke('list_runs', { ...(target ?? {}), limit: 15 })).text];
}

async function handleReconcile(turn: Turn): Promise<string[]> {
  return [(await turn.invoke('scan_and_reconcile')).text, (await turn.invoke('calculate_next_action')).text];
}

async function handleAddFile(turn: Turn): Promise<string[]> {
  const state = await turn.invoke('get_project_state');
  const slug = (state.data as ProjectStateData | null)?.project.slug ?? null;
  return [importAffordance(slug), (await turn.invoke('scan_and_reconcile')).text];
}

async function handleRunInterrupted(turn: Turn): Promise<string[]> {
  const target = await layerArgs(turn.projectId, turn.content);
  const runs = await turn.invoke('list_runs', { ...(target ?? {}), limit: 10 });
  const blocks = [runs.text];
  const candidates = (runs.data as RunsData | null)?.runs.filter((run) => run.active) ?? [];

  // "Rate limit ran out" marks a run FAILED. Without a layer to scope it, the
  // newest open run in the WHOLE project would be chosen — quite possibly one
  // the user was not talking about. Ask instead, the way every other
  // state-changing handler refuses an unresolved reference.
  if (!target && candidates.length > 1) {
    blocks.push(
      `There are ${candidates.length} open runs and you did not say which layer, so I marked ` +
        'nothing as failed. Name the layer — for example "Discovery rate limit ran out."',
    );
    blocks.push((await turn.invoke('calculate_next_action')).text);
    return blocks;
  }

  const open = candidates[0] ?? null;

  if (open) {
    blocks.push(
      (await turn.invoke('update_run', {
        runId: open.id,
        status: 'FAILED',
        failureReason: `Reported in chat: ${JSON.stringify(turn.content)}`,
      })).text,
    );
    blocks.push(
      'The attempt is kept as history — a redo will be chained to it rather than replacing it.',
    );
  } else {
    blocks.push(
      'No open run is recorded in that scope, so I marked nothing as failed. If the work happened ' +
        'outside the platform, create the run (or import the report) first.',
    );
  }
  blocks.push((await turn.invoke('calculate_next_action')).text);
  return blocks;
}

async function handleHelp(turn: Turn): Promise<string[]> {
  return [
    'I did not recognise that as an instruction, so I did not change anything.',
    CAPABILITIES,
    (await turn.invoke('calculate_next_action')).text,
  ];
}

function route(intent: Intent, turn: Turn): Promise<string[]> {
  switch (intent) {
    case 'NEXT_ACTION':
      return handleNextAction(turn);
    case 'RUN_NEXT':
      return handleRunNext(turn);
    case 'WHAT_IS_MISSING':
      return handleWhatIsMissing(turn);
    case 'AUDIT_LAYER':
      return handleAuditLayer(turn);
    case 'REDO':
      return handleRedo(turn);
    case 'FREEZE_LAYER':
      return handleFreeze(turn);
    case 'COMPILE_PROMPT':
      return handleCompilePrompt(turn);
    case 'LAYER_STATUS':
      return handleLayerStatus(turn);
    case 'LIST_DOCUMENTS':
      return handleListDocuments(turn);
    case 'LIST_RUNS':
      return handleListRuns(turn);
    case 'RECONCILE':
      return handleReconcile(turn);
    case 'ADD_FILE':
      return handleAddFile(turn);
    case 'RUN_INTERRUPTED':
      return handleRunInterrupted(turn);
    case 'HELP':
    default:
      return handleHelp(turn);
  }
}

/** The project's main chat, or the named conversation when it belongs here. */
async function resolveConversation(projectId: string, conversationId?: string | null): Promise<Conversation> {
  if (conversationId) {
    const existing = await getConversation(conversationId);
    if (existing && existing.projectId === projectId) return existing;
  }
  return getOrCreateMainConversation(projectId);
}

/**
 * Handle one chat turn. Everything it persists — the user message, one TOOL
 * message per call with its arguments and raw data, and the assistant message —
 * lives in the local database, so the transcript is a record of what was done
 * rather than the place the truth is kept.
 */
export async function handleChatMessage(input: {
  projectId: string;
  content: string;
  conversationId?: string | null;
}): Promise<ChatTurnResult> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error(`Cannot handle a chat message: unknown project ${input.projectId}`);

  const conversation = await resolveConversation(project.id, input.conversationId ?? null);
  const content = input.content ?? '';
  const intent = detectIntent(content);

  const userMessage = await addMessage({
    conversationId: conversation.id,
    role: 'USER',
    content,
    metadata: { intent },
  });

  const toolCalls: ChatToolCall[] = [];
  const turn: Turn = {
    projectId: project.id,
    content,
    lower: content.trim().toLowerCase(),
    async invoke(name, args = {}) {
      const result = await runTool(name, { projectId: project.id }, args);
      toolCalls.push({ name, args, result });
      await addMessage({
        conversationId: conversation.id,
        role: 'TOOL',
        content: result.text,
        // Both keys: the transcript is read by the UI as well as by tests.
        metadata: { tool: name, name, args, ok: result.ok, data: result.data },
      });
      return result;
    },
  };

  const blocks = (await route(intent, turn)).filter((block) => block.trim().length > 0);
  // Provenance line: every claim above is traceable to a query made in this turn.
  const footer =
    toolCalls.length > 0
      ? `— answered from ${toolCalls.length} live tool call${toolCalls.length === 1 ? '' : 's'}: ` +
        `${[...new Set(toolCalls.map((call) => call.name))].join(', ')}.`
      : '— nothing was read or changed.';

  const assistantMessage = await addMessage({
    conversationId: conversation.id,
    role: 'ASSISTANT',
    content: [...blocks, footer].join('\n\n'),
    metadata: {
      intent,
      tools: toolCalls.map((call) => call.name),
      allToolsOk: toolCalls.every((call) => call.result.ok),
    },
  });

  await recordEvent({
    projectId: project.id,
    entityType: 'CONVERSATION',
    entityId: conversation.id,
    eventType: 'CHAT_ACTION',
    payload: {
      intent,
      message: content,
      tools: toolCalls.map((call) => ({ name: call.name, ok: call.result.ok })),
    },
  });

  return {
    conversationId: conversation.id,
    userMessage,
    assistantMessage,
    toolCalls,
  };
}

/** The transcript for the project's main chat (or one named conversation). */
export async function getChatHistory(
  projectId: string,
  conversationId?: string | null,
): Promise<{ conversation: Conversation; messages: Message[] }> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Cannot load chat history: unknown project ${projectId}`);
  const conversation = await resolveConversation(project.id, conversationId ?? null);
  return { conversation, messages: await listMessages(conversation.id) };
}
