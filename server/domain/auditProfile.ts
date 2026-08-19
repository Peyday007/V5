/**
 * Project audit profiles.
 *
 * The auditor's machinery is generic; what a *particular* project considers a
 * foundational gap is not. Rather than scattering `if (layer === 'Discovery')`
 * through the pipeline, every project-specific judgement lives in one profile
 * that the prompts read. A future generated-criteria system replaces the data,
 * not the engine.
 */
import type { GapClassification } from './types.ts';

export interface GlobalCriterion {
  /** Stable id, e.g. `G1`, so a finding can cite the rule it came from. */
  id: string;
  name: string;
  statement: string;
}

export interface LayerCriteria {
  /** Matches `layers.slug`. */
  slug: string;
  name: string;
  /** One sentence: the question this layer exists to answer. */
  owns: string;
  /** The neighbouring question this layer must NOT answer. */
  doesNotOwn: string;
  /** What the auditor checks the layer can actually represent. */
  auditFor: string[];
  /** Deliberate limits on what may be demanded of this layer. */
  cautions: string[];
}

export interface GapCategoryRule {
  classification: GapClassification;
  meaning: string;
  /** Whether an issue in this category may hold the layer open for research. */
  justifiesResearch: boolean;
}

export interface AuditProfile {
  id: string;
  projectSlug: string;
  name: string;
  /** The programme's shape, stated once for every prompt that needs it. */
  premise: string;
  globalCriteria: GlobalCriterion[];
  layers: LayerCriteria[];
  gapCategories: GapCategoryRule[];
  /** Section 10: the difference between "more can be" and "more is required". */
  researchRule: string[];
  synthesisRule: string[];
  freezeRule: string[];
}

/**
 * Which categories may keep a layer open. Stated as data so the judge prompt,
 * the validator and the planner all read the same list.
 */
export const GAP_CATEGORY_RULES: GapCategoryRule[] = [
  {
    classification: 'FOUNDATIONAL_GAP',
    meaning:
      'A missing concept or architecture element that would materially weaken the layer, ' +
      'and would cause later layers or builds to reason incorrectly.',
    justifiesResearch: true,
  },
  {
    classification: 'TARGETED_RESEARCH_GAP',
    meaning:
      'The architecture is broadly sound, but one bounded unknown must be resolved by a ' +
      'focused research run before synthesis or freeze.',
    justifiesResearch: true,
  },
  {
    classification: 'PATCH',
    meaning:
      'The evidence already gathered is sufficient. Existing material can be corrected or ' +
      'reconciled during synthesis. No new research run.',
    justifiesResearch: false,
  },
  {
    classification: 'OTHER_LAYER',
    meaning:
      'The issue is real but a different layer owns it. Record the handoff; do not open ' +
      'research in this layer for it.',
    justifiesResearch: false,
  },
  {
    classification: 'IMPLEMENTATION_DETAIL',
    meaning:
      'Relevant when the system is built, but not required to complete the conceptual ' +
      'foundation. Schemas, APIs, data structures, tooling.',
    justifiesResearch: false,
  },
  {
    classification: 'EMPIRICAL_TUNING',
    meaning:
      'Requires real-world data, calibration, thresholds, experimentation or operational ' +
      'learning. Never holds foundational research open.',
    justifiesResearch: false,
  },
  {
    classification: 'DOMAIN_PLUGIN',
    meaning:
      'The global architecture is complete; a specific industry or family will later need a ' +
      'plug-in. Does not block a global freeze.',
    justifiesResearch: false,
  },
  {
    classification: 'OPTIONAL_IMPROVEMENT',
    meaning: 'Would improve quality but is not necessary for correctness or completeness.',
    justifiesResearch: false,
  },
  {
    classification: 'NO_GAP',
    meaning: 'The proposed criticism does not materially require action.',
    justifiesResearch: false,
  },
];

const DEAL_DISPATCH_GLOBAL: GlobalCriterion[] = [
  {
    id: 'G1',
    name: 'FOUNDATIONAL DEPTH',
    statement:
      'The platform must have enough conceptual depth that implementation is not built on a ' +
      'shallow understanding of commerce.',
  },
  {
    id: 'G2',
    name: 'LAYER SEPARATION',
    statement: 'The eight layers must remain distinct; work must not drift across their boundaries.',
  },
  {
    id: 'G3',
    name: 'NO FAKE COMPLETENESS',
    statement: 'An artifact may not claim completeness merely because it is long.',
  },
  {
    id: 'G4',
    name: 'NO INFINITE RESEARCH',
    statement:
      'An artifact may not remain open merely because additional detail theoretically exists.',
  },
  {
    id: 'G5',
    name: 'GENERALITY',
    statement:
      'Global architecture should survive unfamiliar industries rather than depend on familiar ' +
      'home-service or procurement examples.',
  },
  {
    id: 'G6',
    name: 'EXPLICIT UNCERTAINTY',
    statement:
      'Unknowns and uncertainty must be represented rather than silently converted into facts.',
  },
  {
    id: 'G7',
    name: 'STATEFULNESS',
    statement:
      'Commercial reality is dynamic. Important lifecycle and state distinctions must not be ' +
      'flattened into static labels.',
  },
  {
    id: 'G8',
    name: 'PROVENANCE',
    statement:
      'Material claims and findings should retain enough lineage to understand where they came from.',
  },
  {
    id: 'G9',
    name: 'DOWNSTREAM USABILITY',
    statement:
      'The layer must produce concepts and interfaces that the next layer can actually consume.',
  },
  {
    id: 'G10',
    name: 'NON-COLLAPSE',
    statement:
      'Distinct concepts must not be collapsed solely for simplicity when the distinction ' +
      'materially changes decisions.',
  },
  {
    id: 'G11',
    name: 'ADVERSARIAL SURVIVAL',
    statement: 'The architecture should survive reasonable counterexamples.',
  },
  {
    id: 'G12',
    name: 'CORRECT GAP OWNERSHIP',
    statement: 'A real gap must be routed to its actual owning layer.',
  },
  {
    id: 'G13',
    name: 'SYNTHESIS DISCIPLINE',
    statement:
      'Synthesis means reconciliation and canonicalisation of completed research, not an excuse ' +
      'to invent missing foundations.',
  },
  {
    id: 'G14',
    name: 'FREEZE DISCIPLINE',
    statement:
      'Freeze when no unresolved global foundational contradiction or gap remains. ' +
      'Family- or domain-specific future work does not automatically block a global freeze.',
  },
];

const DEAL_DISPATCH_LAYERS: LayerCriteria[] = [
  {
    slug: 'world-model',
    name: 'World Model',
    owns: 'How commercial reality works: actors, objects, rights, state, flows, commitments, obligations, control and constraints.',
    doesNotOwn: 'Enumerating every commercial family, or industry-specific operating rules.',
    auditFor: [
      'roles represented separately from entities',
      'demand represented separately from firms',
      'supply and capability represented separately from availability',
      'ownership represented separately from control and use',
      'custody and possession',
      'rights bundles',
      'commitments',
      'obligations',
      'risk',
      'responsibility',
      'consideration and settlement',
      'claims, liens, priority and encumbrance',
      'multi-party and composite transactions',
      'market, clearing and allocation mechanisms',
      'multiple simultaneous flows',
      'state transitions',
      'constraints',
      'uncertainty and evidence',
    ],
    cautions: [
      'Do not demand industry-specific operating rules.',
      'World Model should explain HOW commerce can exist, not enumerate every commercial family.',
    ],
  },
  {
    slug: 'taxonomy',
    name: 'Taxonomy',
    owns: 'What recurring commercial requirements, supply classes, domains, families, branches and opportunity types exist.',
    doesNotOwn: 'How opportunities are detected, qualified, priced or executed.',
    auditFor: [
      'coverage of the practical commercial universe',
      'canonical placement',
      'sensible hierarchy',
      'minimal duplication',
      'meaningful separation criteria',
      'substrate-before-vertical reasoning',
      'ability to place unfamiliar opportunities',
      'distinction between transaction object and monetization method',
      'adequate depth for each family',
      'explicit identification of families that require child research',
    ],
    cautions: [
      'Taxonomy is allowed to require substantially more research than other layers.',
      'Do NOT prematurely freeze Taxonomy merely because the upper tree is sound.',
    ],
  },
  {
    slug: 'monetization-logic',
    name: 'Monetization Logic',
    owns: 'What economic position Deal Dispatch may occupy in a transaction.',
    doesNotOwn: 'Whether a particular opportunity is real, or how it is discovered or executed.',
    auditFor: [
      'economically distinct intermediary positions',
      'promise',
      'stance',
      'controlled object',
      'contractual geometry',
      'title and right state',
      'performance responsibility',
      'balance-sheet exposure',
      'capital exposure',
      'risk-bearing',
      'agency versus principal distinction',
      'marketplace versus representation',
      'control-right principalship',
      'compensation separated from economic position',
      'hybrid and modifier handling',
    ],
    cautions: ['Do not multiply structures merely because industries use different labels.'],
  },
  {
    slug: 'discovery-logic',
    name: 'Discovery Logic',
    owns: 'How commercially relevant states become observable.',
    doesNotOwn:
      'Whether pursuing an observed opportunity is economically justified — that is Qualification.',
    auditFor: [
      'evidence detection rather than generic lead generation',
      'demand-first discovery',
      'supply-first discovery',
      'event-first discovery',
      'lifecycle and timing discovery',
      'distress and dislocation',
      'public and open-web sensors',
      'permissioned and private networks',
      'geography and flow anomalies',
      'signal composition',
      'signal freshness',
      'state and change handling',
      'source observability',
      'evidence lineage',
      'separation of trigger from downstream need',
      'separation of existence, capability and availability',
      'correct handling of missing and negative evidence',
      'no deterministic "event X means need Y" inference',
    ],
    cautions: [
      'Discovery should stop before determining whether pursuit is economically justified.',
    ],
  },
  {
    slug: 'qualification-logic',
    name: 'Qualification Logic',
    owns: 'Whether an observed opportunity is real, sufficiently evidenced, feasible, intermediable, economically defensible and worth pursuit.',
    doesNotOwn: 'Allocating portfolio resources among qualified opportunities — that is Routing.',
    auditFor: [
      'transaction thesis',
      'commercial reality',
      'evidence burden',
      'proposition-level evidence',
      'feasibility',
      'access',
      'timing',
      'intermediability',
      'economic defensibility',
      'qualification cost',
      'value of additional qualification information',
      'buyer and counterparty risk',
      'supplier risk',
      'capital exposure',
      'payment geometry',
      'regulatory role permissibility',
      'uncertainty',
      'stop, continue and qualify decisions',
    ],
    cautions: [
      'Qualification determines whether pursuit is defensible; it does not allocate resources among opportunities.',
    ],
  },
  {
    slug: 'execution-playbooks',
    name: 'Execution Playbooks',
    owns: 'How an authorized route is operationally performed.',
    doesNotOwn: 'Choosing the strategic route itself — that is Routing.',
    auditFor: [
      'translation from routed decision to operational action',
      'universal execution core',
      'monetization-structure modules',
      'family and domain overlays',
      'jurisdiction overlays',
      'account-specific overlays',
      'actual deal state',
      'scope',
      'sourcing',
      'verification',
      'quotation',
      'negotiation',
      'commitment',
      'contracting',
      'fulfillment',
      'settlement',
      'exceptions',
      'recovery',
      'fallback',
      'escalation',
      'autonomy boundaries',
      'financial and payment execution',
      'recurring, project and multi-party variations',
    ],
    cautions: ['Execution implements an authorized route; it should not choose the route.'],
  },
  {
    slug: 'decision-routing-rules',
    name: 'Decision Routing Rules',
    owns: 'Among viable paths, what Deal Dispatch should do now, with what resources, timing, authority and fallback.',
    doesNotOwn: 'Whether the opportunity is real — that is Qualification.',
    auditFor: [
      'route comparison',
      'non-compensatory gates',
      'multi-objective tradeoffs',
      'Pareto and dominance logic where appropriate',
      'uncertainty',
      'downside and survivability',
      'portfolio allocation',
      'scarce-resource constraints',
      'value of information',
      'optionality',
      'staged commitment',
      'rerouting',
      'switching cost',
      'hysteresis and stability',
      'urgency',
      'opportunity decay',
      'scheduling',
      'next-best-action',
      'route authority',
      'escalation',
      'abandonment and fallback',
      'distinction between the best route and the authority to choose it',
    ],
    cautions: [
      'Routing answers "what should we do now?", not "is this opportunity real?".',
    ],
  },
  {
    slug: 'learning-evaluation',
    name: 'Learning Evaluation',
    owns: 'What happened, whether predictions and decisions were good, and how the system improves.',
    doesNotOwn: 'Silently rewriting high-impact production rules on the strength of one outcome.',
    auditFor: [
      'prediction versus actual',
      'calibration',
      'decision quality versus outcome',
      'counterfactual thinking',
      'attribution',
      'lineage',
      'cross-layer credit and blame',
      'low-data learning',
      'transfer and generalization',
      'experimentation',
      'regression detection',
      'drift',
      'learning governance',
      'update permissions',
      'human review',
      'playbook and process evaluation',
      'bottleneck and root-cause analysis',
    ],
    cautions: [
      'Learning may recommend system changes; it must not silently rewrite high-impact production rules because one outcome occurred.',
    ],
  },
];

export const DEAL_DISPATCH_AUDIT_PROFILE: AuditProfile = {
  id: 'deal-dispatch-v1',
  projectSlug: 'deal-dispatch',
  name: 'Deal Dispatch Audit Profile',
  premise:
    'Deal Dispatch is a layered research programme building a conceptual foundation for ' +
    'commercial intermediation. Each layer is expanded across sibling research runs, audited, ' +
    'synthesised into one canonical document, and then frozen. The audit exists to decide ' +
    'whether the foundation is strong enough to build on — not to score prose.',
  globalCriteria: DEAL_DISPATCH_GLOBAL,
  layers: DEAL_DISPATCH_LAYERS,
  gapCategories: GAP_CATEGORY_RULES,
  researchRule: [
    '"More can be researched" and "more research is required" are different answers.',
    'Deal Dispatch research stops when the global architecture is sufficient.',
    'Do NOT require another research run merely because: examples could be added; more sources ' +
      'exist; more industries exist; implementation details remain; thresholds need calibration; ' +
      'domain-specific plug-ins remain; or a future layer will need additional detail.',
    'Another research run requires a specific unresolved foundational question, stated as a question.',
  ],
  synthesisRule: [
    'Return READY_FOR_SYNTHESIS only when all required sibling research exists, no unresolved ' +
      'foundational contradiction remains, and no targeted foundational research remains.',
    'Remaining issues may be patches, downstream handoffs, domain plug-ins, implementation work ' +
      'or empirical tuning.',
  ],
  freezeRule: [
    'Freeze is stronger than PASS.',
    'A layer is freeze-ready when a canonical synthesis exists and passes its final audit, no ' +
      'unresolved foundational gap or contradiction remains, and remaining issues belong to ' +
      'specific domains, implementation, empirical calibration, downstream layers or future extensions.',
    'Taxonomy is expected to remain open much longer than most other global layers.',
  ],
};

const PROFILES: AuditProfile[] = [DEAL_DISPATCH_AUDIT_PROFILE];

/** The profile for a project, or null when the project has no configured criteria. */
export function getAuditProfile(projectSlug: string): AuditProfile | null {
  return PROFILES.find((profile) => profile.projectSlug === projectSlug) ?? null;
}

export function getLayerCriteria(profile: AuditProfile, layerSlug: string): LayerCriteria | null {
  return profile.layers.find((entry) => entry.slug === layerSlug) ?? null;
}

/** Whether a classification may legitimately keep a layer open for research. */
export function justifiesResearch(classification: GapClassification): boolean {
  return GAP_CATEGORY_RULES.find((rule) => rule.classification === classification)?.justifiesResearch ?? false;
}
