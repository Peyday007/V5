// The league workspace as data. Nothing here is a card list: an official precon list is loaded
// only when it validates to 100 with a cited source and date, and none has been verified here,
// so every deck is a named record labelled 'unverified cardlist' until one is.
export type ListStatus = 'UNVERIFIED_CARDLIST' | 'VERIFIED_OFFICIAL_100';

export interface SeedPlayer {
  readonly slot: number; // 0 = owner
  readonly label: string;
  readonly product: string | 'UNKNOWN';
  readonly commander: string | 'UNKNOWN';
  readonly provisional: boolean;
  readonly listStatus: ListStatus;
  readonly notes: readonly string[];
}

export const LEAGUE_NAME = 'Precon Commander League';

export const SEED_PLAYERS: readonly SeedPlayer[] = [
  { slot: 0, label: 'CHAOS INCARNATE', product: '2022 Starter Commander (Chaos Incarnate)', commander: 'Kardur, Doomscourge', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Owner deck, original unmodified precon. Official 100 not yet verified with source and date; not loaded.'] },
  { slot: 1, label: 'Red Foundations', product: 'UNKNOWN', commander: 'UNKNOWN', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Label confirmed; product, commander and list unknown.'] },
  { slot: 2, label: 'Other Chaos Incarnate (provisional)', product: '2022 Starter Commander (Chaos Incarnate)', commander: 'UNKNOWN', provisional: true, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Probably another Chaos Incarnate player; unverified and editable.'] },
  { slot: 3, label: 'Sky Warden / First Flight', product: '2022 First Flight', commander: 'UNKNOWN', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Player is changing commander, not deck. Replacement commander UNKNOWN until observed; prior commander and candidate context are kept separate; revalidate the 99 when the change is confirmed.'] },
  { slot: 4, label: 'Undead Girl / Grave Danger', product: '2022 Grave Danger', commander: 'Gisa and Geralf', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Observed noncombat life drain of roughly 3/6/9 per turn without attacks. Causing cards NOT confirmed; no purchases or trigger identity assumed.'] },
  { slot: 5, label: 'Green Foundations', product: 'UNKNOWN', commander: 'UNKNOWN', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Product, commander and list unknown. Observed many creatures, which made Kardur\'s goad useful.'] },
  { slot: 6, label: 'Token Triumph', product: '2022 Token Triumph (Emmara)', commander: 'Emmara, Soul of the Accord', provisional: false, listStatus: 'UNVERIFIED_CARDLIST', notes: ['Official 100 not yet verified with source and date; not loaded.'] },
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
