/** The browser's only door to the server. No credentials live here. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: any) { super(message); }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export const api = {
  status: () => call<any>('/api/status'),
  fixtures: () => call<any[]>('/api/fixtures'),
  fixtureText: async (id: string) => (await fetch(`/api/fixtures/${id}`)).text(),
  decks: () => call<any[]>('/api/decks'),
  deck: (id: string) => call<any>(`/api/decks/${id}`),
  deleteDeck: (id: string) => call<any>(`/api/decks/${id}`, { method: 'DELETE' }),
  preview: (body: any) => call<any>('/api/decks/preview', { body }),
  saveDeck: (body: any) => call<any>('/api/decks', { body }),
  guide: (id: string) => call<any>(`/api/decks/${id}/guide`),
  explainCard: (ref: string, deckId?: string) => call<any>(`/api/cards/explain?ref=${encodeURIComponent(ref)}${deckId ? `&deckId=${deckId}` : ''}`),
  recognize: (body: any) => call<any>('/api/recognize', { body }),
  startMatch: (body: any) => call<any>('/api/matches', { body }),
  matches: () => call<any[]>('/api/matches'),
  state: (id: string, after: number, wait: number, signal?: AbortSignal) => call<any>(`/api/matches/${id}/state?after=${after}&wait=${wait}`, { signal }),
  act: (id: string, revision: number, action: any) => call<any>(`/api/matches/${id}/act`, { body: { revision, action } }),
  automation: (id: string, body: any) => call<any>(`/api/matches/${id}/automation`, { body }),
  coachMode: (id: string, coachMode: string) => call<any>(`/api/matches/${id}/coach-mode`, { body: { coachMode } }),
  concede: (id: string) => call<any>(`/api/matches/${id}/concede`, { body: {} }),
  tutor: (id: string, body: any) => call<any>(`/api/matches/${id}/tutor`, { body }),
  review: (id: string) => call<any>(`/api/matches/${id}/review`),
  learning: () => call<any>('/api/learning'),
};
