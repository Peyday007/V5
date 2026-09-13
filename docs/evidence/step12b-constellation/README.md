# The constellation, superseded and current — one measurement at four widths

**This is the record of two runs at two trees, and it is not a baseline.**
Nothing compares anything to these files and deleting them breaks no test. They
are here because the owner asked for a visual handoff rather than a repository
path, and a comparison somebody has to re-run a harness to see is a comparison
nobody makes.

| | |
| --- | --- |
| Taken | 2026-09-13 |
| Command | `npx tsx scripts/visual-qa.ts <dir> --only=constellation` |
| Superseded ring | the tree at `0850a84`, unmodified |
| Current | the same tree with `client/src/russell/Constellation.tsx` and `client/src/russell/design.css` as this branch has them |
| Browser | Chromium 141, headless, `--hide-scrollbars`, `deviceScaleFactor: 1` |
| Server | a real Brain booted against a throwaway data directory, ordinary seed (Deal Dispatch and its eight layers), signed in as a real account |
| Project | eight major ideas around one nucleus, so nine nodes on the canvas |
| Typefaces | the product's own — Fraunces and Public Sans, served through the harness's font interception |

Nothing here is a mock: every image is the built client served by the server.

## What was measured

Two node boxes that intersect are two buttons where a person can press only one,
and the covered label is not hard to read — it is gone. So the reading is the
number of intersecting pairs among `.lim-node` elements and the area of the
worst one, taken in the page by `scripts/visual-qa.ts`.

| Viewport | Canvas | Superseded ring | Current |
| --- | --- | --- | --- |
| 1180 | 866×541 | `orbit` — 0 pairs | `orbit` — 0 pairs |
| 953 | 647×404 → 647×256 | `orbit` — **1 pair**, 214px² | `spine` — 0 pairs |
| 390 | 316×316 → 316×341 | `orbit` — **8 pairs**, worst 1703px² | `spine` — 0 pairs |
| 360 | 286×286 → 286×358 | `orbit` — **12 pairs**, worst 2316px² | `spine` — 0 pairs |

**Two sets of numbers exist for the superseded ring and both are real.** An
earlier pass ran before the harness served the product's web fonts, so the page
rendered on its fallback stack — and a fallback face sets different label widths,
which is exactly what an overlap is made of. That pass read **9 pairs, worst
2385px²** at 390 and **13 pairs** at 360, reproducing the figure this work was
given to fix. The table above is the run in the product's own typefaces. Neither
reading is the "right" one on its own; what they agree about is the only thing
being claimed, which is that the ring overlapped at both phone widths and at the
intermediate one, and does not now.

The 953 reading is new either way. Nothing had ever measured the constellation at
the intermediate width, so that pair had been sitting in the product unreported —
which is the argument for measuring at every width rather than at the one where
the defect was first noticed.

At every width, in both runs, the diagram drew nine nodes and the list beside it
carried eight rows: the nucleus plus its children, against its children. §29's
rule that the picture and the outline are the same graph holds across the change,
and the harness now checks it rather than assuming it.

## The files

| File | What it is |
| --- | --- |
| `superseded-ring-1180.png` | the ring at desktop width — the case that always worked |
| `superseded-ring-953.png` | the ring at the intermediate width, with the pair nobody had measured |
| `superseded-ring-390.png` | **the defect the owner rejected**: nine nodes piled into each other |
| `superseded-ring-360.png` | the same at the narrower phone |
| `current-953.png` | the spine at the intermediate width |
| `current-360.png` | the spine at the narrowest width in scope |

The current renders at 1180, 953 and 390 are the approval set in
`docs/evidence/step12b-renders/`, declared by its `index.json`, and are not
duplicated here.

## What is not claimed

That the ring is safe at desktop width *in general*. What is known is that it did
not overlap for the eight labels this projection produces, at 179px of arc per
node. The spine's guarantee is a different kind: its nodes are placed in grid
cells, and two things in different cells are disjoint whatever the label does.
`RING_MIN_ARC` in `client/src/russell/Constellation.tsx` is what keeps the ring
inside the case that was measured and hands everything else to the arrangement
that cannot overlap.
