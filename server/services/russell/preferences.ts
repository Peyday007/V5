/**
 * What one person prefers, and the hard line around it.
 *
 * §18 asks for the smallest clean versioned seam and explicitly *not* for a
 * personalization engine. The whole of the safety here is one sentence:
 * **a preference may never change a fact.** Not what the evidence says, not
 * what standard it is held to, not what anybody is allowed to do.
 *
 * That is enforced by `PREFERENCES` being a closed set of presentational keys
 * with declared shapes, checked on write. A free-text key column would make it
 * a convention, and a convention is what somebody adds `evidenceFloor` to in
 * six months without noticing what they have done.
 *
 * Every account works well with no preferences at all. Nothing here has to be
 * configured by an owner for anybody, which is §18's other requirement and the
 * reason every key has a default.
 */
import { getDb } from '../../db/database.ts';
import { nowIso, parseJson, toJson } from '../../repos/util.ts';

/**
 * The closed set.
 *
 * Every one of these changes how something is *shown* and nothing else. Adding
 * a key is a code change somebody reviews — which is the point, because the
 * review is where "does this change a fact?" gets asked.
 */
export const PREFERENCES = {
  /** How much of an answer this person wants by default (§4.5). */
  depth: { kind: 'ENUM' as const, values: ['NORMAL', 'INTERESTED', 'TECHNICAL'], fallback: 'NORMAL' },
  /** Whether the home screen shows Russell's live line. */
  showPulse: { kind: 'BOOLEAN' as const, fallback: true },
  /** Whether "Why this matters" may surface on its own. */
  showWhyThisMatters: { kind: 'BOOLEAN' as const, fallback: true },
  /** Which section this person lands on. A destination, never a permission. */
  landingSection: {
    kind: 'ENUM' as const,
    values: ['HOME', 'WORK', 'PROJECTS', 'NEEDS_YOU'],
    fallback: 'HOME',
  },
} as const;

export type PreferenceKey = keyof typeof PREFERENCES;
export type PreferenceValue = string | boolean;

export function isPreferenceKey(value: unknown): value is PreferenceKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PREFERENCES, value);
}

/**
 * Whether a value is allowed for a key.
 *
 * Pure, so the rule is testable without a database, and strict: an enum key
 * takes one of its declared values and nothing else. A preference that
 * accepted an arbitrary string would be a place to store something that is not
 * a preference.
 */
export function checkPreference(
  key: PreferenceKey,
  value: unknown,
): { ok: true; value: PreferenceValue } | { ok: false; reason: string } {
  const declared = PREFERENCES[key];
  if (declared.kind === 'BOOLEAN') {
    if (typeof value !== 'boolean') return { ok: false, reason: `${key} is true or false.` };
    return { ok: true, value };
  }
  if (typeof value !== 'string' || !(declared.values as readonly string[]).includes(value)) {
    return { ok: false, reason: `${key} must be one of: ${declared.values.join(', ')}.` };
  }
  return { ok: true, value };
}

export type Preferences = { [K in PreferenceKey]: PreferenceValue };

/** The defaults, so an account with nothing stored is fully usable. */
export function defaults(): Preferences {
  const out = {} as Preferences;
  for (const key of Object.keys(PREFERENCES) as PreferenceKey[]) {
    out[key] = PREFERENCES[key].fallback;
  }
  return out;
}

/**
 * One person's preferences, with defaults filled in.
 *
 * A stored value that is no longer allowed — a key whose enum narrowed in a
 * later version — falls back rather than being served. The row stays, because
 * it is still what that person chose under the older meaning, and the version
 * column is what tells the two apart.
 */
export async function preferencesFor(userId: string): Promise<Preferences> {
  const rows = await getDb().all<{ key: string; value: string }>(
    'SELECT key, value FROM user_preferences WHERE user_id = ?',
    [userId],
  );
  const out = defaults();
  for (const row of rows) {
    if (!isPreferenceKey(row.key)) continue;
    const parsed = parseJson<unknown>(row.value, null);
    const checked = checkPreference(row.key, parsed);
    if (checked.ok) out[row.key] = checked.value;
  }
  return out;
}

/**
 * Set one, for one person.
 *
 * The user comes from the authenticated principal at the route, never from the
 * body: a preference route that took a user id would be a way to change
 * somebody else's screen.
 */
export async function setPreference(input: {
  userId: string;
  key: PreferenceKey;
  value: unknown;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const checked = checkPreference(input.key, input.value);
  if (!checked.ok) return checked;
  const now = nowIso();
  const db = getDb();
  await db.run(
    `INSERT INTO user_preferences (user_id, key, value, version, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [input.userId, input.key, toJson(checked.value), now, now],
  );
  await db.run(
    `UPDATE user_preferences SET value = ?, updated_at = ? WHERE user_id = ? AND key = ?`,
    [toJson(checked.value), now, input.userId, input.key],
  );
  return { ok: true };
}
