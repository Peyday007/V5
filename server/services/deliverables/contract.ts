/**
 * The two completion contracts, as the bin machinery asks them.
 *
 * The build contract runs the *whole* content validator — the same one the
 * ingest runs — while the worker still holds the lease. That is the tight
 * repair loop: a figure no cited claim states, a citation that is not a claim
 * of this project, a required content nobody covered, all come back as RETRY
 * with the reason, and the worker fixes it in the same session instead of
 * spending a build. The ingest runs it again anyway, because a lease can be
 * retaken and the claims can change.
 *
 * The review contract is shallow for `evaluateDesignReview`'s reason: it
 * decides whether the bin may finish, and independence — which needs Brain's
 * record of the fire — is decided at ingest.
 */
import type { Bin } from '../../domain/types.ts';
import { listBinUnitResults } from '../../repos/bins.ts';
import { getDeliverableByActiveBin } from '../../repos/deliverables.ts';
import { validateContent } from './content.ts';
import { resolverFor } from './evidence.ts';
import { validateReview, REVIEW_UNIT_KEY } from './review.ts';

export interface DeliverableVerdict {
  satisfied: boolean;
  reasons: string[];
  observed: Record<string, unknown>;
}

export async function evaluateBuild(bin: Bin): Promise<DeliverableVerdict> {
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((r) => r.unitKey === 'content');
  const observed: Record<string, unknown> = { unitsSubmitted: results.length, hasContent: Boolean(submitted) };
  if (!submitted) return { satisfied: false, reasons: ['No content was submitted under the unit key "content".'], observed };
  const d = await getDeliverableByActiveBin(bin.id);
  if (!d) {
    // A bin no deliverable is waiting on any more. Letting it finish costs
    // nothing: the ingest reads only the active bin.
    return { satisfied: true, reasons: [], observed: { ...observed, orphaned: true } };
  }
  const result = await validateContent({ raw: submitted.value, kind: d.kind, spec: d.spec, resolve: resolverFor(d.projectId) });
  if (!result.ok) return { satisfied: false, reasons: result.problems.slice(0, 25), observed: { ...observed, problems: result.problems.length } };
  return { satisfied: true, reasons: [], observed: { ...observed, cited: result.citedClaimIds.length } };
}

export async function evaluateReview(bin: Bin): Promise<DeliverableVerdict> {
  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((r) => r.unitKey === REVIEW_UNIT_KEY);
  const observed: Record<string, unknown> = { unitsSubmitted: results.length, hasReview: Boolean(submitted) };
  if (!submitted) return { satisfied: false, reasons: ['No review was submitted under the unit key "review".'], observed };
  const d = await getDeliverableByActiveBin(bin.id);
  if (!d) return { satisfied: true, reasons: [], observed: { ...observed, orphaned: true } };
  const result = validateReview(submitted.value, d.spec, new Set());
  // Gaps are judged at ingest against the version's own content; here only
  // the shape matters, so a PASS that marks a declared gap unmet is let
  // through to be judged where the gaps are known.
  if (!result.ok && !result.problems.every((p) => p.includes('not declared as gaps'))) {
    return { satisfied: false, reasons: result.problems, observed };
  }
  return { satisfied: true, reasons: [], observed };
}
