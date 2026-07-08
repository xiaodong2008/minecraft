import * as THREE from 'three';
import { B } from '../blocks';
import { GRAVITY, TERMINAL_VELOCITY } from '../constants';
import type { World } from '../world/world';

const EPS = 0.001;

/** Shared AABB-vs-voxel movement used by every entity (and mirrored by the player). */
export function moveEntity(
  world: World, pos: THREE.Vector3, vel: THREE.Vector3,
  halfW: number, height: number, dt: number,
): { onGround: boolean; hitWall: boolean } {
  let onGround = false;
  let hitWall = false;
  const maxStep = 0.4;
  const dist = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
  const steps = Math.max(1, Math.ceil(dist / maxStep));
  const sdt = dt / steps;

  const collideAxis = (axis: 0 | 1 | 2, delta: number): void => {
    if (delta === 0) return;
    if (axis === 0) pos.x += delta;
    else if (axis === 1) pos.y += delta;
    else pos.z += delta;

    const minX = Math.floor(pos.x - halfW);
    const maxX = Math.floor(pos.x + halfW);
    const minY = Math.floor(pos.y);
    const maxY = Math.floor(pos.y + height);
    const minZ = Math.floor(pos.z - halfW);
    const maxZ = Math.floor(pos.z + halfW);

    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          const h = world.solidHeightAt(bx, by, bz);
          if (h <= 0) continue;
          // Partial blocks (beds): no collision when the feet are above the top.
          if (h < 1 && pos.y >= by + h - EPS) continue;
          if (axis === 0) {
            pos.x = delta > 0 ? bx - halfW - EPS : bx + 1 + halfW + EPS;
            vel.x = 0;
            hitWall = true;
          } else if (axis === 1) {
            if (delta > 0) {
              pos.y = by - height - EPS;
            } else {
              pos.y = by + h + EPS;
              onGround = true;
            }
            vel.y = 0;
          } else {
            pos.z = delta > 0 ? bz - halfW - EPS : bz + 1 + halfW + EPS;
            vel.z = 0;
            hitWall = true;
          }
          return;
        }
      }
    }
  };

  for (let s = 0; s < steps; s++) {
    collideAxis(0, vel.x * sdt);
    collideAxis(2, vel.z * sdt);
    collideAxis(1, vel.y * sdt);
  }
  return { onGround, hitWall };
}

export abstract class Entity {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  halfW = 0.3;
  height = 1.8;
  onGround = false;
  inWater = false;
  dead = false;
  age = 0;

  protected applyGravityAndMove(world: World, dt: number, gravityScale = 1, drag = 0): void {
    this.inWater = world.getBlockAt(
      Math.floor(this.pos.x), Math.floor(this.pos.y + this.height * 0.3), Math.floor(this.pos.z),
    ) === B.Water;

    const g = GRAVITY * gravityScale * (this.inWater ? 0.35 : 1);
    this.vel.y -= g * dt;
    if (this.vel.y < -TERMINAL_VELOCITY) this.vel.y = -TERMINAL_VELOCITY;
    if (this.inWater) {
      this.vel.multiplyScalar(Math.max(0, 1 - 2.4 * dt));
    } else if (drag > 0) {
      this.vel.x *= Math.max(0, 1 - drag * dt);
      this.vel.z *= Math.max(0, 1 - drag * dt);
    }
    const res = moveEntity(world, this.pos, this.vel, this.halfW, this.height, dt);
    this.onGround = res.onGround;
  }

  /** Squared distance to a point. */
  dist2(x: number, y: number, z: number): number {
    const dx = this.pos.x - x, dy = this.pos.y - y, dz = this.pos.z - z;
    return dx * dx + dy * dy + dz * dz;
  }
}
