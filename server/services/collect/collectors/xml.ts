/** A tiny, forgiving XML reader for feeds and sitemaps. It never throws and never expands entities beyond text decoding. */
import { decodeEntities } from '../normalize/index.ts';

export interface XmlNode { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] }

function attrsOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/gi;
  let count = 0;
  for (const m of input.matchAll(re)) {
    if (++count > 400_000) break;
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const node: XmlNode = { name: m[3].toLowerCase(), attrs: attrsOf(m[4] ?? ''), text: '', children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root;
}

export function find(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => { for (const c of n.children) { if (c.name === name) out.push(c); walk(c); } };
  walk(node);
  return out;
}

export const child = (node: XmlNode, ...names: string[]): XmlNode | undefined => node.children.find((c) => names.includes(c.name));
export const childText = (node: XmlNode, ...names: string[]): string | null => {
  const t = child(node, ...names)?.text.trim();
  return t ? t : null;
};
