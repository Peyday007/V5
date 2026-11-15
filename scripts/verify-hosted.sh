#!/bin/sh
# Run the hosted verification inside the deployed container.
#
# This exists for one unglamorous reason: `flyctl ssh console -C` opens a
# session in `/`, and `node --import tsx` resolves `tsx` relative to the working
# directory, so the obvious one-liner fails with a module-resolution error that
# looks nothing like its cause. Quoting a `cd` into the remote command means
# nesting quotes through YAML, flyctl and a remote shell, and each of those
# splits arguments slightly differently.
#
# A file takes no quotes at all. The remote command is three plain words.
#
# Usage:  sh /app/scripts/verify-hosted.sh https://your-brain.fly.dev
set -e
cd "$(dirname "$0")/.."
# The verifier shares a 1 GB machine with the Brain it checks, and on
# 2026-10-30 that machine was OOM-killed during a pass. Its heap is capped so a
# runaway verifier fails itself rather than taking the Brain's memory; it needs
# well under this (the whole import graph is under 100 MB).
#
# 768 MB since 2026-11-15 (R-SLOW-RESTART). The machine is 4 GB and the Brain's
# heap is capped at 2,560 MB (Dockerfile), so 384 MB was the 1 GB machine's
# figure. The verifier itself died with "JavaScript heap out of memory" at ~400 MB
# right after reading the shared frontier (979 opportunities, Deploy
# 43760437288), and the gate reported it as "the live Brain answered too
# slowly" — on three Deploys (1092, 1094, 1103) whose releases were serving.
exec node --max-old-space-size=768 --import tsx scripts/verify-hosted.ts "$@"
