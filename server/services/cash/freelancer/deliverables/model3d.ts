/**
 * Basic 3D models from primitives: OBJ (+MTL), binary STL and glTF 2.0, and a
 * shaded preview image.
 *
 * Boxes, cylinders, spheres and cones, each placed, rotated and coloured. That
 * covers simple product mock-ups, packaging, furniture blocks, enclosures and
 * scene layouts. It is not sculpting, character modelling or photoreal
 * rendering, and the capability says so rather than taking that work.
 */
import type { Part3D } from './spec.ts';
import { esc } from './xml.ts';
import { svgToPng } from './raster.ts';

type V3 = [number, number, number];
export interface Mesh {
  name: string;
  color: string;
  positions: V3[];
  triangles: [number, number, number][];
}

const SEGMENTS = 32;

function rotate(p: V3, deg: V3): V3 {
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180) as V3;
  let [x, y, z] = p;
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  return [x, y, z];
}

export function meshOf(part: Part3D): Mesh {
  const positions: V3[] = [];
  const triangles: [number, number, number][] = [];
  const quad = (a: number, b: number, c: number, d: number) => triangles.push([a, b, c], [a, c, d]);
  switch (part.shape) {
    case 'box': {
      const [sx, sy, sz] = part.size.map((v) => v / 2) as V3;
      for (const [x, y, z] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] as V3[]) positions.push([x * sx, y * sy, z * sz]);
      quad(0, 3, 2, 1); quad(4, 5, 6, 7); quad(0, 1, 5, 4); quad(2, 3, 7, 6); quad(1, 2, 6, 5); quad(0, 4, 7, 3);
      break;
    }
    case 'cylinder':
    case 'cone': {
      const [r, h] = part.size as [number, number];
      const top = part.shape === 'cone' ? 0 : r;
      for (let i = 0; i < SEGMENTS; i += 1) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        positions.push([r * Math.cos(a), -h / 2, r * Math.sin(a)], [top * Math.cos(a), h / 2, top * Math.sin(a)]);
      }
      const bottomCentre = positions.push([0, -h / 2, 0]) - 1;
      const topCentre = positions.push([0, h / 2, 0]) - 1;
      for (let i = 0; i < SEGMENTS; i += 1) {
        const j = (i + 1) % SEGMENTS;
        quad(2 * i, 2 * i + 1, 2 * j + 1, 2 * j);
        triangles.push([bottomCentre, 2 * i, 2 * j], [topCentre, 2 * j + 1, 2 * i + 1]);
      }
      break;
    }
    case 'sphere': {
      const [r] = part.size as [number];
      const rings = 16;
      for (let y = 0; y <= rings; y += 1) {
        const v = (y / rings) * Math.PI;
        for (let x = 0; x < SEGMENTS; x += 1) {
          const u = (x / SEGMENTS) * Math.PI * 2;
          positions.push([r * Math.sin(v) * Math.cos(u), r * Math.cos(v), r * Math.sin(v) * Math.sin(u)]);
        }
      }
      for (let y = 0; y < rings; y += 1) {
        for (let x = 0; x < SEGMENTS; x += 1) {
          const a = y * SEGMENTS + x;
          const b = y * SEGMENTS + ((x + 1) % SEGMENTS);
          // The pole rings collapse to one point, so only one triangle of each quad has area there.
          if (y > 0) triangles.push([a, b, b + SEGMENTS]);
          if (y < rings - 1) triangles.push([a, b + SEGMENTS, a + SEGMENTS]);
        }
      }
      break;
    }
  }
  const rot = part.rotation ?? [0, 0, 0];
  return {
    name: part.name,
    color: part.color,
    positions: positions.map((p) => {
      const r = rotate(p, rot);
      return [r[0] + part.position[0], r[1] + part.position[1], r[2] + part.position[2]];
    }),
    triangles,
  };
}

function rgb(hex: string): V3 {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normal(a: V3, b: V3, c: V3): V3 {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

export function toObj(meshes: Mesh[], mtlName: string): { obj: string; mtl: string } {
  const lines = ['# Brain', `mtllib ${mtlName}`];
  const mtl: string[] = ['# Brain'];
  let base = 1;
  meshes.forEach((m, i) => {
    const material = `m${i}_${m.name.replace(/[^\w]+/g, '_')}`;
    const [r, g, b] = rgb(m.color);
    mtl.push(`newmtl ${material}`, `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`, 'Ka 0 0 0', 'Ks 0.1 0.1 0.1', 'd 1', '');
    lines.push(`o ${m.name.replace(/\s+/g, '_')}`, `usemtl ${material}`);
    for (const p of m.positions) lines.push(`v ${p.map((v) => +v.toFixed(5)).join(' ')}`);
    for (const t of m.triangles) lines.push(`f ${t[0] + base} ${t[1] + base} ${t[2] + base}`);
    base += m.positions.length;
  });
  return { obj: `${lines.join('\n')}\n`, mtl: `${mtl.join('\n')}\n` };
}

export function toStl(meshes: Mesh[]): Buffer {
  const count = meshes.reduce((n, m) => n + m.triangles.length, 0);
  const buf = Buffer.alloc(84 + count * 50);
  buf.write('Brain binary STL', 0, 'ascii');
  buf.writeUInt32LE(count, 80);
  let at = 84;
  for (const m of meshes) {
    for (const t of m.triangles) {
      const [a, b, c] = t.map((i) => m.positions[i]!) as [V3, V3, V3];
      for (const v of [normal(a, b, c), a, b, c]) for (const x of v) {
        buf.writeFloatLE(x, at);
        at += 4;
      }
      at += 2;
    }
  }
  return buf;
}

export function toGltf(meshes: Mesh[]): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const materials: unknown[] = [];
  const gMeshes: unknown[] = [];
  meshes.forEach((m, i) => {
    const pos = Buffer.alloc(m.positions.length * 12);
    m.positions.forEach((p, j) => p.forEach((v, k) => pos.writeFloatLE(v, j * 12 + k * 4)));
    const idx = Buffer.alloc(m.triangles.length * 12);
    m.triangles.forEach((t, j) => t.forEach((v, k) => idx.writeUInt32LE(v, j * 12 + k * 4)));
    const min = [0, 1, 2].map((k) => Math.min(...m.positions.map((p) => p[k]!)));
    const max = [0, 1, 2].map((k) => Math.max(...m.positions.map((p) => p[k]!)));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: pos.length, target: 34962 });
    offset += pos.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: idx.length, target: 34963 });
    offset += idx.length;
    chunks.push(pos, idx);
    accessors.push({ bufferView: 2 * i, componentType: 5126, count: m.positions.length, type: 'VEC3', min, max });
    accessors.push({ bufferView: 2 * i + 1, componentType: 5125, count: m.triangles.length * 3, type: 'SCALAR' });
    materials.push({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...rgb(m.color), 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true });
    gMeshes.push({ name: m.name, primitives: [{ attributes: { POSITION: 2 * i }, indices: 2 * i + 1, material: i }] });
  });
  const data = Buffer.concat(chunks);
  return JSON.stringify({
    asset: { version: '2.0', generator: 'Brain' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({ name: m.name, mesh: i })),
    meshes: gMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: data.length, uri: `data:application/octet-stream;base64,${data.toString('base64')}` }],
  });
}

/** An isometric, flat-shaded picture of the model: painter's algorithm, back faces culled. */
export function previewSvg(meshes: Mesh[], size = 900): string {
  const light: V3 = normal([0, 0, 0], [0.4, 1, 0.2], [-0.6, 0.6, 1]);
  const view = (p: V3): V3 => {
    const r = rotate(rotate(p, [0, -45, 0]), [30, 0, 0]);
    return r;
  };
  const faces: { depth: number; points: [number, number][]; fill: string }[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of meshes) {
    const base = rgb(m.color);
    for (const t of m.triangles) {
      const [a, b, c] = t.map((i) => view(m.positions[i]!)) as [V3, V3, V3];
      const n = normal(a, b, c);
      if (n[2] <= 0) continue;
      const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const shade = 0.45 + 0.55 * lambert;
      const fill = `rgb(${base.map((v) => Math.round(Math.min(1, v * shade) * 255)).join(',')})`;
      const pts = [a, b, c].map((p) => [p[0], -p[1]] as [number, number]);
      for (const [x, y] of pts) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      faces.push({ depth: (a[2] + b[2] + c[2]) / 3, points: pts, fill });
    }
  }
  faces.sort((p, q) => p.depth - q.depth);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (size * 0.84) / span;
  const ox = size / 2 - ((minX + maxX) / 2) * scale;
  const oy = size / 2 - ((minY + maxY) / 2) * scale;
  const polys = faces
    .map((f) => `<polygon points="${f.points.map(([x, y]) => `${(x * scale + ox).toFixed(1)},${(y * scale + oy).toFixed(1)}`).join(' ')}" fill="${f.fill}" stroke="${f.fill}" stroke-width="0.6"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#F2F4F7"/>${polys}<desc>${esc(meshes.map((m) => m.name).join(', '))}</desc></svg>`;
}

export function previewPng(meshes: Mesh[]): { png: Buffer; inkShare: number } {
  const raster = svgToPng(previewSvg(meshes), 900);
  return { png: raster.png, inkShare: raster.inkShare };
}

export function bounds(meshes: Mesh[]): { min: V3; max: V3 } {
  const all = meshes.flatMap((m) => m.positions);
  return {
    min: [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k]!))) as V3,
    max: [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k]!))) as V3,
  };
}
