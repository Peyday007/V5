/**
 * The question each commerce round actually asks (§73).
 *
 * Brain supplies the vocabulary, which is how products converge: every
 * follow-up names the product **verbatim from Brain's own rows** and asks for
 * it back unchanged, because `productKey` is case and whitespace and nothing
 * more. The discovery question names example sources and says they are
 * examples rather than the boundary — there is no list of products or
 * platforms anywhere in this kernel.
 *
 * Every sentence here is about what to find, never about what Brain will do.
 * The envelopes' forbidden actions are matched against these words, and a
 * test runs every question through the real envelope screen.
 */
import { LOAD_BEARING_COSTS } from './economics.ts';
import type { ProductStanding } from './standing.ts';

export const DEFAULT_MARKET = 'the United States';

export const DISCOVER_TITLE = 'Which products are visibly selling right now';

export const DISCOVER_QUESTION =
  'Which specific consumer products are visibly selling well right now and could be shipped ' +
  'to the customer direct from a supplier, with no inventory held? Look at published ' +
  'best-seller and fastest-rising lists, marketplace product pages that state how many have ' +
  'sold, product analytics reports of top sellers, adverts in public ad libraries that have ' +
  'been running for several weeks, search-trend pages, and best-seller pages of large online ' +
  'stores — TikTok Shop, Amazon Best Sellers and Movers & Shakers, AliExpress, Etsy, the Meta ' +
  'Ad Library and Google Trends are known examples of this pattern and are not the boundary of ' +
  'it. Report generic products somebody could source from more than one supplier: leave out ' +
  'brand-name products, anything that carries another company’s trademark, and anything that ' +
  'needs a licence to sell. Prefer products that are light, hard to break, priced roughly 20 to ' +
  '80 dollars, and that solve a visible problem or suit a clear audience. Name each product ' +
  'specifically, as a shopper would search for it, rather than as a category.';

export function discoverQuestion(input: {
  objective: string;
  round: number;
  known: readonly string[];
}): string {
  const parts = [
    DISCOVER_QUESTION,
    `This is for a cash sprint whose goal is: ${input.objective}`,
    'Declare every demand signal on its own claim: commerce_finding PRODUCT_DEMAND, ' +
      'commerce_product the product’s specific name, commerce_subject the platform, list or ' +
      'store that shows it, commerce_value the kind of signal, and the date the source published ' +
      'or last observed it as the source date — an undated signal cannot be told apart from an ' +
      'old one and is not filed. Where the source shows a sub-audience or use case for it, ' +
      'declare that separately as NICHE_SIGNAL.',
  ];
  if (input.known.length > 0) {
    parts.push(
      `Brain already holds ${input.known.length} product(s) (` +
        input.known.slice(0, 12).join('; ') +
        (input.known.length > 12 ? '; and others' : '') +
        '). Report products those do not cover rather than restating them, except to add a ' +
        'newer, independent demand signal for one of them under exactly that name.',
    );
  }
  if (input.round > 1) {
    parts.push('This question has been asked before; report what is new and say so plainly where nothing is.');
  }
  return parts.join(' ');
}

export function sourceTitle(product: string): string {
  return `Who would ship ${product}, and at what unit cost`;
}

export function sourceQuestion(input: { product: string; objective: string }): string {
  return [
    `Which suppliers have a published listing for exactly "${input.product}" that would ship one unit ` +
      `direct to a customer in ${DEFAULT_MARKET}? Look at wholesale and dropship catalogues — ` +
      'AliExpress, CJ Dropshipping, Alibaba, Spocket, Zendrop and similar are examples, not the ' +
      'boundary. For each supplier: its name, the published unit cost and currency, the ' +
      `published cost of shipping one unit to ${DEFAULT_MARKET}, and the published delivery time ` +
      'in days.',
    `This is for a cash sprint whose goal is: ${input.objective}`,
    `Declare each supplier as SUPPLIER_OFFER with commerce_product set to exactly ` +
      `"${input.product}", commerce_subject the supplier’s name, commerce_amount_cents the unit ` +
      'cost, commerce_currency as published, and commerce_days the delivery days where stated. ' +
      'Declare its shipping charge separately as COST_LINE SHIPPING_TO_CUSTOMER (a published ' +
      'free-shipping offer is declared as 0). Report figures as published; never convert a ' +
      'currency or turn a range into one number.',
  ].join(' ');
}

export function priceTitle(product: string): string {
  return `What ${product} sells for, and who already sells it`;
}

export function priceQuestion(input: { product: string; objective: string }): string {
  return [
    `What do named sellers charge shoppers in ${DEFAULT_MARKET} for "${input.product}" — on ` +
      'large marketplaces, independent online stores and social shops — and what do buyers ' +
      'complain about in its reviews?',
    `This is for a cash sprint whose goal is: ${input.objective}`,
    `Declare each price as RETAIL_PRICE (or COMPETITOR for a seller already selling it) with ` +
      `commerce_product set to exactly "${input.product}", commerce_subject the seller, ` +
      'commerce_amount_cents and commerce_currency as published. Declare each recurring ' +
      'complaint theme as CUSTOMER_COMPLAINT with commerce_subject naming the theme in a few words.',
  ].join(' ');
}

export function costsTitle(product: string): string {
  return `What one order of ${product} costs to sell`;
}

export function costsQuestion(input: {
  product: string;
  objective: string;
  standing: ProductStanding;
}): string {
  const held = new Set(input.standing.economics.lines.map((one) => one.component));
  const missing = LOAD_BEARING_COSTS.filter((one) => !held.has(one));
  const needsDays = input.standing.economics.supplier?.days === null;
  return [
    `What does it cost to sell one order of "${input.product}" to a customer in ` +
      `${DEFAULT_MARKET}, line by line, from published sources: the payment processor’s ` +
      'published fee for an online card payment, the store platform’s published transaction ' +
      'fee, the published cost of shipping one unit, published advertising cost per order for ' +
      'products of this kind, published return rates, and any import duty? And what published ' +
      'rules bear on selling or advertising it — advertising policies of the large ad platforms, ' +
      'prohibited-item lists, safety certifications, and trademark or patent positions?',
    missing.length > 0
      ? `Brain holds no published figure yet for ${missing.join(' and ')}; those come first.`
      : '',
    needsDays
      ? `No delivery time is published for the chosen supplier (${input.standing.economics.supplier?.subject}); ` +
        'a SUPPLIER_OFFER that states one is wanted.'
      : '',
    `This is for a cash sprint whose goal is: ${input.objective}`,
    `Declare each line as COST_LINE with commerce_product set to exactly "${input.product}", ` +
      'commerce_value naming the line, commerce_subject naming who publishes it, and either ' +
      'commerce_amount_cents with commerce_currency, or commerce_rate_bps for a percentage ' +
      '(2.9% is 290) — never both. Declare each rule as RESTRICTION with commerce_value naming ' +
      'its kind.',
  ]
    .filter(Boolean)
    .join(' ');
}

export function nicheTitle(product: string): string {
  return `Which audience ${product} could be sold to better`;
}

export function nicheQuestion(input: { product: string; objective: string }): string {
  return [
    `Which specific sub-audiences, occasions, professions, hobbies or communities are publicly ` +
      `asking for or talking about "${input.product}", and what do they say existing versions ` +
      'get wrong? Look at forums, community threads, reviews and question sites. The aim is an ' +
      'angle other sellers are not using: a narrower audience, a bundle, or a fix for a common ' +
      'complaint.',
    `This is for a cash sprint whose goal is: ${input.objective}`,
    `Declare each audience as NICHE_SIGNAL and each recurring complaint as CUSTOMER_COMPLAINT, ` +
      `with commerce_product set to exactly "${input.product}" and commerce_subject naming the ` +
      'audience or the complaint in a few words.',
  ].join(' ');
}
