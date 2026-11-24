'use client';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, words } from '@/components/brain/display';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useBrain } from '@/hooks/use-brain';
import type { BacklogReading } from '@/lib/types';

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

/** The research backlog, classified from rows (server/services/research/backlog.ts). */
export function BacklogPanel() {
  const q = useBrain<BacklogReading>('/api/command/backlog', { interval: 60_000 });
  return (
    <Panel
      title='Research backlog'
      description='Every queued research idea, by what it is for, the goal it serves, its priority, whether it is obsolete, and how ideas of its kind actually turned out in the last 7 days.'
      action={<Freshness query={q} />}
    >
      <QueryView query={q} rows={5}>
        {(b) =>
          b.total === 0 ? (
            <Empty>No research idea is queued.</Empty>
          ) : (
            <div className='flex min-w-0 flex-col gap-5'>
              <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                <Stat label='Queued ideas' value={b.total} />
                <Stat label='Ready to launch' value={b.launchable} />
                <Stat label='Obsolete by the rows' value={b.obsolete} tone={b.obsolete > 0 ? 'warn' : undefined} hint='Retired automatically every 30 minutes' />
                <Stat label='Held' value={b.held} hint='Goal paused or deadline passed' />
              </div>

              <div className='min-w-0'>
                <h3 className='mb-2 text-sm font-medium'>By purpose</h3>
                <ul className='grid gap-3 lg:grid-cols-2'>
                  {b.categories.map((c) => {
                    const f = c.finished7d;
                    const finished = f.done + f.failed + f.cancelled;
                    return (
                      <li key={c.category} className='min-w-0 rounded-lg border p-3'>
                        <div className='flex flex-wrap items-start justify-between gap-2'>
                          <p className='min-w-0 flex-1 text-sm font-medium break-words'>{c.purpose}</p>
                          <span className='text-sm font-semibold tabular-nums'>{c.count}</span>
                        </div>
                        <p className='text-muted-foreground mt-1 text-xs break-words'>{c.contribution}</p>
                        <dl className='mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs'>
                          <dt className='text-muted-foreground'>Ready to launch</dt>
                          <dd className='tabular-nums'>{c.launchable}</dd>
                          <dt className='text-muted-foreground'>Obsolete</dt>
                          <dd className='tabular-nums'>{c.obsolete}</dd>
                          <dt className='text-muted-foreground'>Priority</dt>
                          <dd className='break-words'>{Object.entries(c.byPriority).map(([k, v]) => `${words(k)} ${v}`).join(' · ') || '—'}</dd>
                          <dt className='text-muted-foreground'>Last 7 days</dt>
                          <dd className='break-words'>
                            {finished === 0
                              ? 'none finished'
                              : `${f.done} done (${f.useful} filed a document), ${f.failed} failed, ${f.cancelled} cancelled · useful ${pct(f.useful, finished)}`}
                          </dd>
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className='min-w-0'>
                <h3 className='mb-2 text-sm font-medium'>By goal</h3>
                <div className='overflow-x-auto'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Goal</TableHead>
                        <TableHead className='text-right'>Queued</TableHead>
                        <TableHead className='text-right'>Obsolete</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {b.goals.map((g) => (
                        <TableRow key={g.goalId ?? 'none'}>
                          <TableCell className='max-w-[60vw] whitespace-normal break-words sm:max-w-md'>
                            <span className='text-sm'>{g.title}</span>{' '}
                            {g.state !== 'ACTIVE' && <StatusPill status={g.state} className='ml-1' />}
                          </TableCell>
                          <TableCell className='text-right tabular-nums'>{g.count}</TableCell>
                          <TableCell className='text-right tabular-nums'>{g.obsolete}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {b.obsoleteReasons.length > 0 && (
                <div className='min-w-0'>
                  <h3 className='mb-2 text-sm font-medium'>Obsolete or held, and why</h3>
                  <ul className='flex flex-col gap-1.5 text-sm'>
                    {b.obsoleteReasons.map((o) => (
                      <li key={o.reason} className='flex min-w-0 items-start gap-2'>
                        <span className='w-12 shrink-0 text-right font-semibold tabular-nums'>{o.count}</span>
                        <span className='min-w-0 break-words'>
                          {o.text}
                          <span className='text-muted-foreground'> — {o.retirable ? 'taken out of scheduling (row kept)' : 'kept: a person can undo the condition'}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <details className='text-xs'>
                <summary className='text-muted-foreground cursor-pointer'>Examples and limits of this reading</summary>
                <ul className='mt-2 flex flex-col gap-1'>
                  {b.samples.map((s, i) => (
                    <li key={i} className='break-words'>
                      <span className='text-muted-foreground'>{words(s.category)}:</span> {s.title} {s.obsolete && <StatusPill status={s.obsolete} className='ml-1' />}
                    </li>
                  ))}
                </ul>
                <ul className='text-muted-foreground mt-2 list-disc pl-5'>
                  {b.limits.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </details>
            </div>
          )
        }
      </QueryView>
    </Panel>
  );
}
