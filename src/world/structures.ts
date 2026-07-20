// Deterministic multi-chunk structure generation (villages). Structures are
// pure functions of (seed, coordinates): every chunk asks which structures
// intersect it and emits only the blocks inside its own bounds, so generation
// order never matters.

import type { Chunk } from './chunk';
import type { Terrain } from './terrain';

export class Structures {
  private readonly seed: number;
  private readonly terrain: Terrain;

  constructor(seed: number, terrain: Terrain) {
    this.seed = seed >>> 0;
    this.terrain = terrain;
    void this.seed;
    void this.terrain;
  }

  /** Emit all structure blocks that fall inside this chunk. */
  generate(chunk: Chunk): void {
    void chunk;
  }

  /**
   * True when natural features (trees, plants, cacti) must not spawn in this
   * column because a structure claims it.
   */
  clearsColumn(wx: number, wz: number): boolean {
    void wx;
    void wz;
    return false;
  }
}
