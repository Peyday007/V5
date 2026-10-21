/**
 * Selling a qualified product (§74): match it to the supplier's exact item,
 * list it in the owner's store, run a bounded ad test, and buy and ship every
 * unit a customer pays for.
 *
 * ---------------------------------------------------------------------------
 * What gates each step
 * ---------------------------------------------------------------------------
 *
 * Every step that reaches outside Brain needs three things, asked on every
 * pass: the connection (a deployment secret, read by the adapter's `health()`),
 * the commercial action in the owner's standing grant (`LIST_PRODUCT`,
 * `RUN_ADS`, `FULFIL_ORDER`), and — for anything that spends — a commitment
 * against that grant's ceilings, taken before the money moves. A step missing
 * any of them does nothing and records, on the launch, the one sentence that
 * says what to connect or grant. Connecting it is the whole of what it takes:
 * the next pass continues by itself.
 *
 * ---------------------------------------------------------------------------
 * Through the effects engine, never beside it
 * ---------------------------------------------------------------------------
 *
 * Listing, starting an ad test and placing a supplier order are each one
 * `runExternalEffect` keyed on a Brain row that cannot change, so a retry, a
 * restart or a second instance is the same effect. All three adapters are
 * reconcilable: after an unknown outcome Brain asks the provider instead of
 * acting twice. Reading orders, reading spend, pausing a campaign, publishing a
 * listing and marking an order shipped are reads or idempotent writes, and are
 * asked again freely.
 *
 * ---------------------------------------------------------------------------
 * What stops by itself, and what never does
 * ---------------------------------------------------------------------------
 *
 * Pausing the programme or winding the sprint down stops new listings and new
 * ad tests. It never stops a running test from being watched and ended, and it
 * never stops a paid order from being bought and shipped — a customer who paid
 * is owed the item (invariant 40).
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { commit, releaseCommitment, settleCommitment } from '../../repos/cashAuthority.ts';
import { recordMoney } from '../../repos/cashLedger.ts';
import { serializeCash } from '../../repos/cashLock.ts';
import { getCommerceProgramme } from '../../repos/commerce.ts';
import {
  ensureAdTest,
  ensureLaunch,
  listAdTests,
  listLaunches,
  listOrders,
  patchAdTest,
  patchLaunch,
  patchOrder,
  recordStoreOrder,
  type CommerceAdTest,
  type CommerceLaunch,
  type CommerceOrder,
} from '../../repos/commerceLaunch.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { runExternalEffect, type ExternalOutcome } from '../effects/external.ts';
import { commerceSnapshot } from './graph.ts';
import { MAX_QUALIFIED_DELIVERY_DAYS, MIN_ACQUISITION_BUDGET_CENTS, MIN_BUDGET_SHARE } from './standing.ts';
import { pursued } from './allocate.ts';
import type { ProductStanding } from './standing.ts';
import { formatMoney } from './economics.ts';
import {
  ADS_DAILY_BUDGET_ENV,
  ADS_PROVIDER_ENV,
  CJ_KEY_ENV,
  META_AD_ACCOUNT_ENV,
  META_PAGE_ENV,
  META_TOKEN_ENV,
  SHOPIFY_DOMAIN_ENV,
  SHOPIFY_TOKEN_ENV,
  STORE_PROVIDER_ENV,
  SUPPLIER_PROVIDER_ENV,
  adCountries,
  dailyBudgetCents,
  secret,
  supplierConfig,
} from './connect/config.ts';
import { matchSupplierItem, readSupplierOrder } from './connect/cj.ts';
import { campaignSpendCents, pauseCampaign } from './connect/meta.ts';
import {
  ensurePublished,
  findListing,
  fulfilWithTracking,
  listingHandle,
  orderShippingAddress,
  paidUnfulfilledOrders,
} from './connect/shopify.ts';
import {
  AD_TEST_NAMESPACE,
  LISTING_NAMESPACE,
  SUPPLIER_ORDER_NAMESPACE,
  usableCommerceAdapter,
} from './connect/register.ts';

/** How many products are on sale at once. */
export const MAX_LIVE_LAUNCHES = 3;
/** How long one ad test runs before it is judged. */
export const AD_TEST_DAYS = 3;
/** A test that has spent this many acquisition budgets with no order is paused. */
export const STOP_SPEND_MULTIPLE = 2;
/** How many tests a winning product may run back to back before a person looks. */
export const MAX_AD_ROUNDS = 6;
/** How far back the store is asked for paid orders. */
export const ORDER_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const ACTOR = 'BRAIN';
const PRINCIPAL = 'commerce-launch';

export const CONNECT_STORE =
  `Connect a store: set ${STORE_PROVIDER_ENV}=shopify, ${SHOPIFY_DOMAIN_ENV} and ${SHOPIFY_TOKEN_ENV} on the deployment.`;
export const CONNECT_SUPPLIER =
  `Connect a supplier: set ${SUPPLIER_PROVIDER_ENV}=cj and ${CJ_KEY_ENV} on the deployment, and fund the CJ wallet.`;
export const CONNECT_ADS =
  `Connect an ad account: set ${ADS_PROVIDER_ENV}=meta, ${META_TOKEN_ENV}, ${META_AD_ACCOUNT_ENV}, ` +
  `${META_PAGE_ENV} and ${ADS_DAILY_BUDGET_ENV} on the deployment.`;

function grantSentence(action: string): string {
  return `Add ${action} to the standing commercial authority on the Cash page.`;
}

export interface LaunchPass {
  /** One line per launch: what it did this pass, or what stands in its way. */
  lines: { productId: string; name: string; did: string | null; blocker: string | null }[];
  ordersSeen: number;
  ordersPlaced: number;
  ordersShipped: number;
}

/* --------------------------------------------------------------------------
 * The pass
 * ------------------------------------------------------------------------ */

export async function runCommerceLaunch(projectId: string, now: number = Date.now()): Promise<LaunchPass> {
  const out: LaunchPass = { lines: [], ordersSeen: 0, ordersPlaced: 0, ordersShipped: 0 };
  const programme = await getCommerceProgramme(projectId);
  if (!programme) return out;
  const mode = await getCashMode(projectId);
  const mayStart = programme.state === 'ACTIVE' && mode?.state === 'ACTIVE';

  const snapshot = await commerceSnapshot(projectId, now);
  const byProduct = new Map(snapshot.standing.map((one) => [one.productId, one]));
  const existing = await listLaunches(projectId);

  if (mayStart) {
    const live = existing.filter((one) => !one.stoppedAt).length;
    const ready = pursued(snapshot.standing).filter((one) => one.stage === 'QUALIFIED');
    let room = Math.max(0, MAX_LIVE_LAUNCHES - live);
    for (const standing of ready) {
      if (existing.some((one) => one.productId === standing.productId)) continue;
      if (room <= 0) break;
      existing.push(await ensureLaunch({ projectId, productId: standing.productId }));
      room -= 1;
    }
  }

  for (const launch of existing) {
    const standing = byProduct.get(launch.productId);
    if (!standing) continue;
    let line: { did: string | null; blocker: string | null };
    try {
      line = await advanceLaunch({ projectId, launch, standing, mayStart, now });
    } catch (error) {
      line = { did: null, blocker: `This pass failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    out.lines.push({ productId: launch.productId, name: standing.name, ...line });
  }

  const orders = await advanceOrders(projectId, now);
  out.ordersSeen = orders.seen;
  out.ordersPlaced = orders.placed;
  out.ordersShipped = orders.shipped;
  return out;
}

/* --------------------------------------------------------------------------
 * One product, from match to a running test
 * ------------------------------------------------------------------------ */

/** Published lines that still apply once the supplier's own shipping is known. */
function otherLinesCents(standing: ProductStanding): number {
  return standing.economics.lines
    .filter((line) => line.component !== 'SHIPPING_TO_CUSTOMER' && line.component !== 'AD_COST_PER_ORDER')
    .reduce((sum, line) => sum + line.perOrderCents, 0);
}

/** What one order leaves to win a customer, with the supplier's real price and shipping. */
export function realBudgetCents(launch: CommerceLaunch, standing: ProductStanding): number | null {
  const retail = standing.economics.retail?.lowCents ?? null;
  if (retail === null || launch.supplierUnitCents === null || launch.supplierShippingCents === null) return null;
  return retail - launch.supplierUnitCents - launch.supplierShippingCents - otherLinesCents(standing);
}

async function setProblem(launch: CommerceLaunch, problem: string | null): Promise<void> {
  if (launch.problem === problem) return;
  await patchLaunch(launch.id, { problem });
  launch.problem = problem;
}

async function stopLaunch(projectId: string, launch: CommerceLaunch, reason: string): Promise<void> {
  if (await patchLaunch(launch.id, { stoppedAt: new Date().toISOString(), stopReason: reason, problem: null }, { stoppedAt: null })) {
    await recordCashEvent({
      projectId,
      kind: 'COMMERCE_LAUNCH_STOPPED',
      actorRef: ACTOR,
      summary: `Selling ${launch.productId} stopped: ${reason}`,
      detail: { launchId: launch.id },
    });
  }
}

function receiptOf(outcome: ExternalOutcome): string | null {
  if (outcome.status === 'CONFIRMED' || outcome.status === 'RECONCILED') return outcome.receiptRef;
  if (outcome.status === 'REPLAYED') return outcome.operation.resultRef;
  return null;
}

async function advanceLaunch(input: {
  projectId: string;
  launch: CommerceLaunch;
  standing: ProductStanding;
  mayStart: boolean;
  now: number;
}): Promise<{ did: string | null; blocker: string | null }> {
  const { projectId, launch, standing, now } = input;

  // A running test is watched and ended whatever else has changed.
  const watched = await watchAdTests(projectId, launch, standing, now);

  if (launch.stoppedAt) return { did: watched, blocker: `Stopped: ${launch.stopReason ?? 'no reason recorded'}` };
  if (!input.mayStart) {
    return { did: watched, blocker: 'The programme is paused or the sprint is not active; nothing new is started.' };
  }

  // 1. The supplier's exact item.
  if (!launch.supplierVariantId) {
    if (!supplierConfig().configured) {
      await setProblem(launch, CONNECT_SUPPLIER);
      return { did: watched, blocker: CONNECT_SUPPLIER };
    }
    const matched = await matchSupplierItem({
      productName: standing.name,
      destinationCountry: adCountries()[0] ?? 'US',
      maxDeliveryDays: MAX_QUALIFIED_DELIVERY_DAYS,
    });
    if (!matched.ok) {
      if (matched.unknown) {
        await setProblem(launch, `The supplier did not answer (${matched.reason}); asked again next pass.`);
        return { did: watched, blocker: launch.problem };
      }
      await stopLaunch(projectId, launch, matched.reason);
      return { did: watched, blocker: matched.reason };
    }
    const m = matched.match;
    await patchLaunch(
      launch.id,
      {
        supplierProductId: m.supplierProductId,
        supplierVariantId: m.supplierVariantId,
        supplierName: m.name,
        supplierUnitCents: m.unitCents,
        supplierShippingCents: m.shippingCents,
        supplierLogistic: m.logisticName,
        supplierMaxDays: m.maxDays,
        supplierImageUrl: m.imageUrl,
        matchedAt: new Date(now).toISOString(),
        problem: null,
      },
      { supplierVariantId: null },
    );
    Object.assign(launch, {
      supplierProductId: m.supplierProductId,
      supplierVariantId: m.supplierVariantId,
      supplierName: m.name,
      supplierUnitCents: m.unitCents,
      supplierShippingCents: m.shippingCents,
      supplierLogistic: m.logisticName,
      supplierMaxDays: m.maxDays,
      supplierImageUrl: m.imageUrl,
    });
  }

  // 2. The margin with the supplier's real price. CJ prices in US dollars.
  const economics = standing.economics;
  if (economics.currency !== 'USD' || !economics.retail) {
    const reason = 'The supplier prices in USD and this product’s published prices are not in USD.';
    await stopLaunch(projectId, launch, reason);
    return { did: watched, blocker: reason };
  }
  const budget = realBudgetCents(launch, standing)!;
  const retail = economics.retail.lowCents;
  if (budget < MIN_ACQUISITION_BUDGET_CENTS || budget / retail < MIN_BUDGET_SHARE) {
    const reason =
      `With the supplier's real price and shipping, one order leaves ${formatMoney(budget, 'USD')} ` +
      `(${Math.round((budget / retail) * 100)}% of ${formatMoney(retail, 'USD')}), under the floor.`;
    await stopLaunch(projectId, launch, reason);
    return { did: watched, blocker: reason };
  }
  if (launch.priceCents === null) {
    await patchLaunch(launch.id, { priceCents: retail, currency: 'USD' }, { priceCents: null });
    launch.priceCents = retail;
    launch.currency = 'USD';
  }

  // 3. The listing.
  if (!launch.storeProductId) {
    const listed = await list(projectId, launch, standing, budget);
    if (listed.blocker) return { did: watched, blocker: listed.blocker };
    return { did: listed.did, blocker: null };
  }

  // The variant id is what matches a store order to this product; a listing
  // whose variant was not read back is read again rather than never matched.
  if (!launch.storeVariantId && launch.storeHandle) {
    const found = await findListing(launch.storeHandle);
    if (found && found !== 'UNKNOWN' && found.variantId) {
      await patchLaunch(launch.id, { storeVariantId: found.variantId }, { storeVariantId: null });
      launch.storeVariantId = found.variantId;
    }
  }

  // 4. Visible on the Online Store.
  if (!launch.publishedAt) {
    const published = await ensurePublished(launch.storeProductId);
    if (!published.ok) {
      await setProblem(launch, `The listing exists and is not visible yet: ${published.reason}.`);
      return { did: watched, blocker: launch.problem };
    }
    await patchLaunch(launch.id, { publishedAt: new Date(now).toISOString(), problem: null }, { publishedAt: null });
    launch.publishedAt = new Date(now).toISOString();
  }

  // 5. The next ad test.
  const started = await startNextAdTest(projectId, launch, standing, budget, now);
  return { did: started.did ?? watched, blocker: started.blocker };
}

function description(standing: ProductStanding): string {
  const parts = [`<p>${escapeHtml(standing.name)}.</p>`];
  if (standing.niches.length > 0) {
    parts.push(`<p>Made for ${escapeHtml(standing.niches.slice(0, 3).join(', '))}.</p>`);
  }
  if (standing.complaints.length > 0) {
    parts.push(`<p>Built to avoid the common problems: ${escapeHtml(standing.complaints.slice(0, 3).join('; '))}.</p>`);
  }
  parts.push('<p>Ships to you directly. Tracking is sent by email as soon as it ships.</p>');
  return parts.join('');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function list(
  projectId: string,
  launch: CommerceLaunch,
  standing: ProductStanding,
  budget: number,
): Promise<{ did: string | null; blocker: string | null }> {
  const adapter = usableCommerceAdapter(LISTING_NAMESPACE);
  if (!adapter) {
    await setProblem(launch, CONNECT_STORE);
    return { did: null, blocker: CONNECT_STORE };
  }
  const decision = await checkCommercialAuthority({ projectId, action: 'LIST_PRODUCT' });
  if (!decision.ok) {
    const blocker = `${grantSentence('LIST_PRODUCT')} (${decision.reason})`;
    await setProblem(launch, blocker);
    return { did: null, blocker };
  }
  const handle = listingHandle(launch.productId);
  const outcome = await runExternalEffect({
    adapter,
    namespace: LISTING_NAMESPACE,
    projectId,
    key: `commerce.list.${launch.id}`,
    businessId: handle,
    correlationId: `commerce:${launch.id}:list`,
    payload: {
      handle,
      title: standing.name,
      descriptionHtml: description(standing),
      priceCents: launch.priceCents,
      imageUrl: launch.supplierImageUrl,
    },
    principalType: 'SYSTEM',
    principalId: PRINCIPAL,
  });
  const productId = receiptOf(outcome);
  if (!productId) {
    const blocker =
      outcome.status === 'UNCERTAIN'
        ? `Whether the store created the listing is not known yet (${outcome.reason}); Brain asks the store next pass.`
        : 'The store refused the listing. Check the store’s product settings and the token’s write_products scope.';
    await setProblem(launch, blocker);
    return { did: null, blocker };
  }
  const found = await findListing(handle);
  const variantId = found && found !== 'UNKNOWN' ? found.variantId : null;
  await patchLaunch(
    launch.id,
    { storeProductId: productId, storeVariantId: variantId, storeHandle: handle, listedAt: new Date().toISOString(), problem: null },
    { storeProductId: null },
  );
  Object.assign(launch, { storeProductId: productId, storeVariantId: variantId, storeHandle: handle });
  await recordCashEvent({
    projectId,
    kind: 'COMMERCE_PRODUCT_LISTED',
    actorRef: ACTOR,
    summary:
      `${standing.name} is on sale at ${formatMoney(launch.priceCents, 'USD')}; one order leaves ` +
      `${formatMoney(budget, 'USD')} to win a customer.`,
    detail: { launchId: launch.id, storeProductId: productId },
  });
  return { did: `Listed at ${formatMoney(launch.priceCents, 'USD')}.`, blocker: null };
}

/* --------------------------------------------------------------------------
 * Ad tests
 * ------------------------------------------------------------------------ */

function storeUrl(launch: CommerceLaunch): string | null {
  const domain = secret(SHOPIFY_DOMAIN_ENV);
  return domain && launch.storeHandle ? `https://${domain}/products/${launch.storeHandle}` : null;
}

async function testsFor(projectId: string, launchId: string): Promise<CommerceAdTest[]> {
  return (await listAdTests(projectId)).filter((one) => one.launchId === launchId).sort((a, b) => a.round - b.round);
}

async function startNextAdTest(
  projectId: string,
  launch: CommerceLaunch,
  standing: ProductStanding,
  budget: number,
  now: number,
): Promise<{ did: string | null; blocker: string | null }> {
  const tests = await testsFor(projectId, launch.id);
  const last = tests[tests.length - 1] ?? null;
  if (last && (last.state === 'RUNNING' || last.state === 'UNCERTAIN')) return { did: null, blocker: null };
  if (last && last.state !== 'PENDING' && last.outcome !== 'WON') return { did: null, blocker: null };
  if (last && last.state !== 'PENDING' && tests.length >= MAX_AD_ROUNDS) {
    const blocker = `${MAX_AD_ROUNDS} winning tests ran back to back; a person decides whether to keep scaling.`;
    await setProblem(launch, blocker);
    return { did: null, blocker };
  }

  const adapter = usableCommerceAdapter(AD_TEST_NAMESPACE);
  if (!adapter) {
    await setProblem(launch, CONNECT_ADS);
    return { did: null, blocker: CONNECT_ADS };
  }
  const decision = await checkCommercialAuthority({ projectId, action: 'RUN_ADS' });
  if (!decision.ok || !decision.authority) {
    const blocker = `${grantSentence('RUN_ADS')} (${decision.reason})`;
    await setProblem(launch, blocker);
    return { did: null, blocker };
  }
  const daily = dailyBudgetCents();
  const link = storeUrl(launch);
  if (daily === null || !link) {
    await setProblem(launch, CONNECT_ADS);
    return { did: null, blocker: CONNECT_ADS };
  }

  const round = last && last.state !== 'PENDING' ? last.round + 1 : (last?.round ?? 1);
  const test = await ensureAdTest({ projectId, launchId: launch.id, round, dailyBudgetCents: daily, days: AD_TEST_DAYS });
  const total = test.dailyBudgetCents * test.days;

  if (!test.commitmentId) {
    const committed = await commit({
      authorityId: decision.authority.id,
      projectId,
      amountCents: total,
      currency: launch.currency ?? 'USD',
      purpose: `Ad test ${round} for ${standing.name}`,
      expectedResult: `Orders whose contribution (${formatMoney(budget, 'USD')} each) covers the spend`,
      stopCondition:
        `Paused once it has spent ${formatMoney(budget * STOP_SPEND_MULTIPLE, 'USD')} with no order, and ` +
        `ends after ${test.days} days`,
      idempotencyKey: `commerce:adtest:${test.id}`,
      createdBy: ACTOR,
    });
    if (!committed.ok || !committed.commitment) {
      const blocker = `The ad test (${formatMoney(total, 'USD')}) does not fit the standing authority: ${committed.reason}.`;
      await setProblem(launch, blocker);
      return { did: null, blocker };
    }
    await patchAdTest(test.id, { commitmentId: committed.commitment.id }, { commitmentId: null });
    test.commitmentId = committed.commitment.id;
  }

  const endsAt = new Date(Date.parse(test.createdAt) + test.days * 24 * 60 * 60 * 1000).toISOString();
  const outcome = await runExternalEffect({
    adapter,
    namespace: AD_TEST_NAMESPACE,
    projectId,
    key: `commerce.adtest.${test.id}`,
    businessId: test.id,
    correlationId: `commerce:${launch.id}:adtest:${round}`,
    payload: {
      tag: test.id,
      link,
      headline: standing.name,
      message:
        standing.niches.length > 0
          ? `${standing.name} for ${standing.niches[0]}. Shipped to your door.`
          : `${standing.name}. Shipped to your door.`,
      imageUrl: launch.supplierImageUrl,
      dailyBudgetCents: test.dailyBudgetCents,
      endTime: endsAt,
      countries: adCountries(),
    },
    principalType: 'SYSTEM',
    principalId: PRINCIPAL,
  });
  const campaignId = receiptOf(outcome);
  if (campaignId) {
    await patchAdTest(
      test.id,
      { campaignId, state: 'RUNNING', startedAt: new Date(now).toISOString(), endsAt },
      { state: 'PENDING' },
    );
    await setProblem(launch, null);
    await recordCashEvent({
      projectId,
      kind: 'COMMERCE_AD_TEST_STARTED',
      actorRef: ACTOR,
      summary: `Ad test ${round} for ${standing.name} started: ${formatMoney(test.dailyBudgetCents, 'USD')} a day for ${test.days} days.`,
      detail: { launchId: launch.id, adTestId: test.id, campaignId },
    });
    return { did: `Ad test ${round} started.`, blocker: null };
  }
  if (outcome.status === 'FAILED') {
    if (test.commitmentId) await releaseCommitment({ commitmentId: test.commitmentId, reason: 'the ad platform refused the test' });
    await patchAdTest(test.id, { state: 'STOPPED', stopReason: 'The ad platform refused the test.' }, { state: 'PENDING' });
    const blocker = 'The ad platform refused the test. Check the ad account, the Page and the token’s ads_management permission.';
    await setProblem(launch, blocker);
    return { did: null, blocker };
  }
  const blocker = `Whether the ad test started is not known yet; Brain asks the ad platform next pass.`;
  await setProblem(launch, blocker);
  return { did: null, blocker };
}

async function ordersDuring(projectId: string, launchId: string, from: string | null): Promise<CommerceOrder[]> {
  return (await listOrders(projectId)).filter((one) => one.launchId === launchId && (!from || one.paidAt >= from));
}

/**
 * Watch every running test: record what it spent, pause it once it has spent
 * its stop amount with nothing sold, and end it when its days are up.
 */
async function watchAdTests(
  projectId: string,
  launch: CommerceLaunch,
  standing: ProductStanding,
  now: number,
): Promise<string | null> {
  const running = (await testsFor(projectId, launch.id)).filter((one) => one.state === 'RUNNING' && one.campaignId);
  let did: string | null = null;
  for (const test of running) {
    const spend = await campaignSpendCents(test.campaignId!);
    if (spend === 'UNKNOWN') continue;
    const sold = await ordersDuring(projectId, launch.id, test.startedAt);
    const units = sold.reduce((sum, one) => sum + one.quantity, 0);
    const budget = realBudgetCents(launch, standing) ?? standing.economics.contributionBeforeAdsCents ?? 0;
    const earned = units * budget;

    if (units === 0 && spend >= budget * STOP_SPEND_MULTIPLE) {
      if (!(await pauseCampaign(test.campaignId!))) continue;
      await finishTest(projectId, launch, test, spend, 'STOPPED', 'LOST',
        `Spent ${formatMoney(spend, 'USD')} with no order, past the stop amount of ${formatMoney(budget * STOP_SPEND_MULTIPLE, 'USD')}.`);
      did = `Ad test ${test.round} paused: no order.`;
      continue;
    }
    if (test.endsAt && now >= Date.parse(test.endsAt)) {
      await pauseCampaign(test.campaignId!);
      const won = earned > spend;
      await finishTest(projectId, launch, test, spend, 'ENDED', won ? 'WON' : 'LOST',
        `${units} unit(s) sold for ${formatMoney(earned, 'USD')} of contribution against ${formatMoney(spend, 'USD')} spent.`);
      did = `Ad test ${test.round} ended: ${won ? 'it paid for itself' : 'it did not pay for itself'}.`;
      continue;
    }
    if (spend !== test.spendCents) await patchAdTest(test.id, { spendCents: spend }, { state: 'RUNNING' });
  }
  return did;
}

async function finishTest(
  projectId: string,
  launch: CommerceLaunch,
  test: CommerceAdTest,
  spend: number,
  state: 'STOPPED' | 'ENDED',
  outcome: 'WON' | 'LOST',
  reason: string,
): Promise<void> {
  const currency = launch.currency ?? 'USD';
  await serializeCash(projectId, currency, async () => {
    const moved = await patchAdTest(
      test.id,
      { state, outcome, spendCents: spend, stopReason: reason, settledAt: new Date().toISOString() },
      { state: 'RUNNING' },
    );
    if (!moved) return;
    if (spend > 0) {
      await recordMoney({
        projectId,
        commitmentId: test.commitmentId,
        kind: 'COST',
        amountCents: spend,
        currency,
        verifiedReference: test.campaignId,
        note: `Ad test ${test.round} spend`,
        recordedBy: ACTOR,
        idempotencyKey: `commerce:adtest-spend:${test.id}`,
      });
    }
    if (test.commitmentId) {
      if (spend > 0) await settleCommitment(test.commitmentId, spend);
      else await releaseCommitment({ commitmentId: test.commitmentId, reason: 'the ad test spent nothing' });
    }
  });
  await recordCashEvent({
    projectId,
    kind: 'COMMERCE_AD_TEST_FINISHED',
    actorRef: ACTOR,
    summary: `Ad test ${test.round}: ${outcome === 'WON' ? 'won' : 'lost'}. ${reason}`,
    detail: { launchId: launch.id, adTestId: test.id, spendCents: spend, outcome },
  });
  if (outcome === 'LOST') await stopLaunch(projectId, launch, `the ad test did not pay for itself: ${reason}`);
}

/* --------------------------------------------------------------------------
 * Orders: paid -> bought from the supplier -> shipped
 * ------------------------------------------------------------------------ */

async function advanceOrders(projectId: string, now: number): Promise<{ seen: number; placed: number; shipped: number }> {
  const out = { seen: 0, placed: 0, shipped: 0 };
  const launches = (await listLaunches(projectId)).filter((one) => one.storeVariantId);
  if (launches.length === 0 || !usableCommerceAdapter(LISTING_NAMESPACE)) return out;
  const byVariant = new Map(launches.map((one) => [one.storeVariantId!, one]));

  const paid = await paidUnfulfilledOrders(new Date(now - ORDER_LOOKBACK_MS).toISOString());
  if (paid !== 'UNKNOWN') {
    for (const order of paid) {
      const mine = order.lines.filter((line) => byVariant.has(line.variantId));
      if (mine.length === 0) continue;
      const launch = byVariant.get(mine[0]!.variantId)!;
      const quantity = mine
        .filter((line) => line.variantId === mine[0]!.variantId)
        .reduce((sum, line) => sum + line.quantity, 0);
      if (quantity < 1) continue;
      const recorded = await recordStoreOrder({
        projectId,
        launchId: launch.id,
        storeOrderId: order.id,
        storeOrderName: order.name,
        quantity,
        amountCents: order.totalCents,
        currency: order.currency,
        paidAt: order.createdAt || new Date(now).toISOString(),
      });
      if (!recorded.created) continue;
      out.seen += 1;
      await serializeCash(projectId, order.currency, async () => {
        await recordMoney({
          projectId,
          kind: 'CUSTOMER_PAYMENT',
          amountCents: order.totalCents,
          currency: order.currency,
          verifiedReference: order.id,
          note: `Store order ${order.name}`,
          recordedBy: ACTOR,
          idempotencyKey: `commerce:order:${order.id}`,
        });
      });
      await recordCashEvent({
        projectId,
        kind: 'COMMERCE_ORDER_PAID',
        actorRef: ACTOR,
        summary: `Store order ${order.name} paid ${formatMoney(order.totalCents, order.currency)}.`,
        detail: { orderId: recorded.order.id },
      });
    }
  }

  const launchById = new Map(launches.map((one) => [one.id, one]));
  for (const order of await listOrders(projectId)) {
    const launch = launchById.get(order.launchId);
    if (!launch) continue;
    try {
      if (order.state === 'PAID' && (await placeSupplierOrder(projectId, launch, order))) out.placed += 1;
      if ((order.state === 'ORDERED' || order.state === 'SHIPPED') && (await shipOrder(order))) out.shipped += 1;
    } catch (error) {
      await patchOrder(order.id, { problem: `This pass failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return out;
}

async function placeSupplierOrder(projectId: string, launch: CommerceLaunch, order: CommerceOrder): Promise<boolean> {
  const adapter = usableCommerceAdapter(SUPPLIER_ORDER_NAMESPACE);
  if (!adapter) {
    if (order.problem !== CONNECT_SUPPLIER) await patchOrder(order.id, { problem: CONNECT_SUPPLIER });
    return false;
  }
  const decision = await checkCommercialAuthority({ projectId, action: 'FULFIL_ORDER' });
  if (!decision.ok || !decision.authority) {
    await patchOrder(order.id, { problem: `${grantSentence('FULFIL_ORDER')} (${decision.reason})` });
    return false;
  }
  if (!launch.supplierVariantId || launch.supplierUnitCents === null || !launch.supplierLogistic) {
    await patchOrder(order.id, { state: 'NEEDS_PERSON', problem: 'The product has no supplier item matched.' }, { state: 'PAID' });
    return false;
  }
  const estimate = (launch.supplierUnitCents + (launch.supplierShippingCents ?? 0)) * order.quantity;
  const currency = launch.currency ?? 'USD';

  let commitmentId = order.commitmentId;
  if (!commitmentId) {
    const committed = await commit({
      authorityId: decision.authority.id,
      projectId,
      amountCents: estimate,
      currency,
      purpose: `Buy ${order.quantity} unit(s) for store order ${order.storeOrderName}`,
      expectedResult: 'The supplier ships the item to the customer who paid for it',
      stopCondition: 'One supplier order per store order',
      idempotencyKey: `commerce:supplier:${order.id}`,
      createdBy: ACTOR,
    });
    if (!committed.ok || !committed.commitment) {
      await patchOrder(order.id, { problem: `The supplier order (${formatMoney(estimate, currency)}) does not fit the standing authority: ${committed.reason}.` });
      return false;
    }
    commitmentId = committed.commitment.id;
    await patchOrder(order.id, { commitmentId }, { commitmentId: null });
  }

  const address = await orderShippingAddress(order.storeOrderId);
  if (address === 'UNKNOWN') {
    await patchOrder(order.id, { problem: 'The store did not answer with the shipping address; asked again next pass.' });
    return false;
  }
  if (!address) {
    await releaseCommitment({ commitmentId, reason: 'the order has no shipping address' });
    await patchOrder(order.id, { state: 'NEEDS_PERSON', problem: 'The store order has no shipping address.' }, { state: 'PAID' });
    return false;
  }

  const outcome = await runExternalEffect({
    adapter,
    namespace: SUPPLIER_ORDER_NAMESPACE,
    projectId,
    key: `commerce.supplier.${order.id}`,
    businessId: order.supplierOrderNumber,
    correlationId: `commerce:${launch.id}:order:${order.id}`,
    payload: {
      orderNumber: order.supplierOrderNumber,
      supplierVariantId: launch.supplierVariantId,
      quantity: order.quantity,
      logisticName: launch.supplierLogistic,
      shipping: address,
    },
    principalType: 'SYSTEM',
    principalId: PRINCIPAL,
  });
  const supplierOrderId = receiptOf(outcome);
  if (!supplierOrderId) {
    if (outcome.status === 'FAILED') {
      await releaseCommitment({ commitmentId, reason: 'the supplier refused the order' });
      await patchOrder(
        order.id,
        { state: 'NEEDS_PERSON', problem: 'The supplier refused the order — most often an empty CJ wallet. Fund it, then place this order by hand.' },
        { state: 'PAID' },
      );
    } else {
      await patchOrder(order.id, { problem: 'Whether the supplier took the order is not known yet; Brain asks the supplier next pass.' });
    }
    return false;
  }

  const read = await readSupplierOrder(order.supplierOrderNumber);
  const cost = read && read !== 'UNKNOWN' && read.amountCents ? read.amountCents : estimate;
  await serializeCash(projectId, currency, async () => {
    const moved = await patchOrder(
      order.id,
      { state: 'ORDERED', supplierOrderId, supplierCostCents: cost, problem: null },
      { state: 'PAID' },
    );
    if (!moved) return;
    await recordMoney({
      projectId,
      commitmentId,
      kind: 'COST',
      amountCents: cost,
      currency,
      verifiedReference: supplierOrderId,
      note: `Supplier order for store order ${order.storeOrderName}`,
      recordedBy: ACTOR,
      idempotencyKey: `commerce:supplier-cost:${order.id}`,
    });
    await settleCommitment(commitmentId!, cost);
  });
  await recordCashEvent({
    projectId,
    kind: 'COMMERCE_SUPPLIER_ORDERED',
    actorRef: ACTOR,
    summary: `Bought ${order.quantity} unit(s) for store order ${order.storeOrderName} for ${formatMoney(cost, currency)}.`,
    detail: { orderId: order.id, supplierOrderId },
  });
  order.state = 'ORDERED';
  return true;
}

async function shipOrder(order: CommerceOrder): Promise<boolean> {
  let tracking = order.trackingNumber;
  let url = order.trackingUrl;
  let carrier = order.carrier;
  if (!tracking) {
    const read = await readSupplierOrder(order.supplierOrderNumber);
    if (!read || read === 'UNKNOWN' || !read.trackingNumber) return false;
    tracking = read.trackingNumber;
    url = read.trackingUrl;
    carrier = read.carrier;
    await patchOrder(order.id, { state: 'SHIPPED', trackingNumber: tracking, trackingUrl: url, carrier }, { state: 'ORDERED' });
  }
  const done = await fulfilWithTracking({ orderId: order.storeOrderId, trackingNumber: tracking, trackingUrl: url, carrier });
  if (!done.ok) {
    await patchOrder(order.id, { problem: `Shipped; the store has not recorded it yet: ${done.reason}.` });
    return false;
  }
  return await patchOrder(order.id, { state: 'FULFILLED', problem: null }, { state: 'SHIPPED' });
}

export type { CommerceLaunch, CommerceAdTest, CommerceOrder };
