/**
 * Acceptance run 12 (frozen 30835d5) failures, kept as regressions on the real records archived in
 * docs/planning-session-reliability-2026-11-26/run12-acceptance.
 *
 * ap-01, ap-03, ap-04: each sound opening's price was a current comparable listing on the buyers' own marketplace, and
 * the seller's own outreach measured paid conversion. Brain's planner had OFFER_AND_PRICE established. The reviewer held
 * it unestablished as "what other sellers ask" and as "agreements without a price"; the authors accepted and the plans
 * went CONDITIONAL. An independent adjudication (adjudication-ap01-ap03-ap04.md) found the plans defective.
 *
 * Two causes, each repaired at its owner:
 * - Brain's input: the bench world rendered the case's measured `paid` as "27 agreements from 300 contacts", which reads
 *   as something other than a purchase. It now says "27 paid orders from 300 contacts", and Brain's reader parses both
 *   the same way.
 * - The review gate: a condition against a price Brain's planner establishes must name the defect the spec recognises
 *   (only a person's word, contradicted, not a purchase price). Otherwise it is refused.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { conditionProblems, type CardFacts, type PlanRevisionInput, type ReviewCondition } from '../server/domain/sessionPlanning.ts';
import { conversionSentence } from '../bench/planningReliability/case.ts';

const RUN12 = 'docs/planning-session-reliability-2026-11-26/run12-acceptance';
interface Opening { opportunityId: string; links?: { link: string; ok: boolean }[]; facts?: { field: string; kind: string }[] }
const inputs = JSON.parse(fs.readFileSync(`${RUN12}/grading-inputs/a01.json`, 'utf8')) as { run: { openings: Opening[] } };
const state = (JSON.parse(fs.readFileSync(`${RUN12}/published/a01.state.json`, 'utf8')) as { value: { revisions: (PlanRevisionInput & { revisionId: string })[]; reviews: { revisionId: string; verdict: string; conditions?: ReviewCondition[] }[] } }).value;
const established = Object.fromEntries(inputs.run.openings.map((o) => [o.opportunityId, (o.links ?? []).filter((l) => l.ok).map((l) => l.link)]));
const facts: CardFacts = Object.fromEntries(inputs.run.openings.map((o) => [o.opportunityId, (o.facts ?? []).map((f) => ({ field: f.field, kind: f.kind }))])) as CardFacts;
const firstRevise = state.reviews.find((r) => r.verdict === 'REVISE')!;
const reviewed = state.revisions.find((r) => r.revisionId === firstRevise.revisionId)!;

describe('run 12: a condition against a price Brain establishes names a defect the spec recognises', () => {
  it('ap-01’s recorded condition (comparable listing price, no defect named) is refused against Brain’s established price', () => {
    const conditions = firstRevise.conditions ?? [];
    expect(conditions[0]?.link).toBe('OFFER_AND_PRICE');
    expect(established[conditions[0]!.opportunityId]).toContain('OFFER_AND_PRICE');
    const p = conditionProblems(conditions, reviewed, facts, established);
    expect(p.some((x) => /names the defect the record shows/.test(x))).toBe(true);
  });

  it('controls: the same condition naming a recognised defect is accepted, and a condition on a link Brain does not establish needs none', () => {
    const c = firstRevise.conditions![0]!;
    expect(conditionProblems([{ ...c, defect: 'CONTRADICTED' }], reviewed, facts, established)).toEqual([]);
    expect(conditionProblems([c], reviewed, facts, {})).toEqual([]);
  });
});

describe('run 12: the measured conversion reads as purchases', () => {
  it('a CONTACTS conversion is rendered as paid orders, as the case records it', () => {
    expect(conversionSentence({ paid: 27, of: 300, unit: 'CONTACTS' })).toBe('27 paid orders from 300 contacts');
  });
});
