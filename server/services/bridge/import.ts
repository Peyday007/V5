/**
 * Reading a pasted or exported conversation.
 *
 * Two shapes, both of which somebody actually has to hand, and nothing that
 * tries to be clever about a third:
 *
 *   * **A ChatGPT export.** `conversations.json` from *Settings → Data
 *     controls → Export data*: an array of conversations, each with a `mapping`
 *     of message nodes linked by `parent`. The order is the **chain**, not the
 *     object order, so it is walked from the root rather than read off the map
 *     — a map's own key order is not an order and reading it as one would put
 *     a conversation in an arbitrary sequence that looks plausible.
 *   * **Pasted text.** Lines beginning `You:` / `ChatGPT:` / `Assistant:` /
 *     `Me:`, which is what a person gets from selecting a conversation and
 *     copying it. Everything up to the next marker belongs to the turn it
 *     started, so a multi-paragraph answer stays one turn.
 *
 * What it refuses to do is guess. A paste with no markers at all is **one**
 * message of role `UNKNOWN` rather than a transcript this module invented
 * speakers for, and the caller is told which reading happened. §11's rule that
 * a filename is a hint and only the contents are understanding, applied to the
 * shape of a file rather than its name.
 *
 * Nothing here is executed and nothing here is trusted. It produces
 * `IncomingMessage[]` and the sync path treats them exactly as it treats a live
 * client's — which is the point: an import is not a second entrance with its
 * own rules.
 */
import type { BridgeRole } from '../../domain/register.ts';
import type { IncomingMessage } from './sync.ts';

export interface ParsedTranscript {
  title: string;
  messages: IncomingMessage[];
  /** Which reading produced this, so a caller can say so rather than assume. */
  format: 'CHATGPT_EXPORT' | 'MARKED_TEXT' | 'SINGLE_BLOCK';
  /** External conversation id when the source carried one; null otherwise. */
  externalId: string | null;
  /** Anything worth telling the person about what could not be read. */
  notes: string[];
}

/** The speaker markers a person's paste actually carries. */
const MARKERS: { pattern: RegExp; role: BridgeRole; label: string }[] = [
  { pattern: /^(?:you|me)\s*:/i, role: 'USER', label: 'You' },
  { pattern: /^(?:chatgpt|assistant|gpt|claude)\s*:/i, role: 'ASSISTANT', label: 'Assistant' },
  { pattern: /^system\s*:/i, role: 'SYSTEM', label: 'System' },
];

function roleOf(line: string): { role: BridgeRole; label: string } | null {
  for (const marker of MARKERS) {
    if (marker.pattern.test(line.trimStart())) return { role: marker.role, label: marker.label };
  }
  return null;
}

/**
 * Parse whatever was handed over.
 *
 * Tries the structured reading first, because a JSON export that fell through
 * to the text reader would be stored as one enormous message of unknown role —
 * technically exact and completely useless.
 */
export function parseTranscript(input: { body: string; title?: string }): ParsedTranscript {
  const structured = tryChatGptExport(input.body);
  if (structured) return structured;
  return parseMarkedText(input.body, input.title);
}

interface ExportNode {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: {
    author?: { role?: unknown; name?: unknown };
    content?: { parts?: unknown; content_type?: unknown };
    create_time?: unknown;
  } | null;
}

function tryChatGptExport(body: string): ParsedTranscript | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  // The export is an array of conversations; a single conversation copied out
  // of it is the same object on its own. Both are accepted.
  const conversation = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!conversation || typeof conversation !== 'object') return null;
  const record = conversation as Record<string, unknown>;
  const mapping = record.mapping;
  if (!mapping || typeof mapping !== 'object') return null;

  const nodes = mapping as Record<string, ExportNode>;
  const notes: string[] = [];

  /*
   * Walk the chain from the root.
   *
   * A ChatGPT conversation is a tree — a regenerated answer is a sibling — and
   * the thing a person actually read is one path through it. This takes the
   * **last** child at each step, which is the branch the client shows, and says
   * in a note when a branch was left behind. Reporting that is the honest half:
   * §11 already requires an ambiguous branch to be visible rather than resolved
   * silently.
   */
  const root = Object.values(nodes).find((node) => node.parent == null);
  if (!root) return null;

  const messages: IncomingMessage[] = [];
  let ordinal = 0;
  let current: ExportNode | undefined = root;
  const guard = new Set<string>();

  while (current) {
    const id = typeof current.id === 'string' ? current.id : null;
    if (id) {
      if (guard.has(id)) {
        notes.push('The export loops back on itself; the walk stopped where it repeated.');
        break;
      }
      guard.add(id);
    }

    const message = current.message;
    if (message && message.author && Array.isArray(message.content?.parts)) {
      const parts = (message.content?.parts ?? []).filter(
        (part): part is string => typeof part === 'string',
      );
      const content = parts.join('\n');
      if (content.trim()) {
        messages.push({
          ordinal,
          role: normaliseRole(message.author.role),
          content,
          externalId: id,
          authorLabel: typeof message.author.name === 'string' ? message.author.name : null,
          saidAt:
            typeof message.create_time === 'number'
              ? new Date(message.create_time * 1000).toISOString()
              : null,
        });
        ordinal += 1;
      }
    }

    const children: unknown[] = Array.isArray(current.children) ? current.children : [];
    if (children.length > 1) {
      notes.push(
        `Position ${ordinal} had ${children.length} branches in the export; the last one was followed and the rest were not read.`,
      );
    }
    const nextId: unknown = children[children.length - 1];
    current = typeof nextId === 'string' ? nodes[nextId] : undefined;
  }

  if (messages.length === 0) return null;

  return {
    title: typeof record.title === 'string' && record.title.trim() ? record.title : 'Imported conversation',
    messages,
    format: 'CHATGPT_EXPORT',
    externalId:
      typeof record.conversation_id === 'string'
        ? record.conversation_id
        : typeof record.id === 'string'
          ? record.id
          : null,
    notes,
  };
}

function normaliseRole(role: unknown): BridgeRole {
  const text = typeof role === 'string' ? role.toLowerCase() : '';
  if (text === 'user') return 'USER';
  if (text === 'assistant') return 'ASSISTANT';
  if (text === 'system') return 'SYSTEM';
  if (text === 'tool') return 'TOOL';
  return 'UNKNOWN';
}

export function parseMarkedText(body: string, title?: string): ParsedTranscript {
  const lines = body.split(/\r?\n/);
  const messages: IncomingMessage[] = [];
  let role: BridgeRole | null = null;
  let label: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (role === null) return;
    const content = buffer.join('\n').trim();
    if (content) {
      messages.push({ ordinal: messages.length, role, content, authorLabel: label });
    }
    buffer = [];
  };

  for (const line of lines) {
    const marker = roleOf(line);
    if (marker) {
      flush();
      role = marker.role;
      label = marker.label;
      // Everything after the colon on the marker line is the start of the turn.
      buffer = [line.slice(line.indexOf(':') + 1).trimStart()];
      continue;
    }
    if (role !== null) buffer.push(line);
  }
  flush();

  if (messages.length === 0) {
    /*
     * No markers anywhere. This is a person pasting something rather than a
     * transcript, and inventing speakers for it would be making up who said
     * what. One message, role UNKNOWN, and the caller is told which reading
     * happened so it can say so.
     */
    const content = body.trim();
    return {
      title: title?.trim() || 'Pasted note',
      messages: content ? [{ ordinal: 0, role: 'UNKNOWN', content }] : [],
      format: 'SINGLE_BLOCK',
      externalId: null,
      notes: content
        ? ['No speaker markers were found, so this was kept whole as one passage rather than split.']
        : ['There was nothing in it.'],
    };
  }

  return {
    title: title?.trim() || firstLineTitle(messages[0]?.content ?? ''),
    messages,
    format: 'MARKED_TEXT',
    externalId: null,
    notes: [],
  };
}

function firstLineTitle(content: string): string {
  const line = content.split('\n')[0]?.trim() ?? '';
  if (!line) return 'Imported conversation';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
