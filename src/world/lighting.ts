// Flood-fill lighting engine with two channels:
//  - sky light: sunlight columns (level 15) + BFS spread, attenuated by block opacity
//  - block light: emitted by torches/glowstone + BFS spread
// Levels are 0..15, decreasing by max(1, opacity) per step. Direct sunlight (15)
// propagates downward without loss through fully transparent blocks.

import { CHUNK_SIZE, WORLD_HEIGHT, MAX_LIGHT } from '../constants';
import { opacityOf, emissionOf } from '../blocks';
import { Chunk, chunkIndex } from './chunk';

export interface LightWorldAccess {
  getGeneratedChunk(cx: number, cz: number): Chunk | null;
  markMeshDirty(cx: number, cz: number): void;
}

const SKY = 0;
const BLOCK = 1;
type Channel = typeof SKY | typeof BLOCK;

const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

const MAX_BFS_STEPS = 4_000_000;

export class LightEngine {
  private world: LightWorldAccess;
  private cacheCx = 0x7fffffff;
  private cacheCz = 0x7fffffff;
  private cacheChunk: Chunk | null = null;

  // Reusable queues: flat [x, y, z, ...] for adds, [x, y, z, level, ...] for removals.
  private addQ: number[][] = [[], []];
  private removeQ: number[] = [];

  constructor(world: LightWorldAccess) {
    this.world = world;
  }

  invalidateCache(): void {
    this.cacheCx = 0x7fffffff;
    this.cacheCz = 0x7fffffff;
    this.cacheChunk = null;
  }

  private chunkFor(wx: number, wz: number): Chunk | null {
    const cx = wx >> 4;
    const cz = wz >> 4;
    if (cx === this.cacheCx && cz === this.cacheCz) return this.cacheChunk;
    this.cacheCx = cx;
    this.cacheCz = cz;
    this.cacheChunk = this.world.getGeneratedChunk(cx, cz);
    return this.cacheChunk;
  }

  getBlockId(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= WORLD_HEIGHT) return 0;
    const ch = this.chunkFor(wx, wz);
    if (!ch) return 0;
    return ch.blocks[chunkIndex(wx & 15, wy, wz & 15)];
  }

  get(ch: Channel, wx: number, wy: number, wz: number): number {
    if (wy >= WORLD_HEIGHT) return ch === SKY ? MAX_LIGHT : 0;
    if (wy < 0) return 0;
    const c = this.chunkFor(wx, wz);
    if (!c) return ch === SKY ? MAX_LIGHT : 0;
    const i = chunkIndex(wx & 15, wy, wz & 15);
    return ch === SKY ? c.light[i] >> 4 : c.light[i] & 0xf;
  }

  /** Sets a light value; marks affected chunk meshes dirty. Returns false if the cell is unavailable. */
  private set(ch: Channel, wx: number, wy: number, wz: number, v: number): boolean {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const c = this.chunkFor(wx, wz);
    if (!c) return false;
    const lx = wx & 15;
    const lz = wz & 15;
    const i = chunkIndex(lx, wy, lz);
    const old = c.light[i];
    const next = ch === SKY ? (old & 0x0f) | (v << 4) : (old & 0xf0) | v;
    if (next === old) return true;
    c.light[i] = next;

    // Border light changes affect neighbor chunk meshes (smooth lighting samples across borders).
    const cx = c.cx;
    const cz = c.cz;
    this.world.markMeshDirty(cx, cz);
    if (lx === 0) this.world.markMeshDirty(cx - 1, cz);
    if (lx === 15) this.world.markMeshDirty(cx + 1, cz);
    if (lz === 0) this.world.markMeshDirty(cx, cz - 1);
    if (lz === 15) this.world.markMeshDirty(cx, cz + 1);
    if (lx === 0 && lz === 0) this.world.markMeshDirty(cx - 1, cz - 1);
    if (lx === 0 && lz === 15) this.world.markMeshDirty(cx - 1, cz + 1);
    if (lx === 15 && lz === 0) this.world.markMeshDirty(cx + 1, cz - 1);
    if (lx === 15 && lz === 15) this.world.markMeshDirty(cx + 1, cz + 1);
    return true;
  }

  /** BFS spread from every queued source cell (levels read live from storage). */
  private drainAdd(ch: Channel): void {
    const q = this.addQ[ch];
    let head = 0;
    let steps = 0;
    while (head < q.length) {
      if (++steps > MAX_BFS_STEPS) { console.warn('light add BFS aborted'); break; }
      const x = q[head++];
      const y = q[head++];
      const z = q[head++];
      const lv = this.get(ch, x, y, z);
      if (lv <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const dir = DIRS[d];
        const nx = x + dir[0];
        const ny = y + dir[1];
        const nz = z + dir[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nb = this.getBlockId(nx, ny, nz);
        const op = opacityOf(nb);
        if (op >= 15) continue;
        const target = ch === SKY && dir[1] === -1 && lv === MAX_LIGHT && op === 0
          ? MAX_LIGHT
          : lv - Math.max(1, op);
        if (target > 0 && target > this.get(ch, nx, ny, nz)) {
          if (this.set(ch, nx, ny, nz, target)) q.push(nx, ny, nz);
        }
      }
    }
    q.length = 0;
  }

  /**
   * BFS un-spread: removes light that descended from a removed source; boundary
   * cells that still hold light are queued into addQ for re-propagation.
   */
  private drainRemove(ch: Channel): void {
    const q = this.removeQ;
    const addQ = this.addQ[ch];
    let head = 0;
    let steps = 0;
    while (head < q.length) {
      if (++steps > MAX_BFS_STEPS) { console.warn('light remove BFS aborted'); break; }
      const x = q[head++];
      const y = q[head++];
      const z = q[head++];
      const lv = q[head++];
      for (let d = 0; d < 6; d++) {
        const dir = DIRS[d];
        const nx = x + dir[0];
        const ny = y + dir[1];
        const nz = z + dir[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const nl = this.get(ch, nx, ny, nz);
        if (nl === 0) continue;
        // Downward direct sunlight (15) depends on the cell above, so it is removed too.
        if (nl < lv || (ch === SKY && dir[1] === -1 && lv === MAX_LIGHT && nl === MAX_LIGHT)) {
          if (this.set(ch, nx, ny, nz, 0)) q.push(nx, ny, nz, nl);
        } else {
          addQ.push(nx, ny, nz);
        }
      }
    }
    q.length = 0;
  }

  /**
   * Initial lighting for a freshly generated chunk, plus light exchange with
   * already-lit neighbor chunks.
   */
  initChunk(chunk: Chunk): void {
    this.invalidateCache();
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const blocks = chunk.blocks;
    const light = chunk.light;
    const addSky = this.addQ[SKY];
    const addBlock = this.addQ[BLOCK];

    // 1) Direct sunlight columns (top-down), attenuated by opacity.
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const colBase = chunkIndex(lx, 0, lz);
        let lv = MAX_LIGHT;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const i = colBase + y;
          const op = opacityOf(blocks[i]);
          if (op > 0) lv = Math.max(0, lv - op);
          if (lv === 0) break;
          light[i] = (light[i] & 0x0f) | (lv << 4);
          // Seed lateral spread for every sunlit cell.
          addSky.push(baseX + lx, y, baseZ + lz);
        }
      }
    }

    // 2) Emissive blocks (from edits applied before lighting, e.g. saved glowstone).
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const colBase = chunkIndex(lx, 0, lz);
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const em = emissionOf(blocks[colBase + y]);
          if (em > 0) {
            light[colBase + y] = (light[colBase + y] & 0xf0) | em;
            addBlock.push(baseX + lx, y, baseZ + lz);
          }
        }
      }
    }

    // 3) Pull light in from generated neighbors (their border columns become sources).
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nb = this.world.getGeneratedChunk(chunk.cx + dx, chunk.cz + dz);
      if (!nb) continue;
      const nBaseX = nb.cx * CHUNK_SIZE;
      const nBaseZ = nb.cz * CHUNK_SIZE;
      // The neighbor's edge row facing us.
      const lx = dx === 1 ? 0 : dx === -1 ? 15 : -1;
      const lz = dz === 1 ? 0 : dz === -1 ? 15 : -1;
      for (let k = 0; k < CHUNK_SIZE; k++) {
        const nlx = lx >= 0 ? lx : k;
        const nlz = lz >= 0 ? lz : k;
        const colBase = chunkIndex(nlx, 0, nlz);
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const packed = nb.light[colBase + y];
          if (packed >> 4 > 1) addSky.push(nBaseX + nlx, y, nBaseZ + nlz);
          if ((packed & 0xf) > 1) addBlock.push(nBaseX + nlx, y, nBaseZ + nlz);
        }
      }
    }

    this.drainAdd(SKY);
    this.drainAdd(BLOCK);
  }

  /** Incremental relight after a single block edit. Call AFTER the block array was updated. */
  onBlockChanged(x: number, y: number, z: number, oldId: number, newId: number): void {
    this.invalidateCache();
    const oldOp = opacityOf(oldId);
    const newOp = opacityOf(newId);
    const oldEm = emissionOf(oldId);
    const newEm = emissionOf(newId);
    const addSky = this.addQ[SKY];
    const addBlock = this.addQ[BLOCK];

    // ---- block light channel ----
    if (oldEm > 0 || newOp > oldOp) {
      const lv = this.get(BLOCK, x, y, z);
      if (lv > 0) {
        this.set(BLOCK, x, y, z, 0);
        this.removeQ.push(x, y, z, lv);
        this.drainRemove(BLOCK);
      }
    }
    if (newEm > 0 && newEm > this.get(BLOCK, x, y, z)) {
      this.set(BLOCK, x, y, z, newEm);
      addBlock.push(x, y, z);
    }
    if (newOp < oldOp) {
      for (const d of DIRS) addBlock.push(x + d[0], y + d[1], z + d[2]);
    }
    this.drainAdd(BLOCK);

    // ---- sky light channel ----
    if (newOp > oldOp) {
      const lv = this.get(SKY, x, y, z);
      const hadDirectSun = lv === MAX_LIGHT;
      if (lv > 0) {
        this.set(SKY, x, y, z, 0);
        this.removeQ.push(x, y, z, lv);
      }
      if (hadDirectSun) {
        // The direct-sun column below no longer receives 15.
        let yy = y - 1;
        while (yy >= 0 && this.get(SKY, x, yy, z) === MAX_LIGHT) {
          this.set(SKY, x, yy, z, 0);
          this.removeQ.push(x, yy, z, MAX_LIGHT);
          yy--;
        }
      }
      if (this.removeQ.length > 0) this.drainRemove(SKY);
      // If the new block is only partially opaque (water/leaves), sun still filters through.
      if (newOp < 15) {
        const above = this.get(SKY, x, y + 1, z);
        if (above > 0) addSky.push(x, y + 1, z);
      }
    } else if (newOp < oldOp) {
      const above = y + 1 >= WORLD_HEIGHT ? MAX_LIGHT : this.get(SKY, x, y + 1, z);
      if (above === MAX_LIGHT) {
        // Direct sunlight extends down through the newly transparent cell.
        let yy = y;
        while (yy >= 0) {
          if (opacityOf(this.getBlockId(x, yy, z)) > 0) break;
          if (!this.set(SKY, x, yy, z, MAX_LIGHT)) break;
          addSky.push(x, yy, z);
          yy--;
        }
      }
      for (const d of DIRS) addSky.push(x + d[0], y + d[1], z + d[2]);
    }
    this.drainAdd(SKY);
  }
}
