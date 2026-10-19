/**
 * SVG to PNG, with the fonts this repository ships rather than whatever a
 * machine happens to have — so the same SVG renders the same pixels on a
 * laptop and in the slim production image, which has no fonts of its own.
 *
 * Also the visual half of verification: a rendered image that is all one
 * colour is a blank deliverable, whatever its markup said.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../assets/fonts');
export const FONT_FAMILY = 'DejaVu Sans';
const FONT_FILES = [path.join(FONT_DIR, 'DejaVuSans.ttf'), path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')];

export interface Raster {
  png: Buffer;
  width: number;
  height: number;
  /** Share of pixels that differ from the top-left pixel: 0 means blank. */
  inkShare: number;
  /** Distinct colours seen on a sample grid, a crude measure of content. */
  colours: number;
}

export function svgToPng(svg: string, width?: number): Raster {
  const resvg = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: Math.round(width) } : { mode: 'original' },
    font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY },
    background: 'rgba(255,255,255,1)',
  });
  const image = resvg.render();
  const px = image.pixels;
  const w = image.width;
  const h = image.height;
  let ink = 0;
  let total = 0;
  const colours = new Set<number>();
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40_000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      total += 1;
      if (Math.abs(px[i]! - px[0]!) + Math.abs(px[i + 1]! - px[1]!) + Math.abs(px[i + 2]! - px[2]!) > 24) ink += 1;
      colours.add(((px[i]! >> 4) << 8) | ((px[i + 1]! >> 4) << 4) | (px[i + 2]! >> 4));
    }
  }
  return { png: Buffer.from(image.asPng()), width: w, height: h, inkShare: total ? ink / total : 0, colours: colours.size };
}

/** Read width and height from a PNG header. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
