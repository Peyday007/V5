/**
 * Research that came back becomes reusable knowledge, or it was a pile of links.
 *
 * ---------------------------------------------------------------------------
 * The half of the research route that was missing
 * ---------------------------------------------------------------------------
 *
 * `design_patterns.origin` declares `RESEARCH` and, until this module, **nothing
 * wrote it**. That is the defect this repository keeps recording under its own
 * name: a mechanism nothing calls is not a mechanism, and a vocabulary with an
 * unreachable value is worse than one without it, because a reader assumes the
 * path exists.
 *
 * The consequence was the specific thing the design brief warns about. An
 * expansion routed to `RESEARCH` created a candidate, the candidate became a
 * mission, the mission ran the whole pipeline — archive check, compiler,
 * approval envelope, evidence gate, three audit roles — and what came back sat
 * in `research_claims` as a filed report. Useful to read, and **not knowledge
 * the kernel could apply to the next screen**: the next design problem would be
 * assembled from the same seven seed patterns as before, with the research
 * nowhere in it.
 *
 * ---------------------------------------------------------------------------
 * A claim becomes a pattern, and the claim stays the evidence
 * ---------------------------------------------------------------------------
 *
 * Each citable claim becomes one `PROPOSED` pattern whose statement is the
 * claim's own sentence and whose evidence is the claim id and its source URL.
 * Three properties make that safe rather than a way of laundering prose into
 * rules:
 *
 *   **Only claims that cleared the gate.** `citableClaims` is the same read
 *   `assignment.ts` uses for a filed report: accepted, on a fragment that
 *   reached `ACCEPTED` or `BLOCKED`. A rejected claim contributes nothing, and
 *   §12's rule that acceptance is decided once at the gate means nothing can
 *   re-enter here.
 *
 *   **Nothing is rewritten.** The statement is the claim verbatim. Composing a
 *   nicer sentence out of a claim would be model prose becoming a rule with the
 *   citation still attached — §8's defect at the one place it would be least
 *   visible, because the citation would still check out.
 *
 *   **`PROPOSED`, never `ACTIVE`.** The same bar a compiled recurrence and an
 *   owner's promoted correction are held to. A claim that cleared the evidence
 *   gate is a true statement about the world; whether this product should follow
 *   it is a second decision, and the two are not the same.
 *
 * ---------------------------------------------------------------------------
 * And absorbing is not promoting
 * ---------------------------------------------------------------------------
 *
 * An expansion whose research came back settles at `EVALUATED`, not `PROMOTED`.
 * §37's rule is that a dimension moves only when a *reading* of the capability
 * says it moved, and knowing how other interfaces solve dense chronology does
 * not give Brain the ability to judge it — that is still code somebody has to
 * write. Settling it `PROMOTED` would be the merged-pull-request lie one artifact
 * along.
 */
import type { DesignExpansion, DesignPattern, DesignPrimitive } from '../../domain/design.ts';
import { isDesignPrimitive } from '../../domain/design.ts';
import { listExpansions, settleExpansion, upsertPattern } from '../../repos/design.ts';
import { getCapability } from '../../repos/design.ts';
import { citableClaims } from '../../repos/research.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { patternFingerprint } from './patterns.ts';

/**
 * How many claims one piece of research may contribute.
 *
 * A bound rather than a judgement about which are best: a packet that produced
 * forty claims has said forty things, and taking the first handful in the gate's
 * own order is the only selection that does not require somebody to decide which
 * design advice is worth keeping — which is exactly the decision this module
 * must not make. The rest stay in `research_claims` and are still readable.
 */
export const MAX_ABSORBED_PER_EXPANSION = 8;

export interface AbsorbedResearch {
  expansionId: string;
  capabilityKey: string;
  patterns: DesignPattern[];
  outcome: string;
}

/**
 * Turn finished design research into patterns.
 *
 * Derived from rows on the tick rather than hooked to a mission completing, for
 * the reason this repository has needed six times: a hook fixes one entrance and
 * a derivation reaches every entrance plus everything already stranded — here,
 * research that came back before this module existed.
 *
 * Idempotent by fingerprint and by the expansion's own state, so a tick that
 * dies halfway leaves the next one able to finish rather than double.
 */
export async function absorbFinishedResearch(): Promise<AbsorbedResearch[]> {
  const out: AbsorbedResearch[] = [];

  for (const expansion of await listExpansions({ state: 'ROUTED', limit: 50 })) {
    if (expansion.route !== 'RESEARCH' || expansion.routeRef === null) continue;

    const mission = await latestMissionForCandidate(expansion.routeRef);
    if (!mission || mission.orchestrationId === null) continue;

    const claims = await citableClaims(mission.orchestrationId);
    if (claims.length === 0) {
      /*
       * A mission that finished and established nothing citable is settled, not
       * left live. §33 records what a rejection with no reason on it costs, and
       * an expansion sitting `ROUTED` for ever would make a gap that was
       * genuinely investigated look like one nobody had got to.
       */
      if (mission.state === 'DONE' || mission.state === 'FAILED') {
        const outcome =
          `The research ran and produced no claim that cleared the evidence gate, so there is ` +
          'nothing to absorb. The gap is still open and will be offered again after the cool-off.';
        if (await settleExpansion({ id: expansion.id, state: 'REJECTED', outcome })) {
          out.push({
            expansionId: expansion.id,
            capabilityKey: expansion.capabilityKey,
            patterns: [],
            outcome,
          });
        }
      }
      continue;
    }

    const primitive = await primitiveFor(expansion);
    const patterns: DesignPattern[] = [];

    for (const claim of claims.slice(0, MAX_ABSORBED_PER_EXPANSION)) {
      const statement = claim.claim.trim();
      if (statement.length === 0) continue;

      const { pattern } = await upsertPattern({
        primitive,
        /*
         * The branch is the capability the research was about, which is the one
         * label the whole set genuinely shares. Inventing a prettier name would
         * be naming a distinction nobody established — `emergingBranches` is
         * there to *notice* one, not to manufacture it.
         */
        branch: expansion.capabilityKey.toLowerCase().replace(/_/g, ' '),
        statement,
        appliesWhen:
          `Research into ${expansion.capabilityKey.toLowerCase().replace(/_/g, ' ')} established ` +
          'this. It has not yet been held against a screen of this product, so where it applies ' +
          'here is exactly what accepting it would be deciding.',
        exceptions:
          claim.geography || claim.timeframe || claim.population
            ? `Established for ${[claim.geography, claim.timeframe, claim.population]
                .filter(Boolean)
                .join(', ')} — outside that scope it is unestablished rather than false.`
            : null,
        scope: 'GLOBAL',
        scopeRef: null,
        /*
         * MEDIUM at most, whatever the gate concluded. A claim that cleared the
         * evidence gate is a well-sourced statement about interfaces in general;
         * HIGH here is reserved for a lesson this product has actually paid for,
         * which is what the seed patterns and the owner's corrections are.
         */
        confidence: claim.primarySource ? 'MEDIUM' : 'LOW',
        origin: 'RESEARCH',
        evidence: [
          `research_claim:${claim.id}`,
          ...(claim.sourceUrl ? [claim.sourceUrl] : []),
          ...(claim.sourcePublisher ? [`publisher: ${claim.sourcePublisher}`] : []),
          `design_expansion:${expansion.id}`,
        ],
        state: 'PROPOSED',
        fingerprint: patternFingerprint({
          primitive,
          scope: 'GLOBAL',
          scopeRef: null,
          statement,
        }),
      });
      patterns.push(pattern);
    }

    const outcome =
      `${patterns.length} claim(s) that cleared the evidence gate are now proposed design ` +
      'patterns, each carrying its claim id and source. Whether this product follows any of them ' +
      'is a second decision: they are PROPOSED. The capability itself is unchanged — knowing how ' +
      'something is done is not the same as being able to do it.';

    if (await settleExpansion({ id: expansion.id, state: 'EVALUATED', outcome })) {
      out.push({
        expansionId: expansion.id,
        capabilityKey: expansion.capabilityKey,
        patterns,
        outcome,
      });
    }
  }

  return out;
}

/**
 * Which design concern the research belongs under.
 *
 * From the capability it was asked about, because that is a row rather than a
 * reading of the claims' prose — §25's rule at a classification. A capability
 * that has since been removed falls back to the one concern every piece of
 * design knowledge is at least about.
 */
async function primitiveFor(expansion: DesignExpansion): Promise<DesignPrimitive> {
  const capability = await getCapability(expansion.capabilityKey);
  if (capability && isDesignPrimitive(capability.primitive)) return capability.primitive;
  return 'INFORMATION_HIERARCHY';
}
