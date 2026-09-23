/**
 * The three things only a person can tell this kernel.
 *
 * Seeding a category, retiring one, and recording that this company actually
 * holds a capability. All three are decisions or facts about the world outside
 * Brain, and none of them is reachable from any research path.
 *
 * ---------------------------------------------------------------------------
 * Why Brain may not seed
 * ---------------------------------------------------------------------------
 *
 * `SEED` is the one category origin Brain cannot write, and the schema enforces
 * it rather than this comment: every other origin requires a `source_claim_id`,
 * and Brain has no way to produce a claim that has not been through the
 * evidence gate. A machine that could name its own categories would be deciding
 * what this company is — §22's rule that a worker cannot create its own work,
 * arriving at the table that decides where everything else looks.
 *
 * What a seed *is* is an instruction: somebody has a reason to believe this
 * class of machine is worth Brain's attention, and that reason is theirs. The
 * kernel then treats a seeded category exactly like a discovered one — it is
 * asked about, decomposed, and reported barren if it turns out to be, with no
 * special case anywhere.
 *
 * ---------------------------------------------------------------------------
 * Why holding a capability is the most consequential row here
 * ---------------------------------------------------------------------------
 *
 * Every readiness answer, every capability gap, every bridge and the whole
 * question of what to build next turns on which capabilities are held. A
 * capability marked held that is not is the error with a factory on the end of
 * it, so it has exactly one source and that source is not a model: a person
 * with ADMIN on this project saying so, in their own words.
 *
 * **One and not two, which is a deliberate narrowing rather than an omission.**
 * The obvious second was a holding derived from work this project actually got
 * paid for — but Cash Mode delivers services and the Software Factory delivers
 * code, and neither of them is evidence that this company can build a machine.
 * A derived value nothing could produce would be the *mechanism nothing calls*
 * this repository keeps having to correct, wearing an enum. When a second
 * genuine source exists it is an additive migration somebody reviews, which is
 * where "could this be faked?" gets asked.
 *
 * There is certainly no RESEARCHED, and there never will be. §32's distinction
 * at a new table: CONFIGURED is not HEALTHY, and a perfect block of what a
 * category teaches over an empty block of what this company has actually done
 * is a refusal, not a pass.
 */
import { recordEvent } from '../../repos/events.ts';
import {
  createCategory,
  declareCapabilityHeld,
  ensureCapability,
  getCapability,
  getCategory,
  getProgram,
  listCapabilities,
  retireCategory,
  withdrawCapabilityHeld,
  listAcquisitionCandidates,
  listProgrammeDecisions,
  reopenProgrammeDecision,
  resolveProgrammeDecision,
  setAsideCandidate,
} from '../../repos/manufacturing.ts';
import { capabilitySlug } from '../../domain/manufacturing.ts';
import type {
  Capability,
  MachineCategory,
  MachineCategoryKind,
  AcquisitionCandidate,
  ProgrammeDecision,
  ProgrammeDecisionTopic,
} from '../../domain/types.ts';

export interface SeedResult {
  category: MachineCategory;
  /** False when it was already on the ladder, which is not an error. */
  created: boolean;
}

/**
 * Put a category on the ladder because somebody said so.
 *
 * Idempotent by the unique index on `(program, parent, name)`, so pressing it
 * twice produces one category and reports the one that is there. A category
 * that already exists as a *discovered* one is returned unchanged rather than
 * re-origined: how Brain came to know about something is history, and history
 * does not stop having happened because somebody later named it too.
 *
 * It spends nothing and starts nothing. The allocator decides when the category
 * is asked about, the research grant decides whether that may run, and the
 * evidence gate decides what may be claimed.
 */
export async function seedCategory(input: {
  projectId: string;
  name: string;
  kind?: MachineCategoryKind;
  description?: string | null;
  parentId?: string | null;
  actorRef: string;
  reason?: string | null;
}): Promise<SeedResult | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };

  if (input.parentId) {
    const parent = await getCategory(input.parentId);
    if (!parent || parent.programId !== program.id) {
      return { error: 'That parent category is not on this programme’s ladder.' };
    }
  }

  const result = await createCategory({
    programId: program.id,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    // A seeded category is a class of machine unless somebody says otherwise.
    // `ADJACENT_CATEGORY` is what research establishes about a relationship,
    // and a person naming a category is naming a place to look rather than
    // asserting it is adjacent to something.
    kind: input.kind ?? 'PRODUCT_CATEGORY',
    name: input.name,
    description: input.description ?? null,
    origin: 'SEED',
  });

  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'MACHINE_CATEGORY',
      entityId: result.category.id,
      eventType: 'MANUFACTURING_CATEGORY_SEEDED',
      payload: {
        summary: `${result.category.name} was seeded onto the manufacturing ladder.`,
        kind: result.category.kind,
        parentId: result.category.parentId,
        actorRef: input.actorRef,
        reason: input.reason ?? null,
      },
    });
  }
  return { category: result.category, created: result.created };
}

/**
 * A person deciding a category is not worth pursuing.
 *
 * Destroys nothing: the row keeps its id, its evidence, its children and every
 * round ever run against it, and it is still listed. What changes is that the
 * allocator stops offering it and its reading is `RETIRED` with the person's
 * own reason — the one verdict no derivation could ever reach.
 *
 * Deleting instead would be worse than useless: the same category would arrive
 * again on the next expansion as a fresh discovery, and the allowance would be
 * spent learning something somebody had already decided.
 */
export async function retireCategoryDecision(input: {
  projectId: string;
  categoryId: string;
  reason: string;
  actorRef: string;
}): Promise<MachineCategory | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };
  const category = await getCategory(input.categoryId);
  if (!category || category.programId !== program.id) {
    return { error: 'That category is not on this programme’s ladder.' };
  }
  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) {
    return { error: 'Retiring a category records why, so that it stays answerable.' };
  }

  if (await retireCategory(category.id, reason)) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'MACHINE_CATEGORY',
      entityId: category.id,
      eventType: 'MANUFACTURING_CATEGORY_RETIRED',
      payload: {
        summary: `${category.name} was retired from the manufacturing ladder.`,
        reason,
        actorRef: input.actorRef,
      },
    });
  }
  return (await getCategory(category.id)) ?? category;
}

export interface HeldResult {
  capability: Capability;
  /** False when it was already recorded as held, which is not an error. */
  changed: boolean;
}

/**
 * A person recording that this company holds a capability.
 *
 * The capability is created if the ledger has never heard of it, so somebody
 * can record what the company can do before any research has named it — which
 * is the ordinary case at the start of a programme, and the case where being
 * unable to say so would make the whole ladder read as unreachable.
 *
 * The note is required and the refusal for an empty one is not pedantry: it is
 * the only thing standing between this row and a capability recorded as held
 * for no stated reason, which is indistinguishable afterwards from one somebody
 * guessed.
 */
export async function declareHeld(input: {
  projectId: string;
  /** Either an existing capability, or a name to create and hold. */
  capabilityId?: string | null;
  name?: string | null;
  note: string;
  actorRef: string;
}): Promise<HeldResult | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };

  const note = input.note.replace(/\s+/g, ' ').trim();
  if (!note) {
    return {
      error:
        'Recording that this company holds a capability records how it came to: say what was ' +
        'hired, bought, built or delivered. A capability held for no stated reason is ' +
        'indistinguishable from one somebody guessed.',
    };
  }

  let capability: Capability | null = null;
  if (input.capabilityId) {
    capability = await getCapability(input.capabilityId);
    if (!capability || capability.programId !== program.id) {
      return { error: 'That capability is not in this programme’s ledger.' };
    }
  } else if (input.name?.trim()) {
    const slug = capabilitySlug(input.name);
    if (!slug) {
      return { error: `"${input.name}" reduces to nothing a capability could be identified by.` };
    }
    const ensured = await ensureCapability({
      programId: program.id,
      projectId: input.projectId,
      name: input.name,
      origin: 'SEED',
    });
    capability = ensured.capability;
  } else {
    return { error: 'Say which capability, either by id or by name.' };
  }

  const { capability: after, changed } = await declareCapabilityHeld({
    capabilityId: capability.id,
    evidence: 'DECLARED',
    heldBy: input.actorRef,
    note,
  });

  if (changed) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'CAPABILITY',
      entityId: capability.id,
      eventType: 'MANUFACTURING_CAPABILITY_HELD',
      payload: {
        summary: `${capability.name} was recorded as a capability this company holds.`,
        evidence: 'DECLARED',
        heldBy: input.actorRef,
        note,
      },
    });
  }
  return { capability: after ?? capability, changed };
}

/**
 * A person withdrawing a declaration they made.
 *
 * Guarded on `held_evidence = 'DECLARED'` in the statement that makes the
 * change. Today that matches every holding there is, because DECLARED is the
 * only kind — the guard is there so that the rule lives in the `UPDATE` rather
 * than in somebody's memory when a second, derived kind arrives. A holding
 * resting on something that actually happened is not a claim to be corrected,
 * and unsaying it would be editing history.
 */
export async function withdrawHeld(input: {
  projectId: string;
  capabilityId: string;
  reason: string;
  actorRef: string;
}): Promise<Capability | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };
  const capability = await getCapability(input.capabilityId);
  if (!capability || capability.programId !== program.id) {
    return { error: 'That capability is not in this programme’s ledger.' };
  }
  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) return { error: 'Withdrawing a declaration records why.' };

  if (await withdrawCapabilityHeld(capability.id)) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'CAPABILITY',
      entityId: capability.id,
      eventType: 'MANUFACTURING_CAPABILITY_WITHDRAWN',
      payload: {
        summary: `${capability.name} is no longer recorded as a capability this company holds.`,
        reason,
        actorRef: input.actorRef,
        previouslyHeldBy: capability.heldBy,
      },
    });
  }
  return (await getCapability(capability.id)) ?? capability;
}

/** Every capability in the ledger, for a person choosing one. */
export async function ledger(projectId: string): Promise<Capability[]> {
  const program = await getProgram(projectId);
  if (!program) return [];
  return listCapabilities(program.id);
}


/**
 * A person setting an acquisition candidate aside.
 *
 * The one verdict no derivation reaches: somebody read it and said no. It
 * **destroys nothing** — the row keeps its name, its contribution, its
 * statement and the claim it came from — because deleting it would let the
 * same firm arrive again on the next round as a fresh discovery, spending the
 * allowance to learn something somebody had already decided. §5, at a table
 * whose rows are about other people's companies.
 *
 * Setting aside is the only thing a person may do to a candidate here, and
 * that is the boundary rather than an omission. There is no approach, no
 * valuation, no offer and no commitment, in this function or anywhere in this
 * kernel, and there is no column in `acquisition_candidates` that one could be
 * written into.
 */
export async function setAsideAcquisition(input: {
  projectId: string;
  candidateId: string;
  reason: string;
  actorRef: string;
}): Promise<AcquisitionCandidate | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };

  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) {
    return {
      error:
        'Setting a candidate aside records why. A firm dismissed for no stated reason is ' +
        'indistinguishable afterwards from one nobody got round to reading.',
    };
  }

  const before = (await listAcquisitionCandidates(program.id)).find(
    (one) => one.id === input.candidateId,
  );
  if (!before) return { error: 'That candidate is not on this programme.' };
  if (before.setAsideAt !== null) {
    // Already answered. The first reason stands rather than being replaced:
    // the guarded UPDATE says so, and saying it here too keeps the reply
    // honest about what happened.
    return before;
  }

  const after = await setAsideCandidate({
    candidateId: input.candidateId,
    programId: program.id,
    reason,
    actorUserId: input.actorRef,
  });
  if (!after) return { error: 'That candidate is not on this programme.' };

  await recordEvent({
    projectId: input.projectId,
    entityType: 'MANUFACTURING_PROGRAM',
    entityId: program.id,
    eventType: 'MANUFACTURING_CANDIDATE_SET_ASIDE',
    payload: {
      summary: `${after.name} was set aside as an acquisition candidate.`,
      candidateId: after.id,
      contribution: after.contribution,
      reason,
      actorRef: input.actorRef,
    },
  });
  return after;
}

/**
 * A person answering one of the questions this kernel raises and cannot
 * settle.
 *
 * Their own words, stored exactly as written. Nothing validates the answer
 * against a vocabulary, nothing derives it, nothing improves it, and no
 * research round can reach this table — the whole point of the row is that the
 * question is not a researchable one. A Brain that proposed three candidate
 * brand names would have made the decision and left somebody the clerical half
 * of it.
 */
export async function resolveDecision(input: {
  projectId: string;
  topic: ProgrammeDecisionTopic;
  resolution: string;
  actorRef: string;
}): Promise<ProgrammeDecision | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };

  const resolution = input.resolution.replace(/\s+/g, ' ').trim();
  if (!resolution) {
    return {
      error:
        'An answer is the words you would say. An empty one would read afterwards as a ' +
        'decision taken with nothing behind it.',
    };
  }

  const before = (await listProgrammeDecisions(program.id)).find(
    (one) => one.topic === input.topic,
  );
  if (!before) return { error: 'This programme has no such open question.' };
  if (before.state === 'RESOLVED') return before;

  const after = await resolveProgrammeDecision({
    programId: program.id,
    topic: input.topic,
    resolution,
    actorUserId: input.actorRef,
  });
  if (!after) return { error: 'This programme has no such open question.' };

  await recordEvent({
    projectId: input.projectId,
    entityType: 'MANUFACTURING_PROGRAM',
    entityId: program.id,
    eventType: 'MANUFACTURING_DECISION_RESOLVED',
    payload: {
      summary: `${input.topic} was answered.`,
      topic: input.topic,
      resolution,
      actorRef: input.actorRef,
    },
  });
  return after;
}

/**
 * A person unchoosing one.
 *
 * The answering transition, and it exists because the directive's own reason
 * for caution — *do not lock these division names prematurely* — is precisely
 * a reason a name chosen early may need unchoosing. An escalation with no way
 * back is stuck rather than waiting, for the seventh time in this file's
 * history.
 *
 * The previous answer is cleared rather than kept, because a question that
 * reads OPEN while still carrying an answer is §29's status contradicting the
 * control beside it. What it happened is on `project_events`, which is
 * append-only, so nothing about the record is lost.
 */
export async function reopenDecision(input: {
  projectId: string;
  topic: ProgrammeDecisionTopic;
  reason: string;
  actorRef: string;
}): Promise<ProgrammeDecision | { error: string }> {
  const program = await getProgram(input.projectId);
  if (!program) return { error: 'This project has no manufacturing programme.' };

  const reason = input.reason.replace(/\s+/g, ' ').trim();
  if (!reason) {
    return { error: 'Reopening a question records why, so that it stays answerable.' };
  }

  const before = (await listProgrammeDecisions(program.id)).find(
    (one) => one.topic === input.topic,
  );
  if (!before) return { error: 'This programme has no such question.' };
  if (before.state === 'OPEN') return before;

  const after = await reopenProgrammeDecision({ programId: program.id, topic: input.topic });
  if (!after) return { error: 'This programme has no such question.' };

  await recordEvent({
    projectId: input.projectId,
    entityType: 'MANUFACTURING_PROGRAM',
    entityId: program.id,
    eventType: 'MANUFACTURING_DECISION_REOPENED',
    payload: {
      summary: `${input.topic} was reopened.`,
      topic: input.topic,
      previousResolution: before.resolution,
      reason,
      actorRef: input.actorRef,
    },
  });
  return after;
}
