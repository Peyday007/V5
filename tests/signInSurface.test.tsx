// @vitest-environment jsdom
/**
 * What an unauthenticated person actually sees, and what they must not.
 *
 * ---------------------------------------------------------------------------
 * Why this is a rendering test
 * ---------------------------------------------------------------------------
 *
 * Both defects this file has now been written for were **screens**, and both
 * were invisible from the API.
 *
 * The first was a password form under the device button, which no server test
 * could see because a form nobody is required to post does not exist to the
 * API. The second was the opposite and much worse: the device button on its
 * own, with nothing beside it, on an account that had never successfully
 * presented a device. Every server test passed — `/api/auth/passkey/verify`
 * works perfectly — and the owner could not get into their own Brain, because
 * their browser answered the WebAuthn request with *"the operation either
 * timed out or was not allowed"* and the screen had no second control.
 *
 * So what is asserted is the document: what a person can type, what they can
 * press, and what the screen does **not** demand of their hardware. A test that
 * read the source for `navigator.credentials` would pass against a screen that
 * called it from a helper.
 *
 * ---------------------------------------------------------------------------
 * And why the recovery screen is asserted in the same file
 * ---------------------------------------------------------------------------
 *
 * Because the pair is the point. "A PIN on the sign-in screen" is only half a
 * design; the other half is that an account which has no PIN yet can reach one,
 * with the credential it actually holds. Splitting them across two files would
 * let somebody delete the second and leave the first passing — which is, more
 * or less, exactly how the lockout happened.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SignIn } from '../client/src/components/SignIn.tsx';
import { Recovery } from '../client/src/components/Recovery.tsx';

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

beforeEach(() => {
  routes = {};
  calls = [];
  bodies = {};
  try {
    window.localStorage.clear();
  } catch {
    /* a browser without storage is one of the states under test */
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const key = `${init?.method ?? 'GET'} ${url}`;
      calls.push(key);
      if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body);
      const found = routes[key];
      const reply = typeof found === 'function' ? found() : found;
      if (!reply) {
        return new Response(JSON.stringify({ error: 'Not authorized.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  /*
   * A browser that *can* do passkeys.
   *
   * Stubbed deliberately, and it is the assertions' whole point that it
   * changes nothing: the screen must not reach for a device even where one is
   * available, because the owner's browser advertised the capability and then
   * refused the operation. "Supported" and "will work" are two facts, and this
   * screen is not allowed to depend on either.
   */
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    value: {
      create: async () => {
        throw new Error('credentials.create must not be called from the sign-in screen');
      },
      get: async () => {
        throw new Error('credentials.get must not be called from the sign-in screen');
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the sign-in screen an unauthenticated person lands on', () => {
  beforeEach(() => {
    render(<SignIn onSignedIn={() => {}} />);
  });

  it('asks for an identity and a six-digit PIN', () => {
    expect(screen.getByLabelText(/your name or email/i)).toBeTruthy();
    const pin = screen.getByLabelText(/six-digit pin/i) as HTMLInputElement;
    expect(pin).toBeTruthy();
    // Six, and digits: the field cannot be used to type anything else.
    expect(pin.maxLength).toBe(6);
    expect(pin.inputMode).toBe('numeric');
  });

  it('offers one thing to press, and it is a sign-in', () => {
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent ?? '').toMatch(/sign in/i);
  });

  it('does not say SIGN IN WITH YOUR DEVICE, or ask for one at all', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/sign in with your device/i);
    expect(text).not.toMatch(/face id|touch id|fingerprint|screen lock|passkey/i);
  });

  it('never touches the WebAuthn API, even where the browser has one', async () => {
    // The stub throws if it is called. A screen that reached for a device
    // "just in case" would fail here — which is the condition that locked the
    // owner out, asserted rather than trusted.
    routes['POST /api/auth/pin'] = { status: 401, body: { error: 'That did not sign you in.' } };
    fireEvent.change(screen.getByLabelText(/your name or email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    expect(calls).toEqual(['POST /api/auth/pin']);
  });

  it('sends exactly the identity and the PIN, and nothing about this device', async () => {
    routes['POST /api/auth/pin'] = {
      body: { user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false } },
    };
    fireEvent.change(screen.getByLabelText(/your name or email/i), {
      target: { value: ' owner@example.invalid ' },
    });
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '246813' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    expect(bodies['POST /api/auth/pin']).toEqual({
      identity: 'owner@example.invalid',
      pin: '246813',
    });
  });

  it('will not submit until six digits have been typed', () => {
    fireEvent.change(screen.getByLabelText(/your name or email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '12345' } });
    expect((screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '123456' } });
    expect((screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('refuses to hold anything but digits in the PIN box', () => {
    const pin = screen.getByLabelText(/six-digit pin/i) as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '12ab34cd56' } });
    expect(pin.value).toBe('123456');
  });

  it("shows the server's own sentence when a sign-in is refused", async () => {
    routes['POST /api/auth/pin'] = {
      status: 401,
      body: { error: 'That did not sign you in.' },
    };
    fireEvent.change(screen.getByLabelText(/your name or email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '000000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/that did not sign you in/i)).toBeTruthy();
    });
    // Rendered as it arrived. The server answers a wrong PIN, an unknown
    // identity and an account with no PIN identically on purpose, and a client
    // that tried to be more helpful would hand back the distinction.
    // The identity survives a refusal; retyping an address you have just typed
    // correctly is the friction that makes people give up on a typo.
    expect((screen.getByLabelText(/your name or email/i) as HTMLInputElement).value).toBe(
      'owner@example.invalid',
    );
  });

  it('does not point anybody at the recovery machinery', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/recovery/i);
    expect(text).not.toMatch(/break.?glass/i);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('the remembered identity, which is a convenience and not a credential', () => {
  it('shows one box on the next visit, and still asks for the PIN', async () => {
    routes['POST /api/auth/pin'] = {
      body: { user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false } },
    };
    const first = render(<SignIn onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/your name or email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/six-digit pin/i), { target: { value: '246813' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    });
    first.unmount();

    render(<SignIn onSignedIn={() => {}} />);
    expect(screen.queryByLabelText(/your name or email/i)).toBeNull();
    expect(screen.getByText(/owner@example.invalid/)).toBeTruthy();
    // The PIN is still asked for. Remembering a name is a saved form field; it
    // authenticates nobody and the server is never told about it.
    expect(screen.getByLabelText(/six-digit pin/i)).toBeTruthy();
  });

  it('forgets it when somebody says it is not them', async () => {
    window.localStorage.setItem('brain.lastIdentity', 'owner@example.invalid');
    render(<SignIn onSignedIn={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /not you/i }));
    });
    expect(screen.getByLabelText(/your name or email/i)).toBeTruthy();
    expect(window.localStorage.getItem('brain.lastIdentity')).toBeNull();
  });

  it('works in a browser whose storage throws', () => {
    // A private window, or site data blocked. The screen must be correct with
    // no storage at all rather than failing to render.
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: broken });
    render(<SignIn onSignedIn={() => {}} />);
    expect(screen.getByLabelText(/your name or email/i)).toBeTruthy();
    expect(screen.getByLabelText(/six-digit pin/i)).toBeTruthy();
  });
});

describe('the recovery screen, which is where a PIN comes from', () => {
  it('asks for the password the account already holds', () => {
    render(<Recovery onSignedIn={() => {}} />);
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(document.body.textContent ?? '').toMatch(/recovery/i);
    expect(document.body.textContent ?? '').toMatch(/not how you sign in/i);
  });

  it('ends in a PIN rather than in a device', async () => {
    routes['POST /api/auth/login'] = {
      body: {
        user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false, hasPin: false },
      },
    };
    render(<Recovery onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'owner-password-000001' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });

    /*
     * The step that locked the owner out was here, and it demanded a device.
     * What it must be is two boxes of digits and a save — nothing a browser or
     * an authenticator can refuse.
     */
    await waitFor(() => {
      expect(screen.getByLabelText(/create six-digit pin/i)).toBeTruthy();
    });
    expect(screen.getByLabelText(/confirm pin/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save and enter brain/i })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(
      /face id|touch id|fingerprint|screen lock|register this device/i,
    );
  });

  it('saves the PIN and says it is done', async () => {
    routes['POST /api/auth/login'] = {
      body: {
        user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false, hasPin: false },
      },
    };
    routes['POST /api/auth/pin/set'] = { body: { ok: true } };
    render(<Recovery onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => screen.getByLabelText(/create six-digit pin/i));

    fireEvent.change(screen.getByLabelText(/create six-digit pin/i), {
      target: { value: '246813' },
    });
    fireEvent.change(screen.getByLabelText(/confirm pin/i), { target: { value: '246813' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save and enter brain/i }));
    });

    expect(bodies['POST /api/auth/pin/set']).toEqual({ pin: '246813' });
    await waitFor(() => {
      expect(screen.getByText(/your pin is set/i)).toBeTruthy();
    });
  });

  it('refuses two PINs that are not the same, before asking the server', async () => {
    routes['POST /api/auth/login'] = {
      body: {
        user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false, hasPin: false },
      },
    };
    render(<Recovery onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'o@e.invalid' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => screen.getByLabelText(/create six-digit pin/i));

    fireEvent.change(screen.getByLabelText(/create six-digit pin/i), {
      target: { value: '246813' },
    });
    fireEvent.change(screen.getByLabelText(/confirm pin/i), { target: { value: '111111' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save and enter brain/i }));
    });
    expect(screen.getByText(/not the same/i)).toBeTruthy();
    expect(calls).not.toContain('POST /api/auth/pin/set');
  });

  it('says *replace* rather than *create* for an account that already has one', async () => {
    routes['POST /api/auth/login'] = {
      body: {
        user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false, hasPin: true },
      },
    };
    render(<Recovery onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'o@e.invalid' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/^new pin$/i)).toBeTruthy();
    });
  });

  it('takes an account carrying a temporary password to the change form first', () => {
    render(
      <Recovery
        onSignedIn={() => {}}
        pendingUser={{
          id: 'usr_1',
          email: 'owner@example.invalid',
          displayName: 'Owner',
          isBrainAdmin: true,
          mustChangePassword: true,
        }}
      />,
    );
    expect(screen.getByText(/password somebody else\s+chose/i)).toBeTruthy();
    expect(screen.getByLabelText(/^new password$/i)).toBeTruthy();
  });
});

describe('the rest of the shell', () => {
  it('asks no screen but the enrolment one to reach for a device', async () => {
    /*
     * Read rather than rendered, because the claim is about everything that is
     * *not* on screen here. `operatorConsoleRemoved` makes the same move for
     * the same reason: what must not exist cannot be proved by rendering one
     * screen out of forty.
     *
     * It classifies rather than bans, twice over. Registering a device is
     * still a thing a person may choose to do from *Your devices*; the two
     * link-spending screens still reach the enrolment call, and they spend it
     * on a PIN. What must not happen is a screen somebody has to get past
     * **requiring** hardware that can refuse.
     */
    const files = await collectClientSources();
    const allowed = ['Devices.tsx', 'Enrol.tsx', 'AcceptInvitation.tsx'];
    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.some((name) => file.endsWith(name))) continue;
      const source = await readFile(file, 'utf8');
      /*
       * A **call**, not a mention. The trailing `(` is the whole of the
       * difference: this file's own corrections are recorded in comments that
       * name `Passkeys.enrol`, and a check that banned the words would make
       * writing down what went wrong a test failure.
       */
      if (/Passkeys\.(signIn|enrol|enrolWithPin|addDevice)\s*\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders a password field in exactly one component, and it is the recovery one', async () => {
    const files = await collectClientSources();
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/type="password"/.test(source)) continue;
      if (file.endsWith('Recovery.tsx')) continue;
      /*
       * `SignIn` and `Enrol` hold one too, and it is a PIN box: `type="password"`
       * is what stops six digits being read over somebody's shoulder, and there
       * is no other input type that does it. What the check is really about is
       * a *password* being collected, so the two are told apart by the label
       * beside the field rather than by the type on it.
       */
      if (/SIX-DIGIT PIN|six-digit PIN|CONFIRM PIN|NEW PIN/.test(source)) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the PIN door in the release gate, and asserts it is called', async () => {
    // Read rather than run: nothing in this suite executes `verify-hosted`, and
    // that is precisely how §33's missing `geography_basis` reached production
    // with the whole suite green.
    const source = await readFile('scripts/verify-hosted.ts', 'utf8');
    expect(source).toContain('async function signInSurfaceAsksForAPin()');
    expect(source).toContain('await signInSurfaceAsksForAPin();');
    // And that it looks for the thing that actually locked somebody out.
    expect(source).toContain('SIGN IN WITH YOUR DEVICE');
    expect(source).toContain('SIX-DIGIT PIN');
  });

  /**
   * A refusal that names a remedy has to name the remedy that exists.
   *
   * `PASSWORD_DOOR_REFUSED` said *"this Brain signs people in with their
   * device"* — true when it was written, false from the moment the ordinary
   * credential became a PIN, and asserted by nothing, which is how it drifted.
   * The person most likely to read it is the one who has just mistyped their
   * password **at the recovery door**, on their way to creating a PIN: telling
   * them to use a device sends them back to the thing that locked them out.
   *
   * It is held to the credential rather than to a sentence, so rewording it is
   * free and pointing it at a door the product does not offer is not.
   */
  it('refuses a password by naming the credential the screen actually asks for', async () => {
    /*
     * Read rather than imported: this suite runs under jsdom, where
     * `server/env.ts` cannot resolve `import.meta.url` as a file URL, so the
     * whole server module graph is unreachable from here. The string is what
     * is being asserted, and the string is in the file.
     */
    const source = await readFile('server/services/identity/passwordDoor.ts', 'utf8');
    const sentence = /export const PASSWORD_DOOR_REFUSED =\s*'([^']+)'/.exec(source)?.[1];
    expect(sentence).toBeTruthy();
    expect(sentence).toMatch(/PIN/);
    expect(sentence).not.toMatch(/device|passkey|Face ID|Touch ID/i);
    // Still one sentence that names no account and no reason: what failed is
    // exactly what somebody probing would like to know.
    expect(sentence).not.toMatch(/@|exist|disabled|unknown|wrong/i);
  });
});

/** Every `.tsx` under the client, so a new screen is covered by being written. */
async function collectClientSources(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Relative to the working directory, which vitest sets to the repository
  // root — the same way every other jsdom suite here reads a source file.
  const root = 'client/src';
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.tsx')) out.push(full);
    }
  }
  await walk(root);
  return out;
}
