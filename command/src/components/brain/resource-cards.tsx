'use client';
/**
 * Every major resource, answering the same seven questions in full sentences.
 * Nothing truncated: the explanation is the point.
 */
import { Empty, Freshness, Panel, QueryView, StatusPill, TimeAgo, num } from '@/components/brain/display';
import { useBrain } from '@/hooks/use-brain';
import type { ResourceReading, ResourcesView } from '@/lib/types';
import { cn } from '@/lib/utils';

function verdict(r: ResourceReading): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (r.idleBesideWork) return { label: 'Idle beside waiting work', tone: 'bad' };
  if (r.atLimit === true) return { label: 'At its limit', tone: 'good' };
  if (r.atLimit === false && (r.waiting ?? 0) === 0) return { label: 'Room to spare, nothing waiting', tone: 'neutral' };
  if (r.atLimit === false) return { label: 'Below its limit', tone: 'warn' };
  return { label: 'Not measured', tone: 'neutral' };
}

function Row({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className='grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3'>
      <dt className='text-muted-foreground text-xs font-medium'>{q}</dt>
      <dd className='min-w-0 text-sm break-words text-pretty'>{children}</dd>
    </div>
  );
}

export function ResourceCard({ r }: { r: ResourceReading }) {
  const v = verdict(r);
  return (
    <div className='min-w-0 rounded-xl border p-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='font-medium'>{r.name}</h3>
        <StatusPill status={v.label} tone={v.tone} />
      </div>
      <div className='text-muted-foreground mt-1 flex flex-wrap gap-x-4 text-xs tabular-nums'>
        <span>{num(r.running)} running</span>
        <span>{num(r.capacity)} capacity</span>
        <span>{num(r.waiting)} waiting</span>
      </div>
      <dl className='mt-3 flex flex-col gap-2.5'>
        <Row q='What is it accomplishing?'>{r.accomplishing || 'Not reported.'}</Row>
        <Row q='Useful work waiting'>{r.waiting === null ? 'Not measured.' : `${num(r.waiting)} item(s).`}</Row>
        <Row q='At maximum productive capacity?'>
          <span className={cn(v.tone === 'bad' && 'text-red-600 dark:text-red-400', v.tone === 'good' && 'text-emerald-700 dark:text-emerald-400')}>
            {v.label}.
          </span>
        </Row>
        <Row q='Why'>{r.why}</Row>
        <Row q='What Brain is doing'>{r.brainDoing}</Row>
        <Row q='Would spending help?'>
          <StatusPill status={r.spendingHelps === 'UNKNOWN' ? 'Not clear' : r.spendingHelps === 'YES' ? 'Yes' : 'No'} tone={r.spendingHelps === 'YES' ? 'warn' : 'neutral'} className='mr-2' />
          {r.spending}
        </Row>
        <Row q='What it would cost'>{r.costPerHour !== null ? `About $${r.costPerHour.toFixed(2)} per hour while running.` : 'No price on record for adding more of this.'}</Row>
      </dl>
    </div>
  );
}

export function ResourcesPanel() {
  const q = useBrain<ResourcesView>('/api/command/resources', { interval: 20_000 });
  return (
    <Panel
      title='Resources'
      description='Each resource Brain runs on, what it is doing, and what limits it. Re-read every 20 seconds.'
      action={<Freshness query={q} />}
    >
      <QueryView query={q} rows={4}>
        {(v) =>
          v.resources.length === 0 ? (
            <Empty>Brain returned no resource reading yet.</Empty>
          ) : (
            <div className='flex flex-col gap-3'>
              <div className='grid gap-3 xl:grid-cols-2'>
                {v.resources.map((r) => (
                  <ResourceCard key={r.key} r={r} />
                ))}
              </div>
              <p className='text-muted-foreground text-xs'>
                {v.source === 'CACHED' ? 'Last complete reading, ' : 'Read '}
                <TimeAgo at={v.readAt} />.
              </p>
            </div>
          )
        }
      </QueryView>
    </Panel>
  );
}
