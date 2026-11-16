/**
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:666553bc2f177cc1 — runpod/openai/gpt-oss-120b's
 * RESEARCH_FRAGMENT answers were refused as "the answer did not survive Brain's own
 * checks: 0 claim(s) offered, dropped {} … the reply was …": the reply carried claims
 * in a shape the lane's readers did not find. Harmony channel output (reasoning on an
 * analysis channel, the reply on a final one), a wrapper object around the answer, and
 * a list encoded as a JSON string are each read as the claims they carry — and every
 * claim read that way is still held to the page exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { citedExcerpt, firstJson, laneFor, listedClaims, sentencesOf } from '../server/services/freeLane/worker.ts';

const PAGE =
  'Occupational Employment and Wages. The survey covers all industries. ' +
  'The median hourly wage for bookkeeping clerks was $22.15 in May 2024. ' +
  'Employment of bookkeeping clerks is projected to decline 5 percent.';
const numbered = [{ url: 'https://www.bls.gov/oes/current/oes433031.htm', sentences: sentencesOf(PAGE) }];
const one = { claim: 'The median hourly wage for bookkeeping clerks was $22.15 in May 2024.', source: 1, sentences: [2], evidence_lane: 'wage' };
const two = { claim: 'Employment of bookkeeping clerks is projected to decline 5 percent.', source: 1, sentences: [3], evidence_lane: 'wage' };

/** What gpt-oss sends when the server does not split its channels: reasoning, then the reply. */
function harmony(analysis: string, final: string, constrain = ''): string {
  return (
    `<|start|>assistant<|channel|>analysis<|message|>${analysis}<|end|>` +
    `<|start|>assistant<|channel|>final${constrain}<|message|>${final}<|return|>`
  );
}

describe('gpt-oss reply shapes are read as the claims they carry (666553bc2f177cc1)', () => {
  it('reproduces the recorded class: a wrapped or encoded list read as an object with no claims is "0 claim(s) offered" no longer', () => {
    // The shapes firstJson parsed to an object in which the old reader found nothing.
    expect(listedClaims(firstJson(JSON.stringify({ answer: { claims: [one, two] } }))!)).toEqual([one, two]);
    expect(listedClaims(firstJson(JSON.stringify({ result: { claims: [one] } }))!)).toEqual([one]);
    expect(listedClaims(firstJson(JSON.stringify({ response: JSON.stringify({ claims: [one] }) }))!)).toEqual([one]);
    expect(listedClaims(firstJson(JSON.stringify({ claims: JSON.stringify([one, two]) }))!)).toEqual([one, two]);
    expect(listedClaims(firstJson(JSON.stringify({ fragment_answer: { claims: [one] } }))!)).toEqual([one]);
    expect(listedClaims(firstJson(JSON.stringify({ output: [one, two] }))!)).toEqual([one, two]);
  });

  it('harmony output: the final channel is the reply; the analysis channel, with its example claim and draft answer, is reasoning', () => {
    const analysis =
      'The brief wants wages. Example format {"claim":"…","source":2,"sentences":[4,5],"evidence_lane":"wage"} for [S2.4]. ' +
      'Draft: {"claims":[]} — no, [S1.2] states the wage.';
    expect(listedClaims(firstJson(harmony(analysis, JSON.stringify({ claims: [one, two] })))!)).toEqual([one, two]);
    expect(listedClaims(firstJson(harmony(analysis, JSON.stringify([one]), ' <|constrain|>json'))!)).toEqual([one]);
    expect(listedClaims(firstJson(harmony(analysis, `\`\`\`json\n${JSON.stringify({ claims: [two] })}\n\`\`\``))!)).toEqual([two]);
    // Cut off inside the analysis channel: as with an unclosed <think>, the last whole value is the answer.
    expect(firstJson(`<|channel|>analysis<|message|>draft {"claims":[]} then ${JSON.stringify([one])}`)).toEqual({ claims: [one] });
    expect(firstJson('<|channel|>analysis<|message|>still thinking {broken')).toBeNull();
  });

  it('an explicit empty answer stays empty, and prose stays nothing', () => {
    expect(listedClaims(firstJson(harmony('nothing on the page states it', '{"claims":[]}'))!)).toEqual([]);
    expect(listedClaims({ answer: { claims: [] } })).toEqual([]);
    expect(listedClaims({ answer: 'none' })).toEqual([]);
    expect(listedClaims({ result: [{ note: 'not a claim' }] })).toEqual([]);
    // One level of wrapper and no more.
    expect(listedClaims({ answer: { result: { claims: [one] } } })).toEqual([]);
  });

  it('a claim read from any of these shapes is still held to the page: uncited, out-of-page or unknown-lane claims are not rescued', () => {
    const [read] = listedClaims(firstJson(harmony('x', JSON.stringify({ answer: { claims: [one] } })))!);
    expect(PAGE).toContain(citedExcerpt(read!, numbered)!.excerpt);
    const [uncited] = listedClaims(firstJson(JSON.stringify({ answer: { claims: [{ claim: 'Wages rose.', evidence_lane: 'wage' }] } }))!);
    expect(citedExcerpt(uncited!, numbered)).toBeNull();
    const [outside] = listedClaims({ claims: JSON.stringify([{ ...one, sentences: [99] }]) });
    expect(citedExcerpt(outside!, numbered)).toBeNull();
    const [lane] = listedClaims({ result: { claims: [{ ...one, evidence_lane: 'Lane 9 (made up)' }] } });
    expect(laneFor(lane!['evidence_lane'], [{ id: 'wage', description: 'wage levels' }])).toBeNull();
  });
});
