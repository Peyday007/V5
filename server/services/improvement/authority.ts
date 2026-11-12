/**
 * The owner's standing improvement order, as a row (§87).
 *
 * `brain_switches.improvement_loop` is the grant under which Brain submits and
 * approves Factory objectives on its own repository, opens method research in
 * `brain-architecture`, and — when a person last set the switch — authorizes
 * the automatic release of a LOW-risk objective (§58). It widens nothing else:
 * Factory's review, the gate, `RELEASE_EXCLUDED_PATHS` (migrations, auth,
 * secrets, deployment, the release machinery) and the risk class all apply
 * exactly as for a person's objective. `admin improvement on|off --admin …`
 * is the only way to change it.
 */
import { getDb } from '../../db/database.ts';
import { BRAIN_REPOSITORY_ID } from '../../domain/binPurpose.ts';
import { getUserByEmail, listUsers } from '../../repos/identity.ts';
import { recordImprovementEvent } from '../../repos/improvement.ts';
import { nowIso } from '../../repos/util.ts';

export const IMPROVEMENT_SWITCH = 'improvement_loop';
export const IMPROVEMENT_AUTHORITY_ID = 'brain_switches:improvement_loop';

export interface ImprovementSwitch {
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  reason: string | null;
}

export async function improvementSwitch(): Promise<ImprovementSwitch> {
  const row = await getDb().get<{ enabled: number | string; updated_by: string; updated_at: string; reason: string | null }>(
    'SELECT enabled, updated_by, updated_at, reason FROM brain_switches WHERE name = ?',
    [IMPROVEMENT_SWITCH],
  );
  if (!row) return { enabled: false, updatedBy: null, updatedAt: null, reason: null };
  return { enabled: Number(row.enabled) === 1, updatedBy: row.updated_by, updatedAt: row.updated_at, reason: row.reason };
}

/** The only writer. `by` is the administrator's email, resolved against the database. */
export async function setImprovementSwitch(enabled: boolean, by: string, reason: string | null): Promise<void> {
  const user = await getUserByEmail(by);
  if (!user || !user.isBrainAdmin || user.disabled) {
    throw new Error('The improvement switch is set by an active Brain administrator.');
  }
  await getDb().run(
    `INSERT INTO brain_switches (name, enabled, updated_at, updated_by, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by, reason = excluded.reason`,
    [IMPROVEMENT_SWITCH, enabled ? 1 : 0, nowIso(), user.email ?? by, reason],
  );
  await recordImprovementEvent({ candidateId: null, kind: enabled ? 'SWITCH_ON' : 'SWITCH_OFF', detail: { by: user.email ?? by, reason } });
}

/**
 * The person the order is attributed to: the administrator who last set the
 * switch, or none when only the migration has (then nothing is released
 * without a person, and research goals are owned by the first administrator).
 */
export async function improvementPerson(): Promise<{ userId: string; email: string; setByPerson: boolean } | null> {
  const state = await improvementSwitch();
  if (state.updatedBy && state.updatedBy.includes('@')) {
    const user = await getUserByEmail(state.updatedBy);
    if (user && user.isBrainAdmin && !user.disabled) return { userId: user.id, email: user.email ?? state.updatedBy, setByPerson: true };
  }
  const admin = (await listUsers()).find((one) => one.isBrainAdmin && !one.disabled);
  return admin ? { userId: admin.id, email: admin.email ?? admin.id, setByPerson: false } : null;
}

/** Whether the order covers approving an objective on this repository. */
export async function improvementGrant(repository: string): Promise<{ ok: true; authorityId: string } | { ok: false; reason: string }> {
  const state = await improvementSwitch();
  if (!state.enabled) return { ok: false, reason: 'The improvement loop is switched off.' };
  const id = repository.toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (id !== BRAIN_REPOSITORY_ID) {
    return { ok: false, reason: 'The improvement order covers Brain\'s own repository only.' };
  }
  return { ok: true, authorityId: IMPROVEMENT_AUTHORITY_ID };
}
