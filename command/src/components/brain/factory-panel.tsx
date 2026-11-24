'use client';
/** The Factory as it is operating now, read from the line, the dispatcher's corrections and finished campaigns. */
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, words } from '@/components/brain/display';
import { shortTitle } from '@/components/brain/task-card';
import { useBrain } from '@/hooks/use-brain';
import type { FactoryOperations } from '@/lib/types';

export function FactoryPanel() {
  const q = useBrain<FactoryOperations>('/api/command/factory', { interval: 20_000 });
  return (
    <QueryView query={q} rows={5}>
      {({ line, corrections, completed }) => (
        <div className='flex min-w-0 flex-col gap-4'>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            <Stat label='Working now' value={line.active.leasedBins + line.active.arriving} hint={`${line.active.workingCampaigns} campaign(s) working`} tone={line.active.leasedBins > 0 ? 'good' : undefined} />
            <Stat label='Executable, waiting' value={line.executable.total} hint={`${line.executable.queued} queued objective(s), ${line.executable.readyBins} ready bin(s)`} />
            <Stat label='Free capable surfaces' value={line.capacity.freeSurfaces} />
            <Stat label='Unexplained idle' value={line.unexplainedIdle ? 'Yes' : 'No'} tone={line.unexplainedIdle ? 'bad' : 'good'} />
          </div>
          <Panel title='Why the line is or is not moving' action={<Freshness query={q} />}>
            <p className='text-sm break-words text-pretty'>{line.because}</p>
            {line.stranded && line.stranded.bins > 0 && (
              <ul className='mt-2 list-disc pl-5 text-sm text-red-700 dark:text-red-400'>
                {line.stranded.reasons.map((r) => <li key={r} className='break-words'>{r}</li>)}
              </ul>
            )}
            {line.waiting && line.waiting.bins > 0 && (
              <ul className='text-muted-foreground mt-2 list-disc pl-5 text-sm'>
                {line.waiting.reasons.map((r) => <li key={r} className='break-words'>{r}</li>)}
              </ul>
            )}
          </Panel>
          <Panel title='Campaigns in the line'>
            {line.campaigns.length === 0 ? (
              <Empty>No campaign is in the line.</Empty>
            ) : (
              <ul className='grid gap-3 lg:grid-cols-2'>
                {line.campaigns.map((c) => (
                  <li key={c.campaign.id} className='min-w-0 rounded-lg border p-3'>
                    <div className='flex flex-wrap items-start justify-between gap-2'>
                      <p className='min-w-0 flex-1 text-sm font-medium break-words'>{shortTitle(c.objective)}</p>
                      <StatusPill status={c.blocked ? `Blocked: ${c.blocked.kind}` : c.campaign.state} />
                    </div>
                    <p className='mt-1 text-xs break-words'>Next: {c.next}</p>
                    {c.blocked && <p className='text-muted-foreground mt-1 text-xs break-words'>{c.blocked.detail} Remedy: {c.blocked.remedy}</p>}
                    {c.elapsedMs !== null && <p className='text-muted-foreground mt-1 text-xs'>With a worker for {Math.round(c.elapsedMs / 60_000)} min</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title='Capacity' description='Surfaces that can take repository work, and why any is not taking it.'>
            <ul className='divide-y'>
              {line.capacity.surfaces.map((s) => (
                <li key={s.routineId} className='flex min-w-0 flex-wrap items-start justify-between gap-2 py-2'>
                  <div className='min-w-0'>
                    <p className='text-sm font-medium'>{s.routineName} <span className='text-muted-foreground font-normal'>· {s.accountName}</span></p>
                    {s.refusal && <p className='text-muted-foreground text-xs break-words'>{s.refusal}</p>}
                  </div>
                  <StatusPill status={s.free ? 'Free' : s.inFlight > 0 ? 'Working' : 'Unavailable'} tone={s.free ? 'good' : s.inFlight > 0 ? 'info' : 'warn'} />
                </li>
              ))}
            </ul>
          </Panel>
          <div className='grid gap-4 lg:grid-cols-2'>
            <Panel title='Automatic corrections (7 days)' description='What the dispatcher did about stranded work.'>
              {corrections.length === 0 ? (
                <Empty>No automatic correction was needed this week.</Empty>
              ) : (
                <ul className='divide-y'>
                  {corrections.map((c, i) => (
                    <li key={i} className='py-2 text-xs break-words'>
                      <span className='text-muted-foreground'><TimeAgo at={c.at} /> · {words(c.kind)}</span>
                      <p className='text-sm'>{c.reason ?? '—'}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title='Completed work'>
              {completed.length === 0 ? (
                <Empty>No campaign has finished.</Empty>
              ) : (
                <ul className='divide-y'>
                  {completed.map((c) => (
                    <li key={c.campaignId} className='py-2'>
                      <p className='text-sm break-words'>{shortTitle(c.objective)}</p>
                      <p className='text-muted-foreground text-xs break-words'>
                        <TimeAgo at={c.finishedAt} />
                        {c.stageDetail ? ` · ${c.stageDetail}` : ''}
                        {c.prUrl && <> · <a className='underline' href={c.prUrl} target='_blank' rel='noreferrer'>pull request</a></>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      )}
    </QueryView>
  );
}
