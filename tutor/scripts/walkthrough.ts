/**
 * A real-browser walkthrough against the running server and Forge bridge:
 * import the Hail, Caesar sample → save → reload → guide → start a match → play real turns
 * through the UI (lands, spells, payments, targets, combat) → ask the tutor → review.
 *
 * It decides what to click by reading the same viewer state the UI shows, then clicks the
 * control the UI rendered for that action (`data-action`). Screenshots go to the directory
 * named by WALKTHROUGH_OUT (default: data/walkthrough).
 *
 *   npm run walkthrough            # needs `npm start` (or dev:server) and `npm run bridge`
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.TUTOR_URL ?? 'http://127.0.0.1:8790';
const OUT = process.env.WALKTHROUGH_OUT ?? 'data/walkthrough';
const TURNS = Number(process.env.WALKTHROUGH_TURNS ?? 8);
const OPPONENTS = Number(process.env.WALKTHROUGH_OPPONENTS ?? 1);
/** 'defend' keeps creatures home (so blocks are asked for) and activates Equip abilities (which target). */
const STYLE = process.env.WALKTHROUGH_STYLE ?? 'attack';
mkdirSync(OUT, { recursive: true });

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const record = (check: string, ok: boolean, detail = '') => { results.push({ check, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`); };
const shot = async (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

async function json(path: string, init?: RequestInit) { const r = await fetch(BASE + path, init); return r.json() as Promise<any>; }

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => record('no page errors', false, e.message));

  // 1. import
  await page.goto(`${BASE}/#/`);
  await page.getByRole('button', { name: 'Try the Hail, Caesar sample' }).click();
  await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.includes('Caesar'));
  await page.getByRole('button', { name: 'Check deck' }).click();
  await page.getByText('Ready to practice').waitFor({ timeout: 60_000 });
  const summary = await page.locator('.summary').innerText();
  record('Hail, Caesar imports as a playable 100-card deck', /100/.test(summary), summary.replace(/\s+/g, ' '));
  const cmdText = await page.locator('.commander-choice p').first().innerText();
  record('commander is Caesar, Legion\'s Emperor', /Caesar, Legion's Emperor/.test(cmdText) && !/Mr\. House/.test(cmdText), cmdText.replace(/\s+/g, ' ').slice(0, 120));
  await shot(page, '01-import');
  await page.getByRole('button', { name: 'Save deck' }).click();
  await page.waitForURL(/#\/decks\/[^/]+$/);
  const deckId = page.url().split('/').pop()!;

  // 2. guide survives a reload
  await page.reload();
  await page.getByRole('heading', { name: 'Game plan' }).waitFor({ timeout: 60_000 });
  const deck = await json(`/api/decks/${deckId}`);
  const house = deck.deck.lines.find((l: any) => /Mr\. House/.test(l.card?.name ?? ''));
  record('saved deck survives a reload with quantities intact', deck.report.counts.total === 100 && !!house && !deck.deck.commanderIds.includes(house.card.id), `total ${deck.report.counts.total}; Mr. House in the 99: ${!!house}`);
  await shot(page, '02-guide');
  await page.locator('.cmd-img').click();
  await page.locator('.modal .card-detail').waitFor();
  record('tapping the commander opens its card explanation', await page.locator('.modal').innerText().then((t) => /Caesar/.test(t)));
  await shot(page, '03-card');
  await page.getByRole('button', { name: 'Close' }).click();

  // 3. match
  if (OPPONENTS === 3) await page.locator('.practice select').first().selectOption('3');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await page.waitForURL(/#\/play\//, { timeout: 120_000 });
  const matchId = page.url().split('/').pop()!;
  await page.locator('.decision h3').waitFor({ timeout: 120_000 });
  await shot(page, '04-mulligan');

  const seen = new Set<string>();
  let tutorAsked = false, whyAsked = false, lastRev = -1, stuck = 0, myTurns = 0, retries = 0;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const s = await json(`/api/matches/${matchId}/state?after=0&wait=0`);
    if (s.status === 'over') { record('game reached game over', true, JSON.stringify(s.outcome)); break; }
    if (s.turn > TURNS) { record(`game progressed past turn ${TURNS}`, true, `now turn ${s.turn}; my last main phase was turn ${myTurns}`); break; }
    const d = s.decision;
    if (!d || s.revision === lastRev) {
      if (d && stuck === 60 && ++retries <= 5) lastRev = -1; // nothing happened after a click: look again rather than wait for ever
      if (++stuck > 400) { await shot(page, 'stalled'); record('game never stalls', false, `no new decision at revision ${s.revision}: ${d?.type ?? 'busy'}`); break; }
      await new Promise((r) => setTimeout(r, 150)); continue;
    }
    stuck = 0; lastRev = s.revision;
    seen.add(d.type);
    const me = s.players.find((p: any) => p.isHuman);
    if (d.type === 'PassPriority' && s.activePlayerId === me.id && s.phase === 'MAIN1') myTurns = s.turn;

    // Tutor: once at our first main phase with something castable, and "why can't I" for an unaffordable card.
    if (!tutorAsked && d.type === 'PassPriority' && s.phase === 'MAIN1' && s.activePlayerId === me.id) {
      tutorAsked = true;
      await page.getByRole('button', { name: 'What would you recommend, and why?' }).click();
      await page.locator('.answer .rec').waitFor({ timeout: 60_000 });
      const rec = await page.locator('.answer').innerText();
      await shot(page, '05-tutor-recommend');
      const api = await json(`/api/matches/${matchId}/tutor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'recommend', revision: s.revision, sinceSeq: 0 }) });
      const legal = (d.actions ?? []).map((a: any) => a.id);
      record('recommendation names a currently legal action (or none) and its revision', !api.recommendation?.actionId || (legal.includes(api.recommendation.actionId) && api.recommendation.revision === s.revision), api.recommendation?.label ?? 'no action');
      const hidden = s.players.filter((p: any) => !p.isHuman).flatMap((p: any) => p.hand ?? []).length;
      record('no opponent hand is ever sent to the browser or tutor', hidden === 0 && !/library order/i.test(JSON.stringify(api)), rec.slice(0, 120).replace(/\s+/g, ' '));
    }
    const blocked = (d.actions ?? []).find((a: any) => a.category === 'spell' && a.affordable === false);
    if (!whyAsked && blocked && d.type === 'PassPriority') {
      whyAsked = true;
      await page.locator('.why select').selectOption(String(blocked.cardId));
      await page.getByRole('button', { name: "Why can't I play this?" }).click();
      await page.locator('.answer .expl strong', { hasText: /can.t|cannot/i }).waitFor({ timeout: 60_000 });
      const why = await page.locator('.answer .expl').innerText();
      record('tutor explains an unavailable card with an engine reason', /mana|timing|target|main phase|stack|zone/i.test(why), why.split('\n')[0]);
      await shot(page, '06-tutor-why');
    }

    // Click only once the page shows this same position, as a person would.
    await page.waitForFunction((rev) => Number(document.querySelector('.decision')?.getAttribute('data-revision') ?? -1) >= rev, s.revision, { timeout: 30_000 }).catch(() => undefined);
    const actionId = choose(s, d);
    if (actionId === null) { await shot(page, `stuck-${d.type}`); record('every decision has a usable control', false, `${d.type}: ${d.prompt}`); break; }
    await act(page, d, actionId);
    if (d.type === 'Attack' && !seen.has('shot-attack')) { seen.add('shot-attack'); await shot(page, '07-attack'); }
  }
  await shot(page, '08-board');
  record('no click was lost or refused as stale', retries === 0, `${retries} retry(ies)`);
  const fin = await json(`/api/matches/${matchId}/state?after=0&wait=0`);
  const mine = fin.players.find((p: any) => p.isHuman);
  record('commander cast from the command zone (with tax shown)', (mine.commanders?.[0]?.timesCast ?? 0) > 0, JSON.stringify(mine.commanders?.[0] ?? {}));
  record('a targeted choice was made through the UI', seen.has('SelectTargets') || [...seen].some((t) => /Target/i.test(t)), [...seen].join(', '));
  record('blockers were declared through the UI', seen.has('Block'), seen.has('Block') ? 'Block decision answered' : 'the AI never attacked into a declare-blockers stop');
  record('decision kinds encountered', true, [...seen].filter((x) => !x.startsWith('shot')).join(', '));
  const log = await json(`/api/matches/${matchId}/state?after=0&wait=0`);
  const cast = log.log.filter((l: any) => /cast|plays?|play /i.test(l.message)).length;
  record('the action log shows plays by both sides', cast > 0 && new Set(log.log.map((l: any) => l.message.split(' ')[0])).size > 1, `${log.log.length} log entries`);

  // 4. review
  if (log.status !== 'over') await json(`/api/matches/${matchId}/concede`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await page.goto(`${BASE}/#/review/${matchId}`);
  await page.getByRole('heading', { name: 'Your next lesson' }).waitFor({ timeout: 30_000 });
  await shot(page, '09-review');
  record('review produces one deck-tied lesson', (await page.locator('.lesson').innerText()).length > 20);

  // 5. phone width
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await pp.goto(`${BASE}/#/decks/${deckId}`);
  await pp.getByRole('heading', { name: 'Game plan' }).waitFor({ timeout: 30_000 });
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  record('guide fits a phone screen without horizontal scroll', overflow <= 1, `overflow ${overflow}px`);
  await pp.screenshot({ path: join(OUT, '10-phone-guide.png'), fullPage: false });

  await browser.close();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ matchId, deckId, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}.`);
  process.exit(failed.length ? 1 : 0);
}

/**
 * A simple, legal policy using only what the decision offers: keep the opening hand, play a
 * land, then the first affordable spell, pay with the Auto button, pick the first target,
 * attack with everything, accept default blocks, and confirm dialogs with their first option.
 */
const triedThisTurn = new Set<string>();
function choose(s: any, d: any): string | null {
  const ids: string[] = (d.actions ?? []).map((a: any) => a.id);
  const pick = (p: (a: any) => boolean) => (d.actions ?? []).find(p)?.id ?? null;
  if (d.kind === 'dialog') {
    for (const id of ['order', 'assign', 'choose', 'opt:0', 'submit', 'none', 'cancel']) if (ids.includes(id)) return id;
    return ids[0] ?? null;
  }
  if (d.type === 'ConfirmMulligan') return pick((a: any) => /keep/i.test(a.label)) ?? 'ok';
  if (d.type === 'PassPriority') {
    const key = `${s.turn}:${s.phase}`;
    const fresh = (a: any) => !triedThisTurn.has(`${key}:${a.id}`);
    const land = pick((a: any) => a.category === 'land' && fresh(a));
    const me = s.players.find((p: any) => p.isHuman);
    const commanderIds = new Set((me?.commanders ?? []).map((c: any) => c.cardId));
    const castable = (a: any) => a.category === 'spell' && a.affordable !== false && a.hasTargets !== false && fresh(a);
    const spell = s.stack?.length ? null : pick((a: any) => castable(a) && commanderIds.has(a.cardId)) ?? pick(castable);
    const equip = STYLE === 'defend' && !s.stack?.length ? pick((a: any) => a.category === 'ability' && /^Activate .*Equip/.test(a.label) && a.affordable !== false && a.hasTargets !== false && fresh(a)) : null;
    const chosen = land ?? spell ?? equip;
    if (chosen) { triedThisTurn.add(`${key}:${chosen}`); return chosen; }
    return ids.includes('ok') ? 'ok' : ids[0] ?? null;
  }
  // Declare everything once, then confirm the declared attack.
  if (d.type === 'Attack') {
    const key = `${s.turn}:alpha`;
    if (STYLE !== 'defend' && !triedThisTurn.has(key) && ids.includes('alpha')) { triedThisTurn.add(key); return 'alpha'; }
    return 'ok';
  }
  if (/PayMana/.test(d.type)) return pick((a: any) => /auto/i.test(a.label)) ?? pick((a: any) => a.category === 'manaSource') ?? (ids.includes('ok') ? 'ok' : ids[0] ?? null);
  const target = pick((a: any) => a.id.startsWith('card:') || a.id.startsWith('player:'));
  if (target && !triedThisTurn.has(`${s.revision}:${target}`)) { triedThisTurn.add(`${s.revision}:${target}`); return target; }
  return ids.includes('ok') ? 'ok' : ids.includes('cancel') ? 'cancel' : ids[0] ?? null;
}

async function act(page: Page, d: any, id: string) {
  const loc = page.locator(`[data-action="${id}"]`).first();
  if (await loc.count() === 0) {
    // Some choices (a player target, a mana source on the board) are rendered as board cards or menu buttons.
    const a = (d.actions ?? []).find((x: any) => x.id === id);
    await page.getByRole('button', { name: a?.label ?? id, exact: false }).first().click({ timeout: 10_000 });
    return;
  }
  if (id === 'choose') {
    const need = Math.max(1, d.min ?? 1);
    const boxes = page.locator('.dialog input[type=checkbox]');
    for (let i = 0; i < need; i++) await boxes.nth(i).check();
  }
  if (id === 'assign') {
    const inputs = page.locator('.dialog .assign input');
    await inputs.first().fill(String(d.total));
  }
  await loc.click({ timeout: 10_000 });
  await page.waitForTimeout(120);
}

main().catch((e) => { console.error(e); process.exit(1); });
