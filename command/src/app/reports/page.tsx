'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Freshness, Panel, QueryView, StatusPill, TimeAgo, words } from '@/components/brain/display';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTool } from '@/hooks/use-brain';
import type { Deficiency, EngineeringOutcome, OperatorHistory } from '@/lib/types';

/**
 * Brain's own reports on itself: the deficiencies it has diagnosed, the
 * engineering it commissioned and whether it measured an effect, and the
 * operator's run history with what it learned. Operator reads — Brain refuses
 * them to an account without operator rights, and this page says so.
 */
export default function ReportsPage() {
  const deficiencies = useTool<{ deficiencies: Deficiency[] }>('brain_operator_deficiencies');
  const engineering = useTool<{ engineering: EngineeringOutcome[] }>('brain_operator_engineering');
  const history = useTool<OperatorHistory>('brain_operator_history');

  return (
    <PageContainer
      pageTitle='Reports & audits'
      pageDescription='What Brain found wrong with itself, what it changed, whether the change measured, and the record of every operator run.'
      pageHeaderAction={<Freshness query={engineering} />}
    >
      <Tabs defaultValue='engineering'>
        <TabsList>
          <TabsTrigger value='engineering'>Engineering</TabsTrigger>
          <TabsTrigger value='deficiencies'>Deficiencies</TabsTrigger>
          <TabsTrigger value='history'>Operator runs</TabsTrigger>
        </TabsList>

        <TabsContent value='engineering' className='mt-4'>
          <QueryView query={engineering} rows={5}>
            {({ engineering: list }) =>
              list.length === 0 ? (
                <Empty>No engineering outcome is recorded.</Empty>
              ) : (
                <div className='grid gap-4 md:grid-cols-2'>
                  {list.map((e) => (
                    <Panel key={e.candidateId} title={e.title} action={<StatusPill status={e.status} />}>
                      <p className='text-sm text-pretty'>{e.sentence}</p>
                      <div className='text-muted-foreground mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs'>
                        <span>{words(e.intervention)}</span>
                        <span>Stage: {words(e.stage)}</span>
                        {e.measurement && <span>Measured: {words(e.measurement.verdict)}</span>}
                        {e.factory?.prUrl && (
                          <a className='underline' href={e.factory.prUrl} target='_blank' rel='noreferrer'>
                            Pull request
                          </a>
                        )}
                      </div>
                      <p className='mt-2 text-xs text-pretty'><span className='text-muted-foreground'>Next: </span>{e.next}</p>
                    </Panel>
                  ))}
                </div>
              )
            }
          </QueryView>
        </TabsContent>

        <TabsContent value='deficiencies' className='mt-4'>
          <QueryView query={deficiencies} rows={5}>
            {({ deficiencies: list }) =>
              list.length === 0 ? (
                <Empty>Brain has diagnosed no open deficiency.</Empty>
              ) : (
                <Panel title={`${list.length} open deficiencies`}>
                  <ul className='divide-y'>
                    {list.map((d) => (
                      <li key={d.id} className='flex flex-col gap-1 py-3'>
                        <div className='flex items-start justify-between gap-3'>
                          <span className='text-sm font-medium text-pretty'>{d.title}</span>
                          <StatusPill status={d.intervention} tone='info' />
                        </div>
                        <p className='text-muted-foreground text-xs text-pretty'>{d.observed}</p>
                        <p className='text-xs text-pretty'>{d.why}</p>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )
            }
          </QueryView>
        </TabsContent>

        <TabsContent value='history' className='mt-4'>
          <QueryView query={history} rows={5}>
            {(h) => (
              <div className='grid gap-6 lg:grid-cols-2'>
                <Panel title='Runs'>
                  {h.runs.length === 0 ? (
                    <Empty>No operator run is recorded.</Empty>
                  ) : (
                    <ul className='divide-y'>
                      {h.runs.map((r) => (
                        <li key={r.id} className='flex flex-col gap-1 py-2'>
                          <div className='flex items-center justify-between gap-2'>
                            <span className='text-muted-foreground text-xs'><TimeAgo at={r.startedAt} /></span>
                            <StatusPill status={r.state} />
                          </div>
                          <p className='text-sm text-pretty'>{r.summary ?? 'No summary recorded.'}</p>
                          {r.tools.length > 0 && <p className='text-muted-foreground truncate text-[11px]'>{r.tools.join(', ')}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
                <Panel title='What Brain learned'>
                  {h.learnings.length === 0 ? (
                    <Empty>No learning is recorded.</Empty>
                  ) : (
                    <ul className='divide-y'>
                      {h.learnings.map((l, i) => (
                        <li key={i} className='flex flex-col gap-1 py-2'>
                          <p className='text-sm text-pretty'>{l.lesson}</p>
                          <p className='text-muted-foreground text-xs text-pretty'>{l.evidence} · <TimeAgo at={l.at} /></p>
                        </li>
                      ))}
                    </ul>
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
