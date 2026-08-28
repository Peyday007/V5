/**
 * Server-rendered pages, and why there are any.
 *
 * Brain's product UI is the React client. These pages are not part of it, and
 * the separation is deliberate: they are the **operator console** — the screens
 * you need in order to set up access, or to get access back when something is
 * wrong.
 *
 * Two properties follow from that, and both are the reason not to build these
 * into the SPA:
 *
 *   * **They must work when the client bundle does not.** A failed `vite build`,
 *     a broken deploy of the front-end, or a browser that cannot run the bundle
 *     must not be able to lock an administrator out of worker administration.
 *     These pages are plain HTML from the server with no JavaScript at all.
 *
 *   * **They are the OAuth consent screen's neighbours.** A consent screen has
 *     to be server-rendered — it is a page an external client redirects a
 *     browser to, mid-flow, before any application session exists in the SPA's
 *     sense. Once one such page exists, the administration screens that grant
 *     the thing being consented to belong beside it, looking the same.
 *
 * Nothing here reads or writes project research. It is identity and access
 * only.
 */

/** Everything interpolated into a page goes through this. No exceptions. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:flex-start; justify-content:center;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:#f6f7f9; color:#14161a; padding:32px 24px; }
  .card { width:100%; max-width:640px; background:#fff; border:1px solid #e3e6ea; border-radius:14px;
    padding:28px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  .card + .card { margin-top:18px; }
  .stack { width:100%; max-width:640px; }
  h1 { font-size:20px; margin:0 0 6px; letter-spacing:-.01em; }
  h2 { font-size:15px; margin:0 0 14px; letter-spacing:-.01em; }
  p.sub { margin:0 0 20px; color:#5b636e; font-size:14px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 5px; }
  textarea, input[type=text], input[type=email], input[type=password], select {
    width:100%; padding:9px 11px; border:1px solid #cfd4da; border-radius:8px; font-size:14px;
    background:#fff; color:inherit; }
  /* Inherit nothing from the browser: a textarea defaults to a monospace face
     and its own box model, which reads as a different control beside the
     inputs it sits with. */
  textarea { font-family:inherit; resize:vertical; box-sizing:border-box; }
  button { width:100%; margin-top:20px; padding:11px; border:0; border-radius:8px;
    background:#14161a; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
  button.secondary { background:#fff; color:#14161a; border:1px solid #cfd4da; }
  button.danger { background:#fff; color:#8a1f1f; border:1px solid #f5c2c2; margin-top:0; width:auto;
    padding:6px 12px; font-size:13px; }
  .grant { background:#f6f7f9; border:1px solid #e3e6ea; border-radius:10px; padding:14px; margin:18px 0 4px; }
  .grant dt { font-size:12px; color:#5b636e; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .grant dd { margin:2px 0 12px; font-size:14px; }
  .grant dd:last-child { margin-bottom:0; }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:#eceef1;
    padding:1px 5px; border-radius:4px; }
  .err { background:#fdecec; border:1px solid #f5c2c2; color:#8a1f1f; padding:10px 12px;
    border-radius:8px; font-size:13px; margin-bottom:16px; }
  .ok { background:#e8f6ec; border:1px solid #b7e0c3; color:#1d5c31; padding:10px 12px;
    border-radius:8px; font-size:13px; margin-bottom:16px; }
  .note { font-size:12.5px; color:#5b636e; margin-top:16px; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:12px 0; border-bottom:1px solid #eceef1; }
  .row:last-child { border-bottom:0; }
  .row .who { font-size:14px; }
  .row .meta { font-size:12.5px; color:#5b636e; margin-top:2px; }
  .pill { display:inline-block; font-size:11px; font-weight:600; padding:2px 7px; border-radius:99px;
    background:#eceef1; color:#5b636e; text-transform:uppercase; letter-spacing:.04em; }
  .pill.off { background:#fdecec; color:#8a1f1f; }
  fieldset { border:1px solid #e3e6ea; border-radius:10px; padding:14px 16px; margin:18px 0 0; }
  legend { font-size:12px; font-weight:600; color:#5b636e; text-transform:uppercase; letter-spacing:.04em; padding:0 6px; }
  .actions { display:flex; gap:8px; align-items:center; }
  .inline { display:flex; gap:8px; align-items:center; width:100%; }
  .inline select { margin:0; }
  .inline button { margin-top:0; width:auto; white-space:nowrap; }
  label.check { display:flex; align-items:center; gap:8px; font-weight:400; font-size:13px;
    margin:14px 0 0; }
  label.check input { width:auto; margin:0; }
  .access { display:flex; align-items:center; justify-content:space-between; gap:10px;
    margin-top:6px; padding:6px 0 0; border-top:1px dashed #e3e6ea; }
  .access button { padding:3px 10px; font-size:12px; }
  .scopegroup { margin-bottom:14px; }
  .scopegroup:last-child { margin-bottom:0; }
  .grouphead { font-size:12px; font-weight:600; margin-bottom:6px; }
  .grouphead .note { font-weight:400; margin:0; }
  .scopes { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:6px 14px; }
  .scopes label { display:flex; align-items:center; gap:7px; font-weight:400; font-size:13px; margin:0; }
  .scopes input { margin:0; }
  @media (prefers-color-scheme: dark) {
    body { background:#0e1013; color:#e8eaed; }
    .card { background:#16191d; border-color:#2a2f36; box-shadow:none; }
    p.sub, .grant dt, .note, .row .meta, legend { color:#9aa3ad; }
    textarea, input[type=text], input[type=email], input[type=password], select {
      background:#0e1013; border-color:#3a414a; color:#e8eaed; }
    button { background:#e8eaed; color:#14161a; }
    button.secondary { background:#16191d; color:#e8eaed; border-color:#3a414a; }
    button.danger { background:#16191d; color:#f3b6b6; border-color:#5c2326; }
    .grant, fieldset { background:#0e1013; border-color:#2a2f36; }
    .access { border-top-color:#2a2f36; }
    code, .pill { background:#22262c; }
    .err { background:#2b1416; border-color:#5c2326; color:#f3b6b6; }
    .ok { background:#10231a; border-color:#1f4a30; color:#a7dcb8; }
    .row { border-color:#22262c; }
    .pill.off { background:#2b1416; color:#f3b6b6; }
  }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="stack">${body}</div></body></html>`;
}

export function card(body: string): string {
  return `<div class="card">${body}</div>`;
}
