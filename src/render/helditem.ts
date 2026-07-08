import * as THREE from 'three';
import { makeItemObject, setObjectBrightness } from './itemmesh';
import { isBlockId, blockDef, RENDER_CROSS } from '../blocks';

/** First-person view model: the held item bobbing at the bottom-right. */
export class HeldItemView {
  private group = new THREE.Group();
  private itemHolder = new THREE.Group();
  private currentId: number | null = null;
  private atlas: THREE.Texture;

  private swingT = 1; // 0..1, animation done at 1
  private bobPhase = 0;
  private equipT = 1;

  constructor(camera: THREE.PerspectiveCamera, atlas: THREE.Texture) {
    this.atlas = atlas;
    this.group.add(this.itemHolder);
    camera.add(this.group);
    this.group.position.set(0.34, -0.42, -0.55);
  }

  setItem(id: number | null): void {
    if (id === this.currentId) return;
    this.currentId = id;
    this.equipT = 0;
    this.itemHolder.clear();
    if (id === null) return;

    const obj = makeItemObject(id, this.atlas);
    if (isBlockId(id) && blockDef(id).render !== RENDER_CROSS) {
      obj.scale.setScalar(0.4);
      obj.rotation.y = Math.PI / 4 + 0.1;
      obj.position.set(0, 0.05, 0);
    } else {
      obj.scale.setScalar(0.55);
      obj.rotation.set(0.1, -Math.PI / 2 + 0.4, 0.15);
      obj.position.set(0, 0.08, 0);
    }
    this.itemHolder.add(obj);
  }

  swing(): void {
    if (this.swingT >= 0.9 || this.swingT === 0) this.swingT = 0.0001;
  }

  update(dt: number, walkSpeed: number, onGround: boolean, brightness: number, use: { kind: 'eat' | 'bow' | null; progress: number }): void {
    // Swing animation
    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt / 0.28);
    this.equipT = Math.min(1, this.equipT + dt / 0.25);

    if (onGround && walkSpeed > 0.5) {
      this.bobPhase += dt * walkSpeed * 1.6;
    }

    const t = this.swingT;
    const swingCurve = Math.sin(t * Math.PI);
    const dipCurve = Math.sin(Math.min(1, t * 1.4) * Math.PI);

    const bobX = Math.cos(this.bobPhase * Math.PI * 0.5) * 0.012 * Math.min(1, walkSpeed / 4);
    const bobY = Math.abs(Math.sin(this.bobPhase * Math.PI)) * 0.018 * Math.min(1, walkSpeed / 4);

    this.group.position.set(
      0.34 - swingCurve * 0.18 + bobX,
      -0.42 - dipCurve * 0.16 - bobY - (1 - this.equipT) * 0.5,
      -0.55 - swingCurve * 0.1,
    );
    this.group.rotation.set(
      -swingCurve * 0.9,
      -swingCurve * 0.5,
      -swingCurve * 0.3,
    );

    // Eating: shake toward the face. Bow: pull back steadily.
    if (use.kind === 'eat') {
      const shake = Math.sin(use.progress * 60) * 0.02;
      this.group.position.x -= 0.12 + shake;
      this.group.position.y += 0.06 + shake * 0.6;
      this.group.rotation.x += 0.5;
      this.group.rotation.y += 0.4;
    } else if (use.kind === 'bow') {
      this.group.position.x -= use.progress * 0.1;
      this.group.position.z += use.progress * 0.12;
      this.group.rotation.y += use.progress * 0.3;
    }

    setObjectBrightness(this.itemHolder, Math.max(0.15, brightness));
  }
}
