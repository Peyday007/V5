import fs from 'node:fs';
import { SUDOKU } from '/home/user/V5/server/services/puzzle/formats/index.ts';
const want: Record<string, string> = {
  mug: 'EASY', tee: 'MEDIUM', tote: 'MEDIUM', poster: 'HARD', sweatshirt: 'MEDIUM',
  journal: 'EASY', okayest: 'EASY', largeprint: 'EASY', coaster: 'EASY', sticker: 'EASY', blackmug: 'HARD', expert: 'HARD',
};
const out: Record<string, unknown> = {};
for (const [k, d] of Object.entries(want)) {
  for (let i = 0; i < 40; i++) {
    const spec = { formatKey: SUDOKU.key, corpusId: 'common-english-v1', seed: `store-2026-11-11-${k}-${i}`, parameters: { difficulty: d } };
    const a = SUDOKU.render!(spec as never);
    const v = SUDOKU.validate(a);
    if (v.state !== 'VALID') continue;
    out[k] = { seed: spec.seed, intended: d, measured: v.measuredDifficulty, hash: v.canonicalHash, grid: a.grid, solution: a.solution, prompts: a.prompts, checks: v.checks?.map((c: any) => `${c.name}: ${c.ok}`) };
    break;
  }
}
fs.writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
console.log(Object.entries(out).map(([k, v]: any) => `${k} ${v.measured} ${v.prompts} ${v.grid[0]}`).join('\n'));
