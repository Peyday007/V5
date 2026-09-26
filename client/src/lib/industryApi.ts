/**
 * The industry map (§38) over HTTP.
 *
 * Thin by design, and declaring its own types rather than importing a server
 * module — the same choice `client/src/russell/Labor.tsx` makes for
 * `LaborView`, for the identical reason: nothing here reads or derives
 * anything, so there is no service module whose shape this file needs to
 * share, only the wire contract the route already promises.
 */
import { api } from './api.ts';

const p = (value: string): string => encodeURIComponent(value);

/** A single subject on the map, exactly as `SubjectView` reports it. */
export interface IndustrySubjectView {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  /** Root-first, because a leaf name on its own says nothing. */
  path: string[];
  depth: number;
  origin: string;
  description: string | null;
  verdict: string;
  because: string;
  children: number;
  openings: number;
  constraints: number;
  /** Settled rounds, and whether a question about it is live right now. */
  mapRounds: number;
  scanRounds: number;
  live: boolean;
  /** Of the ten ways money is reachable, how many have been asked here. */
  bucketsAsked: number;
  bucketsTotal: number;
  lastAskedAt: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

/** What an opening's capital requirement takes apart, exactly as `CapitalView` reports it. */
export interface IndustryCapitalView {
  opportunityId: string;
  title: string;
  /** What the owner actually has to fund, or null with the reason. */
  minimumOwnerCents: number | null;
  unknown: string | null;
  /** The band it falls in. Presentation — the decision is the comparison. */
  tier: string | null;
  /** Measured against the money that exists, never against a band. */
  executableNow: 'YES' | 'NO' | 'UNKNOWN';
  requirements: { requirement: string; grossCents: number | null; netCents: number | null }[];
  mechanisms: string[];
  removedCents: number | null;
  cashNow: { facts: string[]; unknown: string[] };
  positionLater: { facts: string[]; unknown: string[] };
  constraints: string[];
}

/** What a control on this screen may be offered for — never the control itself. */
export interface IndustryCapabilities {
  /** Name a subject. Project `ADMIN`. */
  maySeed: boolean;
  /** Retire one. Project `ADMIN`. */
  mayRetire: boolean;
  /** Why not, in the server's own words, or null where there is nothing to say. */
  because: string | null;
}

/** The closed set a form on this screen may offer, sent with the reading. */
export interface IndustryVocabulary {
  industryNodeKinds: string[];
}

export interface IndustryView {
  projectId: string;
  /** Every live subject, root-first then by name, so the order is stable. */
  subjects: IndustrySubjectView[];
  /** Subjects a person retired, kept and shown rather than hidden. */
  retired: IndustrySubjectView[];
  /** Whether the map has been started at all, and how. */
  bootstrap: { asked: boolean; open: boolean; found: number | null };
  /** What Brain would ask next, and why. Reading this creates nothing. */
  next: { purpose: string; subject: string; why: string }[];
  /** Why something was considered and not asked. */
  declined: { subject: string; why: string }[];
  /** Openings whose capital has been taken apart. */
  capital: IndustryCapitalView[];
  /** The money the comparison above was made against, stated rather than implied. */
  deployableCents: number;
  /** How many kinds of subject the map currently holds, by kind. */
  byKind: Record<string, number>;
  capabilities: IndustryCapabilities;
  vocabulary: IndustryVocabulary;
}

/** The raw row a seed or a retire returns, exactly as `IndustryNode` is stored. */
export interface IndustryNodeRow {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: string;
  name: string;
  description: string | null;
  origin: string;
  sourceClaimId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getIndustryView(projectId: string): Promise<IndustryView> {
  return api<IndustryView>(`/api/projects/${p(projectId)}/cash/industries`);
}

export function seedIndustrySubject(
  projectId: string,
  body: { name: string; kind?: string; description?: string; parentId?: string; reason?: string },
): Promise<{ subject: IndustryNodeRow; created: boolean; message: string }> {
  return api(`/api/projects/${p(projectId)}/cash/industries`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function retireIndustrySubject(
  projectId: string,
  nodeId: string,
  reason: string,
): Promise<{ subject: IndustryNodeRow; message: string }> {
  return api(`/api/projects/${p(projectId)}/cash/industries/${p(nodeId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
}
