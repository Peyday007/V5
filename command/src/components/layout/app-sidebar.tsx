'use client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar';
import { navGroups } from '@/config/nav-config';
import type { SessionUser } from '@/hooks/use-session';
import { post } from '@/lib/brain';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icons } from '../icons';

const itemClass =
  'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:hover:bg-sidebar-accent [&>svg]:text-sidebar-foreground/60 data-active:[&>svg:first-child]:text-sidebar-primary';
const railPadding = 'group-data-[collapsible=icon]:px-1';

export function isActivePath(pathname: string, url: string) {
  const norm = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  if (url === '/') return norm(pathname) === '/';
  return norm(pathname).startsWith(norm(url));
}

export default function AppSidebar({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible='icon' variant='inset'>
      <SidebarHeader className={railPadding}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size='lg' render={<Link href='/' />}>
              <div className='bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg'>
                <Icons.brain className='size-4' />
              </div>
              <div className='grid flex-1 text-left text-sm leading-tight'>
                <span className='truncate font-semibold'>Brain</span>
                <span className='text-muted-foreground truncate text-xs'>Command Center</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className='overflow-x-hidden'>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label} className={railPadding}>
            <SidebarGroupLabel className='group-data-[collapsible=icon]:pointer-events-none'>
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu className='gap-0.5'>
              {group.items.map((item) => {
                const Icon = item.icon ? Icons[item.icon] : Icons.logo;
                const active = isActivePath(pathname, item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={<Link href={item.url} aria-current={active ? 'page' : undefined} />}
                      tooltip={item.title}
                      isActive={active}
                      className={itemClass}
                      onClick={() => setOpenMobile(false)}
                    >
                      <Icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className={railPadding}>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail className='hover:after:bg-transparent' />
    </Sidebar>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function NavUser({ user }: { user: SessionUser }) {
  const client = useQueryClient();
  const { isMobile } = useSidebar();
  async function signOut() {
    try {
      await post('/api/auth/logout');
    } finally {
      await client.invalidateQueries();
    }
  }
  const avatar = (
    <>
      <div className='bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium'>
        {initials(user.displayName) || '·'}
      </div>
      <div className='grid flex-1 text-left text-sm leading-tight'>
        <span className='truncate font-medium'>{user.displayName}</span>
        <span className='text-muted-foreground truncate text-xs'>
          {user.isBrainAdmin ? 'Brain administrator' : (user.email ?? 'Member')}
        </span>
      </div>
    </>
  );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size='lg'
                className='data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground'
              />
            }
          >
            {avatar}
            <Icons.chevronsUpDown className='text-muted-foreground ml-auto size-4' />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className={isMobile ? 'w-(--anchor-width) min-w-60' : 'w-64'}
            side={isMobile ? 'top' : 'right'}
            align='end'
            sideOffset={8}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className='text-foreground flex items-center gap-2 px-1.5 py-1.5 font-normal'>
                {avatar}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<a href='/' />}>
                <Icons.externalLink />
                Open the full Brain console
              </DropdownMenuItem>
              <DropdownMenuItem onClick={signOut}>
                <Icons.logout aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
