/**
 * AI provider abstraction (section 16).
 *
 * The platform is a research-management system first and an AI client second:
 * every provider is optional, and the MVP path is COPY PROMPT + COPY REQUIRED
 * ATTACHMENT LIST. Nothing above this interface may assume a network call is
 * possible, and no provider is ever consulted for project state — state comes
 * from the database and the filesystem.
 */

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderStatus {
  name: string;
  available: boolean;
  /** Why it is (or is not) usable, phrased for the user, never a stack trace. */
  reason: string;
  model: string | null;
  capabilities: { chat: boolean; research: boolean; audit: boolean };
  /**
   * True when what this provider returns is placeholder content rather than work.
   *
   * The mock is deliberately always available, which is what lets the platform
   * boot, plan, compile prompts and verify naming with no credentials. That is a
   * different thing from being able to do research, and staged research has to
   * be able to tell the difference — a placeholder report filed as an audited
   * artifact would be the worst outcome the platform can produce.
   */
  placeholder?: boolean;
}

export interface ResearchRequest {
  prompt: string;
  requiredAttachments: string[];
  expectedConversationTitle: string;
  expectedFilename: string;
  model?: string | null;
}

export interface ResearchResponse {
  text: string;
  externalResponseId: string | null;
  model: string | null;
}

/**
 * Controls a caller may pass to a research call.
 *
 * Optional on purpose: the orchestration engine needs cancellation, progress and
 * a job identity from whatever worker it is driving, but a provider that cannot
 * offer them is still a valid provider — it simply ignores the options. That is
 * what keeps the engine independent of which tool is doing the research.
 */
export interface ResearchRunOptions {
  /** Cancellation from the UI, or from a job being superseded. */
  signal?: AbortSignal;
  /** Called with each chunk of output, for live progress. */
  onOutput?: (chunk: string) => void;
  /** The run this job belongs to, so its working directory is traceable. */
  runId?: string;
}

export interface AuditRequest {
  prompt: string;
  documentText?: string | null;
  model?: string | null;
}

export interface AuditResponse {
  text: string;
  externalResponseId: string | null;
}

export interface ChatRequest {
  messages: ProviderMessage[];
  system?: string | null;
  model?: string | null;
}

export interface ChatResponse {
  text: string;
  externalResponseId: string | null;
}

export interface AIProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  runResearch(request: ResearchRequest, options?: ResearchRunOptions): Promise<ResearchResponse>;
  audit(request: AuditRequest): Promise<AuditResponse>;
  getStatus(): ProviderStatus;
}

/**
 * Appended to every "this provider cannot run" message. A missing credential is
 * an inconvenience, not a failure state — the user still has a complete,
 * copy-pasteable prompt and attachment list.
 */
export const COPY_PROMPT_FALLBACK =
  'The platform is not blocked by this: use COPY PROMPT and COPY REQUIRED ATTACHMENT LIST, ' +
  'run the prompt in an ordinary chat, and import the report back under the expected filename.';
