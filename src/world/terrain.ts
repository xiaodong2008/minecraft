import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../constants';
import { B } from '../blocks';
import { Simplex2, Simplex3, hash2 } from '../utils/noise';
import { Chunk, chunkIndex } from './chunk';

export type Biome = 'plains' | 'forest' | 'desert' | 'snow';

interface TreeInfo {
  trunkHeight: number;
  kind: 'oak' | 'cactus';
}

const TREE_MARGIN = 3; // max canopy overhang, checked around chunk borders

export class Terrain {
  readonly seed: number;
  private readonly continentNoise: Simplex2;
  private readonly hillNoise: Simplex2;
  private readonly detailNoise: Simplex2;
  private readonly mountainNoise: Simplex2;
  private readonly mountainMaskNoise: Simplex2;
  private readonly tempNoise: Simplex2;
  private readonly moistNoise: Simplex2;
  private readonly caveNoiseA: Simplex3;
  private readonly caveNoiseB: Simplex3;
  private readonly oreNoiseA: Simplex3;
  private readonly oreNoiseB: Simplex3;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.continentNoise = new Simplex2(this.seed ^ 0x1a2b);
    this.hillNoise = new Simplex2(this.seed ^ 0x3c4d);
    this.detailNoise = new Simplex2(this.seed ^ 0x5e6f);
    this.mountainNoise = new Simplex2(this.seed ^ 0x7a8b);
    this.mountainMaskNoise = new Simplex2(this.seed ^ 0x9c0d);
    this.tempNoise = new Simplex2(this.seed ^ 0xbead);
    this.moistNoise = new Simplex2(this.seed ^ 0xdead);
    this.caveNoiseA = new Simplex3(this.seed ^ 0x1111);
    this.caveNoiseB = new Simplex3(this.seed ^ 0x2222);
    this.oreNoiseA = new Simplex3(this.seed ^ 0x3333);
    this.oreNoiseB = new Simplex3(this.seed ^ 0x4444);
  }

  /** Terrain surface height (top solid block y) at world column (x, z). Deterministic. */
  heightAt(x: number, z: number): number {
    const continent = this.continentNoise.fbm(x * 0.0016, z * 0.0016, 3); // large land masses
    const hills = this.hillNoise.fbm(x * 0.008, z * 0.008, 4);
    const detail = this.detailNoise.noise(x * 0.045, z * 0.045);

    let h = SEA_LEVEL + 2 + continent * 14 + hills * 9 + detail * 2;

    // Ridged mountains, only inside a mask so plains stay flat.
    const mask = this.mountainMaskNoise.noise(x * 0.0011, z * 0.0011);
    if (mask > 0.18) {
      const m = 1 - Math.abs(this.mountainNoise.fbm(x * 0.006, z * 0.006, 3));
      const strength = Math.min(1, (mask - 0.18) / 0.5);
      h += m * m * 44 * strength;
    }
    return Math.max(2, Math.min(WORLD_HEIGHT - 6, Math.round(h)));
  }

  biomeAt(x: number, z: number): Biome {
    const temp = this.tempNoise.fbm(x * 0.0021, z * 0.0021, 2);
    const moist = this.moistNoise.fbm(x * 0.0025, z * 0.0025, 2);
    const h = this.heightAt(x, z);
    if (h > 86 || temp < -0.42) return 'snow';
    if (temp > 0.34 && moist < 0.12 && h < 80) return 'desert';
    if (moist > 0.05) return 'forest';
    return 'plains';
  }

  /** Deterministic tree/cactus placement so canopies can cross chunk borders. */
  treeAt(x: number, z: number): TreeInfo | null {
    const r = hash2(x, z, this.seed ^ 0x51ee);
    if (r >= 0.022) return null; // cheap early-out before biome noise

    const h = this.heightAt(x, z);
    if (h <= SEA_LEVEL) return null;
    const biome = this.biomeAt(x, z);

    const chance = biome === 'forest' ? 0.02 : biome === 'plains' ? 0.003 : biome === 'snow' ? 0.006 : 0.004;
    if (r >= chance) return null;

    if (biome === 'desert') {
      return { kind: 'cactus', trunkHeight: 1 + Math.floor(hash2(x, z, this.seed ^ 0x77aa) * 3) };
    }
    return { kind: 'oak', trunkHeight: 4 + Math.floor(hash2(x, z, this.seed ^ 0x77aa) * 3) };
  }

  /** Fill a chunk's block array with generated terrain. */
  generate(chunk: Chunk): void {
    const { cx, cz } = chunk;
    const blocks = chunk.blocks;
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz);
        const colBase = chunkIndex(lx, 0, lz);

        const bedrockDepth = hash2(wx, wz, this.seed ^ 0xbed) < 0.4 ? 2 : 1;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y < bedrockDepth) {
            id = B.Bedrock;
          } else if (y > h - 4 && h <= SEA_LEVEL + 1) {
            // sea floor / beaches
            id = hash2(wx ^ y, wz, this.seed ^ 0xf10) < 0.35 ? B.Gravel : B.Sand;
          } else if (y === h) {
            id = biome === 'desert' ? B.Sand : biome === 'snow' ? B.Snow : B.Grass;
          } else if (y > h - 4) {
            id = biome === 'desert' ? (y > h - 3 ? B.Sand : B.Sandstone) : B.Dirt;
          } else {
            id = B.Stone;
          }

          // Carve caves through stone/dirt (keep bedrock and shorelines intact).
          // Deep cavities below y=11 flood with lava.
          if (id !== B.Bedrock && y > bedrockDepth) {
            const nearSeaSurface = h <= SEA_LEVEL + 1 && y > h - 4;
            if (!nearSeaSurface && this.isCave(wx, y, wz)) {
              blocks[colBase + y] = y <= 11 ? B.Lava : B.Air;
              continue;
            }
          }

          // Ores replace stone.
          if (id === B.Stone) {
            id = this.oreAt(wx, y, wz) ?? id;
          }
          blocks[colBase + y] = id;
        }

        // Water above terrain up to sea level.
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          blocks[colBase + y] = B.Water;
        }
      }
    }

    this.placePlants(chunk);
    this.placeTrees(chunk);
    chunk.generated = true;
  }

  private isCave(x: number, y: number, z: number): boolean {
    if (y < 4) return false;
    // Spaghetti tunnels: intersection of two noise bands.
    const a = this.caveNoiseA.noise(x * 0.015, y * 0.028, z * 0.015);
    const b = this.caveNoiseB.noise(x * 0.015, y * 0.028, z * 0.015);
    if (Math.abs(a) < 0.075 && Math.abs(b) < 0.075) return true;
    // Cheese caverns deep down.
    if (y < 42) {
      const c = this.caveNoiseA.noise(x * 0.024, y * 0.045, z * 0.024);
      if (c > 0.66) return true;
    }
    return false;
  }

  private oreAt(x: number, y: number, z: number): number | null {
    const a = this.oreNoiseA.noise(x * 0.13, y * 0.13, z * 0.13);
    if (a > 0.72 && y < 100) return B.CoalOre;
    if (a < -0.74 && y < 56) return B.IronOre;
    const b = this.oreNoiseB.noise(x * 0.16, y * 0.16, z * 0.16);
    if (b > 0.8 && y < 30) return B.GoldOre;
    if (b < -0.81 && y < 18) return B.DiamondOre;
    return null;
  }

  private placePlants(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const h = this.heightAt(wx, wz);
        if (h + 1 >= WORLD_HEIGHT) continue;

        // Sugar cane: on grass/sand exactly at sea level with adjacent water.
        if (h === SEA_LEVEL && hash2(wx, wz, this.seed ^ 0xca9e) < 0.12) {
          const top = chunk.getBlock(lx, h, lz);
          if ((top === B.Grass || top === B.Sand) &&
              (this.heightAt(wx + 1, wz) < SEA_LEVEL || this.heightAt(wx - 1, wz) < SEA_LEVEL ||
               this.heightAt(wx, wz + 1) < SEA_LEVEL || this.heightAt(wx, wz - 1) < SEA_LEVEL)) {
            const caneH = 1 + Math.floor(hash2(wx, wz, this.seed ^ 0x5eed) * 3);
            for (let k = 1; k <= caneH && h + k < WORLD_HEIGHT; k++) {
              if (chunk.getBlock(lx, h + k, lz) !== B.Air) break;
              chunk.setBlock(lx, h + k, lz, B.SugarCane);
            }
            continue;
          }
        }

        if (chunk.getBlock(lx, h, lz) !== B.Grass) continue;
        if (chunk.getBlock(lx, h + 1, lz) !== B.Air) continue;
        if (this.treeAt(wx, wz)) continue;
        const r = hash2(wx, wz, this.seed ^ 0x9e3d);
        if (r < 0.06) {
          chunk.setBlock(lx, h + 1, lz, B.TallGrass);
        } else if (r < 0.072) {
          chunk.setBlock(lx, h + 1, lz, hash2(wx, wz, this.seed ^ 0x1357) < 0.5 ? B.Dandelion : B.Poppy);
        }
      }
    }
  }

  private placeTrees(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;

    const setIfInside = (wx: number, y: number, wz: number, id: number, replaceSolid = false) => {
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
      const existing = chunk.getBlock(lx, y, lz);
      if (!replaceSolid && existing !== B.Air && existing !== B.Leaves && existing !== B.TallGrass) return;
      chunk.setBlock(lx, y, lz, id);
    };

    for (let tx = -TREE_MARGIN; tx < CHUNK_SIZE + TREE_MARGIN; tx++) {
      for (let tz = -TREE_MARGIN; tz < CHUNK_SIZE + TREE_MARGIN; tz++) {
        const wx = baseX + tx;
        const wz = baseZ + tz;
        const tree = this.treeAt(wx, wz);
        if (!tree) continue;
        const ground = this.heightAt(wx, wz);

        if (tree.kind === 'cactus') {
          for (let k = 1; k <= tree.trunkHeight; k++) {
            setIfInside(wx, ground + k, wz, B.Cactus, true);
          }
          continue;
        }

        const th = tree.trunkHeight;
        // Leaves: two wide layers, one narrow layer, plus a cross on top.
        for (let ly = th - 2; ly <= th + 1; ly++) {
          const r = ly <= th - 1 ? 2 : ly === th ? 1 : 1;
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (dx === 0 && dz === 0 && ly <= th) continue; // trunk
              // trim corners for a rounder canopy; top layer is a plus-shape
              if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && hash2(wx + dx, wz + dz, this.seed ^ ly) < 0.8) continue;
              if (ly === th + 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
              setIfInside(wx + dx, ground + ly, wz + dz, B.Leaves);
            }
          }
        }
        for (let k = 1; k <= th; k++) {
          setIfInside(wx, ground + k, wz, B.OakLog, true);
        }
      }
    }
  }
}
