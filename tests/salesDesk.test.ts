/**
 * The sales desk (§107): Sellbird's sales mind on every Brain business, with
 * Brain deciding, Instantly sending and every reply recorded once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { recordSalesLearning, salesLead, salesReplies } from '../server/repos/salesDesk.ts';
import {
  PERSONAL_STEPS, PUBLISHER_ADDRESS, campaignDefinition, refill, shapeProblems, type Deps, type PersonalDesk,
} from '../server/services/cash/neighborCard.ts';
import { SALES_BUSINESSES, salesBusiness } from '../server/services/sales/businesses.ts';
import {
  handleOneReply, learn, personalDesk, personalShare, promisesDeliverable, textToHtml, ungroundedFigures, workReplies,
} from '../server/services/sales/desk.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const ENV = {
  INSTANTLY_API_KEY: 'k'.repeat(40),
  BRAIN_AGENTS_URL: 'http://northline-agents.flycast',
  BRAIN_AGENTS_KEY: 'a'.repeat(64),
  BRAIN_RUNPOD_URL: 'https://pod-8000.proxy.runpod.net',
  BRAIN_RUNPOD_MODE: 'primary',
  BRAIN_RUNPOD_MODEL: 'Qwen/Qwen3-4B',
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** One fake for the agents service and Instantly; `decision` is Sellbird's answer to /v1/sellbird/reply. */
function world(options: { decision?: Record<string, unknown>; thread?: Record<string, unknown>[]; received?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  const reply = {
    id: 'em-1', thread_id: 'th-1', timestamp_email: '2026-11-12T17:49:16.000Z', from_address_email: 'kathy@clubpilates.example',
    eaccount: 'benjamin@aligninspiration.example', subject: 'Re: A January postcard to 4,944 Camp Hill homes', ue_type: '2',
    campaign_id: 'nc-1', lead: 'kathy@clubpilates.example', body: { text: 'What is the demographic for these homes?' },
  };
  const deps: Deps = {
    env: ENV,
    sleep: async () => {},
    resolveMx: async () => true,
    log: () => {},
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url: u, method: init?.method ?? 'GET', body });
      if (u.endsWith('/v1/sellbird/reply')) {
        return json({ intent: 'question', stage: 'engaged', status: 'open', prospectStatus: 'replied', optOut: null, escalations: [],
          answer: 'The carrier routes have a median household income of about $109k.', ...options.decision });
      }
      if (u.endsWith('/v1/sellbird/insights')) return json({ insights: ['KEEP: reply rate is strong'] });
      if (u.startsWith('https://api.instantly.ai/api/v2/campaigns?')) return json({ items: [{ id: 'nc-1', name: 'Neighbor Card · Camp Hill Jan 2027', status: 1 }, { id: 'ai-1', name: 'AI Dispatch', status: 1 }] });
      if (u.includes('/emails?campaign_id=nc-1')) return json({ items: options.received ?? [reply] });
      if (u.includes('/emails?campaign_id=')) return json({ items: [] });
      if (u.includes('/emails?thread_id=')) return json({ items: options.thread ?? [reply] });
      if (u.includes('/accounts/')) return json({ first_name: 'Benjamin', last_name: 'Hall' });
      if (u.endsWith('/emails/reply')) return json({ id: 'sent-1' });
      if (u.includes('/campaigns/analytics')) return json([{ emails_sent_count: 300, reply_count_unique: 6, bounced_count: 2, unsubscribed_count: 1 }]);
      return json({});
    }) as typeof fetch,
  };
  return { deps, calls, reply };
}

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path));

beforeAll(async () => {
  await freshProject();
});
afterAll(async () => {
  await teardown();
});

describe('what Brain checks on top of Sellbird\'s own gate', () => {
  it('holds a figure the business never stated, and passes one it did', () => {
    const facts = ['A standard spot is $295 (about 6 cents a home); 4,944 homes; median household income of about $109k.'];
    expect(ungroundedFigures('It is $295 for 4,944 homes.', facts)).toEqual([]);
    expect(ungroundedFigures('Only $199 this week, 20% off.', facts)).toEqual(['$199', '20%']);
  });

  it('holds an answer that promises what a text reply cannot carry', () => {
    expect(promisesDeliverable("Sure, I'll send the route map and rate card today.")).toBe(true);
    expect(promisesDeliverable('The homes are in Camp Hill and East Hampden.')).toBe(false);
  });

  it('turns an answer into the paragraphs Instantly sends, escaped', () => {
    expect(textToHtml('One <b>\n\nTwo')).toBe('<p>One &lt;b&gt;</p><p>Two</p>');
  });
});

describe('a reply on a business campaign', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('answers a question with the business\'s own figures, in the thread, from the mailbox that received it', async () => {
    const { deps, calls, reply } = world();
    const card = salesBusiness('neighbor-card')!;
    const out = await handleOneReply(deps, card, mail(reply), [mail(reply)]);
    expect(out?.action).toBe('ANSWERED');
    const sent = posted(calls, '/emails/reply')[0]!;
    expect(sent.body).toMatchObject({ eaccount: 'benjamin@aligninspiration.example', reply_to_uuid: 'em-1' });
    expect(String((sent.body!.body as { html: string }).html)).toContain('$109k');
    expect(String((sent.body!.body as { html: string }).html)).toContain('<p>Benjamin</p>');
    expect(posted(calls, '/leads/update-interest-status')[0]!.body).toMatchObject({ interest_value: 1, campaign_id: 'nc-1' });
    // The offer Sellbird read signs as the receiving account, not as anyone else.
    const asked = posted(calls, '/v1/sellbird/reply')[0]!.body!;
    expect((asked.offer as { sender: { name: string } }).sender.name).toBe('Benjamin Hall');
    expect((await salesReplies('neighbor-card'))[0]).toMatchObject({ emailId: 'em-1', intent: 'question', action: 'ANSWERED', answerEmailId: 'sent-1' });
  });

  it('puts an opt-out on the workspace block list and sends nothing', async () => {
    const { deps, calls, reply } = world({ decision: { intent: 'unsubscribe', stage: 'closed_lost', status: 'closed', answer: '', optOut: { rule: 'phrase', matched: 'no thanks' } } });
    const out = await handleOneReply(deps, salesBusiness('neighbor-card')!, mail(reply), [mail(reply)]);
    expect(out?.action).toBe('SUPPRESSED');
    expect(posted(calls, '/block-lists-entries')[0]!.body).toEqual({ bl_value: 'kathy@clubpilates.example' });
    expect(posted(calls, '/emails/reply')).toHaveLength(0);
    expect(posted(calls, '/leads/update-interest-status')[0]!.body).toMatchObject({ interest_value: -1 });
  });

  it('holds an answer quoting a price the business never stated', async () => {
    const { deps, calls, reply } = world({ decision: { answer: 'This week it is only $199 a spot.' } });
    const out = await handleOneReply(deps, salesBusiness('neighbor-card')!, mail(reply), [mail(reply)]);
    expect(out?.action).toBe('HELD');
    expect(out?.detail).toContain('$199');
    expect(posted(calls, '/emails/reply')).toHaveLength(0);
  });

  it('holds a request for the card for fulfilment instead of promising it', async () => {
    const { deps, calls, reply } = world({ decision: { intent: 'interested', answer: "Happy to. I'll send the card front and back and the route map." } });
    const out = await handleOneReply(deps, salesBusiness('neighbor-card')!, mail(reply), [mail(reply)]);
    expect(out?.action).toBe('FULFILL');
    expect(posted(calls, '/emails/reply')).toHaveLength(0);
  });

  it('never answers on the owner\'s own campaign, and never answers a thread someone already answered', async () => {
    const owner = world();
    expect((await handleOneReply(owner.deps, salesBusiness('ai-dispatch')!, mail(owner.reply), [mail(owner.reply)]))?.action).toBe('HELD');
    const later = { ...owner.reply, id: 'em-2', ue_type: '3', timestamp_email: '2026-11-12T18:30:00.000Z', from_address_email: 'benjamin@aligninspiration.example' };
    const answered = world({ thread: [owner.reply, later] });
    const out = await handleOneReply(answered.deps, salesBusiness('neighbor-card')!, mail({ ...owner.reply, id: 'em-9' }), [mail(owner.reply), mail(later)]);
    expect(out?.action).toBe('HELD');
    expect(out?.detail).toContain('already answered');
    expect(posted(answered.calls, '/emails/reply')).toHaveLength(0);
  });

  it('analyses each reply once, and leaves one the model did not answer for the next pass', async () => {
    const first = world();
    const pass1 = await workReplies(first.deps);
    expect(pass1.outcomes).toHaveLength(1);
    const again = await workReplies(world().deps);
    expect(again.outcomes).toHaveLength(0);

    await freshProject();
    const down = world();
    down.deps.fetch = (async (url: string, init?: RequestInit) => (String(url).endsWith('/v1/sellbird/reply') ? new Response('', { status: 503 }) : world().deps.fetch(url, init))) as typeof fetch;
    const pass = await workReplies(down.deps);
    expect(pass.outcomes).toHaveLength(0);
    expect(pass.line).toContain('left for the next pass');
    expect(await salesReplies(null)).toHaveLength(0);
  });
});

describe('the Neighbor Card\'s personal variant', () => {
  it('has the template\'s address, follow-ups and opt-out, with Sellbird\'s first email', () => {
    const def = campaignDefinition(['a@x.example'], 90, PERSONAL_STEPS);
    expect(shapeProblems({ ...def, sequences: [{ steps: PERSONAL_STEPS.map((s) => ({ variants: [{ subject: s.subject, body: s.body }] })) }] }, ['a@x.example'], 90, PERSONAL_STEPS)).toEqual([]);
    expect(PERSONAL_STEPS[0]!.subject).toBe('{{sb_subject}}');
    for (const step of PERSONAL_STEPS) expect(step.body).toContain(PUBLISHER_ADDRESS);
  });

  it('researches the new leads, drops what Sellbird refuses, and writes for the best fit first', async () => {
    const leads: Record<string, unknown>[] = [];
    const sites: Record<string, string> = {
      'https://harborplumbing.example': '<a href="mailto:office@harborplumbing.example">office@harborplumbing.example</a>',
      'https://camphilldental.example': '<a href="mailto:hello@camphilldental.example">hello@camphilldental.example</a>',
      'https://blockedgym.example': '<a href="mailto:info@blockedgym.example">info@blockedgym.example</a>',
    };
    const deps: Deps = {
      env: ENV, sleep: async () => {}, resolveMx: async () => true, log: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith('https://api.instantly.ai/api/v2/leads/list')) return json({ items: [] });
        if (u.startsWith('https://api.instantly.ai/api/v2/leads')) { leads.push(JSON.parse(String(init?.body))); return json({}); }
        if (u.includes('overpass-api.de')) {
          return json({ elements: Object.keys(sites).map((w, i) => ({ tags: { name: `Business ${i}`, website: w, craft: 'plumber', 'addr:city': 'Camp Hill' } })) });
        }
        if (u.includes('overpass')) return json({ elements: [] });
        const site = Object.keys(sites).find((w) => u.startsWith(w));
        return site ? html(`<html><body>${sites[site]}</body></html>`) : new Response('', { status: 404 });
      }) as typeof fetch,
    };
    const written: string[] = [];
    const desk: PersonalDesk = {
      perPass: 1,
      researchPerPass: 10,
      research: async (lead) => (lead.email.includes('blockedgym') ? { fit: 0, refuse: 'do-not-contact', greeting: null }
        : { fit: lead.email.includes('dental') ? 70 : 35, refuse: null, greeting: lead.email.includes('dental') ? 'Dana' : null }),
      write: async (lead) => { written.push(lead.email); return { subject: 'your january spot', bodyHtml: '<p>Hi Dana,</p><p>Saw you serve Camp Hill families.</p>' }; },
      template: async () => {},
    };
    deps.personal = desk;
    const result = await refill(deps, 'tpl-1', { slot: 0, maxSites: 10, personalCampaignId: 'per-1' });
    expect(written).toEqual(['hello@camphilldental.example']);
    const byEmail = Object.fromEntries(leads.map((l) => [String(l.email), l]));
    expect(byEmail['hello@camphilldental.example']).toMatchObject({ campaign: 'per-1' });
    expect((byEmail['hello@camphilldental.example']!.custom_variables as Record<string, string>)).toMatchObject({ greeting: 'Dana', sb_subject: 'your january spot' });
    expect(byEmail['office@harborplumbing.example']).toMatchObject({ campaign: 'tpl-1' });
    expect(byEmail['info@blockedgym.example']).toBeUndefined();
    expect(result.desk).toMatchObject({ researched: 3, refused: 1, written: 1, personal: 1, template: 1 });
  });

  it('records a written lead with its research, and keeps a draft with an unstated figure off the personal variant', async () => {
    await freshProject();
    for (const [body, variant] of [['Saw you serve Camp Hill. Want the route map?', 'PERSONAL'], ['Only $199 if you sign today. Want it?', 'TEMPLATE']] as const) {
      const fetcher = (async (url: string) => {
        const u = String(url);
        if (u.endsWith('/v1/sellbird/research')) {
          return json({ domain: 'camphilldental.example', reachable: true, challenged: false, siteName: 'Camp Hill Dental', pagesRead: 3, people: [], inbox: null,
            publishedAddresses: [], description: 'Family dentistry', techStack: ['WordPress'], facts: [], observations: [], fit: { score: 40, reasons: ['general inbox only'] } });
        }
        if (u.endsWith('/v1/sellbird/write')) return json({ ok: true, subject: 'your january spot', body, problems: [], tipBasis: true, calls: [] });
        return json({});
      }) as typeof fetch;
      const desk = (await personalDesk(ENV, fetcher))!;
      const lead = { email: `hello+${variant}@camphilldental.example`, greeting: 'there', name: 'Camp Hill Dental', website: 'https://camphilldental.example', category: 'dentist', town: 'Camp Hill', sourceUrl: 'https://camphilldental.example' };
      await desk.research(lead);
      const out = await desk.write(lead);
      expect(Boolean(out)).toBe(variant === 'PERSONAL');
      if (out) expect(out.bodyHtml.startsWith('<p>Hi there,</p>')).toBe(true);
      const row = await salesLead('neighbor-card', lead.email);
      expect(row).toMatchObject({ variant, fitScore: 40, fitReasons: ['general inbox only'] });
    }
  });

  it('moves the allocation toward the variant that earns more positive replies per send', async () => {
    await freshProject();
    expect(await personalShare()).toBe(0.5);
    const { deps } = world();
    const card = salesBusiness('neighbor-card')!;
    deps.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/campaigns/analytics?id=tpl')) return json([{ emails_sent_count: 400, reply_count_unique: 8 }]);
      if (u.includes('/campaigns/analytics?id=per')) return json([{ emails_sent_count: 200, reply_count_unique: 9 }]);
      if (u.endsWith('/v1/sellbird/insights')) return json({ insights: [] });
      return json({});
    }) as typeof fetch;
    // Positive replies Brain recorded: 2 on the template, 4 on the personal variant.
    const { recordSalesReply } = await import('../server/repos/salesDesk.ts');
    for (const [i, campaignId] of ['tpl', 'tpl', 'per', 'per', 'per', 'per'].entries()) {
      await recordSalesReply({ emailId: `e${i}`, business: 'neighbor-card', campaignId, leadEmail: `l${i}@x.example`, threadId: null, receivedAt: null,
        replyText: 'Tell me more', intent: 'interested', stage: 'engaged', status: 'open', optOut: null, escalation: null, answer: null, action: 'RECORDED', actionDetail: '', answerEmailId: null });
    }
    const ids = new Map([[card.campaigns[0]!, { id: 'tpl', status: 1 }], [card.campaigns[1]!, { id: 'per', status: 1 }]]);
    const line = await learn(deps, card, ids);
    expect(line).toContain('personal share 0.5 -> 0.75');
    expect(await personalShare()).toBe(0.75);
    await recordSalesLearning('neighbor-card', 'ALLOCATION', { personalShare: 0.2 });
    expect(await personalShare()).toBe(0.2);
  });
});

describe('every Brain business that sells through Instantly', () => {
  it('is on the desk, names its campaigns, and answers only where Brain operates the campaign', () => {
    expect(SALES_BUSINESSES.map((b) => b.id).sort()).toEqual(['access-audit', 'ai-dispatch', 'bid-digest', 'buyer-outreach', 'grant-prospects', 'neighbor-card']);
    for (const b of SALES_BUSINESSES) {
      expect(b.campaigns.length).toBeGreaterThan(0);
      expect(b.offer.postalAddress).toBeTruthy();
    }
    expect(salesBusiness('ai-dispatch')!.answer).toBe(false);
  });
});

function mail(m: Record<string, unknown>) {
  const body = (m.body ?? {}) as { text?: string };
  const ue = Number(m.ue_type);
  return {
    id: String(m.id), threadId: String(m.thread_id ?? ''), at: String(m.timestamp_email ?? ''), from: String(m.from_address_email ?? ''),
    eaccount: String(m.eaccount ?? ''), subject: String(m.subject ?? ''), text: body.text ?? '', ours: ue === 1 || ue === 3 || ue === 4,
    campaignId: String(m.campaign_id ?? ''), lead: String(m.lead ?? m.from_address_email ?? ''),
  };
}

describe('§107 accounts for the whole of Sellbird', () => {
  // Every module of Sellbird 25ec839 (sellbird/**/*.py, minus package markers).
  const MODULES = 'agent_policy agents/analyst agents/handler agents/scout agents/sender agents/writer booking brain claude_runtime cli codex collectors/ats collectors/discover collectors/people collectors/profile config dashboard dashboard_auth dashboard_instance deliverability desktop/login_item desktop/tray desktop_cli email_style export extensions fit gate handoff home humanize inbox_cli inbox_routes integrations/calendar integrations/email_finder integrations/gmail integrations/instantly integrations/linkedin integrations/mail_provider integrations/microsoft integrations/precleared integrations/quota integrations/signature integrations/smtp_mail integrations/tech_detect integrations/trulyinbox legacy logsafety mailboxes main mcp_install mcp_server models/campaign models/company models/conversation models/prospect offer paths pidfile pipeline public_http register secrets send_hooks send_window sending_mode setup signals site_facts startups state storage textio trainer untrusted usage workspace_home'.split(' ');

  it('names every module as integrated, the machinery under one, or not integrated with its reason', async () => {
    const { readFileSync } = await import('node:fs');
    const record = readFileSync(new URL('../docs/ARCHITECTURE-RECORD.md', import.meta.url), 'utf8');
    const section = record.slice(record.indexOf('## 107.'));
    const missing = MODULES.filter((m) => {
      const leaf = m.split('/').pop()!;
      return !section.includes(m) && !section.includes(`${leaf}.py`) && !new RegExp(`\`[^\`]*\\b${leaf}\\b[^\`]*\``).test(section);
    });
    expect(missing).toEqual([]);
  });
});
