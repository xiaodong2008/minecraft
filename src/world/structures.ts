// Deterministic multi-chunk structure generation (villages). Structures are
// pure functions of (seed, coordinates): every chunk asks which structures
// intersect it and emits only the blocks inside its own bounds, so generation
// order never matters.
//
// Placement: the world is tiled into 48x48-chunk regions. A region hash picks
// candidate regions and a jittered village center; the site is then validated
// with pure terrain queries (biome + flat, dry ground). A valid site builds
// the whole village layout ONCE into per-column cell maps, memoized per
// region, so generate() and clearsColumn() are plain lookups afterwards.
// EDGE_MARGIN keeps every village strictly inside its own region, so a column
// only ever needs to consult the region it belongs to.

import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../constants';
import { B } from '../blocks';
import { hash2 } from '../utils/noise';
import { chunkIndex, type Chunk } from './chunk';
import type { Terrain, Biome } from './terrain';

// --- region / site tuning ---
const REGION_CHUNKS = 48;
const REGION_BLOCKS = REGION_CHUNKS * CHUNK_SIZE; // 768
const VILLAGE_CHANCE = 0.35;
/**
 * Minimum distance from a village center to its region border. Must exceed
 * the maximum village half-extent (~46 blocks: path arm 45, buildings end at
 * arm length - 6 plus footprint + border) so layouts never cross region lines.
 */
const EDGE_MARGIN = 100;
const MAX_SPREAD = 7; // max surface height difference across the site probes
const MIN_GROUND = SEA_LEVEL + 2; // every probe must be dry land

/** Center + 8 ring points (radius ~25) that must be flat, dry ground. */
const SITE_PROBES: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [25, 0], [-25, 0], [0, 25], [0, -25],
  [18, 18], [18, -18], [-18, 18], [-18, -18],
];

// --- layout tuning (blocks; every loop below is bounded by these) ---
const PATH_MIN = 20;
const PATH_RANGE = 26; // arm length 20..45
const TORCH_START = 8; // first torch distance, then every 8..10
const PLOT_FIRST = 12; // first plot 12..14 blocks out from the well
const MAX_FILL = 8; // deepest foundation fill under a floor

// --- hash salts (independent decision streams) ---
const S_EXIST = 0x1f123bb5;
const S_CX = 0x2545f491;
const S_CZ = 0x3c6ef35f;
const S_ARM = 0x47502932; // + arm index
const S_TORCH_SIDE = 0x51ed270b; // + arm index
const S_TORCH_STEP = 0x69e2a2de; // + arm index
const S_PLOTS = 0x7afc9d1d;
const S_SIDE = 0x8f14ab42; // + arm index
const S_D0 = 0x9e3779b9; // + arm index
const S_STEP = 0xa9e0bb11; // + arm index
const S_OFF = 0xb5297a4d;
const S_KIND = 0xc2b2ae3d;
const S_STATION = 0xd6e8feb8;
const S_CHEST = 0xe7037ed1;
const S_CROP_KIND = 0xf1bbcdcb;
const S_CROP_STAGE = 0x94d049bb;

// Rotations 0/90/180/270: local +u / +v axes in world space. Templates are
// authored with the door on the v=0 edge looking toward -v, so the rotation
// alone decides which way a building faces.
const ROT_U: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const ROT_V: ReadonlyArray<readonly [number, number]> = [[0, 1], [-1, 0], [0, -1], [1, 0]];
/** Facing meta (0 +z, 1 -x, 2 -z, 3 +x) pointing out of the door per rotation. */
const DOOR_META: ReadonlyArray<number> = [2, 3, 0, 1];

/** Public summary of one generated village (introspection for tools/tests). */
export interface VillageInfo {
  centerX: number;
  centerZ: number;
  biome: Biome;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** y -> (blockId | meta << 8) for one column. */
type ColumnCells = Map<number, number>;

interface Village extends VillageInfo {
  /** Column key ((dx+128)<<8 | (dz+128), center-relative) -> cells to write. */
  cols: Map<number, ColumnCells>;
  /** Columns where natural plants/trees must not spawn. */
  claimed: Set<number>;
}

/** Center-relative column key; |dx|,|dz| <= ~60 so the +128 bias never wraps. */
function colKey(dx: number, dz: number): number {
  return ((dx + 128) << 8) | (dz + 128);
}

export class Structures {
  private readonly seed: number;
  private readonly terrain: Terrain;
  /** Memoized per-region layout (null = region hosts no village). */
  private readonly regions = new Map<string, Village | null>();
  // clearsColumn hot-path cache: consecutive queries hit the same region.
  private lastRx = 0x7fffffff;
  private lastRz = 0x7fffffff;
  private lastVillage: Village | null = null;

  constructor(seed: number, terrain: Terrain) {
    this.seed = seed >>> 0;
    this.terrain = terrain;
  }

  /** Emit all structure blocks that fall inside this chunk. */
  generate(chunk: Chunk): void {
    const bx = chunk.cx * CHUNK_SIZE;
    const bz = chunk.cz * CHUNK_SIZE;
    const rcx = Math.floor(chunk.cx / REGION_CHUNKS);
    const rcz = Math.floor(chunk.cz / REGION_CHUNKS);
    // Villages never leave their own region (EDGE_MARGIN >> max radius); the
    // 3x3 scan is belt-and-braces and costs only memo lookups.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const v = this.villageForRegion(rcx + dc, rcz + dr);
        if (!v) continue;
        if (v.maxX < bx || v.minX > bx + CHUNK_SIZE - 1 ||
            v.maxZ < bz || v.minZ > bz + CHUNK_SIZE - 1) continue;
        this.emit(v, chunk, bx, bz);
      }
    }
  }

  /**
   * True when natural features (trees, plants, cacti) must not spawn in this
   * column because a structure claims it.
   */
  clearsColumn(wx: number, wz: number): boolean {
    const rx = Math.floor(wx / REGION_BLOCKS);
    const rz = Math.floor(wz / REGION_BLOCKS);
    let v: Village | null;
    if (rx === this.lastRx && rz === this.lastRz) {
      v = this.lastVillage;
    } else {
      v = this.villageForRegion(rx, rz);
      this.lastRx = rx;
      this.lastRz = rz;
      this.lastVillage = v;
    }
    if (!v) return false;
    if (wx < v.minX || wx > v.maxX || wz < v.minZ || wz > v.maxZ) return false;
    return v.claimed.has(colKey(wx - v.centerX, wz - v.centerZ));
  }

  /** The village hosted by a region, if any (introspection for tools/tests). */
  villageInRegion(rx: number, rz: number): VillageInfo | null {
    return this.villageForRegion(rx, rz);
  }

  // ---------------- placement ----------------

  private villageForRegion(rx: number, rz: number): Village | null {
    const key = rx + ',' + rz;
    const hit = this.regions.get(key);
    if (hit !== undefined) return hit;
    const v = this.computeVillage(rx, rz);
    this.regions.set(key, v);
    return v;
  }

  /** Pure function of (seed, region): candidate hash, site checks, layout. */
  private computeVillage(rx: number, rz: number): Village | null {
    if (hash2(rx, rz, this.seed ^ S_EXIST) >= VILLAGE_CHANCE) return null;
    const span = REGION_BLOCKS - 2 * EDGE_MARGIN;
    const cx = rx * REGION_BLOCKS + EDGE_MARGIN + Math.floor(hash2(rx, rz, this.seed ^ S_CX) * span);
    const cz = rz * REGION_BLOCKS + EDGE_MARGIN + Math.floor(hash2(rx, rz, this.seed ^ S_CZ) * span);
    const biome = this.terrain.biomeAt(cx, cz);
    if (biome !== 'plains' && biome !== 'desert') return null;
    let lo = WORLD_HEIGHT;
    let hi = 0;
    for (const [dx, dz] of SITE_PROBES) {
      const h = this.terrain.heightAt(cx + dx, cz + dz);
      if (h < MIN_GROUND) return null;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > MAX_SPREAD) return null;
    return this.buildVillage(cx, cz, biome);
  }

  // ---------------- layout build (once per village, memoized) ----------------

  private buildVillage(cx: number, cz: number, biome: Biome): Village {
    const t = this.terrain;
    const vil: Village = {
      centerX: cx, centerZ: cz, biome,
      minX: cx, maxX: cx, minZ: cz, maxZ: cz,
      cols: new Map(), claimed: new Set(),
    };
    const desert = biome === 'desert';
    const wallBlock = desert ? B.Sandstone : B.OakPlanks;
    const postBlock = desert ? B.Cobblestone : B.OakLog;
    const roofSlab = desert ? B.StoneSlab : B.OakSlab;
    const innerFloor = desert ? B.Sandstone : B.OakPlanks;

    const grow = (wx: number, wz: number): void => {
      if (wx < vil.minX) vil.minX = wx;
      if (wx > vil.maxX) vil.maxX = wx;
      if (wz < vil.minZ) vil.minZ = wz;
      if (wz > vil.maxZ) vil.maxZ = wz;
    };
    const put = (wx: number, y: number, wz: number, id: number, meta = 0): void => {
      if (y < 0 || y >= WORLD_HEIGHT) return;
      const k = colKey(wx - cx, wz - cz);
      let cells = vil.cols.get(k);
      if (!cells) {
        cells = new Map();
        vil.cols.set(k, cells);
      }
      cells.set(y, id | (meta << 8));
      grow(wx, wz);
    };
    const claim = (wx: number, wz: number): void => {
      vil.claimed.add(colKey(wx - cx, wz - cz));
      grow(wx, wz);
    };
    /** Fill foundation from `top` down to the terrain surface (capped). */
    const fillDown = (wx: number, wz: number, top: number, id: number): void => {
      const stop = Math.max(t.heightAt(wx, wz) + 1, top - (MAX_FILL - 1));
      for (let y = top; y >= stop; y--) put(wx, y, wz, id);
    };
    const rnd = (salt: number, x: number, z: number): number => hash2(x, z, this.seed ^ salt);

    // --- WELL at the center: 4x4 cobble ring, 2x2 water 2 deep, slab rim ---
    const wellY = t.heightAt(cx, cz);
    for (let dx = -2; dx <= 1; dx++) {
      for (let dz = -2; dz <= 1; dz++) {
        const wx = cx + dx;
        const wz = cz + dz;
        for (let y = wellY + 2; y <= wellY + 4; y++) put(wx, y, wz, B.Air);
        if (dx === -2 || dx === 1 || dz === -2 || dz === 1) {
          for (let y = wellY - 2; y <= wellY + 1; y++) put(wx, y, wz, B.Cobblestone);
        } else {
          put(wx, wellY - 2, wz, B.Cobblestone);
          put(wx, wellY - 1, wz, B.Water);
          put(wx, wellY, wz, B.Water);
        }
        fillDown(wx, wz, wellY - 3, B.Cobblestone);
      }
    }
    put(cx - 2, wellY + 2, cz - 2, B.CobbleSlab);
    put(cx + 1, wellY + 2, cz - 2, B.CobbleSlab);
    put(cx - 2, wellY + 2, cz + 1, B.CobbleSlab);
    put(cx + 1, wellY + 2, cz + 1, B.CobbleSlab);
    for (let dx = -3; dx <= 2; dx++) {
      for (let dz = -3; dz <= 2; dz++) claim(cx + dx, cz + dz);
    }

    // --- PATHS: 2-wide gravel arms through the well along both axes. The
    // first cells of each arm double as the well's four path stubs. ---
    const ARMS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const armLen: number[] = [];
    for (let a = 0; a < 4; a++) {
      armLen.push(PATH_MIN + Math.floor(rnd(S_ARM + a, cx, cz) * PATH_RANGE));
    }
    for (let a = 0; a < 4; a++) {
      const [ax, az] = ARMS[a];
      const len = armLen[a];
      // The well ring spans -2..+1 on both axes, so positive arms start at 2
      // and negative arms at 3 to meet the rim exactly.
      const start = ax + az > 0 ? 2 : 3;
      for (let d = start; d <= len; d++) {
        for (let s = -2; s <= 1; s++) {
          const wx = cx + ax * d + (ax === 0 ? s : 0);
          const wz = cz + az * d + (az === 0 ? s : 0);
          claim(wx, wz); // strip + 1 border each side
          if (s === -1 || s === 0) {
            const h = t.heightAt(wx, wz);
            if (h > SEA_LEVEL) put(wx, h, wz, B.Gravel);
          }
        }
      }
      // Ground torches beside the strip every ~8-10 blocks.
      let td = TORCH_START;
      while (td <= len) {
        const s = rnd(S_TORCH_SIDE + a, cx + td, cz - td) < 0.5 ? 1 : -2;
        const wx = cx + ax * td + (ax === 0 ? s : 0);
        const wz = cz + az * td + (az === 0 ? s : 0);
        const h = t.heightAt(wx, wz);
        if (h > SEA_LEVEL) {
          // Cobble base: guarantees support even when a cave mouth happens to
          // carve away the natural surface block underneath.
          put(wx, h, wz, B.Cobblestone);
          put(wx, h + 1, wz, B.Torch);
        }
        td += 8 + Math.floor(rnd(S_TORCH_STEP + a, cx + td, cz + td) * 3);
      }
    }

    // --- BUILDING PLOTS along the arms, alternating sides ---
    const rects: { x0: number; z0: number; x1: number; z1: number }[] = [
      // reserve the well plaza
      { x0: cx - 5, z0: cz - 5, x1: cx + 4, z1: cz + 4 },
    ];
    const target = 4 + Math.floor(rnd(S_PLOTS, cx, cz) * 5); // 4..8
    let placed = 0;
    for (let a = 0; a < 4 && placed < target; a++) {
      let side = rnd(S_SIDE + a, cx, cz) < 0.5 ? 1 : -1;
      let d = PLOT_FIRST + Math.floor(rnd(S_D0 + a, cx, cz) * 3); // 12..14
      while (d + 6 <= armLen[a] && placed < target) {
        if (this.tryPlot(vil, rects, a, d, side, put, claim, fillDown, rnd,
                         wallBlock, postBlock, roofSlab, innerFloor)) {
          placed++;
        }
        side = -side;
        d += 12 + Math.floor(rnd(S_STEP + a, cx + d, cz - d) * 7); // 12..18
      }
    }
    return vil;
  }

  /**
   * Try to place one building beside arm `a` at distance `d`, on `side` of
   * the path. Returns false (leaving no blocks) when the spot collides with
   * an earlier plot or the terrain dips into water.
   */
  private tryPlot(
    vil: Village,
    rects: { x0: number; z0: number; x1: number; z1: number }[],
    a: number,
    d: number,
    side: number,
    put: (wx: number, y: number, wz: number, id: number, meta?: number) => void,
    claim: (wx: number, wz: number) => void,
    fillDown: (wx: number, wz: number, top: number, id: number) => void,
    rnd: (salt: number, x: number, z: number) => number,
    wallBlock: number,
    postBlock: number,
    roofSlab: number,
    innerFloor: number,
  ): boolean {
    const t = this.terrain;
    const cx = vil.centerX;
    const cz = vil.centerZ;
    const [ax, az] = [[1, 0], [-1, 0], [0, 1], [0, -1]][a];
    const off = 6 + Math.floor(rnd(S_OFF, cx + a * 101 + d, cz + side * 37) * 5); // 6..10
    // Door column: on the path-facing edge of the footprint.
    const px = ax !== 0 ? cx + ax * d : cx + side * off;
    const pz = ax !== 0 ? cz + side * off : cz + az * d;
    // Rotation from the away-from-path direction (local +v).
    const rot = ax !== 0 ? (side > 0 ? 0 : 2) : (side > 0 ? 3 : 1);

    const roll = rnd(S_KIND, px, pz);
    let kind: 'small' | 'farm' | 'big' | 'lamp';
    let W: number;
    let D: number;
    if (roll < 0.35) { kind = 'small'; W = 5; D = 5; }
    else if (roll < 0.6) { kind = 'farm'; W = 7; D = 9; }
    else if (roll < 0.85) { kind = 'big'; W = 7; D = 9; }
    else { kind = 'lamp'; W = 1; D = 1; }

    const uDoor = W >> 1;
    const U = ROT_U[rot];
    const V = ROT_V[rot];
    const ox = px - uDoor * U[0];
    const oz = pz - uDoor * U[1];
    const map = (u: number, v: number): readonly [number, number] =>
      [ox + u * U[0] + v * V[0], oz + u * U[1] + v * V[1]];

    const [c0x, c0z] = map(0, 0);
    const [c1x, c1z] = map(W - 1, D - 1);
    const x0 = Math.min(c0x, c1x);
    const x1 = Math.max(c0x, c1x);
    const z0 = Math.min(c0z, c1z);
    const z1 = Math.max(c0z, c1z);
    // Reject plots that would collide with earlier plots (grown by 2: the two
    // 1-block borders plus a gap) — build order is fixed, so this stays pure.
    for (const r of rects) {
      if (x0 - 2 <= r.x1 && x1 + 2 >= r.x0 && z0 - 2 <= r.z1 && z1 + 2 >= r.z0) return false;
    }
    const hC = t.heightAt((x0 + x1) >> 1, (z0 + z1) >> 1);
    if (hC <= SEA_LEVEL) return false; // plot drifted onto a shore/pond
    const yF = hC + 1; // floor level
    if (yF + 7 >= WORLD_HEIGHT) return false;
    rects.push({ x0, z0, x1, z1 });

    // Claim footprint + 1 border, and carve air above the floor so hillsides
    // (and tree canopies leaning in) never smother the building.
    const clearTop = kind === 'small' || kind === 'big' ? yF + 6 : yF + 4;
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      for (let z = z0 - 1; z <= z1 + 1; z++) {
        claim(x, z);
        for (let y = yF + 1; y <= clearTop; y++) put(x, y, z, B.Air);
      }
    }
    // Foundation: fill below the floor where the terrain sits lower.
    const fillId = kind === 'farm' ? B.Dirt : B.Cobblestone;
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) fillDown(x, z, yF - 1, fillId);
    }

    const doorMeta = DOOR_META[rot];

    if (kind === 'lamp') {
      // Cobble pillar 2 high, torch on top.
      put(px, yF, pz, B.Cobblestone);
      put(px, yF + 1, pz, B.Cobblestone);
      put(px, yF + 2, pz, B.Torch);
      return true;
    }

    if (kind === 'farm') {
      // Log border, two wet-farmland strips around a central water channel.
      for (let u = 0; u < W; u++) {
        for (let v = 0; v < D; v++) {
          const [x, z] = map(u, v);
          if (u === 0 || u === W - 1 || v === 0 || v === D - 1) {
            put(x, yF, z, B.OakLog);
          } else if (u === 3) {
            put(x, yF, z, B.Water);
          } else {
            put(x, yF, z, B.FarmlandWet);
            const r = hash2(x, z, this.seed ^ S_CROP_KIND);
            const stage = hash2(x, z, this.seed ^ S_CROP_STAGE);
            const crop = r < 0.5 ? B.Wheat4 + Math.floor(stage * 4)
              : r < 0.75 ? B.Carrots2 + Math.floor(stage * 2)
              : B.Potatoes2 + Math.floor(stage * 2);
            put(x, yF + 1, z, crop);
          }
        }
      }
      return true;
    }

    // --- houses (small 5x5 / big 7x9) ---
    // Floor: cobblestone foundation ring, wood/sandstone inside.
    for (let u = 0; u < W; u++) {
      for (let v = 0; v < D; v++) {
        const [x, z] = map(u, v);
        const perim = u === 0 || u === W - 1 || v === 0 || v === D - 1;
        put(x, yF, z, perim ? B.Cobblestone : innerFloor);
      }
    }
    // Walls with log/cobble corner posts, doorway, glass windows.
    for (let u = 0; u < W; u++) {
      for (let v = 0; v < D; v++) {
        const perim = u === 0 || u === W - 1 || v === 0 || v === D - 1;
        if (!perim) continue;
        const corner = (u === 0 || u === W - 1) && (v === 0 || v === D - 1);
        const [x, z] = map(u, v);
        const hasWindow = kind === 'small'
          ? ((v === D - 1 && u === uDoor) || ((u === 0 || u === W - 1) && v === (D >> 1)))
          : (((u === 0 || u === W - 1) && (v === 2 || v === 7)) ||
             (v === D - 1 && (u === 2 || u === 4)) ||
             (v === 0 && (u === 1 || u === 5)));
        for (let y = yF + 1; y <= yF + 3; y++) {
          if (u === uDoor && v === 0 && y <= yF + 2) continue; // 1x2 doorway
          let id = corner ? postBlock : wallBlock;
          if (hasWindow && y === yF + 2 && !corner) id = B.Glass;
          put(x, y, z, id);
        }
      }
    }
    // Flat slab roof with a 1-block overhang.
    for (let u = -1; u <= W; u++) {
      for (let v = -1; v <= D; v++) {
        const [x, z] = map(u, v);
        put(x, yF + 4, z, roofSlab);
      }
    }
    // Interior.
    if (kind === 'small') {
      const [sx, sz] = map(1, 3);
      put(sx, yF + 1, sz, rnd(S_STATION, px, pz) < 0.5 ? B.CraftingTable : B.Furnace, doorMeta);
      if (rnd(S_CHEST, px, pz) < 0.45) {
        const [hx, hz] = map(3, 3);
        put(hx, yF + 1, hz, B.Chest, doorMeta);
      }
      const [tx, tz] = map(3, 1);
      put(tx, yF + 1, tz, B.Torch);
    } else {
      // Two rooms split by an interior wall with its own doorway.
      for (let u = 1; u <= W - 2; u++) {
        const [x, z] = map(u, 5);
        for (let y = yF + 1; y <= yF + 3; y++) {
          if (u === uDoor && y <= yF + 2) continue;
          put(x, y, z, wallBlock);
        }
      }
      const [bedX, bedZ] = map(1, 7);
      put(bedX, yF + 1, bedZ, B.Bed, doorMeta);
      const [bs1x, bs1z] = map(5, 7);
      put(bs1x, yF + 1, bs1z, B.Bookshelf);
      const [bs2x, bs2z] = map(5, 6);
      put(bs2x, yF + 1, bs2z, B.Bookshelf);
      if (rnd(S_CHEST, px, pz) < 0.7) {
        const [hx, hz] = map(1, 6);
        put(hx, yF + 1, hz, B.Chest, doorMeta);
      }
      const [ctx, ctz] = map(5, 1);
      put(ctx, yF + 1, ctz, B.CraftingTable, doorMeta);
      const [t1x, t1z] = map(1, 1);
      put(t1x, yF + 1, t1z, B.Torch);
      const [t2x, t2z] = map(3, 6);
      put(t2x, yF + 1, t2z, B.Torch);
    }
    return true;
  }

  // ---------------- chunk emission ----------------

  /** Copy the memoized layout cells that fall inside this chunk. */
  private emit(v: Village, chunk: Chunk, bx: number, bz: number): void {
    const x0 = Math.max(bx, v.minX);
    const x1 = Math.min(bx + CHUNK_SIZE - 1, v.maxX);
    const z0 = Math.max(bz, v.minZ);
    const z1 = Math.min(bz + CHUNK_SIZE - 1, v.maxZ);
    for (let wx = x0; wx <= x1; wx++) {
      for (let wz = z0; wz <= z1; wz++) {
        const cells = v.cols.get(colKey(wx - v.centerX, wz - v.centerZ));
        if (!cells) continue;
        const base = chunkIndex(wx - bx, 0, wz - bz);
        for (const [y, cell] of cells) {
          chunk.blocks[base + y] = cell & 0xff;
          chunk.meta[base + y] = (cell >>> 8) & 0xff;
        }
      }
    }
  }
}
