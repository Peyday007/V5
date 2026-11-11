import { describe, expect, it } from 'vitest';
import { runExpansionOutreach } from '../server/services/cash/expansionOutreach.ts';
import type { Deps } from '../server/services/cash/neighborCard.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function deps(route: (method: string, path: string) => unknown): Deps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: { INSTANTLY_API_KEY: 'k'.repeat(40) },
    sleep: async () => {},
    resolveMx: async () => true,
    log: () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.instantly.ai/api/v2', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      return json(route(method, path));
    }) as typeof fetch,
  };
}

const CAMPAIGN = { business: 'example', name: 'Example · wave 1' };

describe('expansion outreach pass', () => {
  it('reads counts, lists the reply nobody answered, skips auto-replies and the answered thread, and only reads', async () => {
    const d = deps((_m, path) => {
      if (path.startsWith('/campaigns?')) return { items: [{ id: 'c1', name: 'Example · wave 1', status: 1 }] };
      if (path.startsWith('/campaigns/analytics')) return [{ emails_sent_count: 100, reply_count_unique: 3, bounced_count: 2, unsubscribed_count: 1 }];
      if (path.includes('email_type=received')) {
        return {
          items: [
            { id: 'r1', thread_id: 't1', from_address_email: 'ann@org.org', timestamp_email: '2026-11-12T10:00:00Z', subject: 'Re: hi', content_preview: 'Yes please send it' },
            { id: 'r2', thread_id: 't2', from_address_email: 'bob@co.com', timestamp_email: '2026-11-12T11:00:00Z', subject: 'Re: hi', content_preview: 'Sure' },
            { id: 'r3', thread_id: 't3', from_address_email: 'x@y.com', timestamp_email: '2026-11-12T12:00:00Z', subject: 'Automatic reply: away', content_preview: 'I am out of office' },
          ],
        };
      }
      if (path.includes('thread_id=t1')) return { items: [{ from_address_email: 'ann@org.org', timestamp_email: '2026-11-12T10:00:00Z' }] };
      if (path.includes('thread_id=t2')) return { items: [{ from_address_email: 'bob@co.com', timestamp_email: '2026-11-12T11:00:00Z' }, { from_address_email: 'info@us.com', timestamp_email: '2026-11-12T13:00:00Z' }] };
      return { items: [] };
    });
    const r = await runExpansionOutreach(d, [CAMPAIGN]);
    expect(r.readings[0]).toMatchObject({ sent: 100, replies: 3, bounced: 2, unsubscribed: 1 });
    expect(r.readings[0]!.waiting.map((w) => w.id)).toEqual(['r1']);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/waiting: .*ann@org\.org/);
    expect(d.calls.every((c) => c.startsWith('GET '))).toBe(true);
  });

  it('asks for attention on a stopped campaign and on bounces over 5%, and says OK when all is well', async () => {
    const bad = deps((_m, path) => {
      if (path.startsWith('/campaigns?')) return { items: [{ id: 'c1', name: 'Example · wave 1', status: 2 }] };
      if (path.startsWith('/campaigns/analytics')) return [{ emails_sent_count: 100, bounced_count: 9 }];
      return { items: [] };
    });
    const r = await runExpansionOutreach(bad, [CAMPAIGN]);
    expect(r.readings[0]!.problems.join(' ')).toMatch(/not running.*bounce rate 9\.0%/);
    const good = deps((_m, path) => {
      if (path.startsWith('/campaigns?')) return { items: [{ id: 'c1', name: 'Example · wave 1', status: 1 }] };
      if (path.startsWith('/campaigns/analytics')) return [{ emails_sent_count: 100, bounced_count: 1 }];
      return { items: [] };
    });
    expect((await runExpansionOutreach(good, [CAMPAIGN])).ok).toBe(true);
  });

  it('reports a missing campaign rather than failing the pass', async () => {
    const r = await runExpansionOutreach(deps(() => ({ items: [] })), [CAMPAIGN]);
    expect(r.ok).toBe(false);
    expect(r.lines[1]).toMatch(/no campaign/);
  });
});
