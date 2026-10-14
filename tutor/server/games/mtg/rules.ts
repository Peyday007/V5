import type { Db } from '../../store/db.ts';
import { getMeta, setMeta } from '../../store/db.ts';

/**
 * The Magic Comprehensive Rules, retrieved from Wizards' rules page
 * (https://magic.wizards.com/en/rules), parsed into numbered rules and glossary entries, and
 * kept with the URL and effective date they came from.
 */
export interface RulesInfo { url: string | null; effective: string | null; rules: number; glossary: number }
export interface RuleRef { number: string; text: string }

export class RulesBook {
  constructor(private db: Db, private pageUrl: string, private userAgent: string, private fetchImpl: typeof fetch = fetch) {}

  info(): RulesInfo {
    const rules = (this.db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
    const glossary = (this.db.prepare('SELECT COUNT(*) AS n FROM glossary').get() as { n: number }).n;
    return { url: getMeta(this.db, 'rules_url'), effective: getMeta(this.db, 'rules_effective'), rules, glossary };
  }

  async sync(): Promise<RulesInfo> {
    const page = await (await this.fetchImpl(this.pageUrl, { headers: { 'User-Agent': this.userAgent } })).text();
    const m = page.match(/https:\/\/media\.wizards\.com\/[^"'<>]+?\.txt/);
    if (!m) throw new Error('The rules page no longer links a .txt Comprehensive Rules file.');
    const url = m[0].replace(/ /g, '%20');
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error(`Comprehensive Rules download answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // The file has been published as UTF-8 and as Windows-1252 over the years.
    let text = buf.toString('utf8');
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    this.load(text, url);
    return this.info();
  }

  load(text: string, url: string): void {
    const { rules, glossary, effective } = parseRules(text);
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM rules; DELETE FROM glossary;');
      const r = this.db.prepare('INSERT OR REPLACE INTO rules (number, text) VALUES (?, ?)');
      for (const [k, v] of rules) r.run(k, v);
      const g = this.db.prepare('INSERT OR REPLACE INTO glossary (term, text) VALUES (?, ?)');
      for (const [k, v] of glossary) g.run(k.toLowerCase(), `${k}\n${v}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    setMeta(this.db, 'rules_url', url);
    if (effective) setMeta(this.db, 'rules_effective', effective);
  }

  rule(number: string): RuleRef | null {
    const r = this.db.prepare('SELECT number, text FROM rules WHERE number = ?').get(number) as RuleRef | undefined;
    return r ?? null;
  }

  /** A rule and its lettered subrules (e.g. "702.19" → 702.19a, 702.19b, ...). */
  section(number: string, max = 6): RuleRef[] {
    const head = this.rule(number);
    const subs = this.db.prepare("SELECT number, text FROM rules WHERE number GLOB ? ORDER BY number LIMIT ?").all(`${number}[a-z]`, max) as unknown as RuleRef[];
    return head ? [head, ...subs] : subs;
  }

  glossary(term: string): string | null {
    const r = this.db.prepare('SELECT text FROM glossary WHERE term = ?').get(term.toLowerCase()) as { text: string } | undefined;
    return r?.text ?? null;
  }

  /** The keyword ability or keyword action rule that defines this keyword, if any. */
  keywordRule(keyword: string): RuleRef | null {
    const kw = keyword.toLowerCase();
    const rows = this.db.prepare("SELECT number, text FROM rules WHERE (number GLOB '702.[0-9]*' OR number GLOB '701.[0-9]*') AND number NOT GLOB '*[a-z]' AND lower(text) = ?").all(kw) as unknown as RuleRef[];
    return rows[0] ?? null;
  }
}

export function parseRules(text: string): { rules: Map<string, string>; glossary: Map<string, string>; effective: string | null } {
  const lines = text.replace(/\r/g, '').split('\n');
  const rules = new Map<string, string>();
  const glossary = new Map<string, string>();
  const eff = text.match(/effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  // The table of contents repeats the headings; the rules proper begin at the second "1. Game Concepts".
  let start = 0, seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === '1. Game Concepts') { seen++; if (seen === 2) { start = i; break; } }
  }
  let i = start;
  let inGlossary = false;
  let current: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === 'Glossary') { inGlossary = true; current = null; i++; break; }
    const m = line.match(/^(\d{3}\.\d+[a-z]?\.?|\d{3}\.)\s+(.*)$/);
    if (m) {
      const num = m[1]!.endsWith('.') && /\d{3}\.\d+\.$/.test(m[1]!) ? m[1]!.slice(0, -1) : m[1]!.replace(/\.$/, '');
      rules.set(num, m[2]!);
      current = num;
    } else if (line && current && !/^\d+\. /.test(line)) {
      rules.set(current, rules.get(current) + '\n' + line);
    } else if (!line) {
      current = null;
    }
  }
  if (inGlossary) {
    let term: string | null = null;
    let body: string[] = [];
    for (; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === 'Credits') break;
      if (!line) {
        if (term) glossary.set(term, body.join('\n'));
        term = null; body = [];
      } else if (!term) term = line;
      else body.push(line);
    }
    if (term) glossary.set(term, body.join('\n'));
  }
  return { rules, glossary, effective: eff ? eff[1]! : null };
}
