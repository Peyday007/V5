/**
 * Stand-in executables for the OCR failure paths.
 *
 * Missing binaries, a renderer that fails, a recogniser that exits non-zero or
 * never returns — these are the cases that decide whether a scanned document is
 * reported honestly or silently treated as empty, so they are worth testing
 * against the real adapter rather than a mocked one. Brain discovers the
 * recogniser and renderer through environment variables, so pointing those at a
 * script that misbehaves exercises the true code path, spawn and all.
 *
 * The wrapper is written for the host platform, so these tests are real on
 * Windows as well as on POSIX.
 */
import fs from 'node:fs';
import path from 'node:path';

export type FakeBehaviour = 'ok' | 'render' | 'fail' | 'hang' | 'empty';

export interface FakeExecutable {
  /** Path to pass to BRAIN_TESSERACT_PATH or BRAIN_PDF_RENDERER_PATH. */
  command: string;
  version: string;
}

const RUNNER = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const behaviour = process.env.FAKE_BEHAVIOUR_OVERRIDE || __BEHAVIOUR__;
const version = __VERSION__;
// A 2x2 white PNG: valid, tiny, and enough to stand in for a rendered page.
const __PNG__ =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8//8/AzbAhFVsCAAA' +
  'agIC/w8ZlwAAAABJRU5ErkJggg==';

// Every candidate is version-probed first; answering that is what makes Brain
// believe the executable exists at all.
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(version + '\\n');
  process.exit(0);
}

if (behaviour === 'render') {
  // Behave like the page renderer: write <prefix>-1.png where poppler would.
  // A real image, so the caller can hash it and read its dimensions exactly as
  // it would a real rendered page.
  const prefix = args[args.length - 1];
  fs.writeFileSync(prefix + '-1.png', Buffer.from(__PNG__, 'base64'));
  process.exit(0);
} else if (behaviour === 'hang') {
  // Longer than any test timeout, so the caller's own timeout is what ends it.
  setTimeout(() => process.exit(0), 600000);
} else if (behaviour === 'fail') {
  process.stderr.write('fake ' + __TOOL__ + ' failed on purpose\\n');
  process.exit(3);
} else if (behaviour === 'empty') {
  // Exits cleanly but writes nothing, the way a renderer can when a page is
  // malformed: success by status code, nothing produced.
  process.exit(0);
} else {
  process.exit(0);
}
`;

/**
 * Write a fake executable into `directory` and return the path to invoke.
 *
 * `node` runs the logic; the wrapper only exists because a path handed to
 * `spawn` has to be directly executable on the host.
 */
export function writeFakeExecutable(input: {
  directory: string;
  name: string;
  tool: string;
  behaviour: FakeBehaviour;
  version?: string;
}): FakeExecutable {
  fs.mkdirSync(input.directory, { recursive: true });
  const version = input.version ?? `fake-${input.tool} 9.9.9`;
  const script = path.join(input.directory, `${input.name}.js`);
  fs.writeFileSync(
    script,
    RUNNER.replace('__BEHAVIOUR__', JSON.stringify(input.behaviour))
      .replace('__VERSION__', JSON.stringify(version))
      .replace('__TOOL__', JSON.stringify(input.tool)),
  );

  if (process.platform === 'win32') {
    const cmd = path.join(input.directory, `${input.name}.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return { command: cmd, version };
  }
  const sh = path.join(input.directory, input.name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { command: sh, version };
}
