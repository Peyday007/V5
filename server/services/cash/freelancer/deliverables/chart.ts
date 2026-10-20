/**
 * Bar, line and pie charts as SVG, drawn from the numbers in a spec.
 *
 * One drawing serves every format: a PNG of it is embedded in a slide, a Word
 * document and a PDF. The axis is computed from the data rather than chosen,
 * and a negative bar is drawn below the zero line rather than clipped.
 */
import type { ChartSpec } from './spec.ts';
import { esc } from './xml.ts';
import { FONT_FAMILY } from './raster.ts';

export const PALETTE = ['#2E5AAC', '#E07B39', '#3A9D5D', '#C0392B', '#8E5EA2', '#4AA3B5'];

function niceStep(range: number): number {
  const raw = range / 5;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function label(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
  return `${+v.toFixed(2)}`;
}

export function chartSvg(chart: ChartSpec, width = 960, height = 540): string {
  const font = `font-family="${FONT_FAMILY}"`;
  const parts: string[] = [`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`];
  const top = chart.title ? 64 : 28;
  if (chart.title) parts.push(`<text x="${width / 2}" y="38" ${font} font-size="24" font-weight="bold" text-anchor="middle" fill="#222">${esc(chart.title)}</text>`);

  if (chart.type === 'pie') {
    const values = chart.series[0]!.values;
    const total = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
    const cx = width * 0.36;
    const cy = top + (height - top) / 2;
    const r = Math.min(width * 0.3, (height - top) / 2 - 16);
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      const share = Math.max(v, 0) / total;
      const next = angle + share * Math.PI * 2;
      const colour = PALETTE[i % PALETTE.length];
      if (share >= 0.9999) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}"/>`);
      else if (share > 0) {
        const large = next - angle > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(next);
        const y2 = cy + r * Math.sin(next);
        parts.push(`<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${colour}" stroke="#FFF" stroke-width="2"/>`);
      }
      const ly = top + 20 + i * 30;
      parts.push(`<rect x="${width * 0.7}" y="${ly - 14}" width="18" height="18" fill="${colour}"/>`);
      parts.push(`<text x="${width * 0.7 + 28}" y="${ly}" ${font} font-size="17" fill="#222">${esc(chart.categories[i] ?? '')} — ${(share * 100).toFixed(1)}%</text>`);
      angle = next;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
  }

  const all = chart.series.flatMap((s) => s.values);
  let min = Math.min(0, ...all);
  let max = Math.max(0, ...all);
  if (min === max) max = min + 1;
  const step = niceStep(max - min);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const left = 90;
  const right = width - 24;
  const bottom = height - (chart.series.length > 1 ? 86 : 60);
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
  for (let v = min; v <= max + step / 2; v += step) {
    parts.push(`<line x1="${left}" x2="${right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${Math.abs(v) < step / 1e6 ? '#555' : '#DDD'}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 10}" y="${(y(v) + 5).toFixed(1)}" ${font} font-size="14" text-anchor="end" fill="#555">${label(v)}</text>`);
  }
  const n = chart.categories.length;
  const band = (right - left) / n;
  chart.categories.forEach((cat, i) => {
    const text = cat.length > 14 && n > 6 ? `${cat.slice(0, 13)}…` : cat;
    parts.push(`<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${bottom + 22}" ${font} font-size="14" text-anchor="middle" fill="#333">${esc(text)}</text>`);
  });
  if (chart.type === 'bar') {
    const groupWidth = band * 0.72;
    const barWidth = groupWidth / chart.series.length;
    chart.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = left + band * i + (band - groupWidth) / 2 + barWidth * si;
        const y0 = y(0);
        const y1 = y(v);
        parts.push(`<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(barWidth - 2).toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"/>`);
      });
    });
  } else {
    chart.series.forEach((s, si) => {
      const points = s.values.map((v, i) => `${(left + band * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`);
      parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="3"/>`);
      for (const p of points) {
        const [px, py] = p.split(',');
        parts.push(`<circle cx="${px}" cy="${py}" r="4" fill="${PALETTE[si % PALETTE.length]}"/>`);
      }
    });
  }
  if (chart.series.length > 1) {
    let lx = left;
    chart.series.forEach((s, si) => {
      parts.push(`<rect x="${lx}" y="${height - 34}" width="16" height="16" fill="${PALETTE[si % PALETTE.length]}"/>`);
      parts.push(`<text x="${lx + 24}" y="${height - 20}" ${font} font-size="15" fill="#222">${esc(s.name)}</text>`);
      lx += 40 + s.name.length * 9;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}
