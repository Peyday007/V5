import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('classifier is wired into packet creation', () => {
  it('startPacket classifies each created fragment through the ledger', () => {
    const src = readFileSync('server/services/research/startPacket.ts', 'utf8');
    expect(src).toContain("from '../routing/classify/index.ts'");
    expect(src).toMatch(/classifyAndRecord\(\{[\s\S]*workKind: 'RESEARCH_FRAGMENT'/);
  });
});
