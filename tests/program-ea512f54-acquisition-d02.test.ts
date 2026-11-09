import { describe, expect, it } from 'vitest';
import {
  judgeAcquisitionNeed,
  recordAcquisitionJudgment,
  repeatedUseFromRows,
} from '../server/services/sources/acquisition.ts';
import { boundaryOfRead, classOfRoute, selectAccessMethod, SCRIPT_CONVERSION_RUNS } from '../server/services/sources/accessMethods.ts';
import { operateEvidenceOfRead, readSource, resetSourceAccessMemory, robotsAllows, robotsRules } from '../server/services/sources/access.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

describe('boundaries are stops, never routes around', () => {
  it.each([
    ['contactsStrangers', 'CONTACT_STRANGERS'],
    ['evadesDefenses', 'EVADE_SITE_DEFENSES'],
    ['makesBusinessCommitment', 'BUSINESS_COMMITMENT'],
  ] as const)('refuses a need that %s, even with every route available', (flag, boundary) => {
    for (const kind of ['OPERATE', 'ACQUIRE'] as const) {
      const j = judgeAcquisitionNeed(
        { kind, purpose: 'p', [flag]: true },
        { nativeIntegrationAvailable: true, existingBulkSources: ['x'], stableHttpDocuments: true, authorizedAccountOnRecord: true, repeatedUses: 9 },
      );
      expect(j.outcome).toBe('REFUSED');
      expect(j.route).toBeNull();
      expect(j.boundaries).toContain(boundary);
      expect(j.reusableConnectorJustified).toBe(false);
      expect(j.bespokeCrawlerMayBeProposed).toBe(false);
    }
  });

  it('names every boundary a need crosses', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p', contactsStrangers: true, evadesDefenses: true });
    expect(j.boundaries).toEqual(['CONTACT_STRANGERS', 'EVADE_SITE_DEFENSES']);
  });

  it('an authentication, captcha or bot boundary ends in a human handoff naming the permitted route', () => {
    for (const boundary of ['AUTHENTICATION', 'CAPTCHA', 'BOT_RESTRICTION', 'OWNER_CONSENT'] as const) {
      const s = selectAccessMethod({ boundary, nativeAvailable: true, httpReadable: true, interfaceOnly: true, authorizedSession: true });
      expect(s.method).toBe('HUMAN_HANDOFF');
      expect(s.handoff).toBeTruthy();
      expect(s.considered.filter((c) => c.method !== 'HUMAN_HANDOFF').every((c) => !c.fit)).toBe(true);
    }
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { blockedAtBoundary: true, boundary: 'CAPTCHA', bulkSearchDone: true });
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['ACCESS_BARRIER']);
  });

  it('a licence requirement is a terms boundary, and a missing account is named for OPERATE', () => {
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { requiresLicence: true }).boundaries).toEqual(['TERMS_OR_LICENSE']);
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, { authorizedAccountOnRecord: false });
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
    expect(j.reusableConnectorJustified).toBe(false);
  });

  it('an unstated fact is never read as favourable', () => {
    const s = selectAccessMethod({});
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.considered.some((c) => c.fit && c.method !== 'HUMAN_HANDOFF')).toBe(false);
  });
});

describe('SEARCH_FIRST: existing corpora before any bespoke crawler', () => {
  it('ACQUIRE with no search done and nothing found is told to search first', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { stableHttpDocuments: true });
    expect(j.outcome).toBe('SEARCH_FIRST');
    expect(j.route).toBeNull();
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('a found bulk source is chosen over HTTP and proposes no crawler', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { existingBulkSources: ['catalog'], stableHttpDocuments: true });
    expect(j.route).toBe('BULK');
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('a bespoke crawler may be proposed only after the search ran and found nothing', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { bulkSearchDone: true, stableHttpDocuments: true });
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('HTTP');
    expect(j.bespokeCrawlerMayBeProposed).toBe(true);
  });

  it('OPERATE is never sent to search for corpora', () => {
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, { authorizedAccountOnRecord: true });
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('BROWSER');
  });
});

describe('reliability and cost ranking', () => {
  it('the spec order decides when nothing is measured', () => {
    expect(selectAccessMethod({ nativeAvailable: true, bulkAvailable: true, httpReadable: true }).method).toBe('NATIVE');
  });

  it('a measured-unreliable native route does not win by name', () => {
    const s = selectAccessMethod({ nativeAvailable: true, httpReadable: true, reliability: { NATIVE: 0.1, HTTP: 0.95 } });
    expect(s.method).toBe('HTTP');
  });

  it('cost lowers a route below an equally reliable cheaper one', () => {
    const s = selectAccessMethod({ bulkAvailable: true, httpReadable: true, reliability: { BULK: 0.9, HTTP: 0.9 }, costCents: { BULK: 20, HTTP: 1 } });
    expect(s.method).toBe('HTTP');
  });

  it('a familiar interface is a routine, not model-per-click; an unfamiliar one is model-assisted', () => {
    const base = { interfaceOnly: true, authorizedSession: true };
    expect(selectAccessMethod({ ...base, interfaceUnfamiliar: false }).method).toBe('BROWSER');
    expect(selectAccessMethod({ ...base, interfaceUnfamiliar: true }).method).toBe('BROWSER');
    const modelOnly = selectAccessMethod({ ...base, interfaceUnfamiliar: true, reliability: { BROWSER: 0.1, MODEL_ASSISTED: 0.9 } });
    expect(modelOnly.method).toBe('MODEL_ASSISTED');
  });

  it('terms are carried as constraints whichever route is chosen', () => {
    const s = selectAccessMethod({ httpReadable: true, terms: { rateLimitPerMinute: 30, rateLimited: true, privacyRestricted: true, licenceLimitsUse: 'internal only' } });
    const text = s.constraints.join(' | ');
    expect(text).toContain('30 requests a minute');
    expect(text).toContain('429');
    expect(text).toContain('privacy-restricted');
    expect(text).toContain('internal only');
  });
});

describe('model-assisted work converts to a tested script', () => {
  const base = { interfaceOnly: true, authorizedSession: true, interfaceUnfamiliar: true, reliability: { MODEL_ASSISTED: 0.9, BROWSER: 0.1 } };
  it(`converts after ${SCRIPT_CONVERSION_RUNS} unchanged runs`, () => {
    const s = selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS, stable: SCRIPT_CONVERSION_RUNS } });
    expect(s.method).toBe('MODEL_ASSISTED');
    expect(s.convertToScript).toBe(true);
  });
  it('does not convert too early or when a run changed', () => {
    expect(selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS - 1, stable: SCRIPT_CONVERSION_RUNS - 1 } }).convertToScript).toBe(false);
    expect(selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS, stable: SCRIPT_CONVERSION_RUNS - 1 } }).convertToScript).toBe(false);
    expect(selectAccessMethod(base).convertToScript).toBe(false);
  });
});

describe('reusable connector justification comes from recorded repetition', () => {
  const operate = { kind: 'OPERATE', purpose: 'p' } as const;
  it('OPERATE: needs at least two recorded uses', () => {
    expect(judgeAcquisitionNeed(operate, { authorizedAccountOnRecord: true, repeatedUses: 1 }).reusableConnectorJustified).toBe(false);
    const j = judgeAcquisitionNeed(operate, { authorizedAccountOnRecord: true, repeatedUses: 2 });
    expect(j.reusableConnectorJustified).toBe(true);
    expect(j.reason).toContain('repeated 2 times');
  });
  it('ACQUIRE: repetition must also have needed a fallback twice', () => {
    const ev = { bulkSearchDone: true, stableHttpDocuments: true };
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { ...ev, repeatedUses: 5, repeatedUsesNeedingFallback: 1 }).reusableConnectorJustified).toBe(false);
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { ...ev, repeatedUses: 5, repeatedUsesNeedingFallback: 2 }).reusableConnectorJustified).toBe(true);
  });
});

describe('recordAcquisitionJudgment writes one MEASURED row', () => {
  it('reads repetition from rows when the caller gave none, and records the judgment', async () => {
    const recorded: Record<string, unknown>[] = [];
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'use the portal', host: 'Portal.Example' },
      { authorizedAccountOnRecord: true },
      {
        repeatedUse: async (host) => {
          expect(host).toBe('Portal.Example');
          return { repeatedUses: 4, repeatedUsesNeedingFallback: 0 };
        },
        record: (async (e: Record<string, unknown>) => void recorded.push(e)) as never,
        proposalOnRecord: async () => false,
        caller: 'test',
      },
    );
    expect(j.reusableConnectorJustified).toBe(true);
    // The judgment row, then the proposal a justified connector produces.
    expect(recorded.map((e) => e.eventType)).toEqual(['ACQUISITION_JUDGMENT', 'CONNECTOR_PROPOSED']);
    const row = recorded[0] as { eventType: string; evidenceClass: string; outcome: string; workloadClass: string; measures: Record<string, unknown> };
    expect(row.eventType).toBe('ACQUISITION_JUDGMENT');
    expect(row.evidenceClass).toBe('MEASURED');
    expect(row.outcome).toBe('ROUTE_SELECTED');
    expect(row.workloadClass).toBe('test');
    expect(row.measures.host).toBe('portal.example');
    expect(row.measures.repeatedUses).toBe(4);
  });

  it('keeps caller-supplied repetition and does not read rows', async () => {
    let read = false;
    await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'h.example' },
      { authorizedAccountOnRecord: true, repeatedUses: 0 },
      { repeatedUse: async () => ((read = true), { repeatedUses: 9, repeatedUsesNeedingFallback: 9 }), record: (async () => undefined) as never },
    );
    expect(read).toBe(false);
  });
});

describe('robots.txt handling', () => {
  const rules = robotsRules(['# c', 'User-agent: Googlebot', 'Disallow: /g', '', 'User-agent: *', 'Disallow: /private', 'Allow: /private/open', 'Disallow: /*.pdf$', 'Crawl-delay: 5'].join('\n'));
  it('only the general-reader group binds, and empty Disallow states nothing', () => {
    expect(rules.map((r) => r.path)).toEqual(['/private', '/private/open', '/*.pdf$']);
    expect(robotsRules('User-agent: *\nDisallow:\n')).toEqual([]);
  });
  it('the longest matching rule wins; allow wins a tie; wildcards and $ anchors work', () => {
    expect(robotsAllows(rules, '/private/x')).toBe(false);
    expect(robotsAllows(rules, '/private/open/x')).toBe(true);
    expect(robotsAllows(rules, '/a/b.pdf')).toBe(false);
    expect(robotsAllows(rules, '/a/b.pdf?x=1')).toBe(true);
    expect(robotsAllows(rules, '/public')).toBe(true);
    expect(robotsAllows(robotsRules('User-agent: *\nAllow: /a\nDisallow: /a'), '/a')).toBe(true);
  });
  it('a robots refusal is a bot-restriction boundary, but a site error is not', () => {
    expect(boundaryOfRead({ readable: false, reason: 'ROBOTS', robotsBlocked: true })).toBe('BOT_RESTRICTION');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 404, robotsBlocked: true })).toBeNull();
    const s = selectAccessMethod({ terms: { robotsDisallows: true } });
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.constraints.join(' ')).toContain('robots.txt');
    expect(selectAccessMethod({ terms: { robotsDisallows: true }, bulkAvailable: true }).method).toBe('BULK');
  });
});

describe('read results map to boundaries and method classes', () => {
  it.each([
    [{ readable: false, reason: 'CHALLENGE' }, 'CAPTCHA'],
    [{ readable: false, reason: 'HTTP_ERROR', status: 401 }, 'AUTHENTICATION'],
    [{ readable: false, reason: 'HTTP_ERROR', status: 402 }, 'PAYMENT'],
    [{ readable: false, reason: 'HTTP_ERROR', status: 403 }, 'BOT_RESTRICTION'],
    [{ readable: false, reason: 'HTTP_ERROR', status: 451 }, 'LEGAL'],
    [{ readable: false, reason: 'HTTP_ERROR', status: 500 }, null],
    [{ readable: true }, null],
  ] as const)('%j -> %s', (read, expected) => {
    expect(boundaryOfRead(read as never)).toBe(expected);
  });
  it('existing routes keep one vocabulary', () => {
    expect(classOfRoute('CONNECTOR')).toBe('NATIVE');
    expect(classOfRoute('SITEMAP')).toBe('BULK');
    expect(classOfRoute('ARCHIVE')).toBe('BULK');
    expect(classOfRoute('BROWSER')).toBe('BROWSER');
    expect(classOfRoute('DIRECT')).toBe('HTTP');
  });
});

describe('repeatedUseFromRows is exercised alongside the judgment', () => {
  it('returns zeros for a host with no rows', () => {
    expect(repeatedUseFromRows([], 'none.example')).toEqual({ repeatedUses: 0, repeatedUsesNeedingFallback: 0 });
  });
});

describe('OPERATE has a production producer, separate from ACQUIRE', () => {
  const attempt = (method: string, readable: boolean) => ({ method: method as never, readable, reason: readable ? null : 'EMPTY', status: null, ms: 1 });
  const PAGE = 'Official statistics say the median wage was 41,000 dollars in 2025. '.repeat(10);
  const okFetch = (url: string) => ({ readable: true as const, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', retrievedAt: 'now', sha256: 'x', text: PAGE, truncated: false, totalChars: PAGE.length });
  const emptyFetch = (url: string) => ({ readable: false as const, requestedUrl: url, finalUrl: url, status: 200, retrievedAt: 'now', reason: 'EMPTY' as never, detail: 'needs a browser' });
  const capabilitiesOf = async (caller: string) => {
    const rows = await getDb().all<{ measures: string }>(`SELECT measures FROM bin_events WHERE event_type = 'ACQUISITION_JUDGMENT' AND workload_class = ?`, [caller]);
    return rows.map((r) => (JSON.parse(r.measures) as { capability: string }).capability).sort();
  };

  it('a read that never opened the browser says nothing about operating an interface', () => {
    expect(operateEvidenceOfRead({ attempts: [attempt('DIRECT', true)] }, null, {})).toBeNull();
  });

  it('a browser attempt is OPERATE evidence, and no account is ever asserted', () => {
    const ev = operateEvidenceOfRead({ attempts: [attempt('DIRECT', false), attempt('BROWSER', true)] }, null, { interfaceOnly: true, interfaceUnfamiliar: true });
    expect(ev).toMatchObject({ interactiveInterfaceOnly: true, interfaceUnfamiliarOrChanged: true, authorizedAccountOnRecord: false });
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, ev!);
    expect(j.capability).toBe('OPERATE');
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
  });

  it('a boundary met after the browser is carried into the OPERATE judgment', () => {
    const ev = operateEvidenceOfRead({ attempts: [attempt('BROWSER', false)] }, 'CAPTCHA', {})!;
    expect(ev.blockedAtBoundary).toBe(true);
    expect(judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, ev).boundaries).toEqual(['ACCESS_BARRIER']);
  });

  it('readSource writes one OPERATE and one ACQUIRE ACQUISITION_JUDGMENT row when the browser ran', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await readSource('https://operate-producer.example/app', {
      resolve: async () => ['93.184.216.34'],
      robotsAllow: async () => true,
      learned: async () => null,
      archive: async () => null,
      sitemap: async () => null,
      search: null,
      connector: async () => null,
      direct: async (u) => emptyFetch(u),
      browser: async (u) => okFetch(u),
      caller: 'operate-producer-test',
    });
    expect(await capabilitiesOf('operate-producer-test')).toEqual(['ACQUIRE', 'OPERATE']);
  });

  it('a plain direct read produces no OPERATE row', async () => {
    await freshProject();
    resetSourceAccessMemory();
    await readSource('https://plain-direct.example/p', {
      resolve: async () => ['93.184.216.34'],
      robotsAllow: async () => true,
      learned: async () => null,
      direct: async (u) => okFetch(u),
      caller: 'plain-direct-test',
    });
    expect(await capabilitiesOf('plain-direct-test')).toEqual(['ACQUIRE']);
  });
});
