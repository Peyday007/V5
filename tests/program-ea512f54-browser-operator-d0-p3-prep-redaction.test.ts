import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  REDACTED_URL_VALUE,
  SCREENSHOT_WITHHELD_REASON,
  isCredentialField,
  isSecretParam,
  redactFormValue,
  redactHeaders,
  redactLog,
  redactRun,
  redactScreenshot,
  redactStep,
  redactText,
  redactUrl,
  redactWorkflow,
} from '../server/services/sources/browser/redaction.ts';
import type { BrowserWorkflow, WorkflowRun } from '../server/services/sources/browserWorkflow.ts';

/*
 * ACQ-21-5: screenshots and logs of a browser routine never leak secrets.
 * Everything a routine records passes through this layer before a bin_events
 * row is written.
 */

// Fabricated, clearly fake values; none of them is a real credential.
const FAKE_TOKEN = 'abc123SECRETxyz789';
const FAKE_SESSION = 'S3SS10N-value-0042';
const FAKE_PASSWORD = 'not-a-real-pass-77';
const FAKE_COOKIE = 'sid=c00kie-value-11; theme=dark';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLWZha2U';

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  host: 'example.org',
  name: 'monthly export',
  outcome: 'COMPLETED',
  steps: [
    { index: 0, kind: 'navigate', ok: true, detail: `opened https://app.example.org/login?next=%2Freports&session_id=${FAKE_SESSION}` },
    { index: 1, kind: 'click', ok: true, detail: 'clicked button "Export"' },
  ],
  extracted: [{ name: 'table', text: `Rows: 12\nAuthorization: Bearer ${FAKE_TOKEN}1\nTotal 40`, truncated: false }],
  downloads: [{ name: 'csv', url: `https://cdn.example.org/r.csv?X-Amz-Signature=${FAKE_TOKEN}&X-Amz-Expires=300`, sha256: 'a'.repeat(64), chars: 10, text: 'a,b\n1,2' }],
  finalUrl: `https://app.example.org/done#access_token=${FAKE_TOKEN}&token_type=bearer&expires_in=3600`,
  boundary: null,
  interfaceChanged: false,
  detail: `completed; cookie: ${FAKE_COOKIE}`,
  ...over,
});

const secrets = [FAKE_TOKEN, FAKE_SESSION, FAKE_PASSWORD, 'c00kie-value-11', FAKE_JWT];
const leaks = (v: unknown) => secrets.filter((s) => JSON.stringify(v).includes(s));

describe('URLs: token-, session-, code- and key-like parameters are replaced', () => {
  it.each([
    ['access_token', FAKE_TOKEN],
    ['token', FAKE_TOKEN],
    ['id_token', FAKE_JWT],
    ['session_id', FAKE_SESSION],
    ['PHPSESSID', FAKE_SESSION],
    ['sid', FAKE_SESSION],
    ['code', 'oauth-code-998877'],
    ['state', 'csrf-state-123'],
    ['api_key', FAKE_TOKEN],
    ['apiKey', FAKE_TOKEN],
    ['key', FAKE_TOKEN],
    ['sig', FAKE_TOKEN],
    ['X-Amz-Signature', FAKE_TOKEN],
    ['X-Amz-Security-Token', FAKE_TOKEN],
    ['client_secret', FAKE_TOKEN],
    ['password', FAKE_PASSWORD],
  ])('replaces %s in the query', (name, value) => {
    const out = redactUrl(`https://app.example.org/path/a?page=2&${name}=${encodeURIComponent(value)}&sort=asc`);
    expect(out).toBe(`https://app.example.org/path/a?page=2&${name}=${REDACTED_URL_VALUE}&sort=asc`);
  });

  it('replaces secrets in the fragment, user-info and ;jsessionid path parameter', () => {
    expect(redactUrl(`https://app.example.org/cb#access_token=${FAKE_TOKEN}&token_type=bearer&expires_in=3600`)).toBe(
      `https://app.example.org/cb#access_token=${REDACTED_URL_VALUE}&token_type=${REDACTED_URL_VALUE}&expires_in=3600`,
    );
    expect(redactUrl(`https://user:${FAKE_PASSWORD}@app.example.org/x`)).toBe(`https://${REDACTED_URL_VALUE}@app.example.org/x`);
    expect(redactUrl(`https://app.example.org/a;jsessionid=${FAKE_SESSION}?q=1`)).toBe(`https://app.example.org/a;jsessionid=${REDACTED_URL_VALUE}?q=1`);
  });

  it('leaves a URL with no secret byte-identical, including its encoding', () => {
    for (const u of [
      'https://app.example.org/reports/2026?from=2026-01-01&to=2026-02-01&q=caf%C3%A9+bar#section-2',
      'https://example.org/',
      'https://example.org/search?author=jane&code_of_conduct',
      'not a url at all',
    ]) expect(redactUrl(u)).toBe(u);
  });

  it('does not treat ordinary parameter names as secrets', () => {
    for (const n of ['page', 'author', 'q', 'sort', 'category', 'id', 'from']) expect(isSecretParam(n)).toBe(false);
    for (const n of ['token', 'session', 'code', 'api-key', 'auth', 'xsrf-token']) expect(isSecretParam(n)).toBe(true);
  });
});

describe('credential-like fields and cookie/authorization headers never appear', () => {
  it('replaces header values by name, whatever they contain, and keeps the rest', () => {
    const out = redactHeaders({
      Cookie: FAKE_COOKIE,
      'Set-Cookie': [`sid=${FAKE_SESSION}; HttpOnly`],
      Authorization: `Bearer ${FAKE_TOKEN}`,
      'X-Api-Key': FAKE_TOKEN,
      'X-CSRF-Token': FAKE_TOKEN,
      'Content-Type': 'text/csv; charset=utf-8',
      Accept: 'text/html',
    });
    expect(leaks(out)).toEqual([]);
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toEqual([REDACTED]);
    expect(out.Authorization).toBe(REDACTED);
    expect(out['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(out.Accept).toBe('text/html');
  });

  it('replaces a value typed into a credential-like field, by type, name, label or autocomplete', () => {
    expect(redactFormValue({ type: 'password' }, FAKE_PASSWORD)).toBe(REDACTED);
    expect(redactFormValue({ name: 'otp' }, '123456')).toBe(REDACTED);
    expect(redactFormValue({ autocomplete: 'current-password' }, FAKE_PASSWORD)).toBe(REDACTED);
    expect(redactFormValue('Card number', '4111 1111 1111 1111')).toBe(REDACTED);
    expect(redactFormValue({ label: 'Search' }, 'quarterly report')).toBe('quarterly report');
    expect(redactFormValue({ label: 'Search' }, 'ghp_' + 'x'.repeat(30))).toBe(REDACTED);
    expect(isCredentialField({ label: 'Email' })).toBe(false);
  });

  it('a recorded fill step into a credential field keeps its locator and loses its value', () => {
    const step = redactStep({ kind: 'fill', locator: { label: 'Password' }, value: FAKE_PASSWORD });
    expect(step).toEqual({ kind: 'fill', locator: { label: 'Password' }, value: REDACTED });
    const plain = redactStep({ kind: 'fill', locator: { label: 'Search' }, value: 'widgets' });
    expect(plain).toEqual({ kind: 'fill', locator: { label: 'Search' }, value: 'widgets' });
  });

  it('free text: header lines, bearer tokens, JWTs, keyed secrets and issued Brain credentials', () => {
    const text = [
      `Authorization: Basic dXNlcjpwYXNzMTIz`,
      `Cookie: ${FAKE_COOKIE}`,
      `got ${FAKE_JWT} back`,
      `password=${FAKE_PASSWORD} and api_key: "${FAKE_TOKEN}"`,
      `worker brnw_0123456789abcdef.${FAKE_TOKEN}`,
      `see https://x.example.org/a?token=${FAKE_TOKEN}&page=3`,
    ].join('\n');
    const out = redactText(text);
    expect(leaks(out)).toEqual([]);
    expect(out).not.toContain('dXNlcjpwYXNzMTIz');
    expect(out).not.toContain('brnw_0123');
    expect(out).toContain(`https://x.example.org/a?token=${REDACTED_URL_VALUE}&page=3`);
  });
});

describe('a screenshot of a page with a credential field is withheld', () => {
  it('withholds by flag or by a listed credential field, dropping the image reference', () => {
    const a = redactScreenshot({ ref: 'shots/run-1/step-2.png', pageUrl: `https://app.example.org/login?session=${FAKE_SESSION}`, credentialField: true });
    expect(a.withheld).toBe(true);
    expect(a.ref).toBeNull();
    expect(a.withheldReason).toBe(SCREENSHOT_WITHHELD_REASON);
    expect(leaks(a)).toEqual([]);
    const b = redactScreenshot({ ref: 'shots/run-1/step-3.png', fields: [{ type: 'email', name: 'email' }, { type: 'password', name: 'pw' }] });
    expect(b.withheld).toBe(true);
    expect(b.ref).toBeNull();
  });

  it('keeps a masked capture and a page with no credential field', () => {
    const masked = redactScreenshot({ ref: 'shots/m.png', credentialField: true, masked: true });
    expect(masked.withheld).toBeUndefined();
    expect(masked.ref).toBe('shots/m.png');
    const plain = redactScreenshot({ ref: 'shots/p.png', fields: [{ type: 'search', name: 'q' }] });
    expect(plain.withheld).toBeUndefined();
    expect(plain.ref).toBe('shots/p.png');
  });

  it('redactLog withholds screenshots nested in a log entry', () => {
    const out = redactLog({ step: 2, screenshots: [{ ref: 'a.png', credentialField: true }, { ref: 'b.png' }], screenshot: { ref: 'c.png', fields: [{ autocomplete: 'one-time-code' }] } });
    expect(out.screenshots[0]).toMatchObject({ ref: null, withheld: true });
    expect(out.screenshots[1]).toMatchObject({ ref: 'b.png' });
    expect(out.screenshot).toMatchObject({ ref: null, withheld: true });
  });
});

describe('runs and arbitrary log entries', () => {
  it('redactRun removes every secret from steps, excerpts, downloads, final URL and detail', () => {
    const r = run();
    const out = redactRun(r);
    expect(leaks(out)).toEqual([]);
    expect(out.steps[1]!.detail).toBe('clicked button "Export"');
    expect(out.extracted[0]!.text.startsWith('Rows: 12\n')).toBe(true);
    expect(out.extracted[0]!.text.endsWith('\nTotal 40')).toBe(true);
    expect(out.downloads[0]!.sha256).toBe('a'.repeat(64));
    expect(out.downloads[0]!.url).toContain('X-Amz-Expires=300');
    expect(out.finalUrl).toContain('expires_in=3600');
    // the input is not mutated
    expect(leaks(r).length).toBeGreaterThan(0);
  });

  it('redactLog replaces credential-named keys whole and walks headers, steps and nested text', () => {
    const entry = {
      event: 'BROWSER_WORKFLOW_RUN',
      host: 'example.org',
      password: FAKE_PASSWORD,
      session: { id: FAKE_SESSION },
      storageState: { cookies: [{ name: 'sid', value: FAKE_SESSION }] },
      headers: { Cookie: FAKE_COOKIE, Accept: 'text/html' },
      url: `https://app.example.org/x?code=oauth-code-998877&page=1`,
      steps: [{ kind: 'fill', locator: { label: 'Passcode' }, value: '445566' }, { kind: 'navigate', url: `https://app.example.org/?token=${FAKE_TOKEN}` }],
      note: `server said token=${FAKE_TOKEN}`,
      count: 3,
      ok: true,
    };
    const out = redactLog(entry);
    expect(leaks(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('oauth-code-998877');
    expect(JSON.stringify(out)).not.toContain('445566');
    expect(out.password).toBe(REDACTED);
    expect(out.session).toBe(REDACTED);
    expect(out.storageState).toBe(REDACTED);
    expect(out.headers).toEqual({ Cookie: REDACTED, Accept: 'text/html' });
    expect(out.url).toBe(`https://app.example.org/x?code=${REDACTED_URL_VALUE}&page=1`);
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
  });

  it('redactWorkflow keeps the definition runnable in shape and drops typed credentials', () => {
    const wf: BrowserWorkflow = {
      host: 'example.org',
      name: 'export',
      purpose: 'monthly report',
      account: true,
      origin: 'AUTHORED',
      steps: [
        { kind: 'navigate', url: `https://example.org/start?sid=${FAKE_SESSION}` },
        { kind: 'fill', locator: { label: 'Month' }, value: '2026-10' },
        { kind: 'expect', text: 'Report ready' },
      ],
    };
    const out = redactWorkflow(wf);
    expect(leaks(out)).toEqual([]);
    expect(out.steps[1]).toEqual(wf.steps[1]);
    expect(out.steps[2]).toEqual(wf.steps[2]);
  });
});

describe('idempotent, and non-secret text is byte-identical', () => {
  const samples = [
    `opened https://app.example.org/login?next=%2Freports&session_id=${FAKE_SESSION}`,
    `Authorization: Bearer ${FAKE_TOKEN}1`,
    `cookie: ${FAKE_COOKIE}`,
    `password=${FAKE_PASSWORD}`,
    FAKE_JWT,
    `https://user:${FAKE_PASSWORD}@h.example.org/a;jsessionid=${FAKE_SESSION}?code=c0de1234#id_token=${FAKE_JWT}`,
  ];

  it('redacting twice equals redacting once', () => {
    for (const s of samples) expect(redactText(redactText(s))).toBe(redactText(s));
    for (const s of samples) expect(redactUrl(redactUrl(s))).toBe(redactUrl(s));
    const once = redactRun(run());
    expect(redactRun(once)).toEqual(once);
    const log = { headers: { Authorization: 'x' }, screenshot: { ref: 'a.png', credentialField: true }, steps: [{ kind: 'fill', locator: { label: 'PIN' }, value: '1234' }], note: samples.join(' ') };
    const l1 = redactLog(log);
    expect(redactLog(l1)).toEqual(l1);
  });

  it('leaves ordinary text, including near-miss words, untouched', () => {
    const plain = [
      'Clicked "Export to CSV" on the Reports page; 12 rows extracted.',
      'The bearer instrument is described in section 4. Basic information follows.',
      'Session 3 of the course starts Monday. The token economy chapter is long.',
      'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'Visit https://example.org/docs/getting-started?lang=en#install for details.',
      '  whitespace\tand\nnewlines are kept  ',
      'Ünïcödé — and emoji 📄 survive',
      '',
    ];
    for (const p of plain) expect(redactText(p)).toBe(p);
    expect(redactLog({ detail: plain[0], extracted: [{ text: plain[3] }] })).toEqual({ detail: plain[0], extracted: [{ text: plain[3] }] });
  });
});
