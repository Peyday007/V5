/**
 * The launch runner: finishes the three businesses' setup by itself, as far as
 * the owner's credentials allow, every time it runs.
 *
 *   npx tsx scripts/launch/run.ts dry-run   validate every local input, no network writes
 *   npx tsx scripts/launch/run.ts run       do everything the present credentials allow
 *
 * Stages: stripe → mailer (needs Stripe's links), etsy, store → pinterest
 * (pins every product the etsy and store stages report live). Each is
 * idempotent against the platform itself (it lists what exists before it
 * creates anything), so `launch.yml` runs this hourly and a stage with nothing
 * left to do costs a few reads. A stage without its credential returns
 * NEEDS_OWNER with the exact personal action; nothing else ever reaches the
 * owner. The summary goes to `.launch-out/summary.md` and the job summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';

type Stage = { name: string; file: string; fn: string };
const STAGES: Stage[] = [
  { name: 'Stripe payment links (mailer)', file: './stripe.ts', fn: 'runStripe' },
  { name: 'Mailer materials', file: './mailer.ts', fn: 'runMailer' },
  { name: 'Mailer replies (Neighbor Card)', file: './mailerReplies.ts', fn: 'runMailerReplies' },
  { name: 'Expansion offers (payment links)', file: './offers.ts', fn: 'runOffers' },
  { name: 'Etsy listings', file: './etsy.ts', fn: 'runEtsy' },
  { name: 'Print-on-demand store', file: './store.ts', fn: 'runStore' },
  { name: 'Pinterest pins (customer acquisition)', file: './pinterest.ts', fn: 'runPinterest' },
];

export function summarize(results: Array<StageResult & { name: string }>): string {
  const icon = { DONE: '✅', PARTIAL: '🟡', WAITING: '⏳', NEEDS_OWNER: '👤', FAILED: '❌' } as const;
  const lines = ['# Launch status', '', '| Stage | Status | Detail |', '|---|---|---|'];
  for (const r of results) lines.push(`| ${r.name} | ${icon[r.status]} ${r.status} | ${r.detail.replace(/\|/g, '/')} |`);
  const owner = results.filter((r) => r.ownerAction);
  if (owner.length) {
    lines.push('', '## Personal actions still required', '');
    owner.forEach((r) => lines.push(`- **${r.name}:** ${r.ownerAction}`));
  }
  for (const r of results) {
    const shown = r.items.filter((i) => i.url || i.state === 'FAILED');
    if (!shown.length) continue;
    lines.push('', `## ${r.name}`, '');
    shown.forEach((i) => lines.push(`- ${i.state} · ${i.key}${i.url ? ` · ${i.url}` : ''}${i.note ? ` · ${i.note}` : ''}`));
  }
  return lines.join('\n') + '\n';
}

export async function runAll(ctx: StageContext, only?: string): Promise<Array<StageResult & { name: string }>> {
  const results: Array<StageResult & { name: string }> = [];
  for (const s of STAGES) {
    if (only && !s.file.includes(only)) continue;
    // A stage whose credential lives on the production machine runs there instead (launch.yml).
    if ((ctx.env['LAUNCH_SKIP'] ?? '').split(',').some((k) => k && s.file.includes(k))) continue;
    let r: StageResult;
    try {
      const mod = (await import(s.file)) as Record<string, (c: StageContext) => Promise<StageResult>>;
      const fn = mod[s.fn];
      if (!fn) throw new Error(`${s.file} has no ${s.fn}`);
      r = await fn({ ...ctx, results: [...(ctx.results ?? []), ...results] });
    } catch (e) {
      r = { stage: s.fn, status: 'FAILED', detail: (e as Error).message.split('\n')[0] ?? 'failed', items: [] };
    }
    ctx.log(`${s.name}: ${r.status} — ${r.detail}`);
    results.push({ ...r, name: s.name });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2] ?? 'dry-run';
  const only = process.argv[3];
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  runAll({ env: process.env, dryRun: mode !== 'run', fetch, log: console.log, root }, only)
    .then((results) => {
      const md = summarize(results);
      fs.mkdirSync(path.join(root, '.launch-out'), { recursive: true });
      fs.writeFileSync(path.join(root, '.launch-out', 'summary.md'), md);
      fs.writeFileSync(path.join(root, '.launch-out', 'results.json'), JSON.stringify(results, null, 2));
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
      console.log(md);
      process.exit(results.some((r) => r.status === 'FAILED') ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
