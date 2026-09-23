/**
 * `npm run report:learning` — what Brain learned from its own outcomes.
 *
 * The same derivation the Learning page reads (`services/learning/view.ts`), so
 * a person reading the page and an operator reading this are reading one
 * answer. Every line resolves to a row id.
 *
 * Read-only by default. `--observe` first runs the learning pass itself —
 * observing outcomes and rechecking watches — which writes only learning rows
 * (outcomes, reconstructed predictions, watch cursors and changes). It starts
 * no research, launches nothing, and changes no decision; the next decision is
 * still made by the launcher on its own tick.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { learningView } from '../server/services/learning/view.ts';
import { runLearning } from '../server/services/learning/kernel.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const observe = process.argv.includes('--observe');

function line(text: string): void {
  console.log(text);
}

async function reportProject(projectId: string, name: string): Promise<boolean> {
  if (!(await getCashMode(projectId))) return false;
  if (observe) {
    const pass = await runLearning(projectId);
    line(`OBSERVED ${pass.observed} new outcome row(s), ${pass.changes.length} watch change(s)${pass.error ? ` — error: ${pass.error}` : ''}`);
  }
  const view = await learningView(projectId);
  line('');
  line('='.repeat(100));
  line(`LEARNING — ${name} (${projectId})`);
  line('='.repeat(100));
  const c = view.counts;
  line(
    `  outcomes    ${c.total}  SUCCEEDED=${c.SUCCEEDED} PARTIAL=${c.PARTIAL} FAILED=${c.FAILED} ` +
      `NOT_ATTEMPTED=${c.NOT_ATTEMPTED} ONGOING=${c.ONGOING}  without any work=${c.withoutWork}`,
  );
  line('');
  line('WHAT BRAIN LEARNED');
  line(`  learned      ${view.summary.learned ?? '— no lesson has cleared its floor'}`);
  line(`  does now     ${view.summary.doesDifferently ?? '—'}`);
  line(`  supported by ${view.summary.supportedBy ?? '—'}`);
  line(`  not concluded ${view.summary.notConcluded ?? '—'}`);
  line('');
  line(`LESSONS (${view.lessons.length})`);
  for (const lesson of view.lessons) {
    line(`  ${lesson.status} ${lesson.level} ${lesson.key} independent=${lesson.independent} rests-on=${lesson.outcomeIds.length} fingerprint=${lesson.fingerprint}`);
    line(`      ${lesson.statement}`);
    line(`      effect: ${lesson.effect}`);
  }
  line('');
  line(`DECISIONS AN OUTCOME CHANGED (${view.decisions.length})`);
  for (const decision of view.decisions) {
    line(`  ${decision.id} ${decision.createdAt} ${decision.decision} default="${decision.defaultChoice}" chose="${decision.chosen}" lesson=${decision.lessonKey}${decision.restsOnWithdrawnLesson ? ' (lesson since WITHDRAWN)' : ''}`);
  }
  line('');
  line(`OUTCOMES (newest first, ${Math.min(view.outcomes.length, 40)} of ${view.outcomes.length})`);
  for (const entry of view.outcomes.slice(0, 40)) {
    const o = entry.outcome;
    const passes = o.measures.find((m) => m.metric === 'RESEARCH_PASSES');
    line(`  ${o.id} ${o.result} ${o.subjectId} attempt=${o.attempt} work=${o.workPerformed ? 'yes' : 'no'} blocker=${o.blockerClass ?? '—'} passes=${passes?.value ?? '—'} at=${o.observedAt}`);
    line(`      prediction ${entry.prediction ? `${entry.prediction.id} (${entry.prediction.provenance})` : '— none recorded'} · signal=${o.conditions['signal'] ?? '—'} source=${o.conditions['sourceOrchestrationId'] ?? '—'}`);
  }
  line('');
  line(`WATCHES (${view.watches.length})`);
  for (const watch of view.watches) line(`  ${watch.fact} ${watch.factRef} = ${watch.lastValue ?? 'unread'} (checked ${watch.lastCheckedAt ?? '—'})`);
  for (const change of view.changes) line(`  CHANGE ${change.observedAt} ${change.fromValue ?? '—'} -> ${change.toValue}: ${change.whatChanged} PROPOSAL: ${change.proposal}`);
  line('');
  line(`MISSING CAPABILITIES (${view.capabilities.length})`);
  for (const proposal of view.capabilities) {
    line(`  ${proposal.state} ${proposal.blockerKey} occurrences=${proposal.occurrences} subjects=${proposal.subjects} recommended=${proposal.recommended ?? '—'}`);
    line(`      reason: ${proposal.reason}`);
    line(`      unlocks: ${proposal.unlocks}`);
    for (const option of proposal.options) {
      line(`      ${option.route} viable=${option.viable} cost(${option.cost.evidence}): ${option.cost.text}`);
    }
    line(`      since last seen: ${proposal.sinceLastSeen.attempts} settled, ${proposal.sinceLastSeen.performedWork} performed work · ${proposal.verification}`);
  }
  return true;
}

async function main(): Promise<void> {
  await initDatabase();
  const only = flag('project');
  let found = 0;
  for (const project of await listProjects()) {
    if (only && project.id !== only) continue;
    if (await reportProject(project.id, project.name)) found += 1;
  }
  line('');
  line(`LEARNING-REPORT: OK projects=${found}`);
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error(`LEARNING-REPORT: FAILED ${pooler ?? ''}`, pooler ? '' : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
