/**
 * Signal combinations: several related events for one organisation or place,
 * read together by ordinary code.
 *
 * A detector output or a trigger-bucket finding is one observed event. Two or
 * more *different kinds* of event for the same organisation or place inside a
 * window are a combined signal: expansion + hiring + supply shortage says more
 * than any one of them. It is still a SIGNAL. It never establishes that anybody
 * would pay, and the label is a literal type so a reader cannot count it as
 * demand. Established patterns run here as code over a batch, with no model job
 * per record; a combination no pattern covers is returned once, by pattern key,
 * as a proposal for research to look at, to be converted into a tested pattern.
 */
import { employerKey } from '../feeds/detectors.ts';
import type { DetectedSignal } from '../feeds/detectors.ts';

export type ObservationKind = 'HIRING' | 'EXPANSION' | 'SUPPLY_SHORTAGE' | 'PLATFORM_SUNSET' | 'NEW_RULE' | 'REVIEW_COMPLAINT' | 'STALE_JOB_POST' | 'OTHER';

export interface Observation {
  id: string;
  origin: 'DETECTOR' | 'TRIGGER';
  kind: ObservationKind;
  /** Organisation name as the source printed it; null when the event is about a place only. */
  organization: string | null;
  place: string | null;
  /** The industry the source or detector placed it in, when it did. */
  category: string | null;
  observedAt: string;
  urls: readonly string[];
}

export interface CaptureMethod {
  method: string;
  /** Why this method follows from the pattern. A hypothesis, not a finding. */
  because: string;
}

export interface CombinedSignal {
  /** Always SIGNAL: never confirmed demand, never a buyer. */
  label: 'SIGNAL';
  key: string;
  subject: { organization: string | null; place: string | null };
  kinds: ObservationKind[];
  memberIds: string[];
  urls: string[];
  windowFrom: string;
  windowTo: string;
  industryNode: string | null;
  possibleNeed: string;
  captureMethods: CaptureMethod[];
  patternId: string;
  qualifiers: string[];
}

export interface Pattern {
  id: string;
  /** Every kind here must be present for the pattern to apply. */
  requires: readonly ObservationKind[];
  need: string;
  methods: readonly CaptureMethod[];
}

export const PATTERNS: readonly Pattern[] = [
  {
    id: 'EXPANSION_HIRING_SUPPLY',
    requires: ['EXPANSION', 'HIRING', 'SUPPLY_SHORTAGE'],
    need: 'Capacity and sourcing support while the business grows faster than its supply',
    methods: [{ method: 'supplier and capacity sourcing brief', because: 'growth, hiring and a shortage coincide' }],
  },
  {
    id: 'EXPANSION_HIRING',
    requires: ['EXPANSION', 'HIRING'],
    need: 'Setup work for a growing operation: listings, forms, price sheets, data',
    methods: [{ method: 'bounded setup deliverable offered by email', because: 'a new site and new staff both need documents' }],
  },
  {
    id: 'STALE_POST_HIRING',
    requires: ['STALE_JOB_POST', 'HIRING'],
    need: 'The unfilled task done as a bounded deliverable instead of a hire',
    methods: [{ method: 'fixed-scope task offer', because: 'a post nobody filled beside more hiring suggests the task is the bottleneck' }],
  },
  {
    id: 'SUNSET_REVIEWS',
    requires: ['PLATFORM_SUNSET', 'REVIEW_COMPLAINT'],
    need: 'Migration or rebuild of what the retiring platform held',
    methods: [{ method: 'data migration or page rebuild offer', because: 'forced move plus customer-visible problems' }],
  },
];

export const COMBINE_WINDOW_MS = 30 * 86_400_000;
const MIN_KINDS = 2;

export interface CombineOptions {
  now?: Date;
  patterns?: readonly Pattern[];
  /** Maps a category to an industry node id. Pure lookup supplied by the caller. */
  industryNodeFor?: (category: string | null) => string | null;
}

export interface CombineResult {
  signals: CombinedSignal[];
  /** Kind-combinations no pattern covers, once each, for research to examine. */
  unfamiliar: { patternKey: string; kinds: ObservationKind[]; count: number }[];
  stats: { records: number; subjects: number; modelJobs: 0; elapsedMs: number };
}

function subjectKey(o: Observation): string | null {
  const org = employerKey(o.organization);
  if (org) return `org:${org}`;
  const place = o.place?.trim().toLowerCase().replace(/\s+/g, ' ');
  return place ? `place:${place}` : null;
}

export function combineSignals(observations: readonly Observation[], options: CombineOptions = {}): CombineResult {
  const started = Date.now();
  const now = (options.now ?? new Date()).getTime();
  const patterns = options.patterns ?? PATTERNS;
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const at = Date.parse(o.observedAt);
    if (!Number.isFinite(at) || at < now - COMBINE_WINDOW_MS || at > now + 86_400_000) continue; // undated or stale is never combined
    const key = subjectKey(o);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }
  const signals: CombinedSignal[] = [];
  const unfamiliar = new Map<string, { patternKey: string; kinds: ObservationKind[]; count: number }>();
  for (const [key, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const kinds = [...new Set(members.map((m) => m.kind))].sort();
    if (kinds.length < MIN_KINDS) continue; // the same kind twice is one event repeated, not a combination
    // The most specific pattern wins: the one requiring the most kinds that all hold.
    const matched = patterns
      .filter((p) => p.requires.every((k) => kinds.includes(k)))
      .sort((a, b) => b.requires.length - a.requires.length || a.id.localeCompare(b.id))[0];
    if (!matched) {
      const patternKey = kinds.join('+');
      const seen = unfamiliar.get(patternKey);
      if (seen) seen.count += 1;
      else unfamiliar.set(patternKey, { patternKey, kinds, count: 1 });
      continue;
    }
    const times = members.map((m) => Date.parse(m.observedAt)).sort((a, b) => a - b);
    const category = members.find((m) => m.category)?.category ?? null;
    const org = members.find((m) => m.organization)?.organization?.trim() ?? null;
    const place = members.find((m) => m.place)?.place?.trim() ?? null;
    signals.push({
      label: 'SIGNAL',
      key: `${matched.id}|${key}`,
      subject: { organization: org, place },
      kinds,
      memberIds: members.map((m) => m.id).sort(),
      urls: [...new Set(members.flatMap((m) => m.urls))].sort(),
      windowFrom: new Date(times[0]!).toISOString(),
      windowTo: new Date(times[times.length - 1]!).toISOString(),
      industryNode: options.industryNodeFor ? options.industryNodeFor(category) : null,
      possibleNeed: matched.need,
      captureMethods: [...matched.methods],
      patternId: matched.id,
      qualifiers: [
        'a combination of events is a signal; it does not show anyone would pay',
        'events were matched on the organisation or place name, not on a verified identity',
      ],
    });
  }
  return {
    signals,
    unfamiliar: [...unfamiliar.values()].sort((a, b) => a.patternKey.localeCompare(b.patternKey)),
    stats: { records: observations.length, subjects: groups.size, modelJobs: 0, elapsedMs: Date.now() - started },
  };
}

/** A detector output as an observation. CONCENTRATED_HIRING is HIRING; other rules are OTHER until mapped. */
export function fromDetected(signal: DetectedSignal, ruleId = 'CONCENTRATED_HIRING'): Observation {
  return {
    id: signal.groupKey,
    origin: 'DETECTOR',
    kind: ruleId === 'CONCENTRATED_HIRING' ? 'HIRING' : 'OTHER',
    organization: signal.entityName,
    place: null,
    category: signal.category,
    observedAt: signal.windowTo,
    urls: signal.sourceUrls,
  };
}

const TRIGGER_KIND: Record<string, ObservationKind> = {
  'trigger-stale-job-post': 'STALE_JOB_POST',
  'trigger-platform-sunset': 'PLATFORM_SUNSET',
  'trigger-review-complaint': 'REVIEW_COMPLAINT',
  'trigger-new-location': 'EXPANSION',
  'trigger-new-rule': 'NEW_RULE',
};

/** A trigger-bucket finding as an observation; an unmapped bucket is OTHER, which no pattern requires. */
export function fromTrigger(input: { id: string; bucketId: string; organization: string | null; place?: string | null; observedAt: string; urls: readonly string[]; category?: string | null }): Observation {
  return {
    id: input.id,
    origin: 'TRIGGER',
    kind: input.bucketId === 'trigger-supply-shortage' ? 'SUPPLY_SHORTAGE' : (TRIGGER_KIND[input.bucketId] ?? 'OTHER'),
    organization: input.organization,
    place: input.place ?? null,
    category: input.category ?? null,
    observedAt: input.observedAt,
    urls: input.urls,
  };
}
