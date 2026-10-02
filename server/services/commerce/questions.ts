/**
 * The question each kernel round actually asks.
 *
 * ---------------------------------------------------------------------------
 * The channels bootstrap names places to look, never platforms
 * ---------------------------------------------------------------------------
 *
 * This is the whole of why there is no list of platforms in this codebase.
 * Asking which surfaces publish commerce terms is naming *sources* — the same
 * thing `proposedSources` has always done — and the channels arrive as claims
 * that cleared the evidence gate. A constant holding TikTok, Instagram and
 * YouTube would answer the question the kernel exists to ask, and on this
 * subject it would be wrong within months: the platforms change their
 * commission, their eligibility and their fulfilment obligations faster than
 * anything the industry kernel asks about.
 *
 * TikTok gets in because a person seeded it, which is the one origin Brain may
 * not write. That is the brief's "start with TikTok" as a row rather than as a
 * constant, and it is what lets the evidence name a stronger channel later
 * without anybody editing code.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed, and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per sprint for the same subject would relaunch work already done.
 * The sprint's objective is carried as *context* — it says which findings are
 * worth reporting — and it can widen nothing: the envelope, the evidence gate
 * and the source classes are all the compiler's.
 *
 * ---------------------------------------------------------------------------
 * Every question asks for the distinction the kernel turns on
 * ---------------------------------------------------------------------------
 *
 * Each one below says, in the worker's own assignment, that a view count is
 * `ATTENTION_EVIDENCE` and a purchase is `PURCHASE_EVIDENCE`, and that the two
 * must not be merged. §33 records why this belongs in the assignment rather
 * than only on the submission tool: by the time somebody is filling in a claim
 * they have already decided what they were looking for.
 */
import type { CommerceChannel, CommerceProposition } from '../../domain/types.ts';

export const CHANNELS_TITLE = 'Which surfaces people actually discover and buy things on';

export const CHANNELS_QUESTION =
  'Which online surfaces publish their own terms for selling physical goods discovered on ' +
  'them — naming each one as the platform names itself, and for each one citing the ' +
  "platform's own published commission or referral fee, its published payout schedule, what " +
  'it requires of a seller before anything may be listed, and what it obliges a seller to do ' +
  'about dispatch and tracking?';

export function channelsQuestion(objective: string, round: number): string {
  const parts = [
    CHANNELS_QUESTION,
    `This is the starting map for a short cash sprint whose goal is: ${objective}`,
    'Declare every surface you establish with commerce_finding set to CHANNEL and ' +
      "commerce_subject set to that platform's own name for itself. Declare each fee, payout " +
      'delay, eligibility rule and fulfilment obligation as its own claim with the matching ' +
      "commerce_finding and commerce_subject set to that same platform name, exactly as you " +
      'wrote it on the CHANNEL claim — that name is the only thing that says which platform a ' +
      'commission belongs to, and a figure Brain cannot attach to a platform is refused rather ' +
      'than attached to whichever one is nearest. A platform described in prose and not ' +
      'declared does not reach the map.',
  ];
  if (round > 1) {
    parts.push(
      `This is asking again — report what the platforms have changed about their commission, ` +
        'eligibility, payout or fulfilment terms since, and say so plainly where nothing has.',
    );
  }
  return parts.join(' ');
}

export function productsTitle(channel: CommerceChannel): string {
  return `What is actually being bought on ${channel.name}`;
}

/**
 * What is selling on one channel, with the distinction stated twice.
 *
 * Once in the question, because that is what a worker searches against, and
 * once in the declaration instruction, because that is what decides which
 * column it lands in. Saying it once in either place alone is how a view count
 * ends up filed as demand.
 */
export function productsQuestion(input: {
  channel: CommerceChannel;
  objective: string;
  round: number;
  knownSoFar: number;
}): string {
  const parts = [
    `Which specific physical products are being bought on ${input.channel.name} right now — ` +
      'not merely watched? For each one, name the product precisely, say who is buying it, ' +
      'and cite published evidence that money changed hands: units sold, order counts, a ' +
      'sold-out notice, a published revenue figure, a seller stating their own volume. ' +
      'Separately, where a product has large attention and no evidence of purchase, report ' +
      'that too — it is a finding about this channel rather than a gap in the answer.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare each product with commerce_finding set to PRODUCT_CANDIDATE, commerce_subject ` +
      `set to the product and commerce_qualifier set to ${input.channel.name}. Declare buying ` +
      'evidence as PURCHASE_EVIDENCE and view, like, follow or watch-time figures as ' +
      'ATTENTION_EVIDENCE. Do not file attention as purchase: Brain reads the second as ' +
      'demand and the first as its absence, and merging them is the one mistake that makes ' +
      'this whole exercise produce a confident wrong answer.',
  ];
  if (input.round > 1 || input.knownSoFar > 0) {
    parts.push(
      `Brain already holds ${input.knownSoFar} product` +
        (input.knownSoFar === 1 ? '' : 's') +
        ' for this channel. Report what those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function supplyTitle(proposition: CommerceProposition): string {
  return `Who would actually supply ${clip(proposition.product, 60)}`;
}

export function supplyQuestion(input: {
  proposition: CommerceProposition;
  channel: CommerceChannel | null;
  objective: string;
}): string {
  const parts = [
    `Who actually supplies "${clip(input.proposition.product, 200)}" to a seller who holds no ` +
      'stock — naming specific suppliers that publish their terms, and for each one the ' +
      'minimum order quantity, the unit cost at that quantity, what shipping to an end buyer ' +
      'costs, the published lead time to the buyer, whether tracking is provided, what the ' +
      'returns terms are and who pays for a return, and any published measure of how ' +
      'reliably they deliver?',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
  ];
  if (input.channel) {
    parts.push(
      `It would be sold on ${input.channel.name}, so a supplier that cannot meet that ` +
        "channel's published dispatch or tracking obligation is a finding rather than a " +
        'candidate — report it as one.',
    );
  }
  parts.push(
    'Declare each supplier with commerce_finding set to SUPPLIER_AVAILABLE and the supplier ' +
      'as commerce_subject, and each figure as its own claim: MINIMUM_ORDER, ' +
      'LANDED_UNIT_COST, SHIPPING_COST, DELIVERY_TIME, RETURN_TERMS, SUPPLIER_RELIABILITY. ' +
      'Where a supplier publishes no figure for one of these, say so — an unknown is recorded ' +
      'as unknown and withholds the margin, which is the correct outcome, and a number you ' +
      'estimated would be worse than none.',
  );
  return parts.join(' ');
}

export function economicsTitle(proposition: CommerceProposition): string {
  return `Whether the money works on ${clip(proposition.product, 60)}`;
}

/**
 * The money, and the reason it is asked as one question rather than thirteen.
 *
 * Every line below is a figure a source published, and the fragment that
 * answers them all is judged against one scope. Asking them separately would
 * produce thirteen fragments whose independent-source minimums are each met
 * and whose answers are about thirteen slightly different products — which is
 * the scope defect §25 records, arriving through decomposition.
 */
export function economicsQuestion(input: {
  proposition: CommerceProposition;
  channel: CommerceChannel | null;
  objective: string;
  missing: readonly string[];
}): string {
  const where = input.channel ? ` sold on ${input.channel.name}` : '';
  const parts = [
    `What does "${clip(input.proposition.product, 200)}"${where} actually cost and actually ` +
      'sell for — the price comparable sellers publish, the landed unit cost at a realistic ' +
      "order quantity, shipping to the buyer, the channel's own commission, the payment " +
      'processing rate, what creators are paid, what producing the content costs, the ' +
      'published cost of acquiring a buyer on this channel, and the rates at which orders ' +
      'are returned, refunded and charged back?',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
  ];
  if (input.missing.length > 0) {
    parts.push(
      `Brain is specifically missing ${input.missing.join(', ')}; everything else it already ` +
        'holds, so report what is new rather than restating it.',
    );
  }
  parts.push(
    'Declare each figure as its own claim with the matching commerce_finding, money in minor ' +
      'units in commerce_amount_minor and every rate as parts per million in ' +
      'commerce_rate_ppm. Read the platform fees from the platform itself rather than from a ' +
      'summary of them. Where nothing published settles a figure, say so rather than ' +
      'estimating it: Brain withholds the whole contribution when one input is unknown, and ' +
      'that is a better outcome than a margin that is wrong in the encouraging direction.',
  );
  return parts.join(' ');
}

export function eligibilityTitle(channel: CommerceChannel): string {
  return `What ${channel.name} requires before anything may be sold`;
}

export function eligibilityQuestion(input: {
  channel: CommerceChannel;
  objective: string;
}): string {
  return [
    `What does ${input.channel.name} itself publish as the requirements for selling physical ` +
      'goods on it — who may register, in which countries, what business entity, tax ' +
      'registration, deposit or category approval is required, which product categories are ' +
      'prohibited outright, what it obliges a seller to do about dispatch windows and ' +
      'tracking, and what its current published commission and payout schedule are?',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Read the platform\'s own published terms, help centre and seller documentation rather ' +
      'than an article about them, and date every claim. Declare requirements with ' +
      'commerce_finding set to PLATFORM_ELIGIBILITY, dispatch and tracking obligations as ' +
      'FULFILMENT_REQUIREMENT, prohibited categories as PROHIBITED_PRODUCT, and the fee and ' +
      'payout figures as PLATFORM_FEE and PAYOUT_DELAY.',
  ].join(' ');
}

function clip(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}
