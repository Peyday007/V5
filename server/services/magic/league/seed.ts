// The league workspace as data. An official precon list is loaded only from `officialLists.ts`,
// which carries the Wizards of the Coast source and date and is checked to add up to 100. A deck
// nobody has identified stays a named record labelled 'unverified cardlist'.
import type { OfficialDeckKey } from './officialLists.ts';

export type ListStatus = 'UNVERIFIED_CARDLIST' | 'VERIFIED_OFFICIAL_100' | 'VERIFIED_OFFICIAL_99_COMMANDER_UNKNOWN';

export interface SeedPlayer {
  readonly slot: number; // 0 = owner
  readonly label: string;
  readonly product: string | 'UNKNOWN';
  readonly commander: string | 'UNKNOWN';
  readonly provisional: boolean;
  readonly listStatus: ListStatus;
  readonly notes: readonly string[];
  /** The official list this player's baseline is, when it is known. */
  readonly official?: OfficialDeckKey;
  /** The commander the precon was printed with, kept apart from the one now in use. */
  readonly priorCommander?: string;
}

export const LEAGUE_NAME = 'Precon Commander League';

export const SEED_PLAYERS: readonly SeedPlayer[] = [
  { slot: 0, label: 'CHAOS INCARNATE', product: '2022 Starter Commander (Chaos Incarnate)', commander: 'Kardur, Doomscourge', provisional: false, listStatus: 'VERIFIED_OFFICIAL_100', official: 'CHAOS_INCARNATE', notes: ['Owner deck: the original unmodified precon, loaded from the official list. Earlier $10 lists were suggestions only and are not purchases.'] },
  { slot: 1, label: 'Red Foundations', product: 'UNKNOWN', commander: 'UNKNOWN', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Label confirmed; product, commander and list unknown.'] },
  { slot: 2, label: 'Other Chaos Incarnate (provisional)', product: '2022 Starter Commander (Chaos Incarnate)', commander: 'UNKNOWN', provisional: true, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Probably another Chaos Incarnate player; unverified and editable.'] },
  { slot: 3, label: 'Sky Warden / First Flight', product: '2022 First Flight', commander: 'UNKNOWN', provisional: false, listStatus: 'VERIFIED_OFFICIAL_99_COMMANDER_UNKNOWN', official: 'FIRST_FLIGHT', priorCommander: 'Isperia, Supreme Judge', notes: ['Player is changing commander, not deck. The stock 99 is loaded from the official list; the replacement commander is UNKNOWN until observed, and the printed commander is kept separately as prior context. Revalidate the 99 when the change is confirmed.'] },
  { slot: 4, label: 'Undead Girl / Grave Danger', product: '2022 Grave Danger', commander: 'Gisa and Geralf', provisional: false, listStatus: 'VERIFIED_OFFICIAL_100', official: 'GRAVE_DANGER', notes: ['Baseline is the official precon list. Observed noncombat life drain of roughly 3/6/9 per turn without attacks; the causing cards are NOT confirmed, and no purchases or trigger identity are assumed.'] },
  { slot: 5, label: 'Green Foundations', product: 'UNKNOWN', commander: 'UNKNOWN', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Product, commander and list unknown. Observed many creatures, which made Kardur\'s goad useful.'] },
  { slot: 6, label: 'Token Triumph', product: '2022 Token Triumph (Emmara)', commander: 'Emmara, Soul of the Accord', provisional: false, listStatus: 'VERIFIED_OFFICIAL_100', official: 'TOKEN_TRIUMPH', notes: ['Baseline is the official precon list.'] },
];

export const SEED_RULES = {
  podSize: 4,
  startingLife: 40,
  weeklyAllowanceCents: 1000,
  boosterOption: { packs: 2, userDescribed: '5/8 packs', setsConfirmed: false, blocksSingles: false },
  rollover: { confirmed: false, assumed: 'NONE' as const, accumulateUnconfirmedMoney: false },
  scoring: { firstTwoEliminations: 1, finalElimination: 2, creditTo: 'CONTROLLER_OF_CAUSING_SOURCE' as const },
  houseRulesPending: ['SIMULTANEOUS', 'COMMANDER_DAMAGE', 'ALTERNATE_LOSS'] as const,
} as const;

/** Idempotent seeding over a keyed store: existing keys are never touched, so edits survive. */
export function seedMissing<T extends { key: string }>(existing: ReadonlyMap<string, T>, wanted: readonly T[]): { readonly toInsert: T[]; readonly kept: number } {
  const toInsert = wanted.filter((w) => !existing.has(w.key));
  return { toInsert, kept: wanted.length - toInsert.length };
}

export const playerKey = (p: SeedPlayer): string => `league-seed:player:${p.slot}`;
