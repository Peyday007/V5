'use client';
import KBar from '@/components/kbar';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import SignIn from '@/components/layout/sign-in';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/hooks/use-session';
import type { CSSProperties } from 'react';

/**
 * The gate a page sits behind. The shell holds no data; this only decides
 * whether to ask for a sign-in. Every row is still authorized by Brain's
 * server on every request, whatever this component decides.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();

  if (session.isPending) {
    return (
      <div className='flex h-dvh items-center justify-center' role='status' aria-label='Loading'>
        <Skeleton className='h-8 w-48' />
      </div>
    );
  }
  if (session.isError || !session.data?.authenticated || !session.data.user) {
    return <SignIn error={session.error?.message ?? null} />;
  }

  if (session.data.user.mustChangePassword) {
    return (
      <main className='flex min-h-dvh items-center justify-center p-4'>
        <div className='max-w-sm rounded-xl border p-6 text-center'>
          <p className='font-medium'>Choose a new password first</p>
          <p className='text-muted-foreground mt-2 text-sm'>
            Brain will not serve this account until its password is changed.
          </p>
          <a className='mt-4 inline-block text-sm underline' href='/'>
            Change it in Brain
          </a>
        </div>
      </main>
    );
  }

  return (
    <KBar>
      <SidebarProvider
        defaultOpen
        className='h-dvh'
        style={{ '--sidebar-width-icon': '2.375rem' } as CSSProperties}
      >
        <a
          href='#main-content'
          className='bg-background ring-ring sr-only rounded-md px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:ring-2'
        >
          Skip to content
        </a>
        <AppSidebar user={session.data.user} />
        <SidebarInset
          id='main-content'
          tabIndex={-1}
          className='md:ring-foreground/10 min-h-0 min-w-0 overflow-hidden outline-none md:ring-1'
        >
          <Header />
          <div
            data-slot='page-scroller'
            className='flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto'
          >
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </KBar>
  );
}
