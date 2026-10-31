/**
 * The operator's ceiling on cash research only ever lowers the room.
 */
import { describe, expect, it } from 'vitest';
import { applyOperatorMax, operatorResearchMax } from '../server/services/cash/researchRoom.ts';

const room = (free: number, inFlight: number) => ({
  room: free,
  cap: inFlight + free,
  inFlight,
  limitedBy: 'GRANT' as const,
  reason: 'r',
});

describe('BRAIN_CASH_RESEARCH_MAX', () => {
  it('is off unless set to a number', () => {
    expect(operatorResearchMax({})).toBeNull();
    expect(operatorResearchMax({ BRAIN_CASH_RESEARCH_MAX: 'x' })).toBeNull();
    expect(operatorResearchMax({ BRAIN_CASH_RESEARCH_MAX: '1' })).toBe(1);
  });

  it('caps what may start, counting what is already running', () => {
    expect(applyOperatorMax(room(4, 0), 1)).toMatchObject({ room: 1, cap: 1, limitedBy: 'OPERATOR' });
    expect(applyOperatorMax(room(4, 1), 1).room).toBe(0);
    expect(applyOperatorMax(room(4, 3), 1).room).toBe(0);
  });

  it('never raises the room', () => {
    expect(applyOperatorMax(room(1, 0), 5)).toEqual(room(1, 0));
    expect(applyOperatorMax(room(2, 0), null)).toEqual(room(2, 0));
  });

  it('rises by the idle surfaces nothing is waiting for, and never past the grant', () => {
    expect(applyOperatorMax(room(4, 1), 1, 3)).toMatchObject({ room: 3, limitedBy: 'OPERATOR' });
    expect(applyOperatorMax(room(4, 1), 1, 6)).toEqual(room(4, 1));
    expect(applyOperatorMax(room(4, 1), 1, 0).room).toBe(0);
  });
});

describe('spareResearchSurfaces', () => {
  it('reads an empty fleet as no spare, on either backend', async () => {
    const { freshProject } = await import('./helpers.ts');
    const { spareResearchSurfaces, forgetResearchSurfaces } = await import('../server/services/cash/researchRoom.ts');
    const project = await freshProject();
    forgetResearchSurfaces();
    expect(await spareResearchSurfaces(project.project.id)).toBe(0);
  });
});
