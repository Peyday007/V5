/**
 * Provider registry.
 *
 * The default is always the mock, so the platform boots, plans, compiles
 * prompts, audits and freezes with zero credentials. A remote provider is an
 * optional accelerator that is selected explicitly — never a prerequisite.
 */
import { ClaudeProvider } from './claude.ts';
import { MockProvider } from './mock.ts';
import { OpenAIProvider } from './openai.ts';
import type { AIProvider, ProviderStatus } from './types.ts';

export const MOCK_PROVIDER_NAME = 'mock';

/** Canonical provider names, in the order the UI lists them. */
export const PROVIDER_NAMES = ['mock', 'claude', 'openai'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const FACTORIES: Record<ProviderName, () => AIProvider> = {
  mock: () => new MockProvider(),
  claude: () => new ClaudeProvider(),
  openai: () => new OpenAIProvider(),
};

/** What users, run rows and env vars actually type. */
const ALIASES: Record<string, ProviderName> = {
  mock: 'mock',
  local: 'mock',
  offline: 'mock',
  none: 'mock',
  claude: 'claude',
  anthropic: 'claude',
  'claude-code': 'claude',
  openai: 'openai',
  gpt: 'openai',
  chatgpt: 'openai',
};

/** Instances are stateless and read credentials per call, so caching is safe. */
const instances = new Map<ProviderName, AIProvider>();

function canonicalize(name: string | null | undefined): ProviderName | null {
  const key = (name ?? '').trim().toLowerCase();
  if (key.length === 0) return null;
  return ALIASES[key] ?? null;
}

/**
 * `BRAIN_PROVIDER` when it names something real, otherwise the mock. A typo in
 * the environment must degrade to the always-available provider rather than
 * failing the boot.
 */
export function defaultProviderName(): string {
  return canonicalize(process.env['BRAIN_PROVIDER']) ?? MOCK_PROVIDER_NAME;
}

/**
 * Resolve a provider by name. An empty or missing name gives the default;
 * an unrecognised name throws, because silently swapping the requested provider
 * for another one would put a false `provider` value on the run record.
 */
export function getProvider(name?: string | null): AIProvider {
  const requested = (name ?? '').trim();
  const resolved = requested.length === 0 ? canonicalize(defaultProviderName()) : canonicalize(requested);
  if (!resolved) {
    throw new Error(
      `Unknown AI provider "${requested}". Known providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  const existing = instances.get(resolved);
  if (existing) return existing;
  const created = FACTORIES[resolved]();
  instances.set(resolved, created);
  return created;
}

/** Status of every provider, for the health endpoint and the settings pane. */
export function listProviderStatuses(): ProviderStatus[] {
  return PROVIDER_NAMES.map((name) => getProvider(name).getStatus());
}

export { MockProvider } from './mock.ts';
export { ClaudeProvider } from './claude.ts';
export { OpenAIProvider } from './openai.ts';
export type {
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
