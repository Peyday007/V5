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
exec node --max-old-space-size=384 --import tsx scripts/verify-hosted.ts "$@"
