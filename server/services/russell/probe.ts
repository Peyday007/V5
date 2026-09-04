/**
 * Running a light probe.
 *
 * A probe answers one narrow question cheaply, so that Russell can decide
 * whether a candidate is worth a real research packet. Everything about it is
 * arranged so that "cheap" is a property of the code rather than a promise:
 *
 *   - **Brain chooses where to look.** The envelope in `probeEnvelope.ts` names
 *     the destinations. A proposal supplies one thing, a question, and it is
 *     carried as an encoded query value into a URL Brain wrote. No host, path,
 *     scheme or redirect ever comes from model output.
 *   - **The bound is asked before each fetch**, from rows, by `permitLookup`.
 *     A runner that crashed and resumed cannot get its allowance back by
 *     forgetting how many it used, because the observations table *is* the
 *     count.
 *   - **A redirect is a new destination**, so it is re-checked against the
 *     allowlist and costs another lookup. Following one silently is how an
 *     allowlist becomes decorative.
 *   - **No model is called and nothing is spent.** The outcome is decided by
 *     reading what came back, deterministically.
 *
 * The last point is what makes the verdict honest rather than impressive. A
 * probe can say the subject demonstrably appears in an approved source, or that
 * it looked and did not find it, or that it learned nothing because it could not
 * read anything. It cannot say whether a claim is *true* — that is what the
 * evidence gate, the verification pass and three audit roles are for, and a
 * probe that pretended otherwise would be the cheapest way to get an unaudited
 * conclusion into the project.
 */
import {
  completeProbe,
  createProbe,
  destinationAllowed,
  getProbe,
  listObservations,
  permitLookup,
  recordObservation,
  startProbe,
} from '../../repos/russellProbes.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import {
  allowlistFor,
  destinationFor,
  GENERAL_LIGHT_PROBE_V1,
  probeEnvelope,
  type ProbeEnvelope,
} from './probeEnvelope.ts';
import type { ProbeOutcome, ProbeRetrieval, RussellProbe } from '../../domain/types.ts';

/** How many hops a probe will follow before calling it a day. */
const MAX_REDIRECTS = 2;

export interface OpenProbeResult {
  ok: boolean;
  reason: string;
  probe: RussellProbe | null;
}

/**
 * Open a probe against a candidate.
 *
 * `maxLookups` is the *lower* of what was asked for and what the envelope
 * allows, so a proposal can narrow the bound and can never widen it. The
 * idempotency key is derived from the candidate and the question, so the same
 * probe asked twice — by a retry, a redelivered bin or an impatient person — is
 * one probe.
 */
export async function openProbe(input: {
  candidateId: string;
  question: string;
  maxLookups: number;
  envelopeId?: string;
}): Promise<OpenProbeResult> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate) return { ok: false, reason: 'no such candidate', probe: null };

  const envelope = probeEnvelope(input.envelopeId ?? GENERAL_LIGHT_PROBE_V1.id);
  if (!envelope) return { ok: false, reason: 'no such probe envelope', probe: null };

  const question = input.question.trim();
  if (!question) return { ok: false, reason: 'a probe needs a question', probe: null };

  const probe = await createProbe({
    candidateId: candidate.id,
    projectId: candidate.projectId,
    // Most restrictive source wins, exactly as a capture does: a probe about a
    // private idea is private however public the project is.
    visibility: candidate.visibility,
    question,
    allowedSources: allowlistFor(envelope),
    maxLookups: Math.min(Math.max(1, input.maxLookups), envelope.maxLookups),
    deadlineMinutes: envelope.deadlineMinutes,
    idempotencyKey: `russell:probe:${candidate.id}:${fingerprint(question)}`,
  });
  return { ok: true, reason: 'opened', probe };
}

/** A stable short key for a question, so the same ask is the same probe. */
function fingerprint(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join('-')
    .slice(0, 160);
}

/** What one lookup did, for the caller and for the test. */
export interface LookupReport {
  url: string;
  retrieval: ProbeRetrieval;
  note: string;
  /** True when the retrieved text demonstrably discusses the question. */
  mentioned: boolean;
}

export interface RunProbeResult {
  ok: boolean;
  reason: string;
  outcome: ProbeOutcome | null;
  lookups: LookupReport[];
}

/**
 * A fetch that can be replaced in a test.
 *
 * Injected rather than mocked globally, because the thing under test is what
 * the runner does with an answer — including a redirect to somewhere it is not
 * allowed — and that has to be provoked deterministically rather than hoped for
 * from a live host.
 */
export type ProbeFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/**
 * Run a probe to its end and record the verdict.
 *
 * Re-entrant: the observation count is the budget, and `completeProbe` is
 * guarded, so calling this twice on one probe cannot spend two allowances or
 * record two verdicts.
 */
export async function runProbe(input: {
  probeId: string;
  envelopeId?: string;
  fetcher?: ProbeFetch;
}): Promise<RunProbeResult> {
  const probe = await getProbe(input.probeId);
  if (!probe) return { ok: false, reason: 'no such probe', outcome: null, lookups: [] };

  const envelope = probeEnvelope(input.envelopeId ?? GENERAL_LIGHT_PROBE_V1.id);
  if (!envelope) return { ok: false, reason: 'no such probe envelope', outcome: null, lookups: [] };

  // `startProbe` is guarded on PENDING, so a second runner arriving at a probe
  // already under way does not restart it — but it may still finish it, which
  // is what makes crash recovery work without a supervisor.
  await startProbe(probe.id);

  const lookups: LookupReport[] = [];
  const fetcher = input.fetcher ?? (globalThis.fetch as unknown as ProbeFetch);

  for (const source of envelope.sources) {
    let destination = destinationFor(source, probe.question);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const permission = await permitLookup({ probeId: probe.id, url: destination });
      if (!permission.ok) {
        // Out of budget, past the deadline, or the destination is not allowed.
        // All three end this source rather than the whole probe: another source
        // may still be inside the envelope.
        // Deliberately *not* an observation. The observations table is the
        // budget, and a refusal consumed none of it — writing a row here would
        // make the next `permitLookup` believe an allowance had been spent.
        lookups.push({
          url: source.label,
          retrieval: 'REFUSED',
          note: permission.detail,
          mentioned: false,
        });
        break;
      }

      const attempt = await fetchOnce(fetcher, destination, envelope);
      await recordObservation({
        probeId: probe.id,
        ordinal: permission.ordinal,
        sourceUrl: destination,
        retrieval: attempt.retrieval,
        note: attempt.note,
      });
      lookups.push({
        url: destination,
        retrieval: attempt.retrieval,
        note: attempt.note,
        mentioned: attempt.retrieval === 'RETRIEVED' && mentions(probe.question, attempt.body),
      });

      if (attempt.redirectTo) {
        if (!destinationAllowed(attempt.redirectTo, probe.allowedSources)) {
          // A redirect out of the envelope is where an allowlist earns its
          // keep. Refused by name, and the probe does not follow it.
          lookups.push({
            url: source.label,
            retrieval: 'REFUSED',
            note: 'the redirect left this probe’s allowlist',
            mentioned: false,
          });
          break;
        }
        destination = attempt.redirectTo;
        continue;
      }

      break;
    }
  }

  const outcome = verdictFrom(lookups);
  await completeProbe({
    probeId: probe.id,
    outcome,
    explanation: explain(outcome, lookups),
  });
  return { ok: true, reason: 'ran', outcome, lookups };
}

/**
 * Does the retrieved text actually discuss the question's subject?
 *
 * Deliberately crude and deliberately conservative: the distinctive words of
 * the question, minus the ones every page contains, and a majority of them have
 * to appear. It is a triage signal and is described as one everywhere it is
 * shown. A cleverer version that inferred agreement would be a model's job, and
 * a probe does not call one.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for', 'from', 'has',
  'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'there',
  'these', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

export function mentions(question: string, body: string): boolean {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  if (terms.length === 0) return false;
  const haystack = body.toLowerCase();
  const found = terms.filter((term) => haystack.includes(term)).length;
  return found * 2 > terms.length;
}

interface FetchAttempt {
  retrieval: ProbeRetrieval;
  note: string;
  body: string;
  redirectTo: string | null;
}

/**
 * One bounded fetch.
 *
 * Every failure mode is classified rather than collapsed, because Step 10's
 * lesson holds here too: **"blocked" is four facts and they lead to different
 * actions.** A host that refused this client, a network that refused the host
 * and a page that does not exist are not the same event, and a probe that
 * reported them identically would be telling Russell to retry the one thing
 * that will never work.
 */
async function fetchOnce(
  fetcher: ProbeFetch,
  url: string,
  envelope: ProbeEnvelope,
): Promise<FetchAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), envelope.timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      return {
        retrieval: 'RETRIEVED',
        note: `redirected with ${response.status}`,
        body: '',
        redirectTo: location ? new URL(location, url).toString() : null,
      };
    }
    if (response.status === 404) {
      return { retrieval: 'NOT_FOUND', note: 'the page is not there', body: '', redirectTo: null };
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return {
        retrieval: 'BLOCKED',
        note: `the host refused this client with ${response.status}`,
        body: '',
        redirectTo: null,
      };
    }
    if (response.status >= 400) {
      return {
        retrieval: 'UNREACHABLE',
        note: `the host answered ${response.status}`,
        body: '',
        redirectTo: null,
      };
    }
    const text = (await response.text()).slice(0, envelope.maxBytes);
    return { retrieval: 'RETRIEVED', note: 'read', body: text, redirectTo: null };
  } catch (error) {
    // A timeout, a reset or a refused connection. None of them is evidence
    // about the subject; all of them are evidence about the network.
    return {
      retrieval: 'UNREACHABLE',
      note: error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'could not connect',
      body: '',
      redirectTo: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The verdict, from what the lookups actually did.
 *
 * The ladder is the honest one. `UNKNOWN` when nothing was read, because
 * learning that a network is closed is not learning about the subject.
 * `WEAKENED` when pages were read and did not mention it — a real, if weak,
 * finding. `SUPPORTED` when at least one approved source demonstrably discusses
 * it, which is a claim about presence and never about truth.
 */
export function verdictFrom(lookups: LookupReport[]): ProbeOutcome {
  const read = lookups.filter((lookup) => lookup.retrieval === 'RETRIEVED' && lookup.note === 'read');
  if (read.length === 0) {
    const refusedOnly = lookups.length > 0 && lookups.every((lookup) => lookup.retrieval === 'REFUSED');
    return refusedOnly ? 'REFUSED' : 'UNKNOWN';
  }
  return read.some((lookup) => lookup.mentioned) ? 'SUPPORTED' : 'WEAKENED';
}

function explain(outcome: ProbeOutcome, lookups: LookupReport[]): string {
  const read = lookups.filter((lookup) => lookup.note === 'read').length;
  switch (outcome) {
    case 'SUPPORTED':
      return `Read ${read} ${read === 1 ? 'source' : 'sources'}, and the subject is discussed there. That is a sign it is worth looking at properly, not a finding in itself.`;
    case 'WEAKENED':
      return `Read ${read} ${read === 1 ? 'source' : 'sources'} and did not find the subject in any of them.`;
    case 'REFUSED':
      return 'Every place this probe was allowed to look refused it, so nothing was read.';
    case 'DUPLICATE':
      return 'The project already answers this.';
    default:
      return 'Nothing could be read, so this says something about the sources and nothing about the question.';
  }
}

/** The observations a person or a screen would read back. */
export async function probeTrail(probeId: string) {
  return listObservations(probeId);
}
