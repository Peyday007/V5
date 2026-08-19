/**
 * The Antigravity provider (section 2, connection layer).
 *
 * At this checkpoint the provider exists to tell the truth about itself. It
 * reports what the capability probe found and refuses every call it cannot
 * honestly serve; running an actual research job is the next checkpoint.
 *
 * The refusal matters as much as the eventual success. The rule this platform
 * runs on is that a provider which cannot do the work says so — it never hands
 * the request to the mock and lets a mechanical answer pass for research. A
 * user who thinks a real investigation happened when it did not is worse off
 * than a user who was told to run it themselves.
 */
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatRequest,
  ChatResponse,
  ProviderStatus,
  ResearchRequest,
  ResearchResponse,
} from './types.ts';
import { COPY_PROMPT_FALLBACK } from './types.ts';
import { antigravityStatus, type AntigravityStatus } from './antigravity/runtime.ts';

/** Raised for anything Antigravity cannot currently do. Never a silent fallback. */
export class AntigravityUnavailableError extends Error {
  readonly status: AntigravityStatus;

  constructor(status: AntigravityStatus) {
    super(status.message);
    this.name = 'AntigravityUnavailableError';
    this.status = status;
  }
}

export class AntigravityProvider implements AIProvider {
  readonly name = 'antigravity';

  /** True only when every stage of the probe passed. */
  #usable(status: AntigravityStatus): boolean {
    return (
      status.installed &&
      status.authenticated &&
      status.automationReady &&
      status.quotaState !== 'exhausted'
    );
  }

  #refuse(): never {
    throw new AntigravityUnavailableError(antigravityStatus().status);
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.#refuse();
  }

  async runResearch(_request: ResearchRequest): Promise<ResearchResponse> {
    this.#refuse();
  }

  async audit(_request: AuditRequest): Promise<AuditResponse> {
    this.#refuse();
  }

  getStatus(): ProviderStatus {
    const status = antigravityStatus().status;
    const usable = this.#usable(status);
    return {
      name: this.name,
      available: usable,
      reason: usable
        ? status.message
        : `${status.message} ${COPY_PROMPT_FALLBACK}`,
      model: status.model,
      // Research is the capability this provider exists for; the staged
      // orchestration that delivers it arrives in the next checkpoint, so it is
      // not claimed here.
      capabilities: { chat: false, research: false, audit: false },
    };
  }
}
