/**
 * The question each programme round actually asks.
 *
 * ---------------------------------------------------------------------------
 * A category is a path, never a leaf
 * ---------------------------------------------------------------------------
 *
 * "Pumps" is not a researchable subject; "powered cleaning equipment →
 * commercial pressure washers → pumps" is. A question composed from a
 * category's own name alone would be the scope defect §25 records arriving
 * through a foreign key instead of through prose — a worker would research a
 * real subject correctly and answer a different question. So every question
 * below carries the whole path from the root.
 *
 * ---------------------------------------------------------------------------
 * The template is fixed, and the subject is what varies
 * ---------------------------------------------------------------------------
 *
 * `launch()` treats one specification as researchable once, so a question that
 * differed per programme for the same subject would relaunch work already done.
 * The programme's objective is carried as *context* — it says which findings
 * are worth reporting — and it can widen nothing: the envelope, the evidence
 * gate and the source classes are all the compiler's.
 *
 * ---------------------------------------------------------------------------
 * The opening question names sources, never categories
 * ---------------------------------------------------------------------------
 *
 * This is the whole of why there is no list of machine categories in this
 * codebase. Naming trade associations, statistical classifications, regulators
 * and industry press is naming *places to look* — the same thing
 * `proposedSources` already does — and the categories arrive as claims that
 * cleared the evidence gate. A constant holding the brief's six levels would
 * encode the example sequence the brief explicitly refuses to mandate.
 */

export const BOOTSTRAP_TITLE = 'Which classes of powered machine the sources actually recognise';

export const BOOTSTRAP_QUESTION =
  'Which classes of powered machinery, vehicle and aircraft do the authoritative sources ' +
  'actually recognise as categories in their own right — industry classification systems, ' +
  'trade associations that publish shipment or registration statistics, equipment regulators, ' +
  'and the trade press that reports each one — naming each class as the source itself names ' +
  'it, saying which source recognises it, and reporting where two sources divide the same ' +
  'kind of machine differently rather than reconciling them?';

export function bootstrapQuestion(objective: string, round: number): string {
  const parts = [
    BOOTSTRAP_QUESTION,
    `This is the starting ladder for a manufacturing programme whose objective is: ${objective}`,
    'Declare every class you establish with capability_finding set to PRODUCT_CATEGORY and ' +
      "capability_subject set to that class's own name. A category described in prose and not " +
      'declared does not reach the ladder.',
  ];
  if (round > 1) {
    parts.push(
      `This is asking ${round - 1 === 1 ? 'again' : `round ${round}`} — report what the sources ` +
        'have added, split or retired since, and say so plainly where nothing has changed.',
    );
  }
  return parts.join(' ');
}

export function mapTitle(path: readonly string[]): string {
  return `What sits inside and beside ${path[path.length - 1] ?? 'this category'}`;
}

export function mapQuestion(input: {
  path: readonly string[];
  objective: string;
  round: number;
  childrenSoFar: number;
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `How is ${subject} actually divided — which narrower or more specific classes of machine ` +
      'do the sources recognise inside it, and which different classes do they name as ' +
      'connected to it, whether because the same producers build both, because they are sold ' +
      'through the same channel, or because they share major components?',
    `This is for a manufacturing programme whose objective is: ${input.objective}`,
    'Declare every class you establish on its claim: capability_finding set to ' +
      "PRODUCT_CATEGORY or ADJACENT_CATEGORY, and capability_subject set to that class's own " +
      'name.',
  ];
  if (input.round > 1 || input.childrenSoFar > 0) {
    parts.push(
      `Brain already holds ${input.childrenSoFar} class` +
        (input.childrenSoFar === 1 ? '' : 'es') +
        ' underneath this one. Report what those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function demandTitle(path: readonly string[]): string {
  return `Who is buying ${path[path.length - 1] ?? 'this'}, and how it reaches them`;
}

/**
 * The question the whole kernel is ordered around.
 *
 * Three things in one round because they are one decision. The brief's core
 * principle is that demand and distribution together are what pull
 * manufacturing forward, and a category with buyers and no route to them is as
 * unenterable as one with neither. Where incumbents fall short rides with them
 * because it is the same reading of the same market and separating it would
 * buy a second search for one more question.
 *
 * What it refuses is stated rather than hoped for: an impression that the
 * market is large is not a demand signal, and the finding has nowhere to go
 * unless a source published an observation with a date on it.
 */
export function demandQuestion(input: {
  path: readonly string[];
  objective: string;
  round: number;
  foundSoFar: number;
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `Who is actually buying ${subject}, how does product reach them, and where does what is on ` +
      'the market today fall short? Establish it from published observations — unit shipments, ' +
      'registrations, fleet purchases, tenders and contract awards, replacement cycles, prices ' +
      'actually realised, order backlogs and lead times, installed base — and establish the ' +
      'routes by which machines of this kind reach whoever pays for them. Then establish, from ' +
      'recalls, safety actions, service coverage, parts availability, documented failure modes ' +
      'and stated unmet requirements, where existing producers are weak.',
    `This is for a manufacturing programme whose objective is: ${input.objective}`,
    'Declare each one on its claim: DEMAND_EVIDENCE with the kind of observation it is and ' +
      'the date the source observed it, DISTRIBUTION_CHANNEL with the route, ' +
      'INCUMBENT_WEAKNESS with the kind of shortfall. An observation with no date is not a ' +
      'demand signal here and will not be recorded as one — say so rather than estimating it.',
  ];
  if (input.round > 1) {
    parts.push(
      `Brain has asked this of this category ${input.round - 1} time` +
        (input.round === 2 ? '' : 's') +
        ` before and holds ${input.foundSoFar} finding` +
        (input.foundSoFar === 1 ? '' : 's') +
        '. Report what has been published since, and say so plainly where nothing has.',
    );
  }
  return parts.join(' ');
}

export function capabilityTitle(path: readonly string[]): string {
  return `What building ${path[path.length - 1] ?? 'this'} takes, and what it teaches`;
}

/**
 * The capability question, and the one place a worker is told in as many words
 * that it is not being asked about this company.
 *
 * That sentence is not decorative. The whole kernel rests on the difference
 * between what producing a machine requires and what this company can do, and
 * the cheapest way for the difference to collapse is a worker answering the
 * second question when asked the first. Brain refuses such a claim either way —
 * there is no `capability_finding` that could mark a capability held — but a
 * worker who understood the question writes better claims than one whose
 * answers are being silently discarded.
 */
export function capabilityQuestion(input: {
  path: readonly string[];
  objective: string;
  round: number;
  knownSoFar: number;
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `What does producing ${subject} actually require, and what does producing it develop? ` +
      'Establish, from published sources, the engineering, manufacturing, supply, testing, ' +
      'distribution and servicing capabilities a producer must have; what producing at this ' +
      'level builds up that a producer did not have before; and what must be certified, ' +
      'approved, tooled, qualified or reached in scale before anybody may produce at all.',
    `This is for a manufacturing programme whose objective is: ${input.objective}`,
    'Declare each one on its claim: CAPABILITY_REQUIRED for what producing needs, ' +
      'CAPABILITY_TAUGHT for what producing develops, ENTRY_BARRIER for what must be obtained ' +
      'first. Name a capability as shortly as it can be named while still being the same ' +
      'capability wherever it appears, so that two categories needing the same thing say the ' +
      'same words.',
    'You are being asked what producing this *requires*, from published sources about the ' +
      'industry. You are not being asked, and must not report, what this company can already ' +
      'do: Brain records that separately, from a person or from work actually delivered, and ' +
      'no claim can establish it.',
  ];
  if (input.round > 1 || input.knownSoFar > 0) {
    parts.push(
      `Brain already holds ${input.knownSoFar} capabilit` +
        (input.knownSoFar === 1 ? 'y' : 'ies') +
        ' for this category. Report what those do not cover rather than restating them.',
    );
  }
  return parts.join(' ');
}

export function integrationTitle(path: readonly string[]): string {
  return `What producers of ${path[path.length - 1] ?? 'this'} buy in rather than make`;
}

/**
 * The vertical-integration question, which establishes and never recommends.
 *
 * The brief is explicit — *do NOT vertically integrate merely for ideological
 * reasons* — so this asks what is bought in and who supplies it, and stops.
 * Whether making one in-house would improve cost, quality, supply security or
 * capability is a decision with a factory on the end of it, and nothing in this
 * kernel forms a view about it.
 */
export function integrationQuestion(input: {
  path: readonly string[];
  objective: string;
  requiredSoFar: readonly string[];
}): string {
  const subject = input.path.join(' → ');
  const parts = [
    `Which components and subsystems do producers of ${subject} buy in rather than make, and ` +
      'who supplies them? Establish, from published sources, which parts of the machine come ' +
      'from outside — engines, motors, batteries, transmissions, pumps, hydraulics, ' +
      'electronics, control systems, structures — how concentrated each supply is, and what ' +
      'making one in-house is published to require.',
    `This is for a manufacturing programme whose objective is: ${input.objective}`,
    'Declare each bought-in part with capability_finding set to BOUGHT_IN_COMPONENT and ' +
      "capability_subject set to the component's own name. Where a source establishes what " +
      'producing one in-house requires, declare that separately as CAPABILITY_REQUIRED.',
    'Establish what is bought in. Do not recommend integrating anything: whether making a ' +
      'part in-house is worth it is a decision this research does not make.',
  ];
  if (input.requiredSoFar.length > 0) {
    parts.push(
      `Producing here is already established to require: ${input.requiredSoFar.join(', ')}.`,
    );
  }
  return parts.join(' ');
}
