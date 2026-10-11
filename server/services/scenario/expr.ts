/**
 * A small arithmetic language, parsed by hand and compiled to closures.
 *
 * A scenario model has to say "units = min(demand × conversion, capacity)"
 * somewhere, and the two easy ways to let it are both refused. `eval` or
 * `new Function` would execute text a person typed — invariant 11's rule that
 * nothing found in text is ever executed applies to a model definition too.
 * And a fixed template would make the engine a Cash calculator, which is the
 * second ranking system this capability must not become.
 *
 * So this is a closed grammar: numbers, identifiers (a variable, a derived
 * quantity, or `choice.attribute`), `+ - * / ^`, comparisons and `&& ||` (true
 * is 1, false is 0), parentheses, and ten named functions. An identifier the
 * model does not declare is a refusal at validation time, never a silent zero,
 * and compiled closures read a `Float64Array` by slot so 50,000 evaluations
 * cost arithmetic rather than lookups.
 *
 * Division by zero, `NaN` and infinities are not caught here. They propagate,
 * and the engine reports the scenario as **invalid** with the expression that
 * produced it — a number that quietly became zero would be a fabricated result.
 */
import { SCENARIO_LIMITS } from '../../domain/scenario.ts';

export class ExpressionError extends Error {}

type Node =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

const FUNCTIONS: Record<string, [number, number]> = {
  min: [1, 16],
  max: [1, 16],
  abs: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 1],
  pow: [2, 2],
  sqrt: [1, 1],
  if: [3, 3],
  clamp: [3, 3],
};

interface Token {
  kind: 'num' | 'id' | 'op' | 'end';
  text: string;
  at: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new ExpressionError(`A number at position ${i} could not be read.`);
      tokens.push({ kind: 'num', text: match[0], at: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(source.slice(i))!;
      tokens.push({ kind: 'id', text: match[0], at: i });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', text: two, at: i });
      i += 2;
      continue;
    }
    if ('+-*/^(),<>'.includes(c)) {
      tokens.push({ kind: 'op', text: c, at: i });
      i++;
      continue;
    }
    throw new ExpressionError(`"${c}" at position ${i} is not part of the expression language.`);
  }
  tokens.push({ kind: 'end', text: '', at: source.length });
  return tokens;
}

/** Parse an expression. Throws `ExpressionError` naming what is wrong and where. */
export function parse(source: string): Node {
  if (typeof source !== 'string' || source.trim() === '') throw new ExpressionError('The expression is empty.');
  if (source.length > SCENARIO_LIMITS.maxExpressionLength) {
    throw new ExpressionError(`The expression is longer than ${SCENARIO_LIMITS.maxExpressionLength} characters.`);
  }
  const tokens = tokenize(source);
  let pos = 0;
  let depth = 0;
  const peek = (): Token => tokens[pos]!;
  const take = (): Token => tokens[pos++]!;
  const expectOp = (text: string): void => {
    const token = take();
    if (token.kind !== 'op' || token.text !== text) {
      throw new ExpressionError(`Expected "${text}" at position ${token.at}.`);
    }
  };
  const enter = (): void => {
    depth++;
    if (depth > SCENARIO_LIMITS.maxExpressionDepth) throw new ExpressionError('The expression is nested too deeply.');
  };

  const binaryLevel = (ops: string[], next: () => Node): (() => Node) => () => {
    let left = next();
    for (;;) {
      const token = peek();
      if (token.kind === 'op' && ops.includes(token.text)) {
        take();
        left = { t: 'bin', op: token.text, a: left, b: next() };
      } else return left;
    }
  };

  const primary = (): Node => {
    enter();
    try {
      const token = take();
      if (token.kind === 'num') {
        const value = Number(token.text);
        if (!Number.isFinite(value)) throw new ExpressionError(`"${token.text}" is not a finite number.`);
        return { t: 'num', v: value };
      }
      if (token.kind === 'id') {
        if (peek().kind === 'op' && peek().text === '(') {
          const arity = FUNCTIONS[token.text];
          if (!arity) throw new ExpressionError(`"${token.text}" is not a function this language has.`);
          take();
          const args: Node[] = [];
          if (!(peek().kind === 'op' && peek().text === ')')) {
            args.push(or());
            while (peek().kind === 'op' && peek().text === ',') { take(); args.push(or()); }
          }
          expectOp(')');
          if (args.length < arity[0] || args.length > arity[1]) {
            throw new ExpressionError(`${token.text}() takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument(s), not ${args.length}.`);
          }
          return { t: 'call', fn: token.text, args };
        }
        return { t: 'id', name: token.text };
      }
      if (token.kind === 'op' && token.text === '(') {
        const inner = or();
        expectOp(')');
        return inner;
      }
      throw new ExpressionError(token.kind === 'end' ? 'The expression ends too early.' : `Unexpected "${token.text}" at position ${token.at}.`);
    } finally {
      depth--;
    }
  };
  const power = (): Node => {
    const base = primary();
    if (peek().kind === 'op' && peek().text === '^') {
      take();
      return { t: 'bin', op: '^', a: base, b: unary() };
    }
    return base;
  };
  const unary = (): Node => {
    if (peek().kind === 'op' && peek().text === '-') {
      take();
      enter();
      try { return { t: 'neg', a: unary() }; } finally { depth--; }
    }
    return power();
  };
  const mul = binaryLevel(['*', '/'], unary);
  const add = binaryLevel(['+', '-'], mul);
  const cmp = (): Node => {
    const left = add();
    const token = peek();
    if (token.kind === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(token.text)) {
      take();
      return { t: 'bin', op: token.text, a: left, b: add() };
    }
    return left;
  };
  const and = binaryLevel(['&&'], cmp);
  const or = binaryLevel(['||'], and);

  const tree = or();
  if (peek().kind !== 'end') throw new ExpressionError(`Unexpected "${peek().text}" at position ${peek().at}.`);
  return tree;
}

/** Every identifier an expression reads, for validation and ordering. */
export function identifiers(node: Node, into: Set<string> = new Set()): Set<string> {
  switch (node.t) {
    case 'id': into.add(node.name); break;
    case 'neg': identifiers(node.a, into); break;
    case 'bin': identifiers(node.a, into); identifiers(node.b, into); break;
    case 'call': for (const arg of node.args) identifiers(arg, into); break;
    default: break;
  }
  return into;
}

export type Compiled = (env: Float64Array) => number;

/**
 * Compile to a closure. `slotOf` resolves a name to its slot and throws for a
 * name the model never declared.
 */
export function compile(node: Node, slotOf: (name: string) => number): Compiled {
  switch (node.t) {
    case 'num': { const v = node.v; return () => v; }
    case 'id': { const slot = slotOf(node.name); return (env) => env[slot]!; }
    case 'neg': { const a = compile(node.a, slotOf); return (env) => -a(env); }
    case 'bin': {
      const a = compile(node.a, slotOf);
      const b = compile(node.b, slotOf);
      switch (node.op) {
        case '+': return (env) => a(env) + b(env);
        case '-': return (env) => a(env) - b(env);
        case '*': return (env) => a(env) * b(env);
        case '/': return (env) => a(env) / b(env);
        case '^': return (env) => Math.pow(a(env), b(env));
        case '<': return (env) => (a(env) < b(env) ? 1 : 0);
        case '<=': return (env) => (a(env) <= b(env) ? 1 : 0);
        case '>': return (env) => (a(env) > b(env) ? 1 : 0);
        case '>=': return (env) => (a(env) >= b(env) ? 1 : 0);
        case '==': return (env) => (a(env) === b(env) ? 1 : 0);
        case '!=': return (env) => (a(env) !== b(env) ? 1 : 0);
        case '&&': return (env) => (a(env) !== 0 && b(env) !== 0 ? 1 : 0);
        case '||': return (env) => (a(env) !== 0 || b(env) !== 0 ? 1 : 0);
        default: throw new ExpressionError(`Unknown operator ${node.op}.`);
      }
    }
    case 'call': {
      const args = node.args.map((arg) => compile(arg, slotOf));
      const [x, y, z] = args as [Compiled, Compiled | undefined, Compiled | undefined];
      switch (node.fn) {
        case 'min': return (env) => { let m = args[0]!(env); for (let i = 1; i < args.length; i++) { const v = args[i]!(env); if (v < m || Number.isNaN(v)) m = v; } return m; };
        case 'max': return (env) => { let m = args[0]!(env); for (let i = 1; i < args.length; i++) { const v = args[i]!(env); if (v > m || Number.isNaN(v)) m = v; } return m; };
        case 'abs': return (env) => Math.abs(x(env));
        case 'floor': return (env) => Math.floor(x(env));
        case 'ceil': return (env) => Math.ceil(x(env));
        case 'round': return (env) => Math.round(x(env));
        case 'sqrt': return (env) => Math.sqrt(x(env));
        case 'pow': return (env) => Math.pow(x(env), y!(env));
        case 'if': return (env) => (x(env) !== 0 ? y!(env) : z!(env));
        case 'clamp': return (env) => Math.min(Math.max(x(env), y!(env)), z!(env));
        default: throw new ExpressionError(`Unknown function ${node.fn}.`);
      }
    }
    default: throw new ExpressionError('Unknown node.');
  }
}
