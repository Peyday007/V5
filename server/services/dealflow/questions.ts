/**
 * The question each round actually asks.
 *
 * ---------------------------------------------------------------------------
 * Brain supplies the vocabulary, which is how the classes converge
 * ---------------------------------------------------------------------------
 *
 * `equipmentKey` is deliberately the weakest matcher that could work — case
 * and whitespace, nothing else — so two workers writing "fuel tankers" and
 * "fuel tanker semi-trailers" produce two classes that pair with nothing. The
 * fix is not a cleverer matcher (§37: one that tried harder would produce
 * confident wrong answers) but a question that carries the class **verbatim
 * from Brain's own rows** and asks for it back unchanged. That is the same
 * trick `scanQuestion` uses with the subject path, and it is a convergence
 * mechanism somebody can read rather than a similarity threshold nobody can
 * audit.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per sprint for the same subject would relaunch work already done.
 * The sprint's objective is carried as *context* — it says which findings are
 * worth reporting — and it widens nothing: the envelope, the evidence gate and
 * the source classes are all the compiler's.
 *
 * ---------------------------------------------------------------------------
 * The seed is an example, not the taxonomy
 * ---------------------------------------------------------------------------
 *
 * The bootstrap question names tankers and trailers because that is the
 * pattern the operator actually described, and then asks the worker to report
 * *the shape of the pattern* — which classes of industrial equipment are
 * bought across borders this way, by whom, from where. A constant holding a
 * list of equipment would answer the question this kernel exists to ask, and
 * would be wrong about every class the trade has taken up since somebody typed
 * it. So there is no such list anywhere in this kernel.
 */
import { COMPLIANCE_LAYERS, COST_COMPONENTS } from '../../domain/dealflow.ts';
import type { ComplianceLayer, DealParty } from '../../domain/types.ts';

export const SEED_TITLE = 'Which industrial equipment actually moves across borders this way';

/**
 * The one question with no class attached, because its whole purpose is to
 * produce the first ones.
 */
export const SEED_QUESTION =
  'Which specific classes of heavy industrial and commercial equipment are routinely bought ' +
  'across borders by industrial buyers — logistics, mining, construction, energy, agriculture ' +
  'and infrastructure operators — from manufacturers in another country, where the buyer is ' +
  'not simply walking into a local dealership? For each class, name the class as the trade ' +
  'itself names it, name at least one organisation that has actually published a need for it ' +
  'and at least one manufacturer that publishes the capability to build it for export, and ' +
  'say which country each is in. Tank trailers and road tankers are one known example of this ' +
  'pattern and are not the boundary of it: report the classes the evidence actually shows, ' +
  'including ones nobody would guess from that example.';

export function seedQuestion(objective: string, round: number): string {
  const parts = [
    SEED_QUESTION,
    `This is the starting map for a short cash sprint whose goal is: ${objective}`,
    'Declare every organisation you establish on its own claim: deal_finding set to BUYER_NEED ' +
      'or SUPPLIER_CAPABILITY, deal_subject set to that organisation’s own name, ' +
      'deal_equipment set to the class of equipment, and deal_jurisdiction set to the country ' +
      'it is in. An organisation described in prose and not declared does not reach the map.',
  ];
  if (round > 1) {
    parts.push(
      `This is asking ${round - 1 === 1 ? 'again' : `round ${round}`} — report classes and ` +
        'parties the earlier rounds did not cover rather than restating them, and say so ' +
        'plainly where there is nothing new.',
    );
  }
  return parts.join(' ');
}

export function demandTitle(equipmentClass: string): string {
  return `Who needs ${equipmentClass}`;
}

export function demandQuestion(input: {
  equipmentClass: string;
  objective: string;
  round: number;
  knownBuyers: readonly string[];
}): string {
  const parts = [
    `Which specific organisations have published evidence that they need ${input.equipmentClass} ` +
      '— a fleet expansion, a new mine or plant commissioning, an infrastructure or haulage ' +
      'contract awarded, a fleet ageing out, a regulatory change forcing replacement, a ' +
      'published tender, or a procurement notice? For each one: the organisation, the country ' +
      'it operates in, what triggered the need, roughly how many units, and how urgent the ' +
      'source says it is.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare each organisation with deal_finding set to BUYER_NEED, deal_subject set to its ` +
      `own name, deal_equipment set to exactly "${input.equipmentClass}" — copy that string ` +
      'verbatim, because a different wording is a different class to Brain and will pair with ' +
      'nothing — and deal_jurisdiction set to its country.',
  ];
  if (input.knownBuyers.length > 0) {
    parts.push(
      `Brain already holds ${input.knownBuyers.length} buyer` +
        (input.knownBuyers.length === 1 ? '' : 's') +
        ` for this class (${input.knownBuyers.slice(0, 5).join('; ')}` +
        (input.knownBuyers.length > 5 ? ', and others' : '') +
        '). Report organisations those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function supplyTitle(equipmentClass: string): string {
  return `Who builds ${equipmentClass} for export`;
}

export function supplyQuestion(input: {
  equipmentClass: string;
  objective: string;
  round: number;
  knownSuppliers: readonly string[];
}): string {
  const parts = [
    `Which manufacturers publish the capability to build ${input.equipmentClass} for export — ` +
      'naming, for each: the company, the country, the specific models or configurations, the ' +
      'certifications they publish, the export markets they say they already serve, their ' +
      'stated minimum order and lead time, and whether they publish a willingness to ' +
      'customise? Prefer manufacturers with real engineering evidence and thin international ' +
      'sales coverage over ones already well distributed, and say which is which.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    `Declare each manufacturer with deal_finding set to SUPPLIER_CAPABILITY, deal_subject set ` +
      `to its own name, deal_equipment set to exactly "${input.equipmentClass}" — copy that ` +
      'string verbatim — and deal_jurisdiction set to its country. Where a source publishes a ' +
      'price, declare that separately with deal_finding COST_COMPONENT, deal_value ' +
      'FACTORY_PRICE, the figure in deal_amount_cents, and what the figure is per.',
  ];
  if (input.knownSuppliers.length > 0) {
    parts.push(
      `Brain already holds ${input.knownSuppliers.length} supplier` +
        (input.knownSuppliers.length === 1 ? '' : 's') +
        ` for this class (${input.knownSuppliers.slice(0, 5).join('; ')}` +
        (input.knownSuppliers.length > 5 ? ', and others' : '') +
        '). Report manufacturers those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function complianceTitle(equipmentClass: string, destination: string): string {
  return `What ${destination} demands of ${equipmentClass}`;
}

const LAYER_ASK: Readonly<Record<ComplianceLayer, string>> = Object.freeze({
  FACTORY_CERTIFICATION:
    'what the manufacturing plant itself must hold — quality systems, welding procedure and ' +
    'welder qualifications, materials and pressure-vessel approvals',
  PRODUCT_CERTIFICATION:
    'what this product must hold — type approval, tank testing and periodic inspection, ' +
    'dangerous-goods approval where the cargo needs it, marking and plating',
  MARKET_APPROVAL:
    'what the destination state demands before it may be registered and used — axle loads and ' +
    'weights, dimensions, braking, lighting, coupling, roadworthiness inspection, and any ' +
    'restriction on importing used or non-locally-approved units',
  BUYER_ACCEPTANCE:
    'what large industrial and mining buyers in that market demand beyond the law — their own ' +
    'safety specifications, rollover protection, grounding, emergency shutoff, vapour systems, ' +
    'valve and coupling standards, vendor pre-qualification',
  IMPORT_BARRIER:
    'duties and taxes on import, quotas, outright bans, age limits on the goods, and ' +
    'mandatory pre-shipment or conformity inspection',
});

export function complianceQuestion(input: {
  equipmentClass: string;
  destination: string;
  objective: string;
  layers: readonly ComplianceLayer[];
  round: number;
}): string {
  const asks = input.layers.map((layer) => `${layer}: ${LAYER_ASK[layer]}`);
  return [
    `For ${input.equipmentClass} imported into ${input.destination} and operated there ` +
      `commercially, establish ${asks.join('; ')}. For each requirement, name the instrument ` +
      'or authority that imposes it and when it took effect.',
    'These are separate questions and must not be answered as one. A factory holding a ' +
      'quality certificate does not make the product approved; a product approval does not ' +
      'make the state register it; and neither means the buyer will accept it. Answer each ' +
      'layer on its own evidence.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare every requirement you establish with deal_finding set to COMPLIANCE_REQUIREMENT, ' +
      'deal_value set to the layer it belongs to, deal_subject set to the requirement’s ' +
      `own name, deal_equipment set to exactly "${input.equipmentClass}", and ` +
      `deal_jurisdiction set to "${input.destination}".`,
    'If you search a layer properly and find that it demands nothing here, that is a real ' +
      'and valuable finding — declare it with deal_finding set to REQUIREMENT_ABSENCE, the ' +
      'same layer in deal_value, and the places you searched listed in ' +
      'searched_repositories. Brain treats a layer with no answer as unresearched rather ' +
      'than as clear, so an unreported empty search leaves the deal blocked.',
  ].join(' ');
}

export function landedCostTitle(equipmentClass: string, destination: string): string {
  return `What it costs to land ${equipmentClass} in ${destination}`;
}

export function landedCostQuestion(input: {
  equipmentClass: string;
  destination: string;
  origins: readonly string[];
  objective: string;
  missing: readonly string[];
  round: number;
}): string {
  const lane =
    input.origins.length > 0
      ? `from ${input.origins.slice(0, 3).join(' or ')}`
      : 'from the manufacturing countries that actually export it';
  const parts = [
    `What does it cost to land one ${input.equipmentClass} ${lane} in ${input.destination}, ` +
      'line by line: the ex-works price, inland transport to the export port, terminal and ' +
      'export handling, the ocean freight rate on that lane and what mode it needs, marine ' +
      'insurance, the import duty rate for the tariff heading, VAT or equivalent, customs ' +
      'clearance and port charges, and inland delivery to the buyer? Separately, what do ' +
      `buyers in ${input.destination} pay for this equipment today from their current source?`,
    'State what each figure is per — one unit, one forty-foot container, one shipment — and ' +
      'which currency it is in, as published. Do not reconcile figures that are on different ' +
      'bases or in different currencies into a single number: report them as published. Brain ' +
      'withholds the landed cost when they disagree and says why, which is the correct outcome; ' +
      'a harmonised number would be one nobody can check.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare every figure with deal_finding set to COST_COMPONENT, deal_value set to the line ' +
      `it is (${COST_COMPONENTS.join(', ')}), the amount in deal_amount_cents in minor units, ` +
      'deal_currency set to the published currency\u2019s three-letter code, deal_subject set ' +
      'to what the figure is *per*, ' +
      `deal_equipment set to exactly "${input.equipmentClass}", and deal_jurisdiction set to ` +
      'the market it applies to.',
  ];
  if (input.missing.length > 0) {
    parts.push(
      `Brain is specifically missing ${input.missing.join(', ')} for this lane, and the landed ` +
        'cost cannot be stated at all until those exist. Prioritise them.',
    );
  }
  return parts.join(' ');
}

export function structureTitle(equipmentClass: string): string {
  return `How this trade pays an intermediary in ${equipmentClass}`;
}

export function structureQuestion(input: {
  equipmentClass: string;
  objective: string;
  round: number;
}): string {
  return [
    `How does the ${input.equipmentClass} export trade actually compensate an intermediary who ` +
      'is neither the manufacturer nor the buyer? Look for published or documented evidence of ' +
      'real arrangements: manufacturers publishing agent or distributor terms, sourcing and ' +
      'procurement agencies publishing fee structures, buying agents publishing commission ' +
      'rates, inspection and quality-assurance firms publishing what they charge, freight ' +
      'coordinators and trading houses describing how they are paid, and whether buyers in ' +
      'these markets engage representatives on their own side.',
    'For each one, say what the arrangement actually is, who pays, when they pay, and what the ' +
      'source says it is worth — in the source’s own words, including ranges. Do not ' +
      'convert a range into a single rate.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare each arrangement you find evidence of with deal_finding set to ' +
      'COMMERCIAL_PRECEDENT, deal_value set to the structure it is, deal_subject set to what ' +
      'the source says it pays in the source\u2019s own words, and deal_equipment set to ' +
      `exactly "${input.equipmentClass}".`,
  ].join(' ');
}

export function decisionMakerTitle(party: DealParty): string {
  return `Who decides a purchase at ${party.name}`;
}

export function decisionMakerQuestion(input: {
  party: DealParty;
  objective: string;
  round: number;
}): string {
  return [
    `At ${input.party.name}${input.party.country ? ` in ${input.party.country}` : ''}, who ` +
      `actually decides a purchase of ${input.party.equipmentClass}? Establish the procurement ` +
      'function, the roles that sign off capital equipment at this size, whether purchases go ' +
      'through a published tender process, what the published qualification requirements for a ' +
      'vendor are, and any named individual the organisation itself publishes in that role.',
    'Use what the organisation and the public record publish. Do not infer a name from a ' +
      'job title elsewhere, and do not report a person from a directory that does not say they ' +
      'hold that role now.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare what you establish with deal_finding set to DECISION_MAKER and deal_subject set ' +
      `to "${input.party.name}". Leave deal_equipment out — this finding is about the ` +
      'organisation rather than about a class of equipment.',
  ].join(' ');
}

export function adjacentTitle(party: DealParty): string {
  return `What else ${party.name} procures`;
}

export function adjacentQuestion(input: {
  party: DealParty;
  objective: string;
  round: number;
}): string {
  return [
    `${input.party.name} has been transacted with for ${input.party.equipmentClass}. What else ` +
      'does an operation of this kind repeatedly procure from outside its own country — the ' +
      'equipment upstream and downstream of what they already bought, the consumables and ' +
      'spare parts that follow it, the workshop, storage, power and material-handling ' +
      'infrastructure around it? Establish what this organisation specifically has published a ' +
      'need for, rather than what an organisation like it might plausibly want.',
    'A plausible adjacency is not a finding. Only report a class where a source shows this ' +
      'organisation, or a directly comparable operation in the same market, actually procuring ' +
      'it.',
    `This is for a short cash sprint whose goal is: ${input.objective}`,
    'Declare each one with deal_finding set to BUYER_NEED, deal_subject set to the ' +
      'organisation’s name, deal_equipment set to the new class of equipment, and ' +
      'deal_jurisdiction set to its country.',
  ].join(' ');
}

/** Every compliance layer, for a question that asks about all of them. */
export const ALL_LAYERS: readonly ComplianceLayer[] = COMPLIANCE_LAYERS;
