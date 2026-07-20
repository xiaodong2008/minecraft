import * as THREE from 'three';
import { Entity } from './base';
import { buildMobModel, MobModel, MobType } from '../render/mobmodels';
import { setObjectBrightness } from '../render/itemmesh';
import { B, Drop } from '../blocks';
import { I } from '../ids';
import type { ItemStack } from '../items';
import type { World } from '../world/world';

export interface MobDef {
  maxHp: number;
  speed: number;
  hostile: boolean;
  attackDamage: number;
  xp: number;
  halfW: number;
  height: number;
  burnsInDay: boolean;
  drops: (rand: () => number) => Drop[];
}

export const MOB_DEFS: Record<MobType, MobDef> = {
  zombie: {
    maxHp: 20, speed: 2.7, hostile: true, attackDamage: 3, xp: 5,
    halfW: 0.3, height: 1.9, burnsInDay: true,
    drops: (r) => {
      const out: Drop[] = [];
      if (r() < 0.8) out.push({ id: I.RottenFlesh, count: 1 + ((r() * 2) | 0) });
      if (r() < 0.02) out.push({ id: I.Carrot, count: 1 });
      if (r() < 0.02) out.push({ id: I.Potato, count: 1 });
      return out;
    },
  },
  skeleton: {
    maxHp: 20, speed: 2.8, hostile: true, attackDamage: 3, xp: 5,
    halfW: 0.3, height: 1.9, burnsInDay: true,
    drops: (r) => {
      const out: Drop[] = [];
      if (r() < 0.9) out.push({ id: I.Bone, count: 1 + ((r() * 2) | 0) });
      if (r() < 0.6) out.push({ id: I.Arrow, count: 1 + ((r() * 2) | 0) });
      return out;
    },
  },
  creeper: {
    maxHp: 20, speed: 2.9, hostile: true, attackDamage: 0, xp: 5,
    halfW: 0.3, height: 1.7, burnsInDay: false,
    drops: (r) => (r() < 0.9 ? [{ id: I.Gunpowder, count: 1 + ((r() * 2) | 0) }] : []),
  },
  spider: {
    maxHp: 16, speed: 3.6, hostile: true, attackDamage: 2, xp: 5,
    halfW: 0.65, height: 0.9, burnsInDay: false,
    drops: (r) => (r() < 0.85 ? [{ id: I.String, count: 1 + ((r() * 2) | 0) }] : []),
  },
  pig: {
    maxHp: 10, speed: 1.6, hostile: false, attackDamage: 0, xp: 2,
    halfW: 0.45, height: 0.9, burnsInDay: false,
    drops: (r) => [{ id: I.PorkchopRaw, count: 1 + ((r() * 3) | 0) }],
  },
  cow: {
    maxHp: 10, speed: 1.5, hostile: false, attackDamage: 0, xp: 2,
    halfW: 0.45, height: 1.4, burnsInDay: false,
    drops: (r) => [
      { id: I.BeefRaw, count: 1 + ((r() * 3) | 0) },
      { id: I.Leather, count: (r() * 3) | 0 },
    ],
  },
  sheep: {
    maxHp: 8, speed: 1.5, hostile: false, attackDamage: 0, xp: 2,
    halfW: 0.45, height: 1.3, burnsInDay: false,
    drops: (r) => [
      { id: I.MuttonRaw, count: 1 + ((r() * 2) | 0) },
      { id: B.WoolWhite, count: 1 },
    ],
  },
  chicken: {
    maxHp: 4, speed: 1.3, hostile: false, attackDamage: 0, xp: 2,
    halfW: 0.25, height: 0.7, burnsInDay: false,
    drops: (r) => {
      const out: Drop[] = [{ id: I.ChickenRaw, count: 1 }];
      if (r() < 0.7) out.push({ id: I.Feather, count: 1 + ((r() * 2) | 0) });
      return out;
    },
  },
};

/** What mob AI is allowed to see/do — implemented by the entity manager. */
export interface MobCtx {
  world: World;
  playerPos: THREE.Vector3;
  playerAlive: boolean;
  sunFactor: number;
  hurtPlayer(dmg: number, fromX: number, fromZ: number): void;
  shootArrow(x: number, y: number, z: number, dir: THREE.Vector3, damage: number): void;
  explode(x: number, y: number, z: number, power: number): void;
  flame(x: number, y: number, z: number): void;
  hearts(x: number, y: number, z: number): void;
  /** Spawn a dropped item stack in the world (egg laying, shearing). */
  dropItem(stack: ItemStack, x: number, y: number, z: number): void;
  spawnBaby(type: MobType, x: number, y: number, z: number): void;
  /** Living mobs of the same type near a point (for finding a mate). */
  findMate(self: Mob): Mob | null;
  mobSound(type: MobType, kind: 'hurt' | 'death' | 'ambient' | 'fuse'): void;
}

export class Mob extends Entity {
  readonly type: MobType;
  readonly def: MobDef;
  hp: number;
  yaw = Math.random() * Math.PI * 2;
  readonly obj: THREE.Group;
  private model: MobModel;

  private walkPhase = 0;
  private walkAmount = 0;
  private wanderTimer = Math.random() * 4;
  private wanderDir: { x: number; z: number } | null = null;
  private attackCooldown = 0;
  private shootCooldown = 2;
  private hurtFlash = 0;
  private fleeTimer = 0;
  private fleeFrom = { x: 0, z: 0 };
  private burnTimer = 0;
  private ambientTimer = 5 + Math.random() * 12;
  /** Creeper fuse state 0..1 (-1 = idle). */
  fuse = -1;
  dying = 0;
  private aggro = false;

  /** Breeding state (passive mobs). */
  love = 0;
  breedCooldown = 0;
  /** Seconds left growing up; 0 = adult. */
  growTimer = 0;
  /** Sheep wool state: sheared sheep regrow after a timer. */
  sheared = false;
  regrowTimer = 0;
  /** Chickens lay an egg when this runs out (6-10 minutes). */
  private eggTimer = 360 + Math.random() * 240;

  constructor(type: MobType, x: number, y: number, z: number, scene: THREE.Scene, hp?: number, baby = false) {
    super();
    this.type = type;
    this.def = MOB_DEFS[type];
    this.hp = hp ?? this.def.maxHp;
    this.halfW = this.def.halfW;
    this.height = this.def.height;
    this.pos.set(x, y, z);
    this.model = buildMobModel(type);
    this.obj = this.model.root;
    if (baby) {
      this.growTimer = 120;
      this.halfW *= 0.5;
      this.height *= 0.5;
    }
    scene.add(this.obj);
  }

  get isBaby(): boolean {
    return this.growTimer > 0;
  }

  /** Right-clicked with breeding food. True if consumed. */
  feed(ctx: MobCtx): boolean {
    if (this.def.hostile || this.dying > 0) return false;
    if (this.isBaby) {
      this.growTimer = Math.max(0, this.growTimer - 12); // snacks speed up growth
      ctx.hearts(this.pos.x, this.pos.y + this.height, this.pos.z);
      return true;
    }
    if (this.love > 0 || this.breedCooldown > 0) return false;
    this.love = 30;
    ctx.hearts(this.pos.x, this.pos.y + this.height, this.pos.z);
    ctx.mobSound(this.type, 'ambient');
    return true;
  }

  get hostile(): boolean {
    return this.def.hostile;
  }

  /** Right-clicked with shears. Drops wool and starts the regrow timer; true if sheared. */
  shear(ctx: MobCtx): boolean {
    if (this.type !== 'sheep' || this.sheared || this.isBaby || this.dying > 0) return false;
    this.sheared = true;
    this.regrowTimer = 60 + Math.random() * 60;
    ctx.dropItem(
      { id: B.WoolWhite, count: 1 + ((Math.random() * 3) | 0) },
      this.pos.x, this.pos.y + this.height * 0.6, this.pos.z,
    );
    ctx.mobSound(this.type, 'hurt');
    return true;
  }

  /** Drops granted on death (sheared sheep drop no wool). */
  deathDrops(rand: () => number): Drop[] {
    const drops = this.def.drops(rand);
    return this.type === 'sheep' && this.sheared
      ? drops.filter((d) => d.id !== B.WoolWhite)
      : drops;
  }

  hurt(dmg: number, fromX: number, fromZ: number, ctx: MobCtx): void {
    if (this.dying > 0 || this.dead) return;
    this.hp -= dmg;
    this.hurtFlash = 0.5;
    // Knockback away from the source
    const dx = this.pos.x - fromX;
    const dz = this.pos.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    this.vel.x += (dx / d) * 6.5;
    this.vel.z += (dz / d) * 6.5;
    this.vel.y = Math.max(this.vel.y, 4.6);

    if (this.hp <= 0) {
      this.dying = 0.0001;
      ctx.mobSound(this.type, 'death');
    } else {
      ctx.mobSound(this.type, 'hurt');
      if (!this.def.hostile) {
        this.fleeTimer = 5;
        this.fleeFrom = { x: fromX, z: fromZ };
      } else {
        this.aggro = true;
      }
    }
  }

  update(dt: number, ctx: MobCtx): void {
    this.age += dt;
    if (this.dying > 0) {
      this.dying += dt;
      this.applyGravityAndMove(ctx.world, dt, 1, 8);
      // Classic keel-over
      const t = Math.min(1, this.dying / 0.45);
      this.obj.rotation.z = (Math.PI / 2) * t;
      this.obj.position.set(this.pos.x, this.pos.y + Math.sin(t * Math.PI * 0.5) * 0.1, this.pos.z);
      setObjectBrightness(this.obj, 1, 0.7);
      if (this.dying > 0.9) this.dead = true;
      return;
    }

    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.fleeTimer = Math.max(0, this.fleeTimer - dt);
    this.love = Math.max(0, this.love - dt);
    this.breedCooldown = Math.max(0, this.breedCooldown - dt);
    if (this.growTimer > 0) {
      this.growTimer = Math.max(0, this.growTimer - dt);
      if (this.growTimer === 0) {
        this.halfW = this.def.halfW;
        this.height = this.def.height;
      }
    }
    if (this.love > 0 && Math.random() < dt * 1.2) {
      ctx.hearts(this.pos.x, this.pos.y + this.height, this.pos.z);
    }

    // Chickens periodically lay an egg.
    if (this.type === 'chicken' && !this.isBaby) {
      this.eggTimer -= dt;
      if (this.eggTimer <= 0) {
        this.eggTimer = 360 + Math.random() * 240;
        ctx.dropItem({ id: I.Egg, count: 1 }, this.pos.x, this.pos.y + 0.2, this.pos.z);
        ctx.mobSound(this.type, 'ambient');
      }
    }
    // Sheared sheep regrow their wool after a while.
    if (this.sheared) {
      this.regrowTimer -= dt;
      if (this.regrowTimer <= 0) this.sheared = false;
    }

    const p = ctx.playerPos;
    const dx = p.x - this.pos.x;
    const dz = p.z - this.pos.z;
    const distH = Math.hypot(dx, dz);
    const dist = Math.sqrt(this.dist2(p.x, p.y, p.z));

    // Daylight burning for undead
    if (this.def.burnsInDay && ctx.sunFactor > 0.75) {
      const bx = Math.floor(this.pos.x), bz = Math.floor(this.pos.z);
      if (ctx.world.getSkyAt(bx, Math.floor(this.pos.y + this.height * 0.8), bz) >= 14 && !this.inWater) {
        this.burnTimer += dt;
        if (Math.random() < dt * 8) ctx.flame(this.pos.x, this.pos.y + this.height * 0.7, this.pos.z);
        if (this.burnTimer > 1) {
          this.burnTimer = 0;
          this.hurt(1, this.pos.x + (Math.random() - 0.5), this.pos.z + (Math.random() - 0.5), ctx);
        }
      }
    }

    // Ambient voice
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0 && dist < 18) {
      this.ambientTimer = 6 + Math.random() * 14;
      if (Math.random() < 0.6) ctx.mobSound(this.type, 'ambient');
    }

    // In dark places spiders are hostile; in daylight they wander.
    const spiderAggro = this.type === 'spider'
      ? ctx.world.lightAt(Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), ctx.sunFactor) < 9 || this.aggro
      : false;
    const wantsChase =
      ctx.playerAlive && this.def.hostile && dist < 18 &&
      (this.type !== 'spider' || spiderAggro);

    let moveX = 0;
    let moveZ = 0;
    let speed = this.def.speed;

    if (this.fleeTimer > 0) {
      const fx = this.pos.x - this.fleeFrom.x;
      const fz = this.pos.z - this.fleeFrom.z;
      const fl = Math.hypot(fx, fz) || 1;
      moveX = fx / fl;
      moveZ = fz / fl;
      speed *= 1.7;
    } else if (this.love > 0) {
      const mate = ctx.findMate(this);
      if (mate) {
        const mx = mate.pos.x - this.pos.x;
        const mz = mate.pos.z - this.pos.z;
        const md = Math.hypot(mx, mz);
        if (md > 1.1) {
          moveX = mx / (md || 1);
          moveZ = mz / (md || 1);
          speed *= 0.7;
        } else {
          // Breed: this mob is the one that spawns the baby.
          this.love = 0;
          mate.love = 0;
          this.breedCooldown = 60;
          mate.breedCooldown = 60;
          const bx = (this.pos.x + mate.pos.x) / 2;
          const bz = (this.pos.z + mate.pos.z) / 2;
          ctx.spawnBaby(this.type, bx, Math.max(this.pos.y, mate.pos.y) + 0.1, bz);
          ctx.hearts(bx, this.pos.y + this.height, bz);
          ctx.mobSound(this.type, 'ambient');
        }
      }
    } else if (wantsChase && distH > 0.05) {
      const toward = { x: dx / (distH || 1), z: dz / (distH || 1) };

      if (this.type === 'skeleton') {
        // Kite: back off when close, advance when far, shoot on cooldown.
        if (dist < 7) { moveX = -toward.x; moveZ = -toward.z; }
        else if (dist > 11) { moveX = toward.x; moveZ = toward.z; }
        if (dist < 15 && this.shootCooldown <= 0) {
          this.shootCooldown = 2.4;
          const from = new THREE.Vector3(this.pos.x, this.pos.y + 1.5, this.pos.z);
          const target = new THREE.Vector3(p.x, p.y + 1.2, p.z);
          const dir = target.sub(from).normalize();
          dir.x += (Math.random() - 0.5) * 0.12;
          dir.y += (Math.random() - 0.5) * 0.06 + dist * 0.008;
          dir.z += (Math.random() - 0.5) * 0.12;
          ctx.shootArrow(from.x, from.y, from.z, dir, 3);
        }
      } else if (this.type === 'creeper') {
        if (dist < 2.6 || this.fuse >= 0) {
          if (this.fuse < 0) {
            this.fuse = 0;
            ctx.mobSound('creeper', 'fuse');
          }
          this.fuse += dt / 1.5;
          if (dist > 5.5) this.fuse = -1; // player escaped
          if (this.fuse >= 1) {
            this.dead = true;
            ctx.explode(this.pos.x, this.pos.y + 0.5, this.pos.z, 3);
            return;
          }
        } else {
          moveX = toward.x;
          moveZ = toward.z;
        }
      } else {
        moveX = toward.x;
        moveZ = toward.z;
        // Spider pounce
        if (this.type === 'spider' && this.onGround && dist < 4.5 && dist > 2 && Math.random() < dt * 1.6) {
          this.vel.y = 6.4;
          this.vel.x += toward.x * 4;
          this.vel.z += toward.z * 4;
        }
        // Melee
        if (this.attackCooldown <= 0 && distH < this.halfW + 0.75 && Math.abs(p.y - this.pos.y) < 2) {
          this.attackCooldown = 1;
          ctx.hurtPlayer(this.def.attackDamage, this.pos.x, this.pos.z);
        }
      }
    } else {
      // Wander
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2 + Math.random() * 5;
        this.wanderDir = Math.random() < 0.6
          ? { x: Math.cos(Math.random() * Math.PI * 2), z: Math.sin(Math.random() * Math.PI * 2) }
          : null;
      }
      if (this.wanderDir) {
        moveX = this.wanderDir.x;
        moveZ = this.wanderDir.z;
        speed *= 0.55;
      }
    }

    // Baby scale / creeper swell
    if (this.isBaby) {
      const s = 0.5 + 0.5 * (1 - this.growTimer / 120);
      this.obj.scale.setScalar(s);
    } else if (this.type === 'creeper') {
      const s = this.fuse >= 0 ? 1 + this.fuse * 0.25 : 1;
      this.obj.scale.set(s, 1 + (s - 1) * 0.5, s);
      if (this.fuse >= 0) { moveX = 0; moveZ = 0; }
    } else {
      this.obj.scale.setScalar(1);
    }

    // Steering
    const blend = 1 - Math.exp(-(this.onGround ? 10 : 2.5) * dt);
    this.vel.x += (moveX * speed - this.vel.x) * blend;
    this.vel.z += (moveZ * speed - this.vel.z) * blend;

    const wasHitWall = this.moveAndJump(ctx.world, dt, moveX, moveZ);
    void wasHitWall;

    // Face movement or player
    const facePlayer = wantsChase || (dist < 6 && !this.def.hostile && Math.random() < 0.8);
    const targetYaw = facePlayer && distH > 0.01
      ? Math.atan2(-dx, -dz) + Math.PI
      : (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 0.3 ? Math.atan2(-this.vel.x, -this.vel.z) + Math.PI : this.yaw);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 7);

    // Animate
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.3) {
      this.walkPhase += dt * hSpeed * 2.4;
      this.walkAmount = Math.min(1, this.walkAmount + dt * 5);
    } else {
      this.walkAmount = Math.max(0, this.walkAmount - dt * 5);
    }
    for (const limb of this.model.limbs) {
      const phase = (limb.userData.phase as number) ?? 0;
      const swing = Math.sin(this.walkPhase + phase) * 0.7 * this.walkAmount;
      if (limb.userData.spider) {
        limb.rotation.y = swing * 0.4;
      } else if (limb.userData.arm && this.type === 'zombie') {
        limb.rotation.x = -Math.PI / 2 + swing * 0.25;
      } else {
        limb.rotation.x = swing;
      }
    }
    if (this.model.body) {
      // Sheared sheep show a slimmer torso until the wool regrows.
      if (this.type === 'sheep' && this.sheared) this.model.body.scale.set(0.8, 0.72, 0.95);
      else this.model.body.scale.set(1, 1, 1);
    }
    if (this.model.head && facePlayer) {
      const eyeY = this.pos.y + this.model.eyeHeight;
      const pitch = Math.atan2(p.y + 1.4 - eyeY, distH || 1);
      this.model.head.rotation.x = THREE.MathUtils.clamp(-pitch, -0.7, 0.7);
    } else if (this.model.head) {
      this.model.head.rotation.x *= 1 - Math.min(1, dt * 4);
    }

    this.obj.rotation.z = 0;
    this.obj.rotation.y = this.yaw;
    this.obj.position.copy(this.pos);

    // Light + damage tint
    const bx = Math.floor(this.pos.x), by = Math.floor(this.pos.y + this.height * 0.6), bz = Math.floor(this.pos.z);
    const light = Math.max(
      ctx.world.getSkyAt(bx, by, bz) / 15 * (0.25 + 0.75 * ctx.sunFactor),
      ctx.world.getBlockLightAt(bx, by, bz) / 15,
    );
    const flash = this.hurtFlash > 0 ? 0.75 : this.fuse >= 0 && Math.sin(this.fuse * 22) > 0 ? 0.5 : 0;
    setObjectBrightness(this.obj, 0.22 + 0.78 * light, flash);
  }

  private moveAndJump(world: World, dt: number, moveX: number, moveZ: number): boolean {
    const wantsMove = Math.abs(moveX) + Math.abs(moveZ) > 0.1;
    const before = { x: this.pos.x, z: this.pos.z };
    this.applyGravityAndMove(world, dt, 1, 0);

    if (this.inWater) {
      this.vel.y = Math.min(this.vel.y + 26 * dt, 2.2); // paddle up
    }

    // Jump over one-block walls when stuck.
    if (wantsMove && this.onGround) {
      const movedSq = (this.pos.x - before.x) ** 2 + (this.pos.z - before.z) ** 2;
      const expected = (Math.hypot(this.vel.x, this.vel.z) * dt) ** 2;
      if (movedSq < expected * 0.25) {
        const aheadX = Math.floor(this.pos.x + moveX * (this.halfW + 0.3));
        const aheadZ = Math.floor(this.pos.z + moveZ * (this.halfW + 0.3));
        const feetY = Math.floor(this.pos.y);
        if (world.isSolidAt(aheadX, feetY, aheadZ) && !world.isSolidAt(aheadX, feetY + 1, aheadZ)) {
          this.vel.y = 8.2;
        }
        return true;
      }
    }
    return false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}
