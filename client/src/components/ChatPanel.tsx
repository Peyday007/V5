/**
 * The project chat, docked under the planner.
 *
 * The point of this panel is not conversation, it is provenance: every answer is
 * assembled by the server from tool calls made against live SQLite and the
 * filesystem, so each assistant turn renders the calls behind it in a collapsed
 * list. A claim with no tool call under it is a claim the user should not trust,
 * and this layout makes that visible (invariants 7 and 12).
 *
 * The transcript is re-read from the server after every turn rather than
 * appended to locally — the database is the record of what happened, and the
 * panel is only a view of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Conversation, Message, MessageRole } from '../../../server/domain/types.ts';
import { Api, ApiError } from '../lib/api.ts';

/** One-tap versions of the questions the router understands best. */
const SUGGESTIONS: readonly string[] = [
  "What's next?",
  'What is missing?',
  'List documents',
  'Scan and reconcile',
];

const TOOL_LINE_LIMIT = 160;

interface ToolCallView {
  key: string;
  name: string;
  ok: boolean;
  args: string;
  line: string;
  full: string;
}

interface TurnView {
  key: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  tools: ToolCallView[];
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status > 0 ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** `{ layer: 'Discovery Logic' }` -> `layer="Discovery Logic"`, trimmed for one line. */
function formatArgs(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined && item !== null && item !== '',
  );
  if (entries.length === 0) return '';
  const rendered = entries.map(([key, item]) => `${key}=${JSON.stringify(item)}`).join(' ');
  return rendered.length > 80 ? `${rendered.slice(0, 79)}…` : rendered;
}

/** The first meaningful line of a tool result — enough to see what it proved. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return '(no output)';
  return line.length > TOOL_LINE_LIMIT ? `${line.slice(0, TOOL_LINE_LIMIT - 1)}…` : line;
}

function toToolView(message: Message): ToolCallView {
  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : {};
  const name = readString(metadata, 'name') ?? readString(metadata, 'tool') ?? 'tool';
  return {
    key: message.id,
    name,
    ok: metadata.ok !== false,
    args: formatArgs(metadata.args),
    line: firstLine(message.content),
    full: message.content,
  };
}

/**
 * Group the flat transcript into turns. The server persists USER, then one TOOL
 * message per call, then the ASSISTANT message built from them — so the tool
 * messages seen before an assistant reply are exactly the evidence behind it.
 */
function buildTurns(messages: Message[]): TurnView[] {
  const turns: TurnView[] = [];
  let pending: ToolCallView[] = [];

  for (const message of messages) {
    if (message.role === 'TOOL') {
      pending.push(toToolView(message));
      continue;
    }
    if (message.role === 'ASSISTANT') {
      turns.push({
        key: message.id,
        role: 'ASSISTANT',
        content: message.content,
        createdAt: message.createdAt,
        tools: pending,
      });
      pending = [];
      continue;
    }
    // A turn that recorded tool calls but no answer: never drop the evidence.
    if (pending.length > 0) {
      const orphan = pending;
      pending = [];
      const first = orphan[0];
      turns.push({
        key: `${first ? first.key : message.id}:tools`,
        role: 'TOOL',
        content: '',
        createdAt: message.createdAt,
        tools: orphan,
      });
    }
    turns.push({
      key: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      tools: [],
    });
  }

  if (pending.length > 0) {
    const first = pending[0];
    turns.push({
      key: `${first ? first.key : 'pending'}:tools`,
      role: 'TOOL',
      content: '',
      createdAt: '',
      tools: pending,
    });
  }

  return turns;
}

function ToolCalls(props: { tools: ToolCallView[] }): JSX.Element | null {
  if (props.tools.length === 0) return null;
  const failed = props.tools.filter((tool) => !tool.ok).length;
  return (
    <details className="chat__tools">
      <summary>
        {props.tools.length} tool call{props.tools.length === 1 ? '' : 's'}
        {failed > 0 ? ` · ${failed} failed` : ''}
      </summary>
      {props.tools.map((tool) => (
        <span className="chat__tool" key={tool.key} title={tool.full}>
          <span className={tool.ok ? 'ok' : 'bad'}>{tool.ok ? '✓' : '✗'}</span> {tool.name}
          {tool.args ? ` ${tool.args}` : ''} — {tool.line}
        </span>
      ))}
    </details>
  );
}

export function ChatPanel(props: { projectId: string | null; onChanged(): void }): JSX.Element {
  const { projectId, onChanged } = props;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    const history = await Api.chatHistory(projectId);
    setConversation(history.conversation);
    setMessages(history.messages);
  }, [projectId]);

  useEffect(() => {
    setError(null);
    if (!projectId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Api.chatHistory(projectId)
      .then((history) => {
        if (cancelled) return;
        setConversation(history.conversation);
        setMessages(history.messages);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Keep the newest turn in view; the answer is always at the bottom.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const sendText = useCallback(
    async (text: string): Promise<void> => {
      const content = text.trim();
      if (!content || !projectId) return;
      setSending(true);
      setError(null);
      try {
        await Api.sendChat(projectId, content);
        setInput('');
        await load();
        // A chat turn can create runs and audits, so the rest of the screen is stale.
        onChanged();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setSending(false);
      }
    },
    [projectId, load, onChanged],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void sendText(input);
      }
    },
    [input, sendText],
  );

  const turns = buildTurns(messages);
  const disabled = !projectId || sending;

  return (
    <div className="chat">
      <div className="section__title spread">
        <span>PROJECT CHAT</span>
        <span className="mono muted" title={conversation?.id ?? ''}>
          {conversation ? conversation.title : 'no conversation'}
        </span>
      </div>

      <div className="small muted">
        Answers are assembled from live database reads. Open the tool list under any answer to see
        exactly what was queried.
      </div>

      {error ? (
        <div className="error spread">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setError(null)}>
            DISMISS
          </button>
        </div>
      ) : null}

      <div className="chat__log" ref={logRef}>
        {loading && turns.length === 0 ? <div className="empty">Loading transcript…</div> : null}
        {!loading && turns.length === 0 ? (
          <div className="empty">
            Ask what to do next, what is missing, or for a layer&apos;s status. Every answer is
            derived from the database, never from this transcript.
          </div>
        ) : null}
        {turns.map((turn) => (
          <div className={`chat__msg chat__msg--${turn.role.toLowerCase()}`} key={turn.key}>
            <span className="chat__role" title={turn.createdAt}>
              {turn.role === 'TOOL' ? 'TOOL CALLS' : turn.role}
            </span>
            {turn.content ? <span className="wrap">{turn.content}</span> : null}
            <ToolCalls tools={turn.tools} />
          </div>
        ))}
      </div>

      <div className="row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            type="button"
            className="btn btn--small"
            key={suggestion}
            disabled={disabled}
            onClick={() => void sendText(suggestion)}
          >
            {suggestion.toUpperCase()}
          </button>
        ))}
      </div>

      <form
        className="chat__form"
        onSubmit={(event) => {
          event.preventDefault();
          void sendText(input);
        }}
      >
        <textarea
          className="chat__input"
          value={input}
          placeholder={
            projectId ? 'Ask about project state… (Enter to send, Shift+Enter for a new line)' : 'No project loaded'
          }
          disabled={disabled}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" className="btn btn--primary" disabled={disabled || !input.trim()}>
          {sending ? 'ASKING…' : 'SEND'}
        </button>
      </form>
    </div>
  );
}
