'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, num } from '@/components/brain/display';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useBrain } from '@/hooks/use-brain';
import { useHomeProject } from '@/hooks/use-homes';
import { enc } from '@/lib/brain';
import type { FactoryFleet, FleetView, GoalBriefing, GoalView, WorkEntry, WorkEntryFull, WorkResponse } from '@/lib/types';
import { TaskCard } from '@/components/brain/task-card';

const GROUPS: { key: WorkEntry['group']; label: string }[] = [
  { key: 'WORKING_NOW', label: 'Working now' },
  { key: 'UP_NEXT', label: 'Up next' },
  { key: 'WAITING', label: 'Waiting' },
  { key: 'EXPLORING', label: 'Exploring' },
  { key: 'FINISHED', label: 'Finished' }
];

export default function AgentsPage() {
  const { projectId } = useHomeProject();
  const fleet = useBrain<{ fleet: FleetView }>(projectId ? `/api/russell/projects/${enc(projectId)}/fleet` : null);
  const factory = useBrain<FactoryFleet>('/api/factory/fleet');
  const work = useBrain<WorkResponse>(projectId ? `/api/russell/projects/${enc(projectId)}/work?limit=200` : null);
  const goals = useBrain<{ briefing: GoalBriefing; goals: GoalView[] }>('/api/goals');

  return (
    <PageContainer
      pageTitle='Agents & tasks'
      pageDescription="Brain's agents — routines and Factory workers — and every task they hold, as Brain's queue records them."
      pageHeaderAction={<Freshness query={fleet} />}
    >
      <Tabs defaultValue='tasks'>
        <TabsList>
          <TabsTrigger value='tasks'>Tasks</TabsTrigger>
          <TabsTrigger value='routines'>Routines</TabsTrigger>
          <TabsTrigger value='factory'>Factory workers</TabsTrigger>
        </TabsList>

        <TabsContent value='tasks' className='mt-4'>
          <QueryView query={work} rows={6}>
            {({ work: w }) => {
              const items = w.items as WorkEntryFull[];
              if (items.length === 0) return <Empty>{w.explanation ?? 'Brain has no tasks for this project.'}</Empty>;
              const objectiveOf = (entry: WorkEntryFull): string | null => {
                const bin = entry.links.binId;
                if (!bin) return null;
                const goal = (goals.data?.goals ?? []).find((g) => (g.work ?? []).some((one) => one.binId === bin));
                return goal ? goal.title : null;
              };
              return (
                <div className='flex flex-col gap-6'>
                  {GROUPS.map((g) => {
                    const mine = items.filter((i) => i.group === g.key);
                    if (mine.length === 0) return null;
                    return (
                      <section key={g.key} className='min-w-0'>
                        <h2 className='mb-2 text-sm font-medium'>
                          {g.label} <span className='text-muted-foreground tabular-nums'>· {mine.length}</span>
                        </h2>
                        <ul className='grid min-w-0 gap-3 lg:grid-cols-2'>
                          {mine.slice(0, g.key === 'FINISHED' ? 20 : 60).map((entry) => (
                            <TaskCard key={entry.id} entry={entry} objective={objectiveOf(entry)} />
                          ))}
                        </ul>
                        {mine.length > (g.key === 'FINISHED' ? 20 : 60) && (
                          <p className='text-muted-foreground mt-2 text-xs'>
                            Showing the {g.key === 'FINISHED' ? 20 : 60} most recent of {mine.length}.
                          </p>
                        )}
                      </section>
                    );
                  })}
                </div>
              );
            }}
          </QueryView>
        </TabsContent>

        <TabsContent value='routines' className='mt-4'>
          <QueryView query={fleet} rows={4}>
            {({ fleet: f }) => (
              <div className='flex flex-col gap-4'>
                <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                  <Stat label='Usable / provisioned' value={`${f.usable} / ${f.provisioned}`} />
                  <Stat label='Active' value={num(f.active)} />
                  <Stat label='Cooling / unhealthy' value={`${f.cooling} / ${f.unhealthy}`} tone={f.unhealthy > 0 ? 'warn' : undefined} />
                  <Stat label='Backlog' value={`${f.backlog.ready} ready`} hint={`${f.backlog.leased} leased · ${f.backlog.needsHuman} need a person`} />
                </div>
                <Panel title='Bottleneck' description={f.bottleneckExplanation}>
                  <p className='text-sm'>{f.ifWeAddedCapacity}</p>
                </Panel>
                <Panel title='Routines' flush>
                  {f.surfaces.length === 0 ? (
                    <div className='px-4'><Empty>No routine is registered.</Empty></div>
                  ) : (
                    <div className='overflow-x-auto'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className='pl-4'>Routine</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead className='hidden md:table-cell'>Last outcome</TableHead>
                            <TableHead className='pr-4 text-right'>Last fired</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {f.surfaces.map((s) => (
                            <TableRow key={s.routineId}>
                              <TableCell className='pl-4'>
                                <p className='font-medium'>{s.name}</p>
                                <p className='text-muted-foreground text-xs'>{s.accountName}</p>
                                {s.requiredAction && <p className='text-xs text-amber-600 dark:text-amber-400'>{s.requiredAction.what}</p>}
                              </TableCell>
                              <TableCell><StatusPill status={s.stateLabel || s.state} tone={s.usable ? 'good' : undefined} /></TableCell>
                              <TableCell className='text-muted-foreground hidden max-w-60 truncate text-xs md:table-cell'>{s.lastOutcome}</TableCell>
                              <TableCell className='text-muted-foreground pr-4 text-right text-xs'><TimeAgo at={s.lastFiredAt} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>
              </div>
            )}
          </QueryView>
        </TabsContent>

        <TabsContent value='factory' className='mt-4'>
          <QueryView query={factory} rows={4}>
            {(f) => (
              <div className='flex flex-col gap-4'>
                <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                  <Stat label='Ready' value={f.ready ? 'Yes' : 'No'} tone={f.ready ? 'good' : 'warn'} hint={f.reason} />
                  <Stat label='Available / registered' value={`${f.capacity.available} / ${f.capacity.registered}`} />
                  <Stat label='Rate-limited' value={num(f.capacity.rateLimited)} />
                  <Stat label='Quarantined / paused' value={`${f.capacity.quarantined} / ${f.capacity.paused}`} />
                </div>
                <Panel title='Workers' flush>
                  {f.workers.length === 0 ? (
                    <div className='px-4'><Empty>No Factory worker is registered.</Empty></div>
                  ) : (
                    <div className='overflow-x-auto'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className='pl-4'>Worker</TableHead>
                            <TableHead>Availability</TableHead>
                            <TableHead className='hidden md:table-cell'>Model</TableHead>
                            <TableHead className='pr-4 text-right'>Concurrency</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {f.workers.map((w) => (
                            <TableRow key={w.id}>
                              <TableCell className='pl-4'>
                                <p className='font-medium'>{w.name}</p>
                                <p className='text-muted-foreground text-xs'>{w.kind.replace(/_/g, ' ').toLowerCase()}</p>
                              </TableCell>
                              <TableCell><StatusPill status={w.rateLimitedUntil ? 'Rate limited' : w.availability} /></TableCell>
                              <TableCell className='text-muted-foreground hidden text-xs md:table-cell'>{w.model}</TableCell>
                              <TableCell className='pr-4 text-right tabular-nums'>{w.maxConcurrency}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>
              </div>
            )}
          </QueryView>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
