/**
 * Anthropic adapter — a thin, dependency-free REST client.
 *
 * `POST https://api.anthropic.com/v1/messages` with `x-api-key` and
 * `anthropic-version: 2023-06-01`. No SDK, no retries hidden from the user, and
 * no silent degradation: without a key the provider reports itself unavailable
 * and every call rejects with a message that says what to do instead.
 */
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatRequest,
  ChatResponse,
  ProviderMessage,
  ProviderStatus,
  ResearchRequest,
  ResearchResponse,
} from './types.ts';
import { COPY_PROMPT_FALLBACK } from './types.ts';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface ClaudeProviderOptions {
  apiKey?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface AnthropicTextBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponseBody {
  id?: string;
  model?: string;
  content?: AnthropicTextBlock[];
  error?: { type?: string; message?: string };
}

const RESEARCH_SYSTEM = [
  'You are executing a compiled research run for a local research-operations platform.',
  'Follow the prompt exactly. Obey its naming rules literally — the platform, not you, owns the',
  'document title, the conversation title and the filename.',
  'Return the finished document itself: no preamble, no meta-commentary, no restatement of the prompt.',
].join(' ');

const AUDIT_SYSTEM = [
  'You are auditing a research document for a local research-operations platform.',
  'Return exactly one fenced ```json block containing an object with the keys verdict, summary,',
  'failures, missingDocuments, requiredResearchRuns, requiredPatches, synthesisRequired,',
  'freezeEligible, nextVersion, nextAction and confidence.',
  'verdict must be one of PASS, KEEP, PATCH, REDO, MISSING_DEPENDENCY, MORE_RESEARCH,',
  'READY_FOR_SYNTHESIS, READY_TO_FREEZE, BLOCKED. Never invent documents you were not shown.',
].join(' ');

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Attachment lists are named, not uploaded: the REST call carries text only. */
function attachmentNotice(requiredAttachments: string[]): string {
  if (requiredAttachments.length === 0) {
    return 'This run requires no source documents.';
  }
  return [
    'This run has a required source packet:',
    ...requiredAttachments.map((name) => `- ${name}`),
    '',
    'Those files are NOT attached to this API call — only their canonical names are. If you cannot',
    'see their contents in this conversation, say so explicitly and stop rather than reconstructing',
    'them from memory.',
  ].join('\n');
}

async function readBodySnippet(response: Response): Promise<string> {
  try {
    const body = (await response.text()).trim();
    return body.length > 600 ? `${body.slice(0, 600)}…` : body;
  } catch {
    return '(response body could not be read)';
  }
}

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude';

  private readonly options: ClaudeProviderOptions;

  constructor(options: ClaudeProviderOptions = {}) {
    this.options = options;
  }

  /** Read at call time, never at import time, so a key exported later works. */
  private apiKey(): string | null {
    return trimToNull(this.options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? null);
  }

  private model(requested?: string | null): string {
    return (
      trimToNull(requested) ??
      trimToNull(this.options.model) ??
      trimToNull(process.env['ANTHROPIC_MODEL']) ??
      DEFAULT_CLAUDE_MODEL
    );
  }

  private baseUrl(): string {
    const base =
      trimToNull(this.options.baseUrl) ??
      trimToNull(process.env['ANTHROPIC_BASE_URL']) ??
      DEFAULT_BASE_URL;
    return base.replace(/\/+$/, '');
  }

  getStatus(): ProviderStatus {
    const key = this.apiKey();
    return {
      name: this.name,
      available: key !== null,
      reason: key
        ? `ANTHROPIC_API_KEY is set; calls go to ${this.baseUrl()}/v1/messages as ${this.model()}.`
        : `ANTHROPIC_API_KEY is not set, so the Anthropic API cannot be called. ${COPY_PROMPT_FALLBACK}`,
      model: this.model(),
      capabilities: { chat: true, research: true, audit: true },
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const result = await this.call(request.messages, request.system ?? null, request.model ?? null);
    return { text: result.text, externalResponseId: result.id };
  }

  async runResearch(request: ResearchRequest): Promise<ResearchResponse> {
    const content = [
      request.prompt,
      '',
      '=== REQUIRED ATTACHMENTS (declared by the platform) ===',
      '',
      attachmentNotice(request.requiredAttachments),
      '',
      '=== EXPECTED OUTPUT IDENTITY (enforced by the platform) ===',
      '',
      `Document title : ${request.expectedConversationTitle}`,
      `Filename       : ${request.expectedFilename}`,
    ].join('\n');
    const result = await this.call(
      [{ role: 'user', content }],
      RESEARCH_SYSTEM,
      request.model ?? null,
    );
    return { text: result.text, externalResponseId: result.id, model: result.model };
  }

  async audit(request: AuditRequest): Promise<AuditResponse> {
    const document = trimToNull(request.documentText);
    const content = [
      request.prompt,
      '',
      '=== DOCUMENT UNDER AUDIT ===',
      '',
      document ??
        '(No document text was supplied. Report this as a failure rather than assuming content.)',
    ].join('\n');
    const result = await this.call([{ role: 'user', content }], AUDIT_SYSTEM, request.model ?? null);
    return { text: result.text, externalResponseId: result.id };
  }

  /** The one place an HTTP request is made; everything else composes messages. */
  private async call(
    messages: ProviderMessage[],
    system: string | null,
    requestedModel: string | null,
  ): Promise<{ text: string; id: string | null; model: string | null }> {
    const key = this.apiKey();
    if (!key) {
      throw new Error(
        'The Claude provider cannot run: ANTHROPIC_API_KEY is not set in this environment. ' +
          COPY_PROMPT_FALLBACK,
      );
    }

    // Anthropic takes the system prompt as a top-level field, not a message.
    const systemParts = [
      ...(system ? [system] : []),
      ...messages.filter((message) => message.role === 'system').map((message) => message.content),
    ];
    const turns = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));
    if (turns.length === 0) {
      throw new Error('The Claude provider cannot run: the request contains no user message.');
    }

    const model = this.model(requestedModel);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(`${this.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
          messages: turns,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = controller.signal.aborted
        ? `the request timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`The Anthropic API could not be reached: ${detail}. ${COPY_PROMPT_FALLBACK}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const snippet = await readBodySnippet(response);
      throw new Error(
        `The Anthropic API returned HTTP ${response.status} ${response.statusText}: ${snippet} ` +
          COPY_PROMPT_FALLBACK,
      );
    }

    let body: AnthropicResponseBody;
    try {
      body = (await response.json()) as AnthropicResponseBody;
    } catch {
      throw new Error(
        `The Anthropic API returned a body that is not JSON. ${COPY_PROMPT_FALLBACK}`,
      );
    }
    if (body.error) {
      throw new Error(
        `The Anthropic API reported an error: ${body.error.message ?? body.error.type ?? 'unknown'}. ` +
          COPY_PROMPT_FALLBACK,
      );
    }

    const text = (body.content ?? [])
      .filter((block) => (block.type ?? 'text') === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    if (text.length === 0) {
      throw new Error(
        `The Anthropic API returned no text content. ${COPY_PROMPT_FALLBACK}`,
      );
    }
    return { text, id: trimToNull(body.id), model: trimToNull(body.model) ?? model };
  }
}
