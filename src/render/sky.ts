import * as THREE from 'three';
import { CHUNK_SIZE, DAY_LENGTH_S, WORLD_HEIGHT } from '../constants';
import { buildSunTexture, buildMoonTexture, buildCloudTexture } from './atlas';
import type { SharedUniforms } from './materials';

const DAY_COLOR = new THREE.Color(0.478, 0.65, 1.0);
const NIGHT_COLOR = new THREE.Color(0.012, 0.02, 0.055);
const SUNSET_COLOR = new THREE.Color(0.98, 0.48, 0.25);
const WATER_FOG_COLOR = new THREE.Color(0.06, 0.18, 0.45);
const FLASH_COLOR = new THREE.Color(1, 1, 1);

/**
 * Day-night cycle: sky color, sun/moon billboards, stars, pixel clouds and the
 * sun-light + fog uniforms consumed by the terrain shader.
 */
export class Sky {
  /** 0..1, 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  time = 0.3;

  /** Gamerule doDaylightCycle: when false, time stands still. */
  cycleEnabled = true;
  /** Options toggle: render the cloud plane. */
  cloudsEnabled = true;

  /** Storm overcast 0..1, driven by Weather: grays the sky, dims lighting. */
  rainLevel = 0;
  /** Lightning flash 0..1: Weather sets 1 on a strike, decays here. */
  flash = 0;

  private group = new THREE.Group();
  private sun: THREE.Mesh;
  private sunMat: THREE.MeshBasicMaterial;
  private moon: THREE.Mesh;
  private moonMat: THREE.MeshBasicMaterial;
  private stars: THREE.Points;
  private starsMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh;
  private cloudsMat: THREE.MeshBasicMaterial;
  private cloudTex: THREE.Texture;

  private skyColor = new THREE.Color();
  private fogColor = new THREE.Color();
  private stormGray = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const sunTex = buildSunTexture();
    const moonTex = buildMoonTexture();

    this.sunMat = new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), this.sunMat);
    this.moonMat = new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, fog: false, depthWrite: false });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), this.moonMat);

    // Stars on a unit sphere (group is repositioned to the camera each frame).
    const starCount = 700;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(900);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = Math.abs(v.y) * 0.9 + 30; // keep stars above the horizon
      positions[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starsMat);

    this.group.add(this.sun, this.moon, this.stars);
    this.group.renderOrder = -10;
    scene.add(this.group);

    this.cloudTex = buildCloudTexture();
    this.cloudTex.repeat.set(6, 6);
    this.cloudsMat = new THREE.MeshBasicMaterial({
      map: this.cloudTex, transparent: true, opacity: 0.55, fog: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), this.cloudsMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = WORLD_HEIGHT + 14;
    this.clouds.renderOrder = -5;
    scene.add(this.clouds);
  }

  /** Sun elevation in [-1, 1]. */
  private sunHeight(): number {
    return Math.sin((this.time - 0.25) * Math.PI * 2);
  }

  /** Scale factor applied to sky light, 0.14 at night .. 1 at day; storms dim it. */
  sunFactor(): number {
    const h = this.sunHeight();
    const t = Math.min(1, Math.max(0, (h + 0.12) / 0.34));
    const smooth = t * t * (3 - 2 * t);
    return (0.14 + 0.86 * smooth) * (1 - 0.35 * this.rainLevel);
  }

  update(
    dt: number,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    shared: SharedUniforms,
    renderDistanceChunks: number,
    cameraUnderwater: boolean,
  ): void {
    if (this.cycleEnabled) this.time = (this.time + dt / DAY_LENGTH_S) % 1;

    const h = this.sunHeight();
    const day = this.sunFactor();

    // Sky color: night -> day, with a sunset/sunrise tint near the horizon
    // (the tint is suppressed while overcast).
    this.skyColor.copy(NIGHT_COLOR).lerp(DAY_COLOR, Math.max(0, (day - 0.14) / 0.86));
    const sunsetness = Math.max(0, 1 - Math.abs(h) * 5) * 0.55 * (1 - this.rainLevel);
    this.skyColor.lerp(SUNSET_COLOR, sunsetness);

    // Storm overcast: wash the sky toward a flat gray that follows daylight.
    if (this.rainLevel > 0) {
      this.stormGray.setScalar(0.08 + day * 0.3);
      this.skyColor.lerp(this.stormGray, 0.5 * this.rainLevel);
    }

    // Lightning flash: whites out sky + fog for a moment, then decays.
    if (this.flash > 0) {
      this.skyColor.lerp(FLASH_COLOR, Math.min(1, this.flash * 0.8));
      this.flash = Math.max(0, this.flash - dt * 3);
    }

    scene.background = this.skyColor;

    // Fog: sky-colored, denser underwater.
    const far = renderDistanceChunks * CHUNK_SIZE;
    if (cameraUnderwater) {
      this.fogColor.copy(WATER_FOG_COLOR).multiplyScalar(0.3 + day * 0.7);
      shared.uFogNear.value = 2;
      shared.uFogFar.value = 24;
    } else {
      this.fogColor.copy(this.skyColor);
      shared.uFogNear.value = far * 0.55;
      shared.uFogFar.value = far * 0.98;
    }
    shared.uFogColor.value.copy(this.fogColor).convertSRGBToLinear();
    shared.uSun.value = day;

    // Celestial bodies orbit around the camera.
    this.group.position.copy(camera.position);
    const angle = (this.time - 0.25) * Math.PI * 2;
    const r = 800;
    this.sun.position.set(Math.cos(angle) * r * 0.25, Math.sin(angle) * r, Math.cos(angle) * r);
    this.moon.position.copy(this.sun.position).multiplyScalar(-1);
    this.sun.lookAt(camera.position);
    this.moon.lookAt(camera.position);

    // Overcast hides sun, moon and stars.
    const celestial = 1 - 0.85 * this.rainLevel;
    this.sunMat.opacity = celestial;
    this.moonMat.opacity = celestial;
    this.starsMat.opacity = Math.max(0, 1 - day * 1.6) * (1 - 0.9 * this.rainLevel);

    // Clouds drift and follow the camera horizontally.
    this.clouds.visible = this.cloudsEnabled;
    this.clouds.position.x = camera.position.x;
    this.clouds.position.z = camera.position.z;
    const drift = performance.now() * 0.0000045;
    this.cloudTex.offset.set(camera.position.x / 500 + drift * 8, -camera.position.z / 500);
    this.cloudsMat.opacity = 0.2 + day * 0.35 + 0.3 * this.rainLevel;
    this.cloudsMat.color.setScalar(1 - 0.5 * this.rainLevel);
  }
}
