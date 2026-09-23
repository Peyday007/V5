/**
 * The source material a deliverable may be built from.
 *
 * Two readers, one rule. `resolverFor` answers the validator's question — which
 * of these ids are citable claims of this project now — and `evidencePack`
 * chooses which claims to put in front of the worker, carried whole in the
 * bin's manifest because no worker tool dereferences a claim id (§37 records
 * three leases refusing a bare id they could not read).
 *
 * The pack is ordered by how much each claim shares with the request's own
 * words, bounded by a character budget so the manifest stays under its limit.
 * A claim left out of the pack is still citable — the resolver asks the whole
 * project — and the manifest says how many were left out, so a worker that
 * needs more knows there is more rather than concluding the archive is thin.
 */
import { projectCitableClaims } from '../../repos/research.ts';
import type { ResearchClaim } from '../../domain/types.ts';
import type { DeliverableSpec } from '../../domain/deliverables.ts';
import type { ClaimResolver, EvidenceClaim } from './content.ts';

export function toEvidence(claim: ResearchClaim): EvidenceClaim {
  return {
    id: claim.id,
    claim: claim.claim,
    sourceUrl: claim.sourceUrl ?? '',
    sourceTitle: claim.sourceTitle,
    sourcePublisher: claim.sourcePublisher,
    sourceDate: claim.sourceDate,
    excerpt: claim.evidenceExcerpt,
    locator: claim.evidenceLocator,
  };
}

export function resolverFor(projectId: string): ClaimResolver {
  return async (ids) => {
    const found = await projectCitableClaims(projectId, [...new Set(ids)]);
    return new Map(found.map((one) => [one.id, toEvidence(one)]));
  };
}

const STOP = new Set(
  'the a an and or of to in for on with by from at as is are be this that it its into about which what who how whether each per their there than then also any all our your not no do does'.split(' '),
);

export function termsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** The budget for the claims carried in one manifest, in characters. */
export const PACK_CHAR_BUDGET = 40_000;

export interface EvidencePack {
  claims: EvidenceClaim[];
  totalCitable: number;
  omitted: number;
}

export async function evidencePack(input: {
  projectId: string;
  title: string;
  spec: DeliverableSpec;
  extraText?: string;
  budget?: number;
}): Promise<EvidencePack> {
  const all = (await projectCitableClaims(input.projectId)).map(toEvidence);
  const wanted = termsOf(
    [input.title, input.spec.intendedUse, ...input.spec.requiredContents, input.spec.sourceRequirements, input.extraText ?? ''].join(' '),
  );
  const scored = all.map((claim, index) => {
    const terms = termsOf(`${claim.claim} ${claim.sourceTitle ?? ''} ${claim.sourcePublisher ?? ''}`);
    let hits = 0;
    for (const t of terms) if (wanted.has(t)) hits += 1;
    return { claim, hits, index };
  });
  scored.sort((a, b) => b.hits - a.hits || a.index - b.index);
  const budget = input.budget ?? PACK_CHAR_BUDGET;
  const chosen: EvidenceClaim[] = [];
  let used = 0;
  for (const { claim } of scored) {
    const trimmed: EvidenceClaim = { ...claim, excerpt: claim.excerpt ? claim.excerpt.slice(0, 400) : null };
    const size = JSON.stringify(trimmed).length;
    if (used + size > budget) continue;
    chosen.push(trimmed);
    used += size;
  }
  return { claims: chosen, totalCitable: all.length, omitted: all.length - chosen.length };
}
