'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Failure, Freshness, Panel, QueryView, Stat, StatusPill, TimeAgo, words } from '@/components/brain/display';
import { ResourcesPanel } from '@/components/brain/resource-cards';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBrain } from '@/hooks/use-brain';
import type { InventoryItem, ReportsView, Section } from '@/lib/types';
import { useState } from 'react';

/**
 * Everything Brain has recorded about itself, read from what is stored — the
 * findings register, the engineering outcomes, the deficiencies, the operator's
 * runs, the hourly operations reports and the completed audits. Nothing here
 * generates a report or an audit.
 */
const CLOSED = new Set(['VERIFIED_FIXED', 'NOT_A_DEFECT', 'KNOWN_LIMITATION', 'EXTERNAL_CONSTRAINT']);

function SectionView<T>({ section, children }: { section: Section<T>; children: (value: T) => React.ReactNode }) {
  if (!section.ok) return <Failure error={new Error(`This part could not be read: ${section.error}`)} />;
  return <>{children(section.value)}</>;
}

function Expandable({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length < 240) return <p className='text-sm break-words whitespace-pre-wrap text-pretty'>{text}</p>;
  return (
    <div>
      <p className={`text-sm break-words whitespace-pre-wrap text-pretty ${open ? '' : lines === 2 ? 'line-clamp-2' : 'line-clamp-3'}`}>{text}</p>
      <button type='button' className='text-muted-foreground mt-1 text-xs underline-offset-4 hover:underline' onClick={() => setOpen(!open)}>
        {open ? 'Show less' : 'Show all'}
      </button>
    </div>
  );
}

function Finding({ item }: { item: InventoryItem }) {
  return (
    <li className='min-w-0 rounded-lg border p-3'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <p className='min-w-0 flex-1 text-sm font-medium break-words'>{item.capability}</p>
        <div className='flex gap-1.5'>
          <StatusPill status={item.severity} />
          <StatusPill status={item.status} />
        </div>
      </div>
      <div className='mt-1.5'>
        <Expandable text={item.symptom} />
      </div>
      {item.rootCause && <p className='text-muted-foreground mt-1.5 text-xs break-words'>Cause: {item.rootCause}</p>}
      {item.result && <p className='mt-1.5 text-xs break-words'>Result: {item.result}</p>}
      {item.verification && (
        <p className='mt-1 text-xs break-words text-emerald-700 dark:text-emerald-400'>
          Verified by {words(item.verification.kind)} {item.verification.ref}: {item.verification.detail}
        </p>
      )}
      <p className='text-muted-foreground mt-1.5 text-[11px]'>
        {item.id} · updated <TimeAgo at={item.updatedAt} />
      </p>
    </li>
  );
}

export default function ReportsPage() {
  const q = useBrain<ReportsView>('/api/command/reports', { interval: 60_000 });
  return (
    <PageContainer
      pageTitle='Reports & audits'
      pageDescription='What Brain found wrong with itself, what it fixed and verified, what is still open, its capacity reports, completed audits and every operator run.'
      pageHeaderAction={<Freshness query={q} />}
    >
      <QueryView query={q} rows={6}>
        {(r) => {
          const inventory = r.inventory.ok ? r.inventory.value : [];
          const open = inventory.filter((i) => !CLOSED.has(i.status));
          const verified = inventory.filter((i) => i.status === 'VERIFIED_FIXED');
          const engineering = r.engineering.ok ? r.engineering.value : [];
          const resolved = engineering.filter((e) => e.status === 'RESOLVED');
          return (
            <>
              <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
                <Stat label='Outstanding problems' value={r.inventory.ok ? open.length : '—'} tone={open.length > 0 ? 'warn' : undefined} />
                <Stat label='Verified fixes' value={r.inventory.ok ? verified.length + resolved.length : '—'} tone='good' />
                <Stat label='Deficiencies' value={r.deficiencies.ok ? r.deficiencies.value.length : '—'} />
                <Stat label='Completed audits' value={r.audits.ok ? r.audits.value.length : '—'} hint='most recent 40' />
              </div>
              <Tabs defaultValue='open'>
                <div className='max-w-full overflow-x-auto'>
                  <TabsList>
                    <TabsTrigger value='open'>Outstanding</TabsTrigger>
                    <TabsTrigger value='fixed'>Verified fixes</TabsTrigger>
                    <TabsTrigger value='engineering'>Engineering</TabsTrigger>
                    <TabsTrigger value='capacity'>Capacity</TabsTrigger>
                    <TabsTrigger value='audits'>Audits</TabsTrigger>
                    <TabsTrigger value='deficiencies'>Deficiencies</TabsTrigger>
                    <TabsTrigger value='runs'>Operator runs</TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value='open' className='mt-4'>
                  <SectionView section={r.inventory}>
                    {() => (open.length === 0 ? <Empty>No open finding in the register.</Empty> : <ul className='grid gap-3 lg:grid-cols-2'>{open.map((i) => <Finding key={i.id} item={i} />)}</ul>)}
                  </SectionView>
                </TabsContent>

                <TabsContent value='fixed' className='mt-4 flex flex-col gap-4'>
                  <SectionView section={r.inventory}>
                    {() => (verified.length === 0 ? <Empty>No finding is recorded as verified fixed.</Empty> : <ul className='grid gap-3 lg:grid-cols-2'>{verified.map((i) => <Finding key={i.id} item={i} />)}</ul>)}
                  </SectionView>
                  {resolved.length > 0 && (
                    <Panel title='Engineering changes that measured as resolved'>
                      <ul className='divide-y'>
                        {resolved.map((e) => (
                          <li key={e.candidateId} className='py-2 text-sm break-words'>
                            <span className='font-medium'>{e.title}</span> — {e.sentence}
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  )}
                </TabsContent>

                <TabsContent value='engineering' className='mt-4'>
                  <SectionView section={r.engineering}>
                    {(list) =>
                      list.length === 0 ? (
                        <Empty>No engineering outcome is recorded.</Empty>
                      ) : (
                        <ul className='grid gap-3 lg:grid-cols-2'>
                          {list.map((e) => (
                            <li key={e.candidateId} className='min-w-0 rounded-lg border p-3'>
                              <div className='flex flex-wrap items-start justify-between gap-2'>
                                <p className='min-w-0 flex-1 text-sm font-medium break-words'>{e.title}</p>
                                <StatusPill status={e.status} />
                              </div>
                              <div className='mt-1.5'><Expandable text={e.sentence} /></div>
                              <p className='text-muted-foreground mt-1.5 text-xs break-words'>
                                {words(e.intervention)} · stage {words(e.stage)}
                                {e.measurement ? ` · measured ${words(e.measurement.verdict)}` : ''}
                                {e.factory?.prUrl ? ' · ' : ''}
                                {e.factory?.prUrl && <a className='underline' href={e.factory.prUrl} target='_blank' rel='noreferrer'>pull request</a>}
                              </p>
                              <p className='mt-1 text-xs break-words'>Next: {e.next}</p>
                            </li>
                          ))}
                        </ul>
                      )
                    }
                  </SectionView>
                </TabsContent>

                <TabsContent value='capacity' className='mt-4 flex flex-col gap-4'>
                  <ResourcesPanel />
                  <Panel title='Hourly operations reports' description='The reports Brain recorded each hour, newest first.'>
                    <SectionView section={r.hourly}>
                      {(list) =>
                        list.length === 0 ? (
                          <Empty>No hourly report is recorded.</Empty>
                        ) : (
                          <ul className='flex flex-col gap-3'>
                            {list.map((h) => (
                              <li key={h.noticeId} className='min-w-0 rounded-lg border p-3'>
                                <p className='text-sm font-medium break-words'>{h.subject}</p>
                                <p className='text-muted-foreground text-[11px]'><TimeAgo at={h.readyAt} /></p>
                                <div className='mt-2'><Expandable text={h.text} lines={3} /></div>
                              </li>
                            ))}
                          </ul>
                        )
                      }
                    </SectionView>
                  </Panel>
                </TabsContent>

                <TabsContent value='audits' className='mt-4'>
                  <SectionView section={r.audits}>
                    {(list) =>
                      list.length === 0 ? (
                        <Empty>No audit is recorded in the projects you can read.</Empty>
                      ) : (
                        <ul className='grid gap-3 lg:grid-cols-2'>
                          {list.map((a) => (
                            <li key={a.id} className='min-w-0 rounded-lg border p-3'>
                              <div className='flex flex-wrap items-center justify-between gap-2'>
                                <span className='text-muted-foreground text-xs'><TimeAgo at={a.createdAt} /> · {words(a.mode)}</span>
                                <StatusPill status={a.verdict} />
                              </div>
                              <div className='mt-1.5'><Expandable text={a.summary} /></div>
                            </li>
                          ))}
                        </ul>
                      )
                    }
                  </SectionView>
                </TabsContent>

                <TabsContent value='deficiencies' className='mt-4'>
                  <SectionView section={r.deficiencies}>
                    {(list) =>
                      list.length === 0 ? (
                        <Empty>Brain has diagnosed no open deficiency.</Empty>
                      ) : (
                        <ul className='grid gap-3 lg:grid-cols-2'>
                          {list.map((d, i) => (
                            <li key={i} className='min-w-0 rounded-lg border p-3'>
                              <div className='flex flex-wrap items-start justify-between gap-2'>
                                <p className='min-w-0 flex-1 text-sm font-medium break-words'>{String(d.diagnosis.title ?? d.diagnosis.deficiency ?? 'Deficiency')}</p>
                                <StatusPill status={d.intervention} tone='info' />
                              </div>
                              {d.diagnosis.observed && <div className='mt-1.5'><Expandable text={String(d.diagnosis.observed)} /></div>}
                              <p className='text-muted-foreground mt-1.5 text-xs break-words'>{d.why}</p>
                            </li>
                          ))}
                        </ul>
                      )
                    }
                  </SectionView>
                </TabsContent>

                <TabsContent value='runs' className='mt-4 grid gap-4 lg:grid-cols-2'>
                  <Panel title='Operator runs'>
                    <SectionView section={r.runs}>
                      {(list) =>
                        list.length === 0 ? (
                          <Empty>No operator run is recorded.</Empty>
                        ) : (
                          <ul className='divide-y'>
                            {list.map((run) => (
                              <li key={run.id} className='flex min-w-0 flex-col gap-1 py-2'>
                                <div className='flex items-center justify-between gap-2'>
                                  <span className='text-muted-foreground text-xs'><TimeAgo at={run.startedAt} /> · {run.toolCalls.length} tool call(s)</span>
                                  <StatusPill status={run.state} />
                                </div>
                                <Expandable text={run.summary ?? run.error ?? 'No summary recorded.'} lines={2} />
                              </li>
                            ))}
                          </ul>
                        )
                      }
                    </SectionView>
                  </Panel>
                  <Panel title='What Brain learned'>
                    <SectionView section={r.learnings}>
                      {(list) =>
                        list.length === 0 ? (
                          <Empty>No learning is recorded.</Empty>
                        ) : (
                          <ul className='divide-y'>
                            {list.map((l) => (
                              <li key={l.id} className='py-2 text-sm break-words'>
                                {l.lesson}
                                <p className='text-muted-foreground text-xs break-words'>{l.evidence}</p>
                              </li>
                            ))}
                          </ul>
                        )
                      }
                    </SectionView>
                  </Panel>
                </TabsContent>
              </Tabs>
            </>
          );
        }}
      </QueryView>
    </PageContainer>
  );
}
