/**
 * Decide, for one unit of work, which resource runs it: plain code, the free
 * cheap lane, or Claude.
 *
 * Pure: it takes what the unit requires and what has been measured, and
 * answers with the choice, the reasons and every alternative it passed over.
 * Order is cost, cheapest first, and each step must be earned:
 *
 *   CODE   an ACTIVE detector covers it, or an algorithm does the work on
 *          structured data whose result code can check.
 *   CHEAP  the answer is closed, no tools or internet are needed, the result
 *          does not need the evidence gate, and the free model's *measured*
 *          reliability clears the stored threshold with a real sample.
 *   STRONG everything else, including every unfamiliar problem.
 *
 * Unmeasured is never reliable: a free model with no record is not trusted.
 */
import {
  MAX_CONSECUTIVE_FAILURES,
  MIN_MEASURED_ATTEMPTS,
  type ClassifyInput,
  type RoutingChoice,
} from '../types.ts';

export function classifyWork(input: ClassifyInput): RoutingChoice {
  const { requirements: r, cheapMeasure: m } = input;
  const alternatives: string[] = [];

  if (r.activeDetectorId) {
    return {
      resource: 'CODE',
      reasons: [`ACTIVE_DETECTOR:${r.activeDetectorId}`],
      alternatives: ['CHEAP: not needed, code covers it', 'STRONG: not needed, code covers it'],
    };
  }
  if (r.algorithmAvailable && r.structuredInput && !r.needsInternet && r.verification !== 'EVIDENCE_GATE') {
    return {
      resource: 'CODE',
      reasons: ['ALGORITHM_AVAILABLE', 'STRUCTURED_INPUT', `VERIFICATION:${r.verification}`],
      alternatives: ['CHEAP: not needed, an algorithm does it', 'STRONG: not needed, an algorithm does it'],
    };
  }
  alternatives.push(
    r.algorithmAvailable
      ? 'CODE: an algorithm exists but the input is not structured, needs the internet, or needs the evidence gate'
      : 'CODE: no algorithm or ACTIVE detector covers this',
  );

  const cheapBlockers: string[] = [];
  if (!r.closedAnswerSet) cheapBlockers.push('the answer is not a closed set');
  if (r.needsTools) cheapBlockers.push('it needs tools');
  if (r.needsInternet) cheapBlockers.push('it needs the internet');
  if (r.verification === 'EVIDENCE_GATE') cheapBlockers.push('its result must pass the evidence gate');
  if (cheapBlockers.length === 0) {
    if (!m || m.attempts < MIN_MEASURED_ATTEMPTS) {
      cheapBlockers.push(`the free model has no measured record (needs ${MIN_MEASURED_ATTEMPTS} attempts)`);
    } else if (m.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      cheapBlockers.push(`the free model failed ${m.consecutiveFailures} times in a row`);
    } else {
      const rate = m.successes / m.attempts;
      if (rate < input.cheapThreshold) {
        cheapBlockers.push(`measured reliability ${rate.toFixed(2)} is below the stored ${input.cheapThreshold}`);
      } else {
        alternatives.push('STRONG: not needed, the free model clears the stored reliability');
        return {
          resource: 'CHEAP',
          reasons: ['CLOSED_ANSWER_SET', `MEASURED_RELIABILITY:${rate.toFixed(2)}`, `SAMPLE:${m.attempts}`],
          alternatives,
        };
      }
    }
  }
  alternatives.push(`CHEAP: ${cheapBlockers.join('; ')}`);
  return { resource: 'STRONG', reasons: ['NO_CHEAPER_RESOURCE_QUALIFIES'], alternatives };
}
