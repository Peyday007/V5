/**
 * A learned subject is a subject, not the claim sentence it came from.
 *
 * The harvest once stored `clamp(claim.claim, 120)` as the subject's label, so
 * every claim became its own lens ("Looking at <a sentence>, who is buying…"),
 * near-duplicate claims were separate subjects, and once a project held 60 of
 * them it never learned another. This pins the opposite on each count.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLearnedSubjects, upsertLearnedSubject } from '../server/repos/searchMethods.ts';
import {
  isSubjectLabel, learnedLensesForProject, learnSubjectFromClaim, MAX_LEARNED_SUBJECTS,
  subjectFromClaim, subjectKeyFor,
} from '../server/services/knowledge/subjects/subjects.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const active = async () => (await listLearnedSubjects({ projectIds: [projectId], userId: null }))
  .filter((s) => s.projectId === projectId);

describe('the subject a claim names', () => {
  it('is a short phrase, never the sentence', () => {
    expect(subjectFromClaim('A county published an RFP for parcel research, proposals due 25 September 2026.'))
      .toBe('parcel research');
    expect(subjectFromClaim('The school district issued a request for proposals for janitorial services due Oct 3.'))
      .toBe('janitorial services');
    expect(subjectFromClaim('Mobile notary services needed in Austin by Friday.')).toBe('mobile notary services');
    expect(subjectFromClaim('Revenue grew 12% last year.')).toBeNull();
    for (const claim of [
      'A county published an RFP for parcel research, proposals due 25 September 2026.',
      'The city is seeking a vendor to provide drone roof inspections across three districts.',
    ]) {
      const subject = subjectFromClaim(claim);
      if (subject !== null) {
        expect(isSubjectLabel(subject)).toBe(true);
        expect(subject).not.toBe(claim.toLowerCase());
      }
    }
  });

  it('gives near-duplicate wordings one key', () => {
    expect(subjectKeyFor('Parcel research services', 'MARKET')).toBe(subjectKeyFor('research of parcels', 'MARKET'));
    expect(subjectKeyFor('Dock Leveler Repair')).toBe(subjectKeyFor(' dock  leveler repair '));
    expect(subjectKeyFor('parcel research')).not.toBe(subjectKeyFor('janitorial services'));
  });
});

describe('learning subjects from harvested claims', () => {
  it('learns the phrase, and claims about one thing teach one subject', async () => {
    const a = await learnSubjectFromClaim({ projectId, claimId: 'c1',
      claim: 'A county published an RFP for parcel research, proposals due 25 September 2026.' });
    const b = await learnSubjectFromClaim({ projectId, claimId: 'c2',
      claim: 'Another county posted an RFQ for parcel research services, closing 2 October.' });
    expect(a?.label).toBe('parcel research');
    expect(b?.id).toBe(a?.id);
    expect(await active()).toHaveLength(1);
    const [lens] = await learnedLensesForProject(projectId);
    expect(lens!.question).toMatch(/^Looking at parcel research,/);
  });

  it('teaches nothing from a claim that names no subject', async () => {
    expect(await learnSubjectFromClaim({ projectId, claimId: 'c', claim: 'Revenue grew 12% last year.' })).toBeNull();
    expect(await active()).toHaveLength(0);
  });

  it('keeps learning past the bound by retiring the stalest subject', async () => {
    const max = 3;
    const learned = [];
    for (const [i, thing] of ['parcel research', 'janitorial cleaning', 'drone inspections', 'grant writing'].entries()) {
      learned.push(await learnSubjectFromClaim({ projectId, claimId: `c${i}`, claim: `A buyer posted an RFP for ${thing}, due soon.`, max }));
    }
    const labels = (await active()).map((s) => s.label);
    expect(labels).toHaveLength(max);
    expect(labels).toContain(learned[3]!.label);

    // Observed again, a retired subject is offered again, and another makes room.
    await learnSubjectFromClaim({ projectId, claimId: 'c9', claim: 'A city wants parcel research for its tax roll.', max });
    const after = (await active()).map((s) => s.label);
    expect(after).toHaveLength(max);
    expect(after).toContain('parcel research');
    expect(MAX_LEARNED_SUBJECTS).toBeGreaterThan(max);
  });

  it('retires a sentence stored as a subject by the earlier harvest', async () => {
    await upsertLearnedSubject({ scope: 'PROJECT', projectId, subjectKey: 'market:a-county-published-an-rfp',
      label: 'A county published an RFP for parcel research, proposals due 25 September 2026.',
      origin: 'harvest', sourceRef: 'claim:old' });
    await learnSubjectFromClaim({ projectId, claimId: 'new', claim: 'A town needs janitorial cleaning for its library.' });
    expect((await active()).map((s) => s.label)).toEqual(['janitorial cleaning']);
  });
});
