/**
 * A one-command first pass of the social commerce kernel, on a terminal.
 *
 * `npm run admin` is where §26 puts a decision a person makes about their own
 * project when there is no surface for it yet — reaching the shell is the
 * authentication, and `--admin` is the attribution, resolved against the
 * database rather than trusted. This is the same door for the one decision
 * this kernel cannot make for itself: **which channel to start on**.
 *
 *   npm run commerce -- --project prj_xxx --channel "TikTok Shop" --admin you@example.com
 *   npm run commerce -- --project prj_xxx                    (read and advance only)
 *
 * It does exactly three things, in order, and says which of them it did:
 *
 *   1. Seeds the channel a person named, if they named one. `SEED` is the one
 *      origin Brain may not write, so this is the only way a channel gets on
 *      the map without a gated claim establishing it.
 *   2. Runs one kernel pass — absorb what finished, open what is next, prepare
 *      what can be prepared, raise what is missing.
 *   3. Prints what the loop now holds, and what it would ask next.
 *
 * **It spends nothing and starts no external effect.** Opening a round creates
 * a Russell candidate, which the archive check, the compiler, the approval
 * envelope, the evidence gate and all three audit roles still decide about.
 * Preparing a bounded test writes a row naming what is missing and never
 * authorizes a spend: that is a commercial grant a person makes, and no
 * terminal command here can make one.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getProject, listProjects } from '../server/repos/projects.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { seedChannel } from '../server/services/commerce/seed.ts';
import { runCommerceKernel } from '../server/services/commerce/kernel.ts';
import { commerceView } from '../server/services/commerce/view.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function trim(value: string | null | undefined, width = 100): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

async function main(): Promise<void> {
  await initDatabase();

  const projectId = arg('project');
  if (!projectId) {
    console.log('Pass --project <id>. Projects that run a sprint:');
    for (const project of await listProjects()) {
      const mode = await getCashMode(project.id);
      if (mode) console.log(`  ${project.id}  ${project.name}  [${mode.state}]`);
    }
    return;
  }

  const project = await getProject(projectId);
  if (!project) throw new Error(`No project ${projectId}.`);
  const mode = await getCashMode(projectId);
  if (!mode) {
    throw new Error(
      `${project.name} runs no cash sprint, so there is nothing for a proposition to belong ` +
        'to. Activate one first: a sprint is what authorizes the reading this kernel does.',
    );
  }

  const channelName = arg('channel');
  if (channelName) {
    /*
     * Attribution, resolved against the database rather than trusted.
     *
     * §23's column pair: `--admin` establishes that such a person exists and
     * may authorize this, and says nothing about who typed the command. What
     * authenticated it is reaching the shell.
     */
    const email = arg('admin');
    if (!email) throw new Error('Seeding a channel needs --admin <email> for the attribution.');
    const actor = await getUserByEmail(email);
    if (!actor || actor.disabled) throw new Error(`No enabled account for ${email}.`);

    const seeded = await seedChannel({
      projectId,
      name: channelName,
      description: arg('description'),
      actorRef: actor.id,
      reason: arg('reason'),
    });
    console.log(
      seeded.created
        ? `SEEDED ${seeded.channel.id}  ${seeded.channel.name}  origin=${seeded.channel.origin}`
        : `ALREADY ON THE MAP ${seeded.channel.id}  ${seeded.channel.name} — nothing changed.`,
    );
    console.log('  It spent nothing and started nothing. The allocator decides when to ask.');
  }

  const pass = await runCommerceKernel(projectId);
  console.log('');
  console.log(
    `KERNEL PASS — opened=${pass.opened.length} channels=${pass.absorbed.channels.length} ` +
      `propositions=${pass.absorbed.propositions.length} ` +
      `readings=${pass.absorbed.evidence.length} settled=${pass.absorbed.settled.length} ` +
      `tests=${pass.tests.length} needs=${pass.capabilities.raised.length}`,
  );
  for (const opened of pass.opened) {
    console.log(`  OPENED ${opened.roundId}  ${opened.purpose}  candidate=${opened.candidateId}`);
    console.log(`    because: ${trim(opened.why, 160)}`);
    console.log(`    asks: ${trim(opened.question, 200)}`);
  }
  for (const declined of pass.declined) {
    console.log(`  not asked: ${declined.subject} — ${trim(declined.why, 160)}`);
  }
  for (const test of pass.tests) {
    console.log(`  TEST ${test.propositionId} blocker=${test.blocker ?? 'none'}`);
    console.log(`    ${trim(test.detail, 240)}`);
  }
  for (const raised of pass.capabilities.raised) {
    console.log(`  NEED RAISED ${raised.capability} -> ${raised.needId}`);
  }
  for (const missing of pass.capabilities.missing) {
    console.log(`  capability ${missing.capability} reads ${missing.state}`);
  }

  const view = await commerceView(projectId);
  console.log('');
  console.log(
    `LOOP MATURITY — channels=${view.maturity.channels} propositions=${view.maturity.propositions} ` +
      `purchase=${view.maturity.withPurchase} attention-only=${view.maturity.attentionOnly} ` +
      `supplier=${view.maturity.withSupplier} margin=${view.maturity.withDerivableMargin} ` +
      `positive=${view.maturity.withPositiveMargin} measured=${view.maturity.withMeasuredEvidence}`,
  );
  console.log(`  furthest stage: ${view.maturity.furthestStage ?? 'nothing has started'}`);
  console.log(`  ${trim(view.maturity.measurement, 400)}`);
  for (const channel of view.channels) {
    console.log(`  channel ${channel.id}  ${channel.name} [${channel.origin}] products=${channel.propositions}`);
  }
  for (const [index, piece] of view.best.entries()) {
    console.log(`  ${index + 1}. ${trim(piece.product, 60)} [${piece.stage}] — ${trim(piece.next.what, 140)}`);
  }
  for (const asking of view.asking) {
    console.log(`  asking now: ${asking.purpose} about ${asking.subject}`);
  }
  console.log('');
  console.log(
    `COMMERCE: project=${projectId} sprint=${mode.state} channels=${view.maturity.channels} ` +
      `propositions=${view.maturity.propositions} open_rounds=${view.asking.length} ` +
      `tests_blocked=${view.maturity.testsBlocked}`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
