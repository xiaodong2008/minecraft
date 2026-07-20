import * as THREE from 'three';
import { blockDef } from '../blocks';
import { TILE_PX, ATLAS_TILES_PER_ROW } from './tiles';
import type { World } from '../world/world';

const MAX = 600;

interface P {
  life: number;
  maxLife: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  gravity: number;
}

/** Point-sprite particle system: block-break bursts, smoke, flames, hits. */
export class Particles {
  /** Options: 1 = all, 0.4 = decreased, 0.08 = minimal. */
  density = 1;

  private geometry = new THREE.BufferGeometry();
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private particles: P[] = [];
  private head = 0;
  private points: THREE.Points;
  private tileColorCache = new Map<number, [number, number, number]>();
  private atlasCanvas: HTMLCanvasElement;

  constructor(scene: THREE.Scene, atlasCanvas: HTMLCanvasElement) {
    this.atlasCanvas = atlasCanvas;
    for (let i = 0; i < MAX; i++) {
      this.particles.push({ life: 0, maxLife: 0, x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0, gravity: 0 });
      this.positions[i * 3 + 1] = -1000;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  private emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, gravity: number,
  ): void {
    if (this.density < 1 && Math.random() > this.density) return;
    const i = this.head;
    this.head = (this.head + 1) % MAX;
    const p = this.particles[i];
    p.life = life;
    p.maxLife = life;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.gravity = gravity;
    this.colors[i * 3] = r;
    this.colors[i * 3 + 1] = g;
    this.colors[i * 3 + 2] = b;
  }

  private tileColor(tile: number): [number, number, number] {
    const cached = this.tileColorCache.get(tile);
    if (cached) return cached;
    const ctx = this.atlasCanvas.getContext('2d')!;
    const sx = (tile % ATLAS_TILES_PER_ROW) * TILE_PX;
    const sy = Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE_PX;
    const img = ctx.getImageData(sx, sy, TILE_PX, TILE_PX).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < 100) continue;
      r += img[i]; g += img[i + 1]; b += img[i + 2]; n++;
    }
    n = Math.max(1, n);
    const out: [number, number, number] = [r / n / 255, g / n / 255, b / n / 255];
    this.tileColorCache.set(tile, out);
    return out;
  }

  /** Digging crumbs while mining + burst on break. */
  blockBurst(bx: number, by: number, bz: number, blockId: number, count = 24): void {
    const [r, g, b] = this.tileColor(blockDef(blockId).tiles.side);
    for (let i = 0; i < count; i++) {
      const f = 0.7 + Math.random() * 0.5;
      this.emit(
        bx + 0.1 + Math.random() * 0.8, by + 0.1 + Math.random() * 0.8, bz + 0.1 + Math.random() * 0.8,
        (Math.random() - 0.5) * 3, Math.random() * 3.4 + 0.6, (Math.random() - 0.5) * 3,
        r * f, g * f, b * f,
        0.5 + Math.random() * 0.4, 14,
      );
    }
  }

  crumbs(bx: number, by: number, bz: number, blockId: number): void {
    this.blockBurst(bx, by, bz, blockId, 2);
  }

  /** Red-tinted puffs when an entity takes damage. */
  damage(x: number, y: number, z: number): void {
    for (let i = 0; i < 8; i++) {
      const v = 0.55 + Math.random() * 0.4;
      this.emit(
        x + (Math.random() - 0.5) * 0.5, y + Math.random() * 1.2, z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 2.4, Math.random() * 2.6 + 1, (Math.random() - 0.5) * 2.4,
        v, v * 0.2, v * 0.16,
        0.4 + Math.random() * 0.25, 12,
      );
    }
  }

  explosion(x: number, y: number, z: number, power: number): void {
    const n = Math.min(150, 40 * power);
    for (let i = 0; i < n; i++) {
      const smoke = Math.random() < 0.6;
      const v = smoke ? 0.25 + Math.random() * 0.35 : 1;
      const speed = 2 + Math.random() * power * 2.2;
      const dx = Math.random() - 0.5, dy = Math.random() - 0.3, dz = Math.random() - 0.5;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.emit(
        x, y + 0.4, z,
        (dx / len) * speed, (dy / len) * speed + 2, (dz / len) * speed,
        smoke ? v : 1, smoke ? v : 0.6 + Math.random() * 0.3, smoke ? v : 0.12,
        0.7 + Math.random() * 0.7, smoke ? 2 : 8,
      );
    }
  }

  flame(x: number, y: number, z: number): void {
    this.emit(
      x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4,
      1, 0.55 + Math.random() * 0.3, 0.1,
      0.35 + Math.random() * 0.2, -2,
    );
  }

  /** Rising pink hearts (breeding). */
  hearts(x: number, y: number, z: number): void {
    for (let i = 0; i < 7; i++) {
      this.emit(
        x + (Math.random() - 0.5) * 0.9, y + Math.random() * 0.8, z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 0.5, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5,
        1, 0.3 + Math.random() * 0.25, 0.45 + Math.random() * 0.25,
        0.8 + Math.random() * 0.4, -0.5,
      );
    }
  }

  splash(x: number, y: number, z: number): void {
    for (let i = 0; i < 12; i++) {
      this.emit(
        x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 2.4, 2 + Math.random() * 3, (Math.random() - 0.5) * 2.4,
        0.35, 0.5, 0.9,
        0.4 + Math.random() * 0.3, 14,
      );
    }
  }

  update(dt: number, world: World): void {
    const pos = this.positions;
    for (let i = 0; i < MAX; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        pos[i * 3 + 1] = -1000;
        continue;
      }
      p.vy -= p.gravity * dt;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;
      // Cheap collision: stop on solid cells.
      if (world.isSolidAt(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        p.vx *= 0.4; p.vz *= 0.4;
        if (p.vy < 0) p.vy = 0;
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}
