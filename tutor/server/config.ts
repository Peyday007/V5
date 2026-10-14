import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Everything the server reads from its environment, in one place. Nothing here reaches the browser. */
export interface Config {
  port: number;
  dataDir: string;
  bridgeUrl: string;
  anthropicKey: string | null;
  model: string;
  scryfallUserAgent: string;
  /** Tests point this at a fixture server instead of the real Scryfall. */
  scryfallApi: string;
  rulesPageUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.TUTOR_DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const key = (env.ANTHROPIC_API_KEY ?? '').trim();
  return {
    port: Number(env.TUTOR_PORT ?? 8790),
    dataDir,
    bridgeUrl: (env.FORGE_BRIDGE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, ''),
    anthropicKey: key.length > 0 ? key : null,
    model: env.TUTOR_MODEL?.trim() || 'claude-opus-5-5',
    scryfallUserAgent: env.SCRYFALL_USER_AGENT?.trim() || 'MTGDeckTutor/0.1',
    scryfallApi: (env.SCRYFALL_API ?? 'https://api.scryfall.com').replace(/\/$/, ''),
    rulesPageUrl: env.RULES_PAGE_URL ?? 'https://magic.wizards.com/en/rules',
  };
}
