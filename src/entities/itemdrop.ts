import * as THREE from 'three';
import { Entity } from './base';
import { makeItemObject, setObjectBrightness, cloneWithMaterials } from '../render/itemmesh';
import { isBlockId, blockDef, RENDER_CROSS } from '../blocks';
import type { ItemStack } from '../items';
import type { World } from '../world/world';

const DESPAWN_S = 300;
const MAGNET_DIST = 2.2;
const PICKUP_DIST = 1.1;

const protoCache = new Map<number, THREE.Object3D>();

function itemProto(id: number, atlas: THREE.Texture): THREE.Object3D {
  let proto = protoCache.get(id);
  if (!proto) {
    proto = makeItemObject(id, atlas);
    protoCache.set(id, proto);
  }
  return proto;
}

/** A dropped item stack floating in the world. */
export class ItemEntity extends Entity {
  stack: ItemStack;
  /** Seconds until it can be picked up (thrown items). */
  pickupDelay = 0.6;
  readonly obj: THREE.Group;
  private spin: THREE.Object3D;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(stack: ItemStack, x: number, y: number, z: number, atlas: THREE.Texture, scene: THREE.Scene) {
    super();
    this.stack = stack;
    this.halfW = 0.12;
    this.height = 0.25;
    this.pos.set(x, y, z);
    this.vel.set((Math.random() - 0.5) * 2.4, 2.4 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4);

    this.obj = new THREE.Group();
    this.spin = cloneWithMaterials(itemProto(stack.id, atlas));
    const isCube = isBlockId(stack.id) && blockDef(stack.id).render !== RENDER_CROSS;
    this.spin.scale.setScalar(isCube ? 0.26 : 0.42);
    this.obj.add(this.spin);
    scene.add(this.obj);
  }

  update(dt: number, world: World): void {
    this.age += dt;
    this.pickupDelay = Math.max(0, this.pickupDelay - dt);
    if (this.age > DESPAWN_S) this.dead = true;

    this.applyGravityAndMove(world, dt, 1, this.onGround ? 8 : 0.6);
    if (this.inWater) this.vel.y = Math.min(this.vel.y + 20 * dt, 1.2); // items float

    this.bobPhase += dt * 2.2;
    this.spin.rotation.y += dt * 1.9;
    this.spin.position.y = this.height / 2 + 0.09 + Math.sin(this.bobPhase) * 0.05;
    this.obj.position.copy(this.pos);

    const b = Math.max(
      world.getSkyAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.3), Math.floor(this.pos.z)) / 15,
      world.getBlockLightAt(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.3), Math.floor(this.pos.z)) / 15,
    );
    setObjectBrightness(this.spin, 0.25 + 0.75 * b);
  }

  /** Pulls toward the player when close. Returns true when in pickup range. */
  magnet(dt: number, px: number, py: number, pz: number): boolean {
    if (this.pickupDelay > 0) return false;
    const d2 = this.dist2(px, py, pz);
    if (d2 < PICKUP_DIST * PICKUP_DIST) return true;
    if (d2 < MAGNET_DIST * MAGNET_DIST) {
      const d = Math.sqrt(d2) || 1;
      const pull = 14 * dt / d;
      this.vel.x += (px - this.pos.x) * pull;
      this.vel.y += (py - this.pos.y) * pull;
      this.vel.z += (pz - this.pos.z) * pull;
    }
    return false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}

/** Experience orb: green glowing point rushing to the player. */
export class XpOrb extends Entity {
  value: number;
  readonly obj: THREE.Mesh;
  private phase = Math.random() * 9;

  constructor(value: number, x: number, y: number, z: number, scene: THREE.Scene) {
    super();
    this.value = value;
    this.halfW = 0.1;
    this.height = 0.2;
    this.pos.set(x, y, z);
    this.vel.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2, (Math.random() - 0.5) * 3);
    const mat = new THREE.MeshBasicMaterial({ color: 0x9dfa4a });
    this.obj = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), mat);
    scene.add(this.obj);
  }

  update(dt: number, world: World): void {
    this.age += dt;
    if (this.age > 120) this.dead = true;
    this.applyGravityAndMove(world, dt, 0.7, this.onGround ? 6 : 0.4);
    this.phase += dt * 6;
    this.obj.position.set(this.pos.x, this.pos.y + 0.12 + Math.sin(this.phase) * 0.03, this.pos.z);
    const mat = this.obj.material as THREE.MeshBasicMaterial;
    mat.color.setHSL(0.26 + Math.sin(this.phase * 0.8) * 0.06, 0.9, 0.55);
  }

  magnet(dt: number, px: number, py: number, pz: number): boolean {
    const d2 = this.dist2(px, py, pz);
    if (this.age > 0.35 && d2 < 0.8) return true;
    if (d2 < 36) {
      const d = Math.sqrt(d2) || 1;
      const pull = 30 * dt / d;
      this.vel.x += (px - this.pos.x) * pull;
      this.vel.y += (py + 0.8 - this.pos.y) * pull;
      this.vel.z += (pz - this.pos.z) * pull;
    }
    return false;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.obj);
  }
}
