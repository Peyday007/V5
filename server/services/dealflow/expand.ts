/**
 * Opening the kernel's questions, and filing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets
 * the path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this kernel
 * adds is a new way *in* to machinery Steps 4 to 12C already built, and none
 * of it is a second set of rules.
 *
 * ---------------------------------------------------------------------------
 * Filing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. `targetForFinding` decides which table a
 * finding lands in; nothing here inspects a sentence, infers a jurisdiction,
 * or decides that a requirement *sounds* like a market approval. That is §8 at
 * the tables that decide whether a quarter-million-dollar transaction is
 * lawful, and it is why what this kernel holds can be trusted to be about
 * published reality rather than about what a model expected the trade to
 * contain.
 *
 * ---------------------------------------------------------------------------
 * Every branch refuses rather than improvises
 * ---------------------------------------------------------------------------
 *
 * A requirement whose claim names no layer, a cost line with no figure, a
 * decision maker on a round that names no organisation — each is *reported as
 * refused* rather than attached to the nearest plausible thing. Attaching it
 * would be Brain deciding what a fact was about, which is the confidently
 * wrong answer §25 records.
 */
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { dealClaims } from '../../repos/research.ts';
import {
  attachDecisionMaker,
  createParty,
  getParty,
  openDealRound,
  openDealRoundsByCandidate,
  recordCost,
  recordRequirement,
  recordStructureEvidence,
  settleDealRound,
} from '../../repos/dealflow.ts';
import {
  costEndFor,
  isCommercialStructure,
  isComplianceLayer,
  isCostComponent,
  partyKindForFinding,
  postureForFinding,
  targetForFinding,
} from '../../domain/dealflow.ts';
import {
  adjacentQuestion,
  adjacentTitle,
  ALL_LAYERS,
  complianceQuestion,
  complianceTitle,
  decisionMakerQuestion,
  decisionMakerTitle,
  demandQuestion,
  demandTitle,
  landedCostQuestion,
  landedCostTitle,
  seedQuestion,
  SEED_TITLE,
  structureQuestion,
  structureTitle,
  supplyQuestion,
  supplyTitle,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { DealflowSnapshot } from './graph.ts';
import type {
  DealCost,
  DealParty,
  DealRequirement,
  DealRound,
  DealStructureEvidence,
  ResearchClaim,
} from '../../domain/types.ts';

const OPENED = 'DEALFLOW_ROUND_OPENED';
const ABSORBED = 'DEALFLOW_FINDINGS_FILED';

export interface OpenedDealRound {
  roundId: string;
  purpose: Ask['purpose'];
  equipmentClass: string | null;
  destination: string | null;
  partyId: string | null;
  candidateId: string;
  round: number;
  question: string;
  why: string;
}

/**
 * Turn allocated asks into Russell candidates and rounds.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything.
 */
export async function openDealAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: DealflowSnapshot;
}): Promise<OpenedDealRound[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];

  const out: OpenedDealRound[] = [];
  for (const ask of input.asks) {
    const composed = await compose({ ask, objective: mode.objective, snapshot: input.snapshot });
    if (!composed) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openDealRound({
      projectId: input.projectId,
      cashModeId: mode.id,
      purpose: ask.purpose,
      equipmentClass: ask.equipmentClass,
      destination: ask.destination,
      partyId: ask.partyId,
      dealId: ask.dealId,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary: `${ask.purpose} round ${ask.round} opened: ${composed.title}.`,
      detail: {
        roundId: opened.round.id,
        purpose: ask.purpose,
        equipmentClass: ask.equipmentClass,
        destination: ask.destination,
        partyId: ask.partyId,
        dealId: ask.dealId,
        candidateId: candidate.id,
        round: ask.round,
        /*
         * The allocator's own reason, recorded beside the work it produced —
         * so "why did Brain research this" resolves to a sentence written at
         * the moment it was decided, over a snapshot that has since moved.
         */
        why: ask.why,
        rank: ask.rank,
      },
    });

    out.push({
      roundId: opened.round.id,
      purpose: ask.purpose,
      equipmentClass: ask.equipmentClass,
      destination: ask.destination,
      partyId: ask.partyId,
      candidateId: candidate.id,
      round: ask.round,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

async function compose(input: {
  ask: Ask;
  objective: string;
  snapshot: DealflowSnapshot;
}): Promise<{ title: string; question: string } | null> {
  const { ask, objective } = input;
  const view = ask.equipmentClass
    ? input.snapshot.classes.find((one) => one.equipmentClass === ask.equipmentClass)
    : null;

  if (ask.purpose === 'SEED_EQUIPMENT') {
    return { title: SEED_TITLE, question: seedQuestion(objective, ask.round) };
  }

  if (ask.purpose === 'DECISION_MAKER' || ask.purpose === 'ADJACENT') {
    if (!ask.partyId) return null;
    const party = await getParty(ask.partyId);
    if (!party) return null;
    return ask.purpose === 'DECISION_MAKER'
      ? {
          title: decisionMakerTitle(party),
          question: decisionMakerQuestion({ party, objective, round: ask.round }),
        }
      : {
          title: adjacentTitle(party),
          question: adjacentQuestion({ party, objective, round: ask.round }),
        };
  }

  if (!ask.equipmentClass) return null;

  if (ask.purpose === 'DEMAND') {
    return {
      title: demandTitle(ask.equipmentClass),
      question: demandQuestion({
        equipmentClass: ask.equipmentClass,
        objective,
        round: ask.round,
        knownBuyers: (view?.buyers ?? []).map((one) => one.name),
      }),
    };
  }

  if (ask.purpose === 'SUPPLY') {
    return {
      title: supplyTitle(ask.equipmentClass),
      question: supplyQuestion({
        equipmentClass: ask.equipmentClass,
        objective,
        round: ask.round,
        knownSuppliers: (view?.suppliers ?? []).map((one) => one.name),
      }),
    };
  }

  if (ask.purpose === 'STRUCTURE') {
    return {
      title: structureTitle(ask.equipmentClass),
      question: structureQuestion({
        equipmentClass: ask.equipmentClass,
        objective,
        round: ask.round,
      }),
    };
  }

  if (!ask.destination) return null;

  if (ask.purpose === 'COMPLIANCE') {
    /*
     * The unresearched layers, asked together.
     *
     * One question per layer would be five rounds, five activations and five
     * audits for one envelope — and the layers share their sources, so a
     * worker reading the destination's vehicle regulations answers three of
     * them from the same page. Asking together is cheaper and does not
     * collapse them: each is declared separately on its own claim.
     */
    const unresearched = unresearchedLayers(view?.requirements ?? [], ask.destination);
    return {
      title: complianceTitle(ask.equipmentClass, ask.destination),
      question: complianceQuestion({
        equipmentClass: ask.equipmentClass,
        destination: ask.destination,
        objective,
        layers: unresearched.length > 0 ? unresearched : ALL_LAYERS,
        round: ask.round,
      }),
    };
  }

  if (ask.purpose === 'LANDED_COST') {
    const origins = [
      ...new Set(
        (view?.suppliers ?? [])
          .map((one) => one.country)
          .filter((one): one is string => typeof one === 'string' && one !== ''),
      ),
    ];
    const known = new Set((view?.costs ?? []).map((one) => one.component));
    return {
      title: landedCostTitle(ask.equipmentClass, ask.destination),
      question: landedCostQuestion({
        equipmentClass: ask.equipmentClass,
        destination: ask.destination,
        origins,
        objective,
        missing: ['FACTORY_PRICE', 'OCEAN_FREIGHT', 'IMPORT_DUTY', 'CUSTOMS_CLEARANCE', 'INLAND_DESTINATION'].filter(
          (one) => !known.has(one as DealCost['component']),
        ),
        round: ask.round,
      }),
    };
  }

  return null;
}

function unresearchedLayers(
  requirements: readonly DealRequirement[],
  destination: string,
): typeof ALL_LAYERS {
  const key = destination.replace(/\s+/g, ' ').trim().toLowerCase();
  const answered = new Set(
    requirements
      .filter((one) => one.destination.replace(/\s+/g, ' ').trim().toLowerCase() === key)
      .map((one) => one.layer),
  );
  return ALL_LAYERS.filter((one) => !answered.has(one));
}

/* --------------------------------------------------------------------------
 * Filing what came back
 * ------------------------------------------------------------------------ */

export interface Filed {
  parties: DealParty[];
  requirements: DealRequirement[];
  costs: DealCost[];
  structures: DealStructureEvidence[];
  decisionMakers: { partyId: string; name: string }[];
  settled: { roundId: string; found: number }[];
  /** Reported rather than guessed at. A refusal is evidence, not a silence. */
  refused: { claimId: string; why: string }[];
}

/**
 * A fresh, empty report.
 *
 * A function rather than a shared constant, because every field of `Filed` is
 * an array and a constant spread into a new object hands out the *same* array
 * to every caller. It would work today — the first version overrode all seven
 * fields after the spread — and it would stop working the moment somebody adds
 * an eighth and forgets to override it, at which point two passes would append
 * to one list and nobody would see why.
 */
function emptyFiled(): Filed {
  return {
    parties: [],
    requirements: [],
    costs: [],
    structures: [],
    decisionMakers: [],
    settled: [],
    refused: [],
  };
}

/**
 * File every declared finding from the rounds that are still open.
 *
 * Not gated by the sprint's lifecycle, deliberately and for `harvest`'s own
 * reason: filing what research already found is not new discovery — the
 * spending happened when it ran — and dropping results because the sprint
 * wound down would throw away work already paid for.
 */
export async function fileFindings(input: {
  projectId: string;
  limit?: number;
}): Promise<Filed> {
  const out: Filed = emptyFiled();
  const mode = await getCashMode(input.projectId);
  if (!mode) return out;

  const live = await openDealRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to, through the mission — because
   * a mission is what links a round's candidate to the orchestration it
   * launched. An orchestration with no mission belongs to no kernel round,
   * which is honest rather than a gap: nobody asked a kernel question for it,
   * and filing its claims would put facts into the map under a subject nothing
   * chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<string, { round: DealRound; missionDone: boolean }>();
  for (const mission of missions) {
    if (!mission.orchestrationId || !mission.candidateId) continue;
    const round = live.get(mission.candidateId);
    if (round) {
      byOrchestration.set(mission.orchestrationId, {
        round,
        missionDone: mission.state === 'DONE',
      });
    }
  }
  if (byOrchestration.size === 0) return out;

  const foundPerRound = new Map<string, number>();
  const claims = await dealClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit: Math.max(1, input.limit ?? 200),
  });

  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    const filed = await file({
      projectId: input.projectId,
      claim: entry.claim,
      round: context.round,
      out,
    });
    /*
     * `found` counts what the round *established*, not what this pass wrote.
     *
     * The difference is the whole of §38's recorded defect, and it is
     * reachable here: a round's claims are filed on the pass they are gated,
     * and the round only settles on the pass its mission reaches DONE — which
     * is routinely a later one. Counting creations would then record `found =
     * 0` for a round that had produced everything it produced, and
     * `BARREN_ROUNDS` of those retires the question that was working best.
     *
     * A claim that collided with a row an earlier pass wrote established that
     * row. A refused one established nothing, and is the only thing that does
     * not count.
     */
    if (filed !== 'REFUSED') {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   *
   * `found` is what the next round is decided against, so a round whose
   * mission has finished records what it produced — **including nothing**.
   * Leaving a barren round OPEN would stop it ever being asked again while
   * looking like it was still running, which is the state this kernel exists
   * to make impossible.
   */
  for (const [, { round, missionDone }] of byOrchestration) {
    if (!missionDone) continue;
    const found = foundPerRound.get(round.id) ?? 0;
    const settled = await settleDealRound({ roundId: round.id, found });
    if (settled?.state === 'SETTLED') out.settled.push({ roundId: round.id, found });
  }

  const written =
    out.parties.length +
    out.requirements.length +
    out.costs.length +
    out.structures.length +
    out.decisionMakers.length;
  if (written > 0) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: ABSORBED,
      actorRef: 'BRAIN',
      summary:
        `${out.parties.length} part${out.parties.length === 1 ? 'y' : 'ies'}, ` +
        `${out.requirements.length} requirement${out.requirements.length === 1 ? '' : 's'}, ` +
        `${out.costs.length} cost line${out.costs.length === 1 ? '' : 's'} and ` +
        `${out.structures.length} commercial precedent` +
        `${out.structures.length === 1 ? '' : 's'} were filed from what the dealflow kernel ` +
        'established.',
      detail: {
        partyIds: out.parties.map((one) => one.id),
        requirementIds: out.requirements.map((one) => one.id),
        costIds: out.costs.map((one) => one.id),
        structureIds: out.structures.map((one) => one.id),
        decisionMakers: out.decisionMakers,
        refused: out.refused,
      },
    });
  }
  return out;
}

/**
 * One declared finding into the one table its kind belongs in.
 *
 * Three answers rather than two, and the third is what makes the round's
 * `found` honest. `CREATED` is a row this pass wrote; `EXISTS` is one an
 * earlier pass already wrote from the same claim, which the round still
 * established; `REFUSED` is a declaration that could not be filed at all and
 * established nothing. Collapsing the first two — counting only creations —
 * is §38's recorded defect, where a round that settles on a later pass than
 * the one that filed its claims records nothing and is retired as barren.
 */
type Filing = 'CREATED' | 'EXISTS' | 'REFUSED';

async function file(input: {
  projectId: string;
  claim: ResearchClaim;
  round: DealRound;
  out: Filed;
}): Promise<Filing> {
  const { claim, round, out } = input;
  const finding = claim.dealFinding;
  if (!finding) return 'REFUSED';
  const subject = claim.dealSubject;
  if (!subject) {
    out.refused.push({ claimId: claim.id, why: 'the finding named no subject' });
    return 'REFUSED';
  }

  const target = targetForFinding(finding);

  if (target === 'PARTY') {
    const kind = partyKindForFinding(finding);
    const equipmentClass = claim.dealEquipment;
    if (!kind || !equipmentClass) {
      out.refused.push({ claimId: claim.id, why: 'a party finding named no equipment class' });
      return 'REFUSED';
    }
    const { party, created } = await createParty({
      projectId: input.projectId,
      kind,
      name: subject,
      country: claim.dealJurisdiction,
      equipmentClass,
      note: claim.claim,
      origin: 'DISCOVERED',
      sourceClaimId: claim.id,
    });
    if (created) out.parties.push(party);
    return created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'PARTY_ATTRIBUTE') {
    /*
     * A decision maker belongs to the organisation the round was asked about.
     *
     * Read from the round rather than matched against the claim's subject by
     * name: a party is identified by (name, class) and a decision-maker claim
     * carries no class, so matching on the name alone would attach the fact to
     * whichever of that organisation's rows came first. The round knows
     * exactly which party it asked about, because it had to name one to exist.
     */
    if (!round.partyId) {
      out.refused.push({
        claimId: claim.id,
        why: 'a decision maker arrived on a round that names no organisation, so there is nothing to attach it to',
      });
      return 'REFUSED';
    }
    const attached = await attachDecisionMaker({
      partyId: round.partyId,
      decisionMaker: claim.claim,
      sourceClaimId: claim.id,
    });
    if (attached) out.decisionMakers.push({ partyId: round.partyId, name: subject });
    /*
     * A refusal to overwrite is not a refusal to file. `attachDecisionMaker`
     * is guarded on the column still being null, so a second claim about an
     * organisation Brain already knows the buyer of loses — and the round
     * still established who decides.
     */
    return attached ? 'CREATED' : 'EXISTS';
  }

  if (target === 'REQUIREMENT') {
    const layer = claim.dealValue;
    const posture = postureForFinding(finding);
    const destination = claim.dealJurisdiction;
    const equipmentClass = claim.dealEquipment;
    if (!isComplianceLayer(layer) || !posture || !destination || !equipmentClass) {
      out.refused.push({
        claimId: claim.id,
        why: 'a requirement finding was missing its layer, market or equipment class',
      });
      return 'REFUSED';
    }
    const { requirement, created } = await recordRequirement({
      projectId: input.projectId,
      destination,
      equipmentClass,
      layer,
      posture,
      statement: claim.claim,
      authority: claim.sourcePublisher,
      effectiveDate: claim.sourceDate,
      sourceClaimId: claim.id,
    });
    if (created) out.requirements.push(requirement);
    return created ? 'CREATED' : 'EXISTS';
  }

  if (target === 'COST') {
    const component = claim.dealValue;
    const equipmentClass = claim.dealEquipment;
    if (
      !isCostComponent(component) ||
      !equipmentClass ||
      claim.dealAmountCents === null ||
      !claim.dealCurrency
    ) {
      out.refused.push({
        claimId: claim.id,
        why: 'a cost finding was missing its component, class, figure or currency',
      });
      return 'REFUSED';
    }
    /*
     * Which end of the lane the declared market names is decided by the
     * component, not by the round that happened to turn it up. A supply
     * question routinely finds a published factory price, and filing that as a
     * *destination* would hide it from every lane out of this class.
     */
    const end = costEndFor(component);
    const { cost, created } = await recordCost({
      projectId: input.projectId,
      equipmentClass,
      originCountry: end === 'ORIGIN' ? claim.dealJurisdiction : null,
      destination: end === 'ORIGIN' ? null : claim.dealJurisdiction,
      component,
      amountCents: claim.dealAmountCents,
      /*
       * Both declared, neither parsed out of the sentence.
       *
       * The currency is the source's own, not the sprint's, so a lane whose
       * figures disagree is visible rather than silently harmonised. The basis
       * is `deal_subject`, which for a cost component is defined as what the
       * figure is *per* — because a figure whose basis Brain guessed at is a
       * figure nobody can check, and adding a per-container rate to a per-unit
       * price is the arithmetic this kernel most needs not to do.
       */
      currency: claim.dealCurrency,
      basis: subject,
      sourceClaimId: claim.id,
    });
    if (created) out.costs.push(cost);
    return created ? 'CREATED' : 'EXISTS';
  }

  const structure = claim.dealValue;
  const equipmentClass = claim.dealEquipment;
  if (!isCommercialStructure(structure) || !equipmentClass) {
    out.refused.push({
      claimId: claim.id,
      why: 'a commercial precedent was missing its structure or class',
    });
    return 'REFUSED';
  }
  const { evidence, created } = await recordStructureEvidence({
    projectId: input.projectId,
    equipmentClass,
    structure,
    statement: claim.claim,
    rateNote: subject,
    sourceClaimId: claim.id,
  });
  if (created) out.structures.push(evidence);
  return created ? 'CREATED' : 'EXISTS';
}
