import type { NavGroup } from '@/types';

/** The eleven Command Center pages. Visibility is not access: Brain's server decides every read. */
export const navGroups: NavGroup[] = [
  {
    label: 'Command',
    items: [
      { title: 'Overview', url: '/', icon: 'dashboard', shortcut: ['g', 'o'] },
      { title: 'Brain', url: '/conversation/', icon: 'brain', shortcut: ['g', 'c'] }
    ]
  },
  {
    label: 'Money',
    items: [
      { title: 'Financial objectives', url: '/objectives/', icon: 'target', shortcut: ['g', 'f'] },
      { title: 'Commercial plans', url: '/plans/', icon: 'route', shortcut: ['g', 'p'] },
      { title: 'Investment committee', url: '/committee/', icon: 'scale', shortcut: ['g', 'i'] },
      { title: 'Commercial knowledge', url: '/knowledge/', icon: 'brain', shortcut: ['g', 'k'] },
      { title: 'Budgets & approvals', url: '/approvals/', icon: 'wallet', shortcut: ['g', 'b'] }
    ]
  },
  {
    label: 'Operations',
    items: [
      { title: 'Live operations', url: '/operations/', icon: 'activity', shortcut: ['g', 'l'] },
      { title: 'Agents & tasks', url: '/agents/', icon: 'robot', shortcut: ['g', 'a'] },
      { title: 'Reports & audits', url: '/reports/', icon: 'report', shortcut: ['g', 'r'] },
      { title: 'Settings & integrations', url: '/settings/', icon: 'plug', shortcut: ['g', 's'] }
    ]
  }
];
