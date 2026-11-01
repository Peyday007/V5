/**
 * From a coherent intent to a legal deck, from real catalog cards only.
 *
 * Refuses while any conflict is unresolved: cards are chosen after strategy and
 * constraints agree, not before. Every card carries the role it fills and the
 * tag rule that put it there. Deterministic: fixed order, name tie-breaks.
 */
import { COMMANDER_DECK_SIZE, STANDARD_MIN_MAIN } from '../../../domain/magicRules.ts';
import type { MagicColor } from '../../../domain/magicTypes.ts';
import { tagCard, type Role } from '../analysis/tags.ts';
import { canBeCommander, validateDeck, type ValidationResult } from '../rules/validate.ts';
import type { OptCard } from '../optimizer/types.ts';
import { detectConflicts } from './conflicts.ts';
import type { DesignIntent } from './types.ts';

export type BuiltRole = Role | 'commander' | 'support';

export interface BuiltCard {
  zone: 'commander' | 'main';
  quantity: number;
  card: OptCard;
  role: BuiltRole;
  ruleIds: string[];
  why: string;
}

export interface BuildOptions {
  pool: OptCard[];
  analysisDate: string;
  commander?: OptCard;
  /** Copies owned, by name, for an owned-only build. */
  owned?: Record<string, number>;
}

export interface BuildResult {
  ok: boolean;
  refused: string | null;
  commander: OptCard | null;
  cards: BuiltCard[];
  validation: ValidationResult | null;
  /** The slot plan the build aimed at; a design target, not a probability. */
  plan: Partial<Record<Role, number>>;
  issues: string[];
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isLand = (c: OptCard) => /\bland\b/i.test(c.typeLine);
const isBasic = (c: OptCard) => /\bbasic\b.*\bland\b/i.test(c.typeLine);
const subset = (a: MagicColor[], of: MagicColor[]) => a.every((x) => of.includes(x));

export function rolePlan(i: DesignIntent): Partial<Record<Role, number>> {
  const commander = i.format === 'COMMANDER';
  const p: Partial<Record<Role, number>> = commander
    ? { ramp: 10, draw: 8, removal: 7, sweeper: 2, protection: 2, finisher: 4 }
    : { ramp: 2, draw: 3, removal: 6, sweeper: 1, protection: 2, finisher: 4 };
  const add = (r: Role, n: number) => { p[r] = (p[r] ?? 0) + n; };
  if (i.defensive) { add('removal', 3); add('sweeper', 1); add('lifegain', commander ? 6 : 3); add('protection', 2); }
  if (i.speed === 'fast') { add('threat', commander ? 10 : 10); add('finisher', 2); p.sweeper = Math.max(0, (p.sweeper ?? 0) - 1); }
  if (i.winEngines.includes('lifedrain')) add('drain', commander ? 6 : 4);
  if (i.winEngines.includes('combat')) add('threat', 6);
  if (i.winEngines.includes('tokens')) add('threat', 4);
  if (i.winEngines.includes('combo')) { add('tutor', 3); add('finisher', 2); }
  if (i.risk === 'consistency') add('draw', 2);
  for (const r of i.secondaryPreferences) add(r, 3);
  if (i.earlyMana) add('ramp', 2);
  return p;
}

const ROLE_ORDER: Role[] = ['ramp', 'draw', 'removal', 'sweeper', 'lifegain', 'drain', 'protection', 'counter', 'tutor', 'recursion', 'finisher', 'threat', 'engine'];

export function buildDeck(intent: DesignIntent, opts: BuildOptions): BuildResult {
  const fail = (refused: string, issues: string[] = []): BuildResult => ({
    ok: false, refused, commander: null, cards: [], validation: null, plan: {}, issues: issues.length ? issues : [refused],
  });
  const open = detectConflicts(intent);
  if (open.length > 0) return fail(`Strategy is not coherent yet: ${open.map((c) => c.name).join('; ')}. Decide first, then build.`);

  const format = intent.format;
  const key = format === 'COMMANDER' ? 'commander' : 'standard';
  const commanderFmt = format === 'COMMANDER';
  const excluded = new Set(intent.hardConstraints.flatMap((c) => (c.kind === 'exclude' ? [c.name] : [])));
  const colorConstraint = intent.hardConstraints.find((c) => c.kind === 'colors');
  const ownedOnly = intent.collection === 'owned-only';
  const owned = opts.owned ?? {};
  const budget = intent.budgetCents;
  const preferred = new Set<Role>(intent.secondaryPreferences);

  const tags = new Map<string, ReturnType<typeof tagCard>>();
  const tagsOf = (c: OptCard) => {
    let t = tags.get(c.name);
    if (!t) { t = tagCard({ name: c.name, typeLine: c.typeLine, oracleText: c.oracleText, cmc: c.cmc }); tags.set(c.name, t); }
    return t;
  };
  const pool = [...opts.pool].sort((a, b) => byName(a.name, b.name));
  const legal = (c: OptCard) => c.legalities[key] === 'legal' && !excluded.has(c.name);

  // Commander (or colours, for Standard).
  let commander: OptCard | null = null;
  let allowed: MagicColor[];
  if (commanderFmt) {
    const cands = pool.filter((c) => legal(c) && canBeCommander(c) && (!colorConstraint || colorConstraint.kind !== 'colors' || subset(c.colorIdentity, colorConstraint.colors)));
    commander = opts.commander ?? cands
      .map((c) => ({ c, s: tagsOf(c).roles.filter((r) => preferred.has(r)).length }))
      .sort((a, b) => b.s - a.s || byName(a.c.name, b.c.name))[0]?.c ?? null;
    if (!commander) return fail('No legal commander in the pool.');
    if (!canBeCommander(commander)) return fail(`${commander.name} cannot be a commander.`);
    allowed = commander.colorIdentity;
  } else if (colorConstraint && colorConstraint.kind === 'colors') {
    allowed = colorConstraint.colors;
  } else {
    const tally = new Map<MagicColor, number>();
    for (const c of pool) if (legal(c) && !isLand(c)) for (const col of c.colorIdentity) tally.set(col, (tally.get(col) ?? 0) + 1);
    allowed = [...tally.entries()].sort((a, b) => b[1] - a[1] || byName(a[0], b[0])).slice(0, 2).map(([c]) => c);
  }

  let spent = 0;
  const affordable = (c: OptCard): boolean => {
    if (isBasic(c)) return true;
    if (ownedOnly && (owned[c.name] ?? 0) < 1) return false;
    if (budget === null || ownedOnly) return true;
    if (c.priceCents === null) return false;
    return spent + c.priceCents <= budget;
  };
  const candidates = pool.filter((c) => legal(c) && c.name !== commander?.name && subset(c.colorIdentity, allowed));
  const target = commanderFmt ? COMMANDER_DECK_SIZE - 1 : STANDARD_MIN_MAIN;
  const copies = commanderFmt ? 1 : 4;
  const plan = rolePlan(intent);
  const landQuota = commanderFmt ? (intent.risk === 'consistency' ? 37 : 36) - (intent.speed === 'fast' ? 2 : 0) : 24;
  const nonlandTarget = target - landQuota;

  const used = new Set<string>();
  const cards: BuiltCard[] = [];
  let nonland = 0;
  const take = (c: OptCard, role: BuiltRole, why: string, qty = copies) => {
    const q = Math.min(qty, nonlandTarget - nonland);
    if (q <= 0) return false;
    used.add(c.name);
    nonland += q;
    if (!ownedOnly && c.priceCents !== null && !isBasic(c)) spent += c.priceCents * q;
    cards.push({ zone: 'main', quantity: q, card: c, role, ruleIds: tagsOf(c).ruleIds, why });
    return true;
  };
  const rank = (c: OptCard) => tagsOf(c).roles.filter((r) => preferred.has(r)).length;
  const nonLandCands = candidates.filter((c) => !isLand(c));

  for (const role of ROLE_ORDER) {
    const slots = plan[role] ?? 0;
    if (slots <= 0) continue;
    const picks = nonLandCands
      .filter((c) => !used.has(c.name) && tagsOf(c).roles.includes(role))
      .sort((a, b) => rank(b) - rank(a) || (a.cmc ?? 0) - (b.cmc ?? 0) || byName(a.name, b.name));
    let filled = 0;
    for (const c of picks) {
      if (filled >= slots) break;
      if (!affordable(c)) continue;
      if (take(c, role, `Fills the ${role} slots (tag rule ${tagsOf(c).ruleIds.join(', ')}).`)) filled += Math.min(copies, slots - filled) > 0 ? copies : 0;
    }
  }
  // Remaining nonland slots: best leftover cards, with the role they actually have.
  const leftovers = nonLandCands
    .filter((c) => !used.has(c.name))
    .sort((a, b) => tagsOf(b).roles.length - tagsOf(a).roles.length || rank(b) - rank(a) || (a.cmc ?? 0) - (b.cmc ?? 0) || byName(a.name, b.name));
  for (const c of leftovers) {
    if (nonland >= nonlandTarget) break;
    if (!affordable(c)) continue;
    const r = tagsOf(c).roles[0];
    take(c, r ?? 'support', r ? `Best remaining ${r} card (tag rule ${tagsOf(c).ruleIds[0]}).` : 'No tag rule matched; kept as a support body to complete the list.');
  }

  // Lands: a few nonbasic, then basics for the rest.
  const nonbasic = candidates.filter((c) => isLand(c) && !isBasic(c) && !used.has(c.name) && affordable(c))
    .sort((a, b) => byName(a.name, b.name)).slice(0, commanderFmt ? 6 : 0);
  let landCount = 0;
  for (const c of nonbasic) {
    used.add(c.name);
    landCount += 1;
    if (!ownedOnly && c.priceCents !== null) spent += c.priceCents;
    cards.push({ zone: 'main', quantity: 1, card: c, role: 'land', ruleIds: tagsOf(c).ruleIds, why: `Nonbasic land inside the colour identity (tag rule ${tagsOf(c).ruleIds.join(', ')}).` });
  }
  const basics = candidates.filter(isBasic);
  const basicsNeeded = target - nonland - landCount;
  if (basicsNeeded > 0) {
    if (basics.length === 0) return fail('The pool has no basic land inside the deck\'s colours.');
    const pips = new Map<string, number>();
    for (const b of basics) pips.set(b.name, 1);
    for (const bc of cards) for (const m of (bc.card.manaCost ?? '').matchAll(/\{([WUBRG])\}/g)) {
      const b = basics.find((x) => x.colorIdentity.includes(m[1] as MagicColor));
      if (b) pips.set(b.name, (pips.get(b.name) ?? 0) + bc.quantity);
    }
    const weights = basics.map((b) => ({ b, w: pips.get(b.name) ?? 1 }));
    const total = weights.reduce((s, x) => s + x.w, 0);
    let left = basicsNeeded;
    weights.forEach((x, idx) => {
      const n = idx === weights.length - 1 ? left : Math.min(left, Math.round((basicsNeeded * x.w) / total));
      left -= n;
      if (n > 0) cards.push({ zone: 'main', quantity: n, card: x.b, role: 'land', ruleIds: tagsOf(x.b).ruleIds, why: 'Basic land, split by the colour pips of the chosen spells.' });
    });
  }
  if (commander) {
    cards.unshift({ zone: 'commander', quantity: 1, card: commander, role: 'commander', ruleIds: tagsOf(commander).ruleIds, why: opts.commander ? 'Commander chosen by the caller.' : 'Commander proposed from the pool by preferred roles; change it and the deck revalidates.' });
  }

  const validation = validateDeck({
    format, analysisDate: opts.analysisDate,
    entries: cards.map((c) => ({ zone: c.zone, name: c.card.name, quantity: c.quantity, card: c.card })),
  });
  const issues = validation.issues.filter((x) => x.severity === 'ERROR').map((x) => x.message);
  return { ok: validation.ok, refused: null, commander, cards, validation, plan, issues };
}
