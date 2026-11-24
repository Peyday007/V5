'use client';
import { Separator } from '../ui/separator';
import SearchInput from '../search-input';
import { ThemeModeToggle } from '../themes/theme-mode-toggle';
import { SidebarToggle } from './sidebar-toggle';
import { navGroups } from '@/config/nav-config';
import { usePathname } from 'next/navigation';
import { isActivePath } from './app-sidebar';
import { useIsFetching } from '@tanstack/react-query';

export default function Header() {
  const pathname = usePathname();
  const current = navGroups.flatMap((g) => g.items).find((i) => isActivePath(pathname, i.url));
  const fetching = useIsFetching();
  return (
    <header className='flex h-14 shrink-0 items-center gap-3 border-b px-3 md:px-4'>
      <div className='flex min-w-0 flex-1 items-center'>
        <SidebarToggle />
        <Separator
          orientation='vertical'
          className='mr-3 ml-1.5 data-vertical:h-4 data-vertical:self-center'
        />
        <span className='truncate text-sm font-medium'>{current?.title ?? 'Brain'}</span>
      </div>
      <div className='flex shrink-0 items-center gap-1'>
        <span
          className='text-muted-foreground mr-2 hidden items-center gap-1.5 text-xs sm:flex'
          aria-live='polite'
        >
          <span
            className={`size-1.5 rounded-full ${fetching ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`}
          />
          {fetching ? 'Reading Brain…' : 'Live'}
        </span>
        <SearchInput />
        <ThemeModeToggle />
      </div>
    </header>
  );
}
