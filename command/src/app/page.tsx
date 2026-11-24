'use client';
import PageContainer from '@/components/layout/page-container';
import {
  Empty,
  Freshness,
  Panel,
  QueryView,
  Stat,
  StatusPill,
  TimeAgo,
  money,
  num
} from '@/components/brain/display';
import { Button } from '@/components/ui/button';
import { useBrain, useTool } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { enc } from '@/lib/brain';
import type { GoalBriefing, GoalView, Inbox, Utilization, WorkSummary } from '@/lib/types';
import Link from 'next/link';

export default function OverviewPage() {
  const { projectId } = useHomeProject();
  const summary = useBrain<{ summary: WorkSummary }>(
    projectId ? `/api/russell/summary?projectId=${enc(projectId)}` : '/api/russell/summary'
  );
  const goals = useBrain<{ briefing: GoalBriefing; goals: GoalView[] }>('/api/goals');
  const inbox = useBrain<Inbox>('/api/russell/needs-you/inbox');
  const capacity = useTool<Utilization>('brain_operator_capacity');

  return (
    <PageContainer
      pageTitle='Overview'
      pageDescription='What Brain is doing, what it has earned, and what needs you — read live from Brain.'
      pageHeaderAction={<Freshness query={summary} />}
    >
      <QueryView query={summary} rows={2}>
        {({ summary: s }) => (
          <>
            <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
              <Stat
                label='Received'
                value={s.figures.money ? money(s.figures.money.receivedCents, s.figures.money.currency) : '—'}
                hint={s.figures.money ? 'Customer payments on the ledger' : 'Your account has no full cash scope'}
              />
              <Stat
                label='Earned'
                value={s.figures.money ? money(s.figures.money.earnedCents, s.figures.money.currency) : '—'}
              />
              <Stat
                label='Unpaid costs'
                value={s.figures.money ? money(s.figures.money.unpaidCostsCents, s.figures.money.currency) : '—'}
                tone={s.figures.money && s.figures.money.unpaidCostsCents > 0 ? 'warn' : undefined}
              />
              <Stat
                label='Needs you'
                value={inbox.data ? num(inbox.data.items.length) : '—'}
                tone={inbox.data && inbox.data.items.length > 0 ? 'warn' : undefined}
                hint={<Link className='underline-offset-4 hover:underline' href='/approvals/'>Open approvals</Link>}
              />
            </div>
            <div className='grid gap-3 md:grid-cols-3'>
              {(
                [
                  ['Cash', s.cash, '/objectives/'],
                  ['Research', s.research, '/operations/'],
                  ['Build', s.build, '/agents/']
                ] as const
              ).map(([label, line, href]) => (
                <Panel key={label} title={label} action={line.retrying ? <StatusPill status='Retrying' /> : undefined}>
                  <p className='text-sm text-pretty'>{line.sentence}</p>
                  {line.detail && <p className='text-muted-foreground mt-2 text-xs text-pretty'>{line.detail}</p>}
                  <Button variant='link' className='mt-2 h-auto p-0' render={<Link href={href} />}>
                    Open →
                  </Button>
                </Panel>
              ))}
            </div>
          </>
        )}
      </QueryView>

      <div className='grid gap-6 lg:grid-cols-2'>
        <Panel title='Objectives' description='The goals Brain is working toward.' action={<Freshness query={goals} />}>
          <QueryView query={goals}>
            {({ briefing, goals: list }) => (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-pretty'>{briefing.headline}</p>
                <div className='grid grid-cols-3 gap-2 text-center sm:grid-cols-6'>
                  {Object.entries(briefing.counts).map(([k, v]) => (
                    <div key={k} className='bg-muted/50 rounded-md px-2 py-1.5'>
                      <div className='text-base font-semibold tabular-nums'>{v}</div>
                      <div className='text-muted-foreground text-[11px] capitalize'>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
                    </div>
                  ))}
                </div>
                {list.length === 0 ? (
                  <Empty>Brain has no goals recorded for the projects you can read.</Empty>
                ) : (
                  <ul className='divide-y'>
                    {list.slice(0, 6).map((g) => (
                      <li key={g.id} className='flex items-center justify-between gap-3 py-2'>
                        <Link href={`/objectives/?goal=${enc(g.id)}`} className='min-w-0 truncate text-sm font-medium hover:underline'>
                          {g.title}
                        </Link>
                        <StatusPill status={g.lifecycle} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </QueryView>
        </Panel>

        <Panel title='Needs you' description='Only what genuinely needs a person.' action={<Freshness query={inbox} />}>
          <QueryView query={inbox}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty>Nothing is waiting on you.</Empty>
              ) : (
                <ul className='divide-y'>
                  {data.items.slice(0, 6).map((item) => (
                    <li key={item.id} className='flex items-start justify-between gap-3 py-2'>
                      <div className='min-w-0'>
                        <p className='truncate text-sm font-medium'>{item.title}</p>
                        <p className='text-muted-foreground line-clamp-2 text-xs'>{item.reason}</p>
                      </div>
                      <StatusPill status={item.urgency} />
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryView>
        </Panel>
      </div>

      <Panel
        title='Capacity'
        description="Brain's pools of capacity and whether any is idle beside waiting work."
        action={<Freshness query={capacity} />}
      >
        <QueryView query={capacity}>
          {(c) =>
            !c.pools ? (
              <Empty>{c.note ?? 'Brain has no capacity reading yet.'}</Empty>
            ) : (
              <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
                {c.pools.map((p) => (
                  <div key={p.pool} className='rounded-lg border p-3'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='text-sm font-medium'>{p.pool.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase())}</span>
                      {p.idle && p.waiting > 0 ? <StatusPill status='Idle with work' tone='bad' /> : null}
                    </div>
                    <div className='mt-2 flex gap-4 text-xs'>
                      <span><b className='tabular-nums'>{p.running}</b> running</span>
                      <span><b className='tabular-nums'>{p.waiting}</b> waiting</span>
                      <span><b className='tabular-nums'>{p.capacity}</b> capacity</span>
                    </div>
                    <p className='text-muted-foreground mt-2 line-clamp-2 text-xs'>{p.because}</p>
                  </div>
                ))}
                <p className='text-muted-foreground text-xs sm:col-span-2 lg:col-span-4'>
                  {c.source === 'CACHED' ? 'Last complete reading, ' : 'Read '}
                  <TimeAgo at={c.readAt} />
                </p>
              </div>
            )
          }
        </QueryView>
      </Panel>
    </PageContainer>
  );
}
