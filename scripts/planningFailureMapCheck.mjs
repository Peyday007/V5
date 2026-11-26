#!/usr/bin/env node
/**
 * Checks the planning failure map (docs/PLANNING-FAILURE-MAP.md, data in
 * docs/planning-failure-map/map.json) against itself: every question is whole,
 * every status is one of four, every root cause a question names exists, the
 * rendered record states the counts the data holds, and — with --accept — the
 * latest measured progress meets the owner's bar (27 of 30 fresh goals usable).
 *
 *   node scripts/planningFailureMapCheck.mjs [structure|repairs|coverage|accept|all]
 */
import { readFileSync } from 'node:fs';

const which = process.argv[2] ?? 'structure';
const data = JSON.parse(readFileSync('docs/planning-failure-map/map.json', 'utf8'));
const md = readFileSync('docs/PLANNING-FAILURE-MAP.md', 'utf8');
const failures = [];
const ok = (cond, what) => { if (!cond) failures.push(what); };
const STATUSES = ['PASS', 'FAIL', 'UNKNOWN', 'NEEDS RECHECK'];

if (which === 'structure' || which === 'all') {
  ok(data.capabilities.length >= 40, 'at least 40 capabilities are mapped');
  const ids = new Set(data.questions.map((q) => q.id));
  ok(ids.size === data.questions.length, 'every question id is unique');
  for (const cap of data.capabilities) for (const dim of ['P', 'R', 'I', 'F', 'X']) ok(ids.has(`${cap.id}-${dim}`), `${cap.id} is examined on ${dim}`);
  for (const q of data.questions) {
    ok(q.test && q.expected && q.why && q.cap, `${q.id} states its test, expected behaviour, capability and why`);
    ok(STATUSES.includes(q.status), `${q.id} has a status of PASS, FAIL, UNKNOWN or NEEDS RECHECK`);
    ok(q.status === 'UNKNOWN' || q.evidence, `${q.id}: a status other than UNKNOWN names its evidence`);
    for (const rc of (q.rc || '').split(',').filter(Boolean)) ok(rc in data.rootCauses, `${q.id} names root cause ${rc}, which is recorded`);
  }
  ok(md.includes(`Diagnostic questions (`) && md.includes(`**${data.questions.length}**`), 'the record states the question count the data holds');
  ok(md.includes(`Root causes established: **${Object.keys(data.rootCauses).length}**`), 'the record states the root-cause count the data holds');
  for (const rc of Object.values(data.rootCauses)) ok(rc.wrong && rc.owner && rc.proof && rc.evidence && rc.kind, `root cause ${rc.name} states what is wrong, its kind, owner, proof and evidence`);
}
if (which === 'repairs' || which === 'all') {
  for (const r of data.repairs) ok(r.owner && r.what && r.state, `repair ${r.id} names what, owner and state`);
  for (const rc of Object.keys(data.rootCauses)) ok(data.repairs.some((r) => r.rc === rc), `root cause ${rc} has a repair`);
}
if (which === 'coverage') {
  const open = data.questions.filter((q) => q.status === 'UNKNOWN');
  ok(open.length === 0, `every diagnostic question has been examined (${open.length} still UNKNOWN: ${open.slice(0, 12).map((q) => q.id).join(', ')}${open.length > 12 ? ', …' : ''})`);
}
if (which === 'accept') {
  const last = data.progress[data.progress.length - 1];
  const m = /^(\d+)\/30\b/.exec(last?.usable ?? '');
  ok(!!m && Number(m[1]) >= 27 && /zero critical/i.test(last.note ?? ''), `the latest measurement shows at least 27/30 fresh goals usable with zero critical mistakes (latest: ${last?.usable ?? 'none'})`);
}
if (failures.length) {
  console.error(`PLANNING_FAILURE_MAP ${which}: FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`PLANNING_FAILURE_MAP ${which}: OK`);
