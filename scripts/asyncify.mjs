/**
 * The codemod behind the asynchronous database boundary.
 *
 * Making `getDb()` return promises turns roughly two hundred repository
 * functions asynchronous, and every caller of those, and every caller of
 * those — around forty service and route modules and fourteen test files. Doing
 * that by hand is not a matter of effort but of accuracy: the failure mode is a
 * single missed `await`, which type-checks in a boolean position, passes a
 * promise where a value was meant, and produces a bug that looks like data loss.
 *
 * So it is done by the compiler instead. The script asks TypeScript for the
 * type of every call expression, and where a promise now flows into a place
 * that wants a value, it inserts the `await` and marks the enclosing function
 * async. It runs to a fixed point, because making one function async makes its
 * callers' calls return promises in turn.
 *
 * Positions it deliberately leaves alone: an existing `await`, a `.then` chain,
 * a `void` call, an argument to `Promise.all`, and a bare `return` — all of
 * those mean the promise itself, and awaiting it would change what the code
 * says rather than preserve it.
 *
 *   node scripts/asyncify.mjs <file...>
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

function isFunctionLike(node) {
  return FUNCTION_LIKE.has(node.kind);
}

/** The function whose body this node sits in, ignoring nested ones. */
function enclosingFunction(node) {
  let current = node.parent;
  while (current && !isFunctionLike(current)) current = current.parent;
  return current ?? null;
}

function isAsync(node) {
  return (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** True for a type that is (or includes) a Promise. */
function isPromiseType(checker, type) {
  if (!type) return false;
  if (type.isUnion()) return type.types.some((t) => isPromiseType(checker, t));
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (!symbol) return false;
  const name = symbol.getName();
  if (name !== 'Promise') return false;
  return typeof type.getProperty === 'function' && Boolean(type.getProperty('then'));
}

/**
 * Positions where a promise is the intended value.
 *
 * Every one of these means "the promise itself", so inserting an await would
 * change behaviour instead of preserving it.
 */
function wantsThePromise(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isAwaitExpression(parent)) return true;
  // A `.then(...)` call is code that has chosen to work in promises. Awaiting
  // its result would rewrite a deliberate chain into a sequential one.
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ['then', 'catch', 'finally'].includes(node.expression.name.getText())
  ) {
    return true;
  }
  // A variable declared as a Promise is a handle somebody means to keep.
  if (ts.isVariableDeclaration(parent) && parent.type) {
    if (/^Promise\s*</.test(parent.type.getText())) return true;
  }
  if (ts.isVoidExpression(parent)) return true;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isArrowFunction(parent) && parent.body === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    const name = parent.name.getText();
    if (name === 'then' || name === 'catch' || name === 'finally') return true;
  }
  // Promise.all([...]) and friends take promises on purpose.
  let ancestor = parent;
  while (ancestor && (ts.isArrayLiteralExpression(ancestor) || ts.isSpreadElement(ancestor))) {
    ancestor = ancestor.parent;
  }
  if (ancestor && ts.isCallExpression(ancestor) && ts.isPropertyAccessExpression(ancestor.expression)) {
    const target = ancestor.expression;
    if (target.expression.getText() === 'Promise') return true;
  }
  return false;
}

/**
 * Does the function being called want the promise itself?
 *
 * `withTimeout(provider.audit(...), ms)` is the case that matters: awaiting the
 * argument would hand a settled value to something whose entire job is to race
 * the unsettled one, and the timeout would silently stop applying. The callee's
 * own parameter type says so, so ask it.
 */
function calleeWantsThePromise(checker, node) {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  const index = parent.arguments.indexOf(node);
  if (index === -1) return false;
  const signature = checker.getResolvedSignature(parent);
  const parameter = signature?.getParameters()?.[index];
  if (!parameter) return false;
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
  if (!declaration) return false;
  const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
  return isPromiseType(checker, type);
}

/**
 * Does anything reach into this call's result?
 *
 * `x()!`, `x().y`, `x()[0]` all bind tighter than `await`, so the awaited call
 * needs parentheses or the await lands on the wrong expression.
 */
function bindsTighterThanAwait(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isNonNullExpression(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return true;
  return false;
}

/**
 * `expect(...)` takes `any`, so the type checker cannot object to a promise
 * being handed to it — the assertion just compares against a Promise object and
 * fails at runtime with something unhelpful. Since a matcher on an unresolved
 * promise is never what anybody meant, the argument is awaited unless the
 * matcher is one of the two that want the promise itself.
 */
function isUnawaitedExpectation(node) {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.expression.getText() !== 'expect') return false;
  if (parent.arguments[0] !== node) return false;
  const matcher = parent.parent;
  if (matcher && ts.isPropertyAccessExpression(matcher)) {
    const name = matcher.name.getText();
    if (name === 'rejects' || name === 'resolves') return false;
  }
  return true;
}

/** One pass over one file: returns the edits it wants to make. */
function planEdits(program, checker, sourceFile) {
  const edits = [];
  const needAsync = new Set();

  const visit = (node) => {
    const promiseIntoExpect = ts.isCallExpression(node) && isUnawaitedExpectation(node);
    if (
      ts.isCallExpression(node) &&
      (promiseIntoExpect || (!wantsThePromise(node) && !calleeWantsThePromise(checker, node)))
    ) {
      const type = checker.getTypeAtLocation(node);
      if (isPromiseType(checker, type)) {
        // `await` is a unary operator and member access binds tighter, so
        // `await find()!.name` would await the property rather than the call.
        // Anything reaching into the result gets parentheses.
        if (bindsTighterThanAwait(node)) {
          edits.push({ pos: node.getStart(sourceFile), text: '(await ' });
          edits.push({ pos: node.getEnd(), text: ')' });
        } else {
          edits.push({ pos: node.getStart(sourceFile), text: 'await ' });
        }
        const fn = enclosingFunction(node);
        if (fn && !isAsync(fn)) needAsync.add(fn);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Any function that gained an await, plus any that already had one without
  // being async (the earlier textual pass inserts those).
  const collectExistingAwaits = (node) => {
    if (ts.isAwaitExpression(node)) {
      const fn = enclosingFunction(node);
      if (fn && !isAsync(fn)) needAsync.add(fn);
    }
    ts.forEachChild(node, collectExistingAwaits);
  };
  ts.forEachChild(sourceFile, collectExistingAwaits);

  for (const fn of needAsync) {
    edits.push(...asyncEdits(fn, sourceFile));
  }

  return edits;
}

/** Mark one function async, and wrap its declared return type. */
function asyncEdits(fn, sourceFile) {
  const edits = [];

  // `async` goes before `function`, before the parameter list of an arrow, or
  // before a method's name.
  let insertAt;
  if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) {
    const keyword = fn.getChildren(sourceFile).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
    insertAt = keyword ? keyword.getStart(sourceFile) : fn.getStart(sourceFile);
  } else {
    insertAt = fn.getStart(sourceFile);
  }
  edits.push({ pos: insertAt, text: 'async ' });

  if (fn.type) {
    const text = fn.type.getText(sourceFile);
    if (!/^Promise\s*</.test(text)) {
      edits.push({
        pos: fn.type.getStart(sourceFile),
        end: fn.type.getEnd(),
        text: `Promise<${text}>`,
      });
    }
  }
  return edits;
}

function applyEdits(text, edits) {
  // Apply from the back so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.pos - a.pos || b.text.length - a.text.length);
  let out = text;
  const seen = new Set();
  for (const edit of ordered) {
    const key = `${edit.pos}:${edit.end ?? edit.pos}:${edit.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const end = edit.end ?? edit.pos;
    out = out.slice(0, edit.pos) + edit.text + out.slice(end);
  }
  return out;
}

/**
 * The database boundary writes its own promises on purpose.
 *
 * `server/db/**` is the one place that holds a promise as a value — a
 * connection lock's tail, a pool's client — and inserting awaits there would
 * turn a queue into a deadlock. It is written by hand and excluded from the
 * codemod.
 */
const EXCLUDED = [`${path.sep}server${path.sep}db${path.sep}`];

function main() {
  const targets = process.argv
    .slice(2)
    .map((p) => path.resolve(p))
    .filter((p) => !EXCLUDED.some((fragment) => p.includes(fragment)));
  if (targets.length === 0) {
    console.error('usage: node scripts/asyncify.mjs <file...>');
    process.exit(1);
  }

  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
  const checker = program.getTypeChecker();

  let touched = 0;
  for (const target of targets) {
    const sourceFile = program.getSourceFile(target);
    if (!sourceFile) {
      console.error(`not in the program: ${target}`);
      continue;
    }
    const edits = planEdits(program, checker, sourceFile);
    if (edits.length === 0) continue;
    const next = applyEdits(sourceFile.getFullText(), edits);
    fs.writeFileSync(target, next);
    console.log(`${path.relative(process.cwd(), target)}: ${edits.length}`);
    touched += 1;
  }
  console.log(`files changed: ${touched}`);
}

main();
