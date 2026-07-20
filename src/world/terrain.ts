import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../constants';
import { B } from '../blocks';
import { Simplex2, Simplex3, hash2 } from '../utils/noise';
import { Chunk, chunkIndex } from './chunk';
import { Structures } from './structures';

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

/** Per-column ravine descriptor (null when the column has no ravine). */
interface RavineCol {
  ridge: number;
  y0: number;
  y1: number;
}

const TREE_MARGIN = 3; // max canopy overhang, checked around chunk borders

// --- climate tuning ---
// Temperature and moisture are single-octave and VERY low frequency, so one
// biome stretches for thousands of blocks before the climate drifts across a
// threshold. Borders are made fractal (coastline-like) in two ways:
//  1. multi-scale domain warping — a continental warp, a medium meander and a
//     small ripple are summed, so the border wiggles at every zoom level;
//  2. a small high-frequency nudge added straight to the climate values, which
//     crinkles the threshold contours even where the base fields are flat.
const TEMP_FREQ = 0.00025; // wavelength ~4000 blocks
const MOIST_FREQ = 0.00028; // wavelength ~3600 blocks
const WARP_L_FREQ = 0.0004;
const WARP_L_AMP = 320; // continental meander (hundreds of blocks)
const WARP_M_FREQ = 0.002;
const WARP_M_AMP = 55; // medium wiggle
const WARP_S_FREQ = 0.012;
const WARP_S_AMP = 9; // local ripple
const EDGE_FREQ = 0.01;
const EDGE_AMP = 0.022; // climate-space crinkle at the thresholds

// Biome thresholds in climate space (factor 0.5 = biome border). BAND is the
// half-width of the transition ramp; at these frequencies 0.012 climate units
// come out as roughly a 15-40 block dither band on the ground. The moist gap
// between desert (< 0.04) and forest (> 0.14) keeps a plains strip between
// them so deserts never touch forests directly.
const SNOW_TEMP = 0.3; // snow when temp < -0.30
const DESERT_TEMP = 0.26; // desert when temp > 0.26 ...
const DESERT_MOIST = 0.04; // ... and moist < 0.04
const FOREST_MOIST = 0.14; // forest when moist > 0.14
const BAND = 0.01;

// --- cave tuning ---
// Spaghetti tunnels: intersection of two 3D noise bands, stretched so they run
// mostly horizontal. The band half-width breathes with a slow thickness noise
// between W_BASE - W_VAR (pinched shut) and W_BASE + W_VAR (rooms ~4 radius).
const CAVE_XZ_FREQ = 0.014;
const CAVE_Y_FREQ = 0.035;
const CAVE_W_BASE = 0.06;
const CAVE_W_VAR = 0.05;
const CAVE_THICK_FREQ = 0.005; // horizontal; vertical runs at 2x
// Cheese caverns: threshold tightens toward CHEESE_MAX_Y so caverns fade out
// on the way up and get big and frequent deep down.
const CHEESE_XZ_FREQ = 0.013;
const CHEESE_Y_FREQ = 0.03;
const CHEESE_MAX_Y = 50;
// Ravines: rare long slashes along the zero contours of a low-frequency 2D
// ridged noise, gated by an even lower-frequency mask so only occasional
// stretches of a contour become an actual ravine.
const RAVINE_LINE_FREQ = 0.003;
const RAVINE_TH = 0.9855;
const RAVINE_WALL_AMP = 0.0065; // rough walls: 3D noise wobbles the threshold
const RAVINE_MASK_FREQ = 0.0018;
const RAVINE_MASK_TH = 0.55;

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
  private readonly climateEdgeNoise: Simplex2;
  private readonly ravineLineNoise: Simplex2;
  private readonly ravineMaskNoise: Simplex2;
  private readonly caveNoiseA: Simplex3;
  private readonly caveNoiseB: Simplex3;
  private readonly caveThickNoise: Simplex3;
  private readonly cheeseNoise: Simplex3;
  private readonly ravineWallNoise: Simplex3;
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
    this.climateEdgeNoise = new Simplex2(this.seed ^ 0x7717);
    this.ravineLineNoise = new Simplex2(this.seed ^ 0x8f21);
    this.ravineMaskNoise = new Simplex2(this.seed ^ 0x94a3);
    this.caveNoiseA = new Simplex3(this.seed ^ 0x1111);
    this.caveNoiseB = new Simplex3(this.seed ^ 0x2222);
    this.caveThickNoise = new Simplex3(this.seed ^ 0x6ee6);
    this.cheeseNoise = new Simplex3(this.seed ^ 0x7cc7);
    this.ravineWallNoise = new Simplex3(this.seed ^ 0x8dd8);
    this.oreNoiseA = new Simplex3(this.seed ^ 0x3333);
    this.oreNoiseB = new Simplex3(this.seed ^ 0x4444);
    this.oreNoiseC = new Simplex3(this.seed ^ 0x5555);
    this.structures = new Structures(this.seed, this);
  }

  /** Village/structure generator (see structures.ts). */
  readonly structures: Structures;

  /** Low-frequency, domain-warped climate at a column. Pure and deterministic. */
  private climateAt(x: number, z: number): Climate {
    // Three warp octaves summed (offsets decorrelate the octaves): the border
    // meanders over hundreds of blocks yet still wiggles block-to-block.
    const wx = x +
      this.warpXNoise.noise(x * WARP_L_FREQ, z * WARP_L_FREQ) * WARP_L_AMP +
      this.warpXNoise.noise(x * WARP_M_FREQ + 137.1, z * WARP_M_FREQ - 61.7) * WARP_M_AMP +
      this.warpXNoise.noise(x * WARP_S_FREQ - 293.3, z * WARP_S_FREQ + 211.9) * WARP_S_AMP;
    const wz = z +
      this.warpZNoise.noise(x * WARP_L_FREQ, z * WARP_L_FREQ) * WARP_L_AMP +
      this.warpZNoise.noise(x * WARP_M_FREQ - 87.3, z * WARP_M_FREQ + 43.9) * WARP_M_AMP +
      this.warpZNoise.noise(x * WARP_S_FREQ + 179.7, z * WARP_S_FREQ - 331.1) * WARP_S_AMP;
    const temp = this.tempNoise.noise(wx * TEMP_FREQ, wz * TEMP_FREQ) +
      this.climateEdgeNoise.noise(x * EDGE_FREQ, z * EDGE_FREQ) * EDGE_AMP;
    const moist = this.moistNoise.noise(wx * MOIST_FREQ, wz * MOIST_FREQ) +
      this.climateEdgeNoise.noise(x * EDGE_FREQ + 517.3, z * EDGE_FREQ - 417.7) * EDGE_AMP;
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
        const ravine = this.ravineAt(wx, wz, h);

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

          // Carve caves and ravines through stone/dirt (keep bedrock and
          // shorelines intact). Deep cavities below y=11 flood with lava.
          if (id !== B.Bedrock && y > bedrockDepth) {
            const nearSeaSurface = h <= SEA_LEVEL + 1 && y > h - 4;
            if (!nearSeaSurface &&
                ((ravine !== null && this.inRavine(wx, y, wz, ravine)) || this.isCave(wx, y, wz))) {
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
    this.structures.generate(chunk);
    chunk.generated = true;
  }

  private isCave(x: number, y: number, z: number): boolean {
    if (y < 4) return false;
    // Spaghetti tunnels: intersection of two noise bands. The shared width w
    // breathes with a slow thickness noise, so a tunnel swells into a room,
    // narrows to a crawlspace and pinches shut instead of staying uniform.
    const a = this.caveNoiseA.noise(x * CAVE_XZ_FREQ, y * CAVE_Y_FREQ, z * CAVE_XZ_FREQ);
    const aa = Math.abs(a);
    if (aa < CAVE_W_BASE + CAVE_W_VAR) { // early-out before two more evals
      const t = this.caveThickNoise.noise(x * CAVE_THICK_FREQ, y * CAVE_THICK_FREQ * 2, z * CAVE_THICK_FREQ);
      const w = CAVE_W_BASE + CAVE_W_VAR * t;
      if (aa < w) {
        const b = this.caveNoiseB.noise(x * CAVE_XZ_FREQ, y * CAVE_Y_FREQ, z * CAVE_XZ_FREQ);
        if (Math.abs(b) < w) return true;
      }
    }
    // Cheese caverns: threshold relaxes with depth — none above y=50, huge
    // lava-floored halls near the bottom of the world.
    if (y < CHEESE_MAX_Y) {
      const c = this.cheeseNoise.noise(x * CHEESE_XZ_FREQ, y * CHEESE_Y_FREQ, z * CHEESE_XZ_FREQ);
      if (c > 0.6 + 0.32 * (y / CHEESE_MAX_Y)) return true;
    }
    return false;
  }

  /**
   * Ravine test for a whole column: a rare long slash whose floor sits around
   * y~20 and whose top stops 3-6 blocks below the surface. Sea/shore columns
   * never host ravines so the ocean cannot drain into them.
   */
  private ravineAt(x: number, z: number, h: number): RavineCol | null {
    if (h <= SEA_LEVEL + 1) return null;
    const m = this.ravineMaskNoise.noise(x * RAVINE_MASK_FREQ, z * RAVINE_MASK_FREQ);
    if (m <= RAVINE_MASK_TH) return null;
    const ridge = 1 - Math.abs(this.ravineLineNoise.noise(x * RAVINE_LINE_FREQ, z * RAVINE_LINE_FREQ));
    if (ridge <= RAVINE_TH - RAVINE_WALL_AMP) return null;
    // Depth/roof vary smoothly with the mask strength, not per-column hash.
    const mm = Math.min(1, (m - RAVINE_MASK_TH) / 0.35);
    const y0 = 24 - Math.round(mm * 6); // floor y ~18..24
    const y1 = h - 6 + Math.round(mm * 3); // roof 3..6 below the surface
    return y1 > y0 ? { ridge, y0, y1 } : null;
  }

  /** Per-block ravine carve test: rough walls and a narrowing V floor. */
  private inRavine(x: number, y: number, z: number, r: RavineCol): boolean {
    if (y < r.y0 || y > r.y1) return false;
    const wall = this.ravineWallNoise.noise(x * 0.06, y * 0.1, z * 0.06);
    const taper = Math.max(0, r.y0 + 5 - y) * 0.0022;
    return r.ridge + wall * RAVINE_WALL_AMP > RAVINE_TH + taper;
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
    if (c < -0.7 && y < 16) return B.RedstoneOre;
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
        if (this.structures.clearsColumn(wx, wz)) continue;

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
        if (this.structures.clearsColumn(wx, wz)) continue;
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
