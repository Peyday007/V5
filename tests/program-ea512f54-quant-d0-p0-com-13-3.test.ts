import { describe, expect, it } from 'vitest';
import { outreachFunnelProbe } from '../server/services/cash/funnelProbe.ts';
import { modelOutreachFunnel } from '../server/services/cash/funnel.ts';

describe('COM-13-3 funnel probe', () => {
  it('model: messages are not buyers', () => {
    const base = { mode: 'x', label: 'x', inputs: { permission: { basis: 'MEASURED', value: 1 } } } as never;
    expect(modelOutreachFunnel(base).buyers.basis).toBe('UNKNOWN');
  });
  it('fails, not passes, with no production records', async () => {
    const { ok } = await outreachFunnelProbe().catch(() => ({ ok: false }));
    expect(ok).toBe(false);
  });
});
