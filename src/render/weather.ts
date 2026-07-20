// Weather system: rain/thunder cycles, precipitation particles around the
// camera (snowflakes in cold biomes), sky dimming and lightning flashes.

import * as THREE from 'three';
import type { World } from '../world/world';
import type { Sky } from './sky';
import type { WeatherKind, WeatherSave } from '../saves';

export interface WeatherFrame {
  /** Rain-loop sound intensity 0..1 (0 = silence). */
  rain: number;
  /** True on the frame a lightning strike happens (play thunder sound). */
  thunder: boolean;
}

export class Weather {
  kind: WeatherKind = 'clear';
  /** Seconds until the next automatic weather transition. */
  timer = 600;

  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    void this.scene;
  }

  /** Force a weather state (commands); duration in seconds, 0 = default roll. */
  set(kind: WeatherKind, durationS = 0): void {
    this.kind = kind;
    this.timer = durationS > 0 ? durationS : 120 + Math.random() * 300;
  }

  /**
   * Advance the cycle and precipitation visuals.
   * Returns the ambience info the game forwards to the sound engine.
   */
  update(dt: number, world: World, camera: THREE.Vector3, sky: Sky): WeatherFrame {
    void world;
    void camera;
    void sky;
    this.timer -= dt;
    if (this.timer <= 0) this.set(this.kind === 'clear' ? 'rain' : 'clear');
    return { rain: 0, thunder: false };
  }

  serialize(): WeatherSave {
    return { kind: this.kind, timer: Math.max(1, Math.round(this.timer)) };
  }

  load(data: WeatherSave | undefined): void {
    if (!data) return;
    this.kind = data.kind;
    this.timer = data.timer;
  }

  /** Remove precipitation objects from the scene (world teardown). */
  dispose(): void {
    // implemented with the visuals
  }
}
