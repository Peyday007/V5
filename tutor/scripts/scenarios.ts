/**
 * Focused, real-engine scenarios driven through the browser. Each sets up a position with Forge's
 * own game-state format (what its puzzle mode and developer "Setup Game State" use), then plays
 * it through the UI. Forge decides everything after that: the AI's attack, legality, the stack,
 * replacement effects.
 *
 *   TUTOR_BRIDGE_SCENARIOS=1 npm run bridge        # bridge must allow scenarios
 *   TUTOR_BRIDGE_SCENARIOS=1 npm start             # and so must the server
 *   npx tsx scripts/scenarios.ts
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.TUTOR_URL ?? 'http://127.0.0.1:8790';
const OUT = process.env.WALKTHROUGH_OUT ?? 'data/scenarios';
mkdirSync(OUT, { recursive: true });
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail = '') => { results.push({ check, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`); };
const post = async (path: string, body: unknown) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<any>;

const lib = (card: string) => Array(10).fill(card).join(';');
const SCENARIOS: Record<string, string[]> = {
  block: [
    '[state]', 'humanlife=40', 'ailife=40', 'turn=3', 'activeplayer=ai', 'activephase=MAIN1',
    'humanbattlefield=Grizzly Bears;Plains', `humanlibrary=${lib('Plains')}`, 'humanhand=',
    'aibattlefield=Craw Wurm;Forest;Forest', `ailibrary=${lib('Forest')}`, 'aihand=',
  ],
  respond: [
    '[state]', 'humanlife=40', 'ailife=40', 'turn=3', 'activeplayer=human', 'activephase=MAIN1',
    'humanbattlefield=Mountain;Plains', 'humanhand=Lightning Bolt', `humanlibrary=${lib('Plains')}`,
    'aibattlefield=Grizzly Bears;Mountain', `ailibrary=${lib('Forest')}`, 'aihand=',
    'aiputonstack=Lightning Bolt->human',
  ],
  commander: [
    '[state]', 'humanlife=40', 'ailife=40', 'turn=3', 'activeplayer=human', 'activephase=MAIN1',
    'humanbattlefield=Mountain;Swamp;Plains;Plains;Plains', 'humanhand=Swords to Plowshares', `humanlibrary=${lib('Plains')}`,
    "humancommand=Caesar, Legion's Emperor|IsCommander",
    'aibattlefield=Forest', `ailibrary=${lib('Forest')}`, 'aihand=',
  ],
};

async function deckId(): Promise<string> {
  const decks = await get('/api/decks');
  const found = decks.find((d: any) => /Hail, Caesar/.test(d.name));
  if (found) return found.id;
  const text = await (await fetch(`${BASE}/api/fixtures/hail-caesar`)).text();
  return (await post('/api/decks', { name: 'Hail, Caesar', text, choices: {}, format: 'commander' })).stored.id;
}

/** Waits until Forge offers a decision that satisfies `want` (and the page shows it). */
let clickedAt = 0; // the revision of the last decision we clicked; anything at or before it is stale
async function until(page: Page, matchId: string, want: (s: any) => boolean, ms = 90_000): Promise<any> {
  const end = Date.now() + ms;
  let after = clickedAt;
  while (Date.now() < end) {
    const s = await get(`/api/matches/${matchId}/state?after=${after}&wait=5000`);
    after = s.revision;
    if (s.decision?.type === 'ConfirmMulligan') { await click(page, s, (a) => /keep/i.test(a.label) || a.id === 'ok'); continue; }
    if (s.decision && /coin toss|play or draw/i.test(s.decision.prompt) && !want(s)) { await click(page, s, (a) => /^play$/i.test(a.label) || a.id === 'opt:0'); continue; }
    if (s.decision && want(s)) {
      await page.waitForFunction((rev) => Number(document.querySelector('.decision')?.getAttribute('data-revision') ?? -1) >= rev, s.revision, { timeout: 20_000 });
      return s;
    }
    if (s.status === 'over') throw new Error('game ended');
  }
  throw new Error('timed out waiting for a decision');
}

async function click(page: Page, s: any, which: (a: any) => boolean) {
  const a = (s.decision.actions ?? []).find(which);
  if (!a) throw new Error(`no such action in ${s.decision.type}: ${JSON.stringify(s.decision.actions.map((x: any) => x.label))}`);
  await page.waitForFunction((rev) => Number(document.querySelector('.decision')?.getAttribute('data-revision') ?? -1) >= rev, s.revision, { timeout: 20_000 });
  await page.locator(`[data-action="${a.id}"]`).first().click();
  clickedAt = s.revision;
  return a;
}

const nameOf = (s: any, id: number) => s.players.flatMap((p: any) => [...(p.battlefield ?? []), ...(p.hand ?? []), ...(p.command ?? [])]).find((c: any) => c.id === id)?.name;
const has = (s: any, re: RegExp) => s.log.some((l: any) => re.test(l.message));

async function run(page: Page, name: string, deck: string, body: (page: Page, id: string) => Promise<void>) {
  if (process.env.SCENARIO && process.env.SCENARIO !== name) return;
  clickedAt = 0;
  const m = await post('/api/matches', { deckId: deck, opponents: 1, coachMode: 'hints', scenario: SCENARIOS[name] });
  if (!m.id) { record(`${name}: scenario starts`, false, JSON.stringify(m)); return; }
  await page.goto(`${BASE}/#/play/${m.id}`);
  try { await body(page, m.id); } catch (e) { record(`${name}: completes`, false, (e as Error).message); }
  if (process.env.SCENARIO_LOG) { const st = await get(`/api/matches/${m.id}/state?after=0&wait=0`); console.log(st.log.map((l: any) => `   log ${l.message}`).join('\n')); }
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  await post(`/api/matches/${m.id}/concede`, {});
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const deck = await deckId();

  // 1. The AI attacks; the player declares a blocker by clicking cards.
  await run(page, 'block', deck, async (pg, id) => {
    let s = await until(pg, id, (x) => x.decision.type === 'Block', 120_000);
    record('block: Forge asks the player to declare blockers when the AI attacks', true, s.decision.prompt.split('\n')[0]);
    await pg.screenshot({ path: join(OUT, 'block-ask.png'), fullPage: true });
    await click(pg, s, (a) => a.category === 'blocker' && nameOf(s, a.cardId) === 'Grizzly Bears');
    s = await until(pg, id, (x) => x.decision.type === 'Block' && x.revision > s.revision);
    const attacker = s.decision.actions.find((a: any) => a.category === 'attacker');
    if (attacker) { await click(pg, s, (a) => a.id === attacker.id); s = await until(pg, id, (x) => x.decision.type === 'Block' && x.revision > s.revision); }
    await click(pg, s, (a) => a.id === 'ok');
    s = await until(pg, id, (x) => has(x, /block/i) && !x.decision.type.startsWith('Block'));
    const line = s.log.find((l: any) => /Grizzly Bears.*block|block.*Craw Wurm/i.test(l.message))?.message ?? '';
    record('block: Grizzly Bears blocked Craw Wurm, as Forge logged it', /Grizzly Bears/.test(line) && /Craw Wurm/.test(line), line);
  });

  // 2. Something is on the stack: the player responds at instant speed, targets, pays mana.
  await run(page, 'respond', deck, async (pg, id) => {
    let s = await until(pg, id, (x) => x.decision.type === 'PassPriority' && x.stack.length > 0);
    record('respond: the player gets priority with an opposing spell on the stack (not auto-passed)', true, s.stack.map((x: any) => x.description ?? x.name).join(' | ').slice(0, 120));
    await pg.locator('.tutor-buttons button', { hasText: 'What can I do?' }).click();
    await pg.locator('.answer .expl').waitFor({ timeout: 30_000 });
    record('respond: "What can I do?" answers about this position', /Lightning Bolt|stack|respond/i.test(await pg.locator('.answer').innerText()));
    await click(pg, s, (a) => a.category === 'spell' && /Lightning Bolt/.test(a.label));
    s = await until(pg, id, (x) => x.decision.actions.some((a: any) => /Grizzly Bears/.test(a.label) || a.id.startsWith('card:')));
    await pg.screenshot({ path: join(OUT, 'respond-target.png'), fullPage: true });
    const bear = s.players.find((p: any) => !p.isHuman).battlefield.find((c: any) => c.name === 'Grizzly Bears');
    await click(pg, s, (a) => a.id === `card:${bear.id}` || (a.cardId === bear.id));
    s = await until(pg, id, (x) => /PayMana/.test(x.decision.type) || x.stack.length >= 2);
    if (/PayMana/.test(s.decision.type)) {
      const mountain = s.decision.actions.find((a: any) => a.category === 'manaSource' && /Mountain/.test(nameOf(s, a.cardId) ?? a.label));
      await click(pg, s, (a) => a.id === (mountain?.id ?? 'ok'));
      record('respond: mana paid by tapping a chosen land', !!mountain, mountain?.label ?? 'used Auto');
    }
    // With no mana left I cannot respond to my own spell, so the bridge auto-passes (and says so).
    s = await until(pg, id, (x) => x.stack.length < 2 || x.decision.type === 'PassPriority');
    if (s.stack.length >= 2) { await click(pg, s, (a) => a.id === 'ok'); s = await until(pg, id, (x) => x.stack.length < 2); }
    const order = s.log.map((l: any) => l.message).filter((m: string) => /Lightning Bolt/.test(m));
    record('respond: my Bolt went on the stack above theirs (cast in response)', order.some((m: string) => /You cast Lightning Bolt/.test(m)), order.slice(-3).join(' / ').slice(0, 200));
    const dead = s.players.find((p: any) => !p.isHuman).graveyard.some((c: any) => c.name === 'Grizzly Bears');
    record('respond: my Bolt resolved first and destroyed the Bears', dead, `opponent graveyard: ${s.players.find((p: any) => !p.isHuman).graveyard.map((c: any) => c.name).join(', ')}`);
  });

  // 3. A commander would be exiled: the owner chooses whether it goes to the command zone.
  await run(page, 'commander', deck, async (pg, id) => {
    let s = await until(pg, id, (x) => x.decision.type === 'PassPriority' && x.decision.actions.some((a: any) => /Cast Caesar/.test(a.label)));
    record('commander: Caesar can be cast from the command zone', true, s.decision.actions.find((a: any) => /Cast Caesar/.test(a.label)).label);
    await click(pg, s, (a) => /Cast Caesar/.test(a.label));
    s = await until(pg, id, (x) => /PayMana/.test(x.decision.type) || x.stack.length > 0);
    if (/PayMana/.test(s.decision.type)) await click(pg, s, (a) => /auto/i.test(a.label) || a.id === 'ok');
    s = await until(pg, id, (x) => x.players.find((p: any) => p.isHuman).battlefield.some((c: any) => /Caesar/.test(c.name)) && x.decision.type === 'PassPriority' && x.stack.length === 0
      || (x.decision.type === 'PassPriority' && x.stack.length > 0));
    if (s.stack.length > 0) { await click(pg, s, (a) => a.id === 'ok'); s = await until(pg, id, (x) => x.stack.length === 0 && x.decision.type === 'PassPriority'); }
    const cmd1 = s.players.find((p: any) => p.isHuman).commanders?.[0];
    record('commander: cast count and next tax tracked', cmd1?.timesCast === 1 && cmd1?.tax === 2, JSON.stringify(cmd1));
    s = await until(pg, id, (x) => x.decision.type === 'PassPriority' && x.decision.actions.some((a: any) => /Swords to Plowshares/.test(a.label)));
    await click(pg, s, (a) => /Swords to Plowshares/.test(a.label));
    s = await until(pg, id, (x) => x.decision.actions.some((a: any) => a.id.startsWith('card:')) || /PayMana/.test(x.decision.type));
    if (!/PayMana/.test(s.decision.type)) {
      const caesar = s.players.find((p: any) => p.isHuman).battlefield.find((c: any) => /Caesar/.test(c.name));
      await click(pg, s, (a) => a.id === `card:${caesar.id}`);
      s = await until(pg, id, (x) => /PayMana/.test(x.decision.type) || x.stack.length > 0);
    }
    if (/PayMana/.test(s.decision.type)) { await click(pg, s, (a) => /auto/i.test(a.label) || a.id === 'ok'); s = await until(pg, id, (x) => x.stack.length > 0 || x.decision.type === 'Confirm'); }
    // With nothing left to respond with, the bridge auto-passes and Swords resolves at once.
    if (s.decision.type === 'PassPriority') await click(pg, s, (a) => a.id === 'ok');
    s = await until(pg, id, (x) => x.decision.kind === 'dialog' || x.decision.type === 'Confirm' || (x.stack.length === 0 && x.decision.type === 'PassPriority'));
    if (s.decision.kind === 'dialog' || s.decision.type === 'Confirm') {
      record('commander: Forge asks where the commander goes', true, s.decision.prompt.replace(/\s+/g, ' ').slice(0, 140));
      await pg.screenshot({ path: join(OUT, 'commander-ask.png'), fullPage: true });
      await click(pg, s, (a) => a.id === 'ok' || /yes|command/i.test(a.label));
      s = await until(pg, id, (x) => x.stack.length === 0);
    } else record('commander: Forge asks where the commander goes', false, 'no dialog appeared');
    const me = s.players.find((p: any) => p.isHuman);
    record('commander: Caesar is back in the command zone, tax now applies', me.command.some((c: any) => /Caesar/.test(c.name)), JSON.stringify(me.commanders?.[0] ?? {}));
  });

  await browser.close();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenario checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
