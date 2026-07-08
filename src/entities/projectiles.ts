import * as THREE from 'three';
import { Entity, moveEntity } from './base';
import { GRAVITY } from '../constants';
import type { World } from '../world/world';

export interface ArrowHitTarget {
  /** Distance from segment to target center that counts as a hit. */
  radius: number;
  x: number; y: number; z: number;
  onHit: (damage: number, fromX: number, fromZ: number) => void;
}

/** Arrow: ballistic dart that sticks into blocks and damages the first target hit. */
export class Arrow extends Entity {
  readonly obj: THREE.Group;
  damage: number;
  fromPlayer: boolean;
  stuck = false;
  private stuckTimer = 0;

  constructor(
    x: number, y: number, z: number,
    dir: THREE.Vector3, speed: number, damage: number, fromPlayer: boolean,
    scene: THREE.Scene,
  ) {
    super();
    this.halfW = 0.05;
    this.height = 0.1;
    this.pos.set(x, y, z);
    this.vel.copy(dir).normalize().multiplyScalar(speed);
    this.damage = damage;
    this.fromPlayer = fromPlayer;

    this.obj = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.03, 0.55),
      new THREE.MeshBasicMaterial({ color: 0x8a6a3f }),
    );
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xd8d8dc }),
    );
    head.position.z = -0.3;
    const feather = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xeeeeee }),
    );
    feather.position.z = 0.26;
    this.obj.add(shaft, head, feather);
    scene.add(this.obj);
  }

  update(dt: number, world: World, targets: ArrowHitTarget[]): void {
    this.age += dt;
    if (this.age > 30) this.dead = true;

    if (this.stuck) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 8) this.dead = true;
      return;
    }

    const prev = this.pos.clone();
    this.vel.y -= GRAVITY * 0.55 * dt;
    const res = moveEntity(world, this.pos, this.vel, this.halfW, this.height, dt);
    if (res.hitWall || res.onGround || (this.vel.lengthSq() < 0.01 && !this.inWater)) {
      this.stuck = true;
    }

    // Segment-vs-target hit test.
    const seg = this.pos.clone().sub(prev);
    const segLen = seg.length();
    if (segLen > 1e-5) {
      for (const t of targets) {
        const toT = new THREE.Vector3(t.x - prev.x, t.y - prev.y, t.z - prev.z);
        const along = THREE.MathUtils.clamp(toT.dot(seg) / (segLen * segLen), 0, 1);
        const close = prev.clone().addScaledVector(seg, along);
        const d2 = (close.x - t.x) ** 2 + (close.y - t.y) ** 2 + (close.z - t.z) ** 2;
        if (d2 < t.radius * t.radius) {
          t.onHit(this.damage, prev.x, prev.z);
          this.dead = true;
          return;
        }
      }
    }

    this.obj.position.copy(this.pos);
    if (this.vel.lengthSq() > 0.01) {
      const look = this.pos.clone().add(this.vel.clone().normalize());
      this.obj.lookAt(look);
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}

/** Falling sand/gravel: block visual that re-solidifies where it lands. */
export class FallingBlock extends Entity {
  readonly obj: THREE.Object3D;
  readonly blockId: number;
  landed = false;

  constructor(bx: number, by: number, bz: number, blockId: number, obj: THREE.Object3D, scene: THREE.Scene) {
    super();
    this.halfW = 0.49;
    this.height = 0.98;
    this.blockId = blockId;
    this.pos.set(bx + 0.5, by, bz + 0.5);
    this.obj = obj;
    scene.add(this.obj);
  }

  update(dt: number, world: World): void {
    this.age += dt;
    if (this.age > 30) this.dead = true; // stuck in unloaded space
    this.applyGravityAndMove(world, dt, 1, 0);
    this.obj.position.set(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
    if (this.onGround) {
      this.landed = true;
      this.dead = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}

/** Primed TNT: flashing block that explodes after the fuse. */
export class PrimedTnt extends Entity {
  readonly obj: THREE.Object3D;
  fuse = 4;
  exploded = false;

  constructor(x: number, y: number, z: number, obj: THREE.Object3D, scene: THREE.Scene) {
    super();
    this.halfW = 0.49;
    this.height = 0.98;
    this.pos.set(x, y, z);
    this.vel.set((Math.random() - 0.5) * 0.4, 4.5, (Math.random() - 0.5) * 0.4);
    this.obj = obj;
    scene.add(this.obj);
  }

  update(dt: number, world: World): void {
    this.age += dt;
    this.fuse -= dt;
    this.applyGravityAndMove(world, dt, 1, this.onGround ? 6 : 0);
    this.obj.position.set(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
    // Flash white with increasing frequency
    const rate = this.fuse < 1 ? 10 : 5;
    const on = Math.sin(this.age * rate * Math.PI) > 0;
    this.obj.scale.setScalar(on ? 1.02 : 0.98);
    if (this.fuse <= 0) {
      this.exploded = true;
      this.dead = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}
