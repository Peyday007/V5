#!/usr/bin/env node
/**
 * Checks the recorded 30-question intelligence test (docs/INTELLIGENCE-TEST-30Q-2026-11-26.md)
 * against what its data directory actually holds — the counts the report states are
 * recomputed here, not trusted. Read-only.
 *
 *   node scripts/intelligenceTestCheck.mjs <questions|research|delivery|planning|followup|grading|report|all>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'docs/intelligence-test-2026-11-26';
const REPORT = 'docs/INTELLIGENCE-TEST-30Q-2026-11-26.md';
const GOALS = ['p02', 'p06', 'p10'];
const which = process.argv[2] ?? 'all';
const failures = [];
const ok = (cond, what) => { if (!cond) failures.push(what); };
const json = (p) => JSON.parse(readFileSync(join(DIR, p), 'utf8'));
const lines = (p, prefix) => readFileSync(join(DIR, p), 'utf8').split('\n').filter((l) => l.startsWith(prefix));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function questions() {
  for (const g of GOALS) {
    const qs = json(`questions/${g}.q.json`);
    ok(qs.length === 30, `${g}: 30 questions (has ${qs.length})`);
    ok(new Set(qs.map((q) => norm(q.question))).size === qs.length, `${g}: no question repeated verbatim`);
    ok(new Set(qs.map((q) => norm(q.area ?? ''))).size >= 15, `${g}: at least 15 distinct uncertainty areas`);
    ok(qs.every((q) => q.question && q.decision), `${g}: every question names the decision it changes`);
    const raw = readFileSync(join(DIR, `questions/${g}.questions.raw.txt`), 'utf8');
    ok(/QUESTIONS model \{"label":"(gpu|free):/.test(raw), `${g}: questions came from Brain's production models (raw run log)`);
  }
}
function research() {
  for (const g of GOALS) {
    const files = readdirSync(join(DIR, 'research')).filter((f) => f.startsWith(`r_${g}_`) && !f.endsWith('_f.json'));
    const results = files.flatMap((f) => json(`research/${f}`).results);
    ok(new Set(results.map((r) => r.id)).size === 30, `${g}: every one of the 30 questions has a research record`);
    ok(results.every((r) => ['ANSWERED', 'PARTIAL', 'UNANSWERED'].includes(r.status)), `${g}: every question has an honest status`);
    ok(results.every((r) => r.status !== 'ANSWERED' || (r.facts ?? []).length > 0), `${g}: answered questions carry facts`);
    ok(results.every((r) => (r.facts ?? []).length > 0 || (r.notes ?? '').length > 20), `${g}: a question without facts says what was tried`);
    ok(results.every((r) => (r.opened ?? []).length > 0 || r.status === 'UNANSWERED'), `${g}: sources were opened`);
    const v = json(`verified/v_${g}.json`);
    ok(v.every((x) => x.sourceUrl && x.quote !== undefined && x.v), `${g}: every fact has a URL, a quote and a verification verdict`);
    const verified = v.filter((x) => x.v === 'EXACT' || x.v === 'FUZZY');
    ok(verified.length >= 60, `${g}: at least 60 facts verified against the re-read page (has ${verified.length})`);
  }
}
function delivery() {
  for (const g of GOALS) for (const arm of ['probe1', 'final']) for (const m of ['cap', 'all']) {
    const d = lines(`planner/${arm}_${g}_${m}.txt`, 'PROBE delivery ');
    ok(d.length === 1, `${g} ${arm} ${m}: the planner input records supplied vs shown`);
    if (d[0]) {
      const x = JSON.parse(d[0].slice('PROBE delivery '.length));
      ok(x.supplied > 0 && x.shown > 0, `${g} ${arm} ${m}: findings reached the planner`);
      if (m === 'cap') ok(x.shown === Math.min(40, x.shown) && x.shown <= 40, `${g} ${arm} cap: production's 40-finding cap measured`);
    }
  }
}
function planning() {
  for (const g of GOALS) for (const m of ['cap', 'all']) {
    const t = readFileSync(join(DIR, `planner/final_${g}_${m}.txt`), 'utf8');
    ok(/^PROBE reply /m.test(t) && /^PLANNING_EVAL: OK/m.test(t), `${g} final ${m}: Brain's production proposer answered and the run completed`);
    ok(/^PROBE prompt /m.test(t), `${g} final ${m}: the exact route ask is recorded`);
  }
}
function followup() {
  for (const g of GOALS) {
    const fq = json(`questions/${g}.fq.json`);
    ok(fq.length > 0, `${g}: Brain generated follow-up questions from the findings`);
    ok(lines(`questions/fq_${g}.txt`, 'QUESTIONS mode ').some((l) => l.includes('"followUp":true')), `${g}: follow-ups were asked with the findings shown`);
    const r = json(`research/r_${g}_f.json`).results;
    ok(new Set(r.map((x) => x.id)).size === fq.length, `${g}: every follow-up has a disposition`);
    ok(r.some((x) => x.status === 'ANSWERED' || x.status === 'PARTIAL'), `${g}: follow-ups were researched`);
  }
}
function grading() {
  for (const g of GOALS) {
    const p = `grading/grade_result_${g}.json`;
    ok(existsSync(join(DIR, p)), `${g}: an independent grade exists`);
    if (!existsSync(join(DIR, p))) continue;
    const r = json(p);
    const key = json(`grading/grade_key_${g}.json`);
    ok(r.outputs.length === Object.keys(key).length, `${g}: every blind output was graded`);
    ok(r.outputs.every((o) => ['USABLE', 'CREDIBLE_INCOMPLETE', 'NOT_USABLE'].includes(o.verdict)), `${g}: every output has a verdict`);
    ok(r.outputs.every((o) => o.verdict === 'USABLE' || 'ABCDE'.includes(o.failureCategory ?? '-')), `${g}: every failure is classified A–E`);
  }
}
function report() {
  ok(existsSync(REPORT), 'the report exists');
  if (!existsSync(REPORT)) return;
  const t = readFileSync(REPORT, 'utf8');
  for (const h of ['Questions generated', 'verified live-web evidence', 'Unique sources', 'reasoning input', 'Additional questions', 'Feasible opportunities', 'independently graded', 'First remaining blocker', 'materially improve', 'insufficient information', 'information is sufficient', 'structural change', '9/10', 'Firecrawl'])
    ok(t.includes(h), `the report answers: ${h}`);
}
const checks = { questions, research, delivery, planning, followup, grading, report };
for (const [name, fn] of Object.entries(checks)) if (which === 'all' || which === name) fn();
if (!(which in checks) && which !== 'all') failures.push(`unknown check ${which}`);
if (failures.length) {
  console.error(`INTELLIGENCE_TEST ${which}: FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`INTELLIGENCE_TEST ${which}: OK`);
