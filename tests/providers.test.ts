import { describe, expect, it } from 'vitest';
import { defaultProviderName, getProvider, listProviderStatuses } from '../server/providers/index.ts';
import { parseAuditJson } from '../server/services/auditEngine.ts';

describe('provider abstraction', () => {
  it('defaults to a provider that works with no credentials', () => {
    expect(defaultProviderName()).toBe('mock');
    const provider = getProvider();
    expect(provider.getStatus().available).toBe(true);
  });

  it('reports Claude and OpenAI as unavailable without keys, with a useful reason', () => {
    const statuses = listProviderStatuses();
    const names = statuses.map((s) => s.name);
    expect(names).toContain('mock');
    expect(names).toContain('claude');
    expect(names).toContain('openai');

    for (const name of ['claude', 'openai']) {
      const status = statuses.find((s) => s.name === name);
      if (process.env[name === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']) continue;
      expect(status?.available).toBe(false);
      expect(status?.reason.length).toBeGreaterThan(0);
    }
  });

  it('mock research honours the platform-controlled expected title', async () => {
    const result = await getProvider('mock').runResearch({
      prompt: 'do the research',
      requiredAttachments: ['Discovery Logic v1'],
      expectedConversationTitle: 'Discovery Logic v1B',
      expectedFilename: 'Discovery Logic v1B.pdf',
    });
    expect(result.text).toContain('Discovery Logic v1B');
  });

  it('mock audit returns JSON the audit engine can parse', async () => {
    const result = await getProvider('mock').audit({ prompt: 'audit this' });
    const parsed = parseAuditJson(result.text);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBeTruthy();
    expect(Array.isArray(parsed?.failures)).toBe(true);
  });

  it('rejects clearly when an unconfigured provider is called', async () => {
    if (process.env.ANTHROPIC_API_KEY) return;
    await expect(getProvider('claude').chat({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow();
  });
});
