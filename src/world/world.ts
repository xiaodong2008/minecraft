import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../constants';
import { B, blockDef, isSolid, isTargetable, isOpaqueCube } from '../blocks';
import type { ItemStack } from '../items';
import { SMELTING, fuelTime, itemDef } from '../items';
import { Chunk, chunkIndex, chunkKey } from './chunk';
import { Terrain } from './terrain';
import { LightEngine, LightWorldAccess } from './lighting';
import { buildChunkMesh, GeometryData } from './mesher';

export interface WorldMaterials {
  opaque: THREE.Material;
  cutout: THREE.Material;
  water: THREE.Material;
}

export interface RaycastHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  id: number;
  dist: number;
}

export interface FurnaceState {
  kind: 'furnace';
  input: ItemStack | null;
  fuel: ItemStack | null;
  output: ItemStack | null;
  /** Seconds of burn remaining / total for the current fuel. */
  burn: number;
  burnTotal: number;
  /** Smelt progress in seconds (10s per item). */
  progress: number;
  /** XP banked in the output slot, granted on collect. */
  xp: number;
}

export interface ChestState {
  kind: 'chest';
  slots: (ItemStack | null)[];
}

export type BlockEntity = FurnaceState | ChestState;

export interface ExplosionResult {
  destroyed: { x: number; y: number; z: number; id: number }[];
}

export const SMELT_TIME = 10;

interface Offset { dx: number; dz: number }

function ringOffsets(radius: number): Offset[] {
  const out: Offset[] = [];
  const r2 = (radius + 0.5) * (radius + 0.5);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz <= r2) out.push({ dx, dz });
    }
  }
  out.sort((a, b) => (a.dx * a.dx + a.dz * a.dz) - (b.dx * b.dx + b.dz * b.dz));
  return out;
}

export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

// ---------------- redstone id classification (pure helpers) ----------------

const RS_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
] as const;

const RS_HORIZ = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

function isWireId(id: number): boolean {
  return id === B.RedstoneWire || id === B.RedstoneWireOn;
}

/** Signal a block id injects into adjacent wires/consumers (sources emit 15). */
function rsSourcePower(id: number): number {
  return id === B.RedstoneTorch || id === B.LeverOn || id === B.StoneButtonPressed ||
    id === B.PressurePlatePressed || id === B.RedstoneBlock ? 15 : 0;
}

/** Any block the redstone simulation reacts to (components + ignitable TNT). */
function isRedstoneId(id: number): boolean {
  return (id >= B.RedstoneWire && id <= B.RedstoneBlock) || id === B.TNT;
}

export class World implements LightWorldAccess {
  readonly seed: number;
  readonly terrain: Terrain;
  readonly lighting: LightEngine;
  private readonly scene: THREE.Scene;
  private readonly materials: WorldMaterials;

  private chunks = new Map<string, Chunk>();
  /** Player edits, survive chunk unloading: chunkKey -> (cellIndex -> id | meta<<8). */
  private edits = new Map<string, Map<number, number>>();
  editsDirty = false;

  /** Furnaces/chests with inventories, keyed by "x,y,z". */
  blockEntities = new Map<string, BlockEntity>();

  /** Set by the game: called when a random tick or furnace wants a sound/particle hook. */
  onFurnaceFinish: (() => void) | null = null;
  /** Redstone power reached a TNT block — the game turns it into a primed entity. */
  onTntIgnited: ((x: number, y: number, z: number) => void) | null = null;
  /** Chunks freshly generated this session (for passive mob seeding). */
  freshChunks: Chunk[] = [];

  private renderDistance: number;
  private genOffsets: Offset[] = [];
  private meshOffsets: Offset[] = [];
  private frame = 0;
  private rand = Math.random;
  private tickTimer = 0;

  constructor(scene: THREE.Scene, materials: WorldMaterials, seed: number, renderDistance: number) {
    this.scene = scene;
    this.materials = materials;
    this.seed = seed >>> 0;
    this.terrain = new Terrain(this.seed);
    this.lighting = new LightEngine(this);
    this.renderDistance = renderDistance;
    this.computeOffsets();
  }

  // ---------------- chunk access ----------------

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getGeneratedChunk(cx: number, cz: number): Chunk | null {
    const c = this.chunks.get(chunkKey(cx, cz));
    return c && c.generated ? c : null;
  }

  markMeshDirty(cx: number, cz: number): void {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c && c.generated) c.dirty = true;
  }

  chunkCount(): number {
    return this.chunks.size;
  }

  // ---------------- block access ----------------

  getBlockAt(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.Bedrock;
    if (wy >= WORLD_HEIGHT) return B.Air;
    const c = this.getGeneratedChunk(wx >> 4, wz >> 4);
    if (!c) return B.Air;
    return c.blocks[chunkIndex(wx & 15, wy, wz & 15)];
  }

  getMetaAt(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= WORLD_HEIGHT) return 0;
    const c = this.getGeneratedChunk(wx >> 4, wz >> 4);
    if (!c) return 0;
    return c.meta[chunkIndex(wx & 15, wy, wz & 15)];
  }

  isSolidAt(wx: number, wy: number, wz: number): boolean {
    return isSolid(this.getBlockAt(wx, wy, wz));
  }

  /** Collision height of the cell: 0 = not solid, else block height (1 for full cubes, 0.5625 for beds). */
  solidHeightAt(wx: number, wy: number, wz: number): number {
    const def = blockDef(this.getBlockAt(wx, wy, wz));
    return def.solid ? def.height : 0;
  }

  getSkyAt(wx: number, wy: number, wz: number): number {
    if (wy >= WORLD_HEIGHT) return 15;
    if (wy < 0) return 0;
    const c = this.getGeneratedChunk(wx >> 4, wz >> 4);
    return c ? c.light[chunkIndex(wx & 15, wy, wz & 15)] >> 4 : 15;
  }

  getBlockLightAt(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= WORLD_HEIGHT) return 0;
    const c = this.getGeneratedChunk(wx >> 4, wz >> 4);
    return c ? c.light[chunkIndex(wx & 15, wy, wz & 15)] & 0xf : 0;
  }

  /** Combined light 0..15 given the current sun factor (for mob spawning / growth). */
  lightAt(wx: number, wy: number, wz: number, sunFactor: number): number {
    return Math.max(this.getSkyAt(wx, wy, wz) * sunFactor, this.getBlockLightAt(wx, wy, wz));
  }

  /**
   * Sets a block, updates lighting, marks meshes dirty and cascades
   * support-requiring blocks (torches/plants) above removed blocks.
   */
  setBlockAt(wx: number, wy: number, wz: number, id: number, meta = 0, record = true): boolean {
    if (wy < 0 || wy >= WORLD_HEIGHT) return false;
    const c = this.getGeneratedChunk(wx >> 4, wz >> 4);
    if (!c) return false;
    const lx = wx & 15;
    const lz = wz & 15;
    const i = chunkIndex(lx, wy, lz);
    const old = c.blocks[i];
    if (old === id && c.meta[i] === meta) return false;
    c.blocks[i] = id;
    c.meta[i] = meta;

    if (record) {
      const key = chunkKey(c.cx, c.cz);
      let map = this.edits.get(key);
      if (!map) {
        map = new Map();
        this.edits.set(key, map);
      }
      map.set(i, id | (meta << 8));
      this.editsDirty = true;
    }

    // A destroyed container spills nothing here — interaction handles drops
    // before calling setBlockAt. Just drop the stale block entity.
    if (old !== id) {
      const bk = posKey(wx, wy, wz);
      if (this.blockEntities.has(bk) && id !== B.Furnace && id !== B.FurnaceLit) {
        const wasFurnaceSwap =
          (old === B.Furnace || old === B.FurnaceLit) && (id === B.Furnace || id === B.FurnaceLit);
        if (!wasFurnaceSwap) this.blockEntities.delete(bk);
      }
    }

    // Redstone: queue the change for the next simulation tick (unless the
    // engine itself is applying its batched swaps).
    if (!this.rsApplying && old !== id) {
      this.rsOnBlockChanged(wx, wy, wz, old, id);
    }

    this.lighting.onBlockChanged(wx, wy, wz, old, id);

    c.dirty = true;
    if (lx === 0) this.markMeshDirty(c.cx - 1, c.cz);
    if (lx === 15) this.markMeshDirty(c.cx + 1, c.cz);
    if (lz === 0) this.markMeshDirty(c.cx, c.cz - 1);
    if (lz === 15) this.markMeshDirty(c.cx, c.cz + 1);
    if (lx === 0 && lz === 0) this.markMeshDirty(c.cx - 1, c.cz - 1);
    if (lx === 0 && lz === 15) this.markMeshDirty(c.cx - 1, c.cz + 1);
    if (lx === 15 && lz === 0) this.markMeshDirty(c.cx + 1, c.cz - 1);
    if (lx === 15 && lz === 15) this.markMeshDirty(c.cx + 1, c.cz + 1);

    // Blocks that need support break when their base disappears.
    if (!isSolid(id) && wy + 1 < WORLD_HEIGHT) {
      const above = this.getBlockAt(wx, wy + 1, wz);
      if (blockDef(above).needsSupport) {
        this.setBlockAt(wx, wy + 1, wz, B.Air, 0, record);
        this.onSupportBroken?.(wx, wy + 1, wz, above);
      } else if (blockDef(above).gravity) {
        this.onGravityBlock?.(wx, wy + 1, wz, above);
      }
    }
    // A gravity block placed over a hole starts falling immediately.
    if (blockDef(id).gravity && !isSolid(this.getBlockAt(wx, wy - 1, wz))) {
      this.onGravityBlock?.(wx, wy, wz, id);
    }
    return true;
  }

  /** Sand/gravel lost its support — game layer turns it into a falling entity. */
  onGravityBlock: ((x: number, y: number, z: number, id: number) => void) | null = null;

  /** A support-needing block (torch/flower/bed/cane) popped off — drop its items. */
  onSupportBroken: ((x: number, y: number, z: number, id: number) => void) | null = null;

  /** Top-most solid block y at a column (for spawning). */
  surfaceYAt(wx: number, wz: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (this.isSolidAt(wx, y, wz)) return y;
    }
    return 0;
  }

  /** Biome at a column (pure terrain query, works for ungenerated chunks too). */
  biomeAt(wx: number, wz: number): ReturnType<Terrain['biomeAt']> {
    return this.terrain.biomeAt(wx, wz);
  }

  // ---------------- redstone engine ----------------
  //
  // Event-driven: setBlockAt enqueues changed cells near redstone components
  // into rsDirty; tickRedstone drains the queue, recomputes the affected wire
  // networks (bounded BFS — signal caps at 15 steps) and applies id swaps
  // (wire on/off + META signal level, lamps, torches, TNT ignition) in one
  // guarded batch so the swaps don't re-enqueue themselves.

  /** Cells whose redstone state must be re-evaluated ("x,y,z"). */
  private rsDirty = new Set<string>();
  /** Guard: batched engine swaps must not re-dirty the network. */
  private rsApplying = false;
  /** Pressed stone buttons -> seconds until auto-release. */
  private rsButtons = new Map<string, number>();
  /** Torches scheduled to flip -> remaining delay in seconds. */
  private rsTorches = new Map<string, number>();
  /** Plate cells currently held down by the player. */
  private rsPlates = new Set<string>();

  /** setBlockAt hook: queue cells whose change can affect a redstone network. */
  private rsOnBlockChanged(x: number, y: number, z: number, oldId: number, newId: number): void {
    // Any swap to "pressed" starts the release countdown, no matter who did it.
    if (newId === B.StoneButtonPressed) this.rsButtons.set(posKey(x, y, z), 1.0);

    let relevant = isRedstoneId(oldId) || isRedstoneId(newId);
    if (!relevant) {
      // Plain blocks matter too when a component sits in the 3x3x3 around
      // them (support removal, wire staircase cut by a solid block...).
      outer:
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (isRedstoneId(this.getBlockAt(x + dx, y + dy, z + dz))) {
              relevant = true;
              break outer;
            }
          }
        }
      }
    }
    if (relevant) this.rsDirty.add(posKey(x, y, z));
  }

  /**
   * Per-frame redstone simulation: button/torch timers, player-on-plate
   * detection, then wire network recomputation around all dirty cells.
   */
  tickRedstone(dt: number, px: number, py: number, pz: number): void {
    this.rsTickButtons(dt);
    this.rsTickTorches(dt);
    this.rsTickPlates(px, py, pz);
    if (this.rsDirty.size > 0) this.rsRecompute();
  }

  private rsTickButtons(dt: number): void {
    for (const [key, left] of this.rsButtons) {
      const remain = left - dt;
      if (remain > 0) {
        this.rsButtons.set(key, remain);
        continue;
      }
      this.rsButtons.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      if (this.getBlockAt(x, y, z) === B.StoneButtonPressed) {
        this.setBlockAt(x, y, z, B.StoneButton, this.getMetaAt(x, y, z));
      }
    }
  }

  private rsTickTorches(dt: number): void {
    for (const [key, left] of this.rsTorches) {
      const remain = left - dt;
      if (remain > 0) {
        this.rsTorches.set(key, remain);
        continue;
      }
      this.rsTorches.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      const id = this.getBlockAt(x, y, z);
      if (id !== B.RedstoneTorch && id !== B.RedstoneTorchOff) continue;
      // Re-derive the state at flip time (the pulse may have passed already).
      const want = this.rsSupportPowered(x, y - 1, z) ? B.RedstoneTorchOff : B.RedstoneTorch;
      if (id !== want) this.setBlockAt(x, y, z, want, this.getMetaAt(x, y, z));
    }
  }

  /** Press plates under the player's feet, release the ones stepped off. */
  private rsTickPlates(px: number, py: number, pz: number): void {
    // A plate cell is held down when the player AABB (0.6 wide) overlaps it
    // horizontally and the feet sit within 0.3 above the cell floor.
    const pressed = new Set<string>();
    const yLo = Math.ceil(py - 0.3);
    const yHi = Math.floor(py + 0.05);
    for (let x = Math.floor(px - 0.3); x <= Math.floor(px + 0.3); x++) {
      for (let z = Math.floor(pz - 0.3); z <= Math.floor(pz + 0.3); z++) {
        for (let y = yLo; y <= yHi; y++) {
          const id = this.getBlockAt(x, y, z);
          if (id === B.PressurePlate || id === B.PressurePlatePressed) {
            pressed.add(posKey(x, y, z));
          }
        }
      }
    }
    for (const key of pressed) {
      const [x, y, z] = key.split(',').map(Number);
      if (this.getBlockAt(x, y, z) === B.PressurePlate) {
        this.setBlockAt(x, y, z, B.PressurePlatePressed, this.getMetaAt(x, y, z));
      }
    }
    for (const key of this.rsPlates) {
      if (pressed.has(key)) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (this.getBlockAt(x, y, z) === B.PressurePlatePressed) {
        this.setBlockAt(x, y, z, B.PressurePlate, this.getMetaAt(x, y, z));
      }
    }
    this.rsPlates = pressed;
  }

  /** Wire cells connected to the wire at (x,y,z): same level + staircases. */
  private rsWireNeighbors(x: number, y: number, z: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (const [dx, dz] of RS_HORIZ) {
      if (isWireId(this.getBlockAt(x + dx, y, z + dz))) {
        out.push([x + dx, y, z + dz]);
      }
      // Step up: blocked when a solid block caps this (the lower) wire.
      if (isWireId(this.getBlockAt(x + dx, y + 1, z + dz)) && !isSolid(this.getBlockAt(x, y + 1, z))) {
        out.push([x + dx, y + 1, z + dz]);
      }
      // Step down: blocked when a solid block caps the lower wire over there.
      if (isWireId(this.getBlockAt(x + dx, y - 1, z + dz)) && !isSolid(this.getBlockAt(x + dx, y, z + dz))) {
        out.push([x + dx, y - 1, z + dz]);
      }
    }
    return out;
  }

  /** Strongest signal entering a consumer cell (sources 15, wires their level). */
  private rsPowerInto(x: number, y: number, z: number): number {
    let p = 0;
    for (const [dx, dy, dz] of RS_DIRS) {
      const nid = this.getBlockAt(x + dx, y + dy, z + dz);
      if (isWireId(nid)) p = Math.max(p, this.getMetaAt(x + dx, y + dy, z + dz));
      else p = Math.max(p, rsSourcePower(nid));
    }
    return p;
  }

  /**
   * Is the torch support cell at (x,y,z) powered? True flips the torch above
   * it off (the classic inverter). Powered by: being a redstone block, any
   * adjacent powered wire or non-torch source, or a lit torch directly below
   * (torches strongly power upward — and never their own support).
   */
  private rsSupportPowered(x: number, y: number, z: number): boolean {
    if (this.getBlockAt(x, y, z) === B.RedstoneBlock) return true;
    for (const [dx, dy, dz] of RS_DIRS) {
      const nid = this.getBlockAt(x + dx, y + dy, z + dz);
      if (isWireId(nid) && this.getMetaAt(x + dx, y + dy, z + dz) > 0) return true;
      if (nid === B.RedstoneTorch) {
        if (dy === -1) return true;
        continue;
      }
      if (rsSourcePower(nid) > 0) return true;
    }
    return false;
  }

  /**
   * Recompute the wire networks around all dirty cells: bounded BFS collects
   * the affected wires, signal relaxes outward from sources (15) losing 1 per
   * step, then swaps + consumer reactions are applied in one batch.
   */
  private rsRecompute(): void {
    const dirty = [...this.rsDirty];
    this.rsDirty.clear();

    // -- collect affected wires: seeds are wires in the 3x3x3 around each
    //    dirty cell, expanded along wire connectivity. Signal moves at most
    //    15 steps, so wires further than the depth cap cannot have changed.
    interface RsCell { x: number; y: number; z: number; power: number }
    const region = new Map<string, RsCell>();
    const queue: { x: number; y: number; z: number; d: number }[] = [];
    for (const key of dirty) {
      const [x, y, z] = key.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const wx = x + dx, wy = y + dy, wz = z + dz;
            const k = posKey(wx, wy, wz);
            if (!region.has(k) && isWireId(this.getBlockAt(wx, wy, wz))) {
              region.set(k, { x: wx, y: wy, z: wz, power: 0 });
              queue.push({ x: wx, y: wy, z: wz, d: 0 });
            }
          }
        }
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const { x, y, z, d } = queue[qi];
      if (d >= 17) continue;
      for (const [nx, ny, nz] of this.rsWireNeighbors(x, y, z)) {
        const k = posKey(nx, ny, nz);
        if (!region.has(k)) {
          region.set(k, { x: nx, y: ny, z: nz, power: 0 });
          queue.push({ x: nx, y: ny, z: nz, d: d + 1 });
        }
      }
    }

    // -- seed signal: adjacent sources give 15; wires just outside the region
    //    kept their old level and feed the boundary at level - 1.
    const buckets: RsCell[][] = Array.from({ length: 16 }, () => []);
    for (const cell of region.values()) {
      let p = 0;
      for (const [dx, dy, dz] of RS_DIRS) {
        p = Math.max(p, rsSourcePower(this.getBlockAt(cell.x + dx, cell.y + dy, cell.z + dz)));
      }
      if (p < 15) {
        for (const [nx, ny, nz] of this.rsWireNeighbors(cell.x, cell.y, cell.z)) {
          if (!region.has(posKey(nx, ny, nz))) {
            p = Math.max(p, this.getMetaAt(nx, ny, nz) - 1);
          }
        }
      }
      cell.power = p;
      if (p > 0) buckets[p].push(cell);
    }

    // -- relax outward, 15 -> 1 (uniform -1 edges: bucket order is optimal) --
    for (let p = 15; p >= 2; p--) {
      for (const cell of buckets[p]) {
        if (cell.power !== p) continue; // superseded by a stronger path
        for (const [nx, ny, nz] of this.rsWireNeighbors(cell.x, cell.y, cell.z)) {
          const n = region.get(posKey(nx, ny, nz));
          if (n && n.power < p - 1) {
            n.power = p - 1;
            buckets[p - 1].push(n);
          }
        }
      }
    }

    // -- apply: wire id/meta swaps first, then consumers see fresh levels --
    this.rsApplying = true;
    const ignitions: { x: number; y: number; z: number }[] = [];
    for (const cell of region.values()) {
      const id = this.getBlockAt(cell.x, cell.y, cell.z);
      const want = cell.power > 0 ? B.RedstoneWireOn : B.RedstoneWire;
      if (id !== want || this.getMetaAt(cell.x, cell.y, cell.z) !== cell.power) {
        this.setBlockAt(cell.x, cell.y, cell.z, want, cell.power);
      }
    }

    // Consumers anywhere in the 3x3x3 around a changed cell: lamps toggle,
    // TNT ignites, torches schedule an inverter flip.
    const evaluate = new Set<string>();
    const addAround = (x: number, y: number, z: number): void => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            evaluate.add(posKey(x + dx, y + dy, z + dz));
          }
        }
      }
    };
    for (const key of dirty) {
      const [x, y, z] = key.split(',').map(Number);
      addAround(x, y, z);
    }
    for (const cell of region.values()) addAround(cell.x, cell.y, cell.z);

    for (const key of evaluate) {
      const [x, y, z] = key.split(',').map(Number);
      const id = this.getBlockAt(x, y, z);
      if (id === B.RedstoneLamp || id === B.RedstoneLampOn) {
        const want = this.rsPowerInto(x, y, z) > 0 ? B.RedstoneLampOn : B.RedstoneLamp;
        if (id !== want) this.setBlockAt(x, y, z, want, this.getMetaAt(x, y, z));
      } else if (id === B.TNT) {
        if (this.rsPowerInto(x, y, z) > 0) ignitions.push({ x, y, z });
      } else if (id === B.RedstoneTorch || id === B.RedstoneTorchOff) {
        const want = this.rsSupportPowered(x, y - 1, z) ? B.RedstoneTorchOff : B.RedstoneTorch;
        if (id !== want && !this.rsTorches.has(key)) this.rsTorches.set(key, 0.1);
      } else if (id === B.StoneButtonPressed && !this.rsButtons.has(key)) {
        // Reload safety: a pressed button always gets a release countdown.
        this.rsButtons.set(key, 1.0);
      } else if (id === B.PressurePlatePressed) {
        // Reload safety: adopt unknown pressed plates so they can release.
        this.rsPlates.add(key);
      }
    }
    this.rsApplying = false;

    // TNT hand-off runs outside the guard: the game swaps the block to air,
    // which re-dirties neighbors through the normal hook.
    for (const { x, y, z } of ignitions) this.onTntIgnited?.(x, y, z);
  }

  /** Nearest dry, tree-free column (spiral search within generated chunks). */
  findSpawnColumn(wx: number, wz: number): { x: number; z: number } {
    for (let r = 0; r <= 48; r += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
          const x = wx + dx;
          const z = wz + dz;
          const y = this.surfaceYAt(x, z);
          if (y <= SEA_LEVEL) continue;
          const top = this.getBlockAt(x, y, z);
          if (top === B.Leaves || top === B.Cactus || top === B.OakLog) continue;
          if (this.getBlockAt(x, y + 1, z) !== B.Air || this.getBlockAt(x, y + 2, z) !== B.Air) continue;
          return { x, z };
        }
      }
    }
    return { x: wx, z: wz };
  }

  // ---------------- raycast (voxel DDA) ----------------

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RaycastHit | null {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const startId = this.getBlockAt(x, y, z);
    if (isTargetable(startId)) {
      return { x, y, z, nx: 0, ny: 0, nz: 0, id: startId, dist: 0 };
    }

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = stepX > 0 ? (x + 1 - origin.x) / dir.x : stepX < 0 ? (x - origin.x) / dir.x : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - origin.y) / dir.y : stepY < 0 ? (y - origin.y) / dir.y : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) / dir.z : stepZ < 0 ? (z - origin.z) / dir.z : Infinity;

    let t = 0;
    let nx = 0, ny = 0, nz = 0;
    while (t <= maxDist) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) break;
      const id = this.getBlockAt(x, y, z);
      if (isTargetable(id)) {
        return { x, y, z, nx, ny, nz, id, dist: t };
      }
    }
    return null;
  }

  /** Like raycast but stops at (and returns) the first liquid cell too. */
  raycastLiquid(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RaycastHit | null {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = stepX > 0 ? (x + 1 - origin.x) / dir.x : stepX < 0 ? (x - origin.x) / dir.x : Infinity;
    let tMaxY = stepY > 0 ? (y + 1 - origin.y) / dir.y : stepY < 0 ? (y - origin.y) / dir.y : Infinity;
    let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) / dir.z : stepZ < 0 ? (z - origin.z) / dir.z : Infinity;

    let t = 0;
    let nx = 0, ny = 0, nz = 0;
    while (t <= maxDist) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) break;
      const id = this.getBlockAt(x, y, z);
      if (isTargetable(id) || blockDef(id).liquid) {
        return { x, y, z, nx, ny, nz, id, dist: t };
      }
    }
    return null;
  }

  // ---------------- block entities ----------------

  getBlockEntity(x: number, y: number, z: number): BlockEntity | undefined {
    return this.blockEntities.get(posKey(x, y, z));
  }

  ensureFurnace(x: number, y: number, z: number): FurnaceState {
    const key = posKey(x, y, z);
    let be = this.blockEntities.get(key);
    if (!be || be.kind !== 'furnace') {
      be = { kind: 'furnace', input: null, fuel: null, output: null, burn: 0, burnTotal: 0, progress: 0, xp: 0 };
      this.blockEntities.set(key, be);
    }
    return be as FurnaceState;
  }

  ensureChest(x: number, y: number, z: number): ChestState {
    const key = posKey(x, y, z);
    let be = this.blockEntities.get(key);
    if (!be || be.kind !== 'chest') {
      be = { kind: 'chest', slots: new Array(27).fill(null) };
      this.blockEntities.set(key, be);
    }
    return be as ChestState;
  }

  /** Advance all furnaces. Swaps lit/unlit block variants as needed. */
  tickFurnaces(dt: number): void {
    for (const [key, be] of this.blockEntities) {
      if (be.kind !== 'furnace') continue;
      const [x, y, z] = key.split(',').map(Number);
      const blockId = this.getBlockAt(x, y, z);
      if (blockId !== B.Furnace && blockId !== B.FurnaceLit) continue;

      const recipe = be.input ? SMELTING[be.input.id] : undefined;
      const outFree =
        !!recipe && (!be.output || (be.output.id === recipe.out && be.output.count < itemDef(recipe.out).maxStack));
      const canSmelt = !!recipe && outFree;

      // Consume fuel when needed.
      if (be.burn <= 0 && canSmelt && be.fuel) {
        const ft = fuelTime(be.fuel.id);
        if (ft > 0) {
          be.burn = ft;
          be.burnTotal = ft;
          be.fuel.count--;
          if (be.fuel.count <= 0) be.fuel = null;
        }
      }

      if (be.burn > 0) {
        be.burn = Math.max(0, be.burn - dt);
        if (canSmelt) {
          be.progress += dt;
          if (be.progress >= SMELT_TIME && recipe && be.input) {
            be.progress = 0;
            be.input.count--;
            if (be.input.count <= 0) be.input = null;
            if (be.output) be.output.count++;
            else be.output = { id: recipe.out, count: 1 };
            be.xp += recipe.xp;
            this.onFurnaceFinish?.();
          }
        } else {
          be.progress = 0;
        }
      } else {
        be.progress = Math.max(0, be.progress - dt * 2);
      }

      const shouldBeLit = be.burn > 0;
      const meta = this.getMetaAt(x, y, z);
      if (shouldBeLit && blockId === B.Furnace) this.setBlockAt(x, y, z, B.FurnaceLit, meta);
      else if (!shouldBeLit && blockId === B.FurnaceLit) this.setBlockAt(x, y, z, B.Furnace, meta);
    }
  }

  // ---------------- random ticks ----------------

  /**
   * Vanilla-style random block updates near the player: crop growth, sapling
   * trees, grass spread/decay, farmland hydration, leaf decay.
   */
  randomTicks(dt: number, centerWx: number, centerWz: number, sunFactor: number): void {
    this.tickTimer += dt;
    if (this.tickTimer < 0.25) return;
    this.tickTimer = 0;

    const ccx = Math.floor(centerWx / CHUNK_SIZE);
    const ccz = Math.floor(centerWz / CHUNK_SIZE);
    const R = Math.min(4, this.renderDistance);
    for (let dcx = -R; dcx <= R; dcx++) {
      for (let dcz = -R; dcz <= R; dcz++) {
        const chunk = this.getGeneratedChunk(ccx + dcx, ccz + dcz);
        if (!chunk) continue;
        // ~16 random cells per chunk per tick window
        for (let n = 0; n < 16; n++) {
          const lx = (this.rand() * 16) | 0;
          const lz = (this.rand() * 16) | 0;
          const y = (this.rand() * WORLD_HEIGHT) | 0;
          const id = chunk.blocks[chunkIndex(lx, y, lz)];
          if (id === B.Air || id === B.Stone || id === B.Water) continue;
          this.randomTickBlock(chunk.cx * 16 + lx, y, chunk.cz * 16 + lz, id, sunFactor);
        }
      }
    }
  }

  private randomTickBlock(x: number, y: number, z: number, id: number, sun: number): void {
    // Crop growth (wheat, carrots, potatoes...)
    const bdef = blockDef(id);
    if (bdef.crop && bdef.growsTo !== undefined) {
      if (this.lightAt(x, y, z, sun) >= 9) {
        const below = this.getBlockAt(x, y - 1, z);
        const hydrated = below === B.FarmlandWet;
        if (this.rand() < (hydrated ? 0.33 : 0.12)) {
          this.setBlockAt(x, y, z, bdef.growsTo);
        }
      }
      return;
    }

    if (id === B.Farmland || id === B.FarmlandWet) {
      const wet = this.waterNearby(x, y, z);
      if (wet && id === B.Farmland) this.setBlockAt(x, y, z, B.FarmlandWet);
      else if (!wet && id === B.FarmlandWet && this.rand() < 0.3) this.setBlockAt(x, y, z, B.Farmland);
      // Revert to dirt when nothing is planted for a while
      const above = this.getBlockAt(x, y + 1, z);
      if (!blockDef(above).crop && this.rand() < 0.05) this.setBlockAt(x, y, z, B.Dirt);
      return;
    }

    if (id === B.Sapling) {
      if (this.lightAt(x, y, z, sun) >= 9 && this.rand() < 0.2) {
        this.growTree(x, y, z);
      }
      return;
    }

    if (id === B.Dirt) {
      // Grass spread from a neighboring grass block.
      if (this.getSkyAt(x, y + 1, z) >= 9 && !isOpaqueCube(this.getBlockAt(x, y + 1, z))) {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
          if (this.getBlockAt(x + dx, y + dy, z + dz) === B.Grass) {
            if (this.rand() < 0.35) this.setBlockAt(x, y, z, B.Grass);
            break;
          }
        }
      }
      return;
    }

    if (id === B.Grass) {
      if (isOpaqueCube(this.getBlockAt(x, y + 1, z))) {
        this.setBlockAt(x, y, z, B.Dirt);
      }
      return;
    }

    if (id === B.Leaves) {
      // Decay when no log within manhattan distance 4.
      if (!this.logNearby(x, y, z, 4) && this.rand() < 0.4) {
        this.setBlockAt(x, y, z, B.Air);
        this.onLeafDecay?.(x, y, z);
      }
      return;
    }

    if (id === B.SugarCane) {
      // Only the top segment grows, up to 3 tall.
      if (this.getBlockAt(x, y + 1, z) !== B.Air) return;
      let base = y;
      while (this.getBlockAt(x, base - 1, z) === B.SugarCane) base--;
      if (y - base + 1 < 3 && this.rand() < 0.25) {
        this.setBlockAt(x, y + 1, z, B.SugarCane);
      }
    }
  }

  onLeafDecay: ((x: number, y: number, z: number) => void) | null = null;

  private waterNearby(x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dy = 0; dy <= 1; dy++) {
          if (this.getBlockAt(x + dx, y + dy, z + dz) === B.Water) return true;
        }
      }
    }
    return false;
  }

  private logNearby(x: number, y: number, z: number, r: number): boolean {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > r) continue;
          if (this.getBlockAt(x + dx, y + dy, z + dz) === B.OakLog) return true;
        }
      }
    }
    return false;
  }

  /** Grows an oak tree replacing the sapling at (x, y, z). True on success. */
  growTree(x: number, y: number, z: number): boolean {
    const th = 4 + ((this.rand() * 3) | 0);
    // Space check above the trunk
    for (let k = 1; k <= th; k++) {
      const id = this.getBlockAt(x, y + k, z);
      if (id !== B.Air && id !== B.Leaves) return false;
    }
    this.setBlockAt(x, y, z, B.Air);
    for (let ly = th - 2; ly <= th + 1; ly++) {
      const r = ly <= th - 1 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0 && ly <= th) continue;
          if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2 && this.rand() < 0.8) continue;
          if (ly === th + 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
          const tx = x + dx, ty = y + ly, tz = z + dz;
          if (this.getBlockAt(tx, ty, tz) === B.Air) this.setBlockAt(tx, ty, tz, B.Leaves);
        }
      }
    }
    for (let k = 0; k < th; k++) {
      this.setBlockAt(x, y + k, z, B.OakLog);
    }
    return true;
  }

  // ---------------- explosions ----------------

  /**
   * Sphere explosion: destroys blocks with low blast resistance and returns
   * what was destroyed so the caller can spawn drops/particles/damage.
   */
  explode(cx: number, cy: number, cz: number, power: number): ExplosionResult {
    const destroyed: ExplosionResult['destroyed'] = [];
    const r = Math.ceil(power);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > power) continue;
          const x = Math.floor(cx) + dx, y = Math.floor(cy) + dy, z = Math.floor(cz) + dz;
          const id = this.getBlockAt(x, y, z);
          if (id === B.Air || blockDef(id).liquid) continue;
          const strength = (power - dist) * (0.7 + this.rand() * 0.6);
          if (blockDef(id).resistance / 5 <= strength) {
            destroyed.push({ x, y, z, id });
          }
        }
      }
    }
    // Sort bottom-up so needsSupport cascades don't double-remove.
    destroyed.sort((a, b) => a.y - b.y);
    for (const d of destroyed) {
      this.setBlockAt(d.x, d.y, d.z, B.Air);
    }
    return { destroyed };
  }

  // ---------------- streaming ----------------

  setRenderDistance(rd: number): void {
    this.renderDistance = rd;
    this.computeOffsets();
  }

  getRenderDistance(): number {
    return this.renderDistance;
  }

  private computeOffsets(): void {
    this.genOffsets = ringOffsets(this.renderDistance + 1);
    this.meshOffsets = ringOffsets(this.renderDistance);
  }

  /** Generate + mesh chunks around the center within a per-frame time budget. */
  update(centerWx: number, centerWz: number, budgetMs: number): void {
    const t0 = performance.now();
    const ccx = Math.floor(centerWx / CHUNK_SIZE);
    const ccz = Math.floor(centerWz / CHUNK_SIZE);

    for (const { dx, dz } of this.genOffsets) {
      if (performance.now() - t0 > budgetMs) break;
      const cx = ccx + dx;
      const cz = ccz + dz;
      if (!this.chunks.has(chunkKey(cx, cz))) {
        this.generateChunk(cx, cz);
      }
    }

    for (const { dx, dz } of this.meshOffsets) {
      if (performance.now() - t0 > budgetMs) break;
      const c = this.getGeneratedChunk(ccx + dx, ccz + dz);
      if (c && c.dirty && this.neighborsGenerated(c)) {
        this.buildMeshes(c);
      }
    }

    if (++this.frame % 90 === 0) {
      this.unloadFar(ccx, ccz);
    }
  }

  /** 0..1 readiness of the area around the given center (for the loading screen). */
  loadProgress(centerWx: number, centerWz: number): number {
    const ccx = Math.floor(centerWx / CHUNK_SIZE);
    const ccz = Math.floor(centerWz / CHUNK_SIZE);
    let gen = 0;
    for (const { dx, dz } of this.genOffsets) {
      if (this.getGeneratedChunk(ccx + dx, ccz + dz)) gen++;
    }
    let meshed = 0;
    for (const { dx, dz } of this.meshOffsets) {
      const c = this.getGeneratedChunk(ccx + dx, ccz + dz);
      if (c && c.meshes.length > 0) meshed++;
    }
    return 0.6 * (gen / this.genOffsets.length) + 0.4 * (meshed / this.meshOffsets.length);
  }

  private neighborsGenerated(c: Chunk): boolean {
    return !!(
      this.getGeneratedChunk(c.cx + 1, c.cz) &&
      this.getGeneratedChunk(c.cx - 1, c.cz) &&
      this.getGeneratedChunk(c.cx, c.cz + 1) &&
      this.getGeneratedChunk(c.cx, c.cz - 1)
    );
  }

  private generateChunk(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    this.chunks.set(chunkKey(cx, cz), chunk);
    this.terrain.generate(chunk);

    const editMap = this.edits.get(chunkKey(cx, cz));
    if (editMap) {
      for (const [i, packed] of editMap) {
        chunk.blocks[i] = packed & 0xff;
        chunk.meta[i] = (packed >> 8) & 0xff;
      }
    }

    this.lighting.initChunk(chunk);
    chunk.dirty = true;
    this.freshChunks.push(chunk);

    // Existing neighbors meshed against missing data must rebuild.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        this.markMeshDirty(cx + dx, cz + dz);
      }
    }
    return chunk;
  }

  private buildMeshes(chunk: Chunk): void {
    for (const m of chunk.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    chunk.meshes = [];

    this.lighting.invalidateCache();
    const data = buildChunkMesh(this, chunk);
    const parts: Array<[GeometryData | null, THREE.Material]> = [
      [data.opaque, this.materials.opaque],
      [data.cutout, this.materials.cutout],
      [data.water, this.materials.water],
    ];
    for (const [geo, mat] of parts) {
      if (!geo) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(geo.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(geo.indices, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.position.set(chunk.cx * CHUNK_SIZE, 0, chunk.cz * CHUNK_SIZE);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      chunk.meshes.push(mesh);
    }
    chunk.dirty = false;
  }

  private unloadFar(ccx: number, ccz: number): void {
    const maxDist = this.renderDistance + 3;
    for (const [key, chunk] of this.chunks) {
      const dx = chunk.cx - ccx;
      const dz = chunk.cz - ccz;
      if (dx * dx + dz * dz > maxDist * maxDist) {
        for (const m of chunk.meshes) {
          this.scene.remove(m);
          m.geometry.dispose();
        }
        chunk.meshes = [];
        this.chunks.delete(key);
      }
    }
    this.lighting.invalidateCache();
  }

  // ---------------- persistence ----------------

  serializeEdits(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [key, map] of this.edits) {
      const flat: number[] = [];
      for (const [i, packed] of map) flat.push(i, packed);
      out[key] = flat;
    }
    return out;
  }

  loadEdits(data: Record<string, number[]>): void {
    this.edits.clear();
    for (const [key, flat] of Object.entries(data)) {
      const map = new Map<number, number>();
      for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i], flat[i + 1]);
      this.edits.set(key, map);
    }
  }

  serializeBlockEntities(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const enc = (s: ItemStack | null) => (s ? [s.id, s.count, s.dur ?? 0] : null);
    for (const [key, be] of this.blockEntities) {
      if (be.kind === 'furnace') {
        out[key] = {
          k: 'f', i: enc(be.input), u: enc(be.fuel), o: enc(be.output),
          b: be.burn, bt: be.burnTotal, p: be.progress, x: be.xp,
        };
      } else {
        out[key] = { k: 'c', s: be.slots.map(enc) };
      }
    }
    return out;
  }

  loadBlockEntities(data: Record<string, unknown>): void {
    const dec = (d: unknown): ItemStack | null => {
      if (!Array.isArray(d)) return null;
      return { id: d[0], count: d[1], ...(d[2] ? { dur: d[2] } : {}) };
    };
    this.blockEntities.clear();
    for (const [key, raw] of Object.entries(data)) {
      const o = raw as Record<string, unknown>;
      if (o.k === 'f') {
        this.blockEntities.set(key, {
          kind: 'furnace',
          input: dec(o.i), fuel: dec(o.u), output: dec(o.o),
          burn: (o.b as number) ?? 0, burnTotal: (o.bt as number) ?? 0,
          progress: (o.p as number) ?? 0, xp: (o.x as number) ?? 0,
        });
      } else if (o.k === 'c') {
        this.blockEntities.set(key, {
          kind: 'chest',
          slots: ((o.s as unknown[]) ?? []).map(dec).concat(new Array(27).fill(null)).slice(0, 27),
        });
      }
    }
  }
}
