'use client';
import PageContainer from '@/components/layout/page-container';
import { Empty, Facts, Freshness, Panel, QueryView, StatusPill, TimeAgo } from '@/components/brain/display';
import { ThemeModeToggle } from '@/components/themes/theme-mode-toggle';
import { Button } from '@/components/ui/button';
import { useBrain, useTool } from '@/hooks/use-brain';
import { useSession } from '@/hooks/use-session';
import { BrainError, post } from '@/lib/brain';
import type { Health, IntegrationsView, OperatorIntegrations } from '@/lib/types';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

export default function SettingsPage() {
  const session = useSession();
  const admin = !!session.data?.user?.isBrainAdmin;
  const health = useBrain<Health>('/api/health', { interval: 60_000 });
  const full = useBrain<IntegrationsView>(admin ? '/api/integrations' : null, { interval: 60_000 });
  const summary = useTool<OperatorIntegrations>(admin ? null : 'brain_operator_integrations');

  return (
    <PageContainer
      pageTitle='Settings & integrations'
      pageDescription='Your account, this Brain, and every service it is connected to with its latest health reading. Credentials are never shown.'
      pageHeaderAction={<Freshness query={admin ? full : summary} />}
    >
      <div className='grid gap-6 lg:grid-cols-2'>
        <Panel title='Account'>
          {session.data?.user && (
            <Facts
              items={[
                { label: 'Name', value: session.data.user.displayName },
                { label: 'Email', value: session.data.user.email ?? 'None (passkey account)' },
                { label: 'Role', value: session.data.user.isBrainAdmin ? 'Brain administrator' : 'Member' },
                { label: 'Appearance', value: <span className='inline-flex justify-end'><ThemeModeToggle /></span> }
              ]}
            />
          )}
          <p className='text-muted-foreground mt-3 text-xs'>
            Passkeys, PIN and devices are managed in the <a className='underline' href='/'>Brain console</a>.
          </p>
        </Panel>
        <Panel title='This Brain' action={<Freshness query={health} />}>
          <QueryView query={health}>
            {(h) => (
              <>
                <Facts
                  items={[
                    { label: 'Status', value: <StatusPill status={h.ok ? 'Healthy' : 'Unhealthy'} /> },
                    { label: 'Schema version', value: String(h.schemaVersion) },
                    ...(h.revision !== undefined ? [{ label: 'Revision', value: <span className='font-mono text-xs'>{h.revision?.slice(0, 12) ?? 'unstamped'}</span> }] : []),
                    ...(h.driver ? [{ label: 'Database', value: h.driver }] : [])
                  ]}
                />
                <ul className='mt-3 flex flex-col gap-1.5'>
                  {h.providers.map((p) => (
                    <li key={p.name} className='flex items-center justify-between gap-2 text-sm'>
                      <span>{p.name}{p.model ? <span className='text-muted-foreground'> · {p.model}</span> : null}</span>
                      <StatusPill status={p.available ? 'Available' : 'Unavailable'} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </QueryView>
        </Panel>
      </div>

      {admin ? <FullIntegrations query={full} /> : (
        <Panel title='Integrations'>
          <QueryView query={summary}>
            {(v) =>
              v.integrations.length === 0 ? (
                <Empty>No integration is registered.</Empty>
              ) : (
                <ul className='divide-y'>
                  {v.integrations.map((i) => (
                    <li key={i.id} className='flex items-start justify-between gap-3 py-3'>
                      <div className='min-w-0'>
                        <p className='text-sm font-medium'>{i.name}</p>
                        <p className='text-muted-foreground text-xs text-pretty'>{i.health?.detail ?? 'No health reading yet.'}</p>
                      </div>
                      <StatusPill status={i.health?.state ?? null} />
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryView>
        </Panel>
      )}
    </PageContainer>
  );
}

function FullIntegrations({ query }: { query: UseQueryResult<IntegrationsView, Error> }) {
  const client = useQueryClient();
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try {
      await post('/api/integrations/check');
      await client.invalidateQueries({ queryKey: ['brain', '/api/integrations'] });
      toast.success('Brain re-checked every integration.');
    } catch (e) {
      toast.error(e instanceof BrainError ? e.message : 'The check did not run.');
    } finally {
      setChecking(false);
    }
  }
  return (
    <Panel
      title='Integrations'
      description='Each connected service, what it lets Brain do, and its latest reading.'
      action={<Button size='sm' variant='outline' onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check now'}</Button>}
    >
      <QueryView query={query} rows={5}>
        {(v) => (
          <div className='flex flex-col gap-4'>
            {v.ownerActions.length > 0 && (
              <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300'>
                <p className='font-medium'>Needs you</p>
                <ul className='mt-1 list-disc pl-5 text-xs'>
                  {v.ownerActions.map((a) => <li key={a.integration}>{a.integration}: {a.action}</li>)}
                </ul>
              </div>
            )}
            <div className='grid gap-3 md:grid-cols-2'>
              {v.integrations.map((i) => (
                <div key={i.id} className='rounded-lg border p-3'>
                  <div className='flex items-start justify-between gap-2'>
                    <div className='min-w-0'>
                      <p className='text-sm font-medium'>{i.name}</p>
                      <p className='text-muted-foreground text-xs text-pretty'>{i.purpose}</p>
                    </div>
                    <StatusPill status={i.state} />
                  </div>
                  <p className='mt-2 text-xs text-pretty'>{i.detail}</p>
                  <div className='mt-2 flex flex-wrap gap-1'>
                    {i.credentials.map((c) => (
                      <StatusPill key={c.name} status={`${c.name}: ${c.state}`} tone={c.state === 'PRESENT' || c.state === 'ELSEWHERE' ? 'good' : c.required ? 'bad' : 'neutral'} className='font-mono text-[10px] normal-case' />
                    ))}
                  </div>
                  <p className='text-muted-foreground mt-2 text-[11px]'>Checked <TimeAgo at={i.lastCheck?.recordedAt ?? i.checkedAt} /></p>
                </div>
              ))}
            </div>
          </div>
        )}
      </QueryView>
    </Panel>
  );
}
