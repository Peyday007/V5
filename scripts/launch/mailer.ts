/**
 * Mailer stage of the launch runner: the selling materials, finished.
 *
 * Reads what the Stripe stage wrote (`.launch-out/stripe-links.json`: the 8
 * payment links and the owner's public business details from his Stripe
 * account), copies the mailer kit to `.launch-out/mailer/`, fills every
 * `[Owner …]` placeholder, adds the payment links to the order form and the
 * sales kit, and re-renders the card and rate card with the owner's details.
 * The committed kit is never edited; the finished copy is the workflow's
 * artifact.
 *
 *   npx tsx scripts/launch/mailer.ts dry-run | run
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OwnerContact } from './stripe.ts';
import type { StageContext, StageResult } from './types.ts';

const KIT = 'fast-cash/launch-2026-11-11/mailer';

/** Every placeholder spelling the kit uses, mapped to a contact field. */
export function placeholders(c: OwnerContact): Array<[RegExp, string | undefined]> {
  const addr = c.address;
  return [
    [/\[(Owner's full legal name|Owner's legal name|Full legal name|Owner name|Owner's name)\]/g, c.name],
    [/\[(Owner's mailing address|Physical mailing address|mailing address|address)\]/g, addr],
    [/\[(Owner phone|owner phone|phone)\]/g, c.phone],
    [/\[(owner email|Owner email|email)\]/g, c.email],
    [/\[Town\]/g, c.town],
    [/\[ZIP\]/g, c.zip],
  ];
}

export function fill(text: string, c: OwnerContact): { text: string; missing: string[] } {
  const missing = new Set<string>();
  let out = text;
  for (const [re, v] of placeholders(c)) {
    out = out.replace(re, (m) => {
      if (v) return v;
      missing.add(m);
      return m;
    });
  }
  return { text: out, missing: [...missing] };
}

export function linksSection(links: Array<{ name: string; amount: number; url: string }>): string {
  const rows = links.map((l) => `| ${l.name.replace(/^The Neighbor Card \(Jan 2027\) · /, '')} | $${l.amount.toLocaleString('en-US')} | ${l.url} |`);
  return ['', '## Payment links (live, created by Brain in Stripe)', '', '| Space | Price | Link to send |', '|---|---|---|', ...rows, ''].join('\n');
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

export async function runMailer(ctx: StageContext): Promise<StageResult> {
  const stage = 'mailer';
  const kit = path.join(ctx.root, KIT);
  const textFiles = [
    ...fs.readdirSync(kit).filter((f) => f.endsWith('.md')),
    ...fs.readdirSync(path.join(kit, 'build', 'html')).filter((f) => f.endsWith('.html')).map((f) => path.join('build', 'html', f)),
  ];
  if (ctx.dryRun) {
    const probe: OwnerContact = { name: 'N', email: 'e', phone: 'p', address: 'a', town: 't', zip: 'z' };
    const left = textFiles.flatMap((f) => fill(fs.readFileSync(path.join(kit, f), 'utf8'), probe).missing.map((m) => `${f}: ${m}`));
    return {
      stage, status: left.length ? 'FAILED' : 'DONE',
      detail: left.length ? `placeholders no contact field fills: ${left.join('; ')}` : `dry run: ${textFiles.length} files, every placeholder maps to a Stripe field`,
      items: textFiles.map((f) => ({ key: f, state: 'WOULD_CREATE' as const })),
    };
  }
  const src = path.join(ctx.root, '.launch-out', 'stripe-links.json');
  if (!fs.existsSync(src)) {
    return { stage, status: 'NEEDS_OWNER', detail: 'Waits for the Stripe stage (payment links and business details).', items: [] };
  }
  const { links, contact } = JSON.parse(fs.readFileSync(src, 'utf8')) as { links: Array<{ name: string; amount: number; url: string }>; contact: OwnerContact };
  const out = path.join(ctx.root, '.launch-out', 'mailer');
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(kit, out);
  const missing = new Set<string>();
  for (const f of textFiles) {
    const p = path.join(out, f);
    const r = fill(fs.readFileSync(p, 'utf8'), contact);
    r.missing.forEach((m) => missing.add(m));
    let text = r.text;
    if (f === 'ORDER-FORM-EMAIL.md' || f === 'SALES-KIT.md') text += linksSection(links);
    fs.writeFileSync(p, text);
  }
  const items: StageResult['items'] = textFiles.map((f) => ({ key: f, state: 'UPDATED' as const }));
  let rendered = false;
  try {
    // render.cjs runs twice: the rate card embeds the previews the first pass makes.
    const env = { ...process.env, NODE_PATH: ctx.env.NODE_PATH ?? execFileSync('npm', ['root', '-g']).toString().trim() };
    execFileSync('node', ['build/render.cjs'], { cwd: out, env, stdio: 'pipe' });
    execFileSync('python3', ['-I', 'build/previews.py'], { cwd: out, stdio: 'pipe' });
    execFileSync('node', ['build/render.cjs'], { cwd: out, env, stdio: 'pipe' });
    rendered = true;
    items.push({ key: 'mockup/*.pdf,png', state: 'UPDATED', note: 'card and rate card re-rendered with the owner details' });
  } catch (e) {
    items.push({ key: 'mockup', state: 'FAILED', note: `render: ${(e as Error).message.split('\n')[0]}` });
  }
  if (missing.size) {
    return {
      stage, status: 'NEEDS_OWNER', items,
      detail: `Stripe has no value for ${[...missing].join(', ')}.`,
      ownerAction: 'In Stripe → Settings → Business → Public details, fill in the support phone, support email and support address (Stripe asks for these during activation).',
    };
  }
  return { stage, status: rendered ? 'DONE' : 'PARTIAL', detail: `Mailer materials filled with ${links.length} payment links and the owner's details.`, items };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  runMailer({ env: process.env, dryRun: mode !== 'run', fetch, log: console.log, root })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'FAILED' ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
