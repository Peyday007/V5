/**
 * A constant with no imports, so a browser-side test can read the same words
 * the server sends without loading the server's environment.
 */
export interface ConnectionScope {
  connects: string;
  doesNotConnect: string;
  factoryInstead: string;
}

/**
 * What "Your Claude connection" connects, said the same way to everybody.
 *
 * The friend onboarding journey had one sentence missing and it was the one
 * most likely to be misread. This page creates a personal **research** worker
 * (`research-…`), a membership on the shared frontier, and one Routine fired
 * for research work — and nothing about it puts that Claude account in the
 * Software Factory's pool. The Factory is one worker (`factory-brain`) served
 * by its own `Factory Brain` connector at `/mcp/factory`, its own Cowork
 * Routine, its own uniquely-named trigger secret, an account registration and
 * a worker binding an administrator writes, and a pinned proof. Nothing counts
 * a research connection as Factory capacity, and saying so here is what stops
 * a person believing their account already runs Factory work.
 */
export const CONNECTION_SCOPE: ConnectionScope = {
  connects:
    'This connects your Claude account as research capacity: a personal research worker, ' +
    'fired for research and general work in the projects you belong to.',
  doesNotConnect:
    'It does not add your account to the Software Factory. Nothing here is counted as Factory ' +
    'capacity, and finishing these steps does not let your account run Factory work.',
  factoryInstead:
    'A Factory account is a separate setup: a second connector named Factory Brain at this ' +
    'Brain’s /mcp/factory address, its own Cowork Routine with the repository attached, its own ' +
    'uniquely-named trigger secret, an account registration and worker binding a Brain ' +
    'administrator writes, and a pinned proof that a fire arrived as the Factory worker and ' +
    'finished. It is an administrator’s runbook — docs/workers/CONNECTING-THE-FACTORY-WORKER.md — ' +
    'and it only ever serves repositories this Brain has been authorized for, currently Brain itself.',
};
