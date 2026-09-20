// @vitest-environment jsdom
/**
 * What an unauthenticated person actually sees, and what they must not.
 *
 * ---------------------------------------------------------------------------
 * Why this is a rendering test and not a reading of the source
 * ---------------------------------------------------------------------------
 *
 * The defect was a screen. `SignIn.tsx` rendered SIGN IN WITH YOUR DEVICE, then
 * OR WITH A PASSWORD, then EMAIL and PASSWORD — with a comment underneath
 * explaining that the password half was what the owner's own account still
 * used. Every server test passed the whole time, and would have gone on passing
 * if the form had simply been left there, because a form nobody is required to
 * post is invisible from the API.
 *
 * So the assertions are about the document: the fields are absent as *fields*,
 * found the way a person finds them, and the words are absent as words. A test
 * that grepped the file for `type="password"` would pass against a screen that
 * built the same input from a variable.
 *
 * ---------------------------------------------------------------------------
 * And why the recovery screen is asserted in the same file
 * ---------------------------------------------------------------------------
 *
 * Because the pair is the point. "No password on the sign-in screen" is only
 * half a design; the other half is that the account which still needs one can
 * reach it somewhere deliberate, and that the screen it reaches ends in a
 * device rather than in a Brain. Splitting them across two files would let
 * somebody delete the second and leave the first passing.
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

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const key = `${init?.method ?? 'GET'} ${url}`;
      calls.push(key);
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
   * A browser that can do passkeys. Without this the screen correctly renders
   * the "this browser cannot" sentence, and every assertion below would pass
   * against a screen nobody can use — which is the shape of green that hides a
   * broken product.
   */
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(window.navigator, 'credentials', {
    configurable: true,
    value: { create: async () => null, get: async () => null },
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

  it('offers one way in, and it is the device', () => {
    expect(screen.getByRole('button', { name: /sign in with your device/i })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('has no email field', () => {
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(document.querySelector('input[autocomplete="username"]')).toBeNull();
  });

  it('has no password field', () => {
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('has no input of any kind, which is the strongest way to say both', () => {
    // A field built from a variable would slip past a check for `type`. There
    // is nothing to type on this screen at all — a resident key names its own
    // account, so there is nothing a person could usefully be asked for.
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('does not say OR WITH A PASSWORD, or mention a password at all', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/or with a password/i);
    expect(text).not.toMatch(/password/i);
  });

  it('does not point anybody at the recovery machinery', () => {
    const text = document.body.textContent ?? '';
    // Internal recovery on the front door is the same mistake one step
    // quieter: it tells somebody probing that a second door exists and where.
    expect(text).not.toMatch(/recovery/i);
    expect(text).not.toMatch(/break.?glass/i);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('shows the server\'s own sentence when a device sign-in is refused', async () => {
    routes['POST /api/auth/passkey/options'] = {
      status: 401,
      body: { error: 'That did not sign you in. Try again, or ask for a recovery link.' },
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign in with your device/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/that did not sign you in/i)).toBeTruthy();
    });
    // Rendered as it arrived: the client does not interpret, soften or replace
    // a refusal the server deliberately made uninformative.
    expect(calls).toContain('POST /api/auth/passkey/options');
  });
});

describe('the sign-in screen when the browser cannot do passkeys', () => {
  it('says so, and still offers no password', () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    Object.defineProperty(window.navigator, 'credentials', {
      configurable: true,
      value: undefined,
    });
    render(<SignIn onSignedIn={() => {}} />);
    expect(screen.getByText(/cannot use passkeys/i)).toBeTruthy();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(document.body.textContent ?? '').not.toMatch(/password/i);
  });
});

describe('the recovery screen, which is where the password went', () => {
  it('asks for an address and a password, and says what it is for', () => {
    render(<Recovery onSignedIn={() => {}} />);
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(document.body.textContent ?? '').toMatch(/recovery/i);
    // It says plainly that this is not the ordinary way in, so nobody who
    // arrives by accident concludes it is.
    expect(document.body.textContent ?? '').toMatch(/not how you sign in/i);
  });

  it('ends in a device rather than in the Brain', async () => {
    routes['POST /api/auth/login'] = {
      body: { user: { id: 'usr_1', displayName: 'Owner', mustChangePassword: false } },
    };
    render(<Recovery onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'owner@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'owner-password-000001' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    });

    /*
     * The point of the whole screen. Getting in this way is not the outcome —
     * registering a device is, because that is what makes this door close.
     */
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /register this device/i })).toBeTruthy();
    });
    expect(screen.getByText(/password stops being accepted/i)).toBeTruthy();
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
  it('renders a password field in exactly one component, and it is the recovery one', async () => {
    /*
     * Read rather than rendered, because the claim is about everything that is
     * *not* on screen here. It classifies rather than bans — a file may talk
     * about a password, and this file does — so what it looks for is an input
     * that would collect one.
     *
     * `operatorConsoleRemoved` makes the same move for the same reason: what
     * must not exist is somewhere to type it, and no amount of rendering one
     * screen proves that about the other forty.
     */
    const files = await collectClientSources();
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/type="password"|type={'password'}/.test(source)) continue;
      if (file.endsWith('Recovery.tsx')) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the release gate', () => {
  it('reads the served sign-in screen, and is called', async () => {
    /*
     * Read rather than run: nothing in this suite executes `verify-hosted`, and
     * that is precisely how §33's missing `geography_basis` reached production
     * with the whole suite green. `sharedCashAccess` makes the same move for
     * the same reason — a check that exists and is never called is not a check.
     */
    const source = await readFile('scripts/verify-hosted.ts', 'utf8');
    expect(source).toContain('async function signInSurfaceIsDeviceOnly()');
    expect(source).toContain('await signInSurfaceIsDeviceOnly();');
    expect(source).toContain('OR WITH A PASSWORD');
  });
});

/** Every `.tsx` under the client, so a new screen is covered by being written. */
async function collectClientSources(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Relative to the working directory, which vitest sets to the repository
  // root — the same way every other jsdom suite here reads a source file.
  // `import.meta.url` is not a `file:` URL under jsdom, so resolving against
  // it produces `/client/src` or throws, neither of which is this directory.
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
