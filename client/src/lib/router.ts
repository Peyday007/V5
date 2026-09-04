/**
 * The smallest router that does the job.
 *
 * Written rather than installed, for two reasons. The routing this shell needs
 * is one path, a few segments and the back button — a dependency for that is
 * weight in a bundle somebody has to keep working. And the deploy budget for
 * this step is three mutations, so every new package is risk spent on something
 * that is not the product.
 *
 * Deep links are real links: `/work`, `/conversation/rcv_x` and `/legacy` are
 * addresses a person can bookmark, send to somebody, and reload onto. The server
 * already serves the app for any unknown path, so nothing here needs a hash.
 */
import { useCallback, useEffect, useState } from 'react';

/** Every place the shell can be. */
export type Route =
  | { name: 'HOME' }
  | { name: 'CONVERSATION'; conversationId: string }
  | { name: 'WORK' }
  | { name: 'PROJECTS' }
  | { name: 'KNOWLEDGE' }
  | { name: 'FLEET' }
  | { name: 'NEEDS_YOU' }
  | { name: 'LEGACY' }
  | { name: 'NOT_FOUND'; path: string };

/**
 * A path becomes a route, and an unknown one becomes `NOT_FOUND` rather than
 * silently becoming the home page. A stale bookmark that quietly showed
 * something else is how a person ends up believing they are looking at the
 * thing they asked for.
 */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'HOME' };
  switch (parts[0]) {
    case 'conversation':
      return parts[1] ? { name: 'CONVERSATION', conversationId: parts[1] } : { name: 'HOME' };
    case 'work':
      return { name: 'WORK' };
    case 'projects':
      return { name: 'PROJECTS' };
    case 'knowledge':
      return { name: 'KNOWLEDGE' };
    case 'fleet':
      return { name: 'FLEET' };
    case 'needs-you':
      return { name: 'NEEDS_YOU' };
    case 'legacy':
      return { name: 'LEGACY' };
    default:
      return { name: 'NOT_FOUND', path: pathname };
  }
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'HOME':
      return '/';
    case 'CONVERSATION':
      return `/conversation/${route.conversationId}`;
    case 'WORK':
      return '/work';
    case 'PROJECTS':
      return '/projects';
    case 'KNOWLEDGE':
      return '/knowledge';
    case 'FLEET':
      return '/fleet';
    case 'NEEDS_YOU':
      return '/needs-you';
    case 'LEGACY':
      return '/legacy';
    default:
      return route.path;
  }
}

export interface Navigation {
  route: Route;
  go(route: Route): void;
}

export function useRoute(): Navigation {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    // The back button has to work. Without this the URL changes and the screen
    // does not, which is worse than having no routing at all.
    const onPop = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next: Route) => {
    const path = pathFor(next);
    if (path !== window.location.pathname) window.history.pushState({}, '', path);
    setRoute(next);
  }, []);

  return { route, go };
}
