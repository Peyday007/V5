/** Combined signals: one row per (subject, pattern), always labelled SIGNAL. */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { CombinedSignal, SignalSubjectKind } from '../domain/signals.ts';

interface Row { [key: string]: unknown }

function map(r: Row): CombinedSignal {
  return {
    id: r['id'] as string, projectId: r['project_id'] as string,
    subjectKind: r['subject_kind'] as SignalSubjectKind, subjectKey: r['subject_key'] as string,
    pattern: r['pattern'] as string,
    memberDetectionIds: parseJson<string[]>(r['member_detection_ids'] as string, []),
    industryNodeId: (r['industry_node_id'] as string | null) ?? null,
    possibleNeed: (r['possible_need'] as string | null) ?? null,
    captureMethods: parseJson<string[]>(r['capture_methods'] as string, []),
    label: 'SIGNAL', createdAt: r['created_at'] as string,
  };
}

export async function recordCombinedSignal(input: {
  projectId: string; subjectKind: SignalSubjectKind; subjectKey: string; pattern: string;
  memberDetectionIds: string[]; industryNodeId?: string | null; possibleNeed?: string | null;
  captureMethods: string[];
}): Promise<{ signal: CombinedSignal; created: boolean }> {
  const key = input.subjectKey.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) throw new Error('A combined signal needs an organisation or a place.');
  if (input.memberDetectionIds.length < 2) throw new Error('A combination links at least two detections.');
  const id = newId('csg');
  await getDb().run(
    `INSERT INTO combined_signals (id, project_id, subject_kind, subject_key, pattern,
       member_detection_ids, industry_node_id, possible_need, capture_methods, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIGNAL', ?) ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.subjectKind, key, input.pattern, toJson([...input.memberDetectionIds].sort()),
      input.industryNodeId ?? null, input.possibleNeed ?? null, toJson(input.captureMethods), nowIso()],
  );
  const row = await getDb().get<Row>(
    'SELECT * FROM combined_signals WHERE project_id = ? AND subject_kind = ? AND subject_key = ? AND pattern = ?',
    [input.projectId, input.subjectKind, key, input.pattern]);
  const signal = map(row!);
  return { signal, created: signal.id === id };
}

export async function signalsForNode(projectId: string, industryNodeId: string): Promise<CombinedSignal[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM combined_signals WHERE project_id = ? AND industry_node_id = ? ORDER BY created_at, id',
    [projectId, industryNodeId]);
  return rows.map(map);
}
