/**
 * `npm run commerce -- <command>` — the operator surface for the commerce
 * kernel (§73).
 *
 * The same operations the routes at `/api/projects/:id/commerce` perform,
 * against the same services, for the recovery case §26 keeps a terminal for.
 * `--admin <email>` is attribution, not authentication: reaching this shell is
 * what authenticated it, and the flag resolves an enabled administrator so the
 * row says whose authority it carries.
 *
 * A command that changes nothing does not print success (§23): every write
 * reports whether a row changed and exits non-zero when none did.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getUserByEmail } from '../server/repos/identity.ts';
import { getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import {
  moveCommerceProgramme,
  retireCommerceProductDecision,
  seedCommerceProduct,
  startCommerceProgramme,
} from '../server/services/commerce/programme.ts';
import { commerceView } from '../server/services/commerce/view.ts';
import { runCommerceKernel } from '../server/services/commerce/kernel.ts';
import { registerCommerceProviders } from '../server/services/commerce/connect/register.ts';
import { probeShopify } from '../server/services/commerce/connect/shopify.ts';
import { probeCj } from '../server/services/commerce/connect/cj.ts';
import { probeMeta } from '../server/services/commerce/connect/meta.ts';

function out(line = ''): void {
  console.log(line);
}

class ExitSignal extends Error {}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

const USAGE = `
  npm run commerce -- <command>

  start <project> --objective "…" --admin <email>   start the programme on a project
  state <project> --to ACTIVE|PAUSED --admin <email>
  show <project>                                    products, where each stands, what is next
  tick <project>                                    run one kernel pass by hand
  seed <project> --name "…" --admin <email> [--note "…"]
  retire <project> --product <id> --reason "…" --admin <email>
  probe                                             check the store, supplier and ad keys; sends nothing

  A project is named by slug or id.

  Selling (§74) happens on the tick, only once the store, supplier and ad
  account are connected and the standing commercial authority grants
  LIST_PRODUCT, RUN_ADS and FULFIL_ORDER. 'show' names whatever is missing.
`;

async function resolveProject(ref: string | undefined): Promise<{ id: string; name: string }> {
  if (!ref) fail('Name a project, by slug or id.');
  const bySlug = await getProjectBySlug(ref as string);
  if (bySlug) return { id: bySlug.id, name: bySlug.name };
  const all = await listProjects();
  const byId = all.find((one) => one.id === ref);
  if (byId) return { id: byId.id, name: byId.name };
  fail(`No project matches "${ref}". This Brain holds: ${all.map((one) => one.slug).join(', ') || 'none'}.`);
}

async function resolveAdmin(argv: string[]): Promise<string> {
  const email = flag(argv, 'admin');
  if (!email) fail('--admin <email> says whose authority this carries, and it is required.');
  const person = await getUserByEmail(email as string);
  if (!person || !person.isBrainAdmin || person.disabled) {
    fail(
      `"${email}" resolves to no enabled administrator of this Brain. This is the attribution on ` +
        'the row rather than the check that let you in, so it has to name somebody who exists.',
    );
  }
  return person.id;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    out(USAGE);
    return;
  }
  await initDatabase();
  registerCommerceProviders();

  switch (command) {
    case 'start': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const objective = flag(rest, 'objective');
      if (!objective) fail('--objective "…" is required.');
      const outcome = await startCommerceProgramme({ projectId: project.id, actorUserId: admin, objective: objective as string });
      if (!outcome.ok) fail(outcome.reason);
      out('');
      out(`  ${outcome.created ? 'Started' : 'Already running'}  ${project.name}`);
      out(`  Objective  ${outcome.programme.objective}`);
      out(`  State      ${outcome.programme.state}`);
      out('');
      if (!outcome.created) fail('Nothing changed.');
      break;
    }
    case 'state': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const to = flag(rest, 'to');
      if (to !== 'ACTIVE' && to !== 'PAUSED') fail('--to must be ACTIVE or PAUSED.');
      const outcome = await moveCommerceProgramme({ projectId: project.id, actorUserId: admin, to });
      if (!outcome.ok) fail(outcome.reason);
      out(`\n  State  ${outcome.programme.state}\n`);
      break;
    }
    case 'show': {
      const project = await resolveProject(rest[0]);
      await show(project.id);
      break;
    }
    case 'tick': {
      const project = await resolveProject(rest[0]);
      const pass = await runCommerceKernel(project.id);
      out('');
      out(`  Filed      ${pass.filed.products.length} product(s), ${pass.filed.facts.length} fact(s), ${pass.filed.refused.length} refused`);
      out(`  Settled    ${pass.filed.settled.length} round(s)`);
      out(`  Opened     ${pass.opened.length}`);
      for (const one of pass.opened) out(`    ${one.purpose.padEnd(9)} ${one.roundId}  why: ${one.why}`);
      for (const one of pass.declined.slice(0, 10)) out(`  Declined   ${one.subject} — ${one.why}`);
      out(`  Products   ${pass.products} on the map, ${pass.qualified} qualified`);
      if (pass.launch) {
        for (const one of pass.launch.lines) out(`  Selling    ${one.name}: ${one.did ?? one.blocker ?? 'nothing to do'}`);
        out(`  Orders     ${pass.launch.ordersSeen} new, ${pass.launch.ordersPlaced} bought from the supplier, ${pass.launch.ordersShipped} shipped`);
      }
      out('');
      break;
    }
    case 'seed': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const name = flag(rest, 'name');
      if (!name) fail('--name "…" is required.');
      const outcome = await seedCommerceProduct({ projectId: project.id, actorUserId: admin, name: name as string, note: flag(rest, 'note') });
      if (!outcome.ok) fail(outcome.reason);
      out(`\n  ${outcome.created ? 'Seeded' : 'Already on the map'}  ${outcome.product.name}  ${outcome.product.id}\n`);
      if (!outcome.created) fail('Nothing changed.');
      break;
    }
    case 'retire': {
      const project = await resolveProject(rest[0]);
      const admin = await resolveAdmin(rest);
      const productId = flag(rest, 'product');
      const reason = flag(rest, 'reason');
      if (!productId || !reason) fail('--product <id> and --reason "…" are both required.');
      const outcome = await retireCommerceProductDecision({ projectId: project.id, actorUserId: admin, productId: productId as string, reason: reason as string });
      if (!outcome.ok) fail(outcome.reason);
      out('\n  Retired.\n');
      break;
    }
    case 'probe': {
      await probe();
      break;
    }
    default:
      out(USAGE);
      fail(`"${command}" is not a command.`);
  }
}

async function show(projectId: string): Promise<void> {
  const view = await commerceView(projectId);
  out('');
  if (!view.programme) {
    out('  No commerce programme on this project. `start` begins one.');
    out('');
    return;
  }
  out(`  PROGRAMME  ${view.programme.state} — ${view.programme.objective}`);
  const c = view.counts;
  out(
    `  PRODUCTS   ${c.products} on the map · ${c.QUALIFIED} qualified · ${c.COSTED} costed · ${c.PRICED} priced · ` +
      `${c.SOURCED} sourced · ${c.DEMAND_SEEN} demand only · ${c.THIN_MARGIN} thin margin · ${c.BLOCKED} blocked · ${c.STALE} stale`,
  );
  out('');
  for (const one of view.products.slice(0, 40)) {
    out(`  ${one.stage.padEnd(11)} ${one.name}  (${one.id})`);
    out(`      ${one.because}`);
    if (one.retail) out(`      retail ${one.retail}`);
    if (one.supplier) out(`      supplier ${one.supplier.name} at ${one.supplier.unitCost}, ${one.supplier.days ?? '?'} day(s)`);
    out(`      acquisition budget: ${one.acquisitionBudget}`);
    if (one.niches.length) out(`      niches: ${one.niches.join('; ')}`);
    if (one.conditions.length) out(`      read before selling: ${one.conditions.join('; ')}`);
  }
  out('');
  out('  OPEN QUESTIONS');
  if (view.openRounds.length === 0) out('    none');
  for (const one of view.openRounds) out(`    ${one.purpose.padEnd(9)} ${one.product ?? '—'}  round ${one.round}  ${one.id}`);
  out('  NEXT');
  if (view.next.length === 0) out('    nothing — every slot is taken or the programme is not active');
  for (const one of view.next) out(`    ${one.purpose.padEnd(9)} ${one.product ?? '—'} — ${one.why}`);
  out('  CONNECTIONS');
  for (const one of view.connections) out(`    ${one.state.padEnd(13)} ${one.capability}: ${one.needs}`);
  out('  SELLING');
  if (view.launches.length === 0) out('    nothing yet — a product must be QUALIFIED first');
  for (const one of view.launches) {
    out(`    ${one.product}  price ${one.price ?? '—'}  ${one.listed ? 'listed' : 'not listed'}`);
    if (one.supplier) out(`      supplier ${one.supplier}`);
    for (const test of one.adTests) out(`      ad test ${test.round}: ${test.state} spent ${test.spend}${test.outcome ? ` (${test.outcome})` : ''}`);
    if (one.problem) out(`      next: ${one.problem}`);
    if (one.stopped) out(`      stopped: ${one.stopped}`);
  }
  out('  ORDERS');
  if (view.orders.length === 0) out('    none');
  for (const one of view.orders) {
    out(`    ${one.name} ${one.amount} ${one.state}${one.tracking ? ` tracking ${one.tracking}` : ''}${one.problem ? ` — ${one.problem}` : ''}`);
  }
  out('');
}

async function probe(): Promise<void> {
  const [store, supplier, ads] = await Promise.all([probeShopify(), probeCj(), probeMeta()]);
  out('');
  out(`  Store     ${store.verdict}  ${store.detail}${store.currency ? ` (prices in ${store.currency})` : ''}`);
  out(`  Supplier  ${supplier.verdict}  ${supplier.detail}`);
  out(`  Ads       ${ads.verdict}  ${ads.detail}${ads.currency ? ` (bills in ${ads.currency})` : ''}`);
  out('');
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ExitSignal)) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}
