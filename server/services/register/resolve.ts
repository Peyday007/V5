/**
 * Turning a link into a reading of the row behind it.
 *
 * A `workstream_links` row says *this workstream points at that thing*. It does
 * not say whether that thing is running, finished, blocked or gone — and it
 * must not, because a stored answer to that question is stale the moment the
 * thing moves. §29 records the cost at a status line, §38 at a capital tier and
 * §33 at a round's own count: a row is not a decision.
 *
 * So this module is the read path, and it has exactly one rule: **every reading
 * is a row somebody can go and look at, or it is `UNREADABLE` with the reason.**
 * There is no branch that infers a state from a label, a title or a link's own
 * `detail`. A link whose target has been deleted reads as missing rather than
 * as absent, because those are different facts and only one of them is a defect.
 *
 * `PULL_REQUEST` and `DEPLOY` are the two kinds whose truth lives outside this
 * Brain, and they are handled honestly rather than hopefully: Brain holds no
 * forge credential (§27), so what it knows about a pull request is what
 * something recorded on the link, with *who* recorded it and *when*. A reading
 * that said "merged" on the strength of a URL would be the invented citation
 * this codebase exists to refuse.
 */
import type { LinkKind, WorkstreamLink, WorkstreamState } from '../../domain/register.ts';
import { getCampaign, getChangeRequest, listUnits } from '../../repos/factory.ts';
import { getCandidate } from '../../repos/russellCandidates.ts';
import { getMission } from '../../repos/russellMissions.ts';
import { getConversation } from '../../repos/russellConversations.ts';
import { getDocument } from '../../repos/documents.ts';
import { getOrchestration } from '../../repos/research.ts';

/**
 * What one link currently says.
 *
 * `state` is what this piece contributes to its workstream's state — and
 * `null` is a real answer, meaning *this piece says nothing about progress*.
 * A source conversation is the ordinary case: it is where the work came from
 * and never evidence that any of it happened.
 */
export interface LinkReading {
  linkId: string;
  kind: LinkKind;
  ref: string;
  /** What the row actually says, in words, for a person to read. */
  status: string;
  /** What this contributes to the derived state, or null if nothing. */
  state: WorkstreamState | null;
  /** Set when the row this points at is not there. */
  missing: boolean;
  /** A blocker in that row's own words, when it has one. */
  blocker: string | null;
  /** Where the status came from, so a reader can check it. */
  evidence: string;
  /** Present for a link whose truth is outside Brain. */
  attested?: { by: string; at: string };
}

function unreadable(link: WorkstreamLink, why: string): LinkReading {
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: why,
    state: null,
    missing: true,
    blocker: null,
    evidence: 'no row with that id',
  };
}

/**
 * The kinds that can move a state, and the kinds that never can.
 *
 * A `SOURCE` link is excluded here rather than in the caller, because that is
 * the rule itself: a conversation describing a shipped feature is not the
 * feature shipping, and the only thing stopping the register saying otherwise
 * is that a source never contributes a state.
 */
export function contributesState(link: WorkstreamLink): boolean {
  return link.relation === 'PURSUES' || link.relation === 'EVIDENCE';
}

export async function readLink(link: WorkstreamLink): Promise<LinkReading> {
  switch (link.kind) {
    case 'CAMPAIGN':
      return await readCampaign(link);
    case 'CHANGE_REQUEST':
      return await readChangeRequest(link);
    case 'MISSION':
      return await readMission(link);
    case 'CANDIDATE':
      return await readCandidate(link);
    case 'PACKET':
      return await readPacket(link);
    case 'DOCUMENT':
      return await readDocument(link);
    case 'CONVERSATION':
      return await readConversation(link);
    case 'PULL_REQUEST':
      return readAttested(link, 'pull request');
    case 'DEPLOY':
      return readAttested(link, 'deployment');
    default:
      /*
       * Everything else is a pointer this version does not read into a status.
       * It is reported as a link and contributes no state, which is the correct
       * reading of "nobody has said" rather than a silent omission.
       */
      return {
        linkId: link.id,
        kind: link.kind,
        ref: link.ref,
        status: link.label ?? 'linked',
        state: null,
        missing: false,
        blocker: null,
        evidence: 'the link row',
      };
  }
}

async function readCampaign(link: WorkstreamLink): Promise<LinkReading> {
  const campaign = await getCampaign(link.ref);
  if (!campaign) return unreadable(link, 'the campaign this points at is gone');

  const units = await listUnits(campaign.id);
  const integrated = units.filter((unit) => unit.state === 'INTEGRATED').length;
  const detail = units.length ? ` (${integrated}/${units.length} units integrated)` : '';

  // The campaign's own state is the evidence. Nothing here reads a summary,
  // a title or a worker's account of itself — §27's first rule.
  const state: WorkstreamState =
    campaign.state === 'BLOCKED'
      ? 'BLOCKED'
      : campaign.state === 'COMPLETE'
        ? 'PR_READY'
        : campaign.state === 'CANCELLED'
          ? 'PROPOSED'
          : campaign.state === 'AWAITING_RELEASE'
            ? 'PR_READY'
            : 'IN_PROGRESS';

  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `campaign ${campaign.state}${detail}`,
    state,
    missing: false,
    blocker: campaign.blockerKind
      ? `${campaign.blockerKind}: ${campaign.blockerDetail ?? 'no detail recorded'}`
      : null,
    evidence: `factory_campaigns.state = ${campaign.state}`,
  };
}

async function readChangeRequest(link: WorkstreamLink): Promise<LinkReading> {
  const request = await getChangeRequest(link.ref);
  if (!request) return unreadable(link, 'the change request this points at is gone');
  /*
   * Three states and each says a different thing about progress.
   *
   * `DRAFT` is the one that names a person: a request nobody has approved is a
   * proposal however complete it is, and it is the answer to "what needs me?"
   * rather than to "what is running?".
   *
   * `WITHDRAWN` contributes **nothing**, deliberately. Somebody stopped this,
   * which is neither progress nor a blocker, and mapping it onto either would
   * make a decision somebody made read as a state the work got into.
   */
  const state: WorkstreamState | null =
    request.state === 'APPROVED' ? 'IN_PROGRESS' : request.state === 'DRAFT' ? 'PROPOSED' : null;
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `change request ${request.state}`,
    state,
    missing: false,
    blocker: null,
    evidence: `factory_change_requests.state = ${request.state}`,
  };
}

async function readMission(link: WorkstreamLink): Promise<LinkReading> {
  const mission = await getMission(link.ref);
  if (!mission) return unreadable(link, 'the mission this points at is gone');
  const state: WorkstreamState =
    mission.state === 'NEEDS_HUMAN' || mission.state === 'FAILED'
      ? 'BLOCKED'
      : mission.state === 'DONE'
        ? 'DONE'
        : mission.state === 'CANCELLED'
          ? 'PROPOSED'
          : 'IN_PROGRESS';
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `mission ${mission.state}`,
    state,
    missing: false,
    blocker: mission.state === 'NEEDS_HUMAN' ? 'the mission is waiting on a decision' : null,
    evidence: `russell_missions.state = ${mission.state}`,
  };
}

async function readCandidate(link: WorkstreamLink): Promise<LinkReading> {
  const candidate = await getCandidate(link.ref);
  if (!candidate) return unreadable(link, 'the idea this points at is gone');
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `idea ${candidate.state}`,
    state: candidate.state === 'PARKED' ? 'BLOCKED' : 'PROPOSED',
    missing: false,
    blocker: candidate.state === 'PARKED' ? (candidate.reason ?? 'parked') : null,
    evidence: `russell_candidates.state = ${candidate.state}`,
  };
}

async function readPacket(link: WorkstreamLink): Promise<LinkReading> {
  const packet = await getOrchestration(link.ref);
  if (!packet) return unreadable(link, 'the research packet this points at is gone');
  const state: WorkstreamState =
    packet.status === 'NEEDS_HUMAN'
      ? 'BLOCKED'
      : packet.status === 'COMPLETE' || packet.status === 'COMPLETE_WITH_GAPS'
        ? 'DONE'
        : packet.status === 'FAILED' || packet.status === 'CANCELLED'
          ? 'BLOCKED'
          : 'IN_PROGRESS';
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `packet ${packet.status}`,
    state,
    missing: false,
    blocker: state === 'BLOCKED' ? (packet.failureReason ?? packet.cancelReason ?? packet.status) : null,
    evidence: `research_orchestrations.status = ${packet.status}`,
  };
}

async function readDocument(link: WorkstreamLink): Promise<LinkReading> {
  const document = await getDocument(link.ref);
  if (!document) return unreadable(link, 'the document this points at is gone');
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `filed as ${document.canonicalName}`,
    // A filed document is evidence something was produced, and deliberately not
    // evidence it shipped. Those are different claims.
    state: 'DONE',
    missing: false,
    blocker: null,
    evidence: `documents.id = ${document.id}`,
  };
}

async function readConversation(link: WorkstreamLink): Promise<LinkReading> {
  const conversation = await getConversation(link.ref);
  if (!conversation) return unreadable(link, 'the conversation this points at is gone');
  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: conversation.title,
    state: null,
    missing: false,
    blocker: null,
    evidence: `russell_conversations.id = ${conversation.id}`,
  };
}

/**
 * A fact about the world outside this Brain.
 *
 * Brain holds no credential for any forge and never will (§27), so what it
 * knows about a pull request is what was **recorded on the link**, by somebody
 * or something that could see it, at a time. The reading therefore says all
 * three — the claim, who made it and when — and a link carrying no such
 * attestation reads as *recorded, unverified* rather than as a state.
 *
 * That is the difference between this register and one that lies: a URL is not
 * a merge, and nothing here will read one as a merge.
 */
function readAttested(link: WorkstreamLink, noun: string): LinkReading {
  const detail = link.detail as {
    state?: unknown;
    merged?: unknown;
    verifiedLive?: unknown;
    attestedBy?: unknown;
    attestedAt?: unknown;
  };
  const attestedBy = typeof detail.attestedBy === 'string' ? detail.attestedBy : null;
  const attestedAt = typeof detail.attestedAt === 'string' ? detail.attestedAt : null;

  if (!attestedBy || !attestedAt) {
    return {
      linkId: link.id,
      kind: link.kind,
      ref: link.ref,
      status: `${noun} recorded, with nobody attesting to its state`,
      // Recorded and unattested contributes nothing. A link that moved a
      // register to MERGED because somebody pasted a URL would be exactly the
      // unchecked claim this whole codebase refuses.
      state: null,
      missing: false,
      blocker: null,
      evidence: 'the link row, with no attestation on it',
    };
  }

  const verifiedLive = detail.verifiedLive === true;
  const merged = detail.merged === true;
  const state: WorkstreamState = verifiedLive
    ? 'VERIFIED_LIVE'
    : link.kind === 'DEPLOY'
      ? 'DEPLOYED'
      : merged
        ? 'MERGED'
        : 'PR_READY';

  const said =
    typeof detail.state === 'string'
      ? detail.state
      : verifiedLive
        ? 'verified live'
        : merged
          ? 'merged'
          : 'open';

  return {
    linkId: link.id,
    kind: link.kind,
    ref: link.ref,
    status: `${noun} ${said}`,
    state,
    missing: false,
    blocker: null,
    evidence: `attested by ${attestedBy} at ${attestedAt}`,
    attested: { by: attestedBy, at: attestedAt },
  };
}
