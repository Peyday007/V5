/**
 * `npm run verify:closeout` — what each repaired surface actually says, in
 * production.
 *
 * ---------------------------------------------------------------------------
 * Why a script rather than a screenshot
 * ---------------------------------------------------------------------------
 *
 * Every defect this closeout repaired was visible on a screen and invisible in
 * every test, so proving the repair means reading what the screen reads. A
 * screenshot proves one browser rendered something; this calls the **same
 * projections the screens render from** — `cashView`, `peopleReading`,
 * `connectionView`, `programmeView`, `collectionsView` — inside the deployed
 * container, against the live database.
 *
 * It is the other half of `verify-hosted.ts` rather than a replacement for it.
 * That one drives the HTTP surface from outside as a real principal and proves
 * the door; this reads the answers the doors hand out and prints them, which is
 * the thing a person was being told wrongly.
 *
 * Read-only by construction: it opens the database, calls projections that
 * write nothing, prints, and closes. It activates nothing, adopts nothing,
 * renames nobody and starts no programme. Two projections *do* write, and
 * saying so exactly is better than a sentence that is nearly true:
 * `connectionView` assigns a connection its three names and reconciles its
 * state against rows, exactly as §34 records — neither creates an account, a
 * Routine, a worker, a credential or a bin.
 *
 * No credential is read or printed.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listProjects } from '../server/repos/projects.ts';
import { listUsers } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { cashView } from '../server/services/cash/view.ts';
import { peopleReading } from '../server/services/identity/people.ts';
import { connectionView } from '../server/services/capacity/connection.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { listConversationsForOwner } from '../server/repos/russellConversations.ts';
import { getProject } from '../server/repos/projects.ts';
import { collectionNameFor } from '../server/services/russell/collections.ts';
import { personName } from '../server/domain/personName.ts';

function heading(text: string): void {
  console.log('');
  console.log('='.repeat(100));
  console.log(text);
  console.log('='.repeat(100));
}

/** The one figure that must read as *nothing to total* rather than as zero. */
function contribution(value: number | null): string {
  return value === null ? 'null — no work to total' : `${value} cents`;
}

async function verifyCash(): Promise<void> {
  heading('A. WHAT IS WORK, AND WHAT IS EVIDENCE');
  for (const project of await listProjects()) {
    if (!(await getCashMode(project.id))) continue;
    const view = await cashView({ projectId: project.id });
    const work = view.myCurrentWork;
    console.log(`  ${project.name} (${project.id})`);
    console.log(
      `    tiers        SIGNAL=${work.byTier.SIGNAL} CANDIDATE=${work.byTier.CANDIDATE} ` +
        `QUALIFIED=${work.byTier.QUALIFIED} READY_TO_TEST=${work.byTier.READY_TO_TEST}`,
    );
    console.log(
      `    to act on    ${work.executeNow.length}` +
        `    waiting ${work.waiting.length}` +
        `    being qualified ${work.beingQualified.length}` +
        `    evidence ${work.evidence.length}`,
    );
    console.log(`    aggregate    ${contribution(work.combinedContributionCents)}`);
    console.log(
      `    best shown   ${work.best.length}` +
        `${work.bestAreNearlyQualified ? ' (nearly qualified, said so)' : ''}`,
    );
    /*
     * The two production records by name, if they are still here. Naming them
     * is the point: these are the sentences the owner was shown as current
     * work, and what this prints is where each one sits now.
     */
    for (const placement of work.placements.slice(0, 3)) {
      console.log(
        `    · ${placement.disposition.padEnd(16)} ${placement.tier.tier.padEnd(14)} ` +
          `${placement.opportunity.title.slice(0, 60)}`,
      );
    }
    console.log(
      `    refinement   ${view.roadmap.pipeline
        .filter((stage) => stage.key === 'VALIDATING' || stage.key === 'VALIDATION_NEEDS_PERSON')
        .map((stage) => `${stage.label}=${stage.count}`)
        .join('  ')}`,
    );
  }
}

async function verifyPeople(): Promise<void> {
  heading('B. WHO THE PRODUCT SAYS PEOPLE ARE');
  const reading = await peopleReading(null);
  for (const person of reading.people) {
    console.log(
      `  ${person.userId}  ${person.state.padEnd(12)} ` +
        `${person.isBrainAdmin ? 'ADMIN ' : '      '} ${person.displayName}`,
    );
  }
  console.log('');
  console.log('  and the same rows through the one rule every human-facing surface uses:');
  for (const user of await listUsers()) {
    if (user.kind !== 'PERSON' || user.disabledAt) continue;
    const shown = personName(user);
    console.log(
      `  ${user.id}  row="${user.displayName}"  shown="${shown}"` +
        `${shown.includes('@') ? '   <-- STILL AN ADDRESS' : ''}`,
    );
  }
}

async function verifyConnection(origin: string): Promise<void> {
  heading('C. WHAT THE CLAUDE CONNECTION SAYS');
  for (const user of await listUsers()) {
    if (user.kind !== 'PERSON' || user.disabledAt) continue;
    const view = await connectionView({ user, origin });
    console.log(
      `  ${personName(user).padEnd(20)} ${view.state.padEnd(22)} ` +
        `worker=${view.identity.workerId ?? '—'} routine=${view.identity.routineName ?? '—'}`,
    );
    console.log(
      `      authorized=${view.connectorAuthenticated} expired=${view.authorizationExpired}` +
        ` secret=${view.secretPresent} proven=${view.proven ? 'yes' : 'no'}`,
    );
    console.log(`      ${view.headline}`);
    if (view.nextAction) console.log(`      next: ${view.nextAction}`);
  }
}

async function verifyConversations(): Promise<void> {
  heading('D. WHERE CONVERSATIONS ARE FILED');
  for (const user of await listUsers()) {
    if (user.kind !== 'PERSON' || user.disabledAt) continue;
    const threads = await listConversationsForOwner(user.id, 100);
    if (threads.length === 0) continue;
    console.log(`  ${personName(user)} — ${threads.length} thread(s)`);
    const tally = new Map<string, number>();
    for (const thread of threads) {
      const project = thread.projectId ? await getProject(thread.projectId) : null;
      const target = collectionNameFor({
        projectName: project?.name ?? null,
        visibility: thread.visibility,
        purpose: thread.purpose,
      });
      const key = `${thread.purpose} -> ${target.name}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...tally.entries()].sort()) {
      console.log(`      ${String(count).padStart(4)}  ${key}`);
    }
  }
}

async function verifyMachines(): Promise<void> {
  heading('E. THE MANUFACTURING PROGRAMME');
  for (const project of await listProjects()) {
    const view = await programmeView(project.id);
    console.log(
      `  ${project.name.padEnd(28)} ${view ? `${view.program.state} — ${view.counts.categories} categories` : 'none — the page offers Start'}`,
    );
  }
}

async function main(): Promise<void> {
  const origin = process.env['BRAIN_PUBLIC_ORIGIN'] ?? 'https://northline-brain.fly.dev';
  await initDatabase();
  try {
    await verifyCash();
    await verifyPeople();
    await verifyConnection(origin);
    await verifyConversations();
    await verifyMachines();
    console.log('');
    console.log('CLOSEOUT-VERIFY: OK');
  } finally {
    await closeDatabase();
  }
}

await main();
