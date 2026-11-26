// Isolated model examination runner. Plain OpenAI-compatible calls; imports nothing from Brain.
//   node exam/run.mjs --discover --url U --key-env NAME
//   node exam/run.mjs --label L --url U --key-env NAME --model M --out F [--concurrency 4]
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const url = (arg('url') ?? '').replace(/\/+$/, '');
const key = process.env[arg('key-env') ?? ''] ?? '';
const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };

if (process.argv.includes('--discover')) {
  try {
    const r = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(30_000) });
    const t = await r.text();
    let ids = [];
    try { ids = JSON.parse(t).data.map((m) => m.id); } catch { /* not json */ }
    console.log(`DISCOVER ${url.replace(/\/\/.*?-8000/, '//<pod>-8000')} HTTP ${r.status} ${ids.length ? ids.join(' | ') : t.slice(0, 300)}`);
  } catch (e) { console.log(`DISCOVER error ${String(e).slice(0, 200)}`); }
  process.exit(0);
}

const label = arg('label'), model = arg('model'), out = arg('out');
const conc = Number(arg('concurrency', '4'));
const MAX_TOKENS = Number(arg('max-tokens', '16000'));
const TIMEOUT = Number(arg('timeout-ms', '600000'));
const { system, questions } = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url)));

async function call(messages) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0.2 }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, kind: 'http', status: r.status, error: text.slice(0, 500), ms };
    let j; try { j = JSON.parse(text); } catch { return { ok: false, kind: 'bad_json', error: text.slice(0, 500), ms }; }
    const ch = j.choices?.[0] ?? {};
    const content = ch.message?.content ?? '';
    const reasoning = ch.message?.reasoning_content ?? ch.message?.reasoning ?? null;
    return { ok: content.trim().length > 0, kind: content.trim() ? 'answer' : 'empty', status: r.status, content, reasoning,
      finish_reason: ch.finish_reason ?? null, usage: j.usage ?? null, served_model: j.model ?? null, ms };
  } catch (e) {
    return { ok: false, kind: String(e).includes('Timeout') || String(e).includes('abort') ? 'timeout' : 'network', error: String(e).slice(0, 300), ms: Date.now() - t0 };
  }
}

// One retry, recorded; the first attempt's outcome is kept for the reliability tally.
async function ask(messages) {
  const attempts = [await call(messages)];
  if (!attempts[0].ok) attempts.push(await call(messages));
  return attempts;
}

async function one(q) {
  const base = [{ role: 'system', content: system }, { role: 'user', content: q.prompt }];
  const first = await ask(base);
  const rec = { id: q.id, attempts: first };
  const answer = first.find((a) => a.ok)?.content;
  if (q.followup) {
    rec.followup = answer
      ? await ask([...base, { role: 'assistant', content: answer }, { role: 'user', content: q.followup }])
      : [{ ok: false, kind: 'skipped_no_first_turn' }];
  }
  console.log(`${label} ${q.id} ${first.map((a) => `${a.kind}/${a.finish_reason ?? '-'}/${Math.round(a.ms / 1000)}s`).join(' -> ')}${rec.followup ? ' FU ' + rec.followup.map((a) => a.kind).join('->') : ''}`);
  return rec;
}

const results = new Array(questions.length);
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < questions.length) { const i = next++; results[i] = await one(questions[i]); }
}));
writeFileSync(out, JSON.stringify({ label, model, url_host: url.replace(/^https?:\/\/([^/]+).*/, '$1').replace(/^[a-z0-9]+-8000/, '<pod>-8000'),
  max_tokens: MAX_TOKENS, temperature: 0.2, ranAt: new Date().toISOString(), results }, null, 1));
console.log(`DONE ${label} ${results.filter((r) => r.attempts[0].ok).length}/${results.length} first-attempt answers`);
