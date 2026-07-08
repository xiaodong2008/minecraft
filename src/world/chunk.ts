import type * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../constants';

/**
 * Chunk block index. Column-major so a vertical (x,z) column is contiguous:
 * idx = ((x<<4)|z)<<7 | y  — requires CHUNK_SIZE=16 and WORLD_HEIGHT=128.
 */
export function chunkIndex(x: number, y: number, z: number): number {
  return (((x << 4) | z) << 7) | y;
}

export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  /** Block ids. */
  readonly blocks = new Uint8Array(CHUNK_VOLUME);
  /** Per-block metadata (facing 0..3 for furnaces/chests/crafting tables). */
  readonly meta = new Uint8Array(CHUNK_VOLUME);
  /** Packed light: high nibble = sky light, low nibble = block light. */
  readonly light = new Uint8Array(CHUNK_VOLUME);

  generated = false;
  /** Mesh needs (re)building. */
  dirty = false;
  meshes: THREE.Mesh[] = [];
  /** Passive mobs were seeded for this chunk (once per world). */
  mobsSeeded = false;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
  }

  getBlock(x: number, y: number, z: number): number {
    return this.blocks[chunkIndex(x, y, z)];
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    this.blocks[chunkIndex(x, y, z)] = id;
  }

  getSky(i: number): number { return this.light[i] >> 4; }
  getBlockLight(i: number): number { return this.light[i] & 0xf; }
  setSky(i: number, v: number): void { this.light[i] = (this.light[i] & 0x0f) | (v << 4); }
  setBlockLight(i: number, v: number): void { this.light[i] = (this.light[i] & 0xf0) | v; }
}

export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}
