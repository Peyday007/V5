/**
 * Where a light probe is allowed to look.
 *
 * This is the same idea as `services/research/approvalEnvelope.ts`, at a smaller
 * scale and for the same reason: **nobody supplies the limits their own work is
 * judged against.** The envelope lives in code, a probe names it by id, and the
 * runner reads the destinations from here rather than from anything a model
 * said.
 *
 * That is the whole point of the split. A model proposing a probe supplies one
 * thing — a narrow question — and it is carried as a *query value*, encoded,
 * into a URL Brain wrote. It never supplies a host, a path, a scheme or a
 * redirect. So the worst a compromised or confused proposal can do is ask a
 * silly question of an approved source.
 *
 * The envelope below is deliberately minimal, and that is not an oversight to
 * be corrected in passing. **A second envelope, or a wider one, is a code
 * change somebody reviews** — the same sentence Step 3's approval envelope
 * carries, for the same reason. Widening the reach of an unattended process
 * should never be something the unattended process can do.
 */

/** One destination, written by Brain. */
export interface ProbeSource {
  /** What a person would call it. */
  label: string;
  /**
   * The exact origin and path. Never composed from model output, and never
   * carrying the question — that arrives only as `queryParam`, encoded.
   */
  url: string;
  /** The query parameter the probe question is carried in. */
  queryParam: string;
}

export interface ProbeEnvelope {
  id: string;
  version: number;
  /** The hardest ceiling. A proposal may ask for fewer and never for more. */
  maxLookups: number;
  /** How long the whole probe may take, from the Brain's clock. */
  deadlineMinutes: number;
  /** Per lookup, so one slow source cannot hold the tick open. */
  timeoutMs: number;
  /** Per lookup. A probe reads a page, it does not download a corpus. */
  maxBytes: number;
  sources: ProbeSource[];
}

/**
 * The one envelope that exists.
 *
 * One source, because a light probe's job is triage — "is there anything here
 * worth a packet" — and a triage answer from one broad, stable, public index is
 * worth more than a wider reach nobody has justified. Real research has a real
 * envelope, a real evidence gate and three audit roles; this is the cheap look
 * that decides whether to spend any of that.
 */
export const GENERAL_LIGHT_PROBE_V1: ProbeEnvelope = {
  id: 'GENERAL_LIGHT_PROBE_V1',
  version: 1,
  maxLookups: 3,
  deadlineMinutes: 5,
  timeoutMs: 8_000,
  maxBytes: 256 * 1024,
  sources: [
    {
      label: 'Wikipedia search',
      url: 'https://en.wikipedia.org/w/index.php',
      queryParam: 'search',
    },
  ],
};

const ENVELOPES: Record<string, ProbeEnvelope> = {
  [GENERAL_LIGHT_PROBE_V1.id]: GENERAL_LIGHT_PROBE_V1,
};

export function probeEnvelope(id: string): ProbeEnvelope | null {
  return ENVELOPES[id] ?? null;
}

/**
 * The allowlist a probe row carries, derived from the envelope.
 *
 * Stored on the row as well as read from code, because the row is what
 * `permitLookup` checks and a probe should be judged by the envelope it was
 * opened under rather than by whatever the file says months later.
 */
export function allowlistFor(envelope: ProbeEnvelope): string[] {
  return envelope.sources.map((source) => new URL(source.url).origin);
}

/**
 * The exact URL Brain will fetch for one source and one question.
 *
 * The question goes through `URLSearchParams`, so a question containing `&`,
 * `#`, a path or a whole second URL is encoded into the value rather than
 * escaping into the structure. This function is the only place the two are ever
 * joined.
 */
export function destinationFor(source: ProbeSource, question: string): string {
  const url = new URL(source.url);
  url.searchParams.set(source.queryParam, question);
  return url.toString();
}
