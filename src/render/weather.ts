// Weather system: rain/thunder cycles, precipitation particles around the
// camera (snowflakes in cold biomes), sky dimming and lightning flashes.

import * as THREE from 'three';
import { SEA_LEVEL } from '../constants';
import type { World } from '../world/world';
import type { Sky } from './sky';
import type { WeatherKind, WeatherSave } from '../saves';

export interface WeatherFrame {
  /** Rain-loop sound intensity 0..1 (0 = silence). */
  rain: number;
  /** True on the frame a lightning strike happens (play thunder sound). */
  thunder: boolean;
}

// Precipitation curtain around the camera.
const DROPS = 650;
const RADIUS = 15;
const RAIN_SPEED = 18; // blocks/s
const SNOW_SPEED = 2.5;
const RAIN_OPACITY = 0.7;
const SNOW_OPACITY = 0.85;
/** Curtain fade rate 1/s (fade out well within ~1.5s of turning clear). */
const FADE_RATE = 0.8;

const BOLT_POINTS = 9;
const BOLT_LIFE_S = 0.15;

type PrecipMode = 'rain' | 'snow' | 'none';

/** Two thin quads crossed at 90°, origin at the bottom (visible from any yaw). */
function buildCrossGeometry(w: number, h: number): THREE.BufferGeometry {
  const hw = w / 2;
  const positions = new Float32Array([
    -hw, 0, 0, hw, 0, 0, hw, h, 0, -hw, h, 0,
    0, 0, -hw, 0, 0, hw, 0, h, hw, 0, h, -hw,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return geo;
}

/**
 * Jagged vertical cross-ribbon for the lightning bolt. y runs 0..1 (scaled to
 * the strike height at reposition time), horizontal jitter is in world units.
 */
function buildBoltGeometry(): THREE.BufferGeometry {
  const n = BOLT_POINTS;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    // Random walk widening with height; the strike point (i = 0) stays at 0,0.
    xs[i] = xs[i - 1] + (Math.random() - 0.5) * 1.7;
    zs[i] = zs[i - 1] + (Math.random() - 0.5) * 1.7;
  }
  const positions = new Float32Array(n * 4 * 3);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = i / (n - 1);
    const hw = 0.09 + 0.14 * y; // thin near the ground, wider up the channel
    let o = i * 6;
    positions[o] = xs[i] - hw; positions[o + 1] = y; positions[o + 2] = zs[i];
    positions[o + 3] = xs[i] + hw; positions[o + 4] = y; positions[o + 5] = zs[i];
    o = (n + i) * 6;
    positions[o] = xs[i]; positions[o + 1] = y; positions[o + 2] = zs[i] - hw;
    positions[o + 3] = xs[i]; positions[o + 4] = y; positions[o + 5] = zs[i] + hw;
  }
  for (const base of [0, n * 2]) {
    for (let i = 0; i < n - 1; i++) {
      const a = (base + i) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/** Move v toward target by at most maxStep. */
function approach(v: number, target: number, maxStep: number): number {
  return v < target ? Math.min(target, v + maxStep) : Math.max(target, v - maxStep);
}

export class Weather {
  kind: WeatherKind = 'clear';
  /** Seconds until the next automatic weather transition. */
  timer = 600;

  private readonly scene: THREE.Scene;

  // Per-drop state (world space), preallocated — no allocations per frame.
  private readonly px = new Float32Array(DROPS);
  private readonly py = new Float32Array(DROPS);
  private readonly pz = new Float32Array(DROPS);
  private readonly deathY = new Float32Array(DROPS);
  private readonly phase = new Float32Array(DROPS);
  private readonly speed = new Float32Array(DROPS);

  private readonly rainMesh: THREE.InstancedMesh;
  private readonly snowMesh: THREE.InstancedMesh;
  private readonly rainMat: THREE.MeshBasicMaterial;
  private readonly snowMat: THREE.MeshBasicMaterial;
  private readonly rainArr: Float32Array;
  private readonly snowArr: Float32Array;

  private readonly bolt: THREE.Mesh;
  private readonly boltMat: THREE.MeshBasicMaterial;
  private boltT = 0;
  private strikeIn = 8;

  // Smoothed visual levels.
  private level = 0; // master curtain fade 0..1
  private cover = 1; // 1 = open sky, 0 = camera column covered
  private rainVis = 0; // rain vs snow crossfade
  private snowVis = 0;
  private active = false; // drops seeded and simulating
  private t = 0; // wind clock

  private readonly frame: WeatherFrame = { rain: 0, thunder: false };

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.rainMat = new THREE.MeshBasicMaterial({
      color: 0x9db4d8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.rainMesh = new THREE.InstancedMesh(buildCrossGeometry(0.03, 0.35), this.rainMat, DROPS);
    this.snowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.snowMesh = new THREE.InstancedMesh(buildCrossGeometry(0.09, 0.09), this.snowMat, DROPS);
    for (const mesh of [this.rainMesh, this.snowMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
    }
    this.rainArr = this.rainMesh.instanceMatrix.array as Float32Array;
    this.snowArr = this.snowMesh.instanceMatrix.array as Float32Array;

    this.boltMat = new THREE.MeshBasicMaterial({
      color: 0xd8e8ff, transparent: true, opacity: 1, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    });
    this.bolt = new THREE.Mesh(buildBoltGeometry(), this.boltMat);
    this.bolt.visible = false;
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 5;
    scene.add(this.bolt);
  }

  /** Force a weather state (commands); duration in seconds, 0 = default roll. */
  set(kind: WeatherKind, durationS = 0): void {
    this.kind = kind;
    this.timer = durationS > 0 ? durationS : Weather.rollDuration(kind);
    if (kind === 'thunder') this.strikeIn = 6 + Math.random() * 12;
  }

  private static rollDuration(kind: WeatherKind): number {
    if (kind === 'clear') return 420 + Math.random() * 480;
    if (kind === 'rain') return 180 + Math.random() * 240;
    return 120 + Math.random() * 120;
  }

  private nextKind(): WeatherKind {
    const r = Math.random();
    if (this.kind === 'clear') return r < 0.85 ? 'rain' : 'thunder';
    if (this.kind === 'rain') return r < 0.7 ? 'clear' : 'thunder';
    return r < 0.6 ? 'clear' : 'rain';
  }

  /**
   * Advance the cycle and precipitation visuals.
   * Returns the ambience info the game forwards to the sound engine.
   */
  update(dt: number, world: World, camera: THREE.Vector3, sky: Sky): WeatherFrame {
    this.t += dt;
    this.frame.thunder = false;

    this.timer -= dt;
    if (this.timer <= 0) this.set(this.nextKind());

    const precip = this.kind !== 'clear';
    const biome = world.biomeAt(Math.floor(camera.x), Math.floor(camera.z));
    const mode: PrecipMode = biome === 'desert' ? 'none' : biome === 'snow' ? 'snow' : 'rain';

    // Storm overcast on the sky; lightning flash is set below on strikes.
    sky.rainLevel = approach(sky.rainLevel, precip ? 1 : 0, 0.3 * dt);

    // Muffling: covered camera column dims the curtain and the rain loop.
    const covered =
      world.getSkyAt(Math.floor(camera.x), Math.ceil(camera.y + 1), Math.floor(camera.z)) < 8;
    this.cover = approach(this.cover, covered ? 0 : 1, 3 * dt);

    const levelTarget = precip && mode !== 'none' ? 1 : 0;
    this.level = approach(this.level, levelTarget, FADE_RATE * dt);
    this.rainVis = approach(this.rainVis, mode === 'rain' ? 1 : 0, 2.5 * dt);
    this.snowVis = approach(this.snowVis, mode === 'snow' ? 1 : 0, 2.5 * dt);

    // Lightning strikes while thundering (rarer when the camera is in snow).
    if (this.kind === 'thunder') {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = 6 + Math.random() * 12;
        if (biome !== 'snow' || Math.random() > 0.55) this.strike(world, camera, sky);
      }
    }
    if (this.boltT > 0) {
      this.boltT -= dt;
      this.bolt.visible = this.boltT > 0;
      this.boltMat.opacity = Math.min(1, (this.boltT / BOLT_LIFE_S) * 1.6);
    }

    // Precipitation simulation.
    if (levelTarget > 0 && !this.active) {
      this.seedAll(world, camera);
      this.active = true;
    }
    if (this.active && this.level <= 0.001 && levelTarget === 0) {
      this.active = false;
      this.rainMesh.visible = false;
      this.snowMesh.visible = false;
    }
    if (this.active) this.simulate(dt, world, camera, mode === 'snow');

    const coverOpacity = 0.22 + 0.78 * this.cover;
    this.rainMat.opacity = RAIN_OPACITY * this.level * this.rainVis * coverOpacity;
    this.snowMat.opacity = SNOW_OPACITY * this.level * this.snowVis * coverOpacity;
    if (this.active) {
      this.rainMesh.visible = this.rainMat.opacity > 0.004;
      this.snowMesh.visible = this.snowMat.opacity > 0.004;
      if (this.rainMesh.visible) this.rainMesh.instanceMatrix.needsUpdate = true;
      if (this.snowMesh.visible) this.snowMesh.instanceMatrix.needsUpdate = true;
    }

    // Rain-loop intensity: thunder 1.0 / rain 0.8, faded with the curtain,
    // silent for snowfall and deserts, scaled to ~0.2 under cover.
    const kindAudio = this.kind === 'thunder' ? 1 : this.kind === 'rain' ? 0.8 : 0;
    this.frame.rain = kindAudio * this.level * this.rainVis * (0.2 + 0.8 * this.cover);
    return this.frame;
  }

  private strike(world: World, camera: THREE.Vector3, sky: Sky): void {
    sky.flash = 1;
    this.frame.thunder = true;
    const a = Math.random() * Math.PI * 2;
    const d = 20 + Math.random() * 40;
    const sx = Math.floor(camera.x + Math.cos(a) * d);
    const sz = Math.floor(camera.z + Math.sin(a) * d);
    const sy = world.surfaceYAt(sx, sz) + 1; // topmost solid ⇒ exposed column
    this.bolt.position.set(sx + 0.5, sy, sz + 0.5);
    this.bolt.scale.y = Math.max(8, 110 - sy);
    this.bolt.rotation.y = Math.random() * Math.PI * 2;
    this.boltT = BOLT_LIFE_S;
    this.bolt.visible = true;
    this.boltMat.opacity = 1;
  }

  // ---------------- precipitation particles ----------------

  /** Write a yaw rotation into one instance matrix (columns 0..2 + w). */
  private static writeRot(arr: Float32Array, o: number, c: number, s: number): void {
    arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -s; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = 1; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = s; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
    arr[o + 15] = 1;
  }

  /** Fresh drop at the top of the curtain; caches the column's death height. */
  private respawn(i: number, world: World, cx: number, cy: number, cz: number): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * RADIUS;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    // Rain stops at open water, so death height never sinks below sea level.
    const dy = Math.max(world.surfaceYAt(Math.floor(x), Math.floor(z)) + 1, SEA_LEVEL);
    let y = cy + 6 + Math.random() * 10;
    if (y <= dy + 1) y = dy + 1.5 + Math.random() * 8; // camera below terrain
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.deathY[i] = dy;
    this.phase[i] = Math.random() * Math.PI * 2;
    this.speed[i] = 0.8 + Math.random() * 0.4;
    const yaw = Math.random() * Math.PI * 2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    Weather.writeRot(this.rainArr, i * 16, c, s);
    Weather.writeRot(this.snowArr, i * 16, c, s);
  }

  /** Initial fill: scatter drops through the whole column so rain starts everywhere. */
  private seedAll(world: World, camera: THREE.Vector3): void {
    for (let i = 0; i < DROPS; i++) {
      this.respawn(i, world, camera.x, camera.y, camera.z);
      const top = Math.max(this.deathY[i] + 3, camera.y + 16);
      this.py[i] = this.deathY[i] + Math.random() * (top - this.deathY[i]);
    }
  }

  private simulate(dt: number, world: World, camera: THREE.Vector3, snowing: boolean): void {
    const { px, py, pz, deathY, phase, speed } = this;
    const cx = camera.x;
    const cy = camera.y;
    const cz = camera.z;
    const fall = (snowing ? SNOW_SPEED : RAIN_SPEED) * dt;
    const wrapR2 = (RADIUS + 1) * (RADIUS + 1);
    // Wind clocks hoisted out of the loop.
    const tSnowX = this.t * 0.8;
    const tSnowZ = this.t * 0.63;
    const tRain = this.t * 1.7;
    const swayAmp = (snowing ? 1.3 : 0.55) * dt;

    for (let i = 0; i < DROPS; i++) {
      let x = px[i];
      let z = pz[i];
      const y = py[i] - fall * speed[i];
      if (snowing) {
        x += Math.sin(tSnowX + phase[i]) * swayAmp;
        z += Math.cos(tSnowZ + phase[i] * 1.31) * swayAmp;
      } else {
        x += Math.sin(tRain + phase[i]) * swayAmp;
      }

      if (y < deathY[i]) {
        this.respawn(i, world, cx, cy, cz);
      } else {
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > wrapR2) {
          // Left the cylinder (camera moved): mirror through the camera.
          x = cx - dx * 0.92;
          z = cz - dz * 0.92;
          const dy = Math.max(world.surfaceYAt(Math.floor(x), Math.floor(z)) + 1, SEA_LEVEL);
          if (y <= dy + 0.5) {
            this.respawn(i, world, cx, cy, cz);
          } else {
            px[i] = x; py[i] = y; pz[i] = z;
            deathY[i] = dy;
          }
        } else {
          px[i] = x; py[i] = y; pz[i] = z;
        }
      }

      const o = i * 16;
      this.rainArr[o + 12] = px[i]; this.rainArr[o + 13] = py[i]; this.rainArr[o + 14] = pz[i];
      this.snowArr[o + 12] = px[i]; this.snowArr[o + 13] = py[i]; this.snowArr[o + 14] = pz[i];
    }
  }

  // ---------------- persistence / teardown ----------------

  serialize(): WeatherSave {
    return { kind: this.kind, timer: Math.max(1, Math.round(this.timer)) };
  }

  load(data: WeatherSave | undefined): void {
    if (!data) return;
    this.kind = data.kind;
    this.timer = data.timer;
    if (this.kind === 'thunder') this.strikeIn = 6 + Math.random() * 12;
  }

  /** Remove precipitation objects from the scene (world teardown). */
  dispose(): void {
    this.scene.remove(this.rainMesh, this.snowMesh, this.bolt);
    this.rainMesh.geometry.dispose();
    this.snowMesh.geometry.dispose();
    this.rainMesh.dispose();
    this.snowMesh.dispose();
    this.bolt.geometry.dispose();
    this.rainMat.dispose();
    this.snowMat.dispose();
    this.boltMat.dispose();
    this.active = false;
  }
}
