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
const STREAM = process.argv.includes('--stream');
const ONLY = (arg('only') ?? '').split(',').filter(Boolean);
const ACCEPT = arg('accept-model'); // a reply served by a different model is recorded as kind 'substituted'
const TRIES = Number(arg('tries', '2'));
const all = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url)));
const system = all.system;
const questions = ONLY.length ? all.questions.filter((q) => ONLY.includes(q.id)) : all.questions;

// Streaming keeps bytes flowing, so a proxy's idle timeout (Cloudflare 524 at 100 s) cannot cut a long answer.
async function readStream(r) {
  let content = '', reasoning = '', finish = null, served = null, usage = null, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      served = j.model ?? served; if (j.usage) usage = j.usage;
      const c = j.choices?.[0]; if (!c) continue;
      content += c.delta?.content ?? ''; reasoning += c.delta?.reasoning_content ?? c.delta?.reasoning ?? '';
      if (c.finish_reason) finish = c.finish_reason;
    }
  }
  return { content, reasoning: reasoning || null, finish_reason: finish, served_model: served, usage };
}

async function call(messages) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0.2, ...(STREAM ? { stream: true, stream_options: { include_usage: true } } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) { const text = await r.text(); return { ok: false, kind: 'http', status: r.status, error: text.slice(0, 500), ms: Date.now() - t0 }; }
    let out;
    if (STREAM) out = await readStream(r);
    else {
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { return { ok: false, kind: 'bad_json', error: text.slice(0, 500), ms: Date.now() - t0 }; }
      const ch = j.choices?.[0] ?? {};
      out = { content: ch.message?.content ?? '', reasoning: ch.message?.reasoning_content ?? ch.message?.reasoning ?? null,
        finish_reason: ch.finish_reason ?? null, usage: j.usage ?? null, served_model: j.model ?? null };
    }
    const ms = Date.now() - t0;
    const has = out.content.trim().length > 0;
    const sub = ACCEPT && out.served_model && !out.served_model.includes(ACCEPT);
    return { ok: has && !sub, kind: sub ? 'substituted' : has ? 'answer' : 'empty', status: r.status, ...out, ms };
  } catch (e) {
    return { ok: false, kind: String(e).includes('Timeout') || String(e).includes('abort') ? 'timeout' : 'network', error: String(e).slice(0, 300), ms: Date.now() - t0 };
  }
}

// One retry, recorded; the first attempt's outcome is kept for the reliability tally.
async function ask(messages) {
  const attempts = [await call(messages)];
  while (!attempts.at(-1).ok && attempts.length < TRIES) attempts.push(await call(messages));
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
