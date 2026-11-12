import { describe, expect, it } from 'vitest';
import { independenceGroup } from '../server/services/research/standards.ts';

const claim = (sourceUrl: string, evidenceExcerpt: string, sourcePublisher: string | null = null) => ({
  sourceUrl,
  sourcePublisher,
  evidenceExcerpt,
});

describe('independenceGroup', () => {
  it('counts one upstream estimate once, whatever the sentence position', () => {
    const a = independenceGroup(claim('https://a.com/x', 'According to Gartner, the market is $5B.'));
    const b = independenceGroup(claim('https://b.com/y', 'The market is $5B, according to Gartner.'));
    expect(a).toBe('upstream:gartner');
    expect(b).toBe('upstream:gartner');
  });

  it('does not class hosts that merely contain a wire name as wires', () => {
    expect(independenceGroup(claim('https://openprocurement.org/a', 'Tender notice.'))).toBe('host:openprocurement.org');
    expect(independenceGroup(claim('https://www.msnbc.com/a', 'Report.'))).toBe('host:msnbc.com');
  });

  it('still treats real wires and their subdomains as wires', () => {
    expect(independenceGroup(claim('https://www.prnewswire.com/a', 'Release.', 'Acme'))).toBe('release:acme');
    expect(independenceGroup(claim('https://www.prnewswire.com/a', 'Release.'))).toBe('wire:prnewswire.com');
    expect(independenceGroup(claim('https://finance.yahoo.com/a', 'Release.'))).toBe('wire:finance.yahoo.com');
  });

  it('does not read bare "per" as an attribution', () => {
    expect(independenceGroup(claim('https://a.com/x', 'Costs $10 per Unit shipped'))).toBe('host:a.com');
  });
});
