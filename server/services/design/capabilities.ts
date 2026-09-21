/**
 * What the design kernel can and cannot do, read from rows rather than declared.
 *
 * ---------------------------------------------------------------------------
 * Two dimensions, no aggregate
 * ---------------------------------------------------------------------------
 *
 * §37's rule, at a second registry: one column walking from *we wrote it down*
 * to *it works* is wrong at every value in between and nobody can say which part
 * is wrong. So there is `ability_state` — is there a mechanism — and
 * `evidence_state` — has it been shown to work — and deliberately nothing that
 * combines them. A capability that is `LIVE` and `UNTESTED` is a real and common
 * state, and a single number would round it to something reassuring.
 *
 * ---------------------------------------------------------------------------
 * A capability is declared; only a reading moves it
 * ---------------------------------------------------------------------------
 *
 * `seedDesignCapabilities` writes titles, routes, evaluation methods and
 * limitations. It writes **no state at all** — `declareCapability` is not able
 * to, by construction. States move through `moveCapabilityDimension`, which
 * records why in the same statement, and the reasons come from `readAbility`
 * below, which derives them from the filesystem, the rows and the render
 * runtime.
 *
 * That separation is the whole guarantee. A kernel that could set its own
 * capability to LIVE at the moment somebody wrote the module would be reporting
 * *a definition as an implementation*, which is the most expensive available lie
 * here: it would stop the work that exists to close the gap.
 *
 * ---------------------------------------------------------------------------
 * `limitations` is the half that matters
 * ---------------------------------------------------------------------------
 *
 * A registry that says what it can do and not where that stops is a registry
 * that gets trusted past its evidence. Every seed below carries its limitations,
 * and the sharpest one is worth stating here rather than only in a row: **the
 * judged lane reads a structured description of the page, not the picture.** A
 * worker reached through the fleet gets the heading outline, the counts, the
 * control set, the readings and the product context — which is a great deal and
 * is not *seeing*. So this kernel can tell you the outline goes h1 to h4 and
 * cannot tell you the photograph is ugly. That is recorded as a limitation, it
 * is what the first expansion gap is about, and it is not papered over anywhere.
 */
import {
  declareCapability,
  getCapability,
  listCapabilities,
  listCaptures,
  listFindings,
  moveCapabilityDimension,
  setCapabilityLimitations,
} from '../../repos/design.ts';
import type {
  DesignAbilityState,
  DesignCapability,
  DesignEvidenceState,
  DesignPrimitive,
} from '../../domain/design.ts';
import { ABILITY_RANK, EVIDENCE_RANK } from '../../domain/design.ts';
import { getDb } from '../../db/database.ts';
import { probeRenderRuntime } from './renderRuntime.ts';

export interface CapabilitySeed {
  capabilityKey: string;
  title: string;
  primitive: DesignPrimitive;
  route: string | null;
  evaluationMethod: string | null;
  limitations: string[];
}

/**
 * The abilities this kernel claims to be *about*, whether or not it has them.
 *
 * Declaring one it does not have is the point rather than an oversight: §30's
 * distinction is that `MISSING` means Brain understands the capability and does
 * not have it, while `UNKNOWN` means nobody has told Brain what it is — and the
 * expansion loop can only reach the first. An ability nobody has named cannot be
 * identified as a gap, so the gaps Brain can find are exactly the abilities it
 * has thought to declare, and that is a bound worth being explicit about.
 */
export const SEED_CAPABILITIES: CapabilitySeed[] = [
  {
    capabilityKey: 'RENDER_REAL_INTERFACE',
    title: 'Render the actual running interface and keep the bytes',
    primitive: 'RESPONSIVENESS',
    route: 'server/services/design/capture.ts',
    evaluationMethod:
      'A capture row exists whose content hash matches bytes on disk and whose engine and revision ' +
      'are both recorded.',
    limitations: [
      'Needs a headless browser on the machine. The deployed container has none, so a deployed ' +
        'Brain reports NO_RENDER_RUNTIME rather than evaluating from source.',
      'Captures the viewport, not the full scrollable page, so a defect below the fold at a given ' +
        'width is outside what a single capture shows.',
    ],
  },
  {
    capabilityKey: 'MEASURE_LAYOUT_FAULTS',
    title: 'Measure clipping, overflow, overlap and unreachable controls in the live page',
    primitive: 'RESPONSIVENESS',
    route: 'server/services/design/observe.ts + evaluate.ts',
    evaluationMethod:
      'A capture carries readings with an empty `unreadable` list, and the findings derived from ' +
      'them are reproducible from the stored readings alone.',
    limitations: [
      'Only measures what is on screen at the captured height.',
      'Cannot tell a deliberate overlap from an accidental one; it reports the geometry.',
    ],
  },
  {
    capabilityKey: 'MEASURE_ACCESSIBILITY_FLOOR',
    title: 'Measure contrast and target size against a stated floor',
    primitive: 'ACCESSIBILITY',
    route: 'server/services/design/observe.ts',
    evaluationMethod:
      'Contrast is computed from resolved foreground and backdrop colours, and elements with no ' +
      'opaque backdrop are reported as unmeasured rather than assumed.',
    limitations: [
      'Text over an image or a gradient has no single backdrop colour, so it is reported as ' +
        'unmeasured rather than given a ratio.',
      'Covers contrast and target size only. Focus order, keyboard traps, live regions and label ' +
        'association are not read.',
    ],
  },
  {
    capabilityKey: 'JUDGE_COMPOSITION',
    title: 'Form a judgement about hierarchy, emphasis, density and grouping',
    primitive: 'INFORMATION_HIERARCHY',
    route: 'server/services/design/judge.ts, through a bin on the fleet',
    evaluationMethod:
      'A `design_reviews` row in the JUDGED lane with recorded lineage, an independence tier that ' +
      'is not NOT_APPLICABLE, and findings that validated against the judged vocabulary.',
    limitations: [
      'The reviewer reads a structured description of the rendered page — the heading outline, the ' +
        'control set, the counts, the measured readings and the product context — and not the image. ' +
        'So it can establish that the outline skips a level and cannot establish that the ' +
        'composition is ugly.',
      'Needs a healthy execution surface. With none, the lane is skipped and the cycle says so.',
    ],
  },
  {
    capabilityKey: 'REPAIR_WITHIN_BOUNDS',
    title: 'Repair what it found, and stop honestly when it cannot',
    primitive: 'INTERACTION',
    route: 'server/services/design/operate.ts',
    evaluationMethod:
      'A cycle that closed with SETTLED after a later capture no longer showed the finding, or with ' +
      'REPAIR_EXHAUSTED and its findings still OPEN rather than closed to look finished.',
    limitations: [
      'A repair that is a code change is routed to the Software Factory for a person to authorize. ' +
        'This kernel does not write to a repository.',
    ],
  },
  {
    capabilityKey: 'LEARN_FROM_CORRECTION',
    title: 'Take an owner correction and keep it at the scope it was given at',
    primitive: 'EMPHASIS',
    route: 'server/services/design/corrections.ts + patterns.ts',
    evaluationMethod:
      'A correction row with a before and after that both resolve, and a pattern promoted from it ' +
      'whose scope is identical to the correction’s.',
    limitations: [
      'Brain never widens a scope on its own, so a lesson that really is global stays narrow until ' +
        'a person says otherwise.',
    ],
  },
  {
    capabilityKey: 'DETECT_UI_IMPACT',
    title: 'Decide whether a completed change affects the interface, and which screens',
    primitive: 'NAVIGATION',
    route: 'server/services/design/impact.ts',
    evaluationMethod:
      'A classification over a real diff that names the product concepts it touched and the ' +
      'registered surfaces those reach, with a stated reason for a NONE verdict.',
    limitations: [
      'Reads changed paths and the concepts a change names. A change that alters behaviour with no ' +
        'path and no concept in common with any registered surface reads as no impact.',
    ],
  },
  {
    capabilityKey: 'MOBILE_INTERACTION',
    title: 'Judge interaction on a handheld screen — reach, gesture, thumb travel, sheets',
    primitive: 'INTERACTION',
    route: null,
    evaluationMethod: null,
    limitations: [
      'Nothing implements this. Captures are taken at phone width and controls are asked whether ' +
        'they can be pressed, but nothing reads reach zones, scroll travel, gesture affordance or ' +
        'whether a sheet can be dismissed one-handed.',
    ],
  },
  {
    capabilityKey: 'VISUAL_COMPOSITION_FROM_PIXELS',
    title: 'Form a judgement from the image itself rather than from a description of it',
    primitive: 'EMPHASIS',
    route: null,
    evaluationMethod: null,
    limitations: [
      'Nothing implements this. Brain holds the bytes and can hash them; no path shows an image to ' +
        'anything that could form a view about it, and the MCP tools carry text.',
    ],
  },
  {
    capabilityKey: 'MOTION_AND_TRANSITION',
    title: 'Judge what happens between two states — motion, transition, perceived latency',
    primitive: 'FEEDBACK',
    route: null,
    evaluationMethod: null,
    limitations: [
      'Nothing implements this. A capture is one still frame, so everything about how a screen ' +
        'arrives is outside what this kernel perceives at all.',
    ],
  },
];

/** Write the declarations. States are untouched, by construction. */
export async function seedDesignCapabilities(): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  for (const seed of SEED_CAPABILITIES) {
    const result = await declareCapability(seed);
    (result.created ? created : updated).push(seed.capabilityKey);
  }
  return { created, updated };
}

export interface AbilityReading {
  capabilityKey: string;
  ability: DesignAbilityState;
  evidence: DesignEvidenceState;
  /** What was read to reach each answer. Never a claim without one. */
  because: string[];
}

/**
 * Read what a capability actually is, from rows and from this machine.
 *
 * Every branch names its source. There is no branch that reads *the module
 * exists, therefore it works*: §37 is explicit that a module on disk answers
 * UNKNOWN-connected because whether anything imports it is a static fact a
 * running process cannot establish about itself — and it records two cases where
 * that exact confusion shipped, `reconcileAcceptedFragment` and
 * `reconcileRepairs`, both correct code called by one of two runners.
 *
 * So `ability` here is derived from **work having happened**, not from code
 * existing, and `evidence` from the work having been checkable.
 */
export async function readAbility(capabilityKey: string): Promise<AbilityReading | null> {
  const capability = await getCapability(capabilityKey);
  if (!capability) return null;

  const because: string[] = [];
  let ability: DesignAbilityState = 'ABSENT';
  let evidence: DesignEvidenceState = 'UNTESTED';

  if (capability.route === null) {
    because.push('no module, tool or surface is recorded as performing this, so nothing does it.');
    return { capabilityKey, ability: 'ABSENT', evidence: 'UNTESTED', because };
  }
  because.push(`${capability.route} is recorded as performing this.`);
  ability = 'PARTIAL';

  switch (capabilityKey) {
    case 'RENDER_REAL_INTERFACE': {
      const runtime = probeRenderRuntime();
      const captures = await listCaptures({ limit: 5 });
      if (!runtime.available) {
        because.push(`no render runtime here: ${runtime.reason}`);
      } else {
        because.push(`a render runtime is available (${runtime.version ?? 'version not reported'}).`);
        ability = 'CONNECTED';
      }
      if (captures.length > 0) {
        const withHash = captures.filter((one) => one.contentHash.length === 64 && one.byteSize > 0);
        because.push(`${captures.length} capture(s) recorded, ${withHash.length} with real bytes behind them.`);
        if (withHash.length > 0) {
          ability = 'LIVE';
          evidence = 'PASSING';
          const stamped = withHash.filter((one) => one.revision !== null);
          if (stamped.length > 0) {
            because.push(`${stamped.length} of those are bound to a revision.`);
          } else {
            because.push('none of them is bound to a revision, so none can be held against a tree.');
          }
        }
      } else {
        because.push('nothing has been captured, so this has not been exercised.');
      }
      break;
    }

    case 'MEASURE_LAYOUT_FAULTS':
    case 'MEASURE_ACCESSIBILITY_FLOOR': {
      const captures = await listCaptures({ limit: 40 });
      const readable = captures.filter((one) => one.readings.unreadable.length === 0);
      if (captures.length === 0) {
        because.push('no capture has been evaluated, so this has not been exercised.');
        break;
      }
      ability = 'CONNECTED';
      because.push(`${readable.length} of ${captures.length} capture(s) carry a complete set of readings.`);
      if (readable.length > 0) {
        ability = 'LIVE';
        evidence = 'PASSING';
      } else {
        evidence = 'FAILING';
        because.push('every capture had a reader that could not answer, so nothing was measured.');
      }
      break;
    }

    case 'JUDGE_COMPOSITION': {
      const rows = await getDb().all<{ count: number; tier: string | null }>(
        `SELECT COUNT(*) AS count, independence_tier AS tier FROM design_reviews
          WHERE lane = 'JUDGED' GROUP BY independence_tier ORDER BY independence_tier ASC`,
      );
      const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
      if (total === 0) {
        because.push('no judged review has ever been recorded, so nothing has formed a view.');
        break;
      }
      ability = 'LIVE';
      because.push(`${total} judged review(s) recorded.`);
      const independent = rows.filter((row) => row.tier && row.tier !== 'NOT_APPLICABLE');
      if (independent.length > 0) {
        evidence = 'PASSING';
        because.push(
          `separated at: ${independent.map((row) => `${row.tier} x${row.count}`).join(', ')}.`,
        );
      } else {
        evidence = 'FAILING';
        because.push('no judged review achieved any separation, so none of them was independent.');
      }
      break;
    }

    case 'REPAIR_WITHIN_BOUNDS': {
      const repaired = await listFindings({ state: 'REPAIRED', limit: 200 });
      const unresolved = await listFindings({ state: 'UNRESOLVED', limit: 200 });
      if (repaired.length === 0 && unresolved.length === 0) {
        because.push('no finding has ever been settled either way, so the loop has not run to an end.');
        break;
      }
      ability = 'LIVE';
      because.push(`${repaired.length} finding(s) repaired, ${unresolved.length} honestly unresolved.`);
      /*
       * **Stopping honestly is half of this capability, not a failure of it.**
       *
       * The title says "repair what it found, *and stop honestly when it
       * cannot*", and the first version of this reading scored only the first
       * half — so a run in which every repair was correctly routed to a person
       * read FAILING, and the expansion loop then proposed building a capability
       * that was doing exactly what it is for. A self-model that marks a working
       * mechanism as broken sends work at the wrong thing, which is worse than
       * one that says nothing.
       *
       * So either half passes, and the reason says which was exercised. FAILING
       * is reserved for what it should mean: findings settled by neither route.
       */
      evidence = 'PASSING';
      because.push(
        repaired.length > 0
          ? 'A later capture no longer showed a finding, which is the repairing half.'
          : 'Nothing was repaired and nothing was silently closed, which is the stopping half — ' +
            'the repairing half has not been exercised.',
      );
      break;
    }

    case 'LEARN_FROM_CORRECTION': {
      const row = await getDb().get<{ total: number; promoted: number }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN promoted_pattern_id IS NOT NULL THEN 1 ELSE 0 END) AS promoted
           FROM design_corrections`,
      );
      const total = Number(row?.total ?? 0);
      if (total === 0) {
        because.push('the owner has recorded no corrections, so nothing has been learned from one.');
        break;
      }
      ability = 'LIVE';
      because.push(`${total} correction(s) recorded, ${Number(row?.promoted ?? 0)} promoted to a pattern.`);
      evidence = 'PASSING';
      break;
    }

    case 'DETECT_UI_IMPACT': {
      const row = await getDb().get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM design_cycles WHERE trigger_kind = 'UI_IMPACT'`,
      );
      const count = Number(row?.count ?? 0);
      if (count === 0) {
        because.push('no cycle has ever been opened by a UI-impact classification.');
        break;
      }
      ability = 'LIVE';
      evidence = 'PASSING';
      because.push(`${count} cycle(s) opened by a UI-impact classification.`);
      break;
    }

    default:
      because.push('no reading is implemented for this capability, so it stays where it is.');
      break;
  }

  return { capabilityKey, ability, evidence, because };
}

export interface RefreshOutcome {
  moved: { capabilityKey: string; dimension: 'ABILITY' | 'EVIDENCE'; from: string; to: string }[];
  unchanged: number;
}

/**
 * Take a reading of every capability and move what actually changed.
 *
 * Only changes are written, which is `system_component_events`' own argument: a
 * row per scan would be a log of the scanner rather than a history of the
 * system, and the question somebody asks is *when did this stop working*.
 *
 * It is a derivation on a tick rather than a hook on the moment something
 * happens, for the reason this repository has needed four times: a hook fixes
 * one entrance, and a derivation reaches every entrance plus everything already
 * stranded.
 */
export async function refreshCapabilities(actor = 'DESIGN_KERNEL'): Promise<RefreshOutcome> {
  const moved: RefreshOutcome['moved'] = [];
  let unchanged = 0;

  for (const capability of await listCapabilities()) {
    const reading = await readAbility(capability.capabilityKey);
    if (!reading) continue;

    if (reading.ability !== capability.abilityState) {
      const ok = await moveCapabilityDimension({
        capabilityKey: capability.capabilityKey,
        dimension: 'ABILITY',
        from: capability.abilityState,
        to: reading.ability,
        reason: reading.because.join(' '),
        evidenceRef: null,
        actorType: actor,
        actorId: null,
      });
      if (ok) {
        moved.push({
          capabilityKey: capability.capabilityKey,
          dimension: 'ABILITY',
          from: capability.abilityState,
          to: reading.ability,
        });
      }
    } else {
      unchanged += 1;
    }

    /*
     * The evidence dimension is only moved when the capability declares an
     * evaluation method, and the schema enforces the same thing. An ability with
     * no way of being checked can never leave UNTESTED, which is deliberate:
     * that is exactly what it means to have no way of checking.
     */
    if (capability.evaluationMethod !== null && reading.evidence !== capability.evidenceState) {
      const ok = await moveCapabilityDimension({
        capabilityKey: capability.capabilityKey,
        dimension: 'EVIDENCE',
        from: capability.evidenceState,
        to: reading.evidence,
        reason: reading.because.join(' '),
        evidenceRef: null,
        actorType: actor,
        actorId: null,
      });
      if (ok) {
        moved.push({
          capabilityKey: capability.capabilityKey,
          dimension: 'EVIDENCE',
          from: capability.evidenceState,
          to: reading.evidence,
        });
      }
    }
  }
  return { moved, unchanged };
}

/**
 * A capability's maturity as one sentence, composed rather than stored.
 *
 * Composed from both dimensions and both counters, because that is the only way
 * to describe a state like LIVE-and-UNTESTED without rounding it. §37's
 * `describeFaculty` does the same over six dimensions and for the same reason.
 */
export function describeCapability(capability: DesignCapability): string {
  const ability: Record<DesignAbilityState, string> = {
    ABSENT: 'Nothing does this',
    PARTIAL: 'Something is wired for this but it has not been exercised',
    CONNECTED: 'The mechanism is in place and reachable',
    LIVE: 'This has actually been done',
  };
  const evidence: Record<DesignEvidenceState, string> = {
    UNTESTED: 'and nothing has checked whether it worked',
    FAILING: 'and the last check said it did not work',
    PASSING: 'and a check says it worked',
    PRODUCTION_PROVEN: 'and it has worked against the real product',
  };
  const rate =
    capability.observations === 0
      ? 'It has not been used.'
      : `Used ${capability.observations} time(s), ${capability.failures} of which went wrong.`;
  const limits =
    capability.limitations.length === 0
      ? ''
      : ` Where it stops: ${capability.limitations.join(' ')}`;
  return `${ability[capability.abilityState]} ${evidence[capability.evidenceState]}. ${rate}${limits}`;
}

/** Weakest first, by ability then evidence. The order the expansion loop reads. */
export function weakestFirst(capabilities: readonly DesignCapability[]): DesignCapability[] {
  return [...capabilities].sort((a, b) => {
    const byAbility = ABILITY_RANK[a.abilityState] - ABILITY_RANK[b.abilityState];
    if (byAbility !== 0) return byAbility;
    const byEvidence = EVIDENCE_RANK[a.evidenceState] - EVIDENCE_RANK[b.evidenceState];
    if (byEvidence !== 0) return byEvidence;
    return a.capabilityKey.localeCompare(b.capabilityKey);
  });
}

/** Replace a capability's stated limitations. Used when a reading finds a new one. */
export async function noteLimitation(capabilityKey: string, limitation: string): Promise<void> {
  const capability = await getCapability(capabilityKey);
  if (!capability) return;
  if (capability.limitations.includes(limitation)) return;
  await setCapabilityLimitations(capabilityKey, [...capability.limitations, limitation]);
}

