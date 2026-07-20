import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../constants';
import { B } from '../blocks';
import { Simplex2, Simplex3, hash2 } from '../utils/noise';
import { Chunk, chunkIndex } from './chunk';

export type Biome = 'plains' | 'forest' | 'desert' | 'snow';

interface TreeInfo {
  trunkHeight: number;
  kind: 'oak' | 'cactus';
}

/**
 * Continuous climate sample for one column. The factors are 0..1 ramps over a
 * narrow band around each biome threshold; >= 0.5 means the column is inside
 * that biome, values strictly between 0 and 1 mark the transition band where
 * the surface is dithered between the two materials.
 */
interface Climate {
  temp: number;
  moist: number;
  snow: number;
  desert: number;
  forest: number;
}

const TREE_MARGIN = 3; // max canopy overhang, checked around chunk borders

// --- climate tuning ---
// Temperature and moisture are single-octave and VERY low frequency so biome
// regions span several hundred to a couple thousand blocks. Gentle domain
// warping makes borders meander organically instead of forming round blobs.
const TEMP_FREQ = 0.0006; // wavelength ~1650 blocks
const MOIST_FREQ = 0.00068; // wavelength ~1470 blocks
const WARP_FREQ = 0.0006;
const WARP_AMP = 120; // blocks of border meander

// Biome thresholds in climate space (factor 0.5 = biome border). BAND is the
// half-width of the transition ramp: 0.02 in climate units is roughly a
// 20-40 block dither band on the ground at these noise frequencies. The moist
// gap between desert (< 0.02) and forest (> 0.14) keeps a wide plains strip
// between them so deserts never touch forests directly.
const SNOW_TEMP = 0.34; // snow when temp < -0.34
const DESERT_TEMP = 0.3; // desert when temp > 0.30 ...
const DESERT_MOIST = 0.0; // ... and moist < 0
const FOREST_MOIST = 0.16; // forest when moist > 0.16
const BAND = 0.02;

/**
 * Mountain tops at/above this height get a snow surface block in any biome
 * (surface dressing only — not a biome flip). Regular hills top out at 89, so
 * only real mountains qualify and there are no isolated snow pinpricks.
 */
const SNOWCAP_Y = 90;

function ramp01(v: number, lo: number, hi: number): number {
  return v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo);
}

export class Terrain {
  readonly seed: number;
  private readonly continentNoise: Simplex2;
  private readonly hillNoise: Simplex2;
  private readonly detailNoise: Simplex2;
  private readonly mountainNoise: Simplex2;
  private readonly mountainMaskNoise: Simplex2;
  private readonly tempNoise: Simplex2;
  private readonly moistNoise: Simplex2;
  private readonly warpXNoise: Simplex2;
  private readonly warpZNoise: Simplex2;
  private readonly caveNoiseA: Simplex3;
  private readonly caveNoiseB: Simplex3;
  private readonly oreNoiseA: Simplex3;
  private readonly oreNoiseB: Simplex3;
  private readonly oreNoiseC: Simplex3;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.continentNoise = new Simplex2(this.seed ^ 0x1a2b);
    this.hillNoise = new Simplex2(this.seed ^ 0x3c4d);
    this.detailNoise = new Simplex2(this.seed ^ 0x5e6f);
    this.mountainNoise = new Simplex2(this.seed ^ 0x7a8b);
    this.mountainMaskNoise = new Simplex2(this.seed ^ 0x9c0d);
    this.tempNoise = new Simplex2(this.seed ^ 0xbead);
    this.moistNoise = new Simplex2(this.seed ^ 0xdead);
    this.warpXNoise = new Simplex2(this.seed ^ 0x6f77);
    this.warpZNoise = new Simplex2(this.seed ^ 0x8e99);
    this.caveNoiseA = new Simplex3(this.seed ^ 0x1111);
    this.caveNoiseB = new Simplex3(this.seed ^ 0x2222);
    this.oreNoiseA = new Simplex3(this.seed ^ 0x3333);
    this.oreNoiseB = new Simplex3(this.seed ^ 0x4444);
    this.oreNoiseC = new Simplex3(this.seed ^ 0x5555);
  }

  /** Low-frequency, domain-warped climate at a column. Pure and deterministic. */
  private climateAt(x: number, z: number): Climate {
    const wx = x + this.warpXNoise.noise(x * WARP_FREQ, z * WARP_FREQ) * WARP_AMP;
    const wz = z + this.warpZNoise.noise(x * WARP_FREQ, z * WARP_FREQ) * WARP_AMP;
    const temp = this.tempNoise.noise(wx * TEMP_FREQ, wz * TEMP_FREQ);
    const moist = this.moistNoise.noise(wx * MOIST_FREQ, wz * MOIST_FREQ);
    const snow = ramp01(-temp, SNOW_TEMP - BAND, SNOW_TEMP + BAND);
    const desert = Math.min(
      ramp01(temp, DESERT_TEMP - BAND, DESERT_TEMP + BAND),
      ramp01(-moist, -DESERT_MOIST - BAND, -DESERT_MOIST + BAND),
    );
    const forest = ramp01(moist, FOREST_MOIST - BAND, FOREST_MOIST + BAND);
    return { temp, moist, snow, desert, forest };
  }

  /** Discrete biome from climate factors only (height plays no part). */
  private biomeOf(c: Climate): Biome {
    if (c.snow >= 0.5) return 'snow';
    if (c.desert >= 0.5) return 'desert';
    if (c.forest >= 0.5) return 'forest';
    return 'plains';
  }

  /** Terrain surface height (top solid block y) at world column (x, z). Deterministic. */
  heightAt(x: number, z: number): number {
    return this.heightWithClimate(x, z, this.climateAt(x, z));
  }

  private heightWithClimate(x: number, z: number, c: Climate): number {
    const continent = this.continentNoise.fbm(x * 0.0016, z * 0.0016, 3); // large land masses
    const hills = this.hillNoise.fbm(x * 0.008, z * 0.008, 4);
    const detail = this.detailNoise.noise(x * 0.045, z * 0.045);

    // Climate shapes the rolling hills using the continuous factors, so the
    // relief changes gradually across biome borders (no cliffs at the seam):
    // deserts flatten out, plains stay gentle, forests roll the most.
    const hillAmp = 9 * (1 - 0.4 * c.desert) * (0.85 + 0.15 * c.forest);
    let h = SEA_LEVEL + 2 + continent * 14 + hills * hillAmp + detail * 2;

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
    return this.biomeOf(this.climateAt(x, z));
  }

  /**
   * Surface block for a column: snowcaps on high mountains, otherwise the
   * climate factors dithered by hash so desert->grass and snow->grass edges
   * fade over the transition band instead of forming a hard line.
   */
  private surfaceFor(x: number, z: number, c: Climate, h: number): number {
    if (h >= SNOWCAP_Y) return B.Snow;
    const r = hash2(x, z, this.seed ^ 0xd17e);
    if (c.snow > r) return B.Snow;
    if (c.desert > r) return B.Sand;
    return B.Grass;
  }

  /** Deterministic tree/cactus placement so canopies can cross chunk borders. */
  treeAt(x: number, z: number): TreeInfo | null {
    const r = hash2(x, z, this.seed ^ 0x51ee);
    if (r >= 0.025) return null; // cheap early-out before any noise

    const c = this.climateAt(x, z);
    const h = this.heightWithClimate(x, z, c);
    if (h <= SEA_LEVEL) return null;

    if (this.biomeOf(c) === 'desert') {
      // Cacti only deep inside the desert (never on the dithered grass of the
      // transition band) and never on snowcapped peaks.
      if (c.desert < 1 || h >= SNOWCAP_Y || r >= 0.005) return null;
      return { kind: 'cactus', trunkHeight: 1 + Math.floor(hash2(x, z, this.seed ^ 0x77aa) * 3) };
    }

    // Oak density follows the continuous moisture: dense in deep forest,
    // sparse at the forest edge, rare lone oaks on plains; snow stays sparse.
    const oakChance = 0.003 + 0.021 * ramp01(c.moist, FOREST_MOIST - BAND, 0.45);
    const chance = oakChance + (0.005 - oakChance) * c.snow;
    if (r >= chance) return null;
    // Keep trees off the sandy patches inside a desert transition band.
    if (this.surfaceFor(x, z, c, h) === B.Sand) return null;
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
        // Climate is computed once per column and shared by height + surface.
        const climate = this.climateAt(wx, wz);
        const h = this.heightWithClimate(wx, wz, climate);
        const surface = this.surfaceFor(wx, wz, climate, h);
        const colBase = chunkIndex(lx, 0, lz);

        const bedrockDepth = hash2(wx, wz, this.seed ^ 0xbed) < 0.4 ? 2 : 1;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y < bedrockDepth) {
            id = B.Bedrock;
          } else if (y > h - 4 && h <= SEA_LEVEL + 1) {
            // sea floor / beaches, with occasional clay pods just under the water
            if (h <= SEA_LEVEL && y >= h - 2 && hash2(wx >> 2, wz >> 2, this.seed ^ 0xc1ae) < 0.07) {
              id = B.Clay;
            } else {
              id = hash2(wx ^ y, wz, this.seed ^ 0xf10) < 0.35 ? B.Gravel : B.Sand;
            }
          } else if (y === h) {
            id = surface;
          } else if (y > h - 4) {
            // Subsurface follows the dithered surface choice.
            id = surface === B.Sand ? (y > h - 3 ? B.Sand : B.Sandstone) : B.Dirt;
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
    const c = this.oreNoiseC.noise(x * 0.16, y * 0.16, z * 0.16);
    if (c > 0.78 && y < 32) return B.LapisOre;
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
        } else if (r < 0.0724) {
          // Very rare wild pumpkins and melons
          chunk.setBlock(lx, h + 1, lz, B.Pumpkin);
        } else if (r < 0.0728) {
          chunk.setBlock(lx, h + 1, lz, B.Melon);
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
