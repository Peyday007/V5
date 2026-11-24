'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, num } from '@/components/brain/display';
import { useTool } from '@/hooks/use-brain';

/** `brain_operator_knowledge` (§121): read on the server, narrowed to the projects this person may read. */
interface KnowledgeReading {
  readAt: string;
  learning: {
    lastPass: { at: string; reads: { source: string; outcome: string; facts: number; error?: string }[]; interpreted: string[]; errors: string[] } | null;
    sources: { key: string; title: string; publisher: string; period: string; status: string; origin: string; url: string; lastSuccessAt: string | null; nextDueAt: string; failures: number; lastError: string | null; why: string }[];
    recentReads: { source: string; at: string; outcome: string; bytes: number; rows: number; factsWritten: number; factsUnchanged: number; error: string | null }[];
  };
  understanding: {
    facts: Record<string, number>;
    byClass: Record<string, number>;
    industriesTitled: number;
    industriesMeasured: number;
    industriesInterpreted: number;
    byCustomer: Record<string, number>;
    interpreted: { naics: string; label: string; customer: string; mechanisms: { revenue?: string[]; mechanisms?: string[] }; interpretation: string | null; principles: string[]; requirements: string[]; unknowns: string[]; servedBy: string | null; at: string | null }[];
  };
  mechanisms: { revenueBases: Record<string, number>; mechanisms: Record<string, number> };
  recent: { factsThisWeek: number; derived: { metric: string; naics: string; industry: string | null; value: number; unit: string; period: string; epistemic: string; basis: string }[] };
  missing: {
    buyersUnclassified: { buyer: string; why: string }[];
    withheldCells: number;
    staleFacts: number;
    industriesUninterpreted: number;
    sourcesWithoutReader: { key: string; title: string; url: string; why: string }[];
    failingSources: { key: string; error: string | null; nextDueAt: string }[];
    contradictions: number;
  };
  plans: {
    applied: Record<string, number>;
    buyersLinked: number;
    recent: { kind: string; at: string; detail: string; before: string | null; after: string | null; ref: string }[];
    contradictions: { counts: Record<string, number>; recent: { subject: string; a_value: number; b_value: number; resolution: string; reason: string }[] };
  };
  capacity: { gpuAvailable: boolean; sourcesDue: number; readsLast24h: number; interpretationsLast24h: number; idleBesideWork: boolean; note: string };
}

const words = (key: string) => key.toLowerCase().replace(/_/g, ' ');
const value = (v: number, unit: string) =>
  unit === 'share' ? `${(v * 100).toFixed(1)}%` : unit.startsWith('USD') ? `$${Math.round(v).toLocaleString('en-US')}${unit.slice(3)}` : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}`;

function Counts({ items }: { items: Record<string, number> }) {
  const entries = Object.entries(items).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Empty>Nothing mapped yet.</Empty>;
  return (
    <ul className='flex flex-wrap gap-1.5'>
      {entries.map(([k, n]) => (
        <li key={k} className='bg-muted rounded px-2 py-0.5 text-xs'>
          {words(k)} <b className='tabular-nums'>{num(n)}</b>
        </li>
      ))}
    </ul>
  );
}

export default function KnowledgePage() {
  const q = useTool<KnowledgeReading>('brain_operator_knowledge', {}, { interval: 60_000 });
  return (
    <PageContainer
      pageTitle='Commercial knowledge'
      pageDescription='What Brain learns from public commercial data by itself, what it understands, and where that knowledge changed your plans.'
      pageHeaderAction={<Freshness query={q} />}
    >
      <QueryView query={q} rows={4}>
        {(k) => (
          <>
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-5'>
              <Stat label='Industries measured' value={num(k.understanding.industriesMeasured)} hint={`${num(k.understanding.industriesTitled)} classified`} />
              <Stat label='Industries interpreted (GPU)' value={num(k.understanding.industriesInterpreted)} hint={`${num(k.missing.industriesUninterpreted)} still unread`} />
              <Stat label='Published facts' value={num(k.understanding.facts['FACT'] ?? 0)} hint={`${num(k.understanding.facts['ESTIMATE'] ?? 0)} derived estimates · ${num(k.understanding.facts['UNKNOWN'] ?? 0)} withheld`} />
              <Stat label='Plan inputs supplied' value={num((k.plans.applied['CONSTRUCTION_FACT'] ?? 0) + (k.plans.applied['PLAN_INPUT_CHANGED'] ?? 0))} hint={`${num(k.plans.applied['UNCERTAINTY_RESOLVED'] ?? 0)} research questions answered · ${num(k.plans.applied['ASSUMPTION_REPLACED'] ?? 0)} assumptions replaced`} tone={(k.plans.applied['CONSTRUCTION_FACT'] ?? 0) > 0 ? 'good' : undefined} />
              <Stat label='Capacity' value={k.capacity.idleBesideWork ? 'Idle beside work' : 'In use'} tone={k.capacity.idleBesideWork ? 'bad' : 'good'} hint={`${num(k.capacity.readsLast24h)} reads · ${num(k.capacity.interpretationsLast24h)} GPU readings (24h)`} />
            </div>

            <div className='grid gap-6 lg:grid-cols-2'>
              <Panel title='How knowledge is improving plans' description='Each place an acquired figure reached a goal: what the plan read before, and after.'>
                {k.plans.recent.length === 0 ? (
                  <Empty>No plan has read acquired knowledge yet.</Empty>
                ) : (
                  <ol className='flex max-h-[30rem] flex-col gap-3 overflow-y-auto'>
                    {k.plans.recent.map((a, i) => (
                      <li key={i} className='flex flex-col gap-1 text-xs'>
                        <div className='flex items-center justify-between gap-2'>
                          <StatusPill status={words(a.kind)} tone='good' />
                          <span className='text-muted-foreground'><TimeAgo at={a.at} /></span>
                        </div>
                        <p className='font-medium text-pretty'>{a.detail}</p>
                        {a.before && <p className='text-muted-foreground text-pretty'>Before: {a.before.replace(/^(NO_EVIDENCE|EVIDENCED): /, '')}</p>}
                        {a.after && <p className='text-pretty'>After: {a.after}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>

              <Panel title='What Brain is learning' description='Datasets it found and reads itself, newest vintage first.'>
                <ul className='divide-y'>
                  {k.learning.sources.map((s) => (
                    <li key={s.key} className='flex flex-col gap-1 py-2.5'>
                      <div className='flex items-center justify-between gap-2'>
                        <a href={s.url} className='truncate text-sm font-medium hover:underline' target='_blank' rel='noreferrer'>{s.title}</a>
                        <StatusPill status={s.status} />
                      </div>
                      <p className='text-muted-foreground text-xs text-pretty'>{s.why}</p>
                      <p className='text-muted-foreground text-[11px]'>
                        {s.lastSuccessAt ? <>read <TimeAgo at={s.lastSuccessAt} /></> : 'not read yet'} · next check <TimeAgo at={s.nextDueAt} />
                        {s.lastError && <span className='text-red-600'> · {s.lastError}</span>}
                      </p>
                    </li>
                  ))}
                  {k.learning.sources.length === 0 && <Empty>No dataset discovered yet.</Empty>}
                </ul>
              </Panel>
            </div>

            <div className='grid gap-6 lg:grid-cols-2'>
              <Panel title='Industries it understands' description='The GPU’s reading of measured economics: who pays, how, what it takes, and what the figures leave open. Inference, never fact.'>
                {k.understanding.interpreted.length === 0 ? (
                  <Empty>No industry has been interpreted yet.</Empty>
                ) : (
                  <ul className='flex max-h-[30rem] flex-col gap-3 overflow-y-auto'>
                    {k.understanding.interpreted.map((i) => (
                      <li key={i.naics} className='flex flex-col gap-1 text-xs'>
                        <p className='text-sm font-medium'>{i.naics} {i.label} <span className='text-muted-foreground font-normal'>· {words(i.customer)}</span></p>
                        {i.interpretation && <p className='text-pretty'>{i.interpretation}</p>}
                        {i.principles.length > 0 && <p className='text-muted-foreground text-pretty'>Principles: {i.principles.join(' ')}</p>}
                        {i.unknowns.length > 0 && <p className='text-muted-foreground text-pretty'>Unknown: {i.unknowns.join(' ')}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title='Mechanisms mapped' description='How the businesses of each classified industry are paid, and the mechanisms the GPU recognised.'>
                <div className='flex flex-col gap-3'>
                  <Counts items={k.mechanisms.revenueBases} />
                  <Counts items={k.mechanisms.mechanisms} />
                  <p className='text-muted-foreground text-xs'>Customers: </p>
                  <Counts items={k.understanding.byCustomer} />
                </div>
              </Panel>
            </div>

            <div className='grid gap-6 lg:grid-cols-2'>
              <Panel title='Recently acquired' description={`${num(k.recent.factsThisWeek)} figures added this week; the derived economics below are estimates over published facts.`}>
                {k.recent.derived.length === 0 ? (
                  <Empty>Nothing derived this week.</Empty>
                ) : (
                  <ul className='divide-y text-xs'>
                    {k.recent.derived.map((d, i) => (
                      <li key={i} className='flex flex-col gap-0.5 py-2'>
                        <span><b>{d.industry ?? d.naics}</b> — {d.metric}: <b className='tabular-nums'>{value(d.value, d.unit)}</b> ({d.period})</span>
                        <span className='text-muted-foreground'>{d.epistemic.toLowerCase()}: {d.basis}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title='What is still missing' description='Gaps are rows, not silences.'>
                <ul className='flex flex-col gap-1.5 text-xs'>
                  <li>{num(k.missing.buyersUnclassified.length)} buyer type(s) not yet matched to an industry{k.missing.buyersUnclassified.length > 0 && `: ${k.missing.buyersUnclassified.slice(0, 5).map((b) => b.buyer).join('; ')}`}</li>
                  <li>{num(k.missing.industriesUninterpreted)} industries not yet interpreted</li>
                  <li>{num(k.missing.withheldCells)} figures the publisher withheld</li>
                  <li>{num(k.missing.staleFacts)} figures past their freshness</li>
                  <li>{num(k.missing.contradictions)} unresolved contradictions</li>
                  {k.missing.sourcesWithoutReader.map((s) => (
                    <li key={s.key} className='text-muted-foreground'>Found, no reader yet: <a className='underline' href={s.url} target='_blank' rel='noreferrer'>{s.title}</a></li>
                  ))}
                  {k.missing.failingSources.map((s) => (
                    <li key={s.key} className='text-red-600'>{s.key} failing: {s.error} (retry <TimeAgo at={s.nextDueAt} />)</li>
                  ))}
                </ul>
              </Panel>
            </div>
            <p className='text-muted-foreground text-xs'>{k.capacity.note}</p>
          </>
        )}
      </QueryView>
    </PageContainer>
  );
}
