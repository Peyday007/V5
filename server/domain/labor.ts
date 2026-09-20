/**
 * What a labor finding means, and the one place a declared one is validated.
 *
 * ---------------------------------------------------------------------------
 * A lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * `domain/industry.ts` and `domain/opportunitySignals.ts` make the same
 * argument for the same reason: the judgement is made once, by the only party
 * that can make it — somebody who read the source — and everything after that
 * is Brain matching a value from a closed set exactly. Nothing here inspects a
 * sentence, and in particular nothing here decides from prose whether a job
 * needs a person. That decision is the one this whole kernel exists to make
 * carefully, and a regular expression over a claim would make it carelessly.
 *
 * ---------------------------------------------------------------------------
 * Two readers, one rule
 * ---------------------------------------------------------------------------
 *
 * `services/research/schema.ts` checks a pass a provider returned;
 * `mcp/researchTools.ts` checks a claim a worker submitted over the wire. This
 * repository has had to write *a rule applied by one of two readers is worse
 * than none* five times, and every instance was two implementations that
 * agreed on the day they were written. So both call this, and it is the only
 * thing that decides.
 *
 * ---------------------------------------------------------------------------
 * Refused here, where the worker can still fix it
 * ---------------------------------------------------------------------------
 *
 * Every failure below refuses the whole submission rather than dropping the
 * field. §27 records why: truncation and silent dropping are the outcomes a
 * worker cannot recover from, because they are reported as success. Refused,
 * the worker corrects one field and submits the same claims again on the same
 * item, with the attempt still there to spend.
 */
import {
  HUMAN_NECESSITY_REASONS,
  LABOR_CHANNELS,
  LABOR_FINDINGS,
  NECESSITY_QUESTIONS,
  PRODUCTION_LAYERS,
  RATE_BASES,
  NON_HUMAN_LAYERS,
  type HumanNecessityReason,
  type LaborChannel,
  type LaborFinding,
  type NecessityQuestion,
  type ProductionLayer,
  type RateBasis,
} from './types.ts';

export { LABOR_FINDINGS };
export type { LaborFinding };

export function isLaborFinding(value: unknown): value is LaborFinding {
  return typeof value === 'string' && (LABOR_FINDINGS as readonly string[]).includes(value);
}

export function isHumanNecessityReason(value: unknown): value is HumanNecessityReason {
  return (
    typeof value === 'string' && (HUMAN_NECESSITY_REASONS as readonly string[]).includes(value)
  );
}

export function isLaborChannel(value: unknown): value is LaborChannel {
  return typeof value === 'string' && (LABOR_CHANNELS as readonly string[]).includes(value);
}

export function isRateBasis(value: unknown): value is RateBasis {
  return typeof value === 'string' && (RATE_BASES as readonly string[]).includes(value);
}

export function isProductionLayer(value: unknown): value is ProductionLayer {
  return typeof value === 'string' && (PRODUCTION_LAYERS as readonly string[]).includes(value);
}

export function isNecessityQuestion(value: unknown): value is NecessityQuestion {
  return typeof value === 'string' && (NECESSITY_QUESTIONS as readonly string[]).includes(value);
}

/** Whether a layer is a person, which is what decides if a reason is required. */
export function layerIsHuman(layer: ProductionLayer): boolean {
  return !NON_HUMAN_LAYERS.includes(layer);
}

/**
 * Where a finding's subject comes from. Both kinds have a closed set.
 *
 * Both answer a question Brain asks across every task, and an answer in
 * somebody's own words could not be compared across them. What the source
 * actually said — which regulator, which agency, which tool — is in the claim
 * itself, which is where a sentence belongs.
 */
export function subjectVocabularyFor(finding: LaborFinding): readonly string[] {
  return finding === 'HUMAN_REQUIREMENT' ? HUMAN_NECESSITY_REASONS : LABOR_CHANNELS;
}

/** Only a sourcing channel carries a figure, and only it carries a basis. */
export function findingTakesRate(finding: LaborFinding): boolean {
  return finding === 'SOURCING_CHANNEL';
}

/**
 * The necessity question a HUMAN_REQUIREMENT finding answers, or null.
 *
 * A `Record` over the whole reason union rather than a partial map, so a reason
 * added later is a compile error until somebody says which question it settles
 * — §27's lesson about two sets that must be total between them.
 *
 * Three of the six answer a question directly and three do not, and the three
 * that do not are the point. `EXPERT_JUDGMENT`, `EXCEPTION_HANDLING` and
 * `OVERSIGHT_VERIFICATION` are statements about *this operation's* confidence
 * in Brain, and no published source about an industry can settle one: a trade
 * body can tell you a notary must sign, and it cannot tell you whether your
 * Brain verifies its own output well enough. So a finding declaring one of
 * them is recorded as evidence on its claim and answers nothing, rather than
 * being allowed to move a question it has no standing to move.
 */
const ANSWERS: Readonly<Record<HumanNecessityReason, NecessityQuestion | null>> = Object.freeze({
  ACCOUNTABILITY_LICENSING: 'REQUIRES_LICENSED_HUMAN',
  PHYSICAL_EXECUTION: 'REQUIRES_PHYSICAL_PRESENCE',
  HUMAN_INTERFACE: 'HUMAN_INTERACTION_ADDS_VALUE',
  EXPERT_JUDGMENT: null,
  EXCEPTION_HANDLING: null,
  OVERSIGHT_VERIFICATION: null,
});

export function questionAnsweredBy(reason: HumanNecessityReason): NecessityQuestion | null {
  return ANSWERS[reason];
}

/**
 * One line per finding, for the assignment a worker actually reads.
 *
 * §33 records why this belongs in the assignment rather than only on the
 * submission tool: by the time somebody is filling in a claim they have
 * already decided what they were looking for, and the submission tool is the
 * wrong end of the job.
 */
export const LABOR_FINDING_GUIDE: Readonly<Record<LaborFinding, string>> = Object.freeze({
  HUMAN_REQUIREMENT:
    'a published rule or documented practice requires a person for work of this kind — set ' +
    'labor_subject to which of the six reasons it is',
  SOURCING_CHANNEL:
    'a published way this capability is actually obtained — set labor_subject to the channel, ' +
    'and labor_rate_cents with labor_qualifier where a source states what it costs',
});

/** The closed sets a subject comes from, composed rather than restated. */
export const LABOR_SUBJECT_GUIDE = [
  `HUMAN_REQUIREMENT — one of ${HUMAN_NECESSITY_REASONS.join(', ')}`,
  `SOURCING_CHANNEL — one of ${LABOR_CHANNELS.join(', ')}, including SOFTWARE_TOOL where a ` +
    'published source shows this work being done by software rather than by a person',
].join('; ');

export interface LaborDeclaration {
  finding: LaborFinding | null;
  subject: string | null;
  qualifier: RateBasis | null;
  rateCents: number | null;
}

export type LaborCheck = { ok: true; value: LaborDeclaration } | { ok: false; error: string };

export function validateLabor(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  qualifier: unknown;
  rateCents: unknown;
}): LaborCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const qualifier = tidy(input.qualifier);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about how the work is produced,
     * which is most claims. Its companions must then be absent too: a subject
     * with no finding is a value nothing will ever read, and storing it would
     * look like it had done something.
     */
    if (subject) {
      return {
        ok: false,
        error:
          `${where}: labor_subject was given with no labor_finding. Say which kind of fact ` +
          'about how this work is produced it establishes, or leave the subject out.',
      };
    }
    if (qualifier) {
      return { ok: false, error: `${where}: labor_qualifier was given with no labor_finding.` };
    }
    if (!absent(input.rateCents)) {
      return { ok: false, error: `${where}: labor_rate_cents was given with no labor_finding.` };
    }
    return { ok: true, value: { finding: null, subject: null, qualifier: null, rateCents: null } };
  }

  if (!isLaborFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: labor_finding must be one of ${LABOR_FINDINGS.join(', ')}, or omitted when ` +
        'the claim says nothing about who or what performs work of this kind.',
    };
  }
  const finding = input.finding;

  const vocabulary = subjectVocabularyFor(finding);
  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set labor_subject. It must be one of ` +
        `${vocabulary.join(', ')}.`,
    };
  }
  if (!vocabulary.includes(subject)) {
    return {
      ok: false,
      error:
        `${where}: labor_subject for a ${finding} finding must be one of ` +
        `${vocabulary.join(', ')}. "${subject}" is not one of them — say which of those this ` +
        'is, and put the detail in the claim itself.',
    };
  }

  if (!findingTakesRate(finding)) {
    if (qualifier) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so labor_qualifier must be ` +
          'omitted. Only SOURCING_CHANNEL has a rate and a basis for it.',
      };
    }
    if (!absent(input.rateCents)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so labor_rate_cents must be ` +
          'omitted. Only SOURCING_CHANNEL has one.',
      };
    }
    return { ok: true, value: { finding, subject, qualifier: null, rateCents: null } };
  }

  if (absent(input.rateCents)) {
    /*
     * A channel with no published rate is an ordinary and useful finding: it
     * establishes that the capability can be obtained this way and says
     * nothing about what it costs. So the basis must be absent too — a basis
     * with nothing to be the basis *of* is a value nothing reads.
     */
    if (qualifier) {
      return {
        ok: false,
        error:
          `${where}: labor_qualifier was given with no labor_rate_cents. A basis with no figure ` +
          'measures nothing. Submit the channel with neither where no source publishes a rate — ' +
          'that is recorded as an unknown rate, which is the correct outcome.',
      };
    }
    return { ok: true, value: { finding, subject, qualifier: null, rateCents: null } };
  }

  if (
    typeof input.rateCents !== 'number' ||
    !Number.isFinite(input.rateCents) ||
    !Number.isInteger(input.rateCents) ||
    input.rateCents < 0
  ) {
    return {
      ok: false,
      error:
        `${where}: labor_rate_cents must be a whole number of minor units, not negative. Leave ` +
        'it out where no source publishes a rate — an unknown is recorded as unknown and is ' +
        'never read as cheap.',
    };
  }

  if (!qualifier) {
    return {
      ok: false,
      error:
        `${where}: a rate must say what it is quoted on. Set labor_qualifier to one of ` +
        `${RATE_BASES.join(', ')} — "40.00" compares to nothing, and reading the basis out of ` +
        'the claim sentence would get an order of magnitude wrong silently.',
    };
  }
  if (!isRateBasis(qualifier)) {
    return {
      ok: false,
      error: `${where}: labor_qualifier must be one of ${RATE_BASES.join(', ')}.`,
    };
  }

  return { ok: true, value: { finding, subject, qualifier, rateCents: input.rateCents } };
}
