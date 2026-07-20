// Chunk mesh builder: culled cube faces + cross-shaped plants, with per-vertex
// ambient occlusion and smooth lighting (sky + block light averaged per vertex).
// Vertex color channels carry: r = sky light, g = block light, b = AO * face shade.
// Outputs raw typed arrays (three.js-free) so it can run in headless tests.

import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants';
import { B, BLOCKS, RENDER_CROSS, RENDER_NONE, isOpaqueCube } from '../blocks';
import { uvRect } from '../render/tiles';
import { hash2 } from '../utils/noise';
import { Chunk, chunkIndex } from './chunk';

export interface GeometryData {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface ChunkMeshData {
  opaque: GeometryData | null;
  cutout: GeometryData | null;
  water: GeometryData | null;
}

interface ChunkSource {
  getGeneratedChunk(cx: number, cz: number): Chunk | null;
}

const H = WORLD_HEIGHT;
const P = CHUNK_SIZE + 2; // padded span (one extra column on each side)

// Scratch padded copies of blocks/light/meta, reused across calls (single-threaded).
const padBlocks = new Uint8Array(P * P * H);
const padLight = new Uint8Array(P * P * H);
const padMeta = new Uint8Array(P * P * H);

function pcol(px: number, pz: number): number {
  return ((px + 1) * P + (pz + 1)) * H;
}

function padBlockAt(px: number, y: number, pz: number): number {
  if (y < 0) return B.Bedrock;
  if (y >= H) return B.Air;
  return padBlocks[pcol(px, pz) + y];
}

function padSkyAt(px: number, y: number, pz: number): number {
  if (y < 0) return 0;
  if (y >= H) return 15;
  return padLight[pcol(px, pz) + y] >> 4;
}

function padBlockLightAt(px: number, y: number, pz: number): number {
  if (y < 0 || y >= H) return 0;
  return padLight[pcol(px, pz) + y] & 0xf;
}

interface FaceDef {
  dir: readonly [number, number, number];
  corners: ReadonlyArray<readonly [number, number, number]>;
  shade: number;
  /** Position component indices used for the uv mapping (u axis, v axis). */
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
}

// Corner order is CCW seen from outside (verified windings).
const FACES: FaceDef[] = [
  { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.68, uAxis: 2, vAxis: 1 },
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.68, uAxis: 2, vAxis: 1 },
  { dir: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], shade: 1.0, uAxis: 0, vAxis: 2 },
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.55, uAxis: 0, vAxis: 2 },
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.84, uAxis: 0, vAxis: 1 },
  { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.84, uAxis: 0, vAxis: 1 },
];

// Facing meta (0 +z south, 1 -x west, 2 -z north, 3 +x east) -> face index that shows the front tile.
const FACING_TO_FACE = [4, 1, 5, 0];

const AO_FACTORS = [0.42, 0.62, 0.8, 1.0];

class MeshBuilder {
  positions: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  vertexCount = 0;

  pushVertex(x: number, y: number, z: number, u: number, v: number, sky: number, blk: number, ao: number): number {
    this.positions.push(x, y, z);
    this.uvs.push(u, v);
    this.colors.push(sky, blk, ao);
    return this.vertexCount++;
  }

  quad(i0: number, i1: number, i2: number, i3: number, flip: boolean): void {
    if (!flip) {
      this.indices.push(i0, i1, i2, i0, i2, i3);
    } else {
      this.indices.push(i1, i2, i3, i1, i3, i0);
    }
  }

  build(): GeometryData | null {
    if (this.vertexCount === 0) return null;
    return {
      positions: new Float32Array(this.positions),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** Average light around a face vertex (standard smooth-lighting neighborhood). */
function vertexLight(
  nx: number, ny: number, nz: number,
  du: readonly [number, number, number], dv: readonly [number, number, number],
  s1Solid: boolean, s2Solid: boolean,
): [number, number, number] {
  // AO from the two edge cells + corner cell.
  const cornerX = nx + du[0] + dv[0];
  const cornerY = ny + du[1] + dv[1];
  const cornerZ = nz + du[2] + dv[2];
  const cSolid = isOpaqueCube(padBlockAt(cornerX, cornerY, cornerZ));
  const ao = s1Solid && s2Solid ? 0 : 3 - ((s1Solid ? 1 : 0) + (s2Solid ? 1 : 0) + (cSolid ? 1 : 0));

  let sky = padSkyAt(nx, ny, nz);
  let blk = padBlockLightAt(nx, ny, nz);
  let count = 1;
  if (!s1Solid) {
    sky += padSkyAt(nx + du[0], ny + du[1], nz + du[2]);
    blk += padBlockLightAt(nx + du[0], ny + du[1], nz + du[2]);
    count++;
  }
  if (!s2Solid) {
    sky += padSkyAt(nx + dv[0], ny + dv[1], nz + dv[2]);
    blk += padBlockLightAt(nx + dv[0], ny + dv[1], nz + dv[2]);
    count++;
  }
  if (!(s1Solid && s2Solid) && !cSolid) {
    sky += padSkyAt(cornerX, cornerY, cornerZ);
    blk += padBlockLightAt(cornerX, cornerY, cornerZ);
    count++;
  }
  return [sky / (count * 15), blk / (count * 15), AO_FACTORS[ao]];
}

export function buildChunkMesh(source: ChunkSource, chunk: Chunk): ChunkMeshData {
  const { cx, cz } = chunk;

  // Fill padded block/light copies (self + neighbor borders, incl. diagonals).
  for (let px = -1; px <= CHUNK_SIZE; px++) {
    for (let pz = -1; pz <= CHUNK_SIZE; pz++) {
      const wx = cx * CHUNK_SIZE + px;
      const wz = cz * CHUNK_SIZE + pz;
      const nb = source.getGeneratedChunk(wx >> 4, wz >> 4);
      const dst = pcol(px, pz);
      if (nb) {
        const src = chunkIndex(wx & 15, 0, wz & 15);
        padBlocks.set(nb.blocks.subarray(src, src + H), dst);
        padLight.set(nb.light.subarray(src, src + H), dst);
        padMeta.set(nb.meta.subarray(src, src + H), dst);
      } else {
        padBlocks.fill(B.Air, dst, dst + H);
        padLight.fill(0xf0, dst, dst + H); // unloaded: pretend fully sunlit air
        padMeta.fill(0, dst, dst + H);
      }
    }
  }

  const opaque = new MeshBuilder();
  const cutout = new MeshBuilder();
  const water = new MeshBuilder();

  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const col = pcol(x, z);
      for (let y = 0; y < H; y++) {
        const id = padBlocks[col + y];
        if (id === B.Air) continue;
        const def = BLOCKS[id];
        if (def.render === RENDER_NONE) continue;

        if (def.render === RENDER_CROSS) {
          emitCross(cutout, x, y, z, id, cx, cz);
          continue;
        }

        const builder = def.liquid ? water : def.opacity < 15 ? cutout : opaque;
        const tiles = def.tiles;
        const frontFace = def.hasFacing && tiles.front !== undefined
          ? FACING_TO_FACE[padMeta[col + y] & 3]
          : -1;
        const partial = def.height < 1;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = x + face.dir[0];
          const ny = y + face.dir[1];
          const nz = z + face.dir[2];
          const nb = padBlockAt(nx, ny, nz);
          // Partial blocks: only the bottom face can be culled by a neighbor.
          if (isOpaqueCube(nb) && (!partial || f === 3)) continue;
          if (def.cullSame && nb === id) continue;

          const tile = f === 2 ? tiles.top : f === 3 ? tiles.bottom : f === frontFace ? tiles.front! : tiles.side;
          const uv = uvRect(tile);
          const flatFace = def.liquid; // water skips AO (looks cleaner)

          const idx: number[] = [];
          const aoKey: number[] = [];
          for (let ci = 0; ci < 4; ci++) {
            const c = face.corners[ci];
            // Tangent offsets for this corner (±1 along the two in-plane axes).
            const t1: 0 | 1 | 2 = face.dir[0] !== 0 ? 1 : 0;
            const t2: 0 | 1 | 2 = face.dir[2] !== 0 ? 1 : 2;
            const a = c[t1] === 1 ? 1 : -1;
            const bSign = c[t2] === 1 ? 1 : -1;
            const du: [number, number, number] = [0, 0, 0];
            const dv: [number, number, number] = [0, 0, 0];
            du[t1] = a;
            dv[t2] = bSign;

            let sky: number, blk: number, ao: number;
            if (flatFace) {
              sky = padSkyAt(nx, ny, nz) / 15;
              blk = padBlockLightAt(nx, ny, nz) / 15;
              ao = 1;
            } else {
              const s1 = isOpaqueCube(padBlockAt(nx + du[0], ny + du[1], nz + du[2]));
              const s2 = isOpaqueCube(padBlockAt(nx + dv[0], ny + dv[1], nz + dv[2]));
              [sky, blk, ao] = vertexLight(nx, ny, nz, du, dv, s1, s2);
            }

            const u = uv.u0 + (uv.u1 - uv.u0) * c[face.uAxis];
            const v = uv.v0 + (uv.v1 - uv.v0) * c[face.vAxis];
            idx.push(builder.pushVertex(x + c[0], y + c[1] * def.height, z + c[2], u, v, sky, blk, ao * face.shade));
            aoKey.push(ao + sky);
          }
          // Flip the quad diagonal towards the brighter pair to avoid AO anisotropy.
          const flip = aoKey[0] + aoKey[2] < aoKey[1] + aoKey[3];
          builder.quad(idx[0], idx[1], idx[2], idx[3], flip);
        }
      }
    }
  }

  return { opaque: opaque.build(), cutout: cutout.build(), water: water.build() };
}

function emitCross(builder: MeshBuilder, x: number, y: number, z: number, id: number, cx: number, cz: number): void {
  const def = BLOCKS[id];
  const uv = uvRect(def.tiles.side);
  const col = pcol(x, z);
  const sky = (padLight[col + y] >> 4) / 15;
  const blk = (padLight[col + y] & 0xf) / 15;

  // Small deterministic offset so fields of grass don't look like a grid
  // (not for torches/crops which must stay centered).
  let ox = 0;
  let oz = 0;
  if (id !== B.Torch && !def.crop) {
    ox = (hash2(cx * 16 + x, cz * 16 + z, 101) - 0.5) * 0.3;
    oz = (hash2(cx * 16 + x, cz * 16 + z, 202) - 0.5) * 0.3;
  }

  const lo = 0.146;
  const hi = 0.854;
  const quads: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [[lo, lo], [hi, hi], [hi, hi], [lo, lo]],
    [[lo, hi], [hi, lo], [hi, lo], [lo, hi]],
  ];
  for (const q of quads) {
    const i0 = builder.pushVertex(x + q[0][0] + ox, y, z + q[0][1] + oz, uv.u0, uv.v0, sky, blk, 1);
    const i1 = builder.pushVertex(x + q[1][0] + ox, y, z + q[1][1] + oz, uv.u1, uv.v0, sky, blk, 1);
    const i2 = builder.pushVertex(x + q[2][0] + ox, y + 1, z + q[2][1] + oz, uv.u1, uv.v1, sky, blk, 1);
    const i3 = builder.pushVertex(x + q[3][0] + ox, y + 1, z + q[3][1] + oz, uv.u0, uv.v1, sky, blk, 1);
    builder.quad(i0, i1, i2, i3, false);
  }
}
