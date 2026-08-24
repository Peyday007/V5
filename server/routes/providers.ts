/**
 * Settings → Research Providers → Antigravity.
 *
 * Everything the connection page does, as ordinary endpoints: detect the tool,
 * check whether an account is signed in, run one real job to prove it works,
 * choose which model does which kind of work, turn paid overages on or off, and
 * disconnect.
 *
 * After the tool is installed and signed in, none of this needs a terminal.
 * What crosses to the browser is the four facts, the next action, and a
 * sanitized diagnostic trail — never credentials, never the environment, never
 * a raw CLI dump.
 */
import { Router } from 'express';
import {
  ANTIGRAVITY,
  connectionView,
  detectConnection,
  disconnect,
  testConnection,
  updateModelDefaults,
  updatePaidOverage,
} from '../services/providers/connection.ts';
import { badRequest, handler, optionalBoolean, optionalString } from './helpers.ts';

export const providersRouter = Router();

/** Only the providers Brain actually drives have a connection page. */
function requireProvider(value: string): string {
  const name = value.trim().toLowerCase();
  if (name !== ANTIGRAVITY) {
    throw badRequest(
      `There is no connection page for "${value}". Brain drives Antigravity as its research worker; ` +
        'other providers are configured with credentials rather than connected.',
    );
  }
  return name;
}

providersRouter.get(
  '/providers/connections/:provider',
  handler(async (req) => ({ connection: await connectionView(requireProvider(req.params.provider ?? '')) })),
);

/** Detect Antigravity, and Check Authentication: the same probe, re-run. */
providersRouter.post(
  '/providers/connections/:provider/detect',
  handler(async (req) => ({ connection: await detectConnection(requireProvider(req.params.provider ?? '')) })),
);

/**
 * Test Connection.
 *
 * Runs one real job. It is the only thing that proves the tool works on this
 * machine, so it is the only thing that marks the connection verified.
 */
providersRouter.post(
  '/providers/connections/:provider/test',
  handler(async (req) => await testConnection({ provider: requireProvider(req.params.provider ?? '') })),
);

providersRouter.post(
  '/providers/connections/:provider/disconnect',
  handler(async (req) => ({ connection: await disconnect(requireProvider(req.params.provider ?? '')) })),
);

providersRouter.patch(
  '/providers/connections/:provider/models',
  handler(async (req) => {
    const provider = requireProvider(req.params.provider ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      connection: await updateModelDefaults(provider, {
        light: optionalString(body['light'], 'light') ?? null,
        strong: optionalString(body['strong'], 'strong') ?? null,
      }),
    };
  }),
);

/**
 * Paid overages.
 *
 * Off unless the user says otherwise, here, explicitly. The note is theirs and
 * the timestamp is recorded, because "who turned this on and when" is the first
 * question anybody asks about a charge.
 */
providersRouter.post(
  '/providers/connections/:provider/paid-overage',
  handler(async (req) => {
    const provider = requireProvider(req.params.provider ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = optionalBoolean(body['enabled'], 'enabled');
    if (enabled === undefined) {
      throw badRequest('"enabled" must be true or false — paid overages are never changed by implication.');
    }
    return {
      connection: await updatePaidOverage(provider, enabled, optionalString(body['note'], 'note') ?? null),
    };
  }),
);
