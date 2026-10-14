/**
 * Client for the local Forge bridge (tutor/bridge). Forge is the authority for every legal
 * action and every state change; this file only carries requests to it.
 */
export interface ForgeHealth { ok: boolean; forgeVersion: string; forgeRevision: string; uniqueCards: number }
export interface ForgeCardCheck { name: string; supported: boolean; forgeName?: string; printingFound?: boolean; aiPlayable?: boolean; reason?: string }
export interface ForgeDeckSpec { name?: string; commander: ForgeCardSpec[]; main: ForgeCardSpec[] }
export interface ForgeCardSpec { name: string; count: number; set?: string | null; number?: string | null }

export class ForgeBridge {
  constructor(private base: string, private fetchImpl: typeof fetch = fetch) {}

  private async call<T>(path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok && res.status !== 409) throw new Error(json.error ?? `Forge bridge ${path} answered ${res.status}`);
    return json;
  }

  async health(): Promise<ForgeHealth | null> {
    try { return await this.call<ForgeHealth>('/health', undefined, 3000); } catch { return null; }
  }

  checkCards(cards: ForgeCardSpec[]): Promise<ForgeCardCheck[]> {
    return this.call('/cards/check', { cards });
  }

  validate(deck: ForgeDeckSpec): Promise<{ conforms: boolean; problem?: string; mainCount: number; commanderCount: number }> {
    return this.call('/decks/validate', { deck });
  }

  createMatch(human: ForgeDeckSpec, opponents: Array<{ name: string; deck: ForgeDeckSpec }>, scenario?: string[]): Promise<{ matchId: string; players: number; gameType: string }> {
    return this.call('/matches', { human: { deck: human }, opponents, ...(scenario ? { scenario } : {}) });
  }

  state(id: string, after: number, waitMs: number): Promise<Record<string, unknown>> {
    return this.call(`/matches/${id}/state?after=${after}&wait=${Math.min(waitMs, 25_000)}`, undefined, waitMs + 10_000);
  }

  act(id: string, revision: number, action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    return this.call(`/matches/${id}/act`, { revision, action });
  }

  automation(id: string, settings: Record<string, unknown>): Promise<unknown> {
    return this.call(`/matches/${id}/automation`, settings);
  }

  history(id: string): Promise<unknown[]> {
    return this.call(`/matches/${id}/history`);
  }

  async concede(id: string): Promise<void> {
    await this.call(`/matches/${id}/concede`, {});
  }
}

/** Forge's card-script file name for a card, as its repository lays them out. */
export function forgeScriptPath(name: string): string {
  const slug = name.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[',.!?"’:]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `forge-gui/res/cardsfolder/${slug[0]}/${slug}.txt`;
}
