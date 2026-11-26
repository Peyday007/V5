#!/usr/bin/env node
/**
 * Proves that a diagnostic detects the failure it claims to (planning failure
 * map, Phase 3). Each entry re-introduces one recorded failure as a single
 * textual mutation of the repaired code — the historical defect itself where it
 * can be restored, otherwise a faithful reproduction — runs the named
 * diagnostic, and requires (a) it FAILS, (b) the failing test is the one named
 * for that failure (matched on its full title, not a shared label), and (c) the
 * unmutated code passes (known-good).
 *
 * Mutations run in a throwaway git worktree of HEAD plus the working tree's
 * uncommitted changes, never in the tree other sessions, hooks or reviewers
 * read; a killed run leaves the real tree untouched. Results are merged by id
 * into docs/planning-failure-map/sensitivity.json.
 *
 *   node scripts/diagnosticSensitivity.mjs [--only id[,id]]
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RP = 'server/services/goals/routeProposal.ts';
const IN = 'server/services/industry/construction/intent.ts';
const OM = 'server/domain/operatingModel.ts';
const W1 = 'tests/planningFailureMapWave1.test.ts';
const W2 = 'tests/planningFailureMapWave2.test.ts';
const OP = 'tests/objectiveFreshPhrasings.test.ts';
const OB = 'tests/objectiveFreshBatchBlind.test.ts';
const CS = 'tests/chatStreaming.test.ts';
/** id: the map question it proves; title: a substring of exactly the test that must fail. */
const MUTATIONS = [
  { id: 'C21-P', rc: 'RC4', file: RP, find: 'export const FINDINGS_SHOWN = 160;', replace: 'export const FINDINGS_SHOWN = 40;', test: W1, title: 'shows every one of 135 distinct verified findings', why: 'historical: the 40-finding cap' },
  { id: 'C21-X', rc: 'RC4', file: RP, find: "    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();", replace: "    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);", test: W1, title: 'share their first 160 characters', why: 'historical: near-duplicates judged on the first 160 characters' },
  { id: 'C12-R', rc: 'RC4', file: RP, find: '  let chosen = eligible;\n  if (eligible.length > max) {', replace: '  let chosen = eligible.slice(0, max);\n  if (false) {', test: W1, title: 'takes every lane in turn', why: 'historical: newest-first slice crowding out other lanes' },
  { id: 'C19-I', rc: 'RC4', file: RP, find: "    if ((claim as { contradictionState?: string }).contradictionState === 'REFUTED') continue;", replace: '', test: W1, title: 'drop a refuted one', why: 'reproduction: a refuted claim shown as a finding (the SQL predicate is proven separately in code; no DB test yet)' },
  { id: 'C25-P', rc: 'RC8', file: RP, find: '    if (acquisitionCostPerSale !== null && acquisitionCostPerSale >= price - directCost) {', replace: '    if (false) {', test: W1, title: 'refuses a route whose buyers cost more to win', why: 'historical: the 445-beanies-from-$3,000 route accepted' },
  { id: 'C25-X', rc: 'RC8', file: RP, find: '    if (acquisitionCostPerSale !== null && ctx.capitalLimit !== null && capital + acquisitionCostPerSale > ctx.capitalLimit) {', replace: '    if (false) {', test: W1, title: 'capital and first buyer together exceed the limit', why: 'reproduction: buyer acquisition beyond the capital accepted' },
  { id: 'C25-R', rc: 'RC8', file: RP, find: '   ${economicsLine(route, ctx)}`;', replace: '`;', test: W1, title: 'computes sales, buyer cost, hours and first-cash date', why: 'historical: the critic never shown computed economics' },
  { id: 'C30-F', rc: 'RC9', file: RP, find: "    const ownerFit = str(r['ownerFit'], 300) ?? 'not stated by the proposer — judge it from the route against the owner\\'s words';", replace: "    const ownerFit = str(r['ownerFit'], 300);\n    if (!ownerFit) { reject('no owner fit', 'OWNER_FIT'); continue; }", test: W1, title: 'keeps a route without an owner-fit sentence', why: 'historical: a missing owner-fit sentence loses the route' },
  { id: 'C31-F', rc: 'RC2', file: RP, find: '    if (numericOnly && !review.repair) {', replace: '    if (false) {', test: W1, title: 'keeps a route dropped only on WINDOW', why: 'historical: a WINDOW-only drop removes the route (net 30 read as outside 60 days)' },
  { id: 'C31-X', rc: 'RC2', file: RP, find: "  survivors.sort((a, b) => Number(!!a.against) - Number(!!b.against) || placeOf(a.index)", replace: "  survivors.sort((a, b) => placeOf(a.index)", test: W1, title: 'keeps a route dropped only on WINDOW', why: 'reproduction: a route kept against the critic outranks routes the critic kept' },
  { id: 'C26-F', rc: 'RC2', file: RP, find: "    const verdict = numericOnly && review.repair ? 'REPAIR' : review.verdict;", replace: '    const verdict = review.verdict;', test: W1, title: 're-checks a disputed figure as a repair', why: 'historical: a disputed timing dropped instead of re-checked' },
  { id: 'C23-F', rc: 'RC1', file: RP, find: '  const second = await once(maxTokens * 2);\n  if (second.error || second.content.trim()) return second;', replace: '  const second = first;\n  if (second.error || second.content.trim()) return second;', test: W1, title: 'asks once more with twice the budget', why: 'historical: an empty reply counted as an answer path with no retry' },
  { id: 'C23-P', rc: 'RC1', file: 'server/services/cheap/modelBench.ts', find: ': { stream: true }),', replace: ': {}),', test: CS, title: 'asks for a stream and joins the answer', why: 'historical: non-streamed turns cut by the 100 s proxy idle (524)' },
  { id: 'C23-I', rc: 'RC1', file: 'server/services/cheap/modelBench.ts', find: "  if (!finished && !error) error = 'the stream ended before the answer did (no finish reason, no [DONE])';", replace: '', test: CS, title: 'keeps the partial text but names the cut', why: 'reproduction: a cut stream returned as a complete answer' },
  { id: 'C23-R', rc: 'RC16', file: RP, find: "export const ROUTE_TOKENS = { route: 14_000, direction: 12_000, critique: 10_000 } as const;", replace: "export const ROUTE_TOKENS = { route: 4000, direction: 3500, critique: 3000 } as const;", test: W2, title: 'gives a reasoning model room to reason', why: 'historical: 2,500–4,000 token budgets exhausted by hidden reasoning' },
  { id: 'C41-F', rc: 'RC17', file: RP, find: "export const ROUTE_UNFIT_MODEL_LABELS: readonly string[] = ['free:auto/best-coding'];", replace: 'export const ROUTE_UNFIT_MODEL_LABELS: readonly string[] = [];', test: W2, title: 'names the production fallback combo', why: 'historical: the 1/30 fallback proposed and critiqued its own routes' },
  { id: 'C11-X', rc: 'RC5', file: RP, find: '  return ctx.ownerLabour?.offered\n    ? "The owner offers', replace: '  return false\n    ? "The owner offers', test: W1, title: "direct paid work before brokering", why: "reproduction: the owner's direct paid work never considered first" },
  { id: 'C03-I', rc: 'RC3', file: 'server/services/cash/discovery.ts', find: '  if (!labour.offered) return REMOTE_AI_FOCUS;', replace: '  return REMOTE_AI_FOCUS;', test: W1, title: "discovery keeps the online focus unless", why: 'historical: discovery online-only for an owner who offered work' },
  { id: 'C03-P', rc: 'RC3', file: OM, find: "  if (perWeek !== null && perWeek > 0) return { offered: true, evidence: `the owner gives this goal ${perWeek} hour(s) a week` };", replace: '', test: W2, title: 'like $800 a month starting in January', why: 'historical: 14 of 30 owners stating hours sent the no-physical-work rule' },
  { id: 'C01-P', rc: 'RC15', file: IN, find: '(?:hours?|hrs?)\\b(?:\\s+(?:this|that)\\s+week)?(?!', replace: '(?:hours?|hrs?)(?:\\s+(?:this|that)\\s+week)?(?!', test: OP, title: '"N hours a week at most"', why: 'historical: "3 hours a week at most" read as 3 hours in total' },
  { id: 'C01-R', rc: 'RC15', file: IN, find: '  if (deadline === null && statesMonthlyRate(text)) {', replace: '  if (false) {', test: OP, title: 'start month is due at the end of that month', why: 'historical: a monthly figure with a start month refused' },
  { id: 'C01-I', rc: 'RC15', file: IN, find: "    const brk = /\\b(?:over|during|for|this|on)\\s+(?:the\\s+|my\\s+|our\\s+)?(winter|christmas|holiday|spring|summer)\\s+(?:break|vacation|holidays?)\\b/i.exec(text);", replace: '    const brk = null as RegExpExecArray | null;', test: OP, title: 'a named break is the window', why: 'historical: "over winter break, about two weeks" read as a window ending 10 December' },
  { id: 'C01-F', rc: 'RC15', file: IN, find: '      if (floor) {', replace: '      if (false) {', test: OP, title: 'an unnegated "more than" is a floor', why: 'historical (own regression): "I have more than $600 to spend" read as a $600 ceiling' },
  { id: 'C01-X', rc: 'RC15', file: IN, find: '  for (const m of text.matchAll(/\\b(?:already|currently)\\s+work(?:ing)?\\s+', replace: '  for (const m of ([] as RegExpMatchArray[]) && text.matchAll(/\\b(?:alreadyXX|currentlyXX)\\s+work(?:ing)?\\s+', test: OB, title: 'f07', why: 'historical: "I already work 40 hours a week … maybe 15 more" read as 40 h a week' },
];

const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const root = process.cwd();
const tree = mkdtempSync(join(tmpdir(), 'sensitivity-'));
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 900_000 });
sh('git', ['worktree', 'add', '--detach', tree, 'HEAD'], root);
// The working tree's uncommitted changes, applied to the worktree.
const diff = sh('git', ['diff', 'HEAD', '--binary'], root).stdout;
if (diff.trim()) {
  writeFileSync(join(tree, '.wt.patch'), diff);
  sh('git', ['apply', '.wt.patch'], tree);
}
for (const f of sh('git', ['ls-files', '--others', '--exclude-standard'], root).stdout.split('\n').filter(Boolean)) cpSync(join(root, f), join(tree, f), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'));
const run = (test) => sh('npx', ['vitest', 'run', ...test.split(' '), '--reporter=verbose'], tree);
const results = [];
try {
  for (const m of MUTATIONS.filter((one) => !only || only.has(one.id))) {
    const path = join(tree, m.file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(m.find)) {
      results.push({ id: m.id, rc: m.rc, why: m.why, test: m.test, outcome: 'MUTATION_NOT_APPLICABLE', verified: false });
      console.log(`${m.id.padEnd(7)} ${m.rc.padEnd(5)} MUTATION NOT APPLICABLE (the code moved)  ${m.why}`);
      continue;
    }
    writeFileSync(path, original.replace(m.find, m.replace));
    const bad = run(m.test);
    writeFileSync(path, original);
    const good = run(m.test);
    const out = bad.stdout + bad.stderr;
    const failed = out.split('\n').filter((line) => /^\s*×/.test(line)).map((line) => line.trim());
    const caught = bad.status !== 0;
    const named = failed.some((line) => line.includes(m.title));
    const verified = caught && named && good.status === 0;
    results.push({ id: m.id, rc: m.rc, why: m.why, test: m.test, title: m.title, knownBadDetected: caught, causeNamed: named, knownGoodAccepted: good.status === 0, verified, failing: failed.slice(0, 4) });
    console.log(`${m.id.padEnd(7)} ${m.rc.padEnd(5)} bad:${caught ? 'DETECTED' : 'missed'} cause:${named ? 'named' : 'NOT named'} good:${good.status === 0 ? 'accepted' : 'REJECTED'}  ${m.why}`);
  }
} finally {
  sh('git', ['worktree', 'remove', '--force', tree], root);
  if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
}
const file = 'docs/planning-failure-map/sensitivity.json';
const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).results ?? [] : [];
const byId = new Map(prior.map((one) => [one.id, one]));
for (const one of results) byId.set(one.id, { ...one, at: new Date().toISOString() });
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 1));
