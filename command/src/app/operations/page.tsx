'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, num } from '@/components/brain/display';
import { useBrain, useTool } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { enc } from '@/lib/brain';
import type { Utilization, WorkforceView, WorkResponse } from '@/lib/types';

export default function OperationsPage() {
  const { projectId, homes } = useHomeProject();
  const workforce = useBrain<{ workforce: WorkforceView }>(
    projectId ? `/api/russell/projects/${enc(projectId)}/workforce` : null,
    { interval: 15_000 }
  );
  const work = useBrain<WorkResponse>(projectId ? `/api/russell/projects/${enc(projectId)}/work?limit=60` : null, {
    interval: 15_000
  });
  const capacity = useTool<Utilization>('brain_operator_capacity', {}, { interval: 20_000 });

  return (
    <PageContainer
      pageTitle='Live operations'
      pageDescription='What is running right now, who is running it, and what moved in the last hours. Re-read every 15 seconds.'
      pageHeaderAction={<Freshness query={workforce} />}
    >
      {homes.data && !projectId && <Empty>You have no project Brain operates in.</Empty>}
      <QueryView query={workforce} rows={2}>
        {({ workforce: w }) => (
          <>
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-5'>
              <Stat label='Accounts connected' value={num(w.totals.connected)} />
              <Stat label='Working now' value={num(w.totals.working)} tone={w.totals.working > 0 ? 'good' : undefined} />
              <Stat label='Idle with work' value={num(w.totals.idleWithWork)} tone={w.totals.idleWithWork > 0 ? 'bad' : undefined} />
              <Stat label={`Completed (${w.windowHours}h)`} value={num(w.totals.completed24h)} />
              <Stat label='Queue' value={`${w.queue.ready} ready · ${w.queue.leased} leased`} />
            </div>
            <div className='grid gap-6 lg:grid-cols-[1.4fr_1fr]'>
              <Panel title='Accounts' description='Each connected account and the work in its hands.'>
                {w.accounts.length === 0 ? (
                  <Empty>No account is connected to this project.</Empty>
                ) : (
                  <ul className='divide-y'>
                    {w.accounts.map((a) => (
                      <li key={a.accountId} className='flex flex-col gap-1.5 py-3'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='truncate text-sm font-medium'>{a.name}</span>
                          <StatusPill status={a.status} />
                        </div>
                        <p className='text-muted-foreground text-xs text-pretty'>{a.statusSentence}</p>
                        {a.current.map((job, i) => (
                          <p key={i} className='truncate text-xs'>
                            ▸ {job.title ?? job.routineName ?? 'Untitled work'}{' '}
                            {job.since && <span className='text-muted-foreground'>· <TimeAgo at={job.since} /></span>}
                          </p>
                        ))}
                        <p className='text-muted-foreground text-[11px] tabular-nums'>
                          {a.capacity.inFlight}/{a.capacity.limit ?? '?'} in flight · {a.last24h.completed} done · {a.last24h.failed} failed (24h)
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title='Movement' description='The latest events, newest first.'>
                {w.movement.length === 0 ? (
                  <Empty>Nothing moved in this window.</Empty>
                ) : (
                  <ol className='flex max-h-[28rem] flex-col gap-2 overflow-y-auto'>
                    {w.movement.slice(0, 40).map((m, i) => (
                      <li key={i} className='flex gap-3 text-xs'>
                        <span className='text-muted-foreground w-14 shrink-0'><TimeAgo at={m.at} /></span>
                        <span className='min-w-0 text-pretty'>
                          <b className='font-medium'>{m.accountName ?? 'Brain'}</b> {m.event.toLowerCase().replace(/_/g, ' ')}{' '}
                          {m.title && <span className='text-muted-foreground'>— {m.title}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </div>
          </>
        )}
      </QueryView>

      <Panel title='Working now and up next' action={<Freshness query={work} />}>
        <QueryView query={work}>
          {({ work: w }) => {
            const live = w.items.filter((i) => i.group === 'WORKING_NOW' || i.group === 'UP_NEXT');
            if (live.length === 0) return <Empty>{w.explanation ?? 'Nothing is running or queued right now.'}</Empty>;
            return (
              <ul className='divide-y'>
                {live.map((item) => (
                  <li key={item.id} className='flex items-start justify-between gap-3 py-2'>
                    <div className='min-w-0'>
                      <p className='truncate text-sm font-medium'>{item.title}</p>
                      <p className='text-muted-foreground line-clamp-1 text-xs'>
                        {item.waitingOn ?? item.why ?? ''}
                      </p>
                    </div>
                    <div className='flex shrink-0 flex-col items-end gap-1'>
                      <StatusPill status={item.group === 'WORKING_NOW' ? 'Working' : 'Up next'} tone={item.group === 'WORKING_NOW' ? 'good' : 'info'} />
                      <span className='text-muted-foreground text-[11px]'><TimeAgo at={item.updatedAt} /></span>
                    </div>
                  </li>
                ))}
              </ul>
            );
          }}
        </QueryView>
      </Panel>

      <Panel title='Capacity pools' action={<Freshness query={capacity} />}>
        <QueryView query={capacity}>
          {(c) =>
            !c.pools ? (
              <Empty>{c.note ?? 'No capacity reading yet.'}</Empty>
            ) : (
              <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
                {c.pools.map((p) => {
                  const used = p.capacity > 0 ? Math.min(100, Math.round((p.running / p.capacity) * 100)) : 0;
                  return (
                    <div key={p.pool} className='rounded-lg border p-3'>
                      <div className='flex items-center justify-between text-sm font-medium'>
                        <span>{p.pool.replace(/_/g, ' ').toLowerCase()}</span>
                        <span className='tabular-nums'>{p.running}/{p.capacity}</span>
                      </div>
                      <div className='bg-muted mt-2 h-1.5 overflow-hidden rounded-full'>
                        <div className='bg-primary h-full' style={{ width: `${used}%` }} />
                      </div>
                      <p className='text-muted-foreground mt-2 text-xs'>{p.waiting} waiting{p.idle && p.waiting > 0 ? ' · idle beside work' : ''}</p>
                    </div>
                  );
                })}
              </div>
            )
          }
        </QueryView>
      </Panel>
    </PageContainer>
  );
}
