/**
 * Translating one SQL dialect into the other, by reading the SQL rather than
 * pattern-matching it.
 *
 * Every query in Brain is written once, in SQLite's dialect, and has to reach
 * Postgres unchanged in meaning. Two things differ and both are load-bearing:
 *
 *   - Parameters. SQLite takes positional `?`; Postgres takes `$1`, `$2`, and
 *     numbers them by first appearance rather than by position in the list.
 *   - `rowid`. SQLite gives every row a hidden insertion counter, and thirty-odd
 *     queries use it as the tiebreaker that makes `ORDER BY created_at, rowid`
 *     a total order rather than an arbitrary one. Postgres has no such column,
 *     so the cloud schema gives every table a `seq` identity column that plays
 *     the same part, and the identifier is translated to match.
 *
 * The reason this is a tokenizer and not a regular expression: a `?` inside a
 * string literal is a question mark, and a column called `rowid_source` is not
 * `rowid`. A regex replace would corrupt both, quietly, in whichever query
 * happened to contain one — which is exactly the class of bug that makes people
 * distrust a database layer. So the translator walks the statement, knows when
 * it is inside a literal, a quoted identifier or a comment, and only rewrites
 * what it is actually looking at.
 */

/** What a translated statement needs in order to be executed. */
export interface TranslatedSql {
  sql: string;
  /** Number of distinct placeholders, for checking the parameter list length. */
  placeholders: number;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

/**
 * Rewrite one SQLite statement for Postgres.
 *
 * Positional order is preserved exactly: the nth `?` becomes `$n`, so the
 * caller's parameter array needs no reordering.
 */
export function toPostgresSql(sql: string): TranslatedSql {
  let out = '';
  let placeholders = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;

    // ---- string literal: '...' with '' as the escape -------------------
    if (char === "'") {
      const end = closingQuote(sql, index, "'");
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // ---- quoted identifier: "..." and SQLite's [..] and `..` -----------
    if (char === '"') {
      const end = closingQuote(sql, index, '"');
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '`' || char === '[') {
      // SQLite accepts both; Postgres accepts neither, so they are rewritten to
      // the standard double-quoted form rather than passed through to fail.
      const closing = char === '`' ? '`' : ']';
      const end = sql.indexOf(closing, index + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += `"${sql.slice(index + 1, stop - 1)}"`;
      index = stop;
      continue;
    }

    // ---- comments ------------------------------------------------------
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    // ---- the placeholder ------------------------------------------------
    if (char === '?') {
      placeholders += 1;
      out += `$${placeholders}`;
      index += 1;
      continue;
    }

    // ---- an identifier, which may be `rowid` ----------------------------
    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < sql.length && IDENTIFIER_PART.test(sql[end]!)) end += 1;
      const word = sql.slice(index, end);
      // Only the whole word, and only when it is not part of a qualified name
      // that already ends in something else (`x.rowid` still means the row
      // counter, so that one is translated; `rowid_source` is not).
      out += word.toLowerCase() === 'rowid' ? 'seq' : word;
      index = end;
      continue;
    }

    out += char;
    index += 1;
  }

  return { sql: out, placeholders };
}

/**
 * Find the index just past a closing quote, honouring doubled-quote escapes.
 *
 * An unterminated literal returns the end of the string rather than throwing:
 * the database is the right thing to report a syntax error, and swallowing it
 * here would replace a precise message with a vague one.
 */
function closingQuote(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/**
 * Split a script into statements the same way, for migration files.
 *
 * `exec` on a multi-statement script is a SQLite convenience; the Postgres
 * driver runs one statement per call inside the migration's transaction, so the
 * script has to be split on semicolons that are really statement separators —
 * not the ones inside a string literal or a comment.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < script.length) {
    const char = script[index]!;

    if (char === "'" || char === '"') {
      const end = closingQuote(script, index, char);
      current += script.slice(index, end);
      index = end;
      continue;
    }
    if (char === '-' && script[index + 1] === '-') {
      const end = script.indexOf('\n', index);
      const stop = end === -1 ? script.length : end;
      current += script.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && script[index + 1] === '*') {
      const end = script.indexOf('*/', index + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
