import * as THREE from 'three';
import {
  GRAVITY, TERMINAL_VELOCITY, JUMP_SPEED, WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, SWIM_SPEED,
  PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT, SNEAK_EYE_HEIGHT,
  MAX_HEALTH, MAX_FOOD, MAX_AIR, FALL_SAFE_BLOCKS,
} from '../constants';
import { B } from '../blocks';
import type { World } from '../world/world';
import type { Input } from './input';

const HALF_W = PLAYER_WIDTH / 2;
const EPS = 0.001;

export interface DamageEvent {
  amount: number;
  fromX?: number;
  fromZ?: number;
}

/** First-person survival player: movement, collision, and vital stats. */
export class Player {
  /** Feet position (center of the AABB footprint). */
  pos = new THREE.Vector3(0.5, 80, 0.5);
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  inWater = false;
  headInWater = false;
  inLava = false;
  sprinting = false;
  sneaking = false;

  /** Creative mode: no damage, no hunger, flight, instant break. */
  creative = false;
  /** Creative flight (toggled by double-tapping Space). */
  flying = false;

  // Vitals
  health = MAX_HEALTH;
  food = MAX_FOOD;
  saturation = 5;
  exhaustion = 0;
  air = MAX_AIR;
  alive = true;
  /** Total XP points and derived level/progress. */
  xp = 0;
  level = 0;
  xpProgress = 0; // 0..1 into the current level

  /** Counts down after damage: used for the camera tilt + i-frames. */
  hurtTime = 0;
  private regenTimer = 0;
  private starveTimer = 0;
  private lavaTimer = 0;
  private drownTimer = 0;
  /** On fire for this many more seconds (after lava). */
  fireTime = 0;
  private fireTimer = 0;

  private fallStartY: number | null = null;

  spawnPoint = new THREE.Vector3(8.5, 80, 8.5);

  onDamaged: ((e: DamageEvent) => void) | null = null;
  onDied: (() => void) | null = null;
  onFall: ((blocks: number) => void) | null = null;

  private world: World;
  private bobPhase = 0;
  private bobAmount = 0;

  constructor(world: World) {
    this.world = world;
  }

  spawn(x: number, z: number): void {
    const col = this.world.findSpawnColumn(x, z);
    const y = this.world.surfaceYAt(col.x, col.z) + 1;
    this.pos.set(col.x + 0.5, y + 0.05, col.z + 0.5);
    this.spawnPoint.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = Math.PI * 0.25;
    this.pitch = 0;
  }

  respawn(): void {
    this.pos.copy(this.spawnPoint);
    // Terrain may differ (edits): snap to surface.
    const sx = Math.floor(this.pos.x);
    const sz = Math.floor(this.pos.z);
    this.pos.y = this.world.surfaceYAt(sx, sz) + 1.05;
    this.vel.set(0, 0, 0);
    this.health = MAX_HEALTH;
    this.food = MAX_FOOD;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.fireTime = 0;
    this.hurtTime = 0;
    this.alive = true;
    this.fallStartY = null;
  }

  currentHeight(): number {
    return PLAYER_HEIGHT;
  }

  eyeHeight(): number {
    return this.sneaking ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
  }

  eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z);
  }

  lookDirection(): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  applyLook(dx: number, dy: number, sensitivity = 1): void {
    const k = 0.0023 * sensitivity;
    this.yaw -= dx * k;
    this.pitch -= dy * k;
    const limit = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  // ---------------- vitals ----------------

  /** Armor points are supplied by the game (from the inventory). */
  armorPoints = 0;

  hurt(amount: number, fromX?: number, fromZ?: number, bypassArmor = false): void {
    if (!this.alive || amount <= 0) return;
    if (this.creative) return; // creative players take no damage
    if (this.hurtTime > 0.4) return; // i-frames

    let dmg = amount;
    if (!bypassArmor && this.armorPoints > 0) {
      dmg = amount * (1 - Math.min(0.8, this.armorPoints * 0.04));
    }
    this.health = Math.max(0, this.health - dmg);
    this.hurtTime = 0.55;
    this.exhaustion += 0.1;

    if (fromX !== undefined && fromZ !== undefined) {
      const dx = this.pos.x - fromX;
      const dz = this.pos.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 6.5;
      this.vel.z += (dz / d) * 6.5;
      this.vel.y = Math.max(this.vel.y, 4.4);
    }

    this.onDamaged?.({ amount: dmg, fromX, fromZ });
    if (this.health <= 0) {
      this.alive = false;
      this.onDied?.();
    }
  }

  /** Eats food: fills hunger + saturation (+ instant health for golden apples). */
  eat(hunger: number, saturation: number, heals = 0): void {
    this.food = Math.min(MAX_FOOD, this.food + hunger);
    this.saturation = Math.min(this.food, this.saturation + saturation);
    if (heals > 0) this.health = Math.min(MAX_HEALTH, this.health + heals);
  }

  addXp(points: number): boolean {
    this.xp += points;
    const before = this.level;
    this.recomputeLevel();
    return this.level > before;
  }

  private xpForLevel(level: number): number {
    return 2 * level + 7;
  }

  private recomputeLevel(): void {
    let remaining = this.xp;
    let level = 0;
    while (remaining >= this.xpForLevel(level)) {
      remaining -= this.xpForLevel(level);
      level++;
    }
    this.level = level;
    this.xpProgress = remaining / this.xpForLevel(level);
  }

  private tickVitals(dt: number): void {
    if (this.creative) {
      this.air = MAX_AIR;
      this.fireTime = 0;
      return;
    }
    // Exhaustion drains saturation, then food.
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }

    // Regeneration
    if (this.food >= 18 && this.health < MAX_HEALTH) {
      this.regenTimer += dt;
      if (this.regenTimer >= 4) {
        this.regenTimer = 0;
        this.health = Math.min(MAX_HEALTH, this.health + 1);
        this.exhaustion += 3;
      }
    } else {
      this.regenTimer = 0;
    }

    // Starvation
    if (this.food <= 0) {
      this.starveTimer += dt;
      if (this.starveTimer >= 4) {
        this.starveTimer = 0;
        if (this.health > 1) this.hurt(1, undefined, undefined, true);
      }
    } else {
      this.starveTimer = 0;
    }

    // Drowning
    if (this.headInWater) {
      this.air -= dt;
      if (this.air <= 0) {
        this.drownTimer += dt;
        if (this.drownTimer >= 1) {
          this.drownTimer = 0;
          this.hurt(2, undefined, undefined, true);
        }
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + dt * 4);
      this.drownTimer = 0;
    }

    // Lava + fire
    if (this.inLava) {
      this.fireTime = 6;
      this.lavaTimer += dt;
      if (this.lavaTimer >= 0.5) {
        this.lavaTimer = 0;
        this.hurt(4);
      }
    } else {
      this.lavaTimer = 0;
    }
    if (this.fireTime > 0 && !this.inLava) {
      this.fireTime -= dt;
      if (this.inWater) this.fireTime = 0;
      this.fireTimer += dt;
      if (this.fireTimer >= 1) {
        this.fireTimer = 0;
        this.hurt(1);
      }
    }

    // Cactus contact
    const cactusDmg = this.touchesCactus();
    if (cactusDmg) this.hurt(1);
  }

  private touchesCactus(): boolean {
    const minX = Math.floor(this.pos.x - HALF_W - 0.05);
    const maxX = Math.floor(this.pos.x + HALF_W + 0.05);
    const minY = Math.floor(this.pos.y);
    const maxY = Math.floor(this.pos.y + PLAYER_HEIGHT);
    const minZ = Math.floor(this.pos.z - HALF_W - 0.05);
    const maxZ = Math.floor(this.pos.z + HALF_W + 0.05);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (this.world.getBlockAt(x, y, z) === B.Cactus) return true;
        }
      }
    }
    return false;
  }

  // ---------------- per-frame ----------------

  update(dt: number, input: Input): void {
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    if (!this.alive) {
      // Corpse physics: keep falling/settling
      this.vel.x *= Math.max(0, 1 - 8 * dt);
      this.vel.z *= Math.max(0, 1 - 8 * dt);
      this.vel.y -= GRAVITY * dt;
      this.moveWithCollision(dt);
      return;
    }

    this.updateWaterState();

    // Desired horizontal direction in world space.
    let fwd = 0;
    let strafe = 0;
    if (input.down('KeyW')) fwd += 1;
    if (input.down('KeyS')) fwd -= 1;
    if (input.down('KeyA')) strafe -= 1;
    if (input.down('KeyD')) strafe += 1;
    const len = Math.hypot(fwd, strafe);
    if (len > 0) { fwd /= len; strafe /= len; }

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dirX = -sin * fwd + cos * strafe;
    const dirZ = -cos * fwd - sin * strafe;

    this.sneaking = input.down('ShiftLeft') && !this.inWater && !this.flying;
    this.sprinting =
      (input.down('ControlLeft') || input.sprintLatch) &&
      fwd > 0 && !this.sneaking && !this.inWater && (this.food > 6 || this.creative);
    if (fwd <= 0) input.sprintLatch = false;

    // Creative flight: double-tap Space toggles, landing on the ground clears it.
    if (this.creative && input.consumeFlyToggle()) {
      this.flying = !this.flying;
      if (this.flying) this.vel.y = Math.max(this.vel.y, 0);
    }
    if (!this.creative) this.flying = false;

    if (this.flying) {
      this.updateFly(dt, input, dirX, dirZ);
    } else if (this.inWater || this.inLava) {
      this.updateSwim(dt, input, dirX, dirZ);
    } else {
      this.updateWalk(dt, input, dirX, dirZ);
    }

    this.moveWithCollision(dt);
    if (this.flying && this.onGround) this.flying = false;

    // Fall damage: track the peak height while airborne, settle on landing.
    if (this.inWater || this.inLava || this.flying) {
      this.fallStartY = null;
    } else if (!this.onGround) {
      this.fallStartY = this.fallStartY === null ? this.pos.y : Math.max(this.fallStartY, this.pos.y);
    } else if (this.fallStartY !== null) {
      const fell = this.fallStartY - this.pos.y;
      this.fallStartY = null;
      if (fell > FALL_SAFE_BLOCKS) {
        const dmg = Math.floor(fell - FALL_SAFE_BLOCKS);
        if (dmg > 0) {
          this.onFall?.(fell);
          this.hurt(dmg, undefined, undefined, false);
        }
      }
    }

    // Movement exhaustion
    const hDist = Math.hypot(this.vel.x, this.vel.z) * dt;
    if (this.sprinting) this.exhaustion += hDist * 0.1;
    else if (this.inWater) this.exhaustion += hDist * 0.01;

    this.tickVitals(dt);

    // Void death
    if (this.pos.y < -12) {
      this.hurt(1000, undefined, undefined, true);
    }

    // View bob driven by ground speed.
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hSpeed > 0.5) {
      this.bobPhase += dt * hSpeed * 1.6;
      this.bobAmount = Math.min(1, this.bobAmount + dt * 6);
    } else {
      this.bobAmount = Math.max(0, this.bobAmount - dt * 6);
    }
  }

  private updateWalk(dt: number, input: Input, dirX: number, dirZ: number): void {
    const speed = this.sneaking ? SNEAK_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const k = this.onGround ? 14 : 3.5;
    const blend = 1 - Math.exp(-k * dt);
    this.vel.x += (dirX * speed - this.vel.x) * blend;
    this.vel.z += (dirZ * speed - this.vel.z) * blend;

    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -TERMINAL_VELOCITY) this.vel.y = -TERMINAL_VELOCITY;

    if (input.down('Space') && this.onGround) {
      this.vel.y = JUMP_SPEED;
      this.onGround = false;
      this.exhaustion += this.sprinting ? 0.2 : 0.05;
      if (this.sprinting) {
        // Sprint-jump boost
        const d = Math.hypot(this.vel.x, this.vel.z) || 1;
        this.vel.x += (this.vel.x / d) * 1.4;
        this.vel.z += (this.vel.z / d) * 1.4;
      }
    }
  }

  private updateFly(dt: number, input: Input, dirX: number, dirZ: number): void {
    const speed = (this.sprinting ? 21 : 10.5);
    const blend = 1 - Math.exp(-8 * dt);
    this.vel.x += (dirX * speed - this.vel.x) * blend;
    this.vel.z += (dirZ * speed - this.vel.z) * blend;

    let targetY = 0;
    if (input.down('Space')) targetY = speed * 0.75;
    else if (input.down('ShiftLeft')) targetY = -speed * 0.75;
    this.vel.y += (targetY - this.vel.y) * (1 - Math.exp(-10 * dt));
  }

  private updateSwim(dt: number, input: Input, dirX: number, dirZ: number): void {
    const blend = 1 - Math.exp(-6 * dt);
    this.vel.x += (dirX * SWIM_SPEED - this.vel.x) * blend;
    this.vel.z += (dirZ * SWIM_SPEED - this.vel.z) * blend;

    let targetY = -1.4; // slow sinking
    if (input.down('Space')) targetY = 3.6;
    else if (input.down('ShiftLeft')) targetY = -3.6;
    this.vel.y += (targetY - this.vel.y) * (1 - Math.exp(-5 * dt));

    // Boost out of the water when pushing against an edge.
    if (input.down('Space') && !this.headInWater && this.horizontalBlocked()) {
      this.vel.y = Math.max(this.vel.y, 6.5);
    }
  }

  private updateWaterState(): void {
    const feetBlock = this.world.getBlockAt(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z),
    );
    const eye = this.eyePosition();
    const eyeBlock = this.world.getBlockAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    this.inWater = feetBlock === B.Water || eyeBlock === B.Water;
    this.headInWater = eyeBlock === B.Water;
    const feetCell = this.world.getBlockAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z));
    this.inLava = feetBlock === B.Lava || feetCell === B.Lava || eyeBlock === B.Lava;
  }

  private horizontalBlocked(): boolean {
    const dir = this.lookDirection();
    const px = this.pos.x + Math.sign(dir.x) * (HALF_W + 0.15);
    const pz = this.pos.z + Math.sign(dir.z) * (HALF_W + 0.15);
    return (
      this.world.isSolidAt(Math.floor(px), Math.floor(this.pos.y + 0.5), Math.floor(this.pos.z)) ||
      this.world.isSolidAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.5), Math.floor(pz))
    );
  }

  private hasSupportAt(x: number, z: number): boolean {
    const y = Math.floor(this.pos.y - 0.05);
    for (const [ox, oz] of [[-HALF_W, -HALF_W], [HALF_W, -HALF_W], [-HALF_W, HALF_W], [HALF_W, HALF_W]] as const) {
      if (this.world.isSolidAt(Math.floor(x + ox), y, Math.floor(z + oz))) return true;
    }
    return false;
  }

  private moveWithCollision(dt: number): void {
    // Sneaking keeps you from walking off edges.
    if (this.sneaking && this.onGround) {
      if (this.vel.x !== 0 && !this.hasSupportAt(this.pos.x + this.vel.x * dt + Math.sign(this.vel.x) * 0.05, this.pos.z)) {
        this.vel.x = 0;
      }
      if (this.vel.z !== 0 && !this.hasSupportAt(this.pos.x, this.pos.z + this.vel.z * dt + Math.sign(this.vel.z) * 0.05)) {
        this.vel.z = 0;
      }
    }

    // Substep to prevent tunneling at high fall speeds.
    const maxStep = 0.4;
    const dist = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      // X/Z run before Y; step-up onto partial blocks needs last step's ground state.
      this.wasGrounded = this.onGround;
      this.onGround = false;
      this.collideAxis(0, this.vel.x * sdt);
      this.collideAxis(2, this.vel.z * sdt);
      this.collideAxis(1, this.vel.y * sdt);
    }
  }

  private wasGrounded = false;

  private collideAxis(axis: 0 | 1 | 2, delta: number): void {
    if (delta === 0) return;
    const p = this.pos;
    if (axis === 0) p.x += delta;
    else if (axis === 1) p.y += delta;
    else p.z += delta;

    const height = PLAYER_HEIGHT;
    const minX = Math.floor(p.x - HALF_W);
    const maxX = Math.floor(p.x + HALF_W);
    const minY = Math.floor(p.y);
    const maxY = Math.floor(p.y + height);
    const minZ = Math.floor(p.z - HALF_W);
    const maxZ = Math.floor(p.z + HALF_W);

    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          const h = this.world.solidHeightAt(bx, by, bz);
          if (h <= 0) continue;
          if (h < 1) {
            // Partial block (bed): ignore when the feet are above its top.
            if (p.y >= by + h - EPS) continue;
            // Walking into it on the ground: step up like vanilla.
            if (axis !== 1 && this.wasGrounded && by + h - p.y <= 0.6 &&
                !this.world.isSolidAt(bx, by + 1, bz)) {
              p.y = by + h + EPS;
              continue;
            }
          }
          if (axis === 0) {
            if (delta > 0) p.x = bx - HALF_W - EPS;
            else p.x = bx + 1 + HALF_W + EPS;
            this.vel.x = 0;
          } else if (axis === 1) {
            if (delta > 0) {
              p.y = by - height - EPS;
            } else {
              p.y = by + h + EPS;
              this.onGround = true;
            }
            this.vel.y = 0;
          } else {
            if (delta > 0) p.z = bz - HALF_W - EPS;
            else p.z = bz + 1 + HALF_W + EPS;
            this.vel.z = 0;
          }
          return;
        }
      }
    }
  }

  /** True if placing a solid block at this cell would intersect the player. */
  intersectsCell(bx: number, by: number, bz: number): boolean {
    return (
      bx + 1 > this.pos.x - HALF_W && bx < this.pos.x + HALF_W &&
      bz + 1 > this.pos.z - HALF_W && bz < this.pos.z + HALF_W &&
      by + 1 > this.pos.y && by < this.pos.y + PLAYER_HEIGHT
    );
  }

  /** Options toggle: camera view bobbing. */
  bobbingEnabled = true;

  applyCamera(camera: THREE.PerspectiveCamera): void {
    const eye = this.eyePosition();
    const bobScale = this.bobbingEnabled ? 1 : 0;
    const bob = Math.sin(this.bobPhase * Math.PI) * 0.055 * this.bobAmount * bobScale;
    const bobX = Math.cos(this.bobPhase * Math.PI * 0.5) * 0.025 * this.bobAmount * bobScale;

    camera.position.set(eye.x, eye.y + bob, eye.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw);
    camera.rotateX(this.pitch);
    // Damage tilt (classic roll kick)
    if (this.hurtTime > 0) {
      camera.rotateZ(Math.sin(this.hurtTime * 18) * 0.05 * (this.hurtTime / 0.55));
    }
    if (!this.alive) {
      // Death camera: fall over sideways
      camera.rotateZ(-1.2);
      camera.position.y -= 0.9;
    }
    camera.translateX(bobX);
  }
}
