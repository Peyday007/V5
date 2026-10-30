/** Combined signals: linked detector outputs for one organisation or place. */
export type SignalSubjectKind = 'ORGANISATION' | 'PLACE';

export interface CombinedSignal {
  id: string;
  projectId: string;
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  pattern: string;
  memberDetectionIds: string[];
  industryNodeId: string | null;
  possibleNeed: string | null;
  captureMethods: string[];
  /** Always SIGNAL: a combination is never confirmed demand. */
  label: 'SIGNAL';
  createdAt: string;
}
