/**
 * Which project the shell's other screens are about.
 *
 * It was `projects[0]` whatever thread was open, so a person reading a thread
 * attached to one project and then opening Knows, Work or Needs You was shown
 * another project's — silently. `shellProject` reads the open thread's own
 * attachment, falls back only when there is none, and can never name a
 * project outside the readable list.
 *
 * Ported from Step 12B (PR #3) onto production, where the defect was still
 * present beside §47's correction of how a *new* thread is attached.
 */
import { describe, expect, it } from 'vitest';
import { shellProject } from '../client/src/russell/RussellShell.tsx';
import type { Project } from '../server/domain/types.ts';

// Only the id is read; the rest of a Project is irrelevant to this decision.
const project = (id: string): Project => ({ id }) as Project;

const DEAL = project('prj_deal');
const BRAIN = project('prj_brain');
const PROJECTS = [DEAL, BRAIN];

describe('shellProject', () => {
  it('follows the open thread’s attachment rather than the first project in the list', () => {
    const threads = [{ id: 'cnv_1', projectId: 'prj_brain' }];
    expect(shellProject(PROJECTS, threads, 'cnv_1')?.id).toBe('prj_brain');
  });

  it('falls back to the first readable project for an unattached thread', () => {
    const threads = [{ id: 'cnv_1', projectId: null }];
    expect(shellProject(PROJECTS, threads, 'cnv_1')?.id).toBe('prj_deal');
  });

  it('falls back when no thread is open, or the thread is not in the list yet', () => {
    expect(shellProject(PROJECTS, [], null)?.id).toBe('prj_deal');
    expect(shellProject(PROJECTS, [], 'cnv_unknown')?.id).toBe('prj_deal');
  });

  it('never names a project the person cannot read', () => {
    const threads = [{ id: 'cnv_1', projectId: 'prj_not_readable' }];
    expect(shellProject(PROJECTS, threads, 'cnv_1')?.id).toBe('prj_deal');
    expect(shellProject([], threads, 'cnv_1')).toBeNull();
  });
});
