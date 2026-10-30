/**
 * Combined signals and the possibility store. A combined signal is a signal and
 * never confirmed demand; a possibility is kept with what it needs and what
 * would make it worth reconsidering.
 */
export const SIGNAL_SUBJECT_KINDS = ['ORGANISATION', 'PLACE'] as const;
export type SignalSubjectKind = (typeof SIGNAL_SUBJECT_KINDS)[number];

export const POSSIBILITY_STATES = ['KEPT', 'RECONSIDERING', 'PURSUED', 'RETIRED'] as const;
export type PossibilityState = (typeof POSSIBILITY_STATES)[number];

export const POSSIBILITY_RELATIONS = ['REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS'] as const;
export type PossibilityRelation = (typeof POSSIBILITY_RELATIONS)[number];

export interface SignalsViewer {
  projectId: string;
  userId: string | null;
}

export interface CombinedSignal {
  id: string; projectId: string; ownerUserId: string | null;
  subjectKind: SignalSubjectKind; subjectKey: string; comboKey: string;
  detectionIds: string[]; industryNodeId: string | null; possibleNeed: string | null;
  captureMethods: string[]; label: 'SIGNAL'; createdAt: string;
}

/** What a possibility needs. An open set: any key a requirement can be named by. */
export type PossibilityRequirements = Record<string, string | number | boolean | string[]>;

export interface Possibility {
  id: string; projectId: string; ownerUserId: string | null; title: string; kind: string;
  requirements: PossibilityRequirements; state: PossibilityState; sourceRef: string | null;
  createdAt: string; updatedAt: string;
}

export interface PossibilityEdge {
  id: string; projectId: string; fromId: string; toId: string; relation: PossibilityRelation; createdAt: string;
}

export interface PossibilityCondition {
  id: string; projectId: string; possibilityId: string; conditionKey: string; description: string;
  metChangeRef: string | null; metAt: string | null; createdAt: string;
}
