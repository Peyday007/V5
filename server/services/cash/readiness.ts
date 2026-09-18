/**
 * How many people have joined, and how much research capacity is usable.
 *
 * Two readings that Cash Mode once reported on its own page, both of which turn
 * out to be **Brain-wide account infrastructure** rather than anything about a
 * sprint. A person joins a Brain; a Claude Routine serves every project in it;
 * neither belongs to Cash and neither gates it (§32 removed the last count on
 * this surface that did). So they live on People & Capacity now, and this
 * module is what both surfaces read — one derivation, never two.
 *
 * Nothing here decides anything. It writes nothing, fires nothing, and
 * registers nothing.
 *
 * ---------------------------------------------------------------------------
 * Both halves were wrong, and they were wrong in the same way
 * ---------------------------------------------------------------------------
 *
 * The member count included the two identities `verify-hosted.ts` creates on
 * every deploy, because it counted `users` rows and asked nothing about what
 * they were. The capacity count reported `1 / 4 HEALTHY` while the dispatcher,
 * at the same instant, reported four eligible Routines — because it counted
 * **accounts** and the dispatcher fires **Routines**, and production runs four
 * research Routines under one account.
 *
 * Each half now comes from the module that owns the question:
 * `identity/people.ts` for who is a person, `fleet/capacity.ts` for what the
 * dispatcher would fire. Neither re-derives the other's answer, so the page and
 * the loop cannot disagree.
 */
import { peopleReading, type MemberState, type PersonReading } from '../identity/people.ts';
import { capacityReading, type CapacityReading } from '../fleet/capacity.ts';

export type { MemberState };

export interface MemberReadiness {
  userId: string;
  displayName: string;
  state: MemberState;
  linkExpiresAt?: string;
}

export interface CashReadiness {
  /**
   * People who have joined, out of the people who have been given a slot.
   *
   * The denominator is **how many member slots exist**, which is a fact about
   * rows, rather than the constant four it used to be. Four was the intended
   * topology written down as a number; a person reading `1 / 4` against a Brain
   * with two members concluded, correctly by the arithmetic and wrongly in
   * fact, that half the team was missing.
   */
  members: { ready: number; total: number; rows: MemberReadiness[] };
  /** The dispatcher's own reading, not a second opinion about it. */
  capacity: CapacityReading;
}

export async function cashReadiness(): Promise<CashReadiness> {
  const people = await peopleReading(null);
  const capacity = await capacityReading();
  const rows: MemberReadiness[] = people.people.map((one: PersonReading) => ({
    userId: one.userId,
    displayName: one.displayName,
    state: one.state,
    ...(one.linkExpiresAt ? { linkExpiresAt: one.linkExpiresAt } : {}),
  }));
  return {
    members: { ready: people.joined, total: rows.length, rows },
    capacity,
  };
}
