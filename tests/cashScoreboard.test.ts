/** The scoreboard counts rows and says when the free lane is off. */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { formatScoreboard, scoreboard } from '../server/services/cash/scoreboard.ts';

describe('the scoreboard', () => {
  it('reads an empty sprint as zeros, and the free lane as off', async () => {
    const { project } = await freshProject();
    const board = await scoreboard(project.id);
    expect(board.foundLast7Days).toBe(0);
    expect(board.cheapLane.enabled).toBe(false);
    expect(formatScoreboard(board).join('\n')).toContain('free lane   off');
    expect(board.triggersOn).toBe(false);
    expect(board.triggers).toHaveLength(8);
  });
});
