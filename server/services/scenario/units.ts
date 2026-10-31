/**
 * Units, checked: the dimension of every expression in a scenario model.
 *
 * A scenario model already refuses an identifier it does not declare. What it
 * could not refuse is arithmetic that is well-formed and meaningless — a price
 * per package added to a count of contacts, a cost per mailing multiplied by
 * the number of cities instead of the number of mailings. Each of those is a
 * correct expression that produces a wrong number, and a plan assembled from
 * them reads exactly like one assembled from right ones.
 *
 * So every variable, derived quantity and money line already says its `unit`,
 * and this module infers the unit of each expression from its parts and holds
 * it to the declared one:
 *
 *   * `+`, `-`, comparisons, `min`, `max`, `clamp` and `if` branches need the
 *     same unit on every side;
 *   * `*` and `/` combine units (`USD/package × package = USD`);
 *   * a bare number takes whatever unit the other side needs, so `x + 1` and
 *     `x * 2` are both fine — a literal is a scale or an offset in the unit it
 *     is written beside, never a unit of its own;
 *   * `choice.attribute` has no declared unit and unifies with anything, which
 *     is stated here rather than hidden: a categorical option's attributes are
 *     read in context.
 *
 * A unit is written `token`, `a*b` or `a/b*c` — tokens are words, `1` is
 * dimensionless. Tokens are compared case-insensitively and exactly: `contact`
 * and `contacts` are different units on purpose, because guessing that two
 * spellings mean one thing is the mistake this module exists to catch.
 */
import { parse, type ExprNode } from './expr.ts';

export type Unit = Map<string, number>;

export class UnitError extends Error {}

const DIMENSIONLESS = new Set(['', '1', 'share', 'ratio', 'fraction', 'count_ratio']);

/** Parse a unit string. Throws on anything that is not tokens separated by `*` and `/`. */
export function parseUnit(raw: string): Unit {
  const text = (raw ?? '').trim().toLowerCase();
  const unit: Unit = new Map();
  if (DIMENSIONLESS.has(text)) return unit;
  if (!/^[a-z0-9_]+(\s*[*/]\s*[a-z0-9_]+)*$/.test(text)) {
    throw new UnitError(`"${raw}" is not a unit this model can check: write tokens joined by * and /, e.g. USD/package.`);
  }
  let sign = 1;
  for (const part of text.split(/\s*([*/])\s*/)) {
    if (part === '*') { sign = 1; continue; }
    if (part === '/') { sign = -1; continue; }
    if (DIMENSIONLESS.has(part)) continue;
    unit.set(part, (unit.get(part) ?? 0) + sign);
    if (unit.get(part) === 0) unit.delete(part);
  }
  return unit;
}

export function formatUnit(unit: Unit): string {
  const up = [...unit].filter(([, e]) => e > 0).sort(([a], [b]) => a.localeCompare(b));
  const down = [...unit].filter(([, e]) => e < 0).sort(([a], [b]) => a.localeCompare(b));
  const side = (list: [string, number][]) => list.map(([t, e]) => (Math.abs(e) === 1 ? t : `${t}^${Math.abs(e)}`)).join('*');
  if (up.length === 0 && down.length === 0) return '1';
  return `${up.length ? side(up) : '1'}${down.length ? `/${side(down)}` : ''}`;
}

export function sameUnit(a: Unit, b: Unit): boolean {
  if (a.size !== b.size) return false;
  for (const [t, e] of a) if (b.get(t) !== e) return false;
  return true;
}

function combine(a: Unit, b: Unit, sign: 1 | -1): Unit {
  const out: Unit = new Map(a);
  for (const [t, e] of b) {
    const next = (out.get(t) ?? 0) + sign * e;
    if (next === 0) out.delete(t);
    else out.set(t, next);
  }
  return out;
}

/**
 * The inferred unit of an expression. `ANY` unifies with everything (a bare
 * number, a choice attribute); `FIXED` is a definite unit.
 */
type Inferred = { kind: 'ANY' } | { kind: 'FIXED'; unit: Unit };

const ANY: Inferred = { kind: 'ANY' };

function unify(a: Inferred, b: Inferred, where: string): Inferred {
  if (a.kind === 'ANY') return b;
  if (b.kind === 'ANY') return a;
  if (!sameUnit(a.unit, b.unit)) {
    throw new UnitError(`${where} mixes ${formatUnit(a.unit)} with ${formatUnit(b.unit)}`);
  }
  return a;
}

function dimensionless(): Inferred {
  return { kind: 'FIXED', unit: new Map() };
}

function infer(node: ExprNode, unitOf: (name: string) => Unit | null, source: string): Inferred {
  switch (node.t) {
    case 'num':
      return ANY;
    case 'id': {
      const u = unitOf(node.name);
      return u === null ? ANY : { kind: 'FIXED', unit: u };
    }
    case 'neg':
      return infer(node.a, unitOf, source);
    case 'bin': {
      const a = infer(node.a, unitOf, source);
      const b = infer(node.b, unitOf, source);
      switch (node.op) {
        case '+':
        case '-':
          return unify(a, b, `"${source}": ${node.op}`);
        case '*':
        case '/':
          if (a.kind === 'ANY' && b.kind === 'ANY') return ANY;
          if (a.kind === 'ANY') return node.op === '*' ? b : { kind: 'FIXED', unit: combine(new Map(), (b as { unit: Unit }).unit, -1) };
          if (b.kind === 'ANY') return a;
          return { kind: 'FIXED', unit: combine(a.unit, b.unit, node.op === '*' ? 1 : -1) };
        case '^': {
          if (a.kind === 'FIXED' && a.unit.size > 0) {
            if (node.b.t !== 'num' || !Number.isInteger(node.b.v)) {
              throw new UnitError(`"${source}": a quantity in ${formatUnit(a.unit)} may only be raised to a whole-number literal power`);
            }
            const out: Unit = new Map();
            for (const [t, e] of a.unit) out.set(t, e * node.b.v);
            return { kind: 'FIXED', unit: out };
          }
          return a;
        }
        case '<': case '>': case '<=': case '>=': case '==': case '!=':
          unify(a, b, `"${source}": comparison`);
          return dimensionless();
        case '&&': case '||':
          return dimensionless();
        default:
          throw new UnitError(`"${source}": operator ${node.op} has no unit rule`);
      }
    }
    case 'call': {
      const args = node.args.map((x) => infer(x, unitOf, source));
      switch (node.fn) {
        case 'min': case 'max': case 'clamp':
          return args.reduce((acc, x) => unify(acc, x, `"${source}": ${node.fn}()`), ANY);
        case 'abs': case 'floor': case 'ceil': case 'round':
          return args[0]!;
        case 'if':
          return unify(args[1]!, args[2]!, `"${source}": if()`);
        case 'sqrt': {
          const a = args[0]!;
          if (a.kind === 'ANY' || a.unit.size === 0) return a;
          const out: Unit = new Map();
          for (const [t, e] of a.unit) {
            if (e % 2 !== 0) throw new UnitError(`"${source}": sqrt of ${formatUnit(a.unit)} has no unit`);
            out.set(t, e / 2);
          }
          return { kind: 'FIXED', unit: out };
        }
        case 'pow': {
          const a = args[0]!;
          if (a.kind === 'FIXED' && a.unit.size > 0) {
            const exp = node.args[1]!;
            if (exp.t !== 'num' || !Number.isInteger(exp.v)) throw new UnitError(`"${source}": pow of a quantity in ${formatUnit(a.unit)} needs a whole-number literal exponent`);
            const out: Unit = new Map();
            for (const [t, e] of a.unit) out.set(t, e * exp.v);
            return { kind: 'FIXED', unit: out };
          }
          return a;
        }
        default:
          throw new UnitError(`"${source}": ${node.fn}() has no unit rule`);
      }
    }
  }
}

/**
 * Check one expression against the unit it is declared to produce. Returns a
 * problem sentence, or null when the units agree.
 */
export function checkExpressionUnit(expr: string, declared: string, unitOf: (name: string) => Unit | null): string | null {
  try {
    const want = parseUnit(declared);
    const got = infer(parse(expr), unitOf, expr);
    if (got.kind === 'ANY') return null;
    if (!sameUnit(got.unit, want)) return `"${expr}" produces ${formatUnit(got.unit)} but is declared as ${formatUnit(want)}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The unit an expression produces, for a check that compares two expressions. */
export function unitOfExpression(expr: string, unitOf: (name: string) => Unit | null): Unit | null {
  const got = infer(parse(expr), unitOf, expr);
  return got.kind === 'ANY' ? null : got.unit;
}
