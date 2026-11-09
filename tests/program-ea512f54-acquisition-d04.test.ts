import { describe, expect, it } from 'vitest';
import {
  SCRIPT_CONVERSION_RUNS,
  boundaryOfRead,
  classOfRoute,
  selectAccessMethod,
} from '../server/services/sources/accessMethods.ts';
import {
  judgeAcquisitionNeed,
  recordAcquisitionJudgment,
  repeatedUseFromRows,
} from '../server/services/sources/acquisition.ts';

describe('selectAccessMethod: boundaries stop automation', () => {
  it.each([
    ['AUTHENTICATION', 'authorized account'],
    ['OWNER_CONSENT', 'consent'],
    ['CAPTCHA', 'not solved by Brain'],
    ['BOT_RESTRICTION', 'permission from the site'],
    ['PAYMENT', 'approve the purchase'],
    ['LEGAL', 'legal position'],
  ] as const)('%s ends in a human handoff naming the permitted route, even when other routes fit', (boundary, text) => {
    const s = selectAccessMethod({ boundary, nativeAvailable: true, bulkAvailable: true, httpReadable: true });
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.handoff).toContain(text);
    expect(s.convertToScript).toBe(false);
    expect(s.considered.filter((c) => c.fit).map((c) => c.method)).toEqual(['HUMAN_HANDOFF']);
  });

  it('a named permitted route is the handoff', () => {
    const s = selectAccessMethod({ boundary: 'CAPTCHA', permittedRoute: 'the vendor export' });
    expect(s.handoff).toBe('the vendor export');
  });

  it('a required licence is a handoff to the spending authority', () => {
    const s = selectAccessMethod({ needsLicence: true, httpReadable: true });
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.why).toContain('licence is required');
  });
});

describe('selectAccessMethod: robots.txt', () => {
  it('robots disallow with no other permitted route is a handoff', () => {
    const s = selectAccessMethod({ httpReadable: true, terms: { robotsDisallows: true } });
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.why).toContain('robots.txt');
    expect(s.constraints.join(' ')).toContain('robots.txt disallows');
  });

  it('robots disallow does not stop a native or bulk route that does not read the page', () => {
    expect(selectAccessMethod({ nativeAvailable: true, terms: { robotsDisallows: true } }).method).toBe('NATIVE');
    expect(selectAccessMethod({ bulkAvailable: true, terms: { robotsDisallows: true } }).method).toBe('BULK');
  });

  it('a permitted route lets robots-disallowed work be handed off by name', () => {
    const s = selectAccessMethod({ httpReadable: true, terms: { robotsDisallows: true }, permittedRoute: 'partner feed' });
    expect(s.method).toBe('HTTP');
  });

  it('rate limit, privacy and licence terms become constraints', () => {
    const s = selectAccessMethod({
      httpReadable: true,
      terms: { rateLimitPerMinute: 30, rateLimited: true, privacyRestricted: true, licenceLimitsUse: 'internal only' },
    });
    const c = s.constraints.join('|');
    expect(c).toContain('at most 30 requests a minute');
    expect(c).toContain('429');
    expect(c).toContain('privacy-restricted');
    expect(c).toContain('internal only');
  });
});

describe('selectAccessMethod: reliability and cost ranking', () => {
  it('prefers spec order when nothing is measured', () => {
    expect(selectAccessMethod({ nativeAvailable: true, bulkAvailable: true, httpReadable: true }).method).toBe('NATIVE');
    expect(selectAccessMethod({ bulkAvailable: true, httpReadable: true }).method).toBe('BULK');
  });

  it('a measured-unreliable native route does not win by name', () => {
    const s = selectAccessMethod({ nativeAvailable: true, httpReadable: true, reliability: { NATIVE: 0.1, HTTP: 0.9 } });
    expect(s.method).toBe('HTTP');
  });

  it('cost lowers a route below a cheaper one of equal reliability', () => {
    const s = selectAccessMethod({ nativeAvailable: true, bulkAvailable: true, costCents: { NATIVE: 20, BULK: 1 } });
    expect(s.method).toBe('BULK');
  });

  it('reports unavailable versus unevidenced routes', () => {
    const s = selectAccessMethod({ nativeAvailable: false, httpReadable: true });
    expect(s.considered.find((c) => c.method === 'NATIVE')?.note).toContain('not available');
    expect(s.considered.find((c) => c.method === 'BULK')?.note).toContain('no evidence');
  });

  it('no evidenced route is a handoff, never an assumption', () => {
    const s = selectAccessMethod({});
    expect(s.method).toBe('HUMAN_HANDOFF');
    expect(s.handoff).toContain('official export');
  });
});

describe('selectAccessMethod: browser, model-assisted and script conversion', () => {
  const iface = { interfaceOnly: true, authorizedSession: true };

  it('a familiar interface uses the browser routine, not model-per-click', () => {
    expect(selectAccessMethod({ ...iface }).method).toBe('BROWSER');
  });

  it('an unfamiliar interface is model-assisted', () => {
    expect(selectAccessMethod({ ...iface, interfaceUnfamiliar: true, reliability: { MODEL_ASSISTED: 0.9 } }).method).toBe('MODEL_ASSISTED');
  });

  it('an interface without an authorized session is not operated', () => {
    expect(selectAccessMethod({ interfaceOnly: true, authorizedSession: false }).method).toBe('HUMAN_HANDOFF');
  });

  it('a stable recurring model-assisted pattern converts to a script at the threshold only', () => {
    const base = { ...iface, interfaceUnfamiliar: true, reliability: { MODEL_ASSISTED: 0.9 } };
    expect(selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS, stable: SCRIPT_CONVERSION_RUNS } }).convertToScript).toBe(true);
    expect(selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS - 1, stable: SCRIPT_CONVERSION_RUNS - 1 } }).convertToScript).toBe(false);
    expect(selectAccessMethod({ ...base, recurrence: { runs: SCRIPT_CONVERSION_RUNS, stable: SCRIPT_CONVERSION_RUNS - 1 } }).convertToScript).toBe(false);
  });
});

describe('classOfRoute and boundaryOfRead', () => {
  it('maps read routes to method classes', () => {
    expect(classOfRoute('CONNECTOR')).toBe('NATIVE');
    expect(classOfRoute('SITEMAP')).toBe('BULK');
    expect(classOfRoute('ARCHIVE')).toBe('BULK');
    expect(classOfRoute('BROWSER')).toBe('BROWSER');
    expect(classOfRoute('DIRECT')).toBe('HTTP');
  });

  it('turns refusals into boundaries and leaves ordinary failures alone', () => {
    expect(boundaryOfRead({ readable: true })).toBeNull();
    expect(boundaryOfRead({ readable: false, reason: 'CHALLENGE' })).toBe('CAPTCHA');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 401 })).toBe('AUTHENTICATION');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 402 })).toBe('PAYMENT');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 403 })).toBe('BOT_RESTRICTION');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 451 })).toBe('LEGAL');
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 404 })).toBeNull();
    expect(boundaryOfRead({ readable: false, reason: 'HTTP_ERROR', status: 500, robotsBlocked: true })).toBeNull();
    expect(boundaryOfRead({ readable: false, reason: 'EMPTY', robotsBlocked: true })).toBe('BOT_RESTRICTION');
  });
});

describe('judgeAcquisitionNeed', () => {
  it('refuses contacting strangers, evading defences and business commitments, in either capability', () => {
    for (const kind of ['OPERATE', 'ACQUIRE'] as const) {
      const a = judgeAcquisitionNeed({ kind, purpose: 'x', contactsStrangers: true }, { nativeIntegrationAvailable: true });
      expect(a.outcome).toBe('REFUSED');
      expect(a.route).toBeNull();
      expect(a.boundaries).toEqual(['CONTACT_STRANGERS']);
      const b = judgeAcquisitionNeed({ kind, purpose: 'x', evadesDefenses: true });
      expect(b.boundaries).toEqual(['EVADE_SITE_DEFENSES']);
      expect(b.reason).toContain("evade a site's defenses");
      const c = judgeAcquisitionNeed({ kind, purpose: 'x', makesBusinessCommitment: true });
      expect(c.boundaries).toEqual(['BUSINESS_COMMITMENT']);
    }
    const all = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'x', contactsStrangers: true, evadesDefenses: true, makesBusinessCommitment: true });
    expect(all.boundaries).toEqual(['CONTACT_STRANGERS', 'EVADE_SITE_DEFENSES', 'BUSINESS_COMMITMENT']);
    expect(all.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('ACQUIRE searches for existing corpora before any bespoke crawler', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'filings' }, { stableHttpDocuments: true });
    expect(j.outcome).toBe('SEARCH_FIRST');
    expect(j.route).toBeNull();
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('after the search finds a bulk source it is chosen and no crawler is proposed', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'filings' }, { existingBulkSources: ['catalog'], bulkSearchDone: true, stableHttpDocuments: true });
    expect(j.route).toBe('BULK');
    expect(j.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('after the search finds nothing a bespoke HTTP crawler may be proposed', () => {
    const j = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'filings' }, { bulkSearchDone: true, stableHttpDocuments: true });
    expect(j.outcome).toBe('ROUTE_SELECTED');
    expect(j.route).toBe('HTTP');
    expect(j.bespokeCrawlerMayBeProposed).toBe(true);
  });

  it('a boundary or licence is handed off, not searched around', () => {
    const blocked = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'x' }, { blockedAtBoundary: true, boundary: 'CAPTCHA' });
    expect(blocked.route).toBe('HUMAN_HANDOFF');
    expect(blocked.boundaries).toEqual(['ACCESS_BARRIER']);
    expect(blocked.reusableConnectorJustified).toBe(false);
    const defaulted = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'x' }, { blockedAtBoundary: true });
    expect(defaulted.reason).toContain('AUTHENTICATION');
    const licence = judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'x' }, { requiresLicence: true });
    expect(licence.boundaries).toEqual(['TERMS_OR_LICENSE']);
  });

  it('OPERATE without an authorized account is a handoff naming that', () => {
    const j = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'export report', host: 'x.example' }, {});
    expect(j.route).toBe('HUMAN_HANDOFF');
    expect(j.boundaries).toEqual(['NO_AUTHORIZED_ACCOUNT']);
  });

  it('OPERATE with an account uses the browser, and repetition justifies a reusable connector', () => {
    const once = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, { authorizedAccountOnRecord: true, repeatedUses: 1 });
    expect(once.route).toBe('BROWSER');
    expect(once.reusableConnectorJustified).toBe(false);
    expect(once.reason).toContain('does not yet justify');
    const many = judgeAcquisitionNeed({ kind: 'OPERATE', purpose: 'p' }, { authorizedAccountOnRecord: true, repeatedUses: 2 });
    expect(many.reusableConnectorJustified).toBe(true);
    expect(many.reason).toContain('reusable connector');
    expect(many.bespokeCrawlerMayBeProposed).toBe(false);
  });

  it('ACQUIRE connector needs repetition that also needed fallbacks', () => {
    const ev = { bulkSearchDone: true, stableHttpDocuments: true };
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { ...ev, repeatedUses: 5, repeatedUsesNeedingFallback: 1 }).reusableConnectorJustified).toBe(false);
    expect(judgeAcquisitionNeed({ kind: 'ACQUIRE', purpose: 'p' }, { ...ev, repeatedUses: 5, repeatedUsesNeedingFallback: 2 }).reusableConnectorJustified).toBe(true);
  });

  it('is pure: the same inputs give the same judgment', () => {
    const need = { kind: 'ACQUIRE', purpose: 'p' } as const;
    const ev = { bulkSearchDone: true, nativeIntegrationAvailable: true };
    expect(judgeAcquisitionNeed(need, ev)).toEqual(judgeAcquisitionNeed(need, ev));
  });
});

describe('repeatedUseFromRows', () => {
  const row = (host: unknown, provider: string | null) => ({ provider, measures: JSON.stringify({ host }) });

  it('counts uses of one host case-insensitively and fallbacks beyond DIRECT', () => {
    const rows = [row('A.example', 'DIRECT'), row('a.example', 'BROWSER'), row('a.example', 'ARCHIVE'), row('b.example', 'BROWSER'), row('a.example', null)];
    expect(repeatedUseFromRows(rows, 'a.EXAMPLE')).toEqual({ repeatedUses: 4, repeatedUsesNeedingFallback: 2 });
  });

  it('ignores unknown providers, malformed or missing measures and non-string hosts', () => {
    const rows = [
      row('a.example', 'MYSTERY'),
      { provider: 'BROWSER', measures: '{not json' },
      { provider: 'BROWSER', measures: null },
      row(42, 'BROWSER'),
    ];
    expect(repeatedUseFromRows(rows, 'a.example')).toEqual({ repeatedUses: 1, repeatedUsesNeedingFallback: 0 });
  });
});

describe('recordAcquisitionJudgment', () => {
  it('reads repetition from rows when the host is named, and records a MEASURED judgment', async () => {
    const recorded: Record<string, unknown>[] = [];
    const j = await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p'.repeat(400), host: 'X.Example' },
      { authorizedAccountOnRecord: true },
      {
        repeatedUse: async (host) => {
          expect(host).toBe('X.Example');
          return { repeatedUses: 3, repeatedUsesNeedingFallback: 0 };
        },
        record: (async (e: Record<string, unknown>) => {
          recorded.push(e);
        }) as never,
        caller: 'test',
      },
    );
    expect(j.reusableConnectorJustified).toBe(true);
    expect(recorded).toHaveLength(1);
    const e = recorded[0]!;
    expect(e.eventType).toBe('ACQUISITION_JUDGMENT');
    expect(e.evidenceClass).toBe('MEASURED');
    expect(e.workloadClass).toBe('test');
    expect(e.provider).toBe('BROWSER');
    const m = e.measures as Record<string, unknown>;
    expect(m.host).toBe('x.example');
    expect((m.purpose as string).length).toBe(300);
    expect(m.repeatedUses).toBe(3);
  });

  it('keeps caller-supplied repetition and does not read rows', async () => {
    let read = false;
    await recordAcquisitionJudgment(
      { kind: 'OPERATE', purpose: 'p', host: 'h' },
      { authorizedAccountOnRecord: true, repeatedUses: 0 },
      {
        repeatedUse: async () => {
          read = true;
          return { repeatedUses: 9, repeatedUsesNeedingFallback: 9 };
        },
        record: (async () => {}) as never,
      },
    );
    expect(read).toBe(false);
  });

  it('records a refusal with no route', async () => {
    const recorded: Record<string, unknown>[] = [];
    await recordAcquisitionJudgment({ kind: 'ACQUIRE', purpose: 'p', contactsStrangers: true }, {}, { record: (async (e: Record<string, unknown>) => void recorded.push(e)) as never });
    expect(recorded[0]!.outcome).toBe('REFUSED');
    expect(recorded[0]!.provider).toBeNull();
  });
});
