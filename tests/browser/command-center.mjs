#!/usr/bin/env node
/**
 * The Command Center in a real browser, against a real Brain (§42, §120).
 *
 *   node tests/browser/command-center.mjs [--shots <dir>]
 *
 * Boots a throwaway production-mode Brain on a free port with an empty
 * database, signs in through the Command Center's own form, and drives every
 * page on a desktop and a phone viewport: each renders, nothing overflows
 * sideways, no page error is thrown. Then it does the work a person does —
 * records an objective, opens it, pauses and resumes it through Brain,
 * starts a conversation and sends a turn — and leaves a page open to prove it
 * re-reads Brain on its own. Screenshots land in --shots (default: a temp dir).
 *
 * Needs `command/out` (cd command && npm ci && npm run build) and Playwright's
 * Chromium. Exits non-zero on any failed check.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const shotsArg = process.argv.indexOf('--shots');
const OUT = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'command-shots-'));
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(path.join(ROOT, 'command', 'out', 'index.html'))) {
  console.error('command/out is missing: run `cd command && npm ci && npm run build` first.');
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'command-check@example.test';
const FIRST = `First-${Math.random().toString(36).slice(2)}!A1`;
const PASSWORD = `Second-${Math.random().toString(36).slice(2)}!B2`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-brain-'));
// Local mode only: a throwaway SQLite file, never a configured cloud database or bucket.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(BRAIN_DATABASE|BRAIN_STORAGE|SUPABASE|DATABASE_URL)/.test(k))
);
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: ROOT,
  env: { ...env, NODE_ENV: 'production', PORT: String(PORT), BRAIN_DATA_DIR: dataDir, BRAIN_BOOTSTRAP_ADMIN_EMAIL: EMAIL, BRAIN_BOOTSTRAP_ADMIN_PASSWORD: FIRST },
  stdio: ['ignore', 'ignore', 'inherit']
});
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

for (let i = 0; i < 90; i++) {
  const ok = await fetch(`${BASE}/healthz`).then((r) => r.ok, () => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// The account a person would have: password changed, a member of the project.
let cookie = '';
async function api(method, p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
await api('POST', '/api/auth/login', { email: EMAIL, password: FIRST });
await api('POST', '/api/auth/password', { currentPassword: FIRST, newPassword: PASSWORD });
const session = await api('GET', '/api/auth/session');
const homes = await api('GET', '/api/projects/homes');
const projectId = homes.cash ?? homes.fallback;
if (projectId) await api('POST', `/api/admin/projects/${projectId}/members`, { principalType: 'HUMAN', principalId: session.user.id, role: 'OWNER' });
process.env.EMAIL = EMAIL;
process.env.PASSWORD = PASSWORD;

const PAGES = ['', 'conversation/', 'objectives/', 'plans/', 'operations/', 'agents/', 'committee/', 'knowledge/', 'reports/', 'approvals/', 'settings/'];
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); }

async function signIn(page) {
  await page.goto(`${BASE}/command/`);
  await page.getByText('Sign in to Brain').waitFor();
  await page.getByRole('button', { name: 'Use a password' }).click();
  await page.getByLabel('Email or name').fill(process.env.EMAIL);
  await page.getByLabel('Password').fill(process.env.PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 20000 });
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, ctxOpts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['mobile', { ...devices['iPhone 13'] }]]) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    if (label === 'desktop') {
      await page.goto(`${BASE}/command/`);
      await page.getByText('Sign in to Brain').waitFor();
      await page.screenshot({ path: `${OUT}/${label}-00-signin.png` });
    }
    await signIn(page);
    for (const p of PAGES) {
      await page.goto(`${BASE}/command/${p}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);
      const h1 = await page.locator('h1').first().textContent();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${label} /${p} renders`, !!h1, h1);
      check(`${label} /${p} no horizontal overflow`, !overflow);
      await page.screenshot({ path: `${OUT}/${label}-${(p || 'overview').replace('/', '')}.png`, fullPage: true });
    }
    check(`${label} no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    if (label === 'mobile') {
      await page.goto(`${BASE}/command/`);
      await page.getByRole('button', { name: 'Toggle sidebar' }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/mobile-nav-open.png` });
      await page.getByRole('link', { name: 'Live operations' }).click();
      await page.getByRole('heading', { name: 'Live operations' }).waitFor();
      check('mobile nav navigates', true);
    }
    if (label === 'desktop') {
      // Functional: record an objective through Brain's own route.
      await page.goto(`${BASE}/command/objectives/`);
      await page.getByRole('button', { name: 'New objective' }).click();
      const amount = 1000 + Math.floor(Math.random() * 8000);
      const objective = `Generate $${amount.toLocaleString('en-US')} within 30 days using at most $500 in starting capital.`;
      await page.getByRole('textbox', { name: 'Objective' }).fill(objective);
      await page.getByRole('button', { name: 'Record objective' }).click();
      const created = await page.locator('[data-slot="card-title"]', { hasText: objective }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      const toast = await page.locator('[data-sonner-toast]').first().textContent().catch(() => '');
      check('create objective appears', created, toast || '');
      await page.screenshot({ path: `${OUT}/desktop-objectives-after-create.png`, fullPage: true });
      if (created) {
        await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
        await page.getByRole('button', { name: 'Details' }).first().click();
        await page.getByText('Why this state').waitFor({ timeout: 10000 });
        await page.screenshot({ path: `${OUT}/desktop-objective-detail.png` });
        check('objective detail opens', true);
        await page.getByRole('button', { name: 'Pause' }).click();
        const paused = await page.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
        check('pause through Brain', paused);
        if (paused) {
          await page.getByRole('button', { name: 'Resume' }).click();
          const resumed = await page.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
          check('resume through Brain', resumed);
        }
        await page.keyboard.press('Escape');
      }
      // Functional: talk to Brain.
      await page.goto(`${BASE}/command/conversation/`);
      await page.getByRole('button', { name: 'New conversation' }).click();
      await page.getByLabel('Message Brain').waitFor();
      await page.getByLabel('Message Brain').fill('What are you working on right now?');
      await page.getByRole('button', { name: 'Send' }).click();
      const sent = await page.getByText('What are you working on right now?').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      check('conversation turn sent and shown', sent);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/desktop-conversation-after-send.png`, fullPage: true });
      // Live: the overview re-reads on its own.
      await page.goto(`${BASE}/command/`);
      await page.waitForLoadState('networkidle');
      let reads = 0;
      page.on('request', (r) => { if (r.url().includes('/api/')) reads++; });
      await page.waitForTimeout(23000);
      check('overview re-reads Brain without a reload', reads > 0, `${reads} reads in 23s`);
      // Dark mode.
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`${BASE}/command/plans/`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${OUT}/desktop-dark-plans.png`, fullPage: true });
      await page.goto(`${BASE}/command/`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${OUT}/desktop-dark-overview.png`, fullPage: true });
    }
    await ctx.close();
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`screenshots: ${OUT}`);
  stop();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); stop(); process.exit(2); });
