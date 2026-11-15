/**
 * Production probe for CHAL-33: the recommendation a live goal's plan reaches
 * is challenged independently, at the depth its own consequence earns.
 *
 * It reads what the running Brain composes for each live goal (the portfolio a
 * plan read builds, `persist: false`, so probing records nothing) and judges
 * the challenge attached to its assurance. It does not call the challenger.
 *  - UNKNOWN: no live goal, an unreadable plan, or no challenged recommendation
 *    yet (§39 — an absence is not a demonstration either way).
 *  - FAIL: a challenge that itself failed, a tier outside the three, a step
 *    with no tier of its own, a step held without saying what would clear it,
 *    or a self-agreement counted as independent validation.
 *  - PASS: every challenged recommendation is tiered by consequence, with each
 *    step cleared or held on its own tier.
 */
import type { ProbeResult } from '../probes.ts';
import type { PortfolioOf } from './causalProbe.ts';

const TIERS = new Set(['BASIC_INVARIANTS', 'STANDARD', 'DEEP']);

interface ChallengeLike {
  verdict?: unknown;
  error?: unknown;
  scrutiny?: { tier?: unknown; because?: unknown } | null;
  steps?: Array<{ key?: unknown; scrutiny?: { tier?: unknown } | null; mayProceed?: unknown; heldBy?: unknown }> | null;
  independentValidation?: { counted?: unknown; refusedAsSelfAgreement?: unknown } | null;
}

/** CHAL-33 on given portfolios. Pure. */
export function challengeHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const challenged = ps
    .map((p) => ({ goalId: p.goalId, c: (p.portfolio.assurance as { challenge?: ChallengeLike } | null | undefined)?.challenge ?? null }))
    .filter((one): one is { goalId: string; c: ChallengeLike } => one.c !== null && typeof one.c === 'object');
  if (challenged.length === 0) return { ok: null, detail: "no live goal's recommendation carries a challenge yet" };
  const tiers = new Map<string, number>();
  for (const { goalId, c } of challenged) {
    if (c.verdict === 'CHALLENGE_FAILED') return { ok: false, detail: `goal ${goalId}: the challenge of its recommendation failed (${String(c.error ?? 'no detail').slice(0, 120)})` };
    const tier = String(c.scrutiny?.tier);
    if (!TIERS.has(tier)) return { ok: false, detail: `goal ${goalId}: the challenge names no scrutiny tier (${tier})` };
    if (!Array.isArray(c.scrutiny?.because) || c.scrutiny.because.length === 0) return { ok: false, detail: `goal ${goalId}: the ${tier} tier does not say which consequence chose it` };
    if (!Array.isArray(c.steps)) return { ok: false, detail: `goal ${goalId}: the challenge does not clear or hold the plan's steps` };
    for (const step of c.steps) {
      if (!TIERS.has(String(step.scrutiny?.tier))) return { ok: false, detail: `goal ${goalId}: step ${String(step.key)} has no tier of its own` };
      if (step.mayProceed !== true && (!Array.isArray(step.heldBy) || step.heldBy.length === 0)) {
        return { ok: false, detail: `goal ${goalId}: step ${String(step.key)} is held without saying what would clear it` };
      }
    }
    const v = c.independentValidation;
    if (!v || typeof v.counted !== 'number' || typeof v.refusedAsSelfAgreement !== 'number') {
      return { ok: false, detail: `goal ${goalId}: the challenge does not separate independent checks from self-agreement` };
    }
    tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
  }
  return {
    ok: true,
    detail: `${challenged.length} challenged recommendation(s), tiered by consequence (${[...tiers].map(([t, n]) => `${t} ${n}`).join(', ')}), every step cleared or held on its own tier`,
  };
}

export async function challengeHoldsOnRows(): Promise<ProbeResult> {
  const { livePortfolios } = await import('./causalProbe.ts');
  const ps = await livePortfolios();
  if (!Array.isArray(ps)) return ps;
  return challengeHolds(ps);
}
