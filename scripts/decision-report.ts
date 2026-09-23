/**
 * The decision brief for every recorded objective, read inside the deployed
 * container.
 *
 * Read-only. It opens the database, composes, prints and closes. For a project
 * running a Cash sprint whose objective nobody has asked about yet, it composes
 * the brief for that recorded objective **without adopting it** — a transient
 * objective that is never written — so the reading is exactly what Russell
 * would answer and reading it changes nothing. Objectives that already exist
 * are printed with their steps and their recommendation history.
 *
 * Every line resolves to a row: paths name their opening, deal or idea;
 * rejections name the row that decided them; steps name their work item.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { listDecisions, listObjectives, listSteps, type Objective } from '../server/repos/objectives.ts';
import { composeBrief } from '../server/services/decision/brief.ts';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function report(objective: Objective, persisted: boolean): Promise<void> {
  const { brief, outcome } = await composeBrief(objective);
  console.log('');
  console.log('='.repeat(100));
  console.log(
    `OBJECTIVE ${persisted ? objective.id : '(not adopted yet — composed transiently, nothing written)'} — project ${objective.projectId}`,
  );
  console.log(`  source    ${objective.sourceKind} ${objective.sourceRef}`);
  console.log(`  verdict   ${brief.verdict}`);
  console.log(
    `  paths     ${brief.counts.paths} compared, ${brief.counts.live} live, ${brief.counts.rejected} rejected`,
  );
  console.log('='.repeat(100));
  console.log(brief.text);
  console.log('');
  console.log('LIVE PATHS (ranked)');
  for (const path of [outcome.leading, ...outcome.alternatives.map((one) => one.path)]) {
    if (!path) continue;
    console.log(`  ${path.ref}  ${path.standing}  first open: ${path.firstOpen?.criterion ?? '—'}  research: ${path.researchStep?.kind ?? 'none'}`);
  }
  console.log(`REJECTED (${outcome.rejected.length})`);
  for (const path of outcome.rejected) {
    console.log(`  ${path.ref}  on ${path.rejectedOn?.criterion} (${path.rejectedOn?.kind}) [${path.rejectedOn?.evidenceRef ?? '—'}]`);
    console.log(`      ${path.because}`);
  }
  if (persisted) {
    console.log('STEPS');
    for (const step of await listSteps(objective.id)) {
      console.log(
        `  ${step.id} ${step.kind} ${step.authority} work=${step.workKind ?? '—'}:${step.workRef ?? '—'}${step.supersededAt ? ` superseded ${step.supersededAt}` : ''}`,
      );
    }
    console.log('HISTORY');
    for (const one of await listDecisions(objective.id)) {
      console.log(`  ${one.createdAt} ${one.verdict} ${one.pathRef ?? '—'} — ${one.summary}`);
      if (one.changedBecause) console.log(`      because: ${one.changedBecause}`);
    }
  }
}

async function main(): Promise<void> {
  await initDatabase();
  const only = argument('--project');
  let count = 0;
  for (const project of await listProjects()) {
    if (only && project.id !== only) continue;
    const live = await listObjectives({ projectId: project.id });
    for (const objective of live) {
      await report(objective, true);
      count += 1;
    }
    const mode = await getCashMode(project.id);
    if (mode && !live.some((one) => one.sourceKind === 'CASH_MODE' && one.sourceRef === mode.id)) {
      await report(
        {
          id: 'transient',
          projectId: project.id,
          conversationId: null,
          statement: mode.objective.trim(),
          sourceKind: 'CASH_MODE',
          sourceRef: mode.id,
          createdByUserId: mode.createdByUserId,
          closedAt: null,
          closedReason: null,
          closedByUserId: null,
          createdAt: mode.createdAt,
          updatedAt: mode.createdAt,
        },
        false,
      );
      count += 1;
    }
  }
  console.log('');
  console.log(`DECISION-REPORT: OK objectives=${count}`);
}

main()
  .catch((error) => {
    console.error('DECISION-REPORT: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
