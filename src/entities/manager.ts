import * as THREE from 'three';
import { ItemEntity, XpOrb } from './itemdrop';
import { Arrow, ArrowHitTarget, PrimedTnt, FallingBlock } from './projectiles';
import { Mob, MobCtx } from './mob';
import { MobType } from '../render/mobmodels';
import { makeItemObject } from '../render/itemmesh';
import { B, Drop, blockDef } from '../blocks';
import type { ItemStack } from '../items';
import type { World } from '../world/world';
import type { Particles } from '../render/particles';
import type { Sound } from '../audio';

const MAX_ITEMS = 150;
const MAX_HOSTILE = 14;
const HOSTILE_DESPAWN = 64;

export interface EntityHooks {
  /** Give a stack to the player; returns the count that did not fit. */
  pickupItem(stack: ItemStack): number;
  pickupXp(value: number): void;
  hurtPlayer(dmg: number, fromX: number, fromZ: number): void;
  playerPos(): THREE.Vector3;
  playerAlive(): boolean;
}

export class EntityManager {
  items: ItemEntity[] = [];
  orbs: XpOrb[] = [];
  arrows: Arrow[] = [];
  tnts: PrimedTnt[] = [];
  falling: FallingBlock[] = [];
  mobs: Mob[] = [];

  /** Chunks that already received their one-time passive mob seeding. */
  seededChunks = new Set<string>();

  private scene: THREE.Scene;
  private world: World;
  private atlas: THREE.Texture;
  private particles: Particles;
  private sound: Sound;
  private hooks: EntityHooks;
  private hostileSpawnTimer = 0;

  constructor(
    scene: THREE.Scene, world: World, atlas: THREE.Texture,
    particles: Particles, sound: Sound, hooks: EntityHooks,
  ) {
    this.scene = scene;
    this.world = world;
    this.atlas = atlas;
    this.particles = particles;
    this.sound = sound;
    this.hooks = hooks;
  }

  // ---------------- spawning ----------------

  dropItem(stack: ItemStack, x: number, y: number, z: number, vel?: THREE.Vector3): ItemEntity {
    const e = new ItemEntity(stack, x, y, z, this.atlas, this.scene);
    if (vel) e.vel.copy(vel);
    this.items.push(e);
    if (this.items.length > MAX_ITEMS) {
      const oldest = this.items.shift()!;
      oldest.dispose(this.scene);
    }
    return e;
  }

  /** Standard block-break drop spray at a block cell. */
  dropBlockItems(drops: Drop[], bx: number, by: number, bz: number): void {
    for (const d of drops) {
      if (d.count <= 0) continue;
      const e = this.dropItem(
        { id: d.id, count: d.count },
        bx + 0.3 + Math.random() * 0.4, by + 0.3, bz + 0.3 + Math.random() * 0.4,
      );
      e.pickupDelay = 0.25;
    }
  }

  spawnXp(amount: number, x: number, y: number, z: number): void {
    let left = Math.round(amount);
    while (left > 0) {
      const v = left >= 7 ? 7 : left >= 3 ? 3 : 1;
      left -= v;
      this.orbs.push(new XpOrb(v, x, y, z, this.scene));
    }
  }

  spawnMob(type: MobType, x: number, y: number, z: number, hp?: number, baby = false): Mob {
    const m = new Mob(type, x, y, z, this.scene, hp, baby);
    this.mobs.push(m);
    return m;
  }

  shootArrow(x: number, y: number, z: number, dir: THREE.Vector3, speed: number, damage: number, fromPlayer: boolean): void {
    this.arrows.push(new Arrow(x, y, z, dir, speed, damage, fromPlayer, this.scene));
    this.sound.bow();
  }

  primeTnt(bx: number, by: number, bz: number): void {
    const obj = makeItemObject(B.TNT, this.atlas);
    obj.scale.setScalar(0.98);
    this.tnts.push(new PrimedTnt(bx + 0.5, by, bz + 0.5, obj, this.scene));
    this.sound.fuse();
  }

  /** Turn a world block into a falling entity (sand/gravel losing support). */
  spawnFallingBlock(bx: number, by: number, bz: number, id: number): void {
    const obj = makeItemObject(id, this.atlas);
    obj.scale.setScalar(0.98);
    this.falling.push(new FallingBlock(bx, by, bz, id, obj, this.scene));
  }

  explode(x: number, y: number, z: number, power: number): void {
    const result = this.world.explode(x, y, z, power);
    for (const d of result.destroyed) {
      if (d.id === B.TNT) {
        this.primeTnt(d.x, d.y, d.z);
      } else if (Math.random() < 0.3) {
        this.dropBlockItems(blockDef(d.id).drops(Math.random), d.x, d.y, d.z);
      }
    }
    this.particles.explosion(x, y, z, power);
    this.sound.explosion();

    // Entity damage falls off with distance.
    const range = power * 2;
    const hit = (ex: number, ey: number, ez: number): number => {
      const d = Math.hypot(ex - x, ey - y, ez - z);
      if (d > range) return 0;
      return Math.round((1 - d / range) * power * 7);
    };
    const pp = this.hooks.playerPos();
    const pd = hit(pp.x, pp.y + 0.9, pp.z);
    if (pd > 0) this.hooks.hurtPlayer(pd, x, z);
    for (const m of this.mobs) {
      const md = hit(m.pos.x, m.pos.y + m.height / 2, m.pos.z);
      if (md > 0) m.hurt(md, x, z, this.mobCtx());
    }
    for (const t of this.tnts) {
      if (Math.hypot(t.pos.x - x, t.pos.y - y, t.pos.z - z) < range) {
        t.fuse = Math.min(t.fuse, 0.3 + Math.random() * 0.5);
      }
    }
  }

  // ---------------- queries ----------------

  /** Closest living mob intersecting the ray within reach (for attacks/crosshair). */
  raycastMob(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): Mob | null {
    let best: Mob | null = null;
    let bestT = maxDist;
    for (const m of this.mobs) {
      if (m.dying > 0 || m.dead) continue;
      // Ray vs AABB (slab test)
      const minX = m.pos.x - m.halfW, maxX = m.pos.x + m.halfW;
      const minY = m.pos.y, maxY = m.pos.y + m.height;
      const minZ = m.pos.z - m.halfW, maxZ = m.pos.z + m.halfW;
      let t0 = 0, t1 = bestT;
      let ok = true;
      const check = (o: number, d: number, mn: number, mx: number): void => {
        if (Math.abs(d) < 1e-9) {
          if (o < mn || o > mx) ok = false;
          return;
        }
        let ta = (mn - o) / d;
        let tb = (mx - o) / d;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      };
      check(origin.x, dir.x, minX, maxX);
      check(origin.y, dir.y, minY, maxY);
      check(origin.z, dir.z, minZ, maxZ);
      if (ok && t0 <= t1 && t0 < bestT) {
        // Blocked by terrain?
        const blockHit = this.world.raycast(origin, dir, t0);
        if (!blockHit) {
          bestT = t0;
          best = m;
        }
      }
    }
    return best;
  }

  hostileCount(): number {
    let n = 0;
    for (const m of this.mobs) if (m.hostile) n++;
    return n;
  }

  /** Context handed to mob AI; also used by interaction for feed/attack effects. */
  ctx(): MobCtx {
    return this.mobCtx();
  }

  private mobCtx(): MobCtx {
    return {
      world: this.world,
      playerPos: this.hooks.playerPos(),
      playerAlive: this.hooks.playerAlive(),
      sunFactor: this.lastSun,
      hurtPlayer: (dmg, fx, fz) => this.hooks.hurtPlayer(dmg, fx, fz),
      shootArrow: (x, y, z, dir, damage) => this.shootArrow(x, y, z, dir, 22, damage, false),
      explode: (x, y, z, power) => this.explode(x, y, z, power),
      flame: (x, y, z) => this.particles.flame(x, y, z),
      hearts: (x, y, z) => this.particles.hearts(x, y, z),
      spawnBaby: (type, x, y, z) => {
        this.spawnMob(type, x, y, z, undefined, true);
      },
      findMate: (self) => {
        let best: Mob | null = null;
        let bestD = 8 * 8;
        for (const m of this.mobs) {
          if (m === self || m.type !== self.type || m.love <= 0 || m.dying > 0 || m.dead || m.isBaby) continue;
          const d = m.dist2(self.pos.x, self.pos.y, self.pos.z);
          if (d < bestD) {
            bestD = d;
            best = m;
          }
        }
        return best;
      },
      mobSound: (type, kind) => this.sound.mob(type, kind),
    };
  }

  private lastSun = 1;

  // ---------------- update ----------------

  update(dt: number, sunFactor: number): void {
    this.lastSun = sunFactor;
    const pp = this.hooks.playerPos();
    const alive = this.hooks.playerAlive();

    // Entities in unloaded chunks are frozen (no ground data — they'd fall forever).
    const loaded = (x: number, z: number): boolean =>
      !!this.world.getGeneratedChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);

    // Items: physics, merging, pickup
    for (const e of this.items) {
      if (!loaded(e.pos.x, e.pos.z)) continue;
      e.update(dt, this.world);
      if (alive && e.magnet(dt, pp.x, pp.y + 0.6, pp.z)) {
        const left = this.hooks.pickupItem(e.stack);
        if (left <= 0) {
          e.dead = true;
          this.sound.pop();
        } else if (left < e.stack.count) {
          e.stack.count = left;
          this.sound.pop();
        }
      }
    }
    // Merge nearby identical stacks (cheap n^2 over a small set, throttled)
    if (Math.random() < 0.2) {
      for (let i = 0; i < this.items.length; i++) {
        const a = this.items[i];
        if (a.dead) continue;
        for (let j = i + 1; j < this.items.length; j++) {
          const b = this.items[j];
          if (b.dead || a.stack.id !== b.stack.id) continue;
          if (a.stack.dur !== undefined || b.stack.dur !== undefined) continue;
          if (a.dist2(b.pos.x, b.pos.y, b.pos.z) < 0.7) {
            a.stack.count += b.stack.count;
            b.dead = true;
          }
        }
      }
    }

    for (const o of this.orbs) {
      o.update(dt, this.world);
      if (alive && o.magnet(dt, pp.x, pp.y + 0.6, pp.z)) {
        this.hooks.pickupXp(o.value);
        this.sound.xp();
        o.dead = true;
      }
    }

    // Arrows
    const targets: ArrowHitTarget[] = [];
    for (const a of this.arrows) {
      targets.length = 0;
      if (a.fromPlayer) {
        for (const m of this.mobs) {
          if (m.dying > 0) continue;
          targets.push({
            radius: Math.max(0.5, m.halfW + 0.2),
            x: m.pos.x, y: m.pos.y + m.height / 2, z: m.pos.z,
            onHit: (dmg, fx, fz) => {
              m.hurt(dmg, fx, fz, this.mobCtx());
              this.particles.damage(m.pos.x, m.pos.y, m.pos.z);
            },
          });
        }
      } else if (alive) {
        targets.push({
          radius: 0.65,
          x: pp.x, y: pp.y + 0.9, z: pp.z,
          onHit: (dmg, fx, fz) => this.hooks.hurtPlayer(dmg, fx, fz),
        });
      }
      a.update(dt, this.world, targets);
    }

    // TNT
    for (const t of this.tnts) {
      t.update(dt, this.world);
      if (t.exploded) {
        this.explode(t.pos.x, t.pos.y + 0.5, t.pos.z, 3.6);
      }
    }

    // Falling sand/gravel
    for (const f of this.falling) {
      if (!loaded(f.pos.x, f.pos.z)) continue;
      f.update(dt, this.world);
      if (f.landed) {
        const bx = Math.floor(f.pos.x);
        const by = Math.floor(f.pos.y + 0.02);
        const bz = Math.floor(f.pos.z);
        if (blockDef(this.world.getBlockAt(bx, by, bz)).replaceable) {
          this.world.setBlockAt(bx, by, bz, f.blockId);
          this.sound.dig(blockDef(f.blockId).sound);
        } else {
          // Landing cell occupied (e.g. torch/slab edge): drop as an item.
          this.dropBlockItems([{ id: f.blockId, count: 1 }], bx, by, bz);
        }
      }
    }

    // Mobs
    const ctx = this.mobCtx();
    for (const m of this.mobs) {
      if (!loaded(m.pos.x, m.pos.z)) continue;
      m.update(dt, ctx);
      if (m.dead && m.dying > 0) {
        // Died (not despawned): drops + xp
        this.dropBlockItems(m.def.drops(Math.random), Math.floor(m.pos.x), Math.floor(m.pos.y + 0.3), Math.floor(m.pos.z));
        this.spawnXp(m.def.xp, m.pos.x, m.pos.y + 0.5, m.pos.z);
        this.particles.damage(m.pos.x, m.pos.y + 0.5, m.pos.z);
      }
      // Hostile despawn far away
      if (!m.dead && m.hostile && m.dist2(pp.x, pp.y, pp.z) > HOSTILE_DESPAWN * HOSTILE_DESPAWN) {
        m.dead = true;
        m.dying = 0;
      }
    }

    this.trySpawns(dt, pp, sunFactor);
    this.reap();
  }

  private trySpawns(dt: number, pp: THREE.Vector3, sunFactor: number): void {
    // Passive seeding of freshly generated chunks
    for (const chunk of this.world.freshChunks) {
      const key = `${chunk.cx},${chunk.cz}`;
      if (this.seededChunks.has(key)) continue;
      this.seededChunks.add(key);
      if (Math.random() > 0.12) continue;
      const types: MobType[] = ['pig', 'cow', 'sheep', 'chicken'];
      const type = types[(Math.random() * types.length) | 0];
      const n = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const x = chunk.cx * 16 + 2 + ((Math.random() * 12) | 0);
        const z = chunk.cz * 16 + 2 + ((Math.random() * 12) | 0);
        const y = this.world.surfaceYAt(x, z);
        if (this.world.getBlockAt(x, y, z) !== B.Grass) continue;
        this.spawnMob(type, x + 0.5, y + 1.05, z + 0.5);
      }
    }
    this.world.freshChunks.length = 0;

    // Hostile spawning in darkness
    this.hostileSpawnTimer -= dt;
    if (this.hostileSpawnTimer > 0) return;
    this.hostileSpawnTimer = 1.6;
    if (this.hostileCount() >= MAX_HOSTILE) return;

    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 26 + Math.random() * 22;
      const x = Math.floor(pp.x + Math.cos(ang) * dist);
      const z = Math.floor(pp.z + Math.sin(ang) * dist);
      if (!this.world.getGeneratedChunk(x >> 4, z >> 4)) continue;

      // Surface spawn or cave spawn: pick a random y with ground below
      let y: number;
      if (Math.random() < 0.55) {
        y = this.world.surfaceYAt(x, z) + 1;
      } else {
        y = 6 + ((Math.random() * 58) | 0);
        if (!this.world.isSolidAt(x, y - 1, z)) continue;
      }
      if (this.world.getBlockAt(x, y, z) !== B.Air || this.world.getBlockAt(x, y + 1, z) !== B.Air) continue;
      if (this.world.lightAt(x, y, z, sunFactor) >= 4) continue;
      if ((pp.x - x) ** 2 + (pp.z - z) ** 2 < 24 * 24) continue;

      const r = Math.random();
      const type: MobType = r < 0.4 ? 'zombie' : r < 0.65 ? 'skeleton' : r < 0.85 ? 'creeper' : 'spider';
      this.spawnMob(type, x + 0.5, y + 0.05, z + 0.5);
      break;
    }
  }

  private reap(): void {
    const sweep = <T extends { dead: boolean; dispose(s: THREE.Scene): void }>(list: T[]): T[] => {
      const out: T[] = [];
      for (const e of list) {
        if (e.dead) e.dispose(this.scene);
        else out.push(e);
      }
      return out;
    };
    this.items = sweep(this.items);
    this.orbs = sweep(this.orbs);
    this.arrows = sweep(this.arrows);
    this.tnts = sweep(this.tnts);
    this.falling = sweep(this.falling);
    this.mobs = sweep(this.mobs);
  }

  clearAll(): void {
    for (const list of [this.items, this.orbs, this.arrows, this.tnts, this.falling, this.mobs] as const) {
      for (const e of list) e.dispose(this.scene);
    }
    this.items = [];
    this.orbs = [];
    this.arrows = [];
    this.tnts = [];
    this.falling = [];
    this.mobs = [];
  }

  // ---------------- persistence ----------------

  serialize(): { mobs: unknown[]; items: unknown[]; seeded: string[] } {
    return {
      mobs: this.mobs
        .filter((m) => m.dying === 0)
        .map((m) => [m.type, +m.pos.x.toFixed(2), +m.pos.y.toFixed(2), +m.pos.z.toFixed(2), m.hp, Math.ceil(m.growTimer)]),
      items: this.items.map((e) => [e.stack.id, e.stack.count, e.stack.dur ?? 0, +e.pos.x.toFixed(2), +e.pos.y.toFixed(2), +e.pos.z.toFixed(2)]),
      seeded: [...this.seededChunks],
    };
  }

  load(data: { mobs?: unknown[]; items?: unknown[]; seeded?: string[] } | undefined): void {
    if (!data) return;
    this.seededChunks = new Set(data.seeded ?? []);
    for (const raw of data.mobs ?? []) {
      const [type, x, y, z, hp, grow] = raw as [MobType, number, number, number, number, number?];
      const m = this.spawnMob(type, x, y, z, hp, (grow ?? 0) > 0);
      if (grow && grow > 0) m.growTimer = grow;
    }
    for (const raw of data.items ?? []) {
      const [id, count, dur, x, y, z] = raw as number[];
      const e = this.dropItem({ id, count, ...(dur ? { dur } : {}) }, x, y, z);
      e.vel.set(0, 0, 0);
    }
  }
}
