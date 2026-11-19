/**
 * A step's owner is decided by the act it asks for, never by the words in a
 * name it mentions (plan transfer tests, 2026-11-19: "Bring in" an opening
 * titled "… compliance …" was made a PERSON step — "a legal commitment in the
 * owner's name" — though bringing an opening into the plan commits nobody).
 * General rule: names are data, acts are what is judged.
 */
import { describe, expect, it } from 'vitest';
import { actOfChange, ownerOf } from '../server/services/goals/plan.ts';

describe('a step is owned by what it does, not by a name in it', () => {
  it('does not hand Brain\'s portfolio move to the owner because an opening\'s title says "compliance"', () => {
    const move = {
      label: 'Bring in "Constructed: Dental clinics buying HIPAA compliance audit packs"',
      detail: 'bring in "Constructed: Dental clinics buying HIPAA compliance audit packs", a constructed arrangement the first cut left out',
      cost: 0,
    };
    expect(ownerOf(move)).toEqual({ owner: 'BRAIN', reason: null });
  });

  it('does not read a title the reading knows as the act', () => {
    const move = { label: 'Leave out 1 opening(s)', detail: 'leave out Contract staffing for signed agreements, freeing the capacity it held', cost: 0 };
    expect(ownerOf(move, ['Contract staffing for signed agreements']).owner).toBe('BRAIN');
    // Without the title known, the same words would read as a legal act — the defect.
    expect(ownerOf(move).owner).toBe('PERSON');
  });

  it('still gives the owner a real legal act, a credential, or a payment', () => {
    expect(ownerOf({ label: 'Sign the partner agreement', detail: 'sign the referral agreement in the owner\'s name', cost: 0 }).owner).toBe('PERSON');
    expect(ownerOf({ label: 'Connect the store', detail: 'needs the owner\'s API key for "Compliance Hub"', cost: 0 }).owner).toBe('PERSON');
    expect(ownerOf({ label: 'Order stock', detail: 'pay the supplier for "Signed prints"', cost: 250 }).owner).toBe('PERSON');
  });

  it('removes quoted names and known titles, and leaves the act', () => {
    expect(actOfChange({ label: 'Bring in "Licence packs"', detail: 'add “Licence packs” to the plan' })).not.toMatch(/licen/i);
    expect(actOfChange({ label: 'Leave out X', detail: 'leave out Compliance Co' }, ['Compliance Co'])).not.toMatch(/compliance/i);
  });
});
