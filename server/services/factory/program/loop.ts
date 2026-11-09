/**
 * Programs ride the remote loop's timer, at most once a minute.
 *
 * A program tick is reads, plus a loopback check per requirement whose answer
 * is not yet known at the running revision — cheap, but there is no reason to
 * do it every twenty seconds when a campaign moves in minutes.
 */
import { tickAllPrograms, type ProgramTickReport } from './coordinator.ts';
import { productionPorts } from './ports.ts';

export const PROGRAM_TICK_EVERY_MS = 60_000;
let lastTick = 0;

export async function tickAllProgramsIfDue(now = Date.now()): Promise<ProgramTickReport[]> {
  if (now - lastTick < PROGRAM_TICK_EVERY_MS) return [];
  lastTick = now;
  return tickAllPrograms(productionPorts());
}
