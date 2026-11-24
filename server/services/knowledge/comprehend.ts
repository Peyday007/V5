/**
 * Commercial comprehension of acquired datasets (§121): published figures
 * become the reusable economics of each industry, and two programs that
 * measured the same thing are checked against each other.
 *
 * Deterministic throughout: arithmetic over facts, each result an ESTIMATE
 * naming its inputs. The GPU reads the result (`interpret.ts`); it never
 * produces a number here.
 */
import {
  deriveEconomics,
  sectorOf,
  isMetric,
  resolveProgramGap,
  sectorReading,
  METRICS,
  type FactLike,
} from '../../domain/commercialKnowledge.ts';
import {
  currentNationalFacts,
  recordContradiction,
  upsertIndustries,
  writeFacts,
  type NewFact,
} from '../../repos/commercialKnowledge.ts';
import type { KnowledgeFactRow } from '../../domain/types.ts';

/** Record each industry the datasets titled, with the sector's deterministic reading. */
export async function recordIndustryTitles(titles: readonly { naics: string; label: string }[]): Promise<number> {
  const rows = titles
    .filter((t) => t.naics !== '00' && t.naics.length >= 2)
    .map((t) => {
      const sector = sectorReading(t.naics);
      return {
        naics: t.naics,
        label: t.label,
        level: t.naics.length,
        sector: sectorOf(t.naics),
        activity: sector?.activity ?? 'unclassified',
        customer: sector?.customer ?? 'MIXED',
        mechanisms: JSON.stringify({ revenue: sector?.revenue ?? [], mechanisms: [] }),
      };
    });
  return upsertIndustries(rows);
}

function minIso(values: string[]): string {
  return values.reduce((a, b) => (a < b ? a : b));
}
function maxIso(values: string[]): string {
  return values.reduce((a, b) => (a > b ? a : b));
}

/**
 * Derive every national industry's economics from the facts held now and
 * write those that are new or changed. A derived figure is valid only as long
 * as the oldest figure it was computed from.
 */
export async function deriveIndustryEconomics(now = new Date().toISOString()): Promise<{ industries: number; written: number; unchanged: number; superseded: number }> {
  const facts = await currentNationalFacts();
  const byNaics = new Map<string, KnowledgeFactRow[]>();
  for (const f of facts) {
    if (!isMetric(f.metric)) continue;
    const list = byNaics.get(f.naics) ?? [];
    list.push(f);
    byNaics.set(f.naics, list);
  }
  const out: NewFact[] = [];
  for (const [naics, rows] of byNaics) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const like: FactLike[] = rows.map((r) => ({ id: r.id, metric: r.metric as FactLike['metric'], value: Number(r.value), period: r.period, epistemic: r.epistemic, sizeClass: r.size_class }));
    const label = rows.find((r) => r.industry_label)?.industry_label ?? null;
    for (const d of deriveEconomics(like)) {
      const inputs = d.inputs.map((id) => byId.get(id)!).filter(Boolean);
      if (inputs.length === 0 || !Number.isFinite(d.value)) continue;
      out.push({
        subject_key: `DERIVED|${d.metric}|${naics}|US|${d.sizeClass}|${d.period}`,
        metric: d.metric,
        value: d.value,
        unit: METRICS[d.metric].unit,
        metric_class: METRICS[d.metric].class,
        epistemic: 'ESTIMATE',
        naics,
        naics_level: naics === '00' ? 0 : naics.length,
        industry_label: label,
        geo_code: 'US',
        geo_label: 'United States',
        size_class: d.sizeClass,
        period: d.period,
        basis: d.basis,
        inputs: JSON.stringify(d.inputs),
        source_id: null,
        acquisition_id: null,
        source_title: `Brain derivation from ${[...new Set(inputs.map((i) => i.source_title.split(':')[0]))].join(' and ')}`,
        source_url: inputs[0]?.source_url ?? null,
        quality: 'DERIVED',
        observed_at: maxIso(inputs.map((i) => i.observed_at)),
        valid_until: minIso(inputs.map((i) => i.valid_until)),
      });
    }
  }
  const result = await writeFacts(out, now);
  return { industries: byNaics.size, written: result.written, unchanged: result.unchanged, superseded: result.superseded };
}

/**
 * County Business Patterns and Statistics of U.S. Businesses for the same
 * year count establishments, employment and payroll from one register. Where
 * they disagree beyond the tolerance it is recorded with its resolution; a
 * gap inside it is reconciled and counted, not stored. CBP is the primary
 * measure of establishments; neither is of employment or payroll.
 */
export async function checkProgramAgreement(): Promise<{ compared: number; agreed: number; reconciled: number; recorded: number; unresolved: number }> {
  const facts = (await currentNationalFacts()).filter((f) => f.epistemic === 'FACT' && f.size_class === 'ALL');
  const susb = new Map<string, KnowledgeFactRow>();
  const cbp = new Map<string, KnowledgeFactRow>();
  for (const f of facts) {
    const family = f.subject_key.split('|')[0];
    const key = `${f.metric}|${f.naics}|${f.period}`;
    if (family === 'SUSB') susb.set(key, f);
    else if (family === 'CBP_CENSUS_YEAR' || family === 'CBP') cbp.set(key, f);
  }
  let compared = 0;
  let agreed = 0;
  let reconciled = 0;
  let recorded = 0;
  let unresolved = 0;
  for (const [key, a] of cbp) {
    const b = susb.get(key);
    if (!b || !['ESTABLISHMENTS', 'EMPLOYMENT', 'ANNUAL_PAYROLL'].includes(a.metric)) continue;
    compared++;
    const judged = resolveProgramGap({ value: Number(a.value), primaryFor: a.metric === 'ESTABLISHMENTS' }, { value: Number(b.value), primaryFor: false });
    if (!judged) {
      agreed++;
      continue;
    }
    if (judged.resolution === 'RECONCILED') {
      reconciled++;
      continue;
    }
    if (judged.resolution === 'UNRESOLVED') unresolved++;
    if (
      await recordContradiction({
        subject: `${METRICS[a.metric as keyof typeof METRICS]?.label ?? a.metric}, NAICS ${a.naics}${a.industry_label || b.industry_label ? ` (${a.industry_label ?? b.industry_label})` : ''}, ${a.period}`,
        fact_a_ref: `knowledge_fact:${a.id}`,
        fact_b_ref: `knowledge_fact:${b.id}`,
        a_value: Number(a.value),
        b_value: Number(b.value),
        relative_gap: Math.round(judged.gap * 10_000) / 10_000,
        resolution: judged.resolution,
        reason: `County Business Patterns vs Statistics of U.S. Businesses: ${judged.reason}`,
        project_id: null,
      })
    ) recorded++;
  }
  return { compared, agreed, reconciled, recorded, unresolved };
}
