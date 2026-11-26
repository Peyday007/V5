// Shared harness helpers: build a REF RouteContext for a recorded probe case. Imports Brain's real functions only.
import fs from 'node:fs';
import path from 'node:path';
import { ownerLabourOffer } from '../../../../../server/domain/operatingModel.ts';
import type { RouteContext, RouteFinding } from '../../../../../server/services/goals/routeProposal.ts';

export const EXP = path.resolve(import.meta.dirname, '..');
export const ROOT = path.resolve(EXP, '../../../..');
export const TODAY = '2026-11-26';
export const DELIVERS = ['spreadsheet', 'business document', 'presentation', 'data operations', 'website', 'programming', 'graphic design', '3D model'];

export interface ProbeCase {
  case: string; file: string; revision: string; goal: 'p02' | 'p06' | 'p10';
  objective: { objective: string; remaining: number; daysLeft: number; capitalLimit: number | null; hoursLimit: number | null; resources: string | null };
  findings: RouteFinding[]; replies: { model: string; error: string | null; ms: number; content: string }[];
  parsed: { routes: any[]; rejected: any[] } | null; critique: any; prompt: string | null;
}
export const probes = (): ProbeCase[] => JSON.parse(fs.readFileSync(path.join(EXP, 'raw/E-010/probes.json'), 'utf8'));

// hoursPerWeek as the recorded prompts state it (p02: "20 hour(s) a week"); p06 and p10 state none.
const HOURS_PER_WEEK: Record<string, number | null> = { p02: 20, p06: null, p10: null };

export function refCtx(c: ProbeCase, over: Partial<RouteContext> = {}): RouteContext {
  const o = c.objective;
  return {
    objective: o.objective, currency: 'USD', remaining: o.remaining, daysLeft: o.daysLeft,
    capitalLimit: o.capitalLimit, hoursLimit: o.hoursLimit, hoursPerWeek: HOURS_PER_WEEK[c.goal] ?? null,
    resources: o.resources, industry: null, recurring: false, exclusions: [], delivers: DELIVERS,
    held: [], refuted: [], today: TODAY, ownerLabour: ownerLabourOffer(o.objective, o.resources),
    findings: c.findings, scouted: [], lessons: [], ...over,
  };
}
export const write = (rel: string, data: unknown) => {
  const p = path.join(EXP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
};
