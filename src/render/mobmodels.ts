// Classic box-model mobs with procedurally painted pixel skins.
// All sizes in "model pixels" (16 px = 1 block), matching vanilla proportions.

import * as THREE from 'three';
import { mulberry32 } from '../utils/noise';

export type MobType =
  | 'zombie' | 'skeleton' | 'creeper' | 'spider'
  | 'pig' | 'cow' | 'sheep' | 'chicken';

export interface MobModel {
  root: THREE.Group;
  /** Node rotated to face the move/look direction (yaw applied on root). */
  head: THREE.Object3D | null;
  /** Limbs swung while walking; userData.phase holds the swing phase offset. */
  limbs: THREE.Object3D[];
  /** Height of the model's eyes, for head pitch. */
  eyeHeight: number;
}

type RGB = readonly [number, number, number];
type Face = 'right' | 'left' | 'top' | 'bottom' | 'front' | 'back';
type FacePainter = (ctx: CanvasRenderingContext2D, w: number, h: number, face: Face, rand: () => number) => void;

const PX = 1 / 16;

function speckle(base: RGB, amount = 0.08): FacePainter {
  return (ctx, w, h, _face, rand) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = 1 - amount + rand() * amount * 2;
        ctx.fillStyle = `rgb(${(base[0] * f) | 0},${(base[1] * f) | 0},${(base[2] * f) | 0})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  };
}

function withFront(base: FacePainter, front: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): FacePainter {
  return (ctx, w, h, face, rand) => {
    base(ctx, w, h, face, rand);
    if (face === 'front') front(ctx, w, h);
  };
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, c: RGB): void {
  ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  ctx.fillRect(x, y, 1, 1);
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: RGB): void {
  ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
  ctx.fillRect(x, y, w, h);
}

/**
 * Textured box. Size in model px. The pivot argument shifts the geometry so
 * the mesh origin sits at that local point (also in px, from box center).
 */
function box(
  w: number, h: number, d: number,
  painter: FacePainter,
  pivot: [number, number, number] = [0, 0, 0],
  seed = 1,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX);
  geo.translate(-pivot[0] * PX, -pivot[1] * PX, -pivot[2] * PX);

  const faces: [Face, number, number][] = [
    ['right', d, h], ['left', d, h], ['top', w, d], ['bottom', w, d], ['front', w, h], ['back', w, h],
  ];
  const materials = faces.map(([face, fw, fh], i) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, fw);
    canvas.height = Math.max(1, fh);
    const ctx = canvas.getContext('2d')!;
    painter(ctx, canvas.width, canvas.height, face, mulberry32(seed * 7919 + i * 131));
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map: tex });
    m.userData.tintable = true;
    return m;
  });
  return new THREE.Mesh(geo, materials);
}

function group(x: number, y: number, z: number, ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x * PX, y * PX, z * PX);
  g.add(...children);
  return g;
}

// ---------------- skins ----------------

const ZOMBIE_SKIN: RGB = [92, 150, 78];
const ZOMBIE_SHIRT: RGB = [64, 118, 138];
const ZOMBIE_PANTS: RGB = [58, 66, 120];

function zombieHead(): FacePainter {
  return withFront(speckle(ZOMBIE_SKIN, 0.1), (ctx) => {
    rect(ctx, 1, 3, 2, 2, [20, 32, 20]);
    rect(ctx, 5, 3, 2, 2, [20, 32, 20]);
    rect(ctx, 3, 6, 2, 1, [40, 64, 40]);
  });
}

const SKELETON_BONE: RGB = [206, 206, 198];

function skeletonHead(): FacePainter {
  return withFront(speckle(SKELETON_BONE, 0.05), (ctx) => {
    rect(ctx, 1, 3, 2, 2, [40, 40, 40]);
    rect(ctx, 5, 3, 2, 2, [40, 40, 40]);
    rect(ctx, 3, 5, 2, 1, [90, 90, 90]);
    rect(ctx, 2, 7, 4, 1, [120, 120, 116]);
  });
}

function skeletonBody(): FacePainter {
  return withFront(speckle(SKELETON_BONE, 0.05), (ctx, w, h) => {
    for (let y = 1; y < h; y += 3) rect(ctx, 0, y, w, 1, [130, 130, 124]);
  });
}

const CREEPER_GREENS: RGB[] = [[64, 160, 62], [96, 190, 88], [42, 120, 44], [120, 200, 108]];

function creeperSkin(): FacePainter {
  return (ctx, w, h, _face, rand) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = CREEPER_GREENS[(rand() * CREEPER_GREENS.length) | 0];
        px(ctx, x, y, c);
      }
    }
  };
}

function creeperHead(): FacePainter {
  return withFront(creeperSkin(), (ctx) => {
    const K: RGB = [16, 24, 16];
    rect(ctx, 1, 2, 2, 2, K);
    rect(ctx, 5, 2, 2, 2, K);
    rect(ctx, 3, 4, 2, 3, K);
    rect(ctx, 2, 5, 1, 3, K);
    rect(ctx, 5, 5, 1, 3, K);
  });
}

const SPIDER_DARK: RGB = [42, 36, 34];

function spiderHead(): FacePainter {
  return withFront(speckle(SPIDER_DARK, 0.16), (ctx) => {
    const R: RGB = [190, 38, 38];
    const r2: RGB = [120, 20, 20];
    rect(ctx, 1, 3, 1, 1, R); rect(ctx, 6, 3, 1, 1, R);
    rect(ctx, 2, 2, 1, 1, r2); rect(ctx, 5, 2, 1, 1, r2);
    rect(ctx, 3, 3, 1, 1, R); rect(ctx, 4, 3, 1, 1, R);
  });
}

const PIG_PINK: RGB = [238, 158, 150];

function pigHead(): FacePainter {
  return withFront(speckle(PIG_PINK, 0.06), (ctx) => {
    rect(ctx, 2, 2, 1, 1, [40, 40, 46]); rect(ctx, 5, 2, 1, 1, [40, 40, 46]);
    rect(ctx, 2, 4, 4, 3, [246, 180, 172]);
    rect(ctx, 3, 5, 1, 1, [120, 60, 60]); rect(ctx, 5, 5, 1, 1, [120, 60, 60]);
  });
}

const COW_BROWN: RGB = [104, 74, 54];

function cowBody(): FacePainter {
  return (ctx, w, h, _face, rand) => {
    speckle(COW_BROWN, 0.08)(ctx, w, h, _face, rand);
    for (let i = 0; i < 3; i++) {
      const x = (rand() * w) | 0;
      const y = (rand() * h) | 0;
      rect(ctx, x, y, 2 + ((rand() * 3) | 0), 2 + ((rand() * 2) | 0), [235, 235, 230]);
    }
  };
}

function cowHead(): FacePainter {
  return withFront(speckle(COW_BROWN, 0.08), (ctx) => {
    rect(ctx, 2, 5, 4, 3, [235, 235, 230]);
    rect(ctx, 1, 2, 1, 1, [30, 30, 34]); rect(ctx, 6, 2, 1, 1, [30, 30, 34]);
    rect(ctx, 2, 6, 1, 1, [200, 150, 150]); rect(ctx, 5, 6, 1, 1, [200, 150, 150]);
  });
}

const WOOL: RGB = [232, 232, 230];
const SHEEP_FACE: RGB = [216, 182, 160];

function sheepHead(): FacePainter {
  return withFront(speckle(SHEEP_FACE, 0.06), (ctx) => {
    rect(ctx, 1, 2, 1, 1, [30, 30, 34]); rect(ctx, 5, 2, 1, 1, [30, 30, 34]);
    rect(ctx, 3, 4, 1, 1, [170, 130, 120]);
  });
}

const CHICKEN_WHITE: RGB = [238, 238, 236];

function chickenHead(): FacePainter {
  return withFront(speckle(CHICKEN_WHITE, 0.04), (ctx) => {
    rect(ctx, 0, 1, 1, 1, [30, 30, 34]); rect(ctx, 3, 1, 1, 1, [30, 30, 34]);
  });
}

// ---------------- model builders ----------------

function humanoid(headPainter: FacePainter, bodyPainter: FacePainter, armPainter: FacePainter, legPainter: FacePainter, opts: { armsOut?: boolean; thin?: boolean; seed?: number } = {}): MobModel {
  const seed = opts.seed ?? 1;
  const limbW = opts.thin ? 2 : 4;
  const root = new THREE.Group();

  const head = group(0, 24, 0, box(8, 8, 8, headPainter, [0, -4, 0], seed + 1));
  const body = group(0, 18, 0, box(8, 12, 4, bodyPainter, [0, 0, 0], seed + 2));

  const armL = group(-(4 + limbW / 2), 22, 0, box(limbW, 12, limbW, armPainter, [0, 5, 0], seed + 3));
  const armR = group(4 + limbW / 2, 22, 0, box(limbW, 12, limbW, armPainter, [0, 5, 0], seed + 4));
  const legL = group(-2, 12, 0, box(limbW, 12, limbW, legPainter, [0, 6, 0], seed + 5));
  const legR = group(2, 12, 0, box(limbW, 12, limbW, legPainter, [0, 6, 0], seed + 6));

  if (opts.armsOut) {
    armL.rotation.x = -Math.PI / 2;
    armR.rotation.x = -Math.PI / 2;
  }

  armL.userData.phase = 0;
  armR.userData.phase = Math.PI;
  legL.userData.phase = Math.PI;
  legR.userData.phase = 0;
  armL.userData.arm = true;
  armR.userData.arm = true;

  root.add(head, body, armL, armR, legL, legR);
  return { root, head, limbs: [armL, armR, legL, legR], eyeHeight: 1.62 };
}

// Convention: +z is the model's front (mob yaw = atan2(dx, dz) faces a target).
function quadruped(
  headPainter: FacePainter, bodyPainter: FacePainter, legPainter: FacePainter,
  o: { legH: number; bodyW: number; bodyH: number; bodyL: number; headSize: number; headY: number; headZ: number; seed?: number },
): MobModel {
  const seed = o.seed ?? 40;
  const root = new THREE.Group();
  const bodyY = o.legH + o.bodyH / 2;
  // Body is a horizontal box (length along z).
  const body = group(0, bodyY, 0, box(o.bodyW, o.bodyH, o.bodyL, bodyPainter, [0, 0, 0], seed + 1));
  const head = group(0, o.headY, o.bodyL / 2 + o.headZ, box(o.headSize, o.headSize, o.headSize, headPainter, [0, -o.headSize / 2 + 1, -(o.headSize / 2 - 2)], seed + 2));

  const dx = o.bodyW / 2 - 2;
  const dz = o.bodyL / 2 - 2;
  const legs: THREE.Object3D[] = [];
  const at = [[-dx, -dz], [dx, -dz], [-dx, dz], [dx, dz]];
  for (let i = 0; i < 4; i++) {
    const leg = group(at[i][0], o.legH, at[i][1], box(4, o.legH, 4, legPainter, [0, o.legH / 2, 0], seed + 3 + i));
    leg.userData.phase = i === 0 || i === 3 ? 0 : Math.PI;
    legs.push(leg);
  }
  root.add(body, head, ...legs);
  return { root, head, limbs: legs, eyeHeight: (o.headY + 2) / 16 };
}

export function buildMobModel(type: MobType): MobModel {
  switch (type) {
    case 'zombie':
      return humanoid(zombieHead(), speckle(ZOMBIE_SHIRT, 0.08), speckle(ZOMBIE_SKIN, 0.1), speckle(ZOMBIE_PANTS, 0.08), { armsOut: true, seed: 11 });
    case 'skeleton':
      return humanoid(skeletonHead(), skeletonBody(), speckle(SKELETON_BONE, 0.05), speckle(SKELETON_BONE, 0.05), { thin: true, seed: 21 });
    case 'creeper': {
      const root = new THREE.Group();
      const head = group(0, 18, 0, box(8, 8, 8, creeperHead(), [0, -4, 0], 31));
      const body = group(0, 12, 0, box(8, 12, 4, creeperSkin(), [0, 0, 0], 32));
      const legs: THREE.Object3D[] = [];
      const at = [[-2, -3], [2, -3], [-2, 3], [2, 3]];
      for (let i = 0; i < 4; i++) {
        const leg = group(at[i][0], 6, at[i][1], box(4, 6, 4, creeperSkin(), [0, 3, 0], 33 + i));
        leg.userData.phase = i === 0 || i === 3 ? 0 : Math.PI;
        legs.push(leg);
      }
      root.add(head, body, ...legs);
      return { root, head, limbs: legs, eyeHeight: 1.3 };
    }
    case 'spider': {
      const root = new THREE.Group();
      const body = group(0, 9, -4, box(10, 8, 10, speckle(SPIDER_DARK, 0.16), [0, 0, 0], 41));
      const head = group(0, 9, 4, box(8, 8, 8, spiderHead(), [0, 0, 0], 42));
      const legs: THREE.Object3D[] = [];
      for (let i = 0; i < 4; i++) {
        const z = -5 + i * 3;
        const legL = group(-5, 8, z, box(14, 2, 2, speckle(SPIDER_DARK, 0.1), [7, 0, 0], 43 + i));
        const legR = group(5, 8, z, box(14, 2, 2, speckle(SPIDER_DARK, 0.1), [-7, 0, 0], 47 + i));
        legL.rotation.z = 0.5;
        legR.rotation.z = -0.5;
        legL.userData.phase = i % 2 === 0 ? 0 : Math.PI;
        legR.userData.phase = i % 2 === 0 ? Math.PI : 0;
        legL.userData.spider = true;
        legR.userData.spider = true;
        legs.push(legL, legR);
      }
      root.add(body, head, ...legs);
      return { root, head, limbs: legs, eyeHeight: 0.65 };
    }
    case 'pig':
      return quadruped(pigHead(), speckle(PIG_PINK, 0.06), speckle(PIG_PINK, 0.06), {
        legH: 6, bodyW: 10, bodyH: 8, bodyL: 16, headSize: 8, headY: 9, headZ: 0, seed: 51,
      });
    case 'cow':
      return quadruped(cowHead(), cowBody(), speckle([90, 64, 46], 0.08), {
        legH: 12, bodyW: 12, bodyH: 10, bodyL: 18, headSize: 8, headY: 20, headZ: 0, seed: 61,
      });
    case 'sheep':
      return quadruped(sheepHead(), speckle(WOOL, 0.05), speckle([200, 200, 198], 0.05), {
        legH: 12, bodyW: 10, bodyH: 9, bodyL: 14, headSize: 6, headY: 19, headZ: 1, seed: 71,
      });
    case 'chicken': {
      const m = quadruped(chickenHead(), speckle(CHICKEN_WHITE, 0.05), speckle([222, 178, 90], 0.06), {
        legH: 5, bodyW: 6, bodyH: 6, bodyL: 8, headSize: 4, headY: 12, headZ: 0, seed: 81,
      });
      // Beak + wattle bolted onto the head node.
      const beak = group(0, -0.5, 3.5, box(3, 2, 2, speckle([226, 158, 60], 0.05), [0, 0, 0], 85));
      const wattle = group(0, -2.5, 3, box(2, 2, 1, speckle([190, 60, 50], 0.05), [0, 0, 0], 86));
      m.head?.add(beak, wattle);
      // Only two real legs on a chicken.
      m.limbs[2].visible = false;
      m.limbs[3].visible = false;
      return m;
    }
  }
}
