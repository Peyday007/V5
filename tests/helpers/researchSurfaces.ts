/**
 * Routable research surfaces for a test project: an account, a worker holding
 * a research membership on the project, and `count` Routines bound to it with a
 * deployed secret — what `routableResearchSurfaces` counts, and so what lets a
 * derived research room exceed its floor of one.
 */
import { createWorker, grantMembership } from '../../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../../server/repos/fleet.ts';
import { forgetResearchSurfaces } from '../../server/services/cash/researchRoom.ts';

export async function registerResearchSurfaces(projectId: string, count: number): Promise<string[]> {
  const tag = Math.random().toString(36).slice(2, 8);
  const account = await createAccount({ provider: 'anthropic', name: `surfaces-${tag}` });
  const worker = await createWorker({
    name: `surfaces-worker-${tag}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const secret = `SURFACES_TEST_SECRET_${tag.toUpperCase()}`;
  process.env[secret] = 'not-a-real-token';
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: `trig_surface_${tag}_${index}`,
      name: `surface-${tag}-${index}`,
      tokenSecretName: secret,
    });
    await bindRoutineWorker(routine.id, worker.id);
    ids.push(routine.id);
  }
  forgetResearchSurfaces();
  return ids;
}
