/**
 * What the browser lands on.
 *
 * Two shells live in this application and this component decides which one a
 * person gets. The default is Russell. The old three-pane console is at
 * `/legacy` — reachable, unchanged, and no longer the front door.
 *
 * Authentication is settled here rather than twice, because both shells need
 * exactly the same answer and a second sign-in path is a second place for the
 * "who is this" question to be got wrong.
 */
import { useCallback, useEffect, useState } from 'react';
import { Api } from './lib/api.ts';
import type { SessionUser } from './lib/api.ts';
import { SignIn } from './components/SignIn.tsx';
import { useRoute } from './lib/router.ts';
import { RussellShell } from './russell/RussellShell.tsx';
import App from './App.tsx';

export default function Root(): JSX.Element {
  const navigation = useRoute();
  /**
   * `undefined` means "not asked yet" — a third state, and a necessary one.
   * Rendering the sign-in form while the answer is in flight flashes a login
   * screen at somebody who is already signed in.
   */
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const ask = useCallback(() => {
    void Api.session().then(
      (session) => setUser(session.user),
      () => setUser(null),
    );
  }, []);

  useEffect(ask, [ask]);

  if (user === undefined) {
    return <div className="rs-boot">Starting…</div>;
  }
  if (user === null || user.mustChangePassword) {
    return <SignIn onSignedIn={ask} pendingUser={user} />;
  }
  // The legacy console owns its own boot, health check and project loading, so
  // it is handed the whole screen rather than wrapped. That is deliberate: it
  // was working, and rewiring it to share this component's state is exactly the
  // kind of change that breaks the thing that was not being changed.
  if (navigation.route.name === 'LEGACY') return <App />;

  return <RussellShell navigation={navigation} user={user} onSignedOut={ask} />;
}
