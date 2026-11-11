/**
 * What a browser workflow step does inside the page, as one function the
 * browser evaluates (ACQ-21-2's browser class).
 *
 * Kept apart from `browserWorkflow.ts` so the in-page code is one reviewable
 * string and the orchestration around it is ordinary TypeScript. The function
 * is sent through Playwright MCP's `browser_evaluate`, runs in the page under
 * whatever session the workflow established, and returns a JSON string so its
 * shape survives the tool's own serialisation (as `browserMcp.ts` does).
 *
 * Reliable locators: an element is found by CSS, accessible label, role and
 * name, visible text, test id or placeholder, and a locator that matches
 * nothing or more than one visible element fails instead of guessing. That
 * failure is what tells Brain the interface changed (`browserWorkflow.ts`).
 */

export type Locator =
  | { css: string }
  | { label: string }
  | { role: string; name?: string }
  | { text: string }
  | { testId: string }
  | { placeholder: string };

export type PageAction =
  | { op: 'state' }
  | { op: 'outline' }
  | { op: 'fill'; locator: Locator; value: string }
  | { op: 'select'; locator: Locator; value: string }
  | { op: 'check'; locator: Locator; checked: boolean }
  | { op: 'click'; locator: Locator }
  | { op: 'present'; locator?: Locator; text?: string }
  | { op: 'extract'; locator?: Locator; maxChars: number }
  | { op: 'download'; locator?: Locator; url?: string; maxChars: number };

export interface PageActionResult {
  ok: boolean;
  url: string;
  title: string;
  /** Why it failed; never contains a filled value. */
  detail?: string;
  /** NOT_FOUND / AMBIGUOUS mean the locator no longer fits the interface. */
  miss?: 'NOT_FOUND' | 'AMBIGUOUS';
  text?: string;
  totalChars?: number;
  contentType?: string;
  href?: string;
  /** For `state`: whether the page shows a password field. */
  passwordField?: boolean;
  /** For `outline`: the interactive elements a model-assisted repair can work from. */
  elements?: { tag: string; role: string | null; name: string; type: string | null; id: string | null }[];
}

/**
 * The in-page function. Its argument is embedded as JSON (never interpolated
 * as code), so a value cannot become script.
 */
export function pageActionSource(action: PageAction): string {
  return `async () => { const a = ${JSON.stringify(action)}; return JSON.stringify(await (${PAGE_ACTION_BODY})(a)); }`;
}

/* The body is plain browser JavaScript. */
const PAGE_ACTION_BODY = `async (a) => {
  const base = () => ({ url: location.href, title: document.title });
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 || r.height > 0) && s.visibility !== 'hidden' && s.display !== 'none'; };
  const norm = (t) => String(t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const nameOf = (el) => norm(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '');
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button' || (t === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
    if (t === 'input' && type === 'checkbox') return 'checkbox';
    if (t === 'input' && type === 'radio') return 'radio';
    if (t === 'input' || t === 'textarea') return type === 'search' ? 'searchbox' : 'textbox';
    if (t === 'select') return 'combobox';
    return null;
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
  const find = (l) => {
    let found = [];
    if (l.css) found = all(l.css);
    else if (l.testId) found = all('[data-testid="' + CSS.escape(l.testId) + '"]');
    else if (l.placeholder) found = all('[placeholder]').filter((e) => norm(e.getAttribute('placeholder')) === norm(l.placeholder));
    else if (l.label) {
      const want = norm(l.label);
      const byLabel = all('label').filter((e) => norm(e.innerText) === want).map((e) => e.control).filter(Boolean);
      const byAria = all('[aria-label]').filter((e) => norm(e.getAttribute('aria-label')) === want);
      found = Array.from(new Set([...byLabel, ...byAria]));
    } else if (l.role) found = all('a,button,input,select,textarea,[role]').filter((e) => roleOf(e) === l.role && (l.name === undefined || nameOf(e) === norm(l.name)));
    else if (l.text) { const want = norm(l.text); found = all('a,button,[role=button],[role=link],[role=tab],[role=menuitem],label,summary,li,td,th,span,div').filter((e) => norm(e.innerText) === want); found = found.filter((e) => !found.some((o) => o !== e && e.contains(o))); }
    if (found.length === 0) return { miss: 'NOT_FOUND' };
    if (found.length > 1) return { miss: 'AMBIGUOUS', count: found.length };
    return { el: found[0] };
  };
  const located = (l) => { const f = find(l); if (!f.el) return { fail: { ...base(), ok: false, miss: f.miss, detail: f.miss === 'AMBIGUOUS' ? f.count + ' elements match the locator' : 'no element matches the locator' } }; return f; };
  const setValue = (el, v) => { const proto = Object.getPrototypeOf(el); const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const bodyText = () => (document.body ? document.body.innerText : '');
  switch (a.op) {
    case 'state': return { ...base(), ok: true, text: bodyText().slice(0, 4000), passwordField: all('input[type=password]').length > 0 };
    case 'outline': return { ...base(), ok: true, elements: all('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab]').slice(0, 80).map((e) => ({ tag: e.tagName.toLowerCase(), role: roleOf(e), name: nameOf(e).slice(0, 80), type: e.getAttribute('type'), id: e.id || null })) };
    case 'fill': case 'select': { const f = located(a.locator); if (f.fail) return f.fail; if (!('value' in f.el)) return { ...base(), ok: false, detail: 'the element takes no value' }; f.el.focus(); setValue(f.el, a.value); return { ...base(), ok: true }; }
    case 'check': { const f = located(a.locator); if (f.fail) return f.fail; if (f.el.checked !== a.checked) f.el.click(); return { ...base(), ok: f.el.checked === a.checked, detail: f.el.checked === a.checked ? undefined : 'the box did not take the state' }; }
    case 'click': { const f = located(a.locator); if (f.fail) return f.fail; f.el.click(); return { ...base(), ok: true }; }
    case 'present': {
      if (a.locator) { const f = find(a.locator); return { ...base(), ok: Boolean(f.el), miss: f.el ? undefined : f.miss, detail: f.el ? undefined : 'the expected element is not on the page' }; }
      const ok = norm(bodyText()).includes(norm(a.text)); return { ...base(), ok, detail: ok ? undefined : 'the expected text is not on the page' };
    }
    case 'extract': {
      let text = bodyText();
      if (a.locator) { const f = located(a.locator); if (f.fail) return f.fail; text = f.el.innerText || f.el.value || ''; }
      text = text.replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n\\n').trim();
      return { ...base(), ok: text.length > 0, text: text.slice(0, a.maxChars), totalChars: text.length, detail: text.length > 0 ? undefined : 'nothing to extract' };
    }
    case 'download': {
      let href = a.url || null;
      if (!href && a.locator) { const f = located(a.locator); if (f.fail) return f.fail; href = f.el.href || f.el.getAttribute('href') || f.el.getAttribute('data-href'); }
      if (!href) return { ...base(), ok: false, detail: 'no download address' };
      const target = new URL(href, location.href);
      if (target.origin !== location.origin) return { ...base(), ok: false, href: target.href, detail: 'the download is on another origin' };
      const res = await fetch(target.href, { credentials: 'same-origin' });
      const type = res.headers.get('content-type') || '';
      if (!res.ok) return { ...base(), ok: false, href: target.href, detail: 'the download answered ' + res.status };
      if (!/text|json|csv|xml|javascript/i.test(type)) return { ...base(), ok: false, href: target.href, contentType: type, detail: 'the download is not text (' + type + ')' };
      const text = await res.text();
      return { ...base(), ok: text.length > 0, href: target.href, contentType: type, text: text.slice(0, a.maxChars), totalChars: text.length };
    }
  }
  return { ...base(), ok: false, detail: 'unknown action' };
}`;
