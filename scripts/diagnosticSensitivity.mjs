#!/usr/bin/env node
/**
 * Proves that a diagnostic detects the failure it claims to (planning failure
 * map, Phase 3 "controlled failure"): each entry re-introduces one recorded
 * failure as a single textual mutation of the repaired code, runs the named
 * diagnostic, and requires it to FAIL — and to pass again on the unmutated code
 * (known-good). Mutations are applied to the working tree one at a time and
 * always restored; nothing is committed and nothing reaches production.
 *
 *   node scripts/diagnosticSensitivity.mjs [--only id]   → writes docs/planning-failure-map/sensitivity.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const RP = 'server/services/goals/routeProposal.ts';
const MUTATIONS = [
  { id: 'C21-P', rc: 'RC4', file: RP, find: 'export const FINDINGS_SHOWN = 120;', replace: 'export const FINDINGS_SHOWN = 40;', test: 'tests/researchInformedRoutes.test.ts tests/planningFailureMapWave1.test.ts', name: 'RC4', why: 'the old 40-finding cap' },
  { id: 'C21-X', rc: 'RC4', file: RP, find: "    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();", replace: "    const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);", test: 'tests/planningFailureMapWave1.test.ts', name: 'RC4', why: 'near-duplicates judged on the first 160 characters' },
  { id: 'C19-I', rc: 'RC4', file: RP, find: "    if ((claim as { contradictionState?: string }).contradictionState === 'REFUTED') continue;", replace: '', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC4', why: 'a refuted claim shown as a finding' },
  { id: 'C12-R', rc: 'RC4', file: RP, find: '  if (eligible.length > max) {', replace: '  if (false) {', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC4', why: 'newest-first fill crowding out other lanes' },
  { id: 'C25-P', rc: 'RC8', file: RP, find: '    if (acquisitionCostPerSale !== null && acquisitionCostPerSale >= price - directCost) {', replace: '    if (false) {', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC8', why: 'a route whose buyers cost more than a sale earns accepted' },
  { id: 'C25-R', rc: 'RC8', file: RP, find: "    e.firstCashBy ? `first money by ${e.firstCashBy}", replace: "    e.firstCashBy && false ? `first money by ${e.firstCashBy}", test: 'tests/planningFailureMapWave1.test.ts', name: 'RC8', why: 'the critic not told the computed first-cash date' },
  { id: 'C30-F', rc: 'RC9', file: RP, find: "    const ownerFit = str(r['ownerFit'], 300) ?? 'not stated by the proposer — judge it from the route against the owner\\'s words';", replace: "    const ownerFit = str(r['ownerFit'], 300);\n    if (!ownerFit) { reject('no owner fit', 'OWNER_FIT'); continue; }", test: 'tests/planningFailureMapWave1.test.ts', name: 'RC9', why: 'a missing owner-fit sentence loses the route' },
  { id: 'C31-F', rc: 'RC2', file: RP, find: '    if (numericOnly && !review.repair) {', replace: '    if (false) {', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC2', why: 'a WINDOW-only drop removes the route (the net-30 misreading)' },
  { id: 'C26-F', rc: 'RC2', file: RP, find: "    const verdict = numericOnly && review.repair ? 'REPAIR' : review.verdict;", replace: '    const verdict = review.verdict;', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC2', why: 'a disputed timing dropped instead of re-checked as a repair' },
  { id: 'C23-F', rc: 'RC1', file: RP, find: '  const second = await once(maxTokens * 2);\n  if (second.error || second.content.trim()) return second;', replace: '  const second = first;\n  if (second.error || second.content.trim()) return second;', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC1', why: 'an empty reply not retried with a larger budget' },
  { id: 'C23-P', rc: 'RC1', file: 'server/services/cheap/modelBench.ts', find: ": { stream: true }),", replace: ': {}),', test: 'tests/chatStreaming.test.ts', name: 'streamed', why: 'a non-streamed turn cut by the 100 s proxy idle' },
  { id: 'C11-X', rc: 'RC5', file: RP, find: '  return ctx.ownerLabour?.offered\n    ? "The owner offers', replace: '  return false\n    ? "The owner offers', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC5', why: "the owner's direct paid work never considered first" },
  { id: 'C03-I', rc: 'RC3', file: 'server/services/cash/discovery.ts', find: '  if (!labour.offered) return REMOTE_AI_FOCUS;', replace: '  return REMOTE_AI_FOCUS;', test: 'tests/planningFailureMapWave1.test.ts', name: 'RC3', why: 'discovery online-only for an owner who offered work' },
  { id: 'C01-P', rc: 'RC15', file: 'server/services/industry/construction/intent.ts', find: '(?:hours?|hrs?)\\b(?:\\s+(?:this|that)\\s+week)?(?!', replace: '(?:hours?|hrs?)(?:\\s+(?:this|that)\\s+week)?(?!', test: 'tests/objectiveFreshPhrasings.test.ts', name: 'at most', why: '"N hours a week at most" read as a total of N' },
  { id: 'C01-P2', rc: 'RC15', file: 'server/services/industry/construction/intent.ts', find: '  if (deadline === null && statesMonthlyRate(text)) {', replace: '  if (false) {', test: 'tests/objectiveFreshPhrasings.test.ts', name: 'start month', why: 'a monthly figure with a start month refused for want of a deadline' },
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const run = (test) => spawnSync('npx', ['vitest', 'run', ...test.split(' ')], { encoding: 'utf8', timeout: 600_000 });
const results = [];
for (const m of MUTATIONS.filter((one) => !only || one.id === only)) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    results.push({ ...m, outcome: 'MUTATION_NOT_APPLICABLE' });
    continue;
  }
  let mutated = null;
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    mutated = run(m.test);
  } finally {
    writeFileSync(m.file, original);
  }
  const good = run(m.test);
  const caught = mutated.status !== 0;
  const failedNames = [...(mutated.stdout + mutated.stderr).matchAll(/(?:×|FAIL)\s+([^\n]+)/g)].map((x) => x[1].trim()).slice(0, 4);
  const named = failedNames.some((line) => line.includes(m.name));
  const expectFail = m.expectFail !== false;
  results.push({ id: m.id, rc: m.rc, why: m.why, test: m.test, knownBadDetected: caught, causeNamed: caught ? named : null, knownGoodAccepted: good.status === 0, verified: expectFail ? caught && named && good.status === 0 : null, note: m.note ?? null, failing: failedNames });
  console.log(`${m.id.padEnd(7)} ${m.rc.padEnd(5)} bad:${caught ? 'DETECTED' : 'missed'} cause:${caught ? (named ? 'named' : 'not named') : '-'} good:${good.status === 0 ? 'accepted' : 'REJECTED'}  ${m.why}`);
}
writeFileSync('docs/planning-failure-map/sensitivity.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
