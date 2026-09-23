/**
 * What settles each kind of need, read rather than taken on somebody's word.
 *
 * `closeNeed` used to accept any non-empty sentence, so "done" resolved a need
 * whose capability was still missing and the piece it blocked went back to
 * waiting on something that had not happened. The condition is checkable for
 * exactly the needs Brain raised — it wrote the key, so it knows what to read —
 * and `null` for anything else, which is what makes an authorized manual
 * substitute the honest route rather than a loophole.
 *
 * **It lives in its own module because being registered was the bug.** It was
 * an injected reader wired by a side effect of importing `operate.ts`, on the
 * reasoning that the readings live in modules that import `needs.ts` and a
 * cycle between them is a load-order bug waiting to be found by whichever file
 * loads first. The reasoning was right about cycles and wrong about this one:
 * what settles a condition is `capabilities.ts`, `card.ts` and
 * `cashPortfolio.ts`, and none of the three imports `needs.ts` — so there was
 * never a cycle to break here. The only thing actually crossing was
 * `questionKey`, which lived in `answers.ts`, and which is a string builder
 * rather than a reading.
 *
 * What the injection cost was real. `operate.ts` is imported by exactly one
 * module in the whole server, the Russell tick — so the route a person's
 * browser calls to close a need reached `closeNeed` with the **default**
 * reader in any process that had not also loaded the loop. The default is
 * "nothing here can check this", and that path records the person's word as a
 * `PERSON_SUBSTITUTE` rather than refusing: a person pressing *Mark this done*
 * with "Done." would have resolved a need whose capability was still missing,
 * which is exactly what `verified_by` exists to prevent. It was found by
 * driving the screen against the real routes; every service test passed,
 * because they import `operate.ts`.
 *
 * So it is a plain function now. There is nothing to register and nothing to
 * forget.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { readCapability } from './capabilities.ts';
import { evidenceCard } from './card.ts';
import type { CashNeed } from '../../domain/types.ts';

export interface NeedVerification {
  /** Whether the condition this need named actually holds now. */
  holds: boolean;
  /** What Brain read to decide, in the words a person is owed. */
  reading: string;
}

/**
 * The key a discoverable blank is raised under.
 *
 * `question:` rather than `capability:` because the two are answered by
 * different things, and `startDependentWork` reads exactly that prefix to
 * decide what research can settle. A missing payer is a fact somebody could
 * look up; a missing payment processor is an integration, and captured ideas
 * about integrations are questions nobody can research.
 *
 * Rebuilt per field rather than parsed apart: Brain wrote it, so the field it
 * names is found by constructing the key again and comparing, and nothing
 * anywhere infers from prose which blank a need was raised for.
 */
export function questionKey(opportunityId: string, field: string): string {
  return `question:${opportunityId}:${field}`;
}

/**
 * Does this need's completion condition actually hold?
 *
 * `null` is a third answer and not a pass: it means Brain has no way to check
 * this particular condition, which is what makes an authorized manual
 * substitute the honest route rather than a loophole. "We could not tell" must
 * never read the same as "we checked".
 */
export async function readNeedCondition(need: CashNeed): Promise<NeedVerification | null> {
  if (!need.requestKey) return null;

  if (need.requestKey.startsWith('capability:')) {
    const capabilityId = need.requestKey.slice(need.requestKey.lastIndexOf(':') + 1);
    const reading = await readCapability(capabilityId, need.projectId);
    return {
      holds: reading.state === 'PRESENT',
      reading:
        reading.state === 'PRESENT'
          ? `${reading.id} reads PRESENT.`
          : `${reading.id} still reads ${reading.state}.`,
    };
  }

  if (need.requestKey.startsWith('question:') && need.opportunityId) {
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) return null;
    for (const field of evidenceCard(opportunity).fields) {
      if (questionKey(need.opportunityId, field.key) !== need.requestKey) continue;
      return {
        holds: field.value !== null,
        reading:
          field.value !== null
            ? `The ${field.label.toLowerCase()} is on the card.`
            : `The ${field.label.toLowerCase()} is still blank.`,
      };
    }
    return null;
  }

  return null;
}
