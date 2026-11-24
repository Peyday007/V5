'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, num } from '@/components/brain/display';
import { useBrain, useTool } from '@/hooks/use-brain';
import { ResourcesPanel } from '@/components/brain/resource-cards';
import { BacklogPanel } from '@/components/brain/backlog-panel';
import { shortTitle } from '@/components/brain/task-card';
import { useHomeProject } from '@/hooks/use-homes';
import { enc } from '@/lib/brain';
import type { GpuStatus, Utilization, WorkforceView, WorkResponse } from '@/lib/types';

const usd = (n: number | null | undefined, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `$${n.toFixed(digits)}`);

const WORK_STATE: Record<GpuStatus['work']['state'], string> = {
  BUSY: 'Busy',
  IDLE_WITH_WORK: 'Idle beside waiting work',
  IDLE_NO_WORK: 'Idle, nothing waiting',
  STOPPED_NO_WORK: 'Stopped, nothing waiting',
  STOPPED_WITH_WORK: 'Stopped with work waiting',
  UNKNOWN: 'Not read yet'
};

function GpuPanel({ gpu }: { gpu: GpuStatus }) {
  const running = gpu.pod.status === 'RUNNING';
  const bad = gpu.work.state === 'IDLE_WITH_WORK' || gpu.work.state === 'STOPPED_WITH_WORK';
  return (
    <div className='flex flex-col gap-4'>
      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        <Stat
          label='Pod'
          value={<StatusPill status={running ? (gpu.pod.ready ? 'Serving' : 'Loading') : gpu.pod.status} tone={running && gpu.pod.ready ? 'good' : running ? 'warn' : undefined} />}
          hint={`${gpu.pod.card ?? 'card not recorded'}${gpu.pod.id ? ` · ${gpu.pod.id}` : ''}`}
        />
        <Stat
          label='Rate'
          value={`${usd(gpu.pod.costPerHr)}/h`}
          hint={gpu.authorization ? `authorized up to ${usd(gpu.authorization.usdPerHour)}/h, one card` : 'no standing authorization'}
        />
        <Stat
          label='Spend'
          value={usd(gpu.spend.todayUsd)}
          hint={`today · ${usd(gpu.spend.sinceAuthorizationUsd)} since authorization${gpu.authorization?.since ? ` (${gpu.authorization.since.slice(0, 10)})` : ''}`}
        />
        <Stat
          label='RunPod balance'
          value={usd(gpu.balanceUsd)}
          tone={gpu.balanceUsd !== null && gpu.authorization && gpu.balanceUsd < gpu.authorization.replenishAtUsd ? 'warn' : undefined}
          hint={gpu.authorization ? `replenishes at ${usd(gpu.authorization.replenishAtUsd, 0)} · stops under ${usd(gpu.authorization.balanceFloorUsd, 0)}` : undefined}
        />
        <Stat label='Work' value={WORK_STATE[gpu.work.state]} tone={bad ? 'bad' : gpu.work.state === 'BUSY' ? 'good' : undefined} hint={`${num(gpu.work.waiting)} waiting · ${num(gpu.work.inFlight)} in flight`} />
        <Stat label='Concurrency' value={num(gpu.work.slotTarget)} hint={gpu.work.slotReason ?? 'the lane controller’s target for the GPU slot'} />
        <Stat
          label='Jobs per running hour'
          value={num(gpu.work.jobsPerRunningHour24h)}
          hint={`${num(gpu.work.runningHours24h)} h running in 24 h`}
        />
        <Stat
          label='Accepted'
          value={num(gpu.work.accepted24h)}
          hint={`24 h · ${num(gpu.work.acceptedLastHour)} in the last hour · ${gpu.work.acceptedPerDollar24h === null ? '—' : num(gpu.work.acceptedPerDollar24h)} per $`}
        />
      </div>
      {gpu.restrictions.length === 0 ? (
        <p className='text-muted-foreground text-xs'>No restriction is active.</p>
      ) : (
        <ul className='flex flex-col gap-1 text-xs'>
          {gpu.restrictions.map((r) => (
            <li key={r} className='text-pretty'>▸ {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OperationsPage() {
  const { projectId, homes } = useHomeProject();
  const workforce = useBrain<{ workforce: WorkforceView }>(
    projectId ? `/api/russell/projects/${enc(projectId)}/workforce` : null,
    { interval: 15_000 }
  );
  const capacity = useTool<Utilization>('brain_operator_capacity', {}, { interval: 20_000 });
  const work = useBrain<WorkResponse>(projectId ? `/api/russell/projects/${enc(projectId)}/work?limit=60` : null, {
    interval: 15_000
  });

  return (
    <PageContainer
      pageTitle='Live operations'
      pageDescription='What is running right now, who is running it, what each resource is limited by, and what the research backlog holds. Re-read continuously.'
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
                          <p key={i} className='text-xs break-words'>
                            ▸ {job.title ? shortTitle(job.title) : (job.routineName ?? 'Untitled work')}{' '}
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
                          {m.title && <span className='text-muted-foreground'>— {shortTitle(m.title)}</span>}
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
                      <p className='text-sm font-medium break-words'>{shortTitle(item.title)}</p>
                      <p className='text-muted-foreground text-xs break-words'>
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

      <Panel
        title='GPU'
        description='Brain’s own GPU: what it is, what it costs, what it is doing, and what holds it back.'
        action={<Freshness query={capacity} />}
      >
        <QueryView query={capacity}>
          {(c) => (c.gpu ? <GpuPanel gpu={c.gpu} /> : <Empty>No GPU reading yet.</Empty>)}
        </QueryView>
      </Panel>

      <ResourcesPanel />
      <BacklogPanel />
    </PageContainer>
  );
}
